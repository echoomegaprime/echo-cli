/* eslint-disable @typescript-eslint/no-explicit-any -- purpose-built browser DOM stand-in */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// The page loads media-router.js (owner of the shared Enhance control) and then build.js, both classic scripts, in that order.
const routerSource = readFileSync(new URL('../ui/echo-prime/media-router.js', import.meta.url), 'utf8');
const buildSource = readFileSync(new URL('../ui/echo-prime/build.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../ui/echo-prime/index.html', import.meta.url), 'utf8');
const ID = 'c'.repeat(32);

class TestEvent {
  type: string; target: any = null; detail: any; defaultPrevented = false;
  constructor(type: string, init: any = {}) { this.type = type; this.detail = init.detail; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { /* no propagation in the stand-in */ }
}
class Node {
  tagName: string; className = ''; hidden = false; disabled = false; value = ''; open = false; href = ''; scrollTop = 0; scrollHeight = 0;
  _text = ''; parent: Node | null = null; children: Node[] = []; attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  listeners: Record<string, ((e: any) => unknown)[]> = {};
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this._text = String(v); this.children = []; }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean), put = (xs: string[]) => { this.className = xs.join(' '); };
    const api = {add: (x: string) => { if (!list().includes(x)) put([...list(), x]); }, remove: (x: string) => put(list().filter(y => y !== x)), contains: (x: string) => list().includes(x),
      toggle: (x: string, on?: boolean) => { const yes = on === undefined ? !list().includes(x) : on; if (yes) api.add(x); else api.remove(x); return yes; }};
    return api;
  }
  append(...items: any[]) { for (const item of items) { if (!item) continue; const n = typeof item === 'string' ? Object.assign(new Node('#text'), {_text: item}) : item; n.parent = this; this.children.push(n); } }
  replaceChildren(...items: Node[]) { this.children = []; this._text = ''; this.append(...items); }
  before(...items: Node[]) { if (!this.parent) return; const at = this.parent.children.indexOf(this); for (const item of items) item.parent = this.parent; this.parent.children.splice(at, 0, ...items); }
  after(...items: Node[]) { if (!this.parent) return; const at = this.parent.children.indexOf(this); for (const item of items) item.parent = this.parent; this.parent.children.splice(at + 1, 0, ...items); }
  setAttribute(k: string, v: string) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'value') this.value = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = String(v); }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  removeAttribute(k: string) { delete this.attributes[k]; }
  addEventListener(k: string, fn: (e: any) => unknown) { (this.listeners[k] ??= []).push(fn); }
  dispatchEvent(event: any) { event.target ??= this; for (const fn of this.listeners[event.type] || []) fn(event); return !event.defaultPrevented; }
  click() { if (this.disabled) return; this.dispatchEvent(new TestEvent('click')); }
  async fire(type: string) { return Promise.all((this.listeners[type] || []).map(fn => fn({preventDefault() { /* stand-in */ }, target: this}))); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const fn of this.listeners.close || []) fn(new TestEvent('close')); }
}
const walk = (root: Node): Node[] => root.children.flatMap(c => [c, ...walk(c)]);
function matches(n: Node, selector: string) {
  if (selector.startsWith('#')) return n.getAttribute('id') === selector.slice(1);
  if (selector.startsWith('.')) return n.classList.contains(selector.slice(1));
  return n.tagName === selector.toUpperCase();
}
const tick = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };

const health = {configured: true, available: true, engines: ['gpt', 'grok', 'gemini', 'claude'], maxConcurrent: 1, wallMs: 1800000, deploy: {forge: {unitPrefix: 'echo-app'}, vercel: true}};
const models = {configured: true, routing: true,
  providers: [{id: 'claude', available: true}, {id: 'gpt', available: true}, {id: 'grok', available: false, reason: 'not logged in'}, {id: 'argon', available: true}, {id: 'qwen', available: true}],
  buildProviders: [{engine: 'gpt', available: true, check: 'signed-in'}, {engine: 'grok', available: false, reason: 'not installed'}, {engine: 'gemini', available: true, check: 'installed'}, {engine: 'claude', available: true, check: 'installed'}],
  enhance: {failures: {}}};
const enhanced = {mode: 'build', text: 'Purpose: a counter app.\nCore features: plus, minus, reset.', added: ['Acceptance checks'], provider: 'claude', providerLabel: 'Claude',
  model: {id: 'claude', label: 'Claude', model: 'claude-sonnet-5-5', reported: true, answered: true}};
const build = (status = 'queued') => ({build_id: ID, title: 'Counter app', engine: 'gpt', status, workspace: '/builds/' + ID, created_at: new Date(Date.now() - 65000).toISOString(), updated_at: '2026-11-04T20:00:00Z', log: []});
const workspace = (role = 'owner') => ({enabled: true, ready: Promise.resolve(), session: role === 'anonymous' ? null : {authenticated: true, ownerAccess: role === 'owner'}, ownerHeaders: vi.fn(async () => ({'x-echo-csrf': 'fixture'})), invalidate: vi.fn(), recheck: vi.fn(async () => undefined)});

