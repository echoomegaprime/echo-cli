import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../ui/echo-prime/videoagent.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../ui/echo-prime/videoagent.css', import.meta.url), 'utf8');
const RUN = 'c'.repeat(32), IMAGE = 'upl_' + '1'.repeat(32), CLIP = 'upl_' + '2'.repeat(32), AUDIO = 'upl_' + '3'.repeat(32), SCRIPT = 'upl_' + '4'.repeat(32), FILE = 'upl_' + '5'.repeat(32), ART = 'art_' + '6'.repeat(32);
type Handler = (event: { target: El; key?: string; preventDefault(): void }) => unknown;
// A small DOM with real parent/child moves, text replacement, attributes and disabled clicks.
class El {
  id = ''; className = ''; hidden = false; disabled = false; open = false; value = ''; type = ''; checked = false;
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; children: El[] = []; parentNode: El | null = null;
  handlers: Record<string, Handler[]> = {}; ownText = ''; focused = false;
  constructor(public tag = 'div') {}
  set innerHTML(_value: string) { throw new Error('innerHTML is forbidden in this harness'); }
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.ownText = String(value); }
  append(...nodes: El[]) { for (const node of nodes) { node.detach(); node.parentNode = this; this.children.push(node); } }
  detach() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  replaceChildren(...nodes: El[]) { for (const child of this.children) child.parentNode = null; this.children = []; this.ownText = ''; this.append(...nodes); }
  insertBefore(node: El, ref: El) { node.detach(); const index = this.children.indexOf(ref); if (index < 0) throw new Error('missing reference'); node.parentNode = this; this.children.splice(index, 0, node); }
  after(node: El) { const parent = this.parentNode; if (!parent) return; const next = parent.children[parent.children.indexOf(this) + 1]; if (next) parent.insertBefore(node, next); else parent.append(node); }
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); if (key === 'id') this.id = value; if (key === 'class') this.className = value; if (key === 'value') this.value = value; if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener(name: string, handler: Handler) { (this.handlers[name] ??= []).push(handler); }
  fire(name: string, event: Partial<Parameters<Handler>[0]> = {}) { if (name === 'click' && this.disabled) return []; return (this.handlers[name] ?? []).map(fn => fn({ target: this, preventDefault() { /* noop */ }, ...event })); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() { this.focused = true; }
  querySelectorAll(selector: string): El[] { const parts = selector.split(','); return this.children.flatMap(flat).filter(node => parts.some(part => matches(node, part.trim()))); }
  querySelector(selector: string): El | null { return this.querySelectorAll(selector)[0] ?? null; }
}
function matches(node: El, selector: string): boolean {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
  const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) return attr[2] === undefined ? node.getAttribute(attr[1]) !== null : node.getAttribute(attr[1]) === attr[2];
  return node.tag === selector;
}
const flat = (el: El): El[] => [el, ...el.children.flatMap(flat)];
const text = (el: El): string => flat(el).map(e => e.ownText).join(' | ');
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const budget = { max_calls: 8, max_cost_usd: 0.25, max_wall_s: 180, clamped: true };
const plan = (over: Record<string, unknown> = {}) => ({ schema: 'echo.video.plan.v1', name: 'video-dawn', brief: 'Dawn over water', style: 'Film', aspect: '16:9', duration_s: 8, resolution: { width: 1280, height: 720 },
  inputs: [{ id: IMAGE, kind: 'image', name: 'Lake.png', source: 'upload' }],
  shots: [{ id: 'shot-1', index: 1, prompt: 'Light on water', duration_s: 8, frames: 192, camera: 'wide', motion: 'pan', voiceover: '', inputs: [IMAGE], generation: { mode: 'image_to_video', capability: 'echo.media.video_generate' } }],
  steps: [], capabilities: ['echo.media.video_generate', 'echo.media.stitch'], budget, max_steps: 12, lane: { node: 'forge', model: 'qwen-local' }, origin: { by: 'echo', prompt_sha256: 'a'.repeat(64) },
  narration: { capability: null, voice: 'freeman', lines: 0 }, stitch: { available: true, note: 'Stitch clips locally', capability: 'echo.media.stitch' }, catalog: { live: true, ids: ['echo.media.video_generate', 'echo.media.stitch'], warnings: [] }, ready: true, missing: [], warnings: ['Review the final cut'], ...over });
