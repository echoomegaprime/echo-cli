/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The shipped bots.js runs unchanged in a small DOM harness against synthetic Prime responses. This proves gating
// (nothing fetched while anonymous), rendering, the create and two-step delete flows and the 3 s transcript poll, not a live service.
const source = readFileSync(new URL('../ui/echo-prime/bots.js', import.meta.url), 'utf8');
const BOT = 'a'.repeat(32), BOT2 = 'b'.repeat(32), BOT3 = 'c'.repeat(32), GROUP = 'd'.repeat(32), RUN = 'f'.repeat(32), MSG1 = '1'.repeat(32), MSG2 = '2'.repeat(32), MSG3 = '3'.repeat(32);

class Node {
  tagName: string; textContent = ''; className = ''; hidden = false; disabled = false; open = false; value = ''; checked = false;
  attributes: Record<string, string> = {}; children: Node[] = []; events: Record<string, ((e: any) => unknown)[]> = {};
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  append(...items: Node[]) { this.children.push(...items); }
  replaceChildren(...items: Node[]) { this.children = [...items]; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, fn: (e: any) => unknown) { (this.events[name] ??= []).push(fn); }
  async fire(name: string, event: any = {}) { for (const fn of this.events[name] ?? []) await fn({ target: this, ...event }); }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; void this.fire('close'); }
}
const all = (node: Node): Node[] => node.children.flatMap(child => [child, ...all(child)]);
const text = (node: Node): string => [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
const buttons = (root: Node) => all(root).filter(n => n.tagName === 'BUTTON');
const find = (root: Node, label: string) => buttons(root).find(n => n.textContent === label);
const inputs = (root: Node) => all(root).filter(n => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName));
const byPlaceholder = (root: Node, prefix: string) => inputs(root).find(n => (n.attributes.placeholder ?? '').startsWith(prefix))!;

interface Session { workspaceConfigured: boolean; authenticated: boolean; ownerAccess: boolean; csrf: string | null; user: { uid: string; role: string; status: string } | null }
const owner = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'csrf-owner', user: { uid: 'owner', role: 'owner', status: 'approved' } });
const member = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: false, csrf: 'csrf-member', user: { uid: 'member', role: 'member', status: 'approved' } });
const anonymous = (): Session => ({ workspaceConfigured: true, authenticated: false, ownerAccess: false, csrf: null, user: null });
/** Stands in for workspace.js: the cached session, ownerHeaders() (which in production re-reads /api/session) and invalidate(). */
function workspaceStub(session: Session | null, enabled = true) {
  const ws = {
    ready: Promise.resolve(enabled), enabled, session, sessionReads: 0,
    ownerHeaders: vi.fn(async () => { ws.sessionReads++; if (!ws.session?.ownerAccess) throw new Error('Primary owner admission required.'); return { 'x-echo-csrf': ws.session.csrf! }; }),
    invalidate: vi.fn(() => { ws.session = null; }),
  };
  return ws;
}
const bot = (over: Record<string, unknown> = {}) => ({
  bot_id: BOT, name: 'Release scout', agent: 'release-scout', mode: 'team', status: 'paused', schedule: { every_s: 900 }, instruction: 'Watch the queue.', plugins: ['git-status', 'changelog'],
  memory: { scope: 'bot:' + BOT }, lease: { scopes: ['echo.builds.recent'], max_uses: 50, ttl_s: 3600 }, daily_cost_cap_usd: 1, spent_today_usd: 0.12, inbox_depth: 2,
  last_run_at: '2026-11-04T10:00:00Z', last_error: 'provider qwen-local unavailable', created_at: '2026-11-04T09:00:00Z', ...over });
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const healthy = () => ({ configured: true, available: true, defaultBudget: { max_calls: 80, max_cost_usd: 0, max_wall_s: 1800 }, service: { service: 'echo-adk-api', version: '0.1.0', profile: 'ECHO_ADK', agents: 2, bots: 2, runsActive: 0, contract_version: 2, features: { calendar_schedules: true, idempotent_events: true, memory_recall: true }, budgets: { daily_cap_usd: 200, spent_today_usd: 1, reserved_usd: 2, available_usd: 197 }, connections: { memory: { provider: 'local', recall: true, durable: true, shared: false }, browser: { available: false, reason: 'No isolated browser provider is configured' } } } });

interface Opts { health?: unknown; healthStatus?: number; bots?: Record<string, unknown>[]; agents?: unknown; agentsStatus?: number; workspace?: ReturnType<typeof workspaceStub>; stored?: string | null;
  updateStatus?: number; stopStatus?: string;
  messages?: (poll: number, since: string | null) => unknown; group?: (poll: number) => unknown; agentsView?: { openRun?: ReturnType<typeof vi.fn>; open?: ReturnType<typeof vi.fn>; watch?: ReturnType<typeof vi.fn> } }
