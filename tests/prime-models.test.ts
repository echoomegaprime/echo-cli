import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { SharedChat } from '../src/prime/chat.js';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import { DEFAULT_MODELS, ModelRouter } from '../src/code/model-factory.js';
import type { Runner, RunResult } from '../src/code/providers.js';

const final = (content: string) => JSON.stringify({ action: 'final', content });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const claudeJson = (text: string, model = 'claude-sonnet-5-5') => JSON.stringify({ is_error: false, result: text, modelUsage: { [model]: { outputTokens: 5 } } });
const codexEvents = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

const servers: Server[] = [];
const cleanups: string[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r()));
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});
async function ollama() {
  let chats = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: DEFAULT_MODELS.model }] })); return; }
      chats++;
      res.end(JSON.stringify({ done: true, model: DEFAULT_MODELS.model, message: { content: final('qwen answer') } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats: () => chats };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prime-models-')), state = mkdtempSync(join(tmpdir(), 'prime-models-state-'));
  cleanups.push(root, state);
  writeFileSync(join(root, 'info.txt'), 'calibration=714\n'); writeFileSync(join(root, 'index.html'), 'Prime');
  return { root, workspace: new Workspace(root, [state]), store: new SessionStore(state) };
}
async function setup(run: Runner) {
  const f = fixture(), fake = await ollama();
  const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: run });
  return { ...f, fake, router, chat: new SharedChat({ workspace: f.workspace, store: f.store, models: router }) };
}
const req = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), prompt: 'hello', ...extra });

describe('Prime chat with a selected provider', () => {
  it('uses Qwen on the loopback endpoint by default and says which model answered', async () => {
    const s = await setup(async () => ok());
    const result = await s.chat.submit(req());
    expect(result).toMatchObject({ status: 'completed', answer: 'qwen answer', model: { id: 'qwen', model: DEFAULT_MODELS.model, reported: true, answered: true } });
    expect(s.fake.chats()).toBe(1); expect(s.chat.status()).toMatchObject({ routing: true, defaultProvider: 'qwen' });
  });
  it('routes Claude through its CLI and reports the model it used; GPT reports no model', async () => {
    const calls: string[] = [];
    const s = await setup(async cmd => { calls.push(cmd); return cmd === 'claude' ? ok(claudeJson(final('claude answer'))) : ok(codexEvents(final('gpt answer'))); });
    const c = await s.chat.submit(req({ provider: 'claude' }));
    expect(c).toMatchObject({ status: 'completed', answer: 'claude answer', model: { id: 'claude', model: 'claude-sonnet-5-5', reported: true } });
    const g = await s.chat.submit(req({ provider: 'gpt' }));
    expect(g).toMatchObject({ status: 'completed', answer: 'gpt answer', model: { id: 'gpt', model: null, reported: false, answered: true } });
    expect(calls).toEqual(['claude', 'codex']); expect(s.fake.chats()).toBe(0);
  });
  it('an unavailable provider fails the turn with its own reason and nothing else answers', async () => {
    const s = await setup(async () => { throw Object.assign(new Error('ENOENT'), { spawnFailed: true }); });
    const r = await s.chat.submit(req({ provider: 'grok' }));
    expect(r.status).toBe('failed'); expect(r.answer).toMatch(/Grok .*unavailable.*no fallback was used/);
    expect(r.model).toMatchObject({ id: 'grok', model: null, answered: false });
    expect(s.fake.chats()).toBe(0);
  });
  it('keeps one session on one model and refuses a silent switch', async () => {
    const s = await setup(async () => ok(claudeJson(final('claude answer'))));
    const first = await s.chat.submit(req({ provider: 'claude' }));
    await expect(s.chat.submit(req({ provider: 'qwen', sessionId: first.sessionId }))).rejects.toThrow(/different model.*new conversation/i);
    expect((await s.chat.submit(req({ provider: 'claude', sessionId: first.sessionId }))).status).toBe('completed');
  });
  it('rejects provider ids outside the reviewed list and the browser cannot name a model', async () => {
    const s = await setup(async () => ok());
    await expect(s.chat.submit(req({ provider: 'gemini' }))).rejects.toThrow(/Invalid chat request/);
    await expect(s.chat.submit(req({ provider: 'claude', model: 'opus' }))).rejects.toThrow(/Invalid chat request/);
    await expect(s.chat.submit(req({ provider: '__proto__' }))).rejects.toThrow(/Invalid chat request/);
  });
  it('refuses a provider choice when no model router is configured', async () => {
    const f = fixture();
    const invoke = vi.fn();
    const chat = new SharedChat({ workspace: f.workspace, store: f.store, invoke, admission: { contractSha256: 'a'.repeat(64), admissionId: 'x' } });
    await expect(chat.submit(req({ provider: 'claude' }))).rejects.toThrow(/Model selection is not configured/);
    expect(invoke).not.toHaveBeenCalled(); expect(chat.status()).toMatchObject({ routing: false });
  });
  it('needs either a host invoker or a model router', () => {
    const f = fixture();
    expect(() => new SharedChat({ workspace: f.workspace, store: f.store })).toThrow(/model router or an authenticated host/i);
  });
});

