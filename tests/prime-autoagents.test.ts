import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeHub, type SdkBroker } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { OwnerBotTools } from '../src/prime/bot-tools.js';
import { AdkClient, AdkError, DEFAULT_ADK, parseAgentDefinition } from '../src/prime/agents.js';
import { BotsClient, DEFAULT_BOTS } from '../src/prime/bots.js';
import { AUTOAGENTS_PROMPT_FRAGMENT, AutoAgents, AutoagentError, FLEET_ROLES, autoagentTools, brokerCapabilityLookup, promptSha256, slugName, type CapabilityLookup, type ResolvedCapability } from '../src/code/tools/autoagents.js';

// Stand-in for the loopback echo-adk-api (contract v1 + the 2026-11-04 20:12 POST/PUT/DELETE /agents addition) with in-memory agents
// and bots, and a stand-in capability catalog. Shapes follow the real service (echoomegaprime/echo-adk PR #1 @ 1056da9): POST /agents 201
// (409 invalid when the name exists; 422 invalid when a capability is outside its default-deny registry), PUT /agents/{name} 404 when
// missing (never creates), DELETE /agents/{name} 409 while a bot references it; `gated` is a run status, never an HTTP error code.
// No real service, model or catalog is reached.
const BOT = 'b'.repeat(32), SHA = 'a'.repeat(64), NOW = '2026-11-04T21:00:00.000Z';
const REGISTRY = new Set(['echo.knowledge.search', 'echo.context.recall', 'echo.shell.run', 'echo.odd.cap', 'echo.no.tier', 'echo.a', 'echo.fs.write']);
const OWNER_AGENT = { name: 'researcher', role: 'researcher', skills: ['search'], capabilities: ['echo.knowledge.search'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 60, max_cost_usd: 0, max_wall_s: 1200 } }, max_steps: 12, instruction: 'Verify before claiming.', source: 'agents/researcher.yaml', origin: { by: 'owner', created_at: '2026-11-04T19:00:00Z' } };
type Seen = { method: string; url: string; body: unknown };
type Agent = Record<string, unknown>; type Bot = Record<string, unknown>;
interface Fake { url: string; seen: Seen[]; agents: Agent[]; bots: Bot[]; fail: Partial<Record<string, { status: number; body: unknown }>>; nextBot: number }
const servers: Server[] = []; const dirs: string[] = [];
afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fakeAdk(options: { agents?: Agent[]; bots?: Bot[] } = {}): Promise<Fake> {
  const fake: Fake = { url: '', seen: [], agents: (options.agents ?? [OWNER_AGENT]).map(a => ({ ...a })), bots: (options.bots ?? []).map(b => ({ ...b })), fail: {}, nextBot: 1 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8'); let body: unknown; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const method = req.method ?? '', path = (req.url ?? '').split('?')[0].replace(/^\/v2\//, '/'); fake.seen.push({ method, url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      const reply = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
      const key = method + ' ' + path; const forced = fake.fail[key] ?? fake.fail[method + ' ' + path.replace(/\/[0-9a-f]{32}\//, '/:id/')];
      if (forced) { reply(forced.status, forced.body); return; }
      const agentOf = (p: string) => fake.agents.find(a => a.name === decodeURIComponent(p.split('/')[2]));
      if (method === 'GET' && path === '/health') reply(200, { ok: true, service: 'echo-adk-api', profile: 'ECHO_ADK', version: '0.2.0', agents: fake.agents.length, bots: fake.bots.length, runs_active: 0 });
      else if (method === 'GET' && path === '/agents') reply(200, { agents: fake.agents });
      else if (method === 'POST' && path === '/agents') {
        const def = body as Agent; if (fake.agents.some(a => a.name === def.name)) { reply(409, { error: 'invalid', message: 'agent exists' }); return; }
        const outside = (def.capabilities as string[]).filter(c => !REGISTRY.has(c)); if (outside.length) { reply(422, { error: 'invalid', message: 'capability not in registry: ' + outside.join(', ') }); return; }
        // Like echo-adk 0.1.0: the origin may carry by and prompt_sha256 only; the service stamps created_at itself.
        const origin = (def.origin ?? {}) as Record<string, unknown>; if (Object.keys(origin).some(k => k !== 'by' && k !== 'prompt_sha256')) { reply(400, { error: 'invalid', message: 'origin accepts by and prompt_sha256 only; the service stamps created_at' }); return; }
        const made = { ...def, origin: { by: 'owner', ...origin, created_at: NOW }, source: 'agents/' + def.name + '.json' }; fake.agents.push(made); reply(201, made);
      } else if (method === 'GET' && /^\/agents\/[^/]+$/.test(path)) { const a = agentOf(path); a ? reply(200, a) : reply(404, { error: 'not_found', message: 'no such agent' }); }
      else if (method === 'PUT' && /^\/agents\/[^/]+$/.test(path)) {
        const a = agentOf(path); if (!a) { reply(404, { error: 'not_found', message: 'no such agent' }); return; }
        const outside = ((body as Agent).capabilities as string[]).filter(c => !REGISTRY.has(c)); if (outside.length) { reply(422, { error: 'invalid', message: 'capability not in registry: ' + outside.join(', ') }); return; }
        Object.assign(a, body as Agent); reply(200, a);
      }
      else if (method === 'DELETE' && /^\/agents\/[^/]+$/.test(path)) {
        const a = agentOf(path); if (!a) { reply(404, { error: 'not_found', message: 'no such agent' }); return; }
        if (fake.bots.some(b => b.agent === a.name)) { reply(409, { error: 'invalid', message: 'a bot references this agent' }); return; }
        fake.agents = fake.agents.filter(x => x !== a); reply(200, { name: a.name, deleted: true });
      } else if (method === 'GET' && path === '/bots') reply(200, { bots: fake.bots });
      else if (method === 'POST' && path === '/bots') {
        const b = body as Bot; const made = { bot_id: String(fake.nextBot++).repeat(32).slice(0, 32), name: b.name, agent: b.agent, mode: b.mode ?? 'personal', status: 'paused', schedule: b.schedule ?? null, instruction: b.instruction, plugins: b.plugins ?? [], memory: { scope: 'bot:x' }, lease: b.lease ?? { scopes: [], max_uses: 0, ttl_s: 0 }, daily_cost_cap_usd: b.daily_cost_cap_usd ?? 0, spent_today_usd: 0, inbox_depth: 0, created_at: NOW };
        fake.bots.push(made); reply(201, made);
      } else if (method === 'POST' && /^\/bots\/[0-9a-f]{32}\/(resume|pause)$/.test(path)) {
        const b = fake.bots.find(x => x.bot_id === path.split('/')[2]); if (!b) { reply(404, { error: 'not_found', message: 'no bot' }); return; }
        b.status = path.endsWith('resume') ? 'idle' : 'paused'; reply(200, b);
      } else if (method === 'DELETE' && /^\/bots\/[0-9a-f]{32}$/.test(path)) { const id = path.split('/')[2]; fake.bots = fake.bots.filter(x => x.bot_id !== id); reply(200, { bot_id: id, deleted: true }); }
      else reply(404, { error: 'not_found', message: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; return fake;
}
/** Stand-in live catalog: id → tier (null = the detail carries no tier). Records every resolve so tests can prove nothing was looked up. */
function catalog(entries: Record<string, number | null>) {
  const resolved: string[] = [];
  const lookup: CapabilityLookup = {
    async resolve(id) { resolved.push(id); return id in entries ? { id, tier: entries[id], scope: 'knowledge.read' } satisfies ResolvedCapability : undefined; },
    async search(query) { return Object.entries(entries).filter(([id]) => id.includes(query)).map(([id, tier]) => ({ id, tier: tier ?? 0, registered: true, health: 'green', scope: 'knowledge.read', category: 'discovered', description: 'about ' + id })); },
  };
  return { lookup, resolved };
}
const owner = (prompt: string) => ({ owner: true, prompt });
const CAPS = { 'echo.knowledge.search': 0, 'echo.context.recall': 1, 'echo.shell.run': 2, 'echo.odd.cap': null };
async function service(options: { agents?: Agent[]; bots?: Bot[]; caps?: Record<string, number | null>; botsCap?: number } = {}) {
  const fake = await fakeAdk(options); const cat = catalog(options.caps ?? CAPS); const events: Record<string, unknown>[] = [];
  const adk = new AdkClient({ ...DEFAULT_ADK, baseUrl: fake.url }), bots = new BotsClient({ ...DEFAULT_BOTS, baseUrl: fake.url, defaultBudget: { ...DEFAULT_BOTS.defaultBudget, max_cost_usd: options.botsCap ?? 0 } });
  const auto = new AutoAgents({ adk, bots, caps: cat.lookup, events: e => events.push(e), now: () => new Date(NOW) });
  const posts = (m: string, p: string | RegExp) => fake.seen.filter(s => s.method === m && (typeof p === 'string' ? s.url.split('?')[0] === p : p.test(s.url)));
  return { fake, cat, events, adk, bots, auto, posts, names: () => events.map(e => e.event) };
}
const PROMPT = 'Every morning at 7 check the FORGE build queue and  summarise what is stuck.';
const makeAgentArgs = { name: 'Queue Scout!', role: 'observer', purpose: 'Watch the FORGE build queue each morning', capabilities: ['echo.knowledge.search', 'echo.context.recall'], skills: ['echo-observer-power'], schedule: 60, instruction: 'Report stuck builds only.', max_steps: 50, budget: { max_cost_usd: 40 } };

describe('owner bot creation recovery', () => {
  it('can create the missing agent and retry the same bot admission in one parent request', async () => {
    const { auto, fake } = await service({ agents: [] });
    const tools = new OwnerBotTools(auto, { owner: true, prompt: 'Create my queue scout', sessionId: 'recovery-session', requestId: 'recovery-request' });
    const bot = { action: 'tool' as const, tool: 'make_bot', args: { agent: 'queue-scout', task_key: 'queue-scout' } };
    expect((await tools.execute(bot)).result).toMatchObject({ ok: false });
    expect(fake.bots).toHaveLength(0);
    await tools.execute({ action: 'tool', tool: 'make_agent', args: { name: 'queue-scout', role: 'observer', purpose: 'Inspect the queue', capabilities: [], task_key: 'queue-scout' } });
    expect(fake.agents.map(a => a.name)).toEqual(['queue-scout']);
    const recovered = await tools.execute(bot);
    expect(recovered.result).toMatchObject({ kind: 'autoagent', tool: 'make_bot', bot: { agent: 'queue-scout', status: 'idle' } });
    expect(fake.bots).toHaveLength(1);
    expect((await tools.execute(bot)).result).toMatchObject({ deduplicated: true });
    expect(fake.bots).toHaveLength(1);
    expect(fake.seen.filter(r => r.method === 'POST' && r.url === '/v2/bots')).toHaveLength(1);
  });
});

describe('agent definition validation (client)', () => {
  it('fills the lane defaults, clamps budget and max_steps, and stamps an owner origin', () => {
    const def = parseAgentDefinition({ name: 'queue-scout', role: 'observer', capabilities: ['echo.knowledge.search'], max_steps: 99, lane: { budget: { max_cost_usd: 40 } } });
    expect(def).toMatchObject({ name: 'queue-scout', role: 'observer', skills: [], capabilities: ['echo.knowledge.search'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 40, max_cost_usd: 5, max_wall_s: 900 } }, max_steps: 24, origin: { by: 'owner' } });
    expect(Date.parse(def.origin.created_at)).not.toBeNaN(); expect(def.instruction).toBeUndefined();
    expect(parseAgentDefinition({ name: 'x1', role: 'r', capabilities: ['echo.a'] }).max_steps).toBe(12);
    expect(parseAgentDefinition({ name: 'x1', role: 'r', capabilities: ['echo.a'], max_steps: 0 }).max_steps).toBe(1);
    expect(parseAgentDefinition({ name: 'x1', role: 'r', capabilities: ['echo.a', 'echo.a'], instruction: '   ' }).capabilities).toEqual(['echo.a']);
    expect(parseAgentDefinition({ name: 'x1', role: 'r', capabilities: ['echo.a'], origin: { by: 'echo', prompt_sha256: SHA, created_at: NOW } }).origin).toEqual({ by: 'echo', prompt_sha256: SHA, created_at: NOW });
  });
  it('refuses bad names, non-echo capability ids, unknown keys and malformed origins before any request', () => {
    for (const name of ['Queue', 'a', '-x', 'a.b', 'a b', 'x'.repeat(64), '', 7]) expect(() => parseAgentDefinition({ name, role: 'r', capabilities: ['echo.a'] })).toThrow(/Invalid agent name/);
    for (const capabilities of [['echo.Shell'], ['shell.run'], 'echo.a', ['echo.a/../b'], ['echo.a?x=1']]) expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities })).toThrow(AdkError);
    expect(parseAgentDefinition({ name: 'reason-only', role: 'researcher', capabilities: [] }).capabilities).toEqual([]);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], source: 'x' })).toThrow(/unknown field source/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], lane: { token: 'x' } })).toThrow(/lane has an unknown field/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], origin: { by: 'model' } })).toThrow(/origin.by/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], origin: { by: 'echo', prompt_sha256: 'abc' } })).toThrow(/prompt_sha256/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], origin: { by: 'echo', api_key: 'x' } })).toThrow(/origin has an unknown field/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], instruction: 5 })).toThrow(/instruction/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: 'r', capabilities: ['echo.a'], max_steps: '9' })).toThrow(/max_steps/);
    expect(() => parseAgentDefinition({ name: 'ok-name', role: '', capabilities: ['echo.a'] })).toThrow(/role/);
    expect(() => parseAgentDefinition([])).toThrow(/Invalid agent definition/);
  });
});