interface Options {role?: string; enhance?: unknown; enhanceStatus?: number; pendingEnhance?: boolean; models?: unknown; router?: boolean}
async function harness(opts: Options = {}) {
  const root = new Node('body'), windowEvents: Record<string, ((e: any) => unknown)[]> = {};
  const make = (tag: string, id?: string, attrs: Record<string, string> = {}) => { const n = new Node(tag); if (id) n.setAttribute('id', id); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const named = (ids: string[]) => Object.fromEntries(ids.map(id => [id, make('div', id)]));
  const n: Record<string, Node> = named(['build-dialog', 'open-build', 'build-status', 'build-list', 'build-view', 'build-heading', 'build-meta', 'build-log', 'build-preview', 'build-turn', 'build-turn-prompt', 'build-turn-submit', 'build-deploy-review', 'build-receipt', 'build-repo', 'build-hibernate', 'build-revive', 'build-stop', 'build-deploy', 'refresh-build', 'close-build']);
  // The same shape as ui/echo-prime/index.html: the Enhance holder sits in a row beside Build it, its feedback follows the row.
  n['build-form'] = make('form', 'build-form'); n['build-title'] = make('input', 'build-title'); n['build-prompt'] = make('textarea', 'build-prompt'); n['build-engine'] = make('select', 'build-engine');
  n['build-submit'] = make('button', 'build-submit', {type: 'submit'}); n['build-submit'].disabled = true; n['build-submit']._text = 'Build it';
  n['build-enhance'] = make('div', 'build-enhance'); n['build-enhance'].hidden = true;
  n['build-enhance-feedback'] = make('div', 'build-enhance-feedback'); n['build-enhance-feedback'].hidden = true;
  const row = make('div', 'build-submit-row'); row.append(n['build-enhance'], n['build-submit']);
  n['build-form'].append(n['build-title'], n['build-prompt'], n['build-engine'], row, n['build-enhance-feedback']);
  n['build-dialog'].append(n['build-status'], n['build-list'], n['build-form'], n['build-view']);
  for (const [id, node] of Object.entries(n)) if (!node.parent && id !== 'build-dialog' && id !== 'open-build') n['build-view'].append(node);
  root.append(n['open-build'], n['build-dialog']);
  const document: any = {hidden: false, createElement: (t: string) => new Node(t), createTextNode: (t: string) => Object.assign(new Node('#text'), {_text: t}),
    querySelector: (s: string) => [root, ...walk(root)].find(x => matches(x, s)) ?? null, querySelectorAll: (s: string) => walk(root).filter(x => matches(x, s)), addEventListener: vi.fn()};
  const ws = workspace(opts.role);
  const win: any = {EchoPrimeWorkspace: ws, addEventListener: (k: string, fn: (e: any) => unknown) => (windowEvents[k] ??= []).push(fn), dispatchEvent: (e: any) => { for (const fn of windowEvents[e.type] || []) fn(e); }};
  const calls: {url: string; method: string; body?: any; headers?: any}[] = [];
  let release!: () => void;
  const json = (value: unknown, status = 200) => ({ok: status < 400, status, headers: {get: () => 'application/json'}, json: async () => value});
  let current: any = build();
  const fetch = vi.fn(async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({url, method: init.method ?? 'GET', body, headers: init.headers});
    if (url === '/api/prime/build/health') return json(health);
    if (url === '/api/prime/models') return json(opts.models ?? models);
    if (url === '/api/prime/build/list') return json({builds: [current]});
    if (url === '/api/prime/build/create') { current = {...current, status: 'queued'}; return json(current, 202); }
    if (url === '/api/prime/build/' + ID) return json(current);
    if (url.includes('/log?since=')) return json({events: [], next: 0, truncated: false});
    if (url === '/api/prime/enhance') {
      if (opts.pendingEnhance) return new Promise(resolve => { release = () => resolve(json(opts.enhance ?? enhanced)); });
      return json(opts.enhance ?? enhanced, opts.enhanceStatus ?? 200);
    }
    throw new Error('Unexpected route ' + url);
  });
  const debug = vi.fn();
  const context = {window: win, document, fetch, location: {protocol: 'https:'}, AbortSignal, AbortController, Event: TestEvent, console: {debug}, setTimeout, clearTimeout, Date};
  if (opts.router !== false) runInNewContext(routerSource, context);
  runInNewContext(buildSource, context);
  if (opts.router !== false) await win.EchoPrimeMediaRouter.ready;
  await tick();
  const all = () => [root, ...walk(root)];
  const find = (attr: string, value: string) => all().find(x => x.getAttribute(attr) === value);
  const enhanceCalls = () => calls.filter(c => c.url === '/api/prime/enhance');
  const open = async () => { await win.EchoPrimeBuild.open(); await tick(); };
  return {n, calls, debug, win, ws, fetch, row, all, find, enhanceCalls, open, release: () => release(), fire: (k: string, e: any = new TestEvent(k)) => (windowEvents[k] || []).forEach(fn => fn(e)),
    button: () => find('data-enhance', 'build')!, chip: () => find('data-enhance-provider', 'build')!, undo: () => find('data-enhance-undo', 'build')!, note: () => find('data-enhance-note', 'build')!, added: () => find('data-enhance-added', 'build')!,
    createCalls: () => calls.filter(c => c.url === '/api/prime/build/create')};
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Echo Build Enhance: markup and placement', () => {
  it('ships one holder beside Build it, loads media-router.js before build.js, and keeps the submit button', () => {
    expect(html.match(/id="build-enhance"/g)).toHaveLength(1);
    expect(html.match(/id="build-submit"/g)).toHaveLength(1);
    expect(html.match(/id="build-enhance-feedback"/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="build-submit-row"><div id="build-enhance" class="build-enhance" hidden><\/div><button id="build-submit" class="new-chat" type="submit" disabled>Build it<\/button><\/div>/);
    expect(html.indexOf('src="media-router.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="media-router.js"')).toBeLessThan(html.indexOf('src="build.js"'));
  });

  it('mounts exactly one named Enhance button in the form, after the description and before Build it', async () => {
    const h = await harness();
    expect(h.all().filter(x => x.getAttribute('data-enhance') === 'build')).toHaveLength(1);
    const button = h.button();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Enhance build description');
    expect(button.textContent).toContain('Enhance');
    const order = walk(h.n['build-form']);
    expect(order.indexOf(h.n['build-prompt'])).toBeLessThan(order.indexOf(button));
    expect(order.indexOf(button)).toBeLessThan(order.indexOf(h.n['build-submit']));
    expect(h.n['build-enhance'].children.some(c => walk(c).includes(button) || c === button)).toBe(true);
    expect(h.n['build-enhance-feedback'].children).toContain(h.note());
    expect(h.n['build-enhance-feedback'].children).toContain(h.added());
    expect(h.n['build-submit'].getAttribute('type')).toBe('submit');
  });

  it('is still one control after the view is opened and refreshed', async () => {
    const h = await harness();
    await h.open(); await h.n['refresh-build'].fire('click'); await tick();
    expect(h.all().filter(x => x.getAttribute('data-enhance') === 'build')).toHaveLength(1);
    expect(h.win.EchoPrimeMediaRouter.mountEnhance({name: 'build', textarea: () => null, mode: () => 'build', mount() { throw new Error('mounted twice'); }}).button).toBe(h.button());
  });

  it('does not break Echo Build when the media router script is absent', async () => {
    const h = await harness({router: false});
    await h.open();
    expect(h.n['build-engine'].value).toBe('gpt');
    expect(h.n['build-submit'].disabled).toBe(false);
    expect(h.all().some(x => x.getAttribute('data-enhance') !== null)).toBe(false);
    expect(h.debug).toHaveBeenCalledWith('[echo.enhance]', expect.objectContaining({schema_version: 1, event: 'prime_enhance_mount_skipped', surface: 'build', reason: 'media_router_absent'}));
  });
});