describe('GET /api/prime/models', () => {
  async function get(hub: PrimeHub, headers?: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'prime-route-')); cleanups.push(dir); writeFileSync(join(dir, 'index.html'), 'Prime'); writeFileSync(join(dir, 'models.js'), '// picker');
    const server = await startPrimeServer(hub, dir, 0);
    try {
      const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
      const anon = await fetch(server.url + '/api/prime/models', { headers: { 'x-prime-request': '1' } });
      const authed = await fetch(server.url + '/api/prime/models', { headers: { cookie, 'x-prime-request': '1', ...headers } });
      const post = await fetch(server.url + '/api/prime/models', { method: 'POST', headers: { cookie, origin: server.url, 'content-type': 'application/json', 'x-prime-request': '1' }, body: '{}' });
      const asset = await fetch(server.url + '/models.js');
      return { anon: anon.status, authed, post: post.status, asset: asset.status };
    } finally { await server.close(); }
  }
  it('requires the Prime session and reports availability, reasons and the default', async () => {
    const fake = await ollama();
    const run: Runner = async cmd => { if (cmd === 'grok') throw Object.assign(new Error('x'), { spawnFailed: true }); return ok(); };
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: run });
    const f = fixture();
    const chat = new SharedChat({ workspace: f.workspace, store: f.store, models: router });
    const r = await get(new PrimeHub({ capabilities: [], models: router, chat }));
    expect(r.anon).toBe(403); expect(r.post).not.toBe(200);
    expect(r.authed.status).toBe(200);
    const body = await r.authed.json() as { configured: boolean; routing: boolean; default: string; providers: { id: string; available: boolean; reason?: string }[] };
    expect(body).toMatchObject({ configured: true, routing: true, default: 'qwen' });
    expect(body.providers.map(p => p.id)).toEqual(['qwen', 'claude', 'gpt', 'grok', 'argon']);
    expect(body.providers.find(p => p.id === 'qwen')!.available).toBe(true);
    expect(body.providers.find(p => p.id === 'grok')).toMatchObject({ available: false, reason: expect.stringContaining('could not start') });
  });
  it('says plainly when no router is configured', async () => {
    const r = await get(new PrimeHub({ capabilities: [] }));
    expect(await r.authed.json()).toMatchObject({ configured: false, routing: false, providers: [] });
  });
  it('serves the picker script as a named asset', async () => {
    const r = await get(new PrimeHub({ capabilities: [] }));
    expect(r.asset).toBe(200);
  });
});

// ---- UI: models.js picker and chat.js integration (fake DOM) ----
type El = ReturnType<typeof element>;
function element(tag = 'div') {
  const handlers: Record<string, ((e?: unknown) => void)[]> = {};
  const el = {
    tag, textContent: '', className: '', hidden: false, disabled: false, value: '', title: '', id: '', children: [] as El[], dataset: {} as Record<string, string>,
    append(...nodes: El[]) { this.children.push(...nodes); }, replaceChildren(...nodes: El[]) { this.children = nodes; },
    setAttribute: vi.fn(), scrollIntoView: vi.fn(), insertBefore(n: El) { this.children.unshift(n); },
    addEventListener(name: string, fn: (e?: unknown) => void) { (handlers[name] ??= []).push(fn); },
    fire(name: string) { (handlers[name] ?? []).forEach(fn => fn({ target: el })); },
  };
  return el;
}
const modelsSource = readFileSync(new URL('../ui/echo-prime/models.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../ui/echo-prime/chat.js', import.meta.url), 'utf8');
const report = (over: Record<string, unknown> = {}) => ({
  configured: true, routing: true, default: 'qwen', contextTokens: 262144, providers: [
    { id: 'qwen', label: 'Qwen (FORGE, 256K)', kind: 'local', available: true, requested: DEFAULT_MODELS.model, last: null },
    { id: 'claude', label: 'Claude (claude CLI)', kind: 'cli', available: true, requested: null, last: null },
    { id: 'gpt', label: 'GPT (codex CLI)', kind: 'cli', available: false, reason: 'not signed in', requested: null, last: null },
    { id: 'grok', label: 'Grok (grok CLI)', kind: 'cli', available: true, requested: null, last: null },
  ], ...over,
});
async function pickerFixture(opts: { stored?: string; throwStorage?: boolean; body?: unknown; status?: number } = {}) {
  const toolbar = element(), composer = element();
  const store: Record<string, string> = opts.stored ? { 'echo-prime-model-v1': opts.stored } : {};
  const localStorage = opts.throwStorage
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const fetch = vi.fn(async () => ({ ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => opts.body ?? report() }));
  const window = { addEventListener: vi.fn() } as Record<string, unknown>;
  runInNewContext(modelsSource, { window, localStorage, fetch, Error, console, Promise, Array, JSON,
    document: { querySelector: (s: string) => s === '.composer-toolbar' ? toolbar : s === '#composer' ? composer : null, createElement: (t: string) => element(t) } });
  const api = window.EchoPrimeModels as { ready: Promise<void>; provider: () => string | undefined; describe: (m: unknown) => string };
  await api.ready;
  return { api, toolbar, store, fetch };
}
const flat = (e: El): El[] => [e, ...e.children.flatMap(flat)];