function boot(opts: Opts = {}) {
  const created: Node[] = [], nav = new Node('nav'), sidebar = new Node('aside'), body = new Node('body');
  const documentEvents: Record<string, ((e: any) => unknown)[]> = {}, windowEvents: Record<string, ((e: any) => unknown)[]> = {};
  const dispatched: { type: string; detail: any }[] = [];
  class CustomEvent { type: string; detail: any; constructor(type: string, init: { detail: any }) { this.type = type; this.detail = init.detail; } }
  const document: any = { hidden: false, body, querySelector: (s: string) => s === 'nav[aria-label="Workspace"]' ? nav : s === '#sidebar' ? sidebar : null,
    createElement: (tag: string) => { const n = new Node(tag); created.push(n); return n; }, addEventListener: (name: string, fn: (e: any) => unknown) => (documentEvents[name] ??= []).push(fn),
    dispatchEvent: (event: CustomEvent) => { dispatched.push({ type: event.type, detail: event.detail }); for (const fn of documentEvents[event.type] ?? []) void fn(event); return true; } };
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let bots = (opts.bots ?? [bot(), bot({ bot_id: BOT2, name: 'Docs bot', agent: 'docs', mode: 'personal', status: 'idle', schedule: null, plugins: [], spent_today_usd: 0, daily_cost_cap_usd: 0.5, inbox_depth: 0, last_run_at: undefined, last_error: null })]).map(b => ({ ...b }));
  let messagePolls = 0, groupPolls = 0;
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET', parsed = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body: parsed });
    if (url === '/api/prime/bots/health') return json(opts.healthStatus ?? 200, opts.health ?? healthy());
    if (url === '/api/prime/bots/list') return json(200, { bots });
    if (url === '/api/prime/adk/agents') return json(opts.agentsStatus ?? (opts.agents ? 200 : 405), opts.agents ?? { error: 'JSON POST required' });
    if (url === '/api/prime/bots/create') { const made = bot({ bot_id: BOT3, name: parsed.name, agent: parsed.agent, mode: parsed.mode ?? 'personal', status: 'paused', schedule: parsed.schedule ?? null, plugins: parsed.plugins ?? [], daily_cost_cap_usd: parsed.daily_cost_cap_usd, spent_today_usd: 0, inbox_depth: 0, last_run_at: undefined, last_error: null }); bots.push(made); return json(201, made); }
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})$/.exec(url))) return json(200, bots.find(b => b.bot_id === m![1]));
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/update$/.exec(url))) {
      if (opts.updateStatus) return json(opts.updateStatus, { error: 'Pause and stop pending work before editing' });
      const row = bots.find(b => b.bot_id === m![1])!; Object.assign(row, { ...parsed, ...(parsed.lease ? { lease: { ...row.lease, ...parsed.lease } } : {}) }); return json(200, row);
    }
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/stop$/.exec(url))) return json(200, { botId: m[1], status: opts.stopStatus ?? 'running', stopRequested: true, runIds: [RUN] });
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/(pause|resume|delete)$/.exec(url))) {
      const row = bots.find(b => b.bot_id === m![1]); if (!row) return json(404, { error: 'echoBots service answered HTTP 404: not_found' });
      if (m[2] === 'delete') { bots = bots.filter(b => b.bot_id !== m![1]); return json(200, { botId: m[1], deleted: true }); }
      row.status = m[2] === 'pause' ? 'paused' : 'idle'; return json(200, row);
    }
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/message$/.exec(url))) return json(202, { botId: m[1], messageId: MSG3, runId: RUN });
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/messages\?(.*)$/.exec(url))) {
      messagePolls++; const since = new URLSearchParams(m[2]).get('since');
      if (opts.messages) return json(200, { botId: m[1], messages: opts.messages(messagePolls, since) });
      const first = [{ message_id: MSG1, role: 'user', text: 'status?', created_at: '2026-11-04T10:00:00Z' }, { message_id: MSG2, role: 'bot', text: 'Two builds pending.', created_at: '2026-11-04T10:00:05Z', run_id: RUN }];
      return json(200, { botId: m[1], messages: since === null ? first : since === MSG2 && messagePolls === 2 ? [{ message_id: MSG3, role: 'bot', text: 'One build left.', created_at: '2026-11-04T10:00:09Z', run_id: RUN }] : [] });
    }
    if (url === '/api/prime/bots/groups/create') return json(202, { groupId: GROUP, runIds: [RUN, '9'.repeat(32)], name: parsed.name, bots: parsed.bots });
    if (url === `/api/prime/bots/groups/${GROUP}`) { groupPolls++; return json(200, opts.group ? opts.group(groupPolls) : { group_id: GROUP, status: 'done', messages: [], summary: 'done' }); }
    throw new Error('unexpected url ' + url);
  });
  const storage: Record<string, string> = opts.stored ? { 'echo-prime-bot-v1': opts.stored } : {};
  const localStorage = { getItem: vi.fn((k: string) => storage[k] ?? null), setItem: vi.fn((k: string, v: string) => { storage[k] = v; }), removeItem: vi.fn((k: string) => { delete storage[k]; }) };
  const window: Record<string, unknown> = { addEventListener: (name: string, fn: (e: any) => unknown) => (windowEvents[name] ??= []).push(fn), ...(opts.workspace ? { EchoPrimeWorkspace: opts.workspace } : {}), ...(opts.agentsView ? { EchoPrimeAgents: opts.agentsView } : {}) };
  const context = { window, document, CustomEvent, fetch, localStorage, setTimeout, clearTimeout, Date, AbortController, Error, Map, Set, Number, Math, String, Array, Object, Promise, JSON, encodeURIComponent, console: { debug: vi.fn(), log: console.log } };
  runInNewContext(source, context);
  const api = window.EchoPrimeBots as { ready: Promise<any>; refresh(): Promise<any>; open(): Promise<void>; close(): void; admission(): string; state(): any };
  const navButton = nav.children[0] ?? sidebar.children[0];
  const dialog = () => created.find(n => n.attributes.id === 'bots-dialog')!;
  const count = (url: string) => calls.filter(c => c.url === url).length;
  const fire = (name: string) => { for (const fn of windowEvents[name] ?? []) fn({ type: name }); };
  const documentFire = async (name: string, detail: any) => { for (const fn of documentEvents[name] ?? []) await fn({ type: name, detail }); };
  const orbEvents = () => dispatched.filter(e => e.type === 'echo-orb-satellites').map(e => e.detail);
  const visibility = () => { for (const fn of documentEvents.visibilitychange ?? []) fn({}); };
  const status = () => created.find(n => n.attributes.id === 'bots-status')!.textContent;
  const noteLine = () => created.find(n => n.attributes.id === 'bots-note')!.textContent;
  const cards = () => all(dialog()).filter(n => n.className.startsWith('bots-card ') || n.className === 'bots-card');
  const pane = () => created.find(n => n.attributes.id === 'bots-pane')!;
  /** What the stand-in service holds: tests replace it to model a bot changed or deleted somewhere else. */
  const serverBots = { get: () => bots, set: (next: typeof bots) => { bots = next; } };
  return { api, navButton, dialog, calls, count, fire, documentFire, orbEvents, visibility, status, noteLine, cards, pane, document, localStorage, ws: opts.workspace, messagePolls: () => messagePolls, groupPolls: () => groupPolls, created, serverBots };
}
const settle = async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0); };
async function opened(opts: Opts = {}) { const s = boot(opts); await s.api.ready; await s.api.open(); await settle(); return s; }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('echoBots nav entry and off state', () => {
  it('adds an echoBots entry to the workspace nav and, without a bots section, explains the config section and fetches no list', async () => {
    const s = await opened({ health: { configured: false, available: false, reason: 'echoBots is not enabled: the reviewed Prime configuration has no bots section' } });
    expect(s.navButton.textContent).toBe('echoBots'); expect(s.navButton.className).toBe('nav-item'); expect(s.navButton.hidden).toBe(false);
    expect(s.dialog().open).toBe(true);
    expect(s.status()).toMatch(/echoBots is off: the reviewed Prime configuration has no bots section\. Add "bots": \{"baseUrl": "http:\/\/127\.0\.0\.1:8378"\}.*loopback origin only.*defaultBudget.*restart Prime\. Nothing is fetched while it is off/);
    expect(s.count('/api/prime/bots/health')).toBe(2); expect(s.count('/api/prime/bots/list')).toBe(0); expect(s.calls.some(c => c.url.includes('/adk/'))).toBe(false);
    expect(s.cards()).toHaveLength(0);
    expect(text(s.dialog())).toContain('Bot controls and data scope');
  });
  it('shows a down service as unavailable with its reason and never substitutes anything', async () => {
    const s = await opened({ health: { configured: true, available: false, defaultBudget: { max_calls: 80, max_cost_usd: 0, max_wall_s: 1800 }, reason: 'echoBots service unreachable at http://127.0.0.1:8378' } });
    expect(s.status()).toMatch(/echoBots service unavailable: echoBots service unreachable at http:\/\/127\.0\.0\.1:8378\. Run status cannot be verified from this view/);
    expect(s.count('/api/prime/bots/list')).toBe(0);
  });
  it('reports capabilities and actual connections without claiming credential isolation or complete deletion', async () => {
    const s = await opened();
    const note = text(s.dialog());
    for (const expected of ['Calendar scheduling: available', 'idempotent events available', 'Memory: local recall, durable, scoped per bot', 'Browser: No isolated browser provider is configured', '$1.00 used · $2.00 reserved · $197.00 available · $200.00 cap', 'Bots start paused', 'memory scope bot:<id>', 'does not establish separate computers or isolated credentials', 'does not guarantee removal of run records or backups'])
      expect(note).toContain(expected);
    expect(note).not.toContain('nothing of it remains');
    expect(note).not.toContain('never holds a token');
  });
  it('labels service budget totals as a dated snapshot until health is refreshed', async () => {
    vi.setSystemTime(new Date('2026-11-07T23:59:50Z'));
    const health = healthy(); Object.assign(health.service.budgets, { day: '2026-11-07' });
    const s = await opened({ health });
    expect(text(s.dialog())).toContain('Service budget snapshot for 2026-11-07 (UTC)');
    expect(text(s.dialog())).toContain('Checked 2026-11-07 23:59:50 UTC. Refresh to update.');
    vi.setSystemTime(new Date('2026-11-08T00:01:00Z'));
    expect(text(s.dialog())).toContain('Checked 2026-11-07 23:59:50 UTC. Refresh to update.');
    Object.assign(health.service.budgets, { day: '2026-11-08' }); await find(s.dialog(), 'Refresh')!.fire('click'); await settle();
    expect(text(s.dialog())).toContain('Service budget snapshot for 2026-11-08 (UTC)');
    expect(text(s.dialog())).toContain('Checked 2026-11-08 00:01:00 UTC. Refresh to update.');
  });
});

