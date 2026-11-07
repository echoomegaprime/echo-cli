import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debuglog } from 'node:util';
import { runTurn } from '../src/code/agent.js';
import { ACTION_FORMAT, LocalModel, parseAction, type Action, type Model } from '../src/code/model.js';
import { CliModel, type Runner, type RunResult } from '../src/code/providers.js';
import { SessionStore, type Message } from '../src/code/sessions.js';
import { Workspace } from '../src/code/workspace.js';
import {
  DEFAULT_TOOLS, TOOL_MODULES, ToolCache, ToolKit, ToolRefused, echoKnowledge, echoMemory,
  mcpPlugins, parseToolsConfig, skills, webFetch, webSearch, wolfram,
  type Audience, type FetchResponse, type FetchTransport, type Lookup, type McpGateway,
  type SdkInvoke, type ToolAction, type ToolEnvironment, type ToolEvent, type ToolKitOptions,
} from '../src/code/tools/index.js';
import type { ParamSpec } from '../src/code/tools/types.js';
import { argsKey, compact, isGlobalIp, refuseSecrets, validateArgs } from '../src/code/tools/util.js';
import { FETCH_MAX_BYTES, pageText } from '../src/code/tools/web-fetch.js';
import { SKILL_NOTICE } from '../src/code/tools/skills.js';
import { connectionGateway, sdkToolInvoke } from '../src/prime/tools-bridge.js';
import type { McpConnection, SdkBroker } from '../src/prime/hub.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z'), SOURCE = 'https://example.com/result';
const signal = () => new AbortController().signal;
const searchBody = () => ({ answer: 'Fixture answer', results: [{ title: 'Fixture source', url: SOURCE, content: 'Fixture content' }] });
const searchAction = (query = 'x'): ToolAction => ({ action: 'tool', tool: 'web_search', args: { query } });
const sdkStub = () => vi.fn<SdkInvoke>(async () => searchBody());
const noLookup: Lookup = async () => { throw new Error('Unexpected DNS lookup: inject a lookup stand-in'); };
const noTransport: FetchTransport = async () => { throw new Error('Unexpected HTTP transport: inject a transport stand-in'); };
const debug = debuglog('prime-tools-test');
function environment(over: Partial<ToolEnvironment> = {}): ToolEnvironment {
  return { now: () => NOW, skillRoots: [], mcpAllow: [], crystal: false, lookup: noLookup, transport: noTransport, ...over };
}
function kit(config: unknown = undefined, options: ToolKitOptions = {}) {
  return new ToolKit(parseToolsConfig(config), { sdk: sdkStub(), now: () => NOW, lookup: noLookup, transport: noTransport, ...options }, TOOL_MODULES);
}
function turn(host: ToolKit, audience: Audience = 'owner') {
  const tools = host.forTurn({ audience });
  if (!tools) throw new Error(`Fixture has no tools for ${audience}`);
  return tools;
}
const response = (body = '<p>Public page</p>', over: Partial<FetchResponse> = {}): FetchResponse =>
  ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body), truncated: false, ...over });
function fetchFixture(transport = vi.fn<FetchTransport>(async () => response()), lookup = vi.fn<Lookup>(async () => ['93.184.216.34'])) {
  return { transport, lookup, env: environment({ transport, lookup }) };
}
function gatewayFixture() {
  const inputSchema = { type: 'object', properties: { detail: { type: 'boolean' } }, additionalProperties: false };
  const gateway = {
    list: vi.fn<McpGateway['list']>(async () => [
      { id: 'esh', name: 'Echo Shell', tools: [{ name: 'esh_status', description: 'Read status', inputSchema }, { name: 'esh_run', inputSchema: {} }] },
      { id: 'sdk', name: 'SDK', tools: [{ name: 'search', inputSchema: {} }] },
    ]),
    call: vi.fn<McpGateway['call']>(async () => ({ state: 'ready' })),
  } satisfies McpGateway;
  return { gateway, inputSchema, env: environment({ mcp: gateway, mcpAllow: ['esh:esh_status'] }) };
}

const servers: Server[] = [], cleanups: string[] = [], loopbackOrigins = new Set<string>();
const localFetch = globalThis.fetch;
beforeEach(() => {
  // The one permitted socket path is the explicitly requested, test-owned Ollama fixture.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!loopbackOrigins.has(url.origin)) throw new Error('Unexpected fetch outside the test-owned Ollama server');
    return localFetch(input, init);
  }));
});
afterEach(async () => {
  try {
    while (servers.length) {
      const server = servers.pop()!;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    // Only exact mkdtemp return values created by this file enter this list.
    while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
    loopbackOrigins.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'prime-tools-')); cleanups.push(dir); return dir;
}
function skillFixture() {
  const root = temp();
  mkdirSync(join(root, 'alpha', 'references'), { recursive: true }); mkdirSync(join(root, 'beta'));
  writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha procedure\n---\nRead the alpha guide.\n');
  writeFileSync(join(root, 'alpha', 'references', 'guide.md'), '# Guide\nCite your sources.\n');
  writeFileSync(join(root, 'beta', 'SKILL.md'), '---\ndescription: Beta procedure\n---\nBeta instructions.\n');
  return { root, env: environment({ skillRoots: [root] }) };
}
function workspaceFixture() {
  const root = temp(), state = temp(), workspace = new Workspace(root, [state]), store = new SessionStore(state);
  return { workspace, store, sessionId: store.create(workspace.root, 'qwen2.5-coder:7b').id };
}
interface ChatRequest { model: string; messages: Message[] }
async function ollama(actions: Action[]) {
  const requests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/api/chat' || req.method !== 'POST') { res.writeHead(404).end('{}'); return; }
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest);
        debug('%j', { event: 'ollama_fixture_request', path: req.url, call: requests.length });
        const action = actions[requests.length - 1];
        if (!action) { res.writeHead(500).end('{}'); return; }
        res.end(JSON.stringify({ done: true, model: 'qwen2.5-coder:7b', message: { content: JSON.stringify(action) } }));
      } catch { res.writeHead(400).end('{}'); }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  loopbackOrigins.add(url);
  return { requests, model: new LocalModel(url, 'qwen2.5-coder:7b') };
}
const cliResult = (action: Action): RunResult => ({ code: 0, stderr: '', timedOut: false,
  stdout: JSON.stringify({ is_error: false, result: JSON.stringify(action), modelUsage: { 'claude-fixture': { outputTokens: 5 } } }) });