describe('Echo Build Enhance: rewriting the description', () => {
  it('sends mode build with the textarea text, puts the result back, and starts no build', async () => {
    const h = await harness(); await h.open();
    h.n['build-title'].value = 'Counter';
    h.n['build-prompt'].value = '  a counter app with plus and minus  ';
    h.button().click(); await tick();
    expect(h.enhanceCalls()).toHaveLength(1);
    expect(h.enhanceCalls()[0].method).toBe('POST');
    expect(h.enhanceCalls()[0].body).toEqual({mode: 'build', text: 'a counter app with plus and minus', provider: 'claude'});
    expect(h.enhanceCalls()[0].headers['x-prime-request']).toBe('1');
    expect(h.n['build-prompt'].value).toBe(enhanced.text);
    expect(h.createCalls()).toHaveLength(0);
    expect(h.calls.filter(c => c.method === 'POST' && c.url !== '/api/prime/enhance')).toHaveLength(0);
    expect(h.n['build-title'].value).toBe('Counter');
    expect(h.n['build-submit'].disabled).toBe(false);
  });

  it('shows who enhanced it, which model, what it added, and that nothing was built or sent', async () => {
    const h = await harness(); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    const note = h.note().textContent;
    expect(h.note().hidden).toBe(false);
    expect(note).toContain('Enhanced by Claude');
    expect(note).toContain('claude-sonnet-5-5');
    expect(note).toContain('as a build prompt');
    expect(note).toContain('added 1 thing');
    expect(note).toContain('no build was started');
    expect(note).toContain('press Build it yourself');
    expect(note).not.toContain('press Send');
    expect(h.added().textContent).toContain('Acceptance checks');
  });

  it('announces the working state and the busy button, ignores a second click, and recovers', async () => {
    const h = await harness({pendingEnhance: true}); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.button().disabled).toBe(true);
    expect(h.chip().disabled).toBe(true);
    expect(h.button().textContent).toContain('Enhancing…');
    expect(h.note().textContent).toContain('Asking Claude to enhance this build prompt');
    expect(h.note().getAttribute('role')).toBe('status');
    expect(h.note().getAttribute('aria-live')).toBe('polite');
    h.button().click(); await tick();
    expect(h.enhanceCalls()).toHaveLength(1);
    h.release(); await tick();
    expect(h.button().disabled).toBe(false);
    expect(h.button().textContent).toContain('Enhance');
    expect(h.button().textContent).not.toContain('Enhancing');
    expect(h.n['build-prompt'].value).toBe(enhanced.text);
  });

  it('does not replace a description that changed while the provider was working', async () => {
    const h = await harness({pendingEnhance: true}); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    h.n['build-prompt'].value = 'a counter app, and more';
    h.release(); await tick();
    expect(h.n['build-prompt'].value).toBe('a counter app, and more');
    expect(h.note().textContent).toContain('changed while enhancing');
    expect(h.undo().hidden).toBe(true);
  });

  it('refuses an empty description and an over-long one without calling the provider', async () => {
    const h = await harness(); await h.open();
    h.button().click(); await tick();
    expect(h.note().textContent).toContain('Type a prompt first.');
    h.n['build-prompt'].value = 'x'.repeat(4001);
    h.button().click(); await tick();
    expect(h.note().textContent).toContain('4,000 characters');
    expect(h.enhanceCalls()).toHaveLength(0);
    expect(h.n['build-prompt'].value).toBe('x'.repeat(4001));
  });

  it('then Build it submits the enhanced text with the unchanged Engine choice', async () => {
    const h = await harness(); await h.open();
    h.n['build-title'].value = 'Counter';
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    await h.n['build-form'].fire('submit'); await tick();
    expect(h.createCalls()).toHaveLength(1);
    expect(h.createCalls()[0].body).toEqual({title: 'Counter', prompt: enhanced.text, engine: 'gpt'});
  });

  it('keeps the Build view rules: a title is still required and no build starts without one', async () => {
    const h = await harness(); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    await h.n['build-form'].fire('submit'); await tick();
    expect(h.createCalls()).toHaveLength(0);
    expect(h.n['build-status'].textContent).toContain('Enter a title (up to 120 characters)');
  });
});

