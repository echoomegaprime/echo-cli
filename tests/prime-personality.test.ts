import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { PERSONALITY_IDS, PersonalityForge, builtinCatalog, parseCatalog, personaFor, scorePersonalities } from '../src/prime/personality.js';
import { SharedChat } from '../src/prime/chat.js';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import { DEFAULT_MODELS, ModelRouter } from '../src/code/model-factory.js';
import type { RunResult } from '../src/code/providers.js';

// Scoring cues and the 36 examples were drafted by Gemini (agy, `wrap.sh draft gemini`, 2026-11-04) and reviewed by hand.
const cues = JSON.parse(readFileSync(new URL('./fixtures/personality-cues.json', import.meta.url), 'utf8')) as { examples: { text: string; expected: string }[] };
const workspaceCatalog = [{ id: 'auto', name: 'Auto · by task', registered: true }, { id: 'echo', name: 'Echo Prime', registered: true }, { id: 'gs343', name: 'GS343', registered: true }, { id: 'prometheus', name: 'Prometheus', registered: true }, { id: 'bree', name: 'Bree', registered: true }, { id: 'c3po', name: 'C-3PO', registered: true }, { id: 'r2d2', name: 'R2-D2', registered: false }];

describe('personality scorer (deterministic)', () => {
  it('agrees with the drafted examples at >= 95% and is stable across calls', () => {
    let ok = 0; const misses: string[] = [];
    for (const e of cues.examples) { const first = scorePersonalities(e.text).ranked[0].id; if (first === e.expected) ok++; else misses.push(`${e.expected} != ${first}: ${e.text}`); }
    expect(cues.examples).toHaveLength(36);
    expect({ accuracy: ok / cues.examples.length >= 0.95, misses: misses.slice(0, 3) }).toEqual({ accuracy: true, misses: misses.slice(0, 3) });
    const a = scorePersonalities('FORGE\'s gate is down, what do I check first'), b = scorePersonalities('FORGE\'s gate is down, what do I check first');
    expect(a).toEqual(b); expect(a.ranked[0].id).toBe('r2d2'); expect(a.intent).toBe('crisis');
  });
  it('ranks every profile with a numeric score and names the cues it matched', () => {
    const { ranked, intent, tone } = scorePersonalities('Roast my commit message lol');
    expect(ranked.map(r => r.id).sort()).toEqual([...PERSONALITY_IDS].sort());
    expect(ranked[0]).toMatchObject({ id: 'bree' }); expect(ranked[0].cues).toContain('roast');
    expect(intent).toBe('creative'); expect(tone).toBe('playful');
  });
  it('falls back to Echo Prime when nothing scores, and the last three user turns carry topic forward', () => {
    expect(scorePersonalities('and now?').ranked[0].id).toBe('echo');
    const history = [{ role: 'user', content: 'tell me a joke about my GPU' }, { role: 'assistant', content: '{"action":"final","content":"..."}' }, { role: 'user', content: 'roast my commit message' }];
    expect(scorePersonalities('and now?', history).ranked[0].id).toBe('bree');
    const stale = [...Array(5)].map((_, i) => ({ role: 'user', content: i === 0 ? 'roast my commit message' : 'ok' }));
    expect(scorePersonalities('and now?', stale).ranked[0].id).toBe('echo'); // older than three turns no longer counts
  });
  it('tool results and assistant actions are not topic signals', () => {
    const history = [{ role: 'user', content: 'UNTRUSTED TOOL RESULT (read):\n{"content":"pentest exploit vulnerability cve-2025-1984"}' }, { role: 'assistant', content: '{"action":"final","content":"roast roast roast"}' }];
    expect(scorePersonalities('what next?', history).ranked[0].id).toBe('echo');
  });
  it('discounts profiles the Workspace lists as not registered', () => {
    const text = 'GPU 1 on the worker rig is thermal throttling, check node health';
    const plain = scorePersonalities(text).ranked.find(r => r.id === 'r2d2')!.score;
    const discounted = scorePersonalities(text, [], parseCatalog(workspaceCatalog)).ranked.find(r => r.id === 'r2d2')!.score;
    expect(discounted).toBeLessThan(plain); expect(discounted).toBeGreaterThan(0);
  });
});