describe('AdkClient create / update / delete against the stand-in', () => {
  it('POSTs exactly the validated definition, returns the created record, and keeps the service 409 in the error detail', async () => {
    const fake = await fakeAdk(); const client = new AdkClient({ ...DEFAULT_ADK, baseUrl: fake.url });
    const made = await client.createAgent({ name: 'queue-scout', role: 'observer', capabilities: ['echo.knowledge.search'], origin: { by: 'echo', prompt_sha256: SHA, created_at: NOW } });
    expect(made).toMatchObject({ name: 'queue-scout', source: 'agents/queue-scout.json', origin: { by: 'echo', prompt_sha256: SHA } });
    expect(fake.seen[0]).toMatchObject({ method: 'POST', url: '/agents' });
    expect(fake.seen[0].body).toEqual({ name: 'queue-scout', role: 'observer', skills: [], capabilities: ['echo.knowledge.search'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 } }, max_steps: 12, origin: { by: 'echo', prompt_sha256: SHA } });
    expect(made.origin).toEqual({ by: 'echo', prompt_sha256: SHA, created_at: NOW });
    await expect(client.createAgent({ name: 'queue-scout', role: 'observer', capabilities: ['echo.knowledge.search'] })).rejects.toSatisfy((e: AdkError) => e.status === 409 && e.code === 'invalid' && e.detail.http === 409 && /agent exists/.test(e.message));
    await expect(client.createAgent({ name: 'Bad Name', role: 'observer', capabilities: ['echo.knowledge.search'] })).rejects.toMatchObject({ status: 400 });
    expect(fake.seen).toHaveLength(2);
    fake.fail['POST /agents'] = { status: 201, body: { ...OWNER_AGENT, name: 'other' } };
    await expect(client.createAgent({ name: 'new-one', role: 'observer', capabilities: ['echo.knowledge.search'] })).rejects.toMatchObject({ status: 502, message: /different agent/ });
  });
  it('PUTs a replacement whose name matches the path (404 when missing, never creating), and DELETEs with the service confirmation (409 while a bot references it)', async () => {
    const fake = await fakeAdk({ bots: [{ bot_id: BOT, name: 'Scout', agent: 'researcher', status: 'paused' }] }); const client = new AdkClient({ ...DEFAULT_ADK, baseUrl: fake.url });
    const updated = await client.updateAgent('researcher', { name: 'researcher', role: 'researcher', capabilities: ['echo.knowledge.search', 'echo.context.recall'], origin: { by: 'owner' } });
    expect(updated).toMatchObject({ name: 'researcher', capabilities: ['echo.knowledge.search', 'echo.context.recall'], source: 'agents/researcher.yaml' });
    expect(fake.seen[0]).toMatchObject({ method: 'PUT', url: '/agents/researcher' });
    await expect(client.updateAgent('researcher', { name: 'other-name', role: 'r', capabilities: ['echo.a'] })).rejects.toMatchObject({ status: 400, message: /name must match/ });
    await expect(client.updateAgent('../x', { name: 'researcher', role: 'r', capabilities: ['echo.a'] })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateAgent('missing-one', { name: 'missing-one', role: 'r', capabilities: ['echo.a'] })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(fake.agents.map(a => a.name)).toEqual(['researcher']); // PUT never created anything
    await expect(client.deleteAgent('researcher')).rejects.toSatisfy((e: AdkError) => e.status === 409 && e.code === 'invalid' && e.detail.http === 409 && /a bot references this agent/.test(e.message));
    fake.bots = [];
    expect(await client.deleteAgent('researcher')).toEqual({ name: 'researcher', deleted: true });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/agents/researcher' });
    await expect(client.deleteAgent('researcher')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    fake.fail['DELETE /agents/ghost'] = { status: 200, body: { name: 'ghost', deleted: false } };
    await expect(client.deleteAgent('ghost')).rejects.toMatchObject({ status: 502, message: /did not confirm/ });
    expect(fake.seen).toHaveLength(6);
  });
});

async function primeServer(adk: AdkClient | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-autoagents-')); dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), 'Prime'); writeFileSync(join(dir, 'autoagents.js'), '// autoagents'); writeFileSync(join(dir, 'autoagents.css'), '/* autoagents */');
  const server = await startPrimeServer(new PrimeHub({ capabilities: [], adk }), dir, 0);
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-prime-request': '1' };
  const get = (path: string) => fetch(server.url + path, { headers });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(server.url + path, { method: 'POST', headers: { ...headers, origin: server.url, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  return { server, headers, get, post, close: () => server.close() };
}
describe('Prime routes for agent definitions', () => {
  it('serves POST create (201), :name/update (200) and :name/delete (200) as JSON POSTs; GET on them is 405; off answers 503', async () => {
    const fake = await fakeAdk(); const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: fake.url }));
    try {
      const created = await p.post('/api/prime/adk/agents', { name: 'queue-scout', role: 'observer', capabilities: ['echo.knowledge.search'], origin: { by: 'echo', prompt_sha256: SHA } });
      expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ name: 'queue-scout', origin: { by: 'echo' } });
      const updated = await p.post('/api/prime/adk/agents/queue-scout/update', { name: 'queue-scout', role: 'observer', capabilities: ['echo.context.recall'] });
      expect(updated.status).toBe(200); expect(await updated.json()).toMatchObject({ capabilities: ['echo.context.recall'] });
      const deleted = await p.post('/api/prime/adk/agents/queue-scout/delete', {});
      expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ name: 'queue-scout', deleted: true });
      expect(fake.seen.map(s => `${s.method} ${s.url}`)).toEqual(['POST /agents', 'PUT /agents/queue-scout', 'DELETE /agents/queue-scout']);
      expect((await p.get('/api/prime/adk/agents/queue-scout/update')).status).toBe(405);
      expect((await p.get('/api/prime/adk/agents/queue-scout/delete')).status).toBe(405);
      expect((await p.post('/api/prime/adk/agents', { name: 'Bad', role: 'x', capabilities: ['echo.a'] })).status).toBe(400);
      expect((await p.post('/api/prime/adk/agents/..%2Fx/delete', {})).status).toBe(400);
      expect(fake.seen).toHaveLength(3);
      expect((await fetch(p.server.url + '/autoagents.js')).status).toBe(200);
      expect((await fetch(p.server.url + '/autoagents.css')).headers.get('content-type')).toContain('text/css');
    } finally { await p.close(); }
    const off = await primeServer(undefined);
    try {
      expect((await off.post('/api/prime/adk/agents', { name: 'queue-scout', role: 'r', capabilities: ['echo.a'] })).status).toBe(503);
      expect((await off.post('/api/prime/adk/agents/queue-scout/delete', {})).status).toBe(503);
    } finally { await off.close(); }
  });
  it('requires the same-origin Prime session (CSRF) on every mutation and forwards nothing without it', async () => {
    const fake = await fakeAdk(); const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: fake.url }));
    try {
      const body = JSON.stringify({ name: 'queue-scout', role: 'r', capabilities: ['echo.a'] });
      for (const path of ['/api/prime/adk/agents', '/api/prime/adk/agents/researcher/update', '/api/prime/adk/agents/researcher/delete']) {
        expect((await fetch(p.server.url + path, { method: 'POST', headers: { ...p.headers, origin: 'https://attacker.example', 'content-type': 'application/json' }, body })).status).toBe(403);
        expect((await fetch(p.server.url + path, { method: 'POST', headers: { 'x-prime-request': '1', origin: p.server.url, 'content-type': 'application/json' }, body })).status).toBe(403);
        expect((await fetch(p.server.url + path, { method: 'POST', headers: { ...p.headers, 'content-type': 'application/json' }, body })).status).toBe(403);
      }
      expect(fake.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
});