describe('parseToolsConfig', () => {
  it('defaults to enabled with 12 calls, 60 seconds and 6000 result characters', () => {
    expect(parseToolsConfig(undefined)).toMatchObject({ enabled: true, budget: { calls: 12, wallMs: 60000, resultChars: 6000 }, memory: { crystal: false } });
  });
  it('refuses an unknown top-level key', () => {
    expect(() => parseToolsConfig({ unexpected: true })).toThrow('unknown tools field "unexpected"');
  });
  it('refuses an unknown family', () => {
    expect(() => parseToolsConfig({ families: { shell: true } })).toThrow('unknown families field "shell"');
  });
  it.each([{ calls: 0 }, { calls: 31 }, { wallMs: 999 }, { resultChars: 499 }])('refuses budget bounds %j', budget => {
    expect(() => parseToolsConfig({ budget })).toThrow(/budget\..*must be an integer between/);
  });
  it('refuses relative skills roots', () => {
    expect(() => parseToolsConfig({ skills: { roots: ['./skills'] } })).toThrow('skills.roots must list up to 8 absolute directories');
  });
  it.each([{ allow: 'esh:esh_status' }, { allow: ['esh'] }, { allow: [42] }, { allow: ['esh:*'] }, { allow: ['esh:tool:extra'] }])('refuses malformed mcp.allow %j', ({ allow }) => {
    expect(() => parseToolsConfig({ mcp: { allow } })).toThrow('mcp.allow must list up to 64');
  });
  it('refuses ESH execution while accepting ESH status', () => {
    expect(() => parseToolsConfig({ mcp: { allow: ['esh:esh_run'] } })).toThrow('bypass the ESH review-then-run boundary');
    expect(parseToolsConfig({ mcp: { allow: ['esh:esh_status'] } }).mcp.allow).toEqual(['esh:esh_status']);
  });
  it('returns a deep copy that cannot mutate DEFAULT_TOOLS', () => {
    const before = structuredClone(DEFAULT_TOOLS), config = parseToolsConfig(undefined);
    config.enabled = false; config.families.web = false; config.budget.calls = 2;
    config.skills.roots.push(tmpdir()); config.mcp.allow.push('esh:esh_status'); config.memory.crystal = true;
    expect(DEFAULT_TOOLS).toEqual(before); expect(parseToolsConfig(undefined)).toEqual(before);
  });
});

describe('tool utilities', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1'])('classifies %s as non-global', ip => {
    expect(isGlobalIp(ip), `Non-global address ${ip} must be refused`).toBe(false);
  });
  it.each(['93.184.216.34', '1.1.1.1', '2606:4700::1111'])('classifies %s as global', ip => {
    expect(isGlobalIp(ip), `Public address ${ip} must be accepted`).toBe(true);
  });
  it('normalizes query whitespace and case in argsKey', () => {
    expect(argsKey('web_search', { query: ' Hello  World ' })).toBe(argsKey('web_search', { query: 'hello world' }));
  });
  it('normalizes object key ordering without mixing tools', () => {
    expect(argsKey('web_search', { query: 'x', options: { b: 2, a: 1 } })).toBe(argsKey('web_search', { options: { a: 1, b: 2 }, query: 'x' }));
    expect(argsKey('web_search', { query: 'x' })).not.toBe(argsKey('wolfram', { query: 'x' }));
  });
  it('compacts long text under budget while preserving a citable URL verbatim', () => {
    const url = 'https://example.com/CaseSensitive?q=Hello%20World&x=1#section', text = 'long text '.repeat(6000);
    const result = compact({ url, text }, 700);
    expect(result).toMatchObject({ url, text: expect.stringContaining('[truncated') });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(700);
  });
  it.each([{ api_key: 'x' }, { options: { password: 'x' } }])('refuses credential-shaped arguments %j', args => {
    expect(() => refuseSecrets(args)).toThrow(ToolRefused);
    expect(() => refuseSecrets(args)).toThrow('Credential-shaped arguments are refused');
  });
  const params: Record<string, ParamSpec> = {
    query: { type: 'string', required: true, max: 8, description: 'Query' },
    limit: { type: 'integer', min: 1, max: 3, description: 'Count' },
    mode: { type: 'string', enum: ['brief', 'full'], description: 'Format' },
    options: { type: 'object', max: 100, description: 'Options' },
  };
  it('refuses unknown argument keys', () => {
    expect(() => validateArgs(params, { query: 'x', shell: 'run' })).toThrow('Unknown argument "shell"');
  });
  it('refuses incorrect string and object types', () => {
    expect(() => validateArgs(params, { query: 42 })).toThrow('"query" must be a non-empty string');
    expect(() => validateArgs(params, { query: 'x', options: [] })).toThrow('"options" must be an object');
  });
  it('refuses oversized strings', () => {
    expect(() => validateArgs(params, { query: '123456789' })).toThrow('"query" exceeds 8 characters');
  });
  it.each([0, 4, 1.5, 'many'])('refuses invalid integer %j', limit => {
    expect(() => validateArgs(params, { query: 'x', limit })).toThrow('"limit" must be an integer between 1 and 3');
  });
  it('refuses enum violations', () => {
    expect(() => validateArgs(params, { query: 'x', mode: 'other' })).toThrow('"mode" must be one of brief, full');
  });
  it('accepts and normalizes valid arguments', () => {
    expect(validateArgs(params, { query: ' x ', limit: '2', mode: 'brief', options: { extra: true } })).toEqual({ query: 'x', limit: 2, mode: 'brief', options: { extra: true } });
  });
});