describe('owner-only routes before sign-in (the 2026-11-04 401 request storm)', () => {
  it('anonymous visitor: the nav entry is hidden, nothing is fetched, the session is not re-read and account events change nothing', async () => {
    const s = boot({ workspace: workspaceStub(anonymous()), healthStatus: 401, health: { error: 'Sign in required' } });
    expect(await s.api.ready).toEqual({ configured: false, available: false, reason: 'Sign in to use echoBots.' });
    expect(s.navButton.hidden).toBe(true); expect(s.calls).toHaveLength(0); expect(s.ws!.sessionReads).toBe(0); expect(s.ws!.invalidate).not.toHaveBeenCalled();
    for (let i = 0; i < 25; i++) s.fire('echo-account-changed');
    await settle();
    expect(s.calls).toHaveLength(0); expect(s.ws!.sessionReads).toBe(0); expect(s.ws!.invalidate).not.toHaveBeenCalled();
    await s.api.open(); await settle();
    expect(s.calls).toHaveLength(0); expect(s.status()).toBe('Sign in to use echoBots.');
  });
  it('signed-in member: hidden entry, no fetch, owner-only explanation', async () => {
    const s = boot({ workspace: workspaceStub(member()), healthStatus: 403, health: { error: 'Primary owner admission required' } });
    expect(await s.api.ready).toEqual({ configured: false, available: false, reason: 'echoBots are available to the primary owner only.' });
    expect(s.navButton.hidden).toBe(true); expect(s.calls).toHaveLength(0); expect(s.ws!.invalidate).not.toHaveBeenCalled();
  });
  it('owner whose session expired: one fetch, exactly one invalidate, no retry, then the honest sign-in state', async () => {
    const s = boot({ workspace: workspaceStub(owner()), healthStatus: 401, health: { error: 'Sign in required' } });
    expect(await s.api.ready).toEqual({ configured: false, available: false, reason: 'echoBots status unavailable (Sign in required)' });
    expect(s.count('/api/prime/bots/health')).toBe(1); expect(s.ws!.invalidate).toHaveBeenCalledTimes(1); expect(s.ws!.session).toBeNull();
    s.fire('echo-account-changed'); await settle();
    expect(s.count('/api/prime/bots/health')).toBe(1); expect(s.navButton.hidden).toBe(true);
    expect(await s.api.refresh()).toEqual({ configured: false, available: false, reason: 'Sign in to use echoBots.' });
    expect(s.count('/api/prime/bots/health')).toBe(1);
  });
  it('cools down for 5 s after a failed health read even while account events keep firing, and a 405 from the Agents route invalidates nothing', async () => {
    const s = boot({ workspace: workspaceStub(owner()), healthStatus: 500, health: { error: 'boom' } });
    await s.api.ready; expect(s.count('/api/prime/bots/health')).toBe(1); expect(s.ws!.invalidate).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) { s.fire('echo-account-changed'); await settle(); }
    expect(s.count('/api/prime/bots/health')).toBe(1);
    await vi.advanceTimersByTimeAsync(5100); s.fire('echo-account-changed'); await settle(); expect(s.count('/api/prime/bots/health')).toBe(2);
    const healthyOwner = await opened({ workspace: workspaceStub(owner()) });
    expect(healthyOwner.count('/api/prime/adk/agents')).toBe(1); expect(healthyOwner.ws!.invalidate).not.toHaveBeenCalled();
  });
});

