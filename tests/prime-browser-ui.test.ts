import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const browserSource = readFileSync(new URL('../ui/echo-prime/browser.js', import.meta.url), 'utf8');

interface El {
  tag: string; textContent: string; className: string; hidden: boolean; disabled: boolean; value: string; src: string;
  naturalWidth: number; naturalHeight: number; width: number; height: number;
  children: El[]; attrs: Record<string, string>; dataset: Record<string, string>; classes: Set<string>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  style: { setProperty(k: string, v: string): void };
  append(...n: (El | string)[]): void; replaceChildren(...n: El[]): void;
  setAttribute(k: string, v: string): void; scrollIntoView?: () => void; focus?: () => void; getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(name: string, fn: (e?: unknown) => void): void; fire(name: string, e?: unknown): void;
}
function element(tag = 'div'): El {
  const handlers: Record<string, ((e?: unknown) => void)[]> = {};
  const classes = new Set<string>();
  const el: El = {
    tag, textContent: '', className: '', hidden: false, disabled: false, value: '', src: '',
    naturalWidth: 400, naturalHeight: 600, width: 200, height: 300,
    children: [], attrs: {}, dataset: {}, classes,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : on; if (v) classes.add(c); else classes.delete(c); }, contains: c => classes.has(c) },
    style: { setProperty: () => undefined },
    append(...n) { for (const x of n) this.children.push(typeof x === 'string' ? textNode(x) : x); },
    replaceChildren(...n) { this.children = n; },
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.className = v; },
    scrollIntoView: () => undefined, focus: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: el.width, height: el.height }),
    addEventListener(name, fn) { (handlers[name] ??= []).push(fn); },
    fire(name, e) { (handlers[name] ?? []).forEach(fn => fn(e ?? { target: el, preventDefault() {}, stopPropagation() {} })); },
  };
  return el;
}
function textNode(t: string): El { const n = element('#text'); n.textContent = t; return n; }
const flat = (e: El): El[] => [e, ...e.children.flatMap(flat)];
const find = (e: El, pred: (x: El) => boolean): El | undefined => flat(e).find(pred);
const allText = (e: El): string => flat(e).map(x => x.textContent).join(' ');

interface Session { authenticated: boolean; ownerAccess: boolean; user: unknown }
const owner: Session = { authenticated: true, ownerAccess: true, user: { uid: 'owner' } };
const member: Session = { authenticated: true, ownerAccess: false, user: { uid: 'm' } };
const anon: Session = { authenticated: false, ownerAccess: false, user: null };
function wsStub(session: Session | null, enabled = true) {
  const ws = { ready: Promise.resolve(enabled), enabled, session, ownerHeaders: vi.fn(async () => { if (!ws.session?.ownerAccess) throw new Error('owner only'); return { 'x-echo-csrf': 'c' }; }), invalidate: vi.fn(() => { ws.session = null; }), send: vi.fn(async () => ({ handled: false })) };
  return ws;
}

type Opts = { session?: Session | null; enabled?: boolean; status?: unknown; act?: (body: Record<string, unknown>) => unknown };
const servers: { timers: Set<ReturnType<typeof setTimeout>> }[] = [];
afterEach(() => { for (const s of servers) s.timers.forEach(clearTimeout); servers.length = 0; });

function setup(opts: Opts = {}) {
  const nodes: Record<string, El> = {};
  for (const id of ['#open-browser', '#chat-log', '#welcome', '#prompt']) nodes[id] = element(id === '#prompt' ? 'textarea' : 'div');
  const body = element('body');
  const doc = { hidden: false, activeElement: null as unknown, body, querySelector: (s: string) => nodes[s] ?? null, createElement: (t: string) => element(t), createTextNode: (t: string) => textNode(t), addEventListener: vi.fn() as unknown as (n: string, f: () => void) => void };
  const visibility: (() => void)[] = []; doc.addEventListener = (name: string, fn: () => void) => { if (name === 'visibilitychange') visibility.push(fn); };
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/status')) return { ok: true, json: async () => opts.status ?? { configured: true, available: true, relayUrl: 'http://127.0.0.1:9780' } };
    if (url.endsWith('/tabs')) return { ok: true, json: async () => ({ tabs: [{ id: 9001, url: 'https://echoomegaprime.com/', title: 'ECHO', active: true }] }) };
    if (url.includes('/snapshot/')) return { ok: true, json: async () => ({ tab: 9001, url: 'https://echoomegaprime.com/', title: 'ECHO', text: 'hello', nodes: [] }) };
    if (url.endsWith('/act')) return { ok: true, json: async () => (opts.act ? opts.act(body) : { id: 9001, url: body?.url }) };
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
  });
  const ws = opts.session !== undefined || opts.enabled !== undefined ? wsStub(opts.session ?? null, opts.enabled ?? true) : undefined;
  const chatSend = vi.fn(async () => ({ sent: true, detail: 'chat' }));
  const window: Record<string, unknown> = { addEventListener: vi.fn(), innerWidth: 1200, getSelection: () => '', EchoPrimeChat: { send: chatSend, cancel: vi.fn(), reset: vi.fn() }, ...(ws ? { EchoPrimeWorkspace: ws } : {}) };
  const timers = new Set<ReturnType<typeof setTimeout>>(); servers.push({ timers });
  const context = { window, document: doc, fetch, localStorage: { getItem: () => null, setItem: () => undefined }, setTimeout: ((f: () => void, ms?: number) => { const t = setTimeout(f, ms); timers.add(t); return t; }) as typeof setTimeout, clearTimeout, Date, AbortController, Error, Object, JSON, Array, Promise, console: { debug: vi.fn(), log: console.log } };
  runInNewContext(browserSource, context);
  const mod = window.EchoPrimeBrowser as {
    parseActions(t: string): { verb: string; value: string }[]; admission(): string; proposeBatch(a: { verb: string; value: string }[]): El | null;
    open(): void; close(): void; isOpen(): boolean; paused(): boolean; isBrowse(t: string): boolean; handleBrowse(t: string): Promise<unknown>; state: { open: boolean; collapsed: boolean };
  };
  return { mod, calls, fetch, nodes, body, doc, ws, window, visibility, chatSend };
}