describe('ToolCache and TurnTools', () => {
  it('expires cache entries using the injected clock', () => {
    let now = NOW;
    const cache = new ToolCache(() => now); cache.set('key', { ok: true });
    now += 100; expect(cache.get('key', 100)).toEqual({ ok: true });
    now++; expect(cache.get('key', 100)).toBeUndefined(); expect(cache.size).toBe(0);
  });
  it('evicts the least recently read entry at the cache bound', () => {
    const cache = new ToolCache(() => NOW, 2);
    cache.set('a', 1); cache.set('b', 2); expect(cache.get('a', 100)).toBe(1); cache.set('c', 3);
    expect(cache.get('b', 100)).toBeUndefined(); expect(cache.get('a', 100)).toBe(1); expect(cache.size).toBe(2);
  });
  it('shares a TTL cache across two turns and marks the cached event', async () => {
    const sdk = sdkStub(), host = kit(undefined, { sdk }), first = turn(host), second = turn(host);
    const original = await first.execute(searchAction());
    expect(await second.execute(searchAction())).toEqual(original);
    expect(sdk).toHaveBeenCalledTimes(1); expect(second.used).toBe(0);
    expect(second.events[1]).toMatchObject({ type: 'tool_result', cache_hit: true, evidence: { status: 'cached' } });
  });
  it('calls the SDK again after a tool TTL expires', async () => {
    let now = NOW;
    const sdk = sdkStub(), host = kit(undefined, { sdk, now: () => now });
    await turn(host).execute(searchAction()); now += webSearch.spec.cacheTtlMs + 1;
    const next = turn(host); await next.execute(searchAction());
    expect(sdk).toHaveBeenCalledTimes(2);
    expect(next.events[1]).toMatchObject({ cache_hit: false, evidence: { status: 'returned' } });
  });
  it('deduplicates an identical call in one turn without spending another call', async () => {
    const sdk = sdkStub(), tools = turn(kit(undefined, { sdk }));
    await tools.execute(searchAction());
    expect(await tools.execute(searchAction())).toMatchObject({ result: { ok: true, deduplicated: true }, stop: false });
    expect(sdk).toHaveBeenCalledTimes(1); expect(tools.used).toBe(1);
    expect(tools.events[3]).toMatchObject({ deduplicated: true, evidence: { status: 'deduplicated' } });
  });
  it('refuses the third distinct call at a two-call budget with one notice, then stops the turn', async () => {
    const sdk = sdkStub(), tools = turn(kit({ budget: { calls: 2 } }, { sdk }));
    await tools.execute(searchAction('one')); await tools.execute(searchAction('two'));
    expect(await tools.execute(searchAction('three'))).toMatchObject({ stop: false, result: { ok: false, error: expect.stringContaining('Tool budget exhausted') } });
    expect(tools.budgetExhausted).toBe(true); expect(tools.used).toBe(2);
    expect(tools.events.at(-1)).toMatchObject({ type: 'tool_result', tool: 'web_search', evidence: { status: 'budget' } });
    // The notice is the whole allowance: the very next tool action ends the turn without another request.
    expect(await tools.execute(searchAction('four'))).toMatchObject({ stop: true, result: { ok: false, error: expect.stringContaining('Tool budget exhausted') } });
    expect(sdk).toHaveBeenCalledTimes(2); expect(tools.events).toHaveLength(6);
  });
  it('stops on the wall clock as well as the call count', async () => {
    let now = NOW;
    const sdk = sdkStub(), tools = turn(kit({ budget: { wallMs: 1000 } }, { sdk, now: () => now }));
    await tools.execute(searchAction('one')); now += 1001;
    expect(await tools.execute(searchAction('two'))).toMatchObject({ stop: false, result: { ok: false, error: expect.stringMatching(/Tool budget exhausted \(1 calls, 1 s of 12 calls \/ 1 s\)/) } });
    expect(tools.budgetExhausted).toBe(true); expect(sdk).toHaveBeenCalledTimes(1);
  });
  it('reports the tools used and the gathered source URLs honestly', async () => {
    const tools = turn(kit()); await tools.execute(searchAction());
    expect(tools.summary()).toContain('web_search'); expect(tools.summary()).toContain(SOURCE);
    expect(tools.summary()).toContain('without a final answer from the model'); expect(tools.sources).toEqual([SOURCE]);
  });
  it('starts three distinct tool calls in parallel and returns per-call statuses', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sdk = vi.fn<SdkInvoke>(async () => { await gate; return searchBody(); }), tools = turn(kit(undefined, { sdk }));
    const pending = tools.execute({ action: 'tools', calls: ['one', 'two', 'three'].map(query => ({ tool: 'web_search', args: { query } })) });
    try { expect(sdk).toHaveBeenCalledTimes(3); expect(tools.used).toBe(3); }
    finally { release(); }
    expect(await pending).toMatchObject({ stop: false, result: { results: ['one', 'two', 'three'].map(query => ({ tool: 'web_search', status: 'returned', result: { ok: true, query } })) } });
  });
  it('runs only four calls from an oversized batch and reports omissions', async () => {
    const sdk = sdkStub(), tools = turn(kit(undefined, { sdk }));
    const result = await tools.execute({ action: 'tools', calls: ['a', 'b', 'c', 'd', 'e', 'f'].map(query => ({ tool: 'web_search', args: { query } })) });
    expect(result).toMatchObject({ result: { omitted: 2, note: 'Only 4 calls run per step', results: Array.from({ length: 4 }, () => ({ status: 'returned' })) } });
    expect(sdk).toHaveBeenCalledTimes(4); expect(tools.used).toBe(4);
  });
  it('refuses an unknown tool and lists available names', async () => {
    const sdk = sdkStub(), tools = turn(kit(undefined, { sdk }));
    const result = await tools.execute({ action: 'tool', tool: 'unknown_tool', args: {} });
    expect(result).toMatchObject({ result: { ok: false, error: expect.stringContaining(`Available: ${tools.toolNames().join(', ')}`) } });
    expect(tools.events[1]).toMatchObject({ tool: 'unknown_tool', evidence: { status: 'refused' } });
    expect(sdk).not.toHaveBeenCalled(); expect(tools.used).toBe(0);
  });
  it('reports a thrown tool as failed and lets the turn continue', async () => {
    const sdk = sdkStub().mockRejectedValueOnce(new Error('Fixture gate unavailable')), tools = turn(kit(undefined, { sdk }));
    expect(await tools.execute(searchAction('first'))).toMatchObject({ stop: false, result: { ok: false, error: 'Fixture gate unavailable', state: 'failed' } });
    expect(tools.events[1]).toMatchObject({ evidence: { status: 'failed' } });
    expect(await tools.execute(searchAction('second'))).toMatchObject({ stop: false, result: { ok: true } });
    expect(sdk).toHaveBeenCalledTimes(2);
  });
  it('emits exactly one correlated start/result pair per call, including dedupe and refusal', async () => {
    const tools = turn(kit()), onEvent = vi.fn<(event: ToolEvent) => void>();
    await tools.execute(searchAction(), onEvent, signal()); await tools.execute(searchAction(), onEvent, signal());
    await tools.execute({ action: 'tool', tool: 'missing', args: {} }, onEvent, signal());
    expect(tools.events).toHaveLength(6); expect(onEvent.mock.calls.map(([event]) => event)).toEqual(tools.events);
    for (let i = 0; i < tools.events.length; i += 2) {
      const started = tools.events[i], ended = tools.events[i + 1];
      expect(started).toMatchObject({ type: 'tool_started', request_id: expect.stringMatching(/^[a-f0-9-]{36}$/) });
      expect(ended).toMatchObject({ type: 'tool_result', request_id: started.request_id, sha256: started.sha256 });
      expect(['returned', 'failed', 'cached', 'deduplicated', 'budget', 'refused']).toContain(ended.evidence?.status);
      if (started.tool !== 'missing') expect(started.sha256).toBe(argsKey('web_search', { query: 'x' }));
    }
    expect(new Set(tools.events.filter(e => e.type === 'tool_started').map(e => e.request_id)).size).toBe(3);
  });
  it('redacts a credential-shaped MCP result before the model and event see it', async () => {
    const { gateway } = gatewayFixture(); gateway.call.mockResolvedValue({ note: 'api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789' });
    const tools = turn(kit({ mcp: { allow: ['esh:esh_status'] } }, { mcp: gateway }));
    const result = await tools.execute({ action: 'tool', tool: 'mcp_plugins', args: { action: 'call', connection: 'esh', tool: 'esh_status' } });
    expect(result).toMatchObject({ result: { ok: true, result: { note: expect.stringContaining('REDACTED') } } });
    expect(JSON.stringify(result)).not.toContain('sk-'); expect(JSON.stringify(tools.events)).not.toContain('sk-');
    expect(tools.events[1]).toMatchObject({ result: { result: { note: expect.stringContaining('REDACTED') } } });
  });
  it('clips a 50 KB stand-in result to the model-facing character budget', async () => {
    const { gateway } = gatewayFixture(); gateway.call.mockResolvedValue({ text: 'x'.repeat(50 * 1024), url: SOURCE });
    const tools = turn(kit({ budget: { resultChars: 1000 }, mcp: { allow: ['esh:esh_status'] } }, { mcp: gateway }));
    const result = await tools.execute({ action: 'tool', tool: 'mcp_plugins', args: { action: 'call', connection: 'esh', tool: 'esh_status' } });
    expect(JSON.stringify(result.result).length).toBeLessThanOrEqual(tools.budget.resultChars + 200);
    expect(JSON.stringify(result.result)).toContain('[truncated'); expect(JSON.stringify(result.result)).toContain(SOURCE);
  });
});