describe('AutoAgents: tools, status and prompt guidance', () => {
  it('offers find_capabilities, make_agent and make_bot as owner-only tools with schemas; the hub offers none when the feature is off', async () => {
    const s = await service(); const tools = s.auto.tools();
    expect(tools.map(t => t.name)).toEqual(['bot_browser_status', 'bot_browser_action', 'bot_browser_close', 'bot_connections', 'bot_connection_invoke', 'bot_app_catalog', 'bot_memory_read', 'bot_memory_edit', 'bot_continuity_status', 'bot_continuity_capture', 'bot_continuity_reconcile', 'bot_team_templates', 'bot_app_watches', 'create_bot_app_watch', 'enable_bot_app_watch', 'disable_bot_app_watch', 'find_capabilities', 'make_agent', 'make_bot', 'bots_status', 'list_bots', 'get_bot', 'update_bot', 'pause_bot', 'resume_bot', 'stop_bot', 'delete_bot', 'message_bot', 'deliver_bot_event', 'bot_messages', 'bot_run_status', 'stop_bot_run', 'create_bot_group', 'bot_group_status', 'delegate_task']);
    expect(tools.every(t => t.ownerOnly === true && typeof t.description === 'string' && t.description.length > 40)).toBe(true);
    const makeAgent = tools.find(t => t.name === 'make_agent')!;
    expect(makeAgent.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['name', 'role', 'purpose', 'capabilities'] });
    expect((makeAgent.inputSchema.properties as Record<string, { enum?: string[] }>).role.enum).toEqual([...FLEET_ROLES]);
    expect(autoagentTools(s.auto).map(t => t.name)).toEqual(tools.map(t => t.name));
    expect(new PrimeHub({ capabilities: [] }).autoagentTools()).toEqual([]);
    expect(new PrimeHub({ capabilities: [] }).autoagentsStatus()).toMatchObject({ configured: false, reason: /adk, bots and sdk/ });
    expect(new PrimeHub({ capabilities: [], autoagents: s.auto }).autoagentTools()).toHaveLength(tools.length);
    expect(s.auto.status()).toEqual({ configured: true });
    expect(new AutoAgents({ adk: s.adk }).status()).toEqual({ configured: false, reason: 'Autonomous agents are off: the Prime config needs bots, sdk configured' });
    await expect(new AutoAgents({ adk: s.adk }).makeAgent(makeAgentArgs, owner(PROMPT))).rejects.toMatchObject({ status: 503, code: 'off' });
  });
  it('ships a short, testable system-prompt fragment', () => {
    expect(AUTOAGENTS_PROMPT_FRAGMENT.length).toBeLessThan(2500);
    for (const phrase of ['make_agent', 'make_bot', 'find_capabilities', 'delegate_task', 'task_key', 'at most six', 'bot_run_status', 'untrusted data', 'paused bots stay paused'])
      expect(AUTOAGENTS_PROMPT_FRAGMENT).toContain(phrase);
    expect(AUTOAGENTS_PROMPT_FRAGMENT).not.toContain('Never use make_agent or make_bot for a one-shot');
  });
  it('normalises names to the contract slug and hashes the normalised prompt', () => {
    expect(slugName('Queue Scout!')).toBe('queue-scout'); expect(slugName('  Release--Watcher  ')).toBe('release-watcher'); expect(slugName('x')).toBeUndefined(); expect(slugName('!!!')).toBeUndefined(); expect(slugName(5)).toBeUndefined();
    expect(slugName('a'.repeat(80))).toBe('a'.repeat(63));
    expect(promptSha256('  hello   world ')).toBe(promptSha256('hello world'));
    expect(promptSha256('hello world')).toBe(createHash('sha256').update('hello world').digest('hex'));
    expect(promptSha256('Hello world')).not.toBe(promptSha256('hello world'));
  });
});

