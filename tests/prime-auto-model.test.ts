import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { AUTO_ID, DEFAULT_AUTO, DEFAULT_MODELS, ModelRouter, isChatProvider, parseModelsConfig, routingChains } from '../src/code/model-factory.js';
import { TASK_CLASSES, classifyTask } from '../src/code/task-classifier.js';
import { SharedChat } from '../src/prime/chat.js';
import { PrimeHub } from '../src/prime/hub.js';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import type { Runner, RunResult } from '../src/code/providers.js';

// Routing-table draft (keywords, regexes, 40 labelled examples) by Grok (`wrap.sh draft grok`, 3rd attempt, 2026-11-04); rules reviewed and merged by hand.
const table = JSON.parse(readFileSync(new URL('./fixtures/routing-table.json', import.meta.url), 'utf8')) as { examples: { text: string; expected: string }[] };
const final = (content: string) => JSON.stringify({ action: 'final', content });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const claudeJson = (text: string) => JSON.stringify({ is_error: false, result: text, modelUsage: { 'claude-sonnet-5-5': { outputTokens: 5 } } });
const codexEvents = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
const grokJson = (text: string) => JSON.stringify({ text, modelUsage: { 'grok-4.7': { outputTokens: 5 } } });
const spawnFailed = () => Object.assign(new Error('ENOENT'), { spawnFailed: true });

describe('models.auto configuration', () => {
  it('is opt-in with reviewed defaults, leaves DEFAULT_MODELS untouched, and refuses unknown values', () => {
    expect(parseModelsConfig(undefined)).toEqual(DEFAULT_MODELS); expect(DEFAULT_MODELS).not.toHaveProperty('auto');
    expect(parseModelsConfig({ auto: {} }).auto).toEqual({ enabled: true, classifier: 'rules+qwen', research: 'grok', declineTo: 'qwen' });
    expect(parseModelsConfig({ auto: { enabled: false, classifier: 'rules', research: 'gpt', declineTo: 'none' } }).auto).toEqual({ enabled: false, classifier: 'rules', research: 'gpt', declineTo: 'none' });
    for (const bad of [{ auto: { enabled: 'yes' } }, { auto: { classifier: 'llm' } }, { auto: { research: 'claude' } }, { auto: { declineTo: 'claude' } }, { auto: { token: 'x' } }, { auto: [] }, { default: 'auto' }]) expect(() => parseModelsConfig(bad)).toThrow(/Invalid models configuration/);
    expect(DEFAULT_AUTO).toEqual({ enabled: true, classifier: 'rules+qwen', research: 'grok', declineTo: 'qwen' });
  });
  it('the router exposes effective auto settings: off by default, declines still re-routed', () => {
    expect(new ModelRouter(DEFAULT_MODELS).auto).toEqual({ enabled: false, classifier: 'rules+qwen', research: 'grok', declineTo: 'qwen' });
    expect(new ModelRouter(parseModelsConfig({ auto: {} })).auto.enabled).toBe(true);
    expect(isChatProvider(AUTO_ID)).toBe(true); expect(isChatProvider('qwen')).toBe(true); expect(isChatProvider('gemini')).toBe(false); expect(isChatProvider('__proto__')).toBe(false);
  });
  it('routing chains: coding Claude, long context Argon, research Grok (or GPT), general Qwen only', () => {
    expect(routingChains(DEFAULT_AUTO)).toEqual({ coding: ['claude', 'gpt', 'qwen'], long_context: ['argon', 'claude', 'qwen'], research: ['grok', 'gpt', 'qwen'], general: ['qwen'] });
    expect(routingChains({ ...DEFAULT_AUTO, research: 'gpt' }).research).toEqual(['gpt', 'grok', 'qwen']);
  });
});