describe('tool audiences and owner toggles', () => {
  it('lists skills and MCP for an owner with configured roots and an allow-list', () => {
    const { root } = skillFixture(), { gateway } = gatewayFixture();
    const tools = turn(kit({ skills: { roots: [root] }, mcp: { allow: ['esh:esh_status'] } }, { mcp: gateway }));
    expect(tools.toolNames()).toEqual(expect.arrayContaining(['skills', 'mcp_plugins']));
  });
  it('never offers skills or MCP plugins to members even when configured', () => {
    const { root } = skillFixture(), { gateway } = gatewayFixture();
    const tools = turn(kit({ skills: { roots: [root] }, mcp: { allow: ['esh:esh_status'] } }, { mcp: gateway }), 'member');
    expect(tools.toolNames()).not.toContain('skills'); expect(tools.toolNames()).not.toContain('mcp_plugins');
    expect(tools.toolNames()).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'wolfram', 'echo_knowledge', 'echo_memory']));
  });
  it('removes both web tools from the next turn after disabling the web family', () => {
    const host = kit(); expect(turn(host).toolNames()).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    host.setFamily('web', false);
    expect(turn(host).toolNames()).not.toContain('web_search'); expect(turn(host).toolNames()).not.toContain('web_fetch');
    expect(turn(host).toolNames()).toContain('wolfram');
  });
  it('returns undefined for owner and member turns when tools are disabled', () => {
    const host = kit(); host.setEnabled(false);
    expect(host.forTurn({ audience: 'owner' })).toBeUndefined(); expect(host.forTurn({ audience: 'member' })).toBeUndefined();
    expect(host.report()).toMatchObject({ enabled: false });
  });
  it('reports why every SDK-dependent tool is unavailable when no SDK is attached', () => {
    const report = kit(undefined, { sdk: undefined }).report(), tools = report.families.flatMap(f => f.tools);
    for (const name of ['web_search', 'wolfram', 'echo_knowledge', 'echo_memory']) {
      expect(tools.find(t => t.name === name), `Missing availability report for ${name}`).toMatchObject({ available: false, reason: expect.stringContaining('SDK gate not attached') });
    }
    expect(tools.find(t => t.name === 'web_fetch')).toMatchObject({ available: true });
  });
});

describe('web_search', () => {
  it('maps the Tavily gate shape to ranked, citable results with a provider and null dates', async () => {
    const sdk = sdkStub().mockResolvedValue({ answer: 'Two sources', results: [
      { title: 'First', url: SOURCE, content: 'First content' },
      { title: 'Second', url: 'https://example.org/two', content: 'Second content' },
    ] });
    const result = await webSearch.run({ query: 'x' }, environment({ sdk }), signal());
    expect(result).toMatchObject({ ok: true, answer: 'Two sources', results: [
      { rank: 1, title: 'First', url: SOURCE, snippet: 'First content', date: null },
      { rank: 2, title: 'Second', url: 'https://example.org/two', snippet: 'Second content', date: null },
    ] });
    expect(result.provider).toContain('Tavily'); expect(result.provider).toContain('echo.websearch.query');
  });
  it('passes max_results through the SDK gate with the abort signal', async () => {
    const sdk = sdkStub(), abort = signal();
    await webSearch.run({ query: 'current facts', max_results: 3 }, environment({ sdk }), abort);
    expect(sdk).toHaveBeenCalledExactlyOnceWith('echo.websearch.query', 'query', { query: 'current facts', max_results: 3 }, abort);
  });
  it('returns ok:false when the provider returns neither results nor an answer', async () => {
    const sdk = sdkStub().mockResolvedValue({ answer: '', results: [] });
    expect(await webSearch.run({ query: 'empty' }, environment({ sdk }), signal())).toMatchObject({ ok: false, error: 'The search provider returned no ranked results' });
  });
});