describe('bot cards', () => {
  it('requests stop once and does not label an in-flight provider step as stopped', async () => {
    const s = await opened({ bots: [bot({ status: 'running' })] }); await find(s.cards()[0], 'Stop')!.fire('click'); await settle();
    expect(s.calls.filter(c => c.url.endsWith('/stop'))).toEqual([{ url: `/api/prime/bots/${BOT}/stop`, method: 'POST', body: {} }]);
    expect(text(s.cards()[0])).toContain('running'); expect(s.noteLine()).toContain('Active provider steps may still be running');
  });
  it('uses the service ledger for reserved funds, converts next run timestamps to UTC, and opens reported run evidence', async () => {
    const agentsView = { openRun: vi.fn() };
    const s = await opened({ agentsView, bots: [bot({ status: 'idle', schedule: { at: '09:00', tz: 'America/Chicago', weekdays: [1, 5], missed: 'skip' }, next_run_at: '2026-11-09T09:00:00-06:00', last_run_id: RUN, budget: { daily_cap_usd: 1, spent_today_usd: 0.2, reserved_usd: 0.3, available_usd: 0.5, uncertain_charged_today_usd: 0.1 } })] });
    const shown = text(s.cards()[0]); expect(shown).toContain('$0.20 used · $0.30 reserved · $0.50 available of $1.00'); expect(shown).toContain('Next run 2026-11-09 15:00:00 UTC'); expect(shown).toContain('charged');
    const meter = all(s.cards()[0]).find(n => n.attributes.role === 'meter')!; expect(meter.attributes['aria-valuenow']).toBe('0.5'); expect(meter.children[0].attributes.style).toBe('width:20%'); expect(meter.children[1].attributes.style).toBe('width:30%');
    await buttons(s.cards()[0]).find(n => n.attributes['data-run-id'] === RUN)!.fire('click'); expect(agentsView.openRun).toHaveBeenCalledWith(RUN);
  });
  it('renders name, agent, mode, status badge, schedule, plugins, the spent/cap meter, inbox depth, last run and last error', async () => {
    const s = await opened();
    expect(s.cards()).toHaveLength(2);
    const shown = text(s.cards()[0]);
    for (const expected of ['Release scout', 'team', 'paused', 'Agent release-scout', 'Schedule every 15 min', 'Plugins git-status, changelog', '$0.12 used · not reported reserved · not reported available of $1.00 today (UTC)', 'Inbox 2 waiting', 'Next run paused', 'Last run 2026-11-04 10:00:00 UTC', 'Last error: provider qwen-local unavailable'])
      expect(shown).toContain(expected);
    const meter = all(s.cards()[0]).find(n => n.attributes.role === 'meter')!;
    expect(meter.attributes['aria-valuenow']).toBe('0.12'); expect(meter.attributes['aria-valuemax']).toBe('1'); expect(meter.children[0].attributes.style).toBe('width:12%');
    const second = text(s.cards()[1]);
    for (const expected of ['Docs bot', 'personal', 'idle', 'Schedule on message only', 'Plugins none', '$0.00 used · not reported reserved · not reported available of $0.50 today (UTC)', 'Inbox 0 waiting', 'Last run never']) expect(second).toContain(expected);
    expect(second).not.toContain('Last error');
    expect(find(s.cards()[0], 'Resume')).toBeTruthy(); expect(find(s.cards()[1], 'Pause')).toBeTruthy();
    expect(s.status()).toContain('echo-adk-api 0.1.0 · 2 bots · 2 agents · 0 active runs. Default daily cap $0.00.');
  });
  it('pauses and resumes through the Prime routes and shows the returned status', async () => {
    const s = await opened();
    await find(s.cards()[1], 'Pause')!.fire('click'); await settle();
    expect(s.calls.at(-1)).toEqual({ url: `/api/prime/bots/${BOT2}/pause`, method: 'POST', body: {} });
    expect(text(s.cards()[1])).toContain('paused'); expect(s.noteLine()).toBe('Paused Docs bot: status paused.');
    await find(s.cards()[1], 'Resume')!.fire('click'); await settle();
    expect(s.calls.at(-1)!.url).toBe(`/api/prime/bots/${BOT2}/resume`); expect(text(s.cards()[1])).toContain('idle');
  });
  it('deletes only after an inline two-step confirmation (no browser confirm dialog), and Cancel backs out', async () => {
    const s = await opened();
    expect(find(s.cards()[0], 'Confirm delete')).toBeUndefined();
    await find(s.cards()[0], 'Delete')!.fire('click'); await settle();
    expect(s.calls.some(c => c.url.endsWith('/delete'))).toBe(false);
    expect(find(s.cards()[0], 'Confirm delete')).toBeTruthy(); expect(find(s.cards()[0], 'Cancel')).toBeTruthy(); expect(s.cards()[0].className).toContain('bots-card-confirm');
    expect(s.noteLine()).toContain('Select Confirm delete on Release scout'); expect(text(s.cards()[0])).toContain('Run records and backups may remain');
    await find(s.cards()[0], 'Cancel')!.fire('click'); await settle();
    expect(find(s.cards()[0], 'Confirm delete')).toBeUndefined(); expect(s.calls.some(c => c.url.endsWith('/delete'))).toBe(false);
    await find(s.cards()[0], 'Delete')!.fire('click'); await settle();
    await find(s.cards()[0], 'Confirm delete')!.fire('click'); await settle();
    expect(s.calls.at(-1)).toEqual({ url: `/api/prime/bots/${BOT}/delete`, method: 'POST', body: {} });
    expect(s.cards()).toHaveLength(1); expect(text(s.cards()[0])).toContain('Docs bot'); expect(s.noteLine()).toBe('Deleted Release scout (confirmed by the service).');
  });
});