describe('Echo Build Enhance: Undo', () => {
  it('restores the exact previous text byte for byte, including whitespace, tabs and CRLF', async () => {
    const h = await harness(); await h.open();
    const original = '  Make a counter\twith "quotes"\r\nand ünïcode   \n\n  ';
    h.n['build-prompt'].value = original;
    expect(h.undo().hidden).toBe(true);
    h.button().click(); await tick();
    expect(h.n['build-prompt'].value).toBe(enhanced.text);
    expect(h.undo().hidden).toBe(false);
    expect(h.undo().tagName).toBe('BUTTON');
    expect(h.undo().textContent).toBe('Undo enhance');
    h.undo().click();
    expect(h.n['build-prompt'].value).toBe(original);
    expect(h.undo().hidden).toBe(true);
    expect(h.added().hidden).toBe(true);
    expect(h.note().textContent).toContain('Restored your original prompt.');
    expect(h.createCalls()).toHaveLength(0);
  });

  it('a second Enhance undoes back to the text before that press', async () => {
    const h = await harness(); await h.open();
    h.n['build-prompt'].value = 'first';
    h.button().click(); await tick();
    const second = 'second draft by hand';
    h.n['build-prompt'].value = second;
    h.button().click(); await tick();
    h.undo().click();
    expect(h.n['build-prompt'].value).toBe(second);
  });
});

describe('Echo Build Enhance: failures are named and nothing is changed', () => {
  it('names an expired CLI sign-in, keeps the text, hides Undo and points the next press at the next provider', async () => {
    const reason = 'Claude (claude CLI) is unavailable: Failed to authenticate: OAuth session expired and could not be refreshed; no fallback was used';
    const h = await harness({enhanceStatus: 503, enhance: {error: reason}}); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.n['build-prompt'].value).toBe('a counter app');
    expect(h.undo().hidden).toBe(true);
    expect(h.note().textContent).toBe(reason + '. Your prompt was not changed. GPT is selected for your next try; press Enhance again to use it.');
    expect(h.chip().value).toBe('gpt');
    expect(h.createCalls()).toHaveLength(0);
    expect(h.button().disabled).toBe(false);
  });

  it('skips a provider the server already lists as signed out when it picks the default, and says which', async () => {
    const h = await harness({models: {...models, enhance: {failures: {claude: {category: 'auth', reason: 'OAuth session expired', at: '2026-11-06T09:00:00Z'}}}}}); await h.open();
    expect(h.chip().value).toBe('gpt');
    expect((h.button() as any).title).toContain('Skipped Claude: its last enhance could not sign in.');
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.enhanceCalls()[0].body.provider).toBe('gpt');
  });

  it('reports a provider error in words and leaves the description alone', async () => {
    const h = await harness({enhanceStatus: 502, enhance: {error: 'Claude failed: rate limited; no other provider was used'}}); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.note().textContent).toContain('Claude failed: rate limited; no other provider was used.');
    expect(h.note().textContent).toContain('Your prompt was not changed.');
    expect(h.n['build-prompt'].value).toBe('a counter app');
    expect(h.undo().hidden).toBe(true);
  });
});