describe('web_fetch', () => {
  it.each([
    ['file:///etc/passwd', /Only public http: and https:/],
    ['http://127.0.0.1/', /private, loopback/i],
    ['http://10.0.0.1/', /private, loopback/i],
    ['http://[::1]/', /private, loopback/i],
    ['http://localhost/', /private, local/i],
    ['http://user:pw@example.com/', /embedded credentials/],
    ['http://example.com:8080/', /ports 80 or 443/],
  ] as const)('refuses unsafe URL %s before lookup or transport', async (url, message) => {
    const f = fetchFixture(), pending = webFetch.run({ url }, f.env, signal());
    await expect(pending).rejects.toBeInstanceOf(ToolRefused); await expect(pending).rejects.toThrow(message);
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it('refuses a public hostname resolving to a private address before transport', async () => {
    const f = fetchFixture(); f.lookup.mockResolvedValue(['10.0.0.5']);
    const pending = webFetch.run({ url: 'https://example.com/' }, f.env, signal());
    await expect(pending).rejects.toBeInstanceOf(ToolRefused); await expect(pending).rejects.toThrow(/resolves to a private, loopback/i);
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith('example.com'); expect(f.transport).not.toHaveBeenCalled();
  });
  it('follows three redirects, validates every hop and pins the public address', async () => {
    const f = fetchFixture(), abort = signal();
    f.transport.mockResolvedValueOnce(response('', { status: 301, headers: { location: '/one' } }))
      .mockResolvedValueOnce(response('', { status: 302, headers: { location: 'https://example.org/two' } }))
      .mockResolvedValueOnce(response('', { status: 307, headers: { location: '/three#section' } }));
    const result = await webFetch.run({ url: 'https://example.com/start' }, f.env, abort);
    expect(result).toMatchObject({ ok: true, redirects: 3, url: 'https://example.org/three', requested_url: 'https://example.com/start' });
    expect(f.lookup.mock.calls.map(([host]) => host)).toEqual(['example.com', 'example.com', 'example.org', 'example.org']);
    expect(f.transport.mock.calls.map(([url]) => url.toString())).toEqual(['https://example.com/start', 'https://example.com/one', 'https://example.org/two', 'https://example.org/three']);
    for (const [, address, receivedSignal, maxBytes] of f.transport.mock.calls) {
      expect(address).toBe('93.184.216.34'); expect(receivedSignal).toBe(abort); expect(maxBytes).toBe(FETCH_MAX_BYTES);
    }
  });
  it('refuses a fourth redirect without making a fifth request', async () => {
    const f = fetchFixture(); f.transport.mockResolvedValue(response('', { status: 302, headers: { location: '/again' } }));
    await expect(webFetch.run({ url: 'https://example.com/' }, f.env, signal())).rejects.toThrow('redirected more than 3 times');
    expect(f.transport).toHaveBeenCalledTimes(4); expect(f.lookup).toHaveBeenCalledTimes(4);
  });
  it('revalidates redirects and refuses a hop to loopback', async () => {
    const f = fetchFixture(); f.transport.mockResolvedValueOnce(response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }));
    await expect(webFetch.run({ url: 'https://example.com/' }, f.env, signal())).rejects.toThrow(/private, loopback/i);
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.lookup).toHaveBeenCalledTimes(1);
  });
  it('strips script and style content and returns a title, readable text and ISO timestamp', async () => {
    const f = fetchFixture(); f.transport.mockResolvedValue(response('<html><head><title>Facts &amp; figures</title></head><body><script>badScript()</script><style>.hidden{color:red}</style><p>First paragraph</p><p>Second paragraph</p></body></html>'));
    const result = await webFetch.run({ url: 'https://example.com/' }, f.env, signal());
    expect(result).toMatchObject({ ok: true, title: 'Facts & figures', fetched_at: new Date(NOW).toISOString(), javascript_executed: false, truncated: false });
    expect(result.text).toContain('First paragraph\n'); expect(result.text).toContain('Second paragraph');
    expect(result.text).not.toContain('badScript'); expect(result.text).not.toContain('.hidden');
  });
  it('preserves transport truncation even for short returned text', async () => {
    const f = fetchFixture(); f.transport.mockResolvedValue(response('<p>Partial</p>', { truncated: true }));
    expect(await webFetch.run({ url: 'https://example.com/' }, f.env, signal())).toMatchObject({ ok: true, text: 'Partial', truncated: true });
  });
  it('refuses PDF content', async () => {
    const f = fetchFixture(); f.transport.mockResolvedValue(response('%PDF fixture', { headers: { 'content-type': 'application/pdf' } }));
    await expect(webFetch.run({ url: 'https://example.com/file.pdf' }, f.env, signal())).rejects.toThrow('binary download (application/pdf)');
  });
  it('decodes ampersands and preserves paragraph breaks in pageText', () => {
    expect(pageText('<p>A &amp; B</p><p>C</p>')).toEqual({ title: null, text: 'A & B\n\nC' });
  });
});

describe('wolfram', () => {
  it('maps a configured gate result to a Wolfram source URL and provider', async () => {
    const query = 'integrate x^2 from 0 to 3', sdk = sdkStub().mockResolvedValue({ ok: true, query, result: 'The integral is 9.' }), abort = signal();
    const result = await wolfram.run({ query }, environment({ sdk }), abort);
    expect(result).toMatchObject({ ok: true, query, result: 'The integral is 9.', source: 'https://www.wolframalpha.com/input?i=' + encodeURIComponent(query) });
    expect(result.provider).toContain('echo.wolfram.llm');
    expect(sdk).toHaveBeenCalledExactlyOnceWith('echo.wolfram.llm', 'llm', { query }, abort);
  });
  it('explains an absent AppID with the developer signup URL', async () => {
    const sdk = sdkStub().mockResolvedValue({ ok: false, appid_present: false });
    const result = await wolfram.run({ query: '3^2' }, environment({ sdk }), signal());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Wolfram not configured/), signup: 'https://developer.wolframalpha.com/' });
    expect(result.error).toContain('https://developer.wolframalpha.com/');
  });
  it('maps a thrown appid error to the same unconfigured message', async () => {
    const args = { query: '3^2' }, missing = await wolfram.run(args, environment({ sdk: sdkStub().mockResolvedValue({ ok: false, appid_present: false }) }), signal());
    const thrown = await wolfram.run(args, environment({ sdk: sdkStub().mockRejectedValue(new Error('invalid appid from fixture')) }), signal());
    expect(thrown).toEqual(missing); expect(thrown.error).toMatch(/^Wolfram not configured/);
  });
  it('is unavailable without the SDK', () => {
    expect(wolfram.available(environment())).toMatchObject({ available: false, reason: expect.stringContaining('echo.wolfram.llm') });
  });
});