describe('catalog parsing', () => {
  it('reads the Workspace /api/state list, drops the auto row and junk, keeps registered flags and names', () => {
    const entries = parseCatalog({ personalities: [...workspaceCatalog, { id: 'hal9000', name: 'HAL' }, { id: 'bree', name: 'dup' }, 'junk', { id: 'echo' }] });
    expect(entries.map(e => e.id)).toEqual(['echo', 'gs343', 'prometheus', 'bree', 'c3po', 'r2d2']);
    expect(entries.find(e => e.id === 'c3po')).toEqual({ id: 'c3po', name: 'C-3PO', registered: true });
    expect(entries.find(e => e.id === 'r2d2')).toEqual({ id: 'r2d2', name: 'R2-D2', registered: false });
    expect(parseCatalog([{ id: 'echo', name: 'Ech\u0007o\u001f' }])[0].name).toBe('Echo');
    expect(parseCatalog(null)).toEqual([]); expect(parseCatalog('x')).toEqual([]);
  });
  it('the built-in catalog never claims a profile is registered, and personaFor carries the overlay fragment', () => {
    expect(builtinCatalog().every(e => e.registered === false)).toBe(true);
    expect(personaFor('c3po')).toMatchObject({ id: 'c3po', name: 'C-3PO', fragment: expect.stringContaining('Translate technical problems') });
    expect(personaFor('echo', 'Echo Prime (WS)').name).toBe('Echo Prime (WS)');
  });
});

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
describe('PersonalityForge settings, catalog cache and selection', () => {
  it('starts on with nothing pinned, validates patches, and persists atomically to its file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-forge-')); dirs.push(dir);
    const file = join(dir, 'nested', 'personality-settings.json');
    const forge = new PersonalityForge({ file });
    expect(forge.settings()).toEqual({ enabled: true, pinned: null });
    expect(forge.update({ pinned: 'bree' })).toEqual({ enabled: true, pinned: 'bree' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ enabled: true, pinned: 'bree' });
    expect(existsSync(file + '.tmp')).toBe(false);
    for (const bad of [{ pinned: 'hal9000' }, { enabled: 'yes' }, { volume: 11 }, 'x', null, []]) expect(() => forge.update(bad)).toThrow(/Invalid personality settings/);
    expect(new PersonalityForge({ file }).settings()).toEqual({ enabled: true, pinned: 'bree' });
    writeFileSync(file, '{not json');
    expect(new PersonalityForge({ file }).settings()).toEqual({ enabled: true, pinned: null });
  });
  it('caches the Workspace catalog for 60 s, falls back to the built-in list when the loader fails, and says so', async () => {
    let now = 1_000_000, calls = 0;
    const forge = new PersonalityForge({ now: () => now });
    const loader = vi.fn(async () => { calls++; if (calls === 3) throw new Error('Workspace down'); return workspaceCatalog; });
    expect((await forge.catalog(loader)).source).toBe('workspace');
    expect((await forge.catalog(loader)).entries.find(e => e.id === 'c3po')!.name).toBe('C-3PO');
    expect(loader).toHaveBeenCalledTimes(1);
    now += 59_000; await forge.catalog(loader); expect(loader).toHaveBeenCalledTimes(1);
    now += 2_000; await forge.catalog(loader); expect(loader).toHaveBeenCalledTimes(2);
    now += 61_000; const failed = await forge.catalog(loader);
    expect(failed).toMatchObject({ source: 'builtin', reason: 'Workspace down' }); expect(failed.entries).toHaveLength(6);
    expect(await new PersonalityForge().catalog()).toMatchObject({ source: 'builtin', reason: expect.stringContaining('no Workspace catalog loader') });
  });
  it('selects per turn, honours the pin, returns null when switched off, and records the last pick', async () => {
    const forge = new PersonalityForge({ now: () => 5 });
    const pick = await forge.select({ prompt: 'Explain this stack trace to me like I\'m five', loader: async () => workspaceCatalog });
    expect(pick).toMatchObject({ id: 'c3po', name: 'C-3PO', pinned: false, intent: 'technical' });
    expect(pick!.reason).toMatch(/technical intent.*cues: 'stack trace'/);
    expect(pick!.fragment).toContain('Translate technical problems');
    expect(forge.last()).toMatchObject({ id: 'c3po', pinned: false, at: '1970-01-01T00:00:00.005Z' });
    forge.update({ pinned: 'gs343' });
    expect(await forge.select({ prompt: 'roast me' })).toMatchObject({ id: 'gs343', pinned: true, reason: 'pinned by the owner' });
    forge.update({ enabled: false });
    expect(await forge.select({ prompt: 'roast me' })).toBeNull();
  });
});