describe('make_agent', () => {
  it('refuses a member or visitor before anything is requested, and explains that only the owner can create agents', async () => {
    const s = await service();
    for (const ctx of [{ owner: false, prompt: PROMPT }, { owner: 'yes' as unknown as boolean, prompt: PROMPT }, { prompt: PROMPT } as unknown as { owner: boolean; prompt: string }]) {
      await expect(s.auto.makeAgent(makeAgentArgs, ctx)).rejects.toSatisfy((e: AutoagentError) => e.status === 403 && e.code === 'owner_only' && /Only the owner can create agents and bots/.test(e.message));
      await expect(s.auto.makeBot({}, ctx)).rejects.toMatchObject({ code: 'owner_only' });
    }
    expect(s.fake.seen).toHaveLength(0); expect(s.cat.resolved).toHaveLength(0);
    expect(s.names().every(n => n === 'prime_autoagent_refused')).toBe(true); expect(s.events[0]).toMatchObject({ reason: 'owner_only' });
    await expect(s.auto.makeAgent(makeAgentArgs, { owner: true, prompt: '   ' })).rejects.toMatchObject({ status: 400 });
  });
  it('drafts the definition from the prompt: slug name, fleet role, purpose folded into the instruction, qwen-local lane, clamped budget and steps, origin by echo with the prompt hash', async () => {
    const s = await service(); const hash = promptSha256(PROMPT);
    const built = await s.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const post = s.posts('POST', '/agents'); expect(post).toHaveLength(1);
    expect(post[0].body).toEqual({ name: 'queue-scout', role: 'observer', skills: ['echo-observer-power'], capabilities: ['echo.knowledge.search', 'echo.context.recall'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 40, max_cost_usd: 5, max_wall_s: 900 } }, max_steps: 24,
      instruction: 'Purpose: Watch the FORGE build queue each morning\n\nReport stuck builds only.', origin: { by: 'echo', prompt_sha256: hash } });
    expect(built).toMatchObject({ kind: 'autoagent', tool: 'make_agent', promptSha256: hash, agent: { name: 'queue-scout', role: 'observer', purpose: 'Watch the FORGE build queue each morning', capabilities: [{ id: 'echo.knowledge.search', tier: 0 }, { id: 'echo.context.recall', tier: 1 }], skills: ['echo-observer-power'], lane: { node: 'forge', model: 'qwen-local' }, maxSteps: 24, schedule: { every_s: 3600 }, origin: { by: 'echo', prompt_sha256: hash, created_at: NOW }, existing: false } });
    expect(built.bot).toBeUndefined();
    expect(built.summary).toMatch(/Created agent queue-scout \(role observer, lane qwen-local on forge, up to 24 steps, budget 40 calls \/ \$5\.00\) with capabilities echo\.knowledge\.search \(tier 0\), echo\.context\.recall \(tier 1\)/);
    expect(s.events.find(e => e.event === 'prime_autoagent_agent_created')).toMatchObject({ name: 'queue-scout', role: 'observer', capabilities: 2, tiers: [0, 1], promptSha256: hash });
    const minimal = await s.auto.makeAgent({ name: 'tiny', role: 'researcher', purpose: 'p', capabilities: ['echo.knowledge.search'] }, owner('another prompt'));
    expect(minimal.agent).toMatchObject({ maxSteps: 12, lane: { budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 } }, skills: [], schedule: null });
    expect(s.posts('POST', '/agents')[1].body).toMatchObject({ instruction: 'Purpose: p', max_steps: 12 });
  });
  it('refuses unknown capability ids (nothing created) and malformed ids before the catalog is even asked', async () => {
    const s = await service();
    await expect(s.auto.makeAgent({ ...makeAgentArgs, capabilities: ['echo.knowledge.search', 'echo.made.up'] }, owner(PROMPT))).rejects.toSatisfy((e: AutoagentError) => e.status === 400 && e.code === 'unknown_capability' && e.message === 'Unknown capability id: echo.made.up. Only ids present in the live catalog can be granted; nothing was created.');
    expect(s.cat.resolved).toEqual(['echo.knowledge.search', 'echo.made.up']); expect(s.posts('POST', '/agents')).toHaveLength(0);
    expect(s.events.at(-1)).toMatchObject({ event: 'prime_autoagent_refused', reason: 'unknown_capability', ids: ['echo.made.up'] });
    for (const capabilities of [['echo.Shell.run'], ['shell.run'], ['echo.a b'], 'echo.knowledge.search', ['echo.knowledge.search', 7]])
      await expect(s.auto.makeAgent({ ...makeAgentArgs, capabilities }, owner(PROMPT))).rejects.toMatchObject({ status: 400, code: 'invalid' });
    expect(s.cat.resolved).toHaveLength(2); expect(s.posts('POST', '/agents')).toHaveLength(0);
    const cheat = catalog({ 'echo.knowledge.search': 0 }); cheat.lookup.resolve = async () => ({ id: 'echo.knowledge.searchx', tier: 0 });
    await expect(new AutoAgents({ adk: s.adk, bots: s.bots, caps: cheat.lookup }).makeAgent({ ...makeAgentArgs, capabilities: ['echo.knowledge.search'] }, owner(PROMPT))).rejects.toMatchObject({ code: 'unknown_capability' });
  });
  it('refuses a role outside the fleet list, a missing purpose, unusable names, bad budgets and unknown arguments', async () => {
    const s = await service();
    await expect(s.auto.makeAgent({ ...makeAgentArgs, role: 'wizard' }, owner(PROMPT))).rejects.toMatchObject({ status: 400, message: /role must be one of commander, architect, observer, builder, publisher, enhancer, researcher/ });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, purpose: '  ' }, owner(PROMPT))).rejects.toMatchObject({ message: /purpose is required/ });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, name: '!!' }, owner(PROMPT))).rejects.toMatchObject({ message: /name must reduce/ });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, budget: { max_cost_usd: 'free' } }, owner(PROMPT))).rejects.toMatchObject({ message: /must be a number/ });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, lease: { scopes: ['echo.shell.run'] } }, owner(PROMPT))).rejects.toMatchObject({ message: /unknown argument lease/ });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, schedule: { every_s: 30 } }, owner(PROMPT))).rejects.toMatchObject({ message: /every_s must be an integer of at least 60/ });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, max_steps: 'ten' }, owner(PROMPT))).rejects.toMatchObject({ message: /max_steps must be a number/ });
    await expect(s.auto.makeAgent('queue scout', owner(PROMPT))).rejects.toMatchObject({ code: 'invalid' });
    expect(s.posts('POST', '/agents')).toHaveLength(0);
  });
  it('is idempotent per prompt hash: a re-ask returns the existing agent without a second POST, in this process and from the service listing', async () => {
    const s = await service();
    const first = await s.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const again = await s.auto.makeAgent({ ...makeAgentArgs, name: 'Something Else', purpose: 'reworded' }, owner('  ' + PROMPT.replace('  ', ' ') + ' '));
    expect(again.agent).toMatchObject({ name: 'queue-scout', existing: true, origin: { prompt_sha256: first.promptSha256 } }); expect(again.summary).toMatch(/already exists for this request/);
    expect(s.posts('POST', '/agents')).toHaveLength(1); expect(s.events.filter(e => e.event === 'prime_autoagent_agent_existing')).toHaveLength(1);
    const fresh = new AutoAgents({ adk: s.adk, bots: s.bots, caps: s.cat.lookup });
    const other = await fresh.makeAgent({ ...makeAgentArgs, name: 'yet-another' }, owner(PROMPT));
    expect(other.agent).toMatchObject({ name: 'queue-scout', existing: true }); expect(s.posts('POST', '/agents')).toHaveLength(1);
    const different = await s.auto.makeAgent({ ...makeAgentArgs, name: 'evening-scout' }, owner('Every evening check the queue.'));
    expect(different.agent).toMatchObject({ name: 'evening-scout', existing: false }); expect(s.posts('POST', '/agents')).toHaveLength(2);
  });
  it('on a 409 from the service: returns the existing agent when its origin carries this prompt hash, otherwise refuses "name taken" instead of inventing a variant', async () => {
    const hash = promptSha256(PROMPT);
    const mine = await service({ agents: [OWNER_AGENT, { ...OWNER_AGENT, name: 'queue-scout', source: 'agents/queue-scout.json', origin: { by: 'echo', prompt_sha256: hash, created_at: NOW } }] });
    mine.fake.fail['GET /agents'] = { status: 200, body: { agents: [OWNER_AGENT] } }; // the listing misses it, so only the 409 path can find it
    const found = await mine.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    expect(found.agent).toMatchObject({ name: 'queue-scout', existing: true }); expect(mine.posts('POST', '/agents')).toHaveLength(1);
    const taken = await service({ agents: [{ ...OWNER_AGENT, name: 'queue-scout', origin: { by: 'owner', created_at: NOW } }] });
    await expect(taken.auto.makeAgent(makeAgentArgs, owner(PROMPT))).rejects.toSatisfy((e: AutoagentError) => e.status === 409 && e.code === 'name_taken' && /queue-scout already exists and was not made from this request/.test(e.message));
    expect(taken.events.at(-1)).toMatchObject({ reason: 'name_taken', name: 'queue-scout' });
  });
  it('passes the service default-deny refusal through when the catalog knows an id the registry does not; nothing is retried or substituted', async () => {
    const s = await service({ caps: { ...CAPS, 'echo.not.registered': 0 } });
    await expect(s.auto.makeAgent({ ...makeAgentArgs, capabilities: ['echo.knowledge.search', 'echo.not.registered'] }, owner(PROMPT))).rejects.toSatisfy((e: AdkError) => e.status === 400 && e.code === 'invalid' && e.detail.http === 422 && /capability not in registry: echo\.not\.registered/.test(e.message));
    expect(s.posts('POST', '/agents')).toHaveLength(1); expect(s.fake.agents.map(a => a.name)).toEqual(['researcher']);
    expect(s.names().filter(n => n === 'prime_autoagent_agent_created')).toHaveLength(0);
  });
  it('redacts secrets the service echoes back and never keeps them in the built record', async () => {
    const s = await service(); s.fake.fail['POST /agents'] = { status: 201, body: { name: 'queue-scout', role: 'observer', capabilities: ['echo.knowledge.search'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 1, max_cost_usd: 0, max_wall_s: 30 } }, max_steps: 3, instruction: 'Purpose: x api_key=sk-abcdefghijklmnopqrstuvwxyz', origin: { by: 'echo', prompt_sha256: SHA } } };
    const built = await s.auto.makeAgent({ ...makeAgentArgs, capabilities: ['echo.knowledge.search'] }, owner(PROMPT));
    expect(JSON.stringify(built)).not.toContain('sk-abcdefghijklmnop'); expect(built.agent.instruction).toContain('[REDACTED]');
  });
});