describe('echo_knowledge', () => {
  it('maps hybrid search hits to ranked document references', async () => {
    const sdk = sdkStub().mockResolvedValue({ hits: [
      { title: 'First', path: 'docs/first.md', corpus_id: 'echo', snippet: 'First body', hybrid_score: 0.9, modes: ['fts', 'vector'] },
      { title: 'Second', path: 'docs/second.md', corpus_id: 'echo', snippet: 'Second body', hybrid_score: 0.8, modes: ['fts'] },
    ] }), abort = signal();
    const result = await echoKnowledge.run({ query: 'tools', limit: 2 }, environment({ sdk }), abort);
    expect(result).toMatchObject({ ok: true, source: 'echo.knowledge.search', hit_count: 2, hits: [
      { rank: 1, title: 'First', path: 'docs/first.md', corpus_id: 'echo', snippet: 'First body', score: 0.9, modes: ['fts', 'vector'] },
      { rank: 2, title: 'Second', path: 'docs/second.md', corpus_id: 'echo', snippet: 'Second body', score: 0.8, modes: ['fts'] },
    ] });
    expect(sdk).toHaveBeenCalledExactlyOnceWith('echo.knowledge.search', 'search', { query: 'tools', limit: 2, snippet_chars: 400 }, abort);
  });
  it('reads a doc_id with include_body:true and returns its body', async () => {
    const sdk = sdkStub().mockResolvedValue({ data: { doc_id: 'doc:123', title: 'Tools', body_md: '# Tool instructions' } }), abort = signal();
    expect(await echoKnowledge.run({ doc_id: 'doc:123' }, environment({ sdk }), abort)).toMatchObject({ ok: true, source: 'echo.knowledge.get', doc_id: 'doc:123', body: '# Tool instructions' });
    expect(sdk).toHaveBeenCalledExactlyOnceWith('echo.knowledge.get', 'get', { doc_id: 'doc:123', include_body: true }, abort);
  });
  it('refuses an invalid document ID before invoking the gate', async () => {
    const sdk = sdkStub();
    await expect(echoKnowledge.run({ doc_id: '../secret' }, environment({ sdk }), signal())).rejects.toThrow('doc_id has an invalid shape');
    expect(sdk).not.toHaveBeenCalled();
  });
  it('refuses a request containing neither query nor doc_id', async () => {
    const sdk = sdkStub();
    await expect(echoKnowledge.run({}, environment({ sdk }), signal())).rejects.toThrow('Give a query to search or a doc_id to read');
    expect(sdk).not.toHaveBeenCalled();
  });
});

describe('echo_memory', () => {
  it('maps recalled data and passes the kind filter through the SDK', async () => {
    const memory = { id: 'memory-1', kind: 'decision', content: 'Use injected tools', created_at: '2026-11-03T12:00:00Z' };
    const sdk = sdkStub().mockResolvedValue({ data: [memory] }), abort = signal();
    expect(await echoMemory.run({ query: 'tools', kind: 'decision', limit: 2 }, environment({ sdk }), abort)).toMatchObject({ ok: true, source: 'echo.context.recall', count: 1, memories: [memory], notice: 'Historical, unverified reference data' });
    expect(sdk).toHaveBeenCalledExactlyOnceWith('echo.context.recall', 'recall', { query: 'tools', limit: 2, kind: 'decision' }, abort);
  });
  it('never queries Crystal with the default kit configuration', async () => {
    const sdk = sdkStub().mockResolvedValue({ data: [] }), tools = turn(kit(undefined, { sdk }));
    await tools.execute({ action: 'tool', tool: 'echo_memory', args: { query: 'tools' } });
    expect(sdk.mock.calls.map(([capability]) => capability)).toEqual(['echo.context.recall']);
    expect(sdk).not.toHaveBeenCalledWith('echo.crystal.search', expect.anything(), expect.anything(), expect.anything());
  });
  it('queries Crystal only after explicit memory.crystal configuration', async () => {
    const sdk = vi.fn<SdkInvoke>(async capability => capability === 'echo.context.recall' ? { data: [] }
      : { hits: [{ id: 'crystal-1', kind: 'fact', summary: 'Historical tool fact', created_at: '2026-11-03' }] });
    const tools = turn(kit({ memory: { crystal: true } }, { sdk }));
    expect(await tools.execute({ action: 'tool', tool: 'echo_memory', args: { query: 'tools', limit: 2 } })).toMatchObject({ result: { ok: true, crystal: [{ id: 'crystal-1', summary: 'Historical tool fact' }] } });
    expect(sdk.mock.calls.map(([capability]) => capability)).toEqual(['echo.context.recall', 'echo.crystal.search']);
    expect(sdk).toHaveBeenLastCalledWith('echo.crystal.search', 'search', { query: 'tools', limit: 2 }, expect.any(AbortSignal));
  });
});