// ---- SharedChat: the persona reaches the system text once; the reply carries the tag ----
const servers: Server[] = [];
afterEach(async () => { while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r())); });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
async function ollama() {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: DEFAULT_MODELS.model }] })); return; }
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({ done: true, model: DEFAULT_MODELS.model, message: { content: JSON.stringify({ action: 'final', content: 'beep' }) } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prime-persona-')), state = mkdtempSync(join(tmpdir(), 'prime-persona-state-')); dirs.push(root, state);
  writeFileSync(join(root, 'info.txt'), 'x'); writeFileSync(join(root, 'index.html'), 'Prime');
  return { root, workspace: new Workspace(root, [state]), store: new SessionStore(state), state };
}
async function chatWith(forge: PersonalityForge) {
  const f = fixture(), fake = await ollama();
  const chat = new SharedChat({ workspace: f.workspace, store: f.store, models: new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: async () => ok() }), personality: forge });
  return { ...f, fake, chat };
}
describe('Prime chat with the Personality Forge', () => {
  it('injects the chosen persona once into the system text and tags the reply', async () => {
    const s = await chatWith(new PersonalityForge());
    const r = await s.chat.submit({ requestId: randomUUID(), prompt: 'FORGE\'s gate is down, what do I check first' }, undefined, { personalities: async () => workspaceCatalog });
    expect(r.status).toBe('completed');
    expect(r.personality).toMatchObject({ id: 'r2d2', name: 'R2-D2', pinned: false }); expect(r.personality!.reason).toMatch(/crisis intent/);
    const system = s.fake.bodies[0].messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(system.split('Active personality: R2-D2 (r2d2).')).toHaveLength(2);
    expect(system).toContain('Be resourceful and concise');
    expect(s.store.get(r.sessionId).messages.some(m => m.role === 'system')).toBe(false); // persona lives in the turn, not the saved history
    expect(s.chat.status()).toMatchObject({ personality: { enabled: true, pinned: null } });
  });
  it('a pinned profile answers every turn; switched off, no persona and no tag', async () => {
    const forge = new PersonalityForge(); forge.update({ pinned: 'bree' });
    const s = await chatWith(forge);
    const pinned = await s.chat.submit({ requestId: randomUUID(), prompt: 'is FORGE up?' });
    expect(pinned.personality).toMatchObject({ id: 'bree', pinned: true, reason: 'pinned by the owner' });
    expect(s.fake.bodies[0].messages[0].content).toContain('Active personality: Bree (bree)');
    forge.update({ enabled: false });
    const off = await s.chat.submit({ requestId: randomUUID(), prompt: 'is FORGE up?' });
    expect(off.personality).toBeUndefined(); expect(s.fake.bodies[1].messages[0].content).not.toContain('Active personality');
  });
  it('a failing catalog loader never fails the turn', async () => {
    const s = await chatWith(new PersonalityForge());
    const r = await s.chat.submit({ requestId: randomUUID(), prompt: 'roast my commit message' }, undefined, { personalities: async () => { throw new Error('Workspace down'); } });
    expect(r.status).toBe('completed'); expect(r.personality).toMatchObject({ id: 'bree' });
  });
});