describe('task classifier (rules)', () => {
  it('agrees with the drafted examples at >= 95% and exposes scores and reasons', () => {
    let okCount = 0; const misses: string[] = [];
    for (const e of table.examples) { const c = classifyTask(e.text); if (c.task === e.expected) okCount++; else misses.push(`${e.expected} != ${c.task}: ${e.text}`); }
    expect(table.examples).toHaveLength(40);
    expect({ accuracy: okCount / table.examples.length >= 0.95, misses: misses.slice(0, 3) }).toEqual({ accuracy: true, misses: misses.slice(0, 3) });
    const c = classifyTask('Refactor this function:\n```ts\nconst x = 1;\n```');
    expect(c).toMatchObject({ task: 'coding' }); expect(c.confidence).toBeGreaterThanOrEqual(0.6); expect(c.reasons.join(' ')).toMatch(/code fence/);
    expect(Object.keys(c.scores).sort()).toEqual([...TASK_CLASSES].sort());
  });
  it.each([
    ['Fix the failing unit test in src/code/agent.ts', 'coding'],
    ['Summarise the attached 40-page PDF contract and list the risks', 'long_context'],
    ['What is the latest TypeScript release this week?', 'research'],
    ['How is FORGE doing today?', 'general'],
    ["My mom's birthday is next week, remind me", 'general'],
    ['What did the ESH ledger record for the gate restart?', 'general'],
    ['hello there', 'general'],
  ])('%s -> %s', (text, task) => { expect(classifyTask(text).task).toBe(task); });
  it('is unsure about a bare greeting and confident about a stack trace', () => {
    expect(classifyTask('hello there').confidence).toBeLessThan(0.6);
    expect(classifyTask('TypeError: Cannot read properties of undefined (reading "foo")\n    at main (app.js:10:5)').confidence).toBeGreaterThanOrEqual(0.6);
    expect(classifyTask(undefined as never).task).toBe('general');
  });
});

// ---- ModelRouter.route with stand-in probes and a stand-in Ollama (turns + the one-shot classifier) ----
const servers: Server[] = [], cleanups: string[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r()));
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});
async function ollama(options: { installed?: boolean; classify?: string | null; reply?: string } = {}) {
  const chats: Record<string, unknown>[] = [], classifications: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: options.installed === false ? [] : [{ name: DEFAULT_MODELS.model }] })); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { format?: { properties?: Record<string, unknown> } };
      if (body.format?.properties?.label) { classifications.push(body); res.end(JSON.stringify({ done: true, model: DEFAULT_MODELS.model, message: { content: options.classify === null ? 'not json' : JSON.stringify({ label: options.classify ?? 'research' }) } })); return; }
      chats.push(body); res.end(JSON.stringify({ done: true, model: DEFAULT_MODELS.model, message: { content: final(options.reply ?? 'qwen answer') } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats, classifications };
}
function runner(handler: (cmd: string, args: string[]) => RunResult | Error) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = async (cmd, args) => { calls.push({ cmd, args }); const r = handler(cmd, args); if (r instanceof Error) throw r; return r; };
  return { calls, run, turns: () => calls.filter(c => !['--version', 'login', 'models'].includes(c.args[0])).map(c => c.cmd) };
}
const allUp = runner(cmd => cmd === 'claude' ? ok(claudeJson(final('claude answer'))) : cmd === 'codex' ? ok(codexEvents(final('gpt answer'))) : cmd === 'grok' ? ok(grokJson(final('grok answer'))) : ok(JSON.stringify({ status: 'SUCCESS', response: final('argon answer') })));
const router = (url: string, run: Runner, auto: Record<string, unknown> = {}) => new ModelRouter(parseModelsConfig({ endpoint: url, auto }), { runner: run });