describe('make_bot and the auto-resume gate', () => {
  it('creates the bot paused with a lease of exactly the agent capabilities, then resumes it when every tier is 0 or 1 and the cap is within the default', async () => {
    const s = await service();
    await s.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const built = await s.auto.makeBot({ agent: 'queue-scout', name: 'Queue scout', schedule: 60, instruction: 'Post a short summary.' }, owner(PROMPT));
    const create = s.posts('POST', '/v2/bots'); expect(create).toHaveLength(1);
    expect(create[0].body).toEqual({ name: 'Queue scout', agent: 'queue-scout', mode: 'personal', schedule: { every_s: 3600 }, daily_cost_cap_usd: 0, lease: { scopes: ['echo.knowledge.search', 'echo.context.recall'], ttl_s: 3600, max_uses: 100 }, instruction: 'Post a short summary.' });
    expect(s.posts('POST', /\/bots\/[0-9a-f]{32}\/resume$/)).toHaveLength(1);
    expect(built).toMatchObject({ kind: 'autoagent', tool: 'make_bot', promptSha256: promptSha256(PROMPT), agent: { name: 'queue-scout', purpose: 'Watch the FORGE build queue each morning', capabilities: [{ id: 'echo.knowledge.search', tier: 0 }, { id: 'echo.context.recall', tier: 1 }], existing: true },
      bot: { name: 'Queue scout', agent: 'queue-scout', mode: 'personal', status: 'idle', schedule: { every_s: 3600 }, dailyCostCapUsd: 0, existing: false, autoResumed: true, approval: { required: false, reasons: [] } } });
    expect(built.bot!.botId).toMatch(/^[0-9a-f]{32}$/);
    expect(built.summary).toMatch(/Created bot Queue scout for agent queue-scout \(personal, every 60 min, daily cap \$0\.00\)\. Every capability is tier 0 or 1 and the cap is within the default, so Echo resumed it: status idle\./);
    expect(s.names().filter(n => n.startsWith('prime_autoagent_bot'))).toEqual(['prime_autoagent_bot_created', 'prime_autoagent_bot_resumed']);
  });
  it('keeps the bot paused and renders approval reasons when a capability is tier 2 or has no reported tier; no resume is requested', async () => {
    const s = await service();
    await s.auto.makeAgent({ ...makeAgentArgs, name: 'shell-scout', capabilities: ['echo.knowledge.search', 'echo.shell.run'] }, owner('Run the nightly shell cleanup.'));
    const gated = await s.auto.makeBot({ agent: 'shell-scout' }, owner('Run the nightly shell cleanup.'));
    expect(gated.bot).toMatchObject({ status: 'paused', autoResumed: false, existing: false, approval: { required: true, reasons: ['echo.shell.run is tier 2 (auto-resume allows tier 0 or 1)'] } });
    expect(gated.summary).toMatch(/It stays paused until the owner approves: echo\.shell\.run is tier 2/);
    expect(s.posts('POST', /\/resume$/)).toHaveLength(0);
    expect(s.events.at(-1)).toMatchObject({ event: 'prime_autoagent_bot_paused_for_approval', reasons: ['echo.shell.run is tier 2 (auto-resume allows tier 0 or 1)'] });
    await s.auto.makeAgent({ ...makeAgentArgs, name: 'odd-scout', capabilities: ['echo.odd.cap'] }, owner('Watch the odd thing.'));
    const unknown = await s.auto.makeBot({ agent: 'odd-scout' }, owner('Watch the odd thing.'));
    expect(unknown.bot).toMatchObject({ status: 'paused', approval: { required: true, reasons: ['echo.odd.cap has no reported tier (treated as not auto-approvable)'] } });
    expect(s.posts('POST', /\/resume$/)).toHaveLength(0);
  });
  it('keeps the bot paused when the daily cap exceeds the configured default, and resumes a paid bot only when the default allows it', async () => {
    const s = await service();
    await s.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const paid = await s.auto.makeBot({ agent: 'queue-scout', daily_cost_cap_usd: 1.5 }, owner(PROMPT));
    expect(paid.bot).toMatchObject({ status: 'paused', dailyCostCapUsd: 1.5, approval: { required: true, reasons: ['daily cost cap $1.50 exceeds the configured default of $0.00'] } });
    expect(s.posts('POST', '/v2/bots')[0].body).toMatchObject({ daily_cost_cap_usd: 1.5 }); expect(s.posts('POST', /\/resume$/)).toHaveLength(0);
    const generous = await service({ botsCap: 2 });
    await generous.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const allowed = await generous.auto.makeBot({ agent: 'queue-scout', daily_cost_cap_usd: 1.5 }, owner(PROMPT));
    expect(allowed.bot).toMatchObject({ status: 'idle', autoResumed: true, dailyCostCapUsd: 1.5 });
    await expect(generous.auto.makeBot({ agent: 'queue-scout', daily_cost_cap_usd: 6 }, owner('x'))).rejects.toMatchObject({ message: /daily_cost_cap_usd must be between 0 and 5/ });
  });
  it('is idempotent: a second make_bot for the same prompt returns the existing bot without creating another; the agent name defaults to the one made for this prompt', async () => {
    const s = await service();
    await s.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const first = await s.auto.makeBot({}, owner(PROMPT));
    expect(first.bot).toMatchObject({ agent: 'queue-scout', name: 'queue-scout', schedule: { every_s: 3600 }, existing: false, autoResumed: true }); // the schedule make_agent was given carries over
    expect(s.posts('POST', '/v2/bots')[0].body).toMatchObject({ schedule: { every_s: 3600 } });
    const again = await s.auto.makeBot({ agent: 'queue-scout', name: 'Renamed' }, owner(PROMPT));
    expect(again.bot).toMatchObject({ botId: first.bot!.botId, existing: true, autoResumed: false, approval: { required: false } }); expect(again.summary).toMatch(/already exists for agent queue-scout/);
    expect(s.posts('POST', '/v2/bots')).toHaveLength(1); expect(s.posts('POST', /\/resume$/)).toHaveLength(1);
    const fresh = new AutoAgents({ adk: s.adk, bots: s.bots, caps: s.cat.lookup });
    expect((await fresh.makeBot({ agent: 'queue-scout' }, owner('unrelated prompt'))).bot).toMatchObject({ botId: first.bot!.botId, existing: true });
    expect(s.posts('POST', '/v2/bots')).toHaveLength(1);
    expect(s.events.filter(e => e.event === 'prime_autoagent_bot_existing')).toHaveLength(1); // the fresh instance has no event sink
  });
  it('refuses an unknown agent, an agent without capabilities, bad schedules, modes and arguments before any bot is created', async () => {
    const s = await service({ agents: [OWNER_AGENT, { ...OWNER_AGENT, name: 'empty-agent', capabilities: [] }] });
    await expect(s.auto.makeBot({ agent: 'ghost-agent' }, owner(PROMPT))).rejects.toSatisfy((e: AutoagentError) => e.status === 404 && e.code === 'agent_not_found' && /create it with make_agent first/.test(e.message));
    await expect(s.auto.makeBot({}, owner(PROMPT))).rejects.toMatchObject({ message: /agent must name an agent created with make_agent/ });
    await expect(s.auto.makeBot({ agent: 'Researcher' }, owner(PROMPT))).rejects.toMatchObject({ code: 'invalid' });
    await expect(s.auto.makeBot({ agent: 'researcher', schedule: { every_s: 10 } }, owner(PROMPT))).rejects.toMatchObject({ message: /at least 60/ });
    await expect(s.auto.makeBot({ agent: 'researcher', schedule: 0 }, owner(PROMPT))).rejects.toMatchObject({ message: /minutes must be at least 1/ });
    await expect(s.auto.makeBot({ agent: 'researcher', mode: 'shared' }, owner(PROMPT))).rejects.toMatchObject({ message: /mode must be personal or team/ });
    await expect(s.auto.makeBot({ agent: 'researcher', lease: { scopes: ['echo.shell.run'] } }, owner(PROMPT))).rejects.toMatchObject({ message: /unknown argument lease/ });
    await expect(s.auto.makeBot({ agent: 'researcher', name: 'x'.repeat(65) }, owner(PROMPT))).rejects.toMatchObject({ message: /name exceeds 64/ });
    expect(s.posts('POST', '/v2/bots')).toHaveLength(0);
    const ok = await s.auto.makeBot({ agent: 'researcher', schedule: null, mode: 'team' }, owner(PROMPT));
    expect(ok.bot).toMatchObject({ mode: 'team', schedule: null, status: 'idle' }); expect(ok.agent).toMatchObject({ name: 'researcher', purpose: '', origin: { by: 'owner' } });
    expect(s.posts('POST', '/v2/bots')[0].body).toMatchObject({ schedule: null, mode: 'team', lease: { scopes: ['echo.knowledge.search'] } });
  });
  it('when the service refuses the resume, the bot stays paused with that reason and nothing is retried', async () => {
    const s = await service(); s.fake.fail['POST /bots/:id/resume'] = { status: 503, body: { error: 'unavailable', message: 'scheduler down', provider: 'echo-adk-scheduler' } };
    await s.auto.makeAgent(makeAgentArgs, owner(PROMPT));
    const built = await s.auto.makeBot({ agent: 'queue-scout' }, owner(PROMPT));
    expect(built.bot).toMatchObject({ status: 'paused', autoResumed: false, approval: { required: true } });
    expect(built.bot!.approval.reasons[0]).toMatch(/^resume was refused: echoBots service answered HTTP 503: unavailable: scheduler down \(the bot stays paused\)$/);
    expect(s.posts('POST', /\/resume$/)).toHaveLength(1); expect(s.events.at(-1)).toMatchObject({ event: 'prime_autoagent_bot_paused_for_approval' });
  });
});