describe('owner routes: /api/prime/personality', () => {
  async function serve(hub: PrimeHub, dir: string) {
    const server = await startPrimeServer(hub, dir, 0);
    const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, body?: unknown) => fetch(server.url + path, { method: body ? 'POST' : 'GET', headers: { cookie, origin: server.url, 'x-prime-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { server, call };
  }
  it('reads and updates the owner setting, previews a pick, and refuses junk and anonymous callers', async () => {
    const f = fixture(), fake = await ollama();
    const forge = new PersonalityForge({ file: join(f.state, 'personality-settings.json') });
    const chat = new SharedChat({ workspace: f.workspace, store: f.store, models: new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: async () => ok() }), personality: forge });
    const { server, call } = await serve(new PrimeHub({ capabilities: [], chat }), f.root);
    try {
      expect((await fetch(server.url + '/api/prime/personality', { headers: { 'x-prime-request': '1' } })).status).toBe(403);
      const got = await (await call('/api/prime/personality')).json();
      expect(got).toMatchObject({ configured: true, settings: { enabled: true, pinned: null }, catalog: { source: 'builtin' }, last: null });
      expect(got.catalog.entries.map((e: { id: string }) => e.id)).toEqual([...PERSONALITY_IDS]);
      expect(await (await call('/api/prime/personality', { pinned: 'bree' })).json()).toEqual({ enabled: true, pinned: 'bree' });
      expect(forge.settings().pinned).toBe('bree');
      expect((await call('/api/prime/personality', { pinned: 'hal9000' })).status).toBe(400);
      expect(await (await call('/api/prime/personality/select', { text: 'explain this stack trace' })).json()).toMatchObject({ enabled: true, selection: { id: 'bree', pinned: true } });
      await call('/api/prime/personality', { pinned: null });
      expect(await (await call('/api/prime/personality/select', { text: 'explain this stack trace', history: [{ role: 'user', content: 'x' }] })).json()).toMatchObject({ enabled: true, selection: { id: 'c3po', pinned: false, reason: expect.stringContaining('technical intent') } });
      expect((await call('/api/prime/personality/select', { text: '' })).status).toBe(400);
      await call('/api/prime/personality', { enabled: false });
      expect(await (await call('/api/prime/personality/select', { text: 'roast me' })).json()).toEqual({ enabled: false, selection: null });
    } finally { await server.close(); }
  });
  it('says plainly when no forge is attached', async () => {
    const f = fixture();
    const { server, call } = await serve(new PrimeHub({ capabilities: [] }), f.root);
    try {
      expect(await (await call('/api/prime/personality')).json()).toMatchObject({ configured: false, settings: null });
      expect((await call('/api/prime/personality', { pinned: 'bree' })).status).toBe(400);
    } finally { await server.close(); }
  });
});