describe('Echo Build Enhance: credential warnings from the server', () => {
  it('shows the warning in the status note, marks it, and still replaces the text (the credential is gone from the result)', async () => {
    const warning = 'Your draft contains text that looks like a credential. It was not sent to the model and is shown as [REDACTED]; remove it from your draft.';
    const h = await harness({enhance: {...enhanced, text: 'Purpose: a weather app (api_key=[REDACTED])', warnings: [warning]}}); await h.open();
    h.n['build-prompt'].value = 'a weather app, api_key=sk-fake';
    h.button().click(); await tick();
    expect(h.n['build-prompt'].value).toBe('Purpose: a weather app (api_key=[REDACTED])');
    expect(h.note().textContent).toContain('Warning: ' + warning);
    expect(h.note().classList.contains('enhance-warn')).toBe(true);
    expect(h.note().textContent).toContain('no build was started');
    h.undo().click();
    expect(h.n['build-prompt'].value).toBe('a weather app, api_key=sk-fake');
  });

  it('shows no warning styling for an ordinary result', async () => {
    const h = await harness(); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.note().textContent).not.toContain('Warning');
    expect(h.note().classList.contains('enhance-warn')).toBe(false);
  });
});

describe('Echo Build Enhance: provider choice and the Engine select', () => {
  it('uses the shared Enhance chip (Claude by preference) and leaves the Engine select exactly as it was', async () => {
    const h = await harness(); await h.open();
    const engine = h.n['build-engine'], before = engine.children.map(o => [o.value, o.textContent, o.disabled]);
    expect(h.chip()).not.toBe(engine);
    expect(h.chip().getAttribute('aria-label')).toBe('Enhance with');
    expect(engine.value).toBe('gpt');
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.enhanceCalls()[0].body.provider).toBe('claude');
    expect(engine.value).toBe('gpt');
    expect(engine.children.map(o => [o.value, o.textContent, o.disabled])).toEqual(before);
    h.chip().value = 'gpt'; h.chip().dispatchEvent(new TestEvent('change'));
    h.button().click(); await tick();
    expect(h.enhanceCalls()[1].body.provider).toBe('gpt');
    expect(engine.value).toBe('gpt');
    expect(engine.children.map(o => [o.value, o.textContent, o.disabled])).toEqual(before);
  });

  it('lists only the Enhance providers, disabling the unavailable one, and never the Build engines', async () => {
    const h = await harness(); await h.open();
    expect(h.chip().children.map(o => o.textContent)).toEqual(['Claude', 'GPT', 'Grok (unavailable: not logged in)', 'Gemini (Argon)', 'Qwen']);
    expect(h.chip().children[2].disabled).toBe(true);
  });

  it('changing the Engine does not change the Enhance provider', async () => {
    const h = await harness(); await h.open();
    h.n['build-engine'].value = 'gemini'; await h.n['build-engine'].fire('change');
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.enhanceCalls()[0].body.provider).toBe('claude');
  });
});

describe('Echo Build Enhance: owner only', () => {
  it.each(['anonymous', 'member'])('hides the control for %s and never calls the models or enhance routes', async role => {
    const h = await harness({role}); await h.open();
    expect(h.n['build-enhance'].hidden).toBe(true);
    expect(h.n['build-enhance-feedback'].hidden).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect(h.n['build-status'].textContent).toBe(role === 'member' ? 'Echo Build is available to the primary owner only.' : 'Sign in as the primary owner to use Echo Build.');
    h.button().click(); await tick();
    expect(h.enhanceCalls()).toHaveLength(0);
    expect(h.ws.ownerHeaders).not.toHaveBeenCalled();
  });

  it('shows the control for the primary owner and hides it again when the account changes to a non-owner', async () => {
    const h = await harness(); await h.open();
    expect(h.n['build-enhance'].hidden).toBe(false);
    expect(h.n['build-enhance-feedback'].hidden).toBe(false);
    h.ws.session = {authenticated: true, ownerAccess: false};
    h.fire('echo-account-changed'); await tick();
    h.n['open-build'].dispatchEvent(new TestEvent('click')); await tick();
    expect(h.n['build-enhance'].hidden).toBe(true);
    expect(h.n['build-enhance-feedback'].hidden).toBe(true);
  });
});