describe('catalog access', () => {
  it('find_capabilities returns live rows with tiers, refuses an empty query and reports a failed search without substituting', async () => {
    const s = await service();
    const found = await s.auto.findCapabilities({ query: 'knowledge' }, owner(PROMPT));
    expect(found).toEqual({ query: 'knowledge', capabilities: [{ id: 'echo.knowledge.search', tier: 0, scope: 'knowledge.read', registered: true, health: 'green', description: 'about echo.knowledge.search' }], note: 'Use these ids exactly as listed; make_agent refuses ids that are not in the catalog.' });
    await expect(s.auto.findCapabilities({ query: '  ' }, owner(PROMPT))).rejects.toMatchObject({ status: 400 });
    await expect(s.auto.findCapabilities({ query: 'x'.repeat(151) }, owner(PROMPT))).rejects.toMatchObject({ status: 400 });
    await expect(s.auto.findCapabilities({ query: 'x' }, { owner: false, prompt: PROMPT })).rejects.toMatchObject({ code: 'owner_only' });
    s.cat.lookup.search = async () => { throw new Error('Catalog search truncated; use a narrower query'); };
    await expect(s.auto.findCapabilities({ query: 'echo' }, owner(PROMPT))).rejects.toSatisfy((e: AutoagentError) => e.status === 502 && e.code === 'catalog_unavailable' && /truncated/.test(e.message));
  });
  it('brokerCapabilityLookup takes the tier from the cap detail (never the coerced search row), fails closed on unregistered or unknown ids, and filters non-echo rows', async () => {
    const detail = (id: string, over: Record<string, unknown> = {}, cap: Record<string, unknown> = {}) => ({ ok: true, capability: { id, required_scope: 'knowledge.read', description: 'd', ...cap }, registration_state: 'registered', health_status: 'green', ...over });
    const reads = new Map<string, unknown>([
      ['echo.knowledge.search', detail('echo.knowledge.search', {}, { danger_tier: 0 })],
      ['echo.shell.run', detail('echo.shell.run', { metadata: { danger_tier: 2 } })],
      ['echo.no.tier', detail('echo.no.tier')],
      ['echo.red.cap', detail('echo.red.cap', { health_status: 'red' }, { danger_tier: 0 })],
      ['echo.unreg.cap', detail('echo.unreg.cap', { registration_state: 'pending' }, { danger_tier: 0 })],
      ['echo.other.cap', detail('echo.other.capx', {}, { danger_tier: 0 })],
    ]);
    const sdk: SdkBroker = {
      async search(query) { return [{ id: 'echo.knowledge.search', tier: 0, registered: true, health: 'green', scope: 's', category: 'discovered', description: query }, { id: 'not-echo', tier: 0, registered: true, health: 'green', category: 'discovered', description: '' }]; },
      async read(id) { if (id === 'echo.boom') throw new Error('broker down'); return reads.get(id) ?? { ok: false, error: 'not_found' }; },
      async invoke() { throw new Error('never'); },
    };
    const lookup = brokerCapabilityLookup(sdk);
    expect(await lookup.resolve('echo.knowledge.search')).toEqual({ id: 'echo.knowledge.search', tier: 0, scope: 'knowledge.read', description: 'd' });
    expect(await lookup.resolve('echo.shell.run')).toMatchObject({ id: 'echo.shell.run', tier: 2 });
    expect(await lookup.resolve('echo.no.tier')).toMatchObject({ id: 'echo.no.tier', tier: null });
    for (const id of ['echo.red.cap', 'echo.unreg.cap', 'echo.other.cap', 'echo.missing', 'echo.boom', 'Echo.Bad', 'shell.run']) expect(await lookup.resolve(id)).toBeUndefined();
    expect((await lookup.search('knowledge')).map(r => r.id)).toEqual(['echo.knowledge.search']);
    const s = await service(); const auto = new AutoAgents({ adk: s.adk, bots: s.bots, caps: lookup });
    await auto.makeAgent({ ...makeAgentArgs, name: 'no-tier-scout', capabilities: ['echo.no.tier'] }, owner('watch tiers'));
    expect((await auto.makeBot({ agent: 'no-tier-scout' }, owner('watch tiers'))).bot).toMatchObject({ status: 'paused', approval: { required: true, reasons: ['echo.no.tier has no reported tier (treated as not auto-approvable)'] } });
  });
});