describe('skills', () => {
  it('lists two skills at level 1 with descriptions and a directory-name fallback', async () => {
    const f = skillFixture();
    expect(await skills.run({ action: 'list' }, f.env, signal())).toMatchObject({ ok: true, level: 1, count: 2, skills: [
      { name: 'alpha', description: 'Alpha procedure' }, { name: 'beta', description: 'Beta procedure' },
    ] });
  });
  it('loads level 2 instructions, reference names and the permission notice', async () => {
    const f = skillFixture();
    expect(await skills.run({ action: 'load', name: 'alpha' }, f.env, signal())).toMatchObject({ ok: true, level: 2, instructions: 'Read the alpha guide.', references: ['guide.md'], notice: SKILL_NOTICE });
  });
  it('reads a listed reference as level 3 content', async () => {
    const f = skillFixture();
    expect(await skills.run({ action: 'reference', name: 'alpha', file: 'guide.md' }, f.env, signal())).toMatchObject({ ok: true, level: 3, name: 'alpha', file: 'guide.md', content: '# Guide\nCite your sources.\n', notice: SKILL_NOTICE });
  });
  it.each(['../SKILL.md', 'not-listed.md'])('refuses reference %s', async file => {
    const f = skillFixture();
    await expect(skills.run({ action: 'reference', name: 'alpha', file }, f.env, signal())).rejects.toThrow('Give one of the reference file names listed by action=load');
  });
  it('refuses an unknown skill name', async () => {
    const f = skillFixture();
    await expect(skills.run({ action: 'load', name: 'missing' }, f.env, signal())).rejects.toThrow('No installed skill is named "missing"');
  });
  it('skips skill files larger than 48 KB', async () => {
    const f = skillFixture(); mkdirSync(join(f.root, 'oversized')); writeFileSync(join(f.root, 'oversized', 'SKILL.md'), 'x'.repeat(48 * 1024 + 1));
    const result = await skills.run({ action: 'list' }, f.env, signal());
    expect(result).toMatchObject({ count: 2, skills: [{ name: 'alpha' }, { name: 'beta' }] });
    expect(JSON.stringify(result)).not.toContain('oversized');
  });
  it('is unavailable when no skill roots are configured', () => {
    expect(skills.available(environment())).toMatchObject({ available: false, reason: expect.stringContaining('No skill roots configured') });
  });
});

describe('mcp_plugins', () => {
  it('lists only the allow-listed esh_status tool and connection', async () => {
    const f = gatewayFixture();
    const result = await mcpPlugins.run({ action: 'list' }, f.env, signal());
    expect(result).toMatchObject({ ok: true, connections: [{ id: 'esh', name: 'Echo Shell', tools: [{ name: 'esh_status', description: 'Read status' }] }] });
    expect(JSON.stringify(result)).not.toContain('esh_run'); expect(JSON.stringify(result)).not.toContain('"sdk"');
    expect(f.gateway.call).not.toHaveBeenCalled();
  });
  it('returns the advertised inputSchema for esh_status', async () => {
    const f = gatewayFixture();
    expect(await mcpPlugins.run({ action: 'schema', connection: 'esh', tool: 'esh_status' }, f.env, signal())).toMatchObject({ ok: true, connection: 'esh', tool: 'esh_status', input_schema: f.inputSchema });
    expect(f.gateway.call).not.toHaveBeenCalled();
  });
  it('refuses esh_run without ever invoking the gateway call', async () => {
    const f = gatewayFixture(), pending = mcpPlugins.run({ action: 'call', connection: 'esh', tool: 'esh_run', arguments: {} }, f.env, signal());
    await expect(pending).rejects.toBeInstanceOf(ToolRefused); await expect(pending).rejects.toThrow('not allow-listed or not advertised');
    expect(f.gateway.call).not.toHaveBeenCalled();
  });
  it('calls an allow-listed status tool and labels its result untrusted', async () => {
    const f = gatewayFixture(), abort = signal();
    expect(await mcpPlugins.run({ action: 'call', connection: 'esh', tool: 'esh_status', arguments: { detail: true } }, f.env, abort)).toMatchObject({ ok: true, result: { state: 'ready' }, untrusted: true });
    expect(f.gateway.call).toHaveBeenCalledExactlyOnceWith('esh', 'esh_status', { detail: true }, abort);
  });
  it('is unavailable with an empty allow-list even when a gateway is attached', () => {
    const f = gatewayFixture();
    expect(mcpPlugins.available({ ...f.env, mcpAllow: [] })).toMatchObject({ available: false, reason: expect.stringContaining('No MCP tools allow-listed') });
  });
});

describe('model tool action contract', () => {
  it('accepts a single tool action', () => {
    expect(parseAction({ action: 'tool', tool: 'web_search', args: { query: 'x' } })).toEqual(searchAction());
  });
  it('defaults missing tool args to an empty object', () => {
    expect(parseAction({ action: 'tool', tool: 'web_search' })).toEqual({ action: 'tool', tool: 'web_search', args: {} });
  });
  it.each(['Web Search', '../x'])('refuses invalid tool name %s', tool => {
    expect(() => parseAction({ action: 'tool', tool, args: {} })).toThrow('tool name and object args');
  });
  it.each([{ args: null }, { args: [] }, { args: 'query' }, { args: 42 }])('refuses non-object tool args %j', ({ args }) => {
    expect(() => parseAction({ action: 'tool', tool: 'web_search', args })).toThrow('tool name and object args');
  });
  it.each([0, 5])('refuses a tools action with %i calls', count => {
    expect(() => parseAction({ action: 'tools', calls: Array.from({ length: count }, () => ({ tool: 'web_search', args: { query: 'x' } })) })).toThrow('needs 1-4 calls');
  });
  it('accepts a valid parallel action and normalizes missing args', () => {
    expect(parseAction({ action: 'tools', calls: [{ tool: 'web_search', args: { query: 'x' } }, { tool: 'skills' }] })).toEqual({ action: 'tools', calls: [{ tool: 'web_search', args: { query: 'x' } }, { tool: 'skills', args: {} }] });
  });
  it('advertises both tool action forms in the structured output schema', () => {
    expect(ACTION_FORMAT.properties.action.enum).toContain('tool'); expect(ACTION_FORMAT.properties.action.enum).toContain('tools');
  });
});