describe('ModelRouter.route', () => {
  it('routes a coding turn to Claude when available and records the considered chain', async () => {
    const fake = await ollama(); const r = router(fake.url, allUp.run);
    const route = await r.route('Refactor the loop in src/code/agent.ts and fix the failing unit test');
    expect(route.id).toBe('claude');
    expect(route.info).toMatchObject({ task: 'coding', classifier: 'rules', considered: [{ id: 'claude', available: true }] });
    expect(route.info.reason).toMatch(/^coding \(rules:/); expect(fake.classifications).toHaveLength(0);
  });
  it('skips an unavailable provider for the next preferred one, before any call', async () => {
    const fake = await ollama();
    const r = router(fake.url, runner(cmd => cmd === 'claude' ? spawnFailed() : cmd === 'codex' ? ok() : ok()).run);
    const route = await r.route('Debug this stack trace: TypeError: x is not a function at main (app.js:1:1)');
    expect(route.id).toBe('gpt');
    expect(route.info.considered).toEqual([{ id: 'claude', available: false, reason: expect.stringContaining('could not start "claude"') }, { id: 'gpt', available: true }]);
  });
  it('general and personal turns stay on Qwen only: when Qwen is down the turn fails and no vendor is considered', async () => {
    const fake = await ollama({ installed: false }); const r = router(fake.url, allUp.run);
    await expect(r.route("My mom's birthday is next week, remind me")).rejects.toThrow(/no available provider for a general turn: qwen \(.*not installed.*\); no other provider was used/);
    const up = await ollama(); expect((await router(up.url, allUp.run).route('How is FORGE doing today?')).id).toBe('qwen');
  });
  it('research goes to Grok by default and to GPT when configured', async () => {
    const fake = await ollama();
    expect((await router(fake.url, allUp.run).route('What is the latest TypeScript release this week?')).id).toBe('grok');
    expect((await router(fake.url, allUp.run, { research: 'gpt' }).route('What is the latest TypeScript release this week?')).id).toBe('gpt');
  });
  it('long context goes to Argon unless the conversation would exceed agy\'s command-line cap', async () => {
    const fake = await ollama(); const r = router(fake.url, allUp.run);
    const prompt = 'Summarise the attached 40-page PDF contract and list the differing clauses';
    expect((await r.route(prompt)).id).toBe('argon');
    const big = await r.route(prompt, { historyChars: 30000 });
    expect(big.id).toBe('claude');
    expect(big.info.considered[0]).toEqual({ id: 'argon', available: false, reason: expect.stringContaining("exceeds agy's command-line prompt cap") });
  });
  it('asks Qwen once when the rules are unsure (rules+qwen), honours its label, and falls back to the rules when it fails', async () => {
    const fake = await ollama({ classify: 'research' }); const r = router(fake.url, allUp.run);
    const route = await r.route('hello there');
    expect(route.id).toBe('grok'); expect(route.info).toMatchObject({ task: 'research', classifier: 'qwen', confidence: 0.75 });
    expect(fake.classifications).toHaveLength(1);
    const sent = fake.classifications[0] as { format: { properties: { label: { enum: string[] } } }; options: { num_predict: number }; messages: { content: string }[] };
    expect(sent.format.properties.label.enum).toEqual([...TASK_CLASSES]); expect(sent.options.num_predict).toBeLessThanOrEqual(24); expect(sent.messages.at(-1)!.content).toBe('hello there');
    expect(fake.chats).toHaveLength(0);
    const broken = await ollama({ classify: null });
    expect((await router(broken.url, allUp.run).route('hello there')).info).toMatchObject({ task: 'general', classifier: 'rules' });
    const rulesOnly = await ollama({ classify: 'coding' });
    expect((await router(rulesOnly.url, allUp.run, { classifier: 'rules' }).route('hello there')).info.classifier).toBe('rules'); expect(rulesOnly.classifications).toHaveLength(0);
    const confident = await ollama({ classify: 'general' });
    await router(confident.url, allUp.run).route('Refactor this function:\n```ts\nconst x = 1;\n```'); expect(confident.classifications).toHaveLength(0);
  });
  it('refuses to route when auto mode is off, and the report carries the auto section with chains', async () => {
    const fake = await ollama();
    await expect(new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: allUp.run }).route('x')).rejects.toThrow(/Auto model mode is not enabled/);
    const report = await router(fake.url, allUp.run).report();
    expect(report.auto).toEqual({ ...DEFAULT_AUTO, chains: routingChains(DEFAULT_AUTO) });
    expect(report.providers.map(p => p.id)).toEqual(['qwen', 'claude', 'gpt', 'grok', 'argon']);
  });
});

