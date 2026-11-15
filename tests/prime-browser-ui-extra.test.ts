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
function wsStub(session: Session | null, enabled = true) {
  const ws = { ready: Promise.resolve(enabled), enabled, session, ownerHeaders: vi.fn(async () => { if (!ws.session?.ownerAccess) throw new Error('owner only'); return { 'x-echo-csrf': 'c' }; }), invalidate: vi.fn(() => { ws.session = null; }), send: vi.fn(async () => ({ handled: false })) };
  return ws;
}

type Opts = {
  session?: Session | null;
  enabled?: boolean;
  status?: unknown;
  tabs?: unknown[];
  snapshot?: Record<string, unknown>;
  act?: (body: Record<string, unknown>) => unknown;
};
const servers: { timers: Set<ReturnType<typeof setTimeout>> }[] = [];
afterEach(() => { for (const s of servers) s.timers.forEach(clearTimeout); servers.length = 0; });

function setup(opts: Opts = {}) {
  const nodes: Record<string, El> = {};
  for (const id of ['#open-browser', '#chat-log', '#welcome', '#prompt']) nodes[id] = element(id === '#prompt' ? 'textarea' : 'div');
  const body = element('body');
  const doc = { hidden: false, activeElement: null as unknown, body, querySelector: (s: string) => nodes[s] ?? null, createElement: (t: string) => element(t), createTextNode: (t: string) => textNode(t), addEventListener: vi.fn() as unknown as (n: string, f: () => void) => void };
  const visibility: (() => void)[] = []; doc.addEventListener = (name: string, fn: () => void) => { if (name === 'visibilitychange') visibility.push(fn); };
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const defaultTabs = [{ id: 9001, url: 'https://echoomegaprime.com/', title: 'ECHO', active: true }];
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/status')) return { ok: true, json: async () => opts.status ?? { configured: true, available: true, relayUrl: 'http://127.0.0.1:9780' } };
    if (url.endsWith('/tabs')) return { ok: true, json: async () => ({ tabs: opts.tabs ?? defaultTabs }) };
    if (url.includes('/snapshot/')) return { ok: true, json: async () => ({ tab: 9001, url: 'https://echoomegaprime.com/', title: 'ECHO', text: 'hello', nodes: [], ...opts.snapshot }) };
    if (url.endsWith('/act')) return { ok: true, json: async () => (opts.act ? opts.act(body) : { id: 9001, url: body?.url }) };
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
  });
  const ws = opts.session !== undefined || opts.enabled !== undefined ? wsStub(opts.session ?? null, opts.enabled ?? true) : undefined;
  const chatSend = vi.fn(async () => ({ sent: true, detail: 'chat' }));
  const winListeners: Record<string, ((e?: unknown) => void)[]> = {};
  const addWinListener = vi.fn((name: string, fn: (e?: unknown) => void) => { (winListeners[name] ??= []).push(fn); });
  const removeWinListener = vi.fn((name: string, fn: (e?: unknown) => void) => { winListeners[name] = (winListeners[name] ?? []).filter(f => f !== fn); });
  const fireWindow = (name: string, e?: unknown) => { (winListeners[name] ?? []).forEach(fn => fn(e)); };
  const window: Record<string, unknown> = {
    addEventListener: addWinListener,
    removeEventListener: removeWinListener,
    innerWidth: 1200,
    getSelection: () => '',
    EchoPrimeChat: { send: chatSend, cancel: vi.fn(), reset: vi.fn() },
    ...(ws ? { EchoPrimeWorkspace: ws } : {}),
  };
  const timers = new Set<ReturnType<typeof setTimeout>>(); servers.push({ timers });
  const context = { window, document: doc, fetch, localStorage: { getItem: () => null, setItem: () => undefined }, setTimeout: ((f: () => void, ms?: number) => { const t = setTimeout(f, ms); timers.add(t); return t; }) as typeof setTimeout, clearTimeout, Date, AbortController, Error, Object, JSON, Array, Promise, console: { debug: vi.fn(), log: console.log } };
  runInNewContext(browserSource, context);
  const mod = window.EchoPrimeBrowser as {
    parseActions(t: string): { verb: string; value: string }[]; admission(): string; proposeBatch(a: { verb: string; value: string }[]): El | null;
    scan(root?: El): void; open(): void; close(): void; isOpen(): boolean; paused(): boolean; isBrowse(t: string): boolean; handleBrowse(t: string): Promise<unknown>;
    state: { open: boolean; collapsed: boolean; view: string; tabs: unknown[]; activeTab: number | null; current: unknown };
  };
  return { mod, calls, fetch, nodes, body, doc, ws, window, winListeners, fireWindow, visibility, chatSend };
}