describe('Echo Build Enhance: account changes', () => {
  it('forgets the previous text, note and additions, and re-reads the models', async () => {
    const h = await harness(); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    const before = h.calls.filter(c => c.url === '/api/prime/models').length;
    h.fire('echo-account-changed'); await tick();
    expect(h.n['build-prompt'].value).toBe('');
    expect(h.undo().hidden).toBe(true);
    expect(h.added().hidden).toBe(true);
    expect(h.note().textContent).not.toContain('Enhanced by');
    expect(h.calls.filter(c => c.url === '/api/prime/models').length).toBeGreaterThan(before);
  });
});

describe('Echo Build Enhance: keyboard and structured debug events', () => {
  it('uses native controls that a keyboard activates through click, in a sensible tab order, with no pointer-only handlers', async () => {
    const h = await harness(); await h.open();
    const button = h.button(), undo = h.undo(), chip = h.chip();
    for (const control of [button, undo]) {
      expect(control.tagName).toBe('BUTTON');
      expect(control.getAttribute('type')).toBe('button');
      expect(control.getAttribute('tabindex')).toBeNull();
      expect(Object.keys(control.listeners)).toEqual(['click']);
    }
    expect(chip.tagName).toBe('SELECT');
    expect(chip.getAttribute('tabindex')).toBeNull();
    expect(Object.keys(chip.listeners)).toEqual(['change']);
    const order = walk(h.n['build-form']);
    expect(order.indexOf(h.n['build-engine'])).toBeLessThan(order.indexOf(button));
    expect(order.indexOf(button)).toBeLessThan(order.indexOf(chip));
    expect(order.indexOf(chip)).toBeLessThan(order.indexOf(undo));
    expect(order.indexOf(undo)).toBeLessThan(order.indexOf(h.n['build-submit']));
    h.n['build-prompt'].value = 'a counter app';
    button.click(); await tick();
    expect(h.n['build-prompt'].value).toBe(enhanced.text);
    h.n['build-prompt'].value = 'typed after';
    expect(h.createCalls()).toHaveLength(0);
  });

  it('emits [echo.enhance] events for mount and apply with the build surface, and for a failure', async () => {
    const h = await harness(); await h.open();
    expect(h.debug).toHaveBeenCalledWith('[echo.enhance]', {schema_version: 1, event: 'prime_enhance_mounted', surface: 'build'});
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.debug).toHaveBeenCalledWith('[echo.enhance]', expect.objectContaining({schema_version: 1, event: 'prime_enhance_applied', surface: 'build', mode: 'build', provider: 'claude', model: 'claude-sonnet-5-5', added: 1, warnings: 0}));
    const failing = await harness({enhanceStatus: 502, enhance: {error: 'Claude failed: x; no other provider was used'}}); await failing.open();
    failing.n['build-prompt'].value = 'a counter app';
    failing.button().click(); await tick();
    expect(failing.debug).toHaveBeenCalledWith('[echo.enhance]', expect.objectContaining({schema_version: 1, event: 'prime_enhance_failed', surface: 'build', mode: 'build', provider: 'claude'}));
  });

  it('never puts the draft text or a credential in a debug event', async () => {
    const h = await harness({enhance: {...enhanced, text: 'brief with TOPSECRETWORD', warnings: ['careful']}}); await h.open();
    h.n['build-prompt'].value = 'draft with TOPSECRETWORD api_key=sk-fake';
    h.button().click(); await tick();
    expect(JSON.stringify(h.debug.mock.calls)).not.toContain('TOPSECRETWORD');
    expect(JSON.stringify(h.debug.mock.calls)).not.toContain('sk-fake');
  });
});