// ---- SharedChat in auto mode ----
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prime-auto-')), state = mkdtempSync(join(tmpdir(), 'prime-auto-state-')); cleanups.push(root, state);
  writeFileSync(join(root, 'info.txt'), 'calibration=714\n'); writeFileSync(join(root, 'index.html'), 'Prime');
  return { root, workspace: new Workspace(root, [state]), store: new SessionStore(state) };
}
const req = (prompt: string, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), prompt, ...extra });
describe('Prime chat: Auto (Echo decides)', () => {
  it('routes each turn of one auto conversation to a different provider, labels it, and pins the session to "auto"', async () => {
    const f = fixture(), fake = await ollama({ classify: 'general' }), r = runner(allUp.run as never);
    const chat = new SharedChat({ workspace: f.workspace, store: f.store, models: router(fake.url, allUp.run) });
    expect(chat.status()).toMatchObject({ routing: true, auto: true, defaultProvider: 'auto', declineTo: 'qwen' });
    const code = await chat.submit(req('Refactor the loop in src/code/agent.ts and fix the failing unit test', { provider: 'auto' }));
    expect(code).toMatchObject({ status: 'completed', answer: 'claude answer', model: { id: 'claude', model: 'claude-sonnet-5-5', routed: { task: 'coding', classifier: 'rules' } } });
    expect(f.store.get(code.sessionId).model).toBe('auto');
    const chatty = await chat.submit(req('How is FORGE doing today?', { provider: 'auto', sessionId: code.sessionId }));
    expect(chatty).toMatchObject({ status: 'completed', answer: 'qwen answer', sessionId: code.sessionId, model: { id: 'qwen', routed: { task: 'general' } } });
    expect(fake.chats).toHaveLength(1); expect(r.calls).toHaveLength(0);
    await expect(chat.submit(req('x', { provider: 'claude', sessionId: code.sessionId }))).rejects.toThrow(/different model/);
    const implicit = await chat.submit(req('What is the latest TypeScript release this week?'));
    expect(implicit.model).toMatchObject({ id: 'grok', routed: { task: 'research' } }); expect(f.store.get(implicit.sessionId).model).toBe('auto');
  });
  it('refuses "auto" when the section is absent, and an Argon variant with auto', async () => {
    const f = fixture(), fake = await ollama();
    const off = new SharedChat({ workspace: f.workspace, store: f.store, models: new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: allUp.run }) });
    await expect(off.submit(req('hi', { provider: 'auto' }))).rejects.toThrow(/Auto model mode is not enabled/);
    expect(off.status()).toMatchObject({ auto: false, defaultProvider: 'qwen' });
    const on = new SharedChat({ workspace: f.workspace, store: f.store, models: router(fake.url, allUp.run) });
    await expect(on.submit(req('hi', { provider: 'auto', model: 'gemini-4-argon-high' }))).rejects.toThrow(/Invalid chat request/);
    expect(fake.chats).toHaveLength(0);
  });
  it('a provider chosen by auto that then fails still fails the turn (no second provider for an outage)', async () => {
    const f = fixture(), fake = await ollama();
    const flaky = runner(cmd => cmd === 'claude' ? ok('not json at all') : ok());
    const chat = new SharedChat({ workspace: f.workspace, store: f.store, models: router(fake.url, flaky.run) });
    const r = await chat.submit(req('Refactor the loop in src/code/agent.ts and fix the failing unit test', { provider: 'auto' }));
    expect(r.status).toBe('failed'); expect(r.answer).toMatch(/Claude .*unavailable.*no fallback was used/);
    expect(r.model).toMatchObject({ id: 'claude', answered: false, routed: { task: 'coding' } }); expect(fake.chats).toHaveLength(0);
  });
  it('a decline inside auto mode is re-run on Qwen and carries both labels', async () => {
    const f = fixture(), fake = await ollama();
    const declining = runner(cmd => cmd === 'claude' ? ok(claudeJson("I'm sorry, but I can't help with that request. It goes against my guidelines.")) : ok());
    const chat = new SharedChat({ workspace: f.workspace, store: f.store, models: router(fake.url, declining.run) });
    const r = await chat.submit(req('Refactor the loop in src/code/agent.ts and fix the failing unit test', { provider: 'auto' }));
    expect(r).toMatchObject({ status: 'completed', answer: 'qwen answer', model: { id: 'qwen', declinedBy: 'claude', routed: { task: 'coding' } } });
    expect(fake.chats).toHaveLength(1);
  });
  it('GET /api/prime/models reports the auto section so the picker can offer and default to Auto', async () => {
    const f = fixture(), fake = await ollama();
    const hub = new PrimeHub({ capabilities: [], models: router(fake.url, allUp.run), chat: new SharedChat({ workspace: f.workspace, store: f.store, models: router(fake.url, allUp.run) }) });
    const body = await hub.models() as { auto: { enabled: boolean; chains: Record<string, string[]> }; routing: boolean };
    expect(body.routing).toBe(true); expect(body.auto).toMatchObject({ enabled: true, declineTo: 'qwen', chains: { coding: ['claude', 'gpt', 'qwen'] } });
  });
});