describe('model picker (models.js)', () => {
  it('shows Qwen as the default with Claude, GPT and Grok selectable, and saves the choice', async () => {
    const { api, toolbar, store } = await pickerFixture();
    const select = flat(toolbar).find(e => e.tag === 'select')!;
    const options = select.children.map(o => o.textContent);
    expect(options[0]).toContain('Qwen (FORGE, 256K)'); expect(options.join('|')).toMatch(/Claude.*\|.*GPT.*\|.*Grok/);
    expect(select.value).toBe('qwen'); expect(api.provider()).toBe('qwen');
    select.value = 'claude'; select.fire('change');
    expect(api.provider()).toBe('claude'); expect(store['echo-prime-model-v1']).toBe('claude');
  });
  it('restores a stored choice, ignores junk, and survives blocked storage', async () => {
    expect((await pickerFixture({ stored: 'grok' })).api.provider()).toBe('grok');
    expect((await pickerFixture({ stored: 'gemini' })).api.provider()).toBe('qwen');
    const blocked = await pickerFixture({ throwStorage: true });
    const select = flat(blocked.toolbar).find(e => e.tag === 'select')!;
    select.value = 'gpt'; select.fire('change'); expect(blocked.api.provider()).toBe('gpt');
  });
  it('states explicitly that a provider is unavailable and that no other model will be used', async () => {
    const { toolbar } = await pickerFixture({ stored: 'gpt' });
    const text = flat(toolbar).map(e => e.textContent).join(' ');
    expect(text).toMatch(/GPT.*unavailable.*not signed in.*No other model will be used/i);
  });
  it('does not send a provider when the host has no router', async () => {
    const { api } = await pickerFixture({ body: report({ routing: false }) });
    expect(api.provider()).toBeUndefined();
  });
  it('does not invent a provider when the status route fails', async () => {
    const { api, toolbar } = await pickerFixture({ status: 403, body: { error: 'x' } });
    expect(api.provider()).toBeUndefined();
    expect(flat(toolbar).map(e => e.textContent).join(' ')).toMatch(/status unavailable/i);
  });
  it('describes the model that answered, or says the CLI did not report one', async () => {
    const { api } = await pickerFixture();
    expect(api.describe({ id: 'claude', label: 'Claude (claude CLI)', answered: true, reported: true, model: 'claude-sonnet-5-5', requested: null })).toBe('answered by claude-sonnet-5-5');
    expect(api.describe({ id: 'gpt', label: 'GPT (codex CLI)', answered: true, reported: false, model: null, requested: null })).toBe('model not reported by GPT (codex CLI) (requested: CLI default)');
    expect(api.describe({ id: 'claude', label: 'Claude (claude CLI)', answered: true, reported: false, model: null, requested: 'sonnet' })).toContain('(requested: sonnet)');
    expect(api.describe({ id: 'grok', label: 'Grok (grok CLI)', answered: false, reported: false, model: null, requested: null })).toMatch(/no model answered.*Grok/i);
    expect(api.describe(undefined)).toBe('');
  });
});

function chatFixture(models?: unknown) {
  const nodes = new Map(['#composer .send', '#stop-chat', '#chat-log', '#welcome'].map(k => [k, element()]));
  const sessionId = randomUUID();
  const fetch = vi.fn(async (path: string) => ({ ok: true, json: async () => path.endsWith('status') ? { chat: { state: 'attached' } }
    : { status: 'completed', sessionId, answer: 'hi', answerVerification: 'unverified_model_text', evidence: [], model: { id: 'gpt', label: 'GPT (codex CLI)', answered: true, reported: false, model: null, requested: null } } }));
  const window = { addEventListener: vi.fn(), ...(models ? { EchoPrimeModels: models } : {}) } as Record<string, unknown>;
  runInNewContext(chatSource, { window, document: { querySelector: (s: string) => nodes.get(s), createElement: () => element() }, fetch, crypto: { randomUUID }, AbortController, setTimeout, clearTimeout, Error });
  return { nodes, fetch, chat: window.EchoPrimeChat as { send: (t: string) => Promise<unknown> } };
}
describe('chat.js integration', () => {
  it('sends the selected provider only when the picker supplies one and prints the per-reply model note', async () => {
    const f = chatFixture({ provider: () => 'gpt', describe: (m: { id: string }) => 'note for ' + m.id });
    await f.chat.send('inspect');
    const body = JSON.parse((f.fetch.mock.calls[1] as unknown as [string, { body: string }])[1].body);
    expect(body.provider).toBe('gpt'); expect(body).not.toHaveProperty('model');
    const message = f.nodes.get('#chat-log')!.children[1];
    expect(message.children[2].textContent).toContain('note for gpt');
  });
  it('sends no provider key without the picker (legacy host path unchanged)', async () => {
    const f = chatFixture();
    await f.chat.send('inspect');
    const body = JSON.parse((f.fetch.mock.calls[1] as unknown as [string, { body: string }])[1].body);
    expect(body).not.toHaveProperty('provider');
  });
});