describe('runTurn with always-on live tools', () => {
  it('feeds Qwen the live catalogue and an untrusted tool result before its final answer', async () => {
    const f = workspaceFixture(), fake = await ollama([searchAction(), { action: 'final', content: 'Qwen fixture answer' }]);
    const sdk = sdkStub(), tools = turn(kit(undefined, { sdk })), onToolEvent = vi.fn<(event: ToolEvent) => void>();
    const result = await runTurn({ ...f, model: fake.model, prompt: 'Search for x', tools, onToolEvent, signal: signal() });
    expect(result).toMatchObject({ status: 'completed', answer: 'Qwen fixture answer', tools: { calls: 1, exhausted: false, sources: [SOURCE] } });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].messages.find(m => m.role === 'system')?.content).toContain('Live tools');
    const evidence = fake.requests[1].messages.find(m => m.role === 'user' && m.content.startsWith('UNTRUSTED TOOL RESULT (tool web_search):'));
    expect(evidence?.content).toContain('Tavily'); expect(evidence?.content).toContain('echo.websearch.query'); expect(evidence?.content).toContain(SOURCE);
    expect(result.tools?.events).toHaveLength(2); expect(onToolEvent).toHaveBeenCalledTimes(2);
    expect(onToolEvent.mock.calls.map(([event]) => event)).toEqual(result.tools?.events); expect(sdk).toHaveBeenCalledTimes(1);
    expect(f.store.get(f.sessionId).status).toBe('completed');
  });
  it('feeds a CLI planning model the tool result and catalogue on stdin', async () => {
    const f = workspaceFixture(), sdk = sdkStub();
    const runner = vi.fn<Runner>().mockResolvedValueOnce(cliResult(searchAction())).mockResolvedValueOnce(cliResult({ action: 'final', content: 'CLI fixture answer' }));
    const model = new CliModel('claude', { runner });
    const result = await runTurn({ ...f, model, prompt: 'Search for x', tools: turn(kit(undefined, { sdk })), signal: signal() });
    expect(result).toMatchObject({ status: 'completed', answer: 'CLI fixture answer', tools: { calls: 1 } });
    expect(runner).toHaveBeenCalledTimes(2);
    const input = runner.mock.calls[1][2].input;
    expect(input).toContain('UNTRUSTED TOOL RESULT (tool web_search):'); expect(input).toContain('Live tools'); expect(input).toContain(SOURCE);
    expect(input?.split('<conversation>')[0]).toContain('"action":"tool"');
    expect(runner.mock.calls[0][0]).toBe('claude'); expect(sdk).toHaveBeenCalledTimes(1);
  });
  it('ends a model that keeps requesting tools with an application-generated budget summary', async () => {
    const f = workspaceFixture(), sdk = sdkStub(); let step = 0;
    const next = vi.fn<Model['next']>(async () => searchAction(`query ${++step}`));
    const result = await runTurn({ ...f, model: { next }, prompt: 'Keep searching', maxSteps: 10, tools: turn(kit({ budget: { calls: 2 } }, { sdk })) });
    expect(result).toMatchObject({ status: 'step_limit', answerVerification: 'application_generated', tools: { calls: 2, exhausted: true } });
    expect(result.answer).toContain('Tool budget reached'); expect(result.answer).toContain('web_search'); expect(result.answer).toContain(SOURCE);
    expect(sdk).toHaveBeenCalledTimes(2); expect(next.mock.calls.length).toBeLessThan(10);
    expect(f.store.get(f.sessionId).status).toBe('step_limit');
  });
});

describe('Prime tools bridge', () => {
  function brokerFixture() {
    return { search: vi.fn<SdkBroker['search']>(async () => []), read: vi.fn<SdkBroker['read']>(async () => ({})),
      invoke: vi.fn<SdkBroker['invoke']>(async () => ({ run_id: 'fixture-run', status: 'ok', result: { status_code: 200, body: searchBody() } })) } satisfies SdkBroker;
  }
  function connectionFixture(name: string) {
    return { listTools: vi.fn<McpConnection['listTools']>(async () => [{ name, description: 'Fixture tool', inputSchema: { type: 'object' } }]),
      call: vi.fn<McpConnection['call']>(async () => ({ result: { status_code: 200, body: { state: 'ready' } }, status: 'ok' })) } satisfies McpConnection;
  }
  it('sends flat SDK params, reason and idempotency key and unwraps the HTTP body', async () => {
    const broker = brokerFixture();
    expect(await sdkToolInvoke(broker)('echo.websearch.query', 'query', { query: 'x', max_results: 3 }, signal())).toEqual(searchBody());
    expect(broker.invoke).toHaveBeenCalledExactlyOnceWith({ capability: 'echo.websearch.query', params: { command: 'query', query: 'x', max_results: 3 },
      reason: expect.stringContaining('ECHO Prime live tool call'), idempotency_key: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(broker.read).not.toHaveBeenCalled(); expect(broker.search).not.toHaveBeenCalled();
  });
  it('rejects an options command override before sending an SDK request', async () => {
    const broker = brokerFixture();
    await expect(sdkToolInvoke(broker)('echo.websearch.query', 'query', { command: 'different' }, signal())).rejects.toThrow('cannot override command');
    expect(broker.invoke).not.toHaveBeenCalled();
  });
  it.each(['other.search', 'echoxquery', 'echo.', '../echo.search'])('refuses invalid capability %s without invoking the broker', async capability => {
    const broker = brokerFixture();
    await expect(sdkToolInvoke(broker)(capability, 'query', {}, signal())).rejects.toThrow('Invalid capability ID');
    expect(broker.invoke).not.toHaveBeenCalled();
  });
  it('lists advertised tools from every configured connection', async () => {
    const esh = connectionFixture('esh_status'), sdk = connectionFixture('search');
    expect(await connectionGateway({ esh, sdk, absent: undefined }).list()).toEqual([
      { id: 'esh', name: 'esh', tools: [{ name: 'esh_status', description: 'Fixture tool', inputSchema: { type: 'object' } }] },
      { id: 'sdk', name: 'sdk', tools: [{ name: 'search', description: 'Fixture tool', inputSchema: { type: 'object' } }] },
    ]);
    expect(esh.listTools).toHaveBeenCalledTimes(1); expect(sdk.listTools).toHaveBeenCalledTimes(1);
  });
  it('refuses an unadvertised tool before calling the connection', async () => {
    const esh = connectionFixture('esh_status'), gateway = connectionGateway({ esh });
    await expect(gateway.call('esh', 'esh_run', {}, signal())).rejects.toThrow('MCP tool not advertised');
    expect(esh.call).not.toHaveBeenCalled();
  });
  it('calls an advertised tool and unwraps its result', async () => {
    const esh = connectionFixture('esh_status'), gateway = connectionGateway({ esh });
    expect(await gateway.call('esh', 'esh_status', { detail: true }, signal())).toEqual({ state: 'ready' });
    expect(esh.call).toHaveBeenCalledExactlyOnceWith('esh_status', { detail: true });
  });
});