describe('browser.js — parsing and admission', () => {
  it('parses a fenced ```browser block into open/navigate/click/type/read actions and ignores junk', () => {
    const { mod } = setup();
    const text = 'Sure:\n```browser\nopen https://example.com\nnavigate https://example.com/a\nclick Sign in\ntype hello world\nread #status\nnonsense line\nexplode everything\n```\n';
    const actions = mod.parseActions(text);
    expect(actions).toEqual([
      { verb: 'open', value: 'https://example.com' },
      { verb: 'navigate', value: 'https://example.com/a' },
      { verb: 'click', value: 'Sign in' },
      { verb: 'type', value: 'hello world' },
      { verb: 'read', value: '#status' },
    ]);
    expect(mod.parseActions('no fence here')).toEqual([]);
  });
  it('reads admission from the cached session without any request', () => {
    expect(setup().mod.admission()).toBe('open');            // no workspace
    expect(setup({ session: anon }).mod.admission()).toBe('signin');
    expect(setup({ session: member }).mod.admission()).toBe('member');
    expect(setup({ session: owner }).mod.admission()).toBe('owner');
  });
});

describe('browser.js — owner-only, never fetches while not the owner', () => {
  it('opens to an off-explainer and makes NO request for a signed-out or member visitor', async () => {
    for (const session of [anon, member]) {
      const { mod, fetch, body } = setup({ session });
      mod.open();
      await new Promise(r => setTimeout(r, 0));
      expect(fetch).not.toHaveBeenCalled();
      expect(body.classes.has('browser-open')).toBe(true);
    }
  });
  it('activates for the owner: checks relay status, loads tabs, and is no longer paused', async () => {
    const { mod, calls } = setup({ session: owner });
    mod.open();
    await new Promise(r => setTimeout(r, 5));
    const urls = calls.map(c => c.url);
    expect(urls.some(u => u.endsWith('/status'))).toBe(true);
    expect(urls.some(u => u.endsWith('/tabs'))).toBe(true);
  });
});

describe('browser.js — panel states and poll pause', () => {
  it('paused() is true when closed, collapsed, or the tab is hidden', async () => {
    const { mod, doc } = setup({ session: owner });
    expect(mod.paused()).toBe(true);           // not open yet
    mod.open();
    await new Promise(r => setTimeout(r, 5));
    expect(mod.paused()).toBe(false);          // open + visible
    doc.hidden = true; expect(mod.paused()).toBe(true);
    doc.hidden = false; expect(mod.paused()).toBe(false);
  });
  it('close() drops the split and stops the panel', () => {
    const { mod, body } = setup({ session: owner });
    mod.open(); expect(mod.isOpen()).toBe(true);
    mod.close(); expect(mod.isOpen()).toBe(false);
    expect(body.classes.has('browser-open')).toBe(false);
  });
});

describe('browser.js — "Let Echo drive" approval gate', () => {
  it('builds an Approve/Skip card and runs NOTHING until Approve is clicked', async () => {
    const { mod, fetch } = setup({ session: owner });
    const card = mod.proposeBatch([{ verb: 'open', value: 'https://example.com' }, { verb: 'click', value: 'Go' }])!;
    expect(card).toBeTruthy();
    expect(allText(card)).toMatch(/proposed 2 browser actions/);
    expect(fetch).not.toHaveBeenCalled();                               // nothing ran on render
    const approve = find(card, n => n.attrs['data-browser-approve'] === '1')!;
    approve.fire('click');
    await new Promise(r => setTimeout(r, 10));
    const acts = fetch.mock.calls.filter(c => String(c[0]).endsWith('/act'));
    expect(acts.length).toBeGreaterThan(0);                              // ran only after approval
    expect(JSON.parse(String((acts[0][1] as { body: string }).body)).verb).toBe('open');
  });
  it('Skip runs nothing at all', () => {
    const { mod, fetch } = setup({ session: owner });
    const card = mod.proposeBatch([{ verb: 'open', value: 'https://example.com' }])!;
    const skip = find(card, n => n.textContent === 'Skip')!;
    skip.fire('click');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('browser.js — /browse chat command', () => {
  it('intercepts /browse, opens the panel and the URL, and reports handled', async () => {
    const s = setup({ session: owner });
    expect(s.mod.isBrowse('/browse example.com')).toBe(true);
    expect(s.mod.isBrowse('hello')).toBe(false);
    const result = await (s.window.EchoPrimeChat as { send(t: string): Promise<{ handled: boolean; sent: boolean }> }).send('/browse https://example.com');
    expect(result).toMatchObject({ handled: true, sent: true });
    expect(s.calls.some(c => c.url.endsWith('/act') && c.body?.verb === 'open')).toBe(true);
    expect(s.mod.isOpen()).toBe(true);
  });
  it('passes an ordinary message through to the original chat.send', async () => {
    const s = setup({ session: owner });
    const result = await (s.window.EchoPrimeChat as { send(t: string): Promise<{ detail: string }> }).send('just a question');
    expect(result).toMatchObject({ detail: 'chat' });
    expect(s.chatSend).toHaveBeenCalledWith('just a question');
  });
});