// ---- brain.js in a fake DOM ----
type El = ReturnType<typeof element>;
function element(tag = 'div') {
  const handlers: Record<string, ((e?: unknown) => Promise<void> | void)[]> = {};
  const el = {
    tag, textContent: '', className: '', hidden: false, disabled: false, value: '', type: '', id: '', children: [] as El[], attributes: {} as Record<string, string>,
    append(...nodes: El[]) { this.children.push(...nodes); }, replaceChildren(...nodes: El[]) { this.children = nodes; },
    setAttribute(k: string, v: string) { this.attributes[k] = v; }, scrollIntoView() {},
    addEventListener(name: string, fn: (e?: unknown) => Promise<void> | void) { (handlers[name] ??= []).push(fn); },
    async fire(name: string) { for (const fn of handlers[name] ?? []) await fn({ target: el }); },
  };
  return el;
}
const flat = (e: El): El[] => [e, ...e.children.flatMap(flat)];
const text = (e: El): string => e.textContent + e.children.map(text).join('');
const brainSource = readFileSync(new URL('../ui/echo-prime/brain.js', import.meta.url), 'utf8');
interface Session { workspaceConfigured: boolean; authenticated: boolean; ownerAccess: boolean; csrf: string | null; user: { uid: string; role: string; status: string } | null }
const owner = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'csrf-owner', user: { uid: 'owner', role: 'owner', status: 'approved' } });
const member = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: false, csrf: 'csrf-member', user: { uid: 'm', role: 'member', status: 'approved' } });
function workspaceStub(session: Session | null, chat: unknown = null) {
  const bridgeApi = vi.fn(async () => ({}));
  return { ready: Promise.resolve(true), enabled: true, session, ownerHeaders: vi.fn(async () => ({ 'x-echo-csrf': session?.csrf ?? '' })), bridge: () => ({ state: { chat }, api: bridgeApi }), bridgeApi };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function brainFixture(opts: { workspace?: ReturnType<typeof workspaceStub>; status?: Record<string, unknown>; verify?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
  const toolbar = element();
  const calls: { path: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (path: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ path, body });
    if (path.endsWith('/api/prime/personality') && !body) return { ok: true, status: 200, json: async () => opts.status ?? { configured: true, settings: { enabled: true, pinned: null }, catalog: { entries: [{ id: 'echo', name: 'Echo Prime', registered: true }, { id: 'bree', name: 'Bree', registered: true }, { id: 'c3po', name: 'C-3PO', registered: false }], source: 'workspace' }, last: null } };
    if (path.endsWith('/api/prime/personality')) return { ok: true, status: 200, json: async () => ({ enabled: body.enabled ?? true, pinned: body.pinned ?? null }) };
    if (path.endsWith('/api/prime/personality/select')) return { ok: true, status: 200, json: async () => opts.select ?? { enabled: true, selection: { id: 'bree', name: 'Bree', reason: 'creative intent', pinned: false } } };
    if (path.endsWith('/api/chat/verify')) return { ok: true, status: 200, json: async () => opts.verify ?? { summary: { total: 2, verified: 1, unverified: 1 }, claims: [{ kind: 'id', value: 'esh_1', verified: true, source: 'tool result 1 (read)' }, { kind: 'url', value: 'https://nowhere.test', verified: false, source: null }], account: { text: '1. tool result 1\n2. no evidence', model: { id: 'qwen', label: 'Qwen', answered: true, reported: true, model: 'q' } } } };
    return { ok: false, status: 404, json: async () => ({ error: 'x' }) };
  });
  const handlers: Record<string, (() => void)[]> = {};
  const window = { addEventListener: vi.fn((name: string, fn: () => void) => { (handlers[name] ??= []).push(fn); }), EchoPrimeModels: { describe: () => 'answered by q' }, ...(opts.workspace ? { EchoPrimeWorkspace: opts.workspace } : {}) } as Record<string, unknown>;
  runInNewContext(brainSource, { window, fetch, console: { debug: vi.fn() }, crypto: { randomUUID }, Error, Promise, Array, JSON, Date, Number, Map, document: { querySelector: (s: string) => s === '.composer-toolbar' ? toolbar : null, createElement: (t: string) => element(t), createTextNode: (t: string) => Object.assign(element('#text'), { textContent: t }) } });
  const api = window.EchoPrimeBrain as { ready: Promise<void>; decorate: (a: El, r: unknown, c: El) => void; beforeWorkspaceTurn: (t: unknown) => Promise<unknown>; settings: () => unknown };
  await api.ready; await flush();
  return { api, toolbar, fetch, calls, fire: (n: string) => { for (const fn of handlers[n] ?? []) fn(); } };
}
describe('brain.js: personality controls', () => {
  it('owner: loads settings once, lists Auto plus the catalog, pins through the select and toggles off', async () => {
    const f = await brainFixture({ workspace: workspaceStub(owner()) });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const select = flat(f.toolbar).find(e => e.tag === 'select')!, toggle = flat(f.toolbar).find(e => e.tag === 'button')!;
    expect(select.children.map(o => o.textContent)).toEqual(['Personality: auto (by task)', 'Echo Prime', 'Bree', 'C-3PO · not registered']);
    expect(select.value).toBe('auto'); expect(toggle.textContent).toBe('Personality: on');
    expect(flat(f.toolbar).map(text).join(' ')).toContain('picks a personality per message');
    select.value = 'bree'; await select.fire('change'); await flush();
    expect(f.calls.at(-1)).toEqual({ path: '/api/prime/personality', body: { pinned: 'bree' } });
    expect(f.api.settings()).toEqual({ enabled: true, pinned: 'bree' });
    expect(flat(f.toolbar).map(text).join(' ')).toContain('Pinned to Bree');
    await toggle.fire('click'); await flush();
    expect(f.calls.at(-1)).toEqual({ path: '/api/prime/personality', body: { enabled: false } });
    expect(toggle.textContent).toBe('Personality: off'); expect(select.disabled).toBe(true);
  });
  it('member and signed-out visitor: no fetch, an honest note; a host without a forge hides the controls', async () => {
    const m = await brainFixture({ workspace: workspaceStub(member()) });
    expect(m.fetch).not.toHaveBeenCalled(); expect(flat(m.toolbar).map(text).join(' ')).toContain('set by the primary owner');
    const anon = await brainFixture({ workspace: workspaceStub({ workspaceConfigured: true, authenticated: false, ownerAccess: false, csrf: null, user: null }) });
    expect(anon.fetch).not.toHaveBeenCalled(); expect(flat(anon.toolbar).map(text).join(' ')).toContain('Sign in');
    const off = await brainFixture({ status: { configured: false, settings: null, catalog: { entries: [], source: 'none' }, last: null } });
    expect(flat(off.toolbar).find(e => e.tag === 'select')!.hidden).toBe(true);
  });
});
describe('brain.js: reply decoration', () => {
  const answer = 'Run esh_1 wrote to src/a.ts; see https://nowhere.test now.', url = 'https://nowhere.test';
  const reply = (over: Record<string, unknown> = {}) => ({ status: 'completed', sessionId: randomUUID(), answer, claims: { total: 3, verified: 2, unverified: [{ kind: 'url', value: url, start: answer.indexOf(url), end: answer.indexOf(url) + url.length }] }, personality: { id: 'c3po', name: 'C-3PO', reason: 'technical intent', pinned: false }, ...over });
  it('adds the "as <Name>" tag with a Pin control, marks unverified identifiers with text nodes only, and offers Verify', async () => {
    const f = await brainFixture({ workspace: workspaceStub(owner()) });
    const article = element('article'), content = element('p'); const r = reply(); content.textContent = r.answer;
    f.api.decorate(article, r, content);
    const tag = article.children.find(c => c.className === 'personality-tag')!;
    expect(text(tag)).toContain('as C-3PO · technical intent'); expect(tag.children[0].textContent).toBe('Pin C-3PO');
    expect(text(content)).toBe(r.answer);
    const marked = content.children.filter(c => c.className === 'unverified');
    expect(marked.map(c => c.textContent)).toEqual(['https://nowhere.test']); expect(marked[0].attributes.title).toBe('Echo could not verify this');
    expect(content.children.every(c => c.tag === '#text' || c.className === 'unverified')).toBe(true);
    expect(article.children.find(c => c.className === 'claims-note')!.textContent).toContain('1 identifier Echo could not verify');
    const verify = article.children.find(c => c.className.includes('verify-action'))!; expect(verify.textContent).toBe('Verify');
    await verify.fire('click'); await flush();
    expect(f.calls.at(-1)).toMatchObject({ path: '/api/chat/verify', body: { sessionId: r.sessionId } });
    const box = article.children.find(c => c.className === 'verify-result')!;
    expect(text(box)).toContain('2 claims · 1 found'); expect(text(box)).toContain('[url] https://nowhere.test'); expect(text(box)).toContain('no evidence');
    await tag.children[0].fire('click'); await flush();
    expect(f.calls.at(-1)).toEqual({ path: '/api/prime/personality', body: { pinned: 'c3po' } }); expect(tag.children[0].textContent).toBe('Pinned');
  });
  it('a pinned personality shows "(pinned)" without a Pin button; a reply without claims or personality adds only Verify; failed turns add nothing', async () => {
    const f = await brainFixture({ workspace: workspaceStub(owner()) });
    const a = element('article'), c = element('p'); f.api.decorate(a, reply({ personality: { id: 'bree', name: 'Bree', reason: 'pinned by the owner', pinned: true }, claims: undefined }), c);
    expect(text(a.children[0])).toContain('as Bree (pinned)'); expect(a.children[0].children).toHaveLength(0); expect(c.children).toHaveLength(0);
    const plain = element('article'); f.api.decorate(plain, { status: 'completed', sessionId: randomUUID(), answer: 'hi' }, element('p'));
    expect(plain.children.map(x => x.className)).toEqual(['quiet-button verify-action']);
    const failed = element('article'); f.api.decorate(failed, { status: 'failed', answer: 'nope' }, element('p')); expect(failed.children).toEqual([]);
    expect(() => f.api.decorate(element(), null as never, element())).not.toThrow();
  });
  it('ignores claim offsets that do not fit the answer', async () => {
    const f = await brainFixture({ workspace: workspaceStub(owner()) });
    const a = element('article'), c = element('p'); c.textContent = 'short';
    f.api.decorate(a, reply({ answer: 'short', claims: { total: 1, verified: 0, unverified: [{ kind: 'url', value: 'x', start: 2, end: 99 }] } }), c);
    expect(c.children).toHaveLength(0); expect(c.textContent).toBe('short');
  });
});
describe('brain.js: Workspace conversation path', () => {
  it('owner with auto on: scores on the server, then calls the Workspace personality_select once per change', async () => {
    const ws = workspaceStub(owner(), { id: 'chat-1', messages: [] });
    const f = await brainFixture({ workspace: ws });
    const wsApi = vi.fn(async () => ({}));
    const pick = await f.api.beforeWorkspaceTurn({ text: 'roast my commit', chatId: 'chat-1', api: wsApi, messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }] });
    expect(pick).toMatchObject({ id: 'bree' });
    expect(f.calls.at(-1)).toEqual({ path: '/api/prime/personality/select', body: { text: 'roast my commit', history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }] } });
    expect(wsApi).toHaveBeenCalledWith('/action', { action: 'personality_select', chat_id: 'chat-1', profile: 'bree' });
    await f.api.beforeWorkspaceTurn({ text: 'roast it again', chatId: 'chat-1', api: wsApi, messages: [] });
    expect(wsApi).toHaveBeenCalledTimes(1);
    // switching auto off hands the chat back to the Workspace's own auto mode once
    const toggle = flat(f.toolbar).find(e => e.tag === 'button')!; await toggle.fire('click'); await flush();
    expect(ws.bridgeApi).toHaveBeenCalledWith('/action', { action: 'personality_select', chat_id: 'chat-1', profile: 'auto' });
    expect(await f.api.beforeWorkspaceTurn({ text: 'roast', chatId: 'chat-1', api: wsApi, messages: [] })).toBeNull();
  });
  it('a member turn is untouched and malformed input is ignored', async () => {
    const f = await brainFixture({ workspace: workspaceStub(member()) });
    const wsApi = vi.fn();
    expect(await f.api.beforeWorkspaceTurn({ text: 'roast my commit', chatId: 'chat-1', api: wsApi, messages: [] })).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled(); expect(wsApi).not.toHaveBeenCalled();
    const o = await brainFixture({ workspace: workspaceStub(owner()) });
    expect(await o.api.beforeWorkspaceTurn(null)).toBeNull(); expect(await o.api.beforeWorkspaceTurn({ text: 'x' })).toBeNull();
  });
});