describe('create form', () => {
  it('loads a fresh paused bot for editing and sends only changed values, including explicit clearing and scope revocation', async () => {
    const s = await opened({ bots: [bot({ inbox_depth: 0 })] }); await find(s.cards()[0], 'Edit')!.fire('click'); await settle();
    const form = s.pane(); expect(text(form)).toContain('Saving leaves the bot paused');
    expect(inputs(form).find(n => n.attributes['aria-label'] === 'Agent (cannot change)')!.disabled).toBe(true);
    await find(form, 'Save bot changes')!.fire('click'); expect(s.noteLine()).toBe('No changes to save.');
    byPlaceholder(form, 'Bot name').value = 'Updated scout'; byPlaceholder(form, 'Standing instruction').value = ''; byPlaceholder(form, 'Skill names').value = ''; byPlaceholder(form, 'Exact capability ids').value = '';
    const scheduled = inputs(form).find(n => n.attributes.type === 'checkbox')!; scheduled.checked = false; await scheduled.fire('change');
    await find(form, 'Save bot changes')!.fire('click'); await settle();
    expect(s.calls.filter(c => c.url.endsWith('/update'))).toEqual([{ url: `/api/prime/bots/${BOT}/update`, method: 'POST', body: { name: 'Updated scout', schedule: null, instruction: null, plugins: [], lease: { scopes: [] } } }]);
    expect(s.calls.some(c => c.url.endsWith('/resume'))).toBe(false); expect(s.noteLine()).toContain('Updated Updated scout: status paused');
  });
  it('requires pause and an empty inbox, keeps an editing draft on a backend conflict, and never stops work automatically', async () => {
    const active = await opened({ bots: [bot({ status: 'running' })] }); await find(active.cards()[0], 'Edit')!.fire('click'); await settle();
    expect(active.noteLine()).toContain('Pause the bot and stop pending work'); expect(find(active.pane(), 'Save bot changes')).toBeUndefined(); expect(active.calls.some(c => c.url.endsWith('/stop'))).toBe(false);
    const s = await opened({ bots: [bot({ inbox_depth: 0, schedule: { every_s: 90, missed: 'skip' } })], updateStatus: 409 }); await find(s.cards()[0], 'Edit')!.fire('click'); await settle();
    const form = s.pane(); byPlaceholder(form, 'Bot name').value = 'Draft survives'; await find(form, 'Save bot changes')!.fire('click'); await settle();
    expect(s.calls.find(c => c.url.endsWith('/update'))?.body).toEqual({ name: 'Draft survives' }); expect(byPlaceholder(s.pane(), 'Bot name').value).toBe('Draft survives');
    expect(s.noteLine()).toContain('Bot not updated'); expect(s.calls.filter(c => c.url.endsWith('/update'))).toHaveLength(1);
    await find(s.pane(), 'Cancel edit')!.fire('click'); expect(s.api.state().pane).toBe('chat');
  });
  it('closes the editor when a refreshed list confirms that the bot was removed elsewhere', async () => {
    const s = await opened({ bots: [bot({ inbox_depth: 0 })] }); await find(s.cards()[0], 'Edit')!.fire('click'); await settle();
    byPlaceholder(s.pane(), 'Bot name').value = 'Unsaved draft';
    s.serverBots.set([]); await find(s.dialog(), 'Refresh')!.fire('click'); await settle();
    expect(s.api.state().selected).toBeNull(); expect(s.api.state().pane).toBe('none');
    expect(find(s.pane(), 'Save bot changes')).toBeUndefined(); expect(s.calls.some(c => c.url.endsWith('/update'))).toBe(false);
  });
  it('creates a calendar schedule with explicit timezone, selected ISO weekdays and missed-run policy', async () => {
    const s = await opened(); await find(s.dialog(), 'New bot')!.fire('click'); await settle();
    const form = s.pane(); byPlaceholder(form, 'Bot name').value = 'Morning scout'; byPlaceholder(form, 'Echo ADK agent name').value = 'scout';
    const scheduled = inputs(form).find(n => n.attributes.type === 'checkbox')!; scheduled.checked = true; await scheduled.fire('change');
    const type = inputs(form).find(n => n.attributes['aria-label'] === 'Schedule type')!; expect(type.children[1].disabled).toBe(false); type.value = 'calendar'; await type.fire('change');
    const at = inputs(form).find(n => n.attributes['aria-label'] === 'Local run time')!, zone = byPlaceholder(form, 'Timezone');
    expect(at.disabled).toBe(false); at.value = '08:30'; zone.value = 'America/Chicago';
    const missed = inputs(form).find(n => n.attributes['aria-label'] === 'Missed run policy')!; missed.value = 'once';
    inputs(form).find(n => n.attributes['aria-label'] === 'Tue')!.checked = false;
    await find(form, 'Create bot (starts paused)')!.fire('click'); await settle();
    expect(s.calls.find(c => c.url.endsWith('/create'))?.body).toEqual({ name: 'Morning scout', agent: 'scout', mode: 'personal', schedule: { at: '08:30', tz: 'America/Chicago', weekdays: [1, 3, 4, 5], missed: 'once' }, daily_cost_cap_usd: 0 });
    expect(text(s.cards()[2])).toContain('08:30 America/Chicago · Mon, Wed, Thu, Fri · catch up once');
  });
  it('rejects invalid timezones and empty weekdays without submitting, and disables unreported calendar support', async () => {
    const s = await opened(); await find(s.dialog(), 'New bot')!.fire('click'); await settle();
    const form = s.pane(); byPlaceholder(form, 'Bot name').value = 'Morning'; byPlaceholder(form, 'Echo ADK agent name').value = 'scout';
    const scheduled = inputs(form).find(n => n.attributes.type === 'checkbox')!; scheduled.checked = true; await scheduled.fire('change');
    const type = inputs(form).find(n => n.attributes['aria-label'] === 'Schedule type')!; type.value = 'calendar'; await type.fire('change');
    byPlaceholder(form, 'Timezone').value = 'Not/AZone'; await find(form, 'Create bot (starts paused)')!.fire('click');
    expect(s.noteLine()).toContain('valid IANA timezone');
    byPlaceholder(form, 'Timezone').value = 'UTC'; for (const day of inputs(form).filter(n => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(n.attributes['aria-label']))) day.checked = false;
    await find(form, 'Create bot (starts paused)')!.fire('click'); expect(s.noteLine()).toBe('Choose at least one weekday.');
    expect(s.calls.some(c => c.url.endsWith('/create'))).toBe(false);
    const missing = healthy(); missing.service.features.calendar_schedules = false;
    const legacy = await opened({ health: missing }); await find(legacy.dialog(), 'New bot')!.fire('click'); await settle();
    expect(inputs(legacy.pane()).find(n => n.attributes['aria-label'] === 'Schedule type')!.children[1].disabled).toBe(true);
    expect(text(legacy.pane())).toContain('Calendar scheduling is not reported');
  });
  it('uses a free-text agent field when the Agents route does not answer, states that bots start paused, posts the exact body and shows the new paused bot', async () => {
    const s = await opened();
    await find(s.dialog(), 'New bot')!.fire('click'); await settle();
    const form = s.pane();
    expect(text(form)).toContain('Bots start paused. Resume one from its card when you are ready');
    const agent = byPlaceholder(form, 'Echo ADK agent name'); expect(agent.tagName).toBe('INPUT');
    byPlaceholder(form, 'Bot name').value = ' Night watch '; agent.value = 'watcher';
    const scheduled = inputs(form).find(n => n.attributes.type === 'checkbox')!; scheduled.checked = true; await scheduled.fire('change');
    const minutes = inputs(form).find(n => n.attributes.type === 'number' && n.attributes.min === '1' && n.value === '15')!; expect(minutes.disabled).toBe(false); minutes.value = '30';
    byPlaceholder(form, 'Skill names').value = 'git-status, changelog';
    const cap = inputs(form).find(n => n.attributes.max === '5')!; expect(cap.value).toBe('0'); cap.value = '1.5';
    await find(form, 'Create bot (starts paused)')!.fire('click'); await settle();
    const created = s.calls.find(c => c.url === '/api/prime/bots/create')!;
    expect(created.body).toEqual({ name: 'Night watch', agent: 'watcher', mode: 'personal', schedule: { every_s: 1800 }, plugins: ['git-status', 'changelog'], daily_cost_cap_usd: 1.5 });
    expect(s.cards()).toHaveLength(3); expect(text(s.cards()[2])).toContain('Night watch'); expect(text(s.cards()[2])).toContain('paused');
    expect(s.noteLine()).toBe('Created Night watch: status paused (resume it from its card when ready).');
    expect(s.api.state()).toMatchObject({ selected: BOT3, pane: 'chat', polling: true });
  });
  it('offers the Agents list when /api/prime/adk/agents answers, and refuses an over-cap or unnamed bot before any request', async () => {
    const s = await opened({ agents: { agents: [{ name: 'release-scout', role: 'Watches releases' }, { name: 'docs', role: 'Keeps docs current' }] } });
    await find(s.dialog(), 'New bot')!.fire('click'); await settle();
    const select = inputs(s.pane()).find(n => n.tagName === 'SELECT' && n.children.length === 2)!;
    expect(select.children.map(o => o.textContent)).toEqual(['release-scout · Watches releases', 'docs · Keeps docs current']); expect(select.children[1].value).toBe('docs');
    const before = s.calls.length;
    await find(s.pane(), 'Create bot (starts paused)')!.fire('click'); await settle();
    expect(s.noteLine()).toBe('Give the bot a name of 1 to 64 characters.');
    byPlaceholder(s.pane(), 'Bot name').value = 'x'; select.value = 'docs';
    inputs(s.pane()).find(n => n.attributes.max === '5')!.value = '7';
    await find(s.pane(), 'Create bot (starts paused)')!.fire('click'); await settle();
    expect(s.noteLine()).toBe('The daily cost cap must be between $0 and $5.'); expect(s.calls.length).toBe(before);
  });
});