describe('browser.js — extra panel controls, actions, and lifecycle', () => {
  it('toggles body class browser-collapsed and paused() when clicking Collapse', async () => {
    const { mod, body } = setup({ session: owner });
    mod.open();
    await new Promise(r => setTimeout(r, 15));
    expect(body.classes.has('browser-collapsed')).toBe(false);
    expect(mod.paused()).toBe(false);

    const collapse = find(body, n => n.attrs['aria-label'] === 'Collapse')!;
    expect(collapse).toBeTruthy();

    collapse.fire('click');
    expect(body.classes.has('browser-collapsed')).toBe(true);
    expect(mod.paused()).toBe(true);

    collapse.fire('click');
    expect(body.classes.has('browser-collapsed')).toBe(false);
    expect(mod.paused()).toBe(false);
  });

  it('switches to image mode on view toggle click, requesting ?shot=1 and setting label to "Text view"', async () => {
    const { mod, body, calls } = setup({ session: owner });
    mod.open();
    await new Promise(r => setTimeout(r, 15));

    const toggle = find(body, n => n.attrs['title'] === 'Toggle image / text view')!;
    expect(toggle).toBeTruthy();

    const before = calls.length;
    toggle.fire('click');
    await new Promise(r => setTimeout(r, 15));

    expect(toggle.textContent).toBe('Text view');
    const snapCalls = calls.slice(before).filter(c => c.method === 'GET' && c.url.includes('/api/prime/browser/snapshot/'));
    expect(snapCalls.length).toBeGreaterThan(0);
    expect(snapCalls[0].url).toContain('?shot=1');
  });

  it('renders interactive snapshot node buttons in text mode and POSTs click act when clicked', async () => {
    const { mod, body, calls } = setup({
      session: owner,
      snapshot: { nodes: [{ role: 'link', name: 'Docs', selector: 'a#d' }] },
    });
    mod.open();
    await new Promise(r => setTimeout(r, 15));

    const nodeBtn = find(body, n => n.tag === 'button' && n.className === 'browser-node' && n.attrs['title'] === 'a#d')!;
    expect(nodeBtn).toBeTruthy();
    expect(allText(nodeBtn)).toContain('Docs');

    nodeBtn.fire('click');
    await new Promise(r => setTimeout(r, 15));

    const actCall = calls.find(c => c.method === 'POST' && c.url === '/api/prime/browser/act');
    expect(actCall?.body).toEqual({ verb: 'click', tab: 9001, text: 'Docs' });
  });

  it('POSTs navigate from address bar Enter when a tab is active, and open when no tab is active', async () => {
    const withTab = setup({ session: owner });
    withTab.mod.open();
    await new Promise(r => setTimeout(r, 15));

    const addr1 = find(withTab.body, n => n.className === 'browser-addr')!;
    addr1.value = 'example.com';
    addr1.fire('keydown', { key: 'Enter', preventDefault() {} });
    await new Promise(r => setTimeout(r, 15));

    const navAct = withTab.calls.find(c => c.method === 'POST' && c.url === '/api/prime/browser/act');
    expect(navAct?.body).toMatchObject({ verb: 'navigate', tab: 9001, url: 'https://example.com' });

    const noTab = setup({ session: owner, tabs: [] });
    noTab.mod.open();
    await new Promise(r => setTimeout(r, 15));

    const addr2 = find(noTab.body, n => n.className === 'browser-addr')!;
    addr2.value = 'example.com';
    addr2.fire('keydown', { key: 'Enter', preventDefault() {} });
    await new Promise(r => setTimeout(r, 15));

    const openAct = noTab.calls.find(c => c.method === 'POST' && c.url === '/api/prime/browser/act');
    expect(openAct?.body).toEqual({ verb: 'open', url: 'https://example.com' });
  });

  it('appends "<title> — <url>" to #prompt value when clicking "Send to chat" after snapshot render', async () => {
    const { mod, body, doc } = setup({
      session: owner,
      snapshot: { title: 'ECHO Docs', url: 'https://echoomegaprime.com/docs' },
    });
    const prompt = doc.querySelector('#prompt')!;
    prompt.value = 'Summarize:';

    mod.open();
    await new Promise(r => setTimeout(r, 15));

    const sendBtn = find(body, n => n.tag === 'button' && allText(n).trim() === 'Send to chat')!;
    expect(sendBtn).toBeTruthy();
    sendBtn.fire('click');

    expect(prompt.value).toBe('Summarize:\n\nECHO Docs — https://echoomegaprime.com/docs');
  });

  it('closes the panel and clears state.tabs when window echo-account-changed fires', async () => {
    const { mod, body, fireWindow } = setup({ session: owner });
    mod.open();
    await new Promise(r => setTimeout(r, 15));

    expect(mod.isOpen()).toBe(true);
    expect(body.classes.has('browser-open')).toBe(true);
    expect(mod.state.tabs.length).toBeGreaterThan(0);

    fireWindow('echo-account-changed');

    expect(mod.isOpen()).toBe(false);
    expect(body.classes.has('browser-open')).toBe(false);
    expect(mod.state.tabs).toEqual([]);
  });

  it('caps parseActions at 20 actions and lower-cases verbs', () => {
    const { mod } = setup({ session: owner });
    const lines = [
      'OPEN https://x',
      ...Array.from({ length: 24 }, (_, i) => `CLICK Item ${i + 1}`),
    ];
    const actions = mod.parseActions('```browser\n' + lines.join('\n') + '\n```');

    expect(actions).toHaveLength(20);
    expect(actions[0]).toEqual({ verb: 'open', value: 'https://x' });
    expect(actions.every(a => a.verb === a.verb.toLowerCase())).toBe(true);
  });
});