describe('Echo Build Enhance: Build it waits while Enhance works', () => {
  it('disables Build it for the whole request, refuses a submit with a reason, and enables it again once the text has been replaced', async () => {
    const h = await harness({pendingEnhance: true}); await h.open();
    h.n['build-title'].value = 'Counter'; h.n['build-prompt'].value = 'a counter app';
    expect(h.n['build-submit'].disabled).toBe(false);
    h.button().click(); await tick();
    expect(h.n['build-submit'].disabled).toBe(true);
    await h.n['build-form'].fire('submit'); await tick();
    expect(h.createCalls()).toHaveLength(0);
    expect(h.n['build-status'].textContent).toContain('Enhance is still working');
    expect(h.n['build-prompt'].value).toBe('a counter app');
    h.release(); await tick();
    expect(h.n['build-prompt'].value).toBe(enhanced.text);
    expect(h.n['build-submit'].disabled).toBe(false);
    await h.n['build-form'].fire('submit'); await tick();
    expect(h.createCalls()).toHaveLength(1);
    expect(h.createCalls()[0].body.prompt).toBe(enhanced.text);
  });

  it('stays disabled through a refresh and an Engine change while Enhance works', async () => {
    const h = await harness({pendingEnhance: true}); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    await h.n['refresh-build'].fire('click'); await tick();
    await h.n['build-engine'].fire('change'); await tick();
    expect(h.n['build-submit'].disabled).toBe(true);
    h.release(); await tick();
    expect(h.n['build-submit'].disabled).toBe(false);
  });

  it('enables it again after a failed Enhance and after one that replaced nothing because the text changed', async () => {
    const failing = await harness({enhanceStatus: 502, enhance: {error: 'Claude failed: x; no other provider was used'}}); await failing.open();
    failing.n['build-prompt'].value = 'a counter app';
    failing.button().click(); await tick();
    expect(failing.n['build-submit'].disabled).toBe(false);
    const changed = await harness({pendingEnhance: true}); await changed.open();
    changed.n['build-prompt'].value = 'a counter app';
    changed.button().click(); await tick();
    changed.n['build-prompt'].value = 'a counter app, edited by hand';
    changed.release(); await tick();
    expect(changed.n['build-submit'].disabled).toBe(false);
  });

  it('does not stay locked when the account changes while Enhance is working', async () => {
    const h = await harness({pendingEnhance: true}); await h.open();
    h.n['build-prompt'].value = 'a counter app';
    h.button().click(); await tick();
    expect(h.n['build-submit'].disabled).toBe(true);
    h.fire('echo-account-changed'); await tick();
    h.release(); await tick();
    h.n['open-build'].dispatchEvent(new TestEvent('click')); await tick();
    expect(h.n['build-submit'].disabled).toBe(false);
  });

  it('logs the lock and the unlock as [echo.enhance] events with no text in them', async () => {
    const h = await harness({pendingEnhance: true}); await h.open();
    h.n['build-prompt'].value = 'draft with TOPSECRETWORD';
    h.button().click(); await tick();
    expect(h.debug).toHaveBeenCalledWith('[echo.enhance]', {schema_version: 1, event: 'prime_enhance_build_locked', surface: 'build', locked: true});
    await h.n['build-form'].fire('submit'); await tick();
    expect(h.debug).toHaveBeenCalledWith('[echo.enhance]', {schema_version: 1, event: 'prime_enhance_build_blocked', surface: 'build'});
    h.release(); await tick();
    expect(h.debug).toHaveBeenCalledWith('[echo.enhance]', {schema_version: 1, event: 'prime_enhance_build_locked', surface: 'build', locked: false});
    expect(JSON.stringify(h.debug.mock.calls)).not.toContain('TOPSECRETWORD');
  });
});

describe('Echo Build Enhance: the line breaks a browser reports', () => {
  /** A real textarea reports its text with LF line breaks whatever was typed or pasted; this stand-in does the same. */
  const browserLikeTextarea = (node: Node) => {
    let raw = '';
    Object.defineProperty(node, 'value', {configurable: true, get: () => raw.replace(/\r\n?/g, '\n'), set: (v: string) => { raw = String(v); }});
  };

  it('restores exactly what the textarea reported before Enhance, and sends the same LF text to the server', async () => {
    const h = await harness(); browserLikeTextarea(h.n['build-prompt']); await h.open();
    h.n['build-prompt'].value = '  line one\r\nline two\r\n\r\n  ';
    const reported = h.n['build-prompt'].value;
    expect(reported).toBe('  line one\nline two\n\n  ');
    h.button().click(); await tick();
    expect(h.enhanceCalls()[0].body.text).toBe('line one\nline two');
    expect(h.n['build-prompt'].value).toBe(enhanced.text);
    h.undo().click();
    expect(h.n['build-prompt'].value).toBe(reported);
  });
});