describe('bot chat', () => {
  it('polls the transcript every 3 s with since=<last id>, links each reply to its run id and pauses while the tab is hidden', async () => {
    const s = await opened();
    await find(s.cards()[0], 'Open chat')!.fire('click'); await settle();
    expect(s.messagePolls()).toBe(1); expect(s.calls.at(-1)!.url).toBe(`/api/prime/bots/${BOT}/messages?limit=200`);
    expect(s.localStorage.setItem).toHaveBeenCalledWith('echo-prime-bot-v1', BOT);
    let shown = text(s.pane());
    expect(shown).toContain('You status?'); expect(shown).toContain('Release scout Two builds pending.'); expect(shown).toContain('This bot is paused: your messages queue');
    const run = all(s.pane()).find(n => n.attributes['data-run-id'] === RUN)!;
    expect(run.textContent).toBe('run ffffffff…'); expect(run.attributes.title).toBe('Run ' + RUN);
    await vi.advanceTimersByTimeAsync(2900); expect(s.messagePolls()).toBe(1);
    await vi.advanceTimersByTimeAsync(200); expect(s.messagePolls()).toBe(2);
    expect(s.calls.at(-1)!.url).toBe(`/api/prime/bots/${BOT}/messages?since=${MSG2}&limit=200`);
    shown = text(s.pane()); expect(shown).toContain('One build left.'); expect(shown).toContain('Polling every 3 s');
    s.document.hidden = true; s.visibility();
    await vi.advanceTimersByTimeAsync(15000); expect(s.messagePolls()).toBe(2);
    expect(text(s.pane())).toContain('polling paused while this tab is hidden');
    s.document.hidden = false; s.visibility(); await settle(); expect(s.messagePolls()).toBe(3);
    expect(s.calls.at(-1)!.url).toBe(`/api/prime/bots/${BOT}/messages?since=${MSG3}&limit=200`);
    await run.fire('click'); expect(s.noteLine()).toBe('Run ' + RUN + '. Open it in the Agents view once that view is installed.');
    s.api.close(); const n = s.messagePolls(); await vi.advanceTimersByTimeAsync(10000); expect(s.messagePolls()).toBe(n); expect(s.api.state().polling).toBe(false);
  });
  it('sends a message as a 202 run, clears the box and hands a run id to the Agents view when one is installed', async () => {
    const open = vi.fn(async () => undefined), watch = vi.fn();
    const s = await opened({ agentsView: { open, watch } });
    await find(s.cards()[1], 'Open chat')!.fire('click'); await settle();
    const box = inputs(s.pane()).find(n => n.tagName === 'TEXTAREA')!;
    await find(s.pane(), 'Send')!.fire('click'); await settle();
    expect(s.noteLine()).toBe('Type a message first.'); expect(s.calls.some(c => c.url.endsWith('/message'))).toBe(false);
    box.value = 'What is left?';
    await find(s.pane(), 'Send')!.fire('click'); await settle();
    expect(s.calls.find(c => c.url.endsWith('/message'))).toEqual({ url: `/api/prime/bots/${BOT2}/message`, method: 'POST', body: { text: 'What is left?' } });
    expect(box.value).toBe(''); expect(s.noteLine()).toBe('Queued for Docs bot as run ffffffff….');
    await all(s.pane()).find(n => n.attributes['data-run-id'] === RUN)!.fire('click');
    expect(open).toHaveBeenCalledOnce(); expect(watch).toHaveBeenCalledWith(RUN); expect(open.mock.invocationCallOrder[0]).toBeLessThan(watch.mock.invocationCallOrder[0]);
  });
  it('reopens on the remembered bot and keeps the chat draft when the card status changes', async () => {
    const s = await opened({ stored: BOT2 });
    expect(s.api.state()).toMatchObject({ selected: BOT2, pane: 'chat', polling: true });
    const box = inputs(s.pane()).find(n => n.tagName === 'TEXTAREA')!; box.value = 'draft text';
    await find(s.cards()[1], 'Pause')!.fire('click'); await settle();
    const rebuilt = inputs(s.pane()).find(n => n.tagName === 'TEXTAREA')!;
    expect(rebuilt).not.toBe(box); expect(rebuilt.value).toBe('draft text'); // the status change rebuilt the pane and carried the draft over
    await find(s.dialog(), 'Refresh')!.fire('click'); await settle();
    expect(s.count('/api/prime/bots/list')).toBe(2);
    expect(inputs(s.pane()).find(n => n.tagName === 'TEXTAREA')).toBe(rebuilt); // a plain list refresh leaves the pane (and the draft) alone
  });
});