const uploads = [
  { id: IMAGE, name: 'Lake.png', kind: 'image', bytes: 1234, url: 'never-send' }, { id: CLIP, name: 'Clip.mp4', kind: 'video' }, { id: AUDIO, name: 'Track.wav', kind: 'audio' }, { id: SCRIPT, name: 'Script.txt', kind: 'document' }, { id: FILE, name: 'Other.bin', kind: 'file' },
];
const running = (over: Record<string, unknown> = {}) => ({ runId: RUN, agent: 'video-dawn', status: 'running', done: false, spent: { calls: 2, cost_usd: 0.1, wall_s: 3 }, steps: [], ...over });
const finished = () => running({ status: 'done', done: true, steps: [{ step: 1, kind: 'final', verdict: 'allowed', duration_ms: 10, data: { text: '<img onerror="bad()"> final cut' } }], proof: { verdict: 'PASS', events_sha256: 'b'.repeat(64), artifacts: [{ url: '/cut.mp4' }], receipts: [{ id: 'receipt' }] } });
interface Options {
  access?: 'signin' | 'member' | 'owner' | 'open'; missingDialog?: boolean; noStudio?: boolean; noAgents?: boolean;
  uploads?: typeof uploads; artifacts?: Record<string, unknown>[]; refreshError?: string; registerError?: string; noRegister?: boolean;
  response?: (path: string, body: Record<string, unknown> | undefined) => { body: unknown; status?: number } | Promise<{ body: unknown; status?: number }> | undefined;
}
async function setup(opts: Options = {}) {
  const root = new El(), dialog = new El('dialog'); dialog.id = 'agents-dialog'; const title = new El('h2'); title.className = 'dialog-title'; title.textContent = 'Agents'; const connection = new El('p'); connection.className = 'connection-note'; dialog.append(title, new El(), connection); if (!opts.missingDialog) root.append(dialog);
  const creative = new El('dialog'); creative.id = 'creative-dialog'; const category = new El('select'); category.id = 'creative-category'; category.value = 'image'; const creativePrompt = new El('textarea'); creativePrompt.id = 'creative-prompt'; const actions = new El(); actions.className = 'creative-actions'; creative.append(category, creativePrompt, actions); root.append(creative);
  const visibility: (() => unknown)[] = [], handlers: Record<string, (() => unknown)[]> = {};
  const doc = { hidden: false, querySelector: (s: string) => root.querySelector(s), createElement: (tag: string) => new El(tag), addEventListener: (name: string, fn: () => unknown) => { if (name === 'visibilitychange') visibility.push(fn); } };
  const ws = { enabled: opts.access !== 'open', session: { authenticated: opts.access !== 'signin', ownerAccess: opts.access !== 'member' }, ready: Promise.resolve(), ownerHeaders: vi.fn(async () => ({ 'x-echo-csrf': 'owner-test' })), invalidate: vi.fn() };
  const register = vi.fn(async (_payload: unknown) => { if (opts.registerError) throw new Error(opts.registerError); return { id: ART }; });
  const library = { refresh: vi.fn(async () => { if (opts.refreshError) throw new Error(opts.refreshError); }), uploads: () => opts.uploads ?? uploads, uploadById: (id: string) => (opts.uploads ?? uploads).find(u => u.id === id) ?? null };
  const studio = { open: vi.fn((cat = 'all', prompt = '', _inputs: unknown[] = []) => { category.value = cat; creativePrompt.value = prompt; creative.showModal(); return 'original-result'; }), inputs: () => [{ upload_id: IMAGE, role: 'reference' }, { upload_id: AUDIO, role: 'audio' }, { upload_id: SCRIPT, role: 'script' }, { upload_id: FILE, role: 'mask' }] };
  const originalStudioOpen = studio.open;
  const agents = { open: vi.fn(() => dialog.showModal()) };
  const win: Record<string, unknown> = { EchoPrimeWorkspace: ws, EchoPrimeLibrary: library, EchoPrimeArtifacts: { list: () => opts.artifacts ?? [{ id: ART, title: 'Saved clip', kind: 'video' }, { id: 'art_' + '7'.repeat(32), kind: 'chat' }], ...(opts.noRegister ? {} : { register }) }, ...(!opts.noStudio ? { EchoPrimeStudio: studio } : {}), ...(!opts.noAgents ? { EchoPrimeAgents: agents } : {}), addEventListener: (name: string, fn: () => unknown) => { (handlers[name] ??= []).push(fn); } };
  const calls: { path: string; body?: Record<string, unknown>; init: { credentials: string; method: string; headers: Record<string, string>; signal: AbortSignal } }[] = [];
  const fetch = vi.fn(async (url: string, init: { credentials: string; method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => {
    const path = url.replace('/api/prime/', ''), body = init.body === undefined ? undefined : JSON.parse(init.body); calls.push({ path, body, init });
    const response = await opts.response?.(path, body); if (response) return json(response.body, response.status);
    if (path === 'video/status') return json({ configured: true, catalog: true, adk: true, uploads: true });
    if (path === 'video/plan') return json({ plan: plan() });
    if (path === 'video/agent') return json({ plan: plan(), agent: { name: 'video-dawn' }, existing: false }, 201);
    if (path === 'video/run') return json({ runId: RUN, agent: 'video-dawn', status: 'queued' }, 202);
    if (path === `adk/runs/${RUN}`) return json(running());
    if (path === `adk/runs/${RUN}/stop`) return json({ runId: RUN, status: 'running' });
    throw new Error('Unexpected request ' + path);
  });
  const debug = vi.fn();
  runInNewContext(source, { document: doc, window: win, fetch, console: { debug }, setTimeout, clearTimeout, AbortController });
  type API = { open(prefill?: { brief?: string; inputs?: { id: string; kind: string }[] }): Promise<void>; state(): { tab: string; rows: number; inputs: number; plan: boolean; agent: string | null; runId: string | null }; core: { uploadKind(kind: string): string; artifactKind(kind: string): string; requestBody(value: unknown): unknown; storyboardBody(value: unknown): unknown } };
  const api = win.EchoPrimeVideoAgent as API;
  const get = (id: string) => { const node = root.querySelector('#' + id); if (!node) throw new Error('Missing #' + id); return node; };
  const buttons = (label: string, parent = dialog) => flat(parent).filter(e => e.tag === 'button' && e.textContent === label);
  const click = async (label: string, parent = dialog) => { const b = buttons(label, parent)[0]; if (!b) throw new Error('Missing button ' + label); await Promise.all(b.fire('click')); await vi.advanceTimersByTimeAsync(0); };
  const fill = (id: string, value: string) => { const node = get(id); node.value = value; node.fire('input'); };
  const prepare = async () => { await api.open(); fill('video-brief', 'Dawn over water'); fill('video-name', 'dawn'); fill('video-style', 'Film'); get('video-prompts').querySelector('textarea')!.value = 'Light on water'; await click('Plan storyboard'); };
  const create = async () => { await prepare(); await click('Create agent'); };
  const start = async () => { await create(); await click('Run video agent'); };
  const fire = (name: string) => { for (const fn of handlers[name] ?? []) fn(); };
  const visible = async (hidden: boolean) => { doc.hidden = hidden; for (const fn of visibility) fn(); await vi.advanceTimersByTimeAsync(0); };
  return { api, root, dialog, title, connection, creative, category, creativePrompt, actions, studio, originalStudioOpen, agents, ws, register, library, calls, fetch, debug, get, buttons, click, fill, prepare, create, start, fire, visible, doc };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Video agent builder', () => {
  it('returns quietly when the Agents dialog is absent', async () => { const s = await setup({ missingDialog: true }); expect(s.api).toBeUndefined(); expect(s.calls).toEqual([]); });
  it('injects tabs after the title and panel before the connection note; synchronizes aria and dataset', async () => {
    const s = await setup(); expect(s.calls).toHaveLength(0); expect(s.dialog.children[1].className).toBe('video-tabs'); expect(s.dialog.children.at(-2)?.id).toBe('video-agent-panel');
    expect(s.buttons('Agents')[0].getAttribute('aria-selected')).toBe('true'); await s.click('Video agent'); expect(s.dialog.dataset.agentsTab).toBe('video'); expect(s.get('video-agent-panel').hidden).toBe(false); expect(s.buttons('Video agent')[0].getAttribute('aria-selected')).toBe('true');
    await s.click('Agents'); expect(s.api.state().tab).toBe('list'); expect(s.get('video-agent-panel').hidden).toBe(true); expect(s.buttons('Video agent')[0].getAttribute('aria-selected')).toBe('false');
    expect(css).toContain('#agents-dialog[data-agents-tab="video"] > :not(.dialog-title):not(.video-tabs):not(#video-agent-panel){display:none}');
  });
  it('supports keyboard tab selection', async () => { const s = await setup(); s.dialog.querySelector('.video-tabs')!.fire('keydown', { key: 'End' }); await vi.advanceTimersByTimeAsync(0); expect(s.api.state().tab).toBe('video'); expect(s.buttons('Video agent')[0].focused).toBe(true); });
  it('sends nothing for a signed-out visitor, including Refresh and planning', async () => { const s = await setup({ access: 'signin' }); await s.api.open(); await s.click('Refresh'); await s.click('Plan storyboard'); expect(text(s.dialog)).toContain('Sign in to build video agents.'); expect(s.calls).toHaveLength(0); expect(s.ws.ownerHeaders).not.toHaveBeenCalled(); });
  it('sends nothing for members', async () => { const s = await setup({ access: 'member' }); await s.api.open(); await s.click('Refresh'); expect(text(s.dialog)).toContain('Video agents are available to the primary owner only.'); expect(s.calls).toHaveLength(0); });
  it('shows status once per open and Refresh rechecks, using owner headers and same-origin credentials', async () => {
    const s = await setup(); await s.api.open(); await s.api.open(); expect(s.calls).toHaveLength(1); expect(text(s.get('video-status'))).toContain('Video agents are configured.');
    expect(s.calls[0].init).toMatchObject({ credentials: 'same-origin', method: 'GET', headers: { 'x-prime-request': '1', 'x-echo-csrf': 'owner-test' } });
    await s.click('Refresh'); expect(s.calls).toHaveLength(2); s.dialog.close(); await s.api.open(); expect(s.calls).toHaveLength(3);
  });
  it('shows a configuration refusal but allows planning', async () => { const s = await setup({ response: path => path === 'video/status' ? { body: { configured: false, adk: false, catalog: false, reason: 'No live SDK catalog' } } : undefined }); await s.prepare(); expect(text(s.get('video-status'))).toBe('No live SDK catalog'); expect(s.api.state().plan).toBe(true); });
  it('invalidates a cached owner on 401/403 and displays the server error verbatim', async () => { const s = await setup({ response: () => ({ status: 403, body: { error: 'Owner lease expired <img onerror>' } }) }); await s.api.open(); expect(s.ws.invalidate).toHaveBeenCalledOnce(); expect(text(s.get('video-status'))).toBe('Owner lease expired <img onerror>'); });
  it('swallows ownerHeaders failures and still sends the Prime request marker', async () => { const s = await setup(); s.ws.ownerHeaders.mockRejectedValue(new Error('offline')); await s.api.open(); expect(s.calls[0].init.headers).toEqual({ 'x-prime-request': '1' }); });
  it('adds, removes and reorders prompt values, relabeling and enforcing disabled boundaries', async () => {
    const s = await setup(); await s.api.open(); const list = s.get('video-prompts'); expect(s.buttons('Up')[0].disabled).toBe(true); expect(s.buttons('Down')[0].disabled).toBe(true); expect(s.buttons('Remove')[0].disabled).toBe(true); await s.click('Remove'); expect(s.api.state().rows).toBe(1);
    list.querySelector('textarea')!.value = 'first'; await s.click('Add prompt'); list.children[1].querySelector('textarea')!.value = 'second'; await Promise.all(s.buttons('Up')[1].fire('click'));
    expect(list.querySelectorAll('textarea').map(e => e.value)).toEqual(['second', 'first']); expect(list.querySelectorAll('textarea').map(e => e.getAttribute('aria-label'))).toEqual(['Shot 1', 'Shot 2']); expect(s.buttons('Down')[1].disabled).toBe(true); expect(s.buttons('Up')[1].disabled).toBe(false);
    await s.click('Remove'); expect(s.api.state().rows).toBe(1); expect(s.buttons('Remove')[0].disabled).toBe(true);
  });
  it('caps prompt rows at 18 and a disabled Add cannot click', async () => { const s = await setup(); await s.api.open(); for (let i = 0; i < 22; i++) await s.click('Add prompt'); expect(s.api.state().rows).toBe(18); expect(s.buttons('Add prompt')[0].disabled).toBe(true); });
  it('refreshes the input picker, maps upload kinds, ignores duplicates and includes only image/video artifacts', async () => {
    const s = await setup(); await s.api.open(); await s.click('Choose inputs'); expect(s.library.refresh).toHaveBeenCalledOnce();
    for (const u of uploads) await s.click(u.name + ' · ' + u.kind); await s.click('Lake.png · image'); await s.click('Saved clip · video'); expect(s.api.state().inputs).toBe(6);
    expect(s.dialog.querySelectorAll('[data-input-id]').map(e => e.getAttribute('data-input-id'))).toEqual([IMAGE, CLIP, AUDIO, SCRIPT, FILE, ART]); expect(text(s.get('video-inputs'))).toContain('Other.bin · reference');
    const remove = s.get('video-inputs').querySelector('[aria-label="Remove Lake.png"]')!; await Promise.all(remove.fire('click')); expect(s.api.state().inputs).toBe(5);
    const core = s.api.core; expect(['image', 'video', 'audio', 'document', 'file', '__proto__'].map(core.uploadKind)).toEqual(['image', 'clip', 'audio', 'script', 'reference', 'reference']); expect(['image', 'video', 'voice', 'music', 'sound', 'document', 'code', 'chat', 'other', 'toString'].map(core.artifactKind)).toEqual(['image', 'clip', 'audio', 'audio', 'audio', 'script', 'script', 'script', 'reference', 'reference']);
  });
  it('limits chosen inputs to 64 and ignores invalid identifiers', async () => { const s = await setup(); await s.api.open({ inputs: [...Array.from({ length: 70 }, (_, i) => ({ id: 'upl_' + i.toString(16).padStart(32, '0'), kind: 'image' })), { id: 'https://untrusted', kind: 'clip' }] }); expect(s.api.state().inputs).toBe(64); });
  it('reports an empty library and refresh errors safely', async () => { const s = await setup({ uploads: [], artifacts: [], refreshError: 'offline <img>' }); await s.api.open(); await s.click('Choose inputs'); expect(text(s.dialog)).toContain('Library unavailable: offline <img>'); expect(text(s.dialog)).toContain('No uploads yet. Open Library & Artifacts to upload images, clips or audio.'); });
  it('sends the exact initial request form with identifiers and mapped kinds, never bytes or URLs', async () => {
    const s = await setup(); await s.api.open(); s.fill('video-brief', '  Dawn over water '); s.fill('video-name', 'dawn'); s.fill('video-style', 'Film'); s.fill('video-duration', '24'); s.get('video-prompts').querySelector('textarea')!.value = '  Light on water  ';
    await s.click('Choose inputs'); for (const u of uploads) await s.click(u.name + ' · ' + u.kind); await s.click('Plan storyboard');
    const sent = s.calls.find(c => c.path === 'video/plan')!; expect(sent.body).toEqual({ brief: 'Dawn over water', prompts: ['Light on water'], name: 'dawn', style: 'Film', aspect: '16:9', duration_s: 24, inputs: [{ id: IMAGE, kind: 'image' }, { id: CLIP, kind: 'clip' }, { id: AUDIO, kind: 'audio' }, { id: SCRIPT, kind: 'script' }, { id: FILE, kind: 'reference' }] }); expect(sent.init.headers['content-type']).toBe('application/json'); expect(JSON.stringify(sent.body)).not.toMatch(/bytes|never-send/);
  });
  it('refuses empty prompts and invalid duration without posting', async () => { const s = await setup(); await s.api.open(); s.fill('video-brief', 'Brief'); await s.click('Plan storyboard'); expect(text(s.get('video-notice'))).toContain('Every prompt'); s.get('video-prompts').querySelector('textarea')!.value = 'Shot'; s.fill('video-duration', '2.5'); await s.click('Plan storyboard'); expect(text(s.get('video-notice'))).toContain('integer from 2 to 600'); expect(s.calls.filter(c => c.path === 'video/plan')).toHaveLength(0); });
  it('renders storyboard shots, summary, capabilities, narration, warnings and missing requirements', async () => {
    const p = plan({ ready: false, missing: ['Missing stitch'], narration: { capability: 'echo.speech.narrate', lines: 1 }, shots: [...plan().shots, { ...plan().shots[0], id: 'shot-2', inputs: [], generation: { mode: 'clip', capability: null } }] }); const s = await setup({ response: path => path === 'video/plan' ? { body: { plan: p } } : undefined }); await s.prepare(); const shown = text(s.get('video-storyboard'));
    for (const fragment of ['video-dawn', '2 shots', '1280 × 720', '12 max steps', 'up to 8 calls, $0.25, 3 min (clamped to the service caps)', 'forge · qwen-local', 'Live catalog: 2 capabilities verified', 'echo.media.video_generate', 'Narration: echo.speech.narrate (voice freeman), 1 lines', 'Stitch clips locally', 'Review the final cut', 'Not ready', 'Missing stitch', 'Shot 2', 'animate ' + IMAGE]) expect(shown).toContain(fragment);
    expect(s.get('video-create').disabled).toBe(true); await s.click('Create agent'); expect(s.calls.filter(c => c.path === 'video/agent')).toHaveLength(0);
  });
  it('disables Create when catalog.live is false even if ready is true', async () => { const s = await setup({ response: path => path === 'video/plan' ? { body: { plan: plan({ catalog: { live: false, reason: 'catalog disconnected' } }) } } : undefined }); await s.prepare(); expect(s.get('video-create').disabled).toBe(true); expect(text(s.get('video-storyboard'))).toContain('Live catalog unavailable: catalog disconnected'); });
  it('renders a sparse plan without assuming optional fields', async () => { const s = await setup({ response: path => path === 'video/plan' ? { body: { plan: { ready: false } } } : undefined }); await s.prepare(); expect(text(s.get('video-storyboard'))).toContain('budget not reported'); expect(s.get('video-create').disabled).toBe(true); });
  it('Create sends the current edited storyboard exactly, then replaces it with the authoritative plan', async () => {
    const authoritative = plan({ budget: { ...budget, max_calls: 3 } }); const s = await setup({ response: path => path === 'video/agent' ? { body: { plan: authoritative, agent: { name: 'video-dawn' }, existing: false }, status: 201 } : undefined }); await s.prepare();
    s.fill('video-shot-0-prompt', 'An edited lake'); s.fill('video-shot-0-duration', '7'); s.fill('video-shot-0-camera', 'close'); s.fill('video-shot-0-motion', 'tilt'); s.fill('video-shot-0-voiceover', 'Welcome');
    expect(text(s.get('video-storyboard'))).toContain('Edited - re-plan to recompute capabilities and budget'); expect(s.get('video-create').disabled).toBe(false); await s.click('Create agent');
    expect(s.calls.find(c => c.path === 'video/agent')!.body).toEqual({ brief: 'Dawn over water', style: 'Film', aspect: '16:9', name: 'dawn', inputs: [{ id: IMAGE, kind: 'image' }], shots: [{ prompt: 'An edited lake', duration_s: 7, camera: 'close', motion: 'tilt', voiceover: 'Welcome', inputs: [IMAGE] }] }); expect(text(s.get('video-storyboard'))).toContain('up to 3 calls'); expect(s.get('video-shot-0-prompt').value).toBe('Light on water'); expect(text(s.get('video-notice'))).toBe('Created video-dawn');
  });
  it('Re-plan sends storyboard fields and checked input IDs rather than original prompts', async () => { const s = await setup(); await s.prepare(); s.fill('video-shot-0-prompt', 'Revised'); const checkbox = s.get('video-storyboard').querySelector('fieldset')!.querySelector('input')!; checkbox.checked = false; checkbox.fire('change'); await s.click('Re-plan'); expect(s.calls.filter(c => c.path === 'video/plan')[1].body).toEqual({ brief: 'Dawn over water', style: 'Film', aspect: '16:9', name: 'dawn', inputs: [{ id: IMAGE, kind: 'image' }], shots: [{ prompt: 'Revised', duration_s: 8, camera: 'wide', motion: 'pan', voiceover: '', inputs: [] }] }); });
  it('shows existing:true without claiming to create another agent', async () => { const s = await setup({ response: path => path === 'video/agent' ? { body: { plan: plan(), agent: { name: 'video-dawn' }, existing: true } } : undefined }); await s.create(); expect(text(s.get('video-notice'))).toBe('video-dawn already existed for this storyboard; nothing new was created'); });
  it('shows an agent creation error verbatim and keeps storyboard values editable', async () => { const s = await setup({ response: path => path === 'video/agent' ? { status: 400, body: { error: 'capability <img onerror> is not in registry' } } : undefined }); await s.prepare(); s.fill('video-shot-0-prompt', 'Keep this edit'); await s.click('Create agent'); expect(text(s.get('video-notice'))).toBe('capability <img onerror> is not in registry'); expect(s.get('video-shot-0-prompt').value).toBe('Keep this edit'); expect(s.get('video-shot-0-prompt').disabled).toBe(false); expect(s.api.state().agent).toBeNull(); });
  it('posts only agent and the three authoritative budget numbers to run', async () => { const s = await setup(); await s.start(); expect(s.calls.find(c => c.path === 'video/run')!.body).toEqual({ agent: 'video-dawn', budget: { max_calls: 8, max_cost_usd: 0.25, max_wall_s: 180 } }); expect(s.api.state().runId).toBe(RUN); expect(s.get('video-start-run').disabled).toBe(true); });
  it('polls every 3 seconds and renders envelopes, model identity, gated guidance and provider refusal', async () => {
    const s = await setup({ response: path => path === `adk/runs/${RUN}` ? { body: running({ status: 'gated', steps: [{ step: 1, kind: 'cap', capability: 'echo.media.video_generate', tier: 2, verdict: 'gated', duration_ms: 120, needs: ['lease'], how: 'Grant lease' }, { step: 2, kind: 'model', data: { answered: { model: 'qwen', provider: 'forge', reported: true } } }, { step: 3, kind: 'model', data: { answered: { requested: 'other', reported: false } } }], error: { code: 'unavailable', provider: 'cinema' } }) } : undefined }); await s.start();
    const shown = text(s.get('video-run')); for (const expected of [RUN, 'Status: gated', 'Spent 2 calls, $0.1, 3 s', '#1 cap echo.media.video_generate tier 2 gated 120 ms', 'Gated: needs lease. How: Grant lease', 'answered by qwen · forge', 'model not reported', 'Provider cinema is unavailable. No fallback provider was used.']) expect(shown).toContain(expected);
    expect(s.calls.filter(c => c.path === `adk/runs/${RUN}`)).toHaveLength(1); await vi.advanceTimersByTimeAsync(3000); expect(s.calls.filter(c => c.path === `adk/runs/${RUN}`)).toHaveLength(2);
  });
  it('pauses polls while hidden and resumes once on visibilitychange', async () => { const s = await setup(); await s.start(); await s.visible(true); const n = s.calls.length; await vi.advanceTimersByTimeAsync(12000); expect(s.calls).toHaveLength(n); await s.visible(false); expect(s.calls).toHaveLength(n + 1); });
  it('stops after five consecutive failures and reports lost contact', async () => { const s = await setup({ response: path => path === `adk/runs/${RUN}` ? { status: 502, body: { error: 'offline' } } : undefined }); await s.start(); await vi.advanceTimersByTimeAsync(12000); expect(s.calls.filter(c => c.path === `adk/runs/${RUN}`)).toHaveLength(5); expect(text(s.get('video-run'))).toContain('Lost contact with Echo ADK; the run may still be running'); const n = s.calls.length; await vi.advanceTimersByTimeAsync(10000); await s.visible(false); expect(s.calls).toHaveLength(n); });
  it('a successful poll resets the consecutive failure count', async () => { let polls = 0; const s = await setup({ response: path => path === `adk/runs/${RUN}` ? (++polls === 3 ? { body: running() } : { status: 502, body: { error: 'offline' } }) : undefined }); await s.start(); await vi.advanceTimersByTimeAsync(18000); expect(polls).toBe(7); expect(text(s.get('video-run'))).toContain('Status check failed (4/5)'); await vi.advanceTimersByTimeAsync(3000); expect(text(s.get('video-run'))).toContain('Lost contact'); });
  it('shows how many job status checks the step budget leaves', async () => {
    const s = await setup({ response: path => path === 'video/plan' ? { body: { plan: plan({ estimate: { shots: 1, calls: 14, wall_s: 420, duration_s: 8, status_checks: 9 } }) } } : undefined });
    await s.prepare(); expect(text(s.get('video-storyboard'))).toContain('12 max steps · 9 job status checks · up to 8 calls');
  });
  it('closing the Agents dialog pauses the run watch without losing the run; opening the Video tab resumes it', async () => {
    const s = await setup(); await s.start(); const polls = () => s.calls.filter(c => c.path === `adk/runs/${RUN}`).length;
    expect(polls()).toBe(1); s.dialog.close(); await vi.advanceTimersByTimeAsync(12000); expect(polls()).toBe(1);
    expect(s.api.state()).toMatchObject({ tab: 'list', runId: RUN });
    await s.api.open(); await vi.advanceTimersByTimeAsync(0); expect(polls()).toBe(2); expect(text(s.get('video-run'))).not.toContain('Lost contact');
    await vi.advanceTimersByTimeAsync(3000); expect(polls()).toBe(3);
  });
  it('a status check cut off by closing the dialog is not counted as a failure after resuming', async () => {
    let release: (() => void) | undefined, hold = false;
    const s = await setup({ response: path => path === `adk/runs/${RUN}` && hold ? new Promise(resolve => { release = () => resolve({ body: running() }); }) : undefined });
    const polls = () => s.calls.filter(c => c.path === `adk/runs/${RUN}`).length;
    await s.start(); hold = true; await vi.advanceTimersByTimeAsync(3000); expect(polls()).toBe(2);
    s.dialog.close(); hold = false; await s.api.open(); await vi.advanceTimersByTimeAsync(0); expect(polls()).toBe(2);
    release!(); await vi.advanceTimersByTimeAsync(0);
    expect(text(s.get('video-run'))).not.toContain('Status check failed');
    await vi.advanceTimersByTimeAsync(3000); expect(polls()).toBe(3);
  });
  it('done renders the final artifact and proof, stops polling and registers once with the exact provenance', async () => {
    const s = await setup({ response: path => path === `adk/runs/${RUN}` ? { body: finished() } : undefined }); await s.start(); expect(text(s.get('video-run'))).toContain('Final artifact'); expect(text(s.get('video-run'))).toContain('<img onerror="bad()"> final cut'); expect(text(s.get('video-run'))).toContain('Proof: PASS'); expect(text(s.get('video-run'))).toContain('Receipts: 1'); expect(text(s.get('video-run'))).toContain('Saved to the Artifact Center');
    expect(s.register).toHaveBeenCalledExactlyOnceWith({ title: 'Video · video-dawn · ' + RUN.slice(0, 8), kind: 'video', content: { run_id: RUN, agent: 'video-dawn', status: 'done', final_text: '<img onerror="bad()"> final cut', artifacts: [{ url: '/cut.mp4' }], receipts: 1, plan_sha256: 'a'.repeat(64), shots: [{ id: 'shot-1', prompt: 'Light on water', duration_s: 8 }] }, provenance: { source: 'adk', agent: 'video-dawn', run_id: RUN, prompt: 'Dawn over water', verdict: 'PASS', events_sha256: 'b'.repeat(64) } }); const n = s.calls.length; await vi.advanceTimersByTimeAsync(12000); await s.visible(false); expect(s.calls).toHaveLength(n); expect(s.register).toHaveBeenCalledOnce();
  });
  it('reports a budget stop and a final artifact without final text', async () => { const s = await setup({ response: path => path === `adk/runs/${RUN}` ? { body: running({ done: true, status: 'failed', error: { code: 'budget_exceeded', message: 'Call limit' } }) } : undefined }); await s.start(); expect(text(s.get('video-run'))).toContain('Budget stop: the run stopped at its budget. Call limit'); expect(text(s.get('video-run'))).toContain('The run finished without a final text.'); });
  it('reports an Artifact Center registration failure once', async () => { const s = await setup({ registerError: 'Disk full', response: path => path === `adk/runs/${RUN}` ? { body: finished() } : undefined }); await s.start(); expect(text(s.get('video-run'))).toContain('Not saved to the Artifact Center: Disk full'); await vi.advanceTimersByTimeAsync(9000); expect(s.register).toHaveBeenCalledOnce(); });
  it('reports when the Artifact Center is not loaded', async () => { const s = await setup({ noRegister: true, response: path => path === `adk/runs/${RUN}` ? { body: finished() } : undefined }); await s.start(); expect(text(s.get('video-run'))).toContain('Artifact Center is not loaded'); });
  it('Stop posts an empty body and explains that a running provider call is not interrupted', async () => { const s = await setup(); await s.start(); await s.click('Stop after this step'); expect(s.calls.find(c => c.path.endsWith('/stop'))!.body).toEqual({}); expect(text(s.get('video-run'))).toContain('Stop requested; a provider call already running is not interrupted.'); await s.click('Stop after this step'); expect(s.calls.filter(c => c.path.endsWith('/stop'))).toHaveLength(1); });
  it('Studio button visibility follows both select changes and wrapped open arguments/return value', async () => { const s = await setup(); const entry = s.actions.querySelector('[data-action="make-video-agent"]')!; expect(entry.hidden).toBe(true); s.category.value = 'video'; s.category.fire('change'); expect(entry.hidden).toBe(false); const args: [string, string, unknown[]] = ['image', 'hello', [{ upload_id: IMAGE, role: 'init' }]]; expect(s.studio.open(...args)).toBe('original-result'); expect(entry.hidden).toBe(true); expect(s.originalStudioOpen).toHaveBeenCalledExactlyOnceWith(...args); s.studio.open('video', 'new'); expect(entry.hidden).toBe(false); });
  it('Studio click closes Studio, opens Agents, prefills brief/first prompt and maps inputs', async () => { const s = await setup(); s.studio.open('video', '  A lake film  '); await s.click('Make a video agent', s.creative); expect(s.creative.open).toBe(false); expect(s.agents.open).toHaveBeenCalledOnce(); expect(s.api.state()).toMatchObject({ tab: 'video', inputs: 4 }); expect(s.get('video-brief').value).toBe('A lake film'); expect(s.get('video-prompts').querySelector('textarea')!.value).toBe('A lake film'); expect(text(s.get('video-inputs'))).toContain('Track.wav · audio'); expect(text(s.get('video-inputs'))).toContain('Lake.png · image'); expect(text(s.get('video-notice'))).toBe('Prefilled from the Creative Studio'); });
  it('preserves unsent content on Studio handoff and appends only new inputs', async () => { const s = await setup(); await s.api.open({ brief: 'Keep me', inputs: [{ id: IMAGE, kind: 'image' }] }); s.studio.open('video', 'Replace me'); await s.click('Make a video agent', s.creative); expect(s.get('video-brief').value).toBe('Keep me'); expect(s.get('video-prompts').querySelector('textarea')!.value).toBe('Keep me'); expect(s.api.state().inputs).toBe(4); });
  it('opens the dialog directly if Agents is absent, and tolerates Studio being absent', async () => { const s = await setup({ noAgents: true, noStudio: true }); await s.api.open({ brief: 'Hello' }); expect(s.dialog.open).toBe(true); expect(s.actions.children).toHaveLength(0); });
  it('account change clears every form, chip, plan and run, returns to list and cancels polls', async () => { const s = await setup(); await s.start(); s.fire('echo-account-changed'); expect(s.api.state()).toEqual({ tab: 'list', rows: 1, inputs: 0, plan: false, agent: null, runId: null }); expect(s.get('video-brief').value).toBe(''); expect(s.get('video-name').value).toBe(''); expect(s.get('video-storyboard').children).toHaveLength(0); expect(s.get('video-run').children).toHaveLength(0); expect(s.get('video-inputs').children).toHaveLength(0); const n = s.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(s.calls).toHaveLength(n); });
  it('aborts in-flight requests and ignores late responses after account change', async () => { let resolve!: (value: { body: unknown }) => void; const pending = new Promise<{ body: unknown }>(r => { resolve = r; }); const s = await setup({ response: path => path === 'video/status' ? pending : undefined }); const opening = s.api.open(); await vi.advanceTimersByTimeAsync(0); expect(s.calls).toHaveLength(1); s.fire('echo-account-changed'); expect(s.calls[0].init.signal.aborted).toBe(true); resolve({ body: { configured: true } }); await opening; expect(text(s.get('video-status'))).toBe('Video agents have not been checked.'); expect(s.api.state().tab).toBe('list'); });
  it('locks the form while planning and ignores a late plan after account change', async () => {
    let resolve!: (value: { body: unknown }) => void;
    const pending = new Promise<{ body: unknown }>(r => { resolve = r; });
    const s = await setup({ response: path => path === 'video/plan' ? pending : undefined });
    await s.api.open({ brief: 'A film' });
    const planning = s.click('Plan storyboard'); await vi.advanceTimersByTimeAsync(0);
    expect(s.get('video-brief').disabled).toBe(true); expect(s.buttons('Add prompt')[0].disabled).toBe(true);
    s.fire('echo-account-changed'); resolve({ body: { plan: plan() } }); await planning;
    expect(s.api.state().plan).toBe(false); expect(s.get('video-storyboard').hidden).toBe(true); expect(s.get('video-notice').textContent).toBe('');
  });
  it('records the plan used to start a run even when a different storyboard is later planned', async () => {
    let polls = 0, plans = 0;
    const s = await setup({ response: path => {
      if (path === `adk/runs/${RUN}`) return { body: ++polls === 1 ? running() : finished() };
      if (path === 'video/plan') return { body: { plan: ++plans === 1 ? plan() : plan({ brief: 'New brief', origin: { prompt_sha256: 'd'.repeat(64) }, shots: [{ ...plan().shots[0], prompt: 'A different scene' }] }) } };
      return undefined;
    } });
    await s.start(); s.fill('video-brief', 'New brief'); await s.click('Plan storyboard');
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.register).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ plan_sha256: 'a'.repeat(64), shots: [{ id: 'shot-1', prompt: 'Light on water', duration_s: 8 }] }), provenance: expect.objectContaining({ prompt: 'Dawn over water' }) }));
  });
  it('generation labels distinguish text, animation and clips and choose the matching input kind', async () => {
    const p = plan({ inputs: [{ id: AUDIO, kind: 'audio' }, { id: IMAGE, kind: 'image' }, { id: CLIP, kind: 'clip' }], shots: [
      { ...plan().shots[0], inputs: [AUDIO, IMAGE], generation: { mode: 'image_to_video', capability: 'echo.media.video_generate' } },
      { ...plan().shots[0], inputs: [AUDIO, CLIP], generation: { mode: 'clip', capability: null } },
      { ...plan().shots[0], inputs: [], generation: { mode: 'text_to_video', capability: 'echo.media.video_generate' } },
      { ...plan().shots[0], inputs: [], generation: { mode: 'text_to_video', capability: null } },
    ] });
    const s = await setup({ response: path => path === 'video/plan' ? { body: { plan: p } } : undefined }); await s.prepare();
    const shown = text(s.get('video-storyboard'));
    for (const expected of ['animate ' + IMAGE + ' via echo.media.video_generate', 'use clip ' + CLIP + ' as-is', 'text to video via echo.media.video_generate', 'no capability: text_to_video']) expect(shown).toContain(expected);
  });
  it('keeps builder and Studio controls visible despite the global mobile quiet-button rule', () => {
    expect(css).toMatch(/\.video-panel button,\.video-tabs button,#creative-dialog \[data-action="make-video-agent"\]\{display:inline-flex/);
    expect(css).toContain('grid-template-columns:minmax(0,1fr)'); expect(css).toContain('overflow-wrap:anywhere'); expect(css).toContain(':focus-visible');
  });
  it('uses textContent for untrusted server text and never includes prompts in debug logs', async () => { const attack = '<img onerror="steal()">'; const s = await setup({ response: path => path === 'video/plan' ? { body: { plan: plan({ brief: attack, name: attack, warnings: [attack] }) } } : undefined }); await s.api.open({ brief: attack }); await s.click('Plan storyboard'); expect(s.get('video-brief').value).toBe(attack); expect(text(s.get('video-storyboard'))).toContain(attack); expect(s.dialog.querySelectorAll('img')).toHaveLength(0); expect(source).not.toContain('innerHTML'); expect(JSON.stringify(s.debug.mock.calls)).not.toContain(attack); expect(s.debug).toHaveBeenCalledWith('[echo.video]', expect.objectContaining({ event: 'video/plan', outcome: 'returned' })); });
});