// ---- Stylesheet cascade ------------------------------------------------------------------------------------------------
// The gate host has no browser, so layout cannot be rendered there. This stand-in applies the page's real stylesheets in the
// order index.html links them (specificity, then source order, `font` expanded) to a described element chain. It is a check
// of which rule wins for the provider chip and Build it, not a pixel test: DEPLOY_BUILD_ENHANCE.md step 3 is the visual check.
type Chain = {tag: string; classes: string[]; id: string}[];
const dom = (tag: string, classes: string[] = [], id = '') => ({tag, classes, id});
interface Winner { value: string; spec: number[]; order: number; selector: string }
function cssRules() {
  const files = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  const rules: {selectors: string[]; decls: [string, string][]; order: number}[] = [];
  let order = 0;
  for (const file of files) {
    const css = readFileSync(new URL('../ui/echo-prime/' + file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0, headStart = 0, bodyStart = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '{') { if (depth === 0) bodyStart = i; depth++; }
      else if (css[i] === '}' && --depth === 0) {
        const head = css.slice(headStart, bodyStart).trim(), body = css.slice(bodyStart + 1, i);
        headStart = i + 1;
        if (head.startsWith('@')) continue; // media queries: the desktop layout is what is compared
        const decls = body.split(/;(?![^(]*\))/).map(d => d.trim()).filter(d => d.includes(':')).map(d => [d.slice(0, d.indexOf(':')).trim().toLowerCase(), d.slice(d.indexOf(':') + 1).replace(/!important/i, '').trim()] as [string, string]);
        rules.push({selectors: head.split(/,(?![^(]*\))/).map(s => s.trim()), decls, order: order++});
      }
    }
  }
  return rules;
}
const allRules = cssRules();
function compoundMatches(compound: string, element: Chain[number]) {
  const m = /^([a-z][a-z0-9]*|\*)?((?:[.#][\w-]+)*)$/i.exec(compound);
  if (!m) return false; // attribute and pseudo selectors (:hover, [hidden]) are not the resting state
  if (m[1] && m[1] !== '*' && m[1].toLowerCase() !== element.tag) return false;
  return [...m[2].matchAll(/([.#])([\w-]+)/g)].every(([, kind, name]) => kind === '.' ? element.classes.includes(name) : element.id === name);
}
function selectorMatches(tokens: string[], at: number, chain: Chain, index: number): boolean {
  if (!compoundMatches(tokens[at], chain[index])) return false;
  if (at === 0) return true;
  if (tokens[at - 1] === '>') return index > 0 && selectorMatches(tokens, at - 2, chain, index - 1);
  for (let j = index - 1; j >= 0; j--) if (selectorMatches(tokens, at - 1, chain, j)) return true;
  return false;
}
const specificity = (selector: string) => [(selector.match(/#[\w-]+/g) ?? []).length, (selector.match(/\.[\w-]+/g) ?? []).length, (selector.replace(/[.#][\w-]+/g, ' ').match(/[a-z][a-z0-9]*/gi) ?? []).length];
const beats = (a: number[], orderA: number, b: Winner) => { for (let i = 0; i < 3; i++) if (a[i] !== b.spec[i]) return a[i] > b.spec[i]; return orderA > b.order; };
function winners(chain: Chain) {
  const won = new Map<string, Winner>();
  for (const rule of allRules) for (const selector of rule.selectors) {
    const tokens = selector.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
    if (!selectorMatches(tokens, tokens.length - 1, chain, chain.length - 1)) continue;
    const spec = specificity(selector);
    for (const [prop, value] of rule.decls) for (const p of prop === 'font' ? ['font', 'font-size', 'font-family'] : [prop]) {
      const old = won.get(p);
      if (!old || beats(spec, rule.order, old)) won.set(p, {value, spec, order: rule.order, selector});
    }
  }
  return won;
}
const buildForm: Chain = [dom('body'), dom('dialog', ['panel-dialog', 'build-dialog'], 'build-dialog'), dom('div', ['build-layout']), dom('div'), dom('form', ['build-form'], 'build-form')];
const buildChip: Chain = [...buildForm, dom('div', ['build-submit-row']), dom('div', ['build-enhance'], 'build-enhance'), dom('div', ['enhance-wrap']), dom('select', ['enhance-provider'])];
const composerChip: Chain = [dom('body'), dom('main'), dom('div', ['composer-wrap']), dom('form', ['composer'], 'composer'), dom('div', ['composer-bottom']), dom('div', ['send-actions']), dom('div', ['enhance-wrap']), dom('select', ['enhance-provider'])];

describe('Echo Build Enhance: stylesheet cascade (no browser on the gate host)', () => {
  it('finds the Build form rule that restyles a plain select, so the checks below are not vacuous', () => {
    const plain = winners([...buildForm, dom('label'), dom('select')]);
    expect(plain.get('width')?.value).toBe('100%');
    expect(plain.get('border-radius')?.value).toBe('8px');
    expect(plain.get('width')?.selector).toBe('.build-form select');
  });

  it('gives the provider chip the same declarations in the Build form as in the composer', () => {
    const inBuild = winners(buildChip), inComposer = winners(composerChip);
    const same = (w?: Winner, prop?: string) => prop === 'width' && (!w || w.value === 'auto') ? 'auto' : w?.value ?? '';
    for (const prop of ['width', 'max-width', 'box-sizing', 'padding', 'border', 'border-radius', 'background', 'color', 'font-size', 'font-family'])
      expect(same(inBuild.get(prop), prop), prop + ' won by "' + inBuild.get(prop)?.selector + '"').toBe(same(inComposer.get(prop), prop));
  });

  it('keeps Build it stretching across the form column, as it did before it moved into the Enhance row', () => {
    const submit = winners([...buildForm, dom('div', ['build-submit-row']), dom('button', ['new-chat'], 'build-submit')]);
    expect(submit.get('flex')?.value, 'flex won by "' + submit.get('flex')?.selector + '"').toMatch(/^1 1 /);
  });
});