describe('group chat', () => {
  it('refuses fewer than 2 bots client-side, posts 2..6 bots with the prompt, shows the shared transcript while running, then the summary', async () => {
    const s = await opened({ group: n => n < 2 ? { group_id: GROUP, name: 'Standup', bots: [BOT, BOT2], status: 'running', messages: [{ bot_id: BOT, text: 'Release looks clear.', created_at: '2026-11-04T10:01:00Z' }] }
      : { group_id: GROUP, name: 'Standup', bots: [BOT, BOT2], status: 'done', messages: [{ bot_id: BOT, text: 'Release looks clear.', created_at: '2026-11-04T10:01:00Z' }, { bot_id: BOT2, text: 'Docs lag by one PR.', created_at: '2026-11-04T10:01:04Z' }], summary: 'Ship; docs follow.' } });
    await find(s.dialog(), 'Group chat')!.fire('click'); await settle();
    const picks = inputs(s.pane()).filter(n => n.attributes.type === 'checkbox'); expect(picks).toHaveLength(2);
    byPlaceholder(s.pane(), 'Group name').value = 'Standup'; byPlaceholder(s.pane(), 'Prompt for the group').value = 'Status?';
    picks[0].checked = true;
    await find(s.pane(), 'Start group chat')!.fire('click'); await settle();
    expect(s.noteLine()).toBe('Pick between 2 and 6 bots (1 selected).'); expect(s.calls.some(c => c.url.endsWith('/groups/create'))).toBe(false);
    picks[1].checked = true;
    await find(s.pane(), 'Start group chat')!.fire('click'); await settle();
    expect(s.calls.find(c => c.url.endsWith('/groups/create'))).toEqual({ url: '/api/prime/bots/groups/create', method: 'POST', body: { name: 'Standup', bots: [BOT, BOT2], prompt: 'Status?' } });
    expect(s.groupPolls()).toBe(1);
    let shown = text(s.pane());
    expect(shown).toContain('Standup · still running (running)'); expect(shown).toContain('the group is still running'); expect(shown).toContain('Release scout Release looks clear.'); expect(find(s.pane(), 'Stop watching')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(3100); expect(s.groupPolls()).toBe(2);
    shown = text(s.pane());
    expect(shown).toContain('Standup · finished (done)'); expect(shown).toContain('Docs bot Docs lag by one PR.'); expect(shown).toContain('Summary Ship; docs follow.'); expect(shown).toContain('Polling stopped: the group is finished.');
    expect(find(s.pane(), 'Stop watching')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10000); expect(s.groupPolls()).toBe(2);
    expect(s.api.state().group).toEqual({ groupId: GROUP, done: true });
  });
  it('Stop watching stops the poll and says the group may still be running', async () => {
    const s = await opened({ group: () => ({ group_id: GROUP, status: 'running', messages: [] }) });
    await find(s.dialog(), 'Group chat')!.fire('click'); await settle();
    for (const box of inputs(s.pane()).filter(n => n.attributes.type === 'checkbox')) box.checked = true;
    byPlaceholder(s.pane(), 'Group name').value = 'g'; byPlaceholder(s.pane(), 'Prompt for the group').value = 'p';
    await find(s.pane(), 'Start group chat')!.fire('click'); await settle();
    expect(s.groupPolls()).toBe(1);
    await find(s.pane(), 'Stop watching')!.fire('click'); await settle();
    await vi.advanceTimersByTimeAsync(10000); expect(s.groupPolls()).toBe(1);
    const shown = text(s.pane());
    expect(shown).toContain('no longer watched (it may still be running)'); expect(shown).toContain('Polling stopped by you; the runs may continue up to their caps.');
  });
});

describe('living orb satellites', () => {
  it('publishes owner bots with their identity, display fields and status after loading the list', async () => {
    const s = await opened();
    expect(s.orbEvents().at(-1)).toEqual({ source: 'bots', satellites: [
      { id: `bot:${BOT}`, kind: 'bot', name: 'Release scout', status: 'paused', busy: false, group: undefined },
      { id: `bot:${BOT2}`, kind: 'bot', name: 'Docs bot', status: 'idle', busy: false, group: undefined },
    ] });
  });
  it('marks running bots busy while paused bots remain quiet', async () => {
    const s = await opened({ bots: [bot({ status: 'running' }), bot({ bot_id: BOT2, name: 'Paused bot', status: 'paused' })] });
    expect(s.orbEvents().at(-1).satellites.map((moon: any) => ({ id: moon.id, busy: moon.busy }))).toEqual([
      { id: `bot:${BOT}`, busy: true }, { id: `bot:${BOT2}`, busy: false },
    ]);
  });
  it('groups live participants as busy and removes their group when the group finishes', async () => {
    const s = await opened({ group: n => n === 1 ? { group_id: GROUP, status: 'running', messages: [] } : { group_id: GROUP, status: 'done', messages: [], summary: 'done' } });
    await find(s.dialog(), 'Group chat')!.fire('click'); await settle();
    for (const box of inputs(s.pane()).filter(n => n.attributes.type === 'checkbox')) box.checked = true;
    byPlaceholder(s.pane(), 'Group name').value = 'Orb group'; byPlaceholder(s.pane(), 'Prompt for the group').value = 'Work together';
    await find(s.pane(), 'Start group chat')!.fire('click'); await settle();
    expect(s.orbEvents().at(-1).satellites.every((moon: any) => moon.busy && moon.group === GROUP)).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    expect(s.orbEvents().at(-1).satellites.every((moon: any) => moon.group === undefined)).toBe(true);
  });
  it('republishes pause, resume and delete results, removing the deleted moon', async () => {
    const s = await opened(); const before = s.orbEvents().length;
    await find(s.cards()[1], 'Pause')!.fire('click'); await settle();
    expect(s.orbEvents().at(-1).satellites.find((moon: any) => moon.id === `bot:${BOT2}`).status).toBe('paused');
    await find(s.cards()[1], 'Resume')!.fire('click'); await settle();
    expect(s.orbEvents().at(-1).satellites.find((moon: any) => moon.id === `bot:${BOT2}`).status).toBe('idle');
    await find(s.cards()[0], 'Delete')!.fire('click'); await find(s.cards()[0], 'Confirm delete')!.fire('click'); await settle();
    expect(s.orbEvents().length).toBe(before + 3); expect(s.orbEvents().at(-1).satellites.map((moon: any) => moon.id)).toEqual([`bot:${BOT2}`]);
  });
  it('publishes the new bot with the rest of the list right after a create', async () => {
    const s = await opened();
    await find(s.dialog(), 'New bot')!.fire('click'); await settle();
    byPlaceholder(s.pane(), 'Bot name').value = 'Night watch'; byPlaceholder(s.pane(), 'Echo ADK agent name').value = 'watcher';
    await find(s.pane(), 'Create bot (starts paused)')!.fire('click'); await settle();
    expect(s.calls.some(c => c.url === '/api/prime/bots/create')).toBe(true);
    expect(s.orbEvents().at(-1)).toEqual({ source: 'bots', satellites: [
      { id: `bot:${BOT}`, kind: 'bot', name: 'Release scout', status: 'paused', busy: false, group: undefined },
      { id: `bot:${BOT2}`, kind: 'bot', name: 'Docs bot', status: 'idle', busy: false, group: undefined },
      { id: `bot:${BOT3}`, kind: 'bot', name: 'Night watch', status: 'paused', busy: false, group: undefined },
    ] });
  });
  it('republishes what the Refresh button reads, so a bot changed or deleted elsewhere updates the orb', async () => {
    const s = await opened();
    s.serverBots.set([{ ...s.serverBots.get()[0], status: 'running' }]); // BOT2 was deleted elsewhere; BOT is running now
    await find(s.dialog(), 'Refresh')!.fire('click'); await settle();
    expect(s.count('/api/prime/bots/list')).toBe(2);
    expect(s.orbEvents().at(-1)).toEqual({ source: 'bots', satellites: [{ id: `bot:${BOT}`, kind: 'bot', name: 'Release scout', status: 'running', busy: true, group: undefined }] });
  });
  it('republishes on the 30 s list refresh while the view is open; the moons stay, unpolled, after it closes', async () => {
    const s = await opened(); const before = s.orbEvents().length;
    s.serverBots.set(s.serverBots.get().map(b => ({ ...b, status: 'error' })));
    await vi.advanceTimersByTimeAsync(29000); expect(s.orbEvents().length).toBe(before);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.count('/api/prime/bots/list')).toBe(2); expect(s.orbEvents().length).toBe(before + 1);
    expect(s.orbEvents().at(-1).satellites.map((moon: any) => moon.status)).toEqual(['error', 'error']);
    s.api.close(); const after = s.orbEvents().length;
    await vi.advanceTimersByTimeAsync(65000); expect(s.count('/api/prime/bots/list')).toBe(2); expect(s.orbEvents().length).toBe(after);
  });
  it('sends running bots first, so one listed past the 24th still orbits; the rest keep list order', async () => {
    const hex = (i: number) => i.toString(16).padStart(32, '0');
    const s = await opened({ bots: Array.from({ length: 30 }, (_, i) => bot({ bot_id: hex(i + 1), name: 'Bot ' + i, status: i === 27 ? 'running' : 'paused' })) });
    const moons = s.orbEvents().at(-1).satellites;
    expect(moons).toHaveLength(24); expect(moons[0]).toMatchObject({ id: `bot:${hex(28)}`, status: 'running', busy: true });
    expect(moons.slice(1).map((moon: any) => moon.id)).toEqual(Array.from({ length: 23 }, (_, i) => `bot:${hex(i + 1)}`));
  });
  it('publishes nothing new when an action fails', async () => {
    const s = await opened(); s.serverBots.set([]); const before = s.orbEvents().length;
    await find(s.cards()[1], 'Pause')!.fire('click'); await settle();
    expect(s.noteLine()).toContain('Pause failed for Docs bot'); expect(s.orbEvents().length).toBe(before);
  });
  it('clears bot satellites on account changes', async () => {
    const s = await opened(); s.fire('echo-account-changed'); await settle();
    expect(s.orbEvents().at(-1)).toEqual({ source: 'bots', satellites: [] });
  });
  it.each([['signed out', anonymous()], ['member', member()]])('%s sessions fetch nothing and only publish empty lists', async (_label, session) => {
    const s = boot({ workspace: workspaceStub(session) }); await s.api.ready; s.fire('echo-account-changed'); await settle();
    expect(s.calls).toHaveLength(0); expect(s.orbEvents().length).toBeGreaterThan(0); expect(s.orbEvents().every((event: any) => event.source === 'bots' && event.satellites.length === 0)).toBe(true);
  });
  it('opens and selects a valid bot moon while ignoring other kinds and malformed ids', async () => {
    const s = boot({ workspace: workspaceStub(owner()) }); await s.api.ready;
    await s.documentFire('echo-orb-open', { id: `bot:${BOT2}`, kind: 'agent' });
    await s.documentFire('echo-orb-open', { id: 'bot:not-an-id', kind: 'bot' });
    expect(s.dialog()).toBeUndefined();
    await s.documentFire('echo-orb-open', { id: `bot:${BOT2}`, kind: 'bot' }); await settle();
    expect(s.dialog().open).toBe(true); expect(s.api.state()).toMatchObject({ selected: BOT2, pane: 'chat' });
  });
});