// ---- models.js picker with the Auto entry (fake DOM, same harness as prime-models.test.ts) ----
type El = ReturnType<typeof element>;
function element(tag = 'div') {
  const handlers: Record<string, ((e?: unknown) => void)[]> = {};
  const el = {
    tag, textContent: '', className: '', hidden: false, disabled: false, value: '', id: '', children: [] as El[],
    append(...nodes: El[]) { this.children.push(...nodes); }, replaceChildren(...nodes: El[]) { this.children = nodes; },
    setAttribute: vi.fn(), scrollIntoView: vi.fn(), addEventListener(name: string, fn: (e?: unknown) => void) { (handlers[name] ??= []).push(fn); },
    fire(name: string) { (handlers[name] ?? []).forEach(fn => fn({ target: el })); },
  };
  return el;
}
const flat = (e: El): El[] => [e, ...e.children.flatMap(flat)];
const modelsSource = readFileSync(new URL('../ui/echo-prime/models.js', import.meta.url), 'utf8');
const report = (over: Record<string, unknown> = {}) => ({
  configured: true, routing: true, default: 'qwen', contextTokens: 262144, providers: [
    { id: 'qwen', label: 'Qwen (FORGE, 256K)', kind: 'local', available: true, requested: DEFAULT_MODELS.model, last: null },
    { id: 'claude', label: 'Claude (claude CLI)', kind: 'cli', available: true, requested: null, last: null },
    { id: 'gpt', label: 'GPT (codex CLI)', kind: 'cli', available: false, reason: 'not signed in', requested: null, last: null },
    { id: 'grok', label: 'Grok (grok CLI)', kind: 'cli', available: true, requested: null, last: null },
    { id: 'argon', label: 'Argon (agy CLI)', kind: 'cli', available: true, requested: null, last: null, variants: [] },
  ], ...over,
});
const withAuto = (over: Record<string, unknown> = {}) => report({ auto: { ...DEFAULT_AUTO, chains: routingChains(DEFAULT_AUTO) }, ...over });
async function picker(opts: { stored?: string; body?: unknown } = {}) {
  const toolbar = element();
  const store: Record<string, string> = opts.stored ? { 'echo-prime-model-v1': opts.stored } : {};
  const window = { addEventListener: vi.fn() } as Record<string, unknown>;
  runInNewContext(modelsSource, { window, localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } }, fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => opts.body ?? withAuto() })), Error, console, Promise, Array, JSON, Date,
    document: { querySelector: (s: string) => s === '.composer-toolbar' ? toolbar : null, createElement: (t: string) => element(t) } });
  const api = window.EchoPrimeModels as { ready: Promise<void>; provider: () => string | undefined; describe: (m: unknown) => string };
  await api.ready;
  return { api, toolbar, store, select: flat(toolbar).find(e => e.tag === 'select')!, note: () => flat(toolbar).map(e => e.textContent).join(' ') };
}
describe('model picker: Auto (Echo decides)', () => {
  it('offers Auto first and defaults to it when the server reports auto enabled; explains the routing table', async () => {
    const p = await picker();
    expect(p.select.children[0].textContent).toBe('Auto (Echo decides)'); expect(p.select.value).toBe('auto'); expect(p.api.provider()).toBe('auto');
    expect(p.note()).toMatch(/Auto \(Echo decides\) selected.*Coding → Claude, documents\/images → Argon, web research → Grok, everything else → Qwen.*declines is re-run on Qwen/);
    p.select.value = 'claude'; p.select.fire('change'); expect(p.api.provider()).toBe('claude'); expect(p.store['echo-prime-model-v1']).toBe('claude');
    expect((await picker({ stored: 'auto' })).api.provider()).toBe('auto');
  });
  it('hides Auto and ignores a stored "auto" when the server does not enable it', async () => {
    const p = await picker({ body: report(), stored: 'auto' });
    expect(p.select.children.map(o => o.textContent)[0]).toContain('Qwen'); expect(p.select.children.some(o => o.value === 'auto')).toBe(false);
    expect(p.api.provider()).toBe('qwen');
  });
  it('describes routed and re-routed replies', async () => {
    const { api } = await picker();
    expect(api.describe({ id: 'claude', label: 'Claude (claude CLI)', answered: true, reported: true, model: 'claude-sonnet-5-5', requested: null, routed: { task: 'coding', reason: 'coding (rules: code fence)' } })).toBe('routed to Claude (coding) · answered by claude-sonnet-5-5');
    expect(api.describe({ id: 'qwen', label: 'Qwen (FORGE, 256K)', answered: true, reported: true, model: DEFAULT_MODELS.model, requested: DEFAULT_MODELS.model, declinedBy: 'claude', declinedLabel: 'Claude (claude CLI)' })).toBe('Claude declined; answered by Qwen (FORGE, 256K) · ' + DEFAULT_MODELS.model);
    expect(api.describe({ id: 'qwen', label: 'Qwen (FORGE, 256K)', answered: true, reported: true, model: DEFAULT_MODELS.model, requested: DEFAULT_MODELS.model, declinedBy: 'claude', declinedLabel: 'Claude (claude CLI)', routed: { task: 'long_context' } })).toBe('routed to Claude (long context) · Claude declined; answered by Qwen (FORGE, 256K) · ' + DEFAULT_MODELS.model);
    expect(api.describe({ id: 'qwen', label: 'Qwen (FORGE, 256K)', answered: true, reported: false, model: null, requested: 'x', routed: { task: 'general' } })).toBe('routed to Qwen (general) · model not reported by Qwen (FORGE, 256K) (requested: x)');
  });
});
