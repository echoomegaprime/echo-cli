import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../ui/echo-prime/agents.js', import.meta.url), 'utf8');
const RUN = 'c'.repeat(32);

interface El {
  tag: string; textContent: string; className: string; hidden: boolean; disabled: boolean; open: boolean; value: string; children: El[];
  append(...n: El[]): void; replaceChildren(...n: El[]): void; setAttribute: ReturnType<typeof vi.fn>; showModal(): void; close(): void;
  addEventListener(name: string, fn: (e?: unknown) => void): void; fire(name: string, event?: unknown): unknown[];
}
function element(tag = 'div'): El {
  const handlers: Record<string, ((e?: unknown) => void)[]> = {};
  const el: El = {
    tag, textContent: '', className: '', hidden: false, disabled: false, open: false, value: '', children: [],
    append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; },
    setAttribute: vi.fn(), showModal() { this.open = true; }, close() { this.open = false; this.fire('close'); },
    addEventListener(name, fn) { (handlers[name] ??= []).push(fn); },
    // A real browser never dispatches a click on a disabled control; the fake must not either, or a dead button passes.
    fire(name, event) { if (name === 'click' && el.disabled) return []; return (handlers[name] ?? []).map(fn => fn(event ?? { target: el, preventDefault() { /* noop */ } })); },
  };
  return el;
}
const flat = (e: El): El[] => [e, ...e.children.flatMap(flat)];
const text = (e: El): string => flat(e).map(x => x.textContent).join(' | ');
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

const AGENTS = [
  { name: 'researcher', role: 'Finds and verifies facts', skills: ['search', 'summarize'], capabilities: ['echo.knowledge.search'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 60, max_cost_usd: 0, max_wall_s: 1200 } }, max_steps: 12, instruction: 'Verify before claiming.', source: 'agents/researcher.yaml' },
  { name: 'builder', role: 'Ships code', skills: ['edit'], capabilities: ['echo.fs.write'], lane: { node: 'anvil', model: 'claude-cli', budget: { max_calls: 20, max_cost_usd: 2, max_wall_s: 600 } }, max_steps: 8, source: 'agents/builder.yaml' }];
const HEALTH = { configured: true, available: true, defaultBudget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 }, service: { service: 'echo-adk-api', profile: 'ECHO_ADK', version: '0.1.0', agents: 2, bots: 0, runsActive: 1 } };
const envelope = (step: number, kind: string, over: Record<string, unknown> = {}) => ({ envelope_version: 1, run_id: RUN, step, kind, verdict: 'allowed', ok: true, untrusted: true, redacted: 0, duration_ms: 120, data: {}, ...over });
const running = (steps: unknown[] = [], over: Record<string, unknown> = {}) => ({ runId: RUN, agent: 'researcher', status: 'running', done: false, steps, budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 }, spent: { calls: steps.length, cost_usd: 0, wall_s: 3 }, ...over });
const finished = () => ({ runId: RUN, agent: 'researcher', status: 'done', done: true, startedAt: '2026-11-04T19:00:00Z', finishedAt: '2026-11-04T19:00:09Z',
  steps: [envelope(1, 'cap', { capability: 'echo.knowledge.search', tier: 0, audit_id: 'aud-1' }), envelope(2, 'model', { data: { answered: { provider: 'forge-qwen', requested: 'qwen-local', model: 'qwen3.5-27b', reported: true } } }), envelope(3, 'final', { data: { text: 'Verified: the port is 8378.' } })],
  proof: { run_id: RUN, lease_id: 'l'.repeat(32), events_sha256: 'e'.repeat(64), actions: [{ cap: 'echo.knowledge.search', tier: 0, verdict: 'allowed', audit_id: 'aud-1' }], artifacts: [], receipts: [{ kind: 'audit', id: 'aud-1' }], verdict: 'PASS' },
  budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 }, spent: { calls: 2, cost_usd: 0, wall_s: 9 } });

interface Session { workspaceConfigured: boolean; authenticated: boolean; ownerAccess: boolean; csrf: string | null; user: { uid: string; role: string; status: string } | null }
const owner = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'csrf-owner', user: { uid: 'owner', role: 'owner', status: 'approved' } });
const member = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: false, csrf: 'csrf-member', user: { uid: 'member', role: 'member', status: 'approved' } });
const anonymous = (): Session => ({ workspaceConfigured: true, authenticated: false, ownerAccess: false, csrf: null, user: null });
/** Stands in for workspace.js on a host with an authenticated Workspace: the cached session, ownerHeaders() and invalidate(). */
function workspaceStub(session: Session | null, enabled = true) {
  const ws = {
    ready: Promise.resolve(enabled), enabled, session, sessionReads: 0,
    ownerHeaders: vi.fn(async () => { ws.sessionReads++; if (!ws.session?.ownerAccess) throw new Error('Primary owner admission required.'); return { 'x-echo-csrf': ws.session.csrf! }; }),
    invalidate: vi.fn(() => { ws.session = null; }),
  };
  return ws;
}
interface Opts { health?: unknown; healthStatus?: number; agents?: unknown; run?: () => unknown; runStatus?: number; poll?: (n: number) => { status?: number; body: unknown }; runs?: unknown; stop?: () => { status?: number; body: unknown }; workspace?: ReturnType<typeof workspaceStub>; stored?: string | null }
const IDS = ['agents-dialog', 'open-agents', 'close-agents', 'refresh-agents', 'agents-status', 'agents-list', 'agents-form', 'agents-agent', 'agents-prompt', 'agents-calls', 'agents-cost', 'agents-wall', 'agents-submit', 'agents-run', 'agents-runs'];
async function setup(opts: Opts = {}) {
  const nodes: Record<string, El> = Object.fromEntries(IDS.map(id => [id, element(id === 'agents-dialog' ? 'dialog' : id === 'agents-form' ? 'form' : id === 'agents-agent' ? 'select' : 'div')]));
  const visibility: (() => void)[] = [];
  // The living orb's side of the page: agents.js dispatches echo-orb-state / echo-orb-satellites on document (recorded
  // here in order) and listens there for echo-orb-open (which fireDoc delivers).
  const orbEvents: { type: string; detail: Record<string, unknown> }[] = [], docHandlers = new Map<string, ((e?: unknown) => void)[]>();
  const doc = {
    hidden: false, querySelector: (s: string) => nodes[s.slice(1)] ?? null, createElement: (t: string) => element(t),
    addEventListener: vi.fn((name: string, fn: (e?: unknown) => void) => { if (name === 'visibilitychange') visibility.push(fn as () => void); (docHandlers.get(name) ?? docHandlers.set(name, []).get(name)!).push(fn); }),
    dispatchEvent: (e: CustomEvent) => { orbEvents.push({ type: e.type, detail: e.detail }); return true; },
  };
  const fireDoc = (name: string, detail: unknown) => { for (const fn of docHandlers.get(name) ?? []) fn(new CustomEvent(name, { detail })); };
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let polls = 0;
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/prime/adk/health') return json(opts.healthStatus ?? 200, opts.health ?? HEALTH);
    if (url === '/api/prime/adk/agents') return json(200, { agents: opts.agents ?? AGENTS });
    if (url === '/api/prime/adk/runs?limit=20') return json(200, { runs: opts.runs ?? [{ runId: 'd'.repeat(32), agent: 'builder', status: 'done', startedAt: '2026-11-04T18:00:00Z' }] });
    if (url === '/api/prime/adk/runs' && method === 'POST') return json(opts.runStatus ?? 202, opts.run ? opts.run() : { runId: RUN, agent: body.agent, status: 'queued', budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 } });
    if (url === `/api/prime/adk/runs/${RUN}` && method === 'GET') { polls++; const r = opts.poll ? opts.poll(polls) : { body: running() }; return json(r.status ?? 200, r.body); }
    if (url === `/api/prime/adk/runs/${RUN}/stop` && method === 'POST') { const r = opts.stop ? opts.stop() : { body: { runId: RUN, status: 'running' } }; return json(r.status ?? 200, r.body); }
    throw new Error('unexpected url ' + method + ' ' + url);
  });
  const store = new Map<string, string>(); if (opts.stored) store.set('echo-prime-adk-v1', opts.stored);
  const window: Record<string, unknown> = { addEventListener: vi.fn(), ...(opts.workspace ? { EchoPrimeWorkspace: opts.workspace } : {}) };
  const context = { window, document: doc, fetch, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } }, setTimeout, clearTimeout, Date, AbortController, Error, Number, String, Math, JSON, Promise, Array, Object, CustomEvent, console: { debug: vi.fn(), log: console.log } };
  runInNewContext(source, context);
  const api = window.EchoPrimeAgents as { open(): Promise<void>; refresh(): Promise<void>; active(): string | null };
  const windowHandlers = window.addEventListener as ReturnType<typeof vi.fn>;
  const fire = (name: string) => { for (const [registered, fn] of windowHandlers.mock.calls as [string, () => void][]) if (registered === name) fn(); };
  const count = (url: string) => calls.filter(c => c.url === url).length;
  const open = async () => { await nodes['open-agents'].fire('click')[0]; };
  const submit = async (prompt = 'Find the port.', agent = 'researcher') => { nodes['agents-agent'].value = agent; nodes['agents-prompt'].value = prompt; await Promise.all(nodes['agents-form'].fire('submit')); };
  return { nodes, n: nodes, api, calls, count, fire, open, submit, doc, visibility, polls: () => polls, store, ws: opts.workspace, fetch, orbEvents, fireDoc };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Agents view: off, admission and the agent list', () => {
  it('fetches nothing at load; says the feature is off when the config has no adk section', async () => {
    const s = await setup({ health: { configured: false, available: false, reason: 'Echo ADK is off: add an `adk` section to the Prime config' } });
    expect(s.calls).toHaveLength(0); expect(s.n['agents-submit'].disabled).toBe(true);
    await s.open();
    expect(s.n['agents-dialog'].open).toBe(true);
    expect(s.n['agents-status'].textContent).toBe('Echo ADK is off: add an `adk` section to the Prime config');
    expect(s.count('/api/prime/adk/health')).toBe(1); expect(s.count('/api/prime/adk/agents')).toBe(0); expect(s.count('/api/prime/adk/runs?limit=20')).toBe(0);
    expect(s.n['agents-submit'].disabled).toBe(true);
  });
  it('anonymous visitor: no owner-only route is ever fetched, nothing is invalidated, and the view says to sign in', async () => {
    const s = await setup({ workspace: workspaceStub(anonymous()), healthStatus: 401, health: { error: 'Sign in required' } });
    expect(s.calls).toHaveLength(0);
    await s.open();
    expect(s.calls).toHaveLength(0); expect(s.ws!.sessionReads).toBe(0); expect(s.ws!.invalidate).not.toHaveBeenCalled();
    expect(s.n['agents-status'].textContent).toContain('Sign in to use Agents');
    for (let i = 0; i < 25; i++) s.fire('echo-account-changed');
    await s.n['refresh-agents'].fire('click')[0]; await settle();
    expect(s.calls).toHaveLength(0); expect(s.ws!.invalidate).not.toHaveBeenCalled();
  });
  it('signed-in member: the owner-only routes are skipped and the view says they are for the primary owner only', async () => {
    const s = await setup({ workspace: workspaceStub(member()), healthStatus: 403, health: { error: 'Primary owner admission required' } });
    await s.open();
    expect(s.calls).toHaveLength(0); expect(s.ws!.invalidate).not.toHaveBeenCalled();
    expect(s.n['agents-status'].textContent).toContain('primary owner only'); expect(s.n['agents-submit'].disabled).toBe(true);
  });
  it('owner whose session expired: one health fetch, exactly one invalidate, no retry', async () => {
    const s = await setup({ workspace: workspaceStub(owner()), healthStatus: 401, health: { error: 'Sign in required' } });
    await s.open();
    expect(s.count('/api/prime/adk/health')).toBe(1); expect(s.ws!.invalidate).toHaveBeenCalledTimes(1); expect(s.ws!.session).toBeNull();
    expect(s.n['agents-status'].textContent).toContain('Echo ADK status unavailable (Sign in required)');
    s.fire('echo-account-changed'); await settle();
    expect(s.n['agents-dialog'].open).toBe(false);
    await s.api.open();
    expect(s.count('/api/prime/adk/health')).toBe(1); expect(s.n['agents-status'].textContent).toContain('Sign in to use Agents');
  });
  it('owner: lists every agent definition with role, skills, capabilities, lane and budget, fills the picker and the default budget', async () => {
    const s = await setup({ workspace: workspaceStub(owner()) });
    await s.open();
    expect(s.count('/api/prime/adk/health')).toBe(1); expect(s.count('/api/prime/adk/agents')).toBe(1); expect(s.count('/api/prime/adk/runs?limit=20')).toBe(1);
    expect(s.ws!.ownerHeaders).toHaveBeenCalled();
    const shown = text(s.n['agents-list']);
    for (const expected of ['researcher', 'Finds and verifies facts', 'search, summarize', 'echo.knowledge.search', 'forge · qwen-local', 'up to 60 calls, $0.00, 20 min', '12', 'agents/researcher.yaml', 'Verify before claiming.', 'builder', 'Ships code', 'anvil · claude-cli', 'up to 20 calls, $2.00, 10 min'])
      expect(shown).toContain(expected);
    expect(s.n['agents-agent'].children.map(o => o.value)).toEqual(['researcher', 'builder']);
    expect(s.n['agents-agent'].value).toBe('researcher');
    expect([s.n['agents-calls'].value, s.n['agents-cost'].value, s.n['agents-wall'].value]).toEqual(['40', '0', '900']);
    expect(s.n['agents-status'].textContent).toBe('Echo ADK 0.1.0 · 2 agents · 1 active run · default up to 40 calls, $0.00, 15 min');
    expect(s.n['agents-submit'].disabled).toBe(false);
    expect(text(s.n['agents-runs'])).toContain('builder · done · dddddddd…');
  });
  it('host without an authenticated Workspace: the Prime cookie decides, so the view loads', async () => {
    const s = await setup();
    await s.open();
    expect(s.count('/api/prime/adk/health')).toBe(1); expect(s.n['agents-submit'].disabled).toBe(false);
  });
  it('shows a failed status check as unavailable, keeps Refresh usable, and cools down for 5 s before asking again', async () => {
    const s = await setup({ healthStatus: 500, health: { error: 'boom' } });
    await s.open();
    expect(s.n['agents-status'].textContent).toBe('Echo ADK status unavailable (boom). Nothing was started.');
    expect(s.n['refresh-agents'].disabled).toBe(false);
    const clicked = s.n['refresh-agents'].fire('click'); expect(clicked).toHaveLength(1); await clicked[0];
    expect(s.count('/api/prime/adk/health')).toBe(1); expect(s.n['agents-status'].textContent).toContain('try Refresh in a few seconds');
    await vi.advanceTimersByTimeAsync(5100); await s.n['refresh-agents'].fire('click')[0]; expect(s.count('/api/prime/adk/health')).toBe(2);
  });
  it('Refresh stays usable on every early return: off, unavailable and sign-in', async () => {
    const off = await setup({ health: { configured: false, available: false, reason: 'Echo ADK is off: add an `adk` section to the Prime config' } });
    await off.open(); expect(off.n['refresh-agents'].disabled).toBe(false);
    expect(off.n['refresh-agents'].fire('click')).toHaveLength(1); await settle(); expect(off.count('/api/prime/adk/health')).toBe(2);
    const down = await setup({ health: { configured: true, available: false, defaultBudget: HEALTH.defaultBudget, reason: 'Echo ADK unreachable at http://127.0.0.1:8378' } });
    await down.open(); expect(down.n['refresh-agents'].disabled).toBe(false); expect(down.n['agents-submit'].disabled).toBe(true);
    const signin = await setup({ workspace: workspaceStub(anonymous()) });
    await signin.open(); expect(signin.n['refresh-agents'].disabled).toBe(false); expect(signin.calls).toHaveLength(0);
  });
  it('says the service is unavailable, and starts nothing, when health says so', async () => {
    const s = await setup({ health: { configured: true, available: false, defaultBudget: HEALTH.defaultBudget, reason: 'Echo ADK unreachable at http://127.0.0.1:8378' } });
    await s.open();
    expect(s.n['agents-status'].textContent).toBe('Echo ADK is unavailable: Echo ADK unreachable at http://127.0.0.1:8378. Nothing was started.');
    expect(s.count('/api/prime/adk/agents')).toBe(0); expect(s.n['agents-submit'].disabled).toBe(true);
  });
  it('restores the last agent and prompt from localStorage and remembers the next submission', async () => {
    const s = await setup({ stored: JSON.stringify({ agent: 'builder', prompt: 'Ship the fix.' }) });
    await s.open();
    expect(s.n['agents-agent'].value).toBe('builder'); expect(s.n['agents-prompt'].value).toBe('Ship the fix.');
    await s.submit('Find the port.', 'researcher'); await settle();
    expect(JSON.parse(s.store.get('echo-prime-adk-v1')!)).toEqual({ agent: 'researcher', prompt: 'Find the port.' });
  });
});

describe('an agent run', () => {
  it('submits once with the budget, polls every 3 s, then renders every step, the model that answered, the final text and the Proof', async () => {
    const s = await setup({ poll: n => n < 3 ? { body: running(n === 1 ? [] : [envelope(1, 'cap', { capability: 'echo.knowledge.search', tier: 0 })]) } : { body: finished() } });
    await s.open();
    s.n['agents-calls'].value = '12'; s.n['agents-cost'].value = '0'; s.n['agents-wall'].value = '300';
    await s.submit('Find the port.'); await settle();
    const submits = s.calls.filter(c => c.url === '/api/prime/adk/runs' && c.method === 'POST');
    expect(submits).toHaveLength(1); expect(submits[0].body).toEqual({ agent: 'researcher', prompt: 'Find the port.', budget: { max_calls: 12, max_cost_usd: 0, max_wall_s: 300 } });
    expect(s.polls()).toBe(1); expect(s.api.active()).toBe(RUN);
    let shown = text(s.n['agents-run']);
    expect(shown).toContain('Run ' + RUN); expect(shown).toContain('running'); expect(shown).toContain('up to 40 calls, $0.00, 15 min'); expect(shown).toContain('polling every 3 s');
    expect(shown).toContain('Stop after this step'); expect(shown).toContain('already running is not interrupted');
    await vi.advanceTimersByTimeAsync(2900); expect(s.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(200); expect(s.polls()).toBe(2);
    shown = text(s.n['agents-run']);
    expect(shown).toContain('Steps (1)'); expect(shown).toContain('echo.knowledge.search'); expect(shown).toContain('0:03');
    await vi.advanceTimersByTimeAsync(3000); expect(s.polls()).toBe(3);
    shown = text(s.n['agents-run']);
    for (const expected of ['done', 'Steps (3)', '#1', 'cap', 'echo.knowledge.search', 'tier 0', 'allowed', '120 ms', 'audit aud-1', '#2', 'model', 'answered by qwen3.5-27b · forge-qwen', '#3', 'final',
      'Final text', 'Verified: the port is 8378.', 'Proof', 'PASS', 'e'.repeat(64), 'echo.knowledge.search · tier 0 · allowed · audit aud-1', 'Receipts (1)', 'spent 2 calls, $0.00, 9 s', 'Finished after'])
      expect(shown).toContain(expected);
    expect(shown).not.toContain('Stop after this step');
    expect(s.api.active()).toBeNull();
    const before = s.polls(); await vi.advanceTimersByTimeAsync(20000); expect(s.polls()).toBe(before);
    expect(s.count('/api/prime/adk/runs?limit=20')).toBe(2);
  });
  it('says "model not reported" when the provider does not say which model answered', async () => {
    const s = await setup({ poll: () => ({ body: { ...finished(), steps: [envelope(1, 'model', { data: { answered: { provider: 'agy', requested: 'gemini-4-argon', model: null, reported: false } } }), envelope(2, 'final', { data: { text: 'ok' } })] } }) });
    await s.open(); await s.submit(); await settle();
    expect(text(s.n['agents-run'])).toContain('model not reported by agy (requested: gemini-4-argon)');
  });
  it('stops polling while the tab is hidden and polls again the moment it is visible', async () => {
    const s = await setup();
    await s.open(); await s.submit(); await settle(); expect(s.polls()).toBe(1);
    s.doc.hidden = true; s.visibility.forEach(f => f());
    await vi.advanceTimersByTimeAsync(15000); expect(s.polls()).toBe(1);
    expect(text(s.n['agents-run'])).toContain('polling paused while this tab is hidden');
    s.doc.hidden = false; s.visibility.forEach(f => f()); await settle(); expect(s.polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3100); expect(s.polls()).toBe(3);
  });
  it('renders a gated run with what it needs and how, and keeps polling', async () => {
    const s = await setup({ poll: () => ({ body: running([envelope(1, 'cap', { capability: 'echo.shell.run', tier: 2, verdict: 'gated', ok: false, needs: ['echo.shell.run'], how: 'grant a Lease with scope echo.shell.run' })], { status: 'gated' }) }) });
    await s.open(); await s.submit(); await settle();
    const shown = text(s.n['agents-run']);
    expect(shown).toContain('gated'); expect(shown).toContain('Gated: this step needs a Lease before it can run.');
    expect(shown).toContain('Needs: echo.shell.run'); expect(shown).toContain('How: grant a Lease with scope echo.shell.run'); expect(shown).toContain('ok: false');
    await vi.advanceTimersByTimeAsync(6100); expect(s.polls()).toBe(3);
  });
  it('names the unavailable provider and says no fallback was used', async () => {
    const s = await setup({ poll: () => ({ body: { ...running([envelope(1, 'model', { verdict: 'allowed', ok: false, data: {} })]), status: 'failed', done: true, error: { code: 'unavailable', message: 'claude CLI exited 1', provider: 'claude' } } }) });
    await s.open(); await s.submit(); await settle();
    const shown = text(s.n['agents-run']);
    expect(shown).toContain('Provider claude is unavailable.'); expect(shown).toContain('No fallback provider was used.'); expect(shown).toContain('claude CLI exited 1');
    expect(s.api.active()).toBeNull();
  });
  it('shows a budget stop as a budget stop', async () => {
    const s = await setup({ poll: () => ({ body: { ...running([]), status: 'failed', done: true, error: { code: 'budget_exceeded', message: 'max_calls reached' }, spent: { calls: 40, cost_usd: 0, wall_s: 88 } } }) });
    await s.open(); await s.submit(); await settle();
    const shown = text(s.n['agents-run']);
    expect(shown).toContain('Budget stop: the run stopped at its budget.'); expect(shown).toContain('max_calls reached'); expect(shown).toContain('spent 40 calls, $0.00, 88 s');
  });
  it('shows a plain failure with its code and message', async () => {
    const s = await setup({ poll: () => ({ body: { ...running([]), status: 'failed', done: true, error: { code: 'invalid', message: 'agent rejected the prompt' } } }) });
    await s.open(); await s.submit(); await settle();
    expect(text(s.n['agents-run'])).toContain('The run failed (invalid).'); expect(text(s.n['agents-run'])).toContain('agent rejected the prompt');
  });
  it('Stop posts to the stop route, says a running provider call is not interrupted, and keeps polling until the run ends', async () => {
    const s = await setup({ poll: n => n < 4 ? { body: running() } : { body: { ...finished(), steps: [envelope(1, 'cap', { capability: 'echo.knowledge.search' })], proof: { ...finished().proof, verdict: 'UNKNOWN' } } } });
    await s.open(); await s.submit(); await settle();
    const stop = flat(s.n['agents-run']).find(e => e.tag === 'button')!;
    expect(stop.textContent).toBe('Stop after this step');
    await Promise.all(stop.fire('click')); await settle();
    expect(s.calls.filter(c => c.url === `/api/prime/adk/runs/${RUN}/stop` && c.method === 'POST')).toHaveLength(1);
    expect(text(s.n['agents-run'])).toContain('Stop requested (status running). The run stops after the current step; a running provider call is not interrupted.');
    await vi.advanceTimersByTimeAsync(3100);
    expect(flat(s.n['agents-run']).find(e => e.tag === 'button')!.textContent).toBe('Stop requested');
    await vi.advanceTimersByTimeAsync(6100); expect(s.polls()).toBe(4);
    const shown = text(s.n['agents-run']);
    expect(shown).toContain('UNKNOWN'); expect(shown).toContain('The run finished without a final text.'); expect(s.api.active()).toBeNull();
  });
  it('reports a refused stop and keeps the run', async () => {
    const s = await setup({ stop: () => ({ status: 404, body: { error: 'Echo ADK answered HTTP 404 (not_found): unknown run' } }) });
    await s.open(); await s.submit(); await settle();
    await Promise.all(flat(s.n['agents-run']).find(e => e.tag === 'button')!.fire('click')); await settle();
    expect(text(s.n['agents-run'])).toContain('Stop was not accepted: Echo ADK answered HTTP 404 (not_found): unknown run. The run continues.');
    expect(s.api.active()).toBe(RUN);
  });
  it('retries transient status errors, then reports lost contact after five in a row', async () => {
    const s = await setup({ poll: () => ({ status: 502, body: { error: 'Echo ADK unreachable at http://127.0.0.1:8378' } }) });
    await s.open(); await s.submit(); await settle();
    expect(text(s.n['agents-run'])).toContain('Status check failed (1/5)');
    await vi.advanceTimersByTimeAsync(13000);
    const shown = text(s.n['agents-run']);
    expect(shown).toContain('Lost contact with Echo ADK.'); expect(shown).toContain('may still be running and spending its budget'); expect(shown).toContain('No fallback provider was used');
    expect(s.polls()).toBe(5); expect(s.api.active()).toBeNull();
    await vi.advanceTimersByTimeAsync(20000); expect(s.polls()).toBe(5);
  });
  it('stops at once when the service does not know the run', async () => {
    const s = await setup({ poll: () => ({ status: 404, body: { error: 'Echo ADK answered HTTP 404 (not_found): unknown run' } }) });
    await s.open(); await s.submit(); await settle();
    expect(text(s.n['agents-run'])).toContain('Echo ADK does not know run ' + RUN); expect(s.polls()).toBe(1); expect(s.api.active()).toBeNull();
  });
  it('gives up after the wall-clock budget plus grace and says the run may still be running', async () => {
    const s = await setup({ run: () => ({ runId: RUN, agent: 'researcher', status: 'queued', budget: { max_calls: 5, max_cost_usd: 0, max_wall_s: 30 } }) });
    await s.open(); await s.submit(); await settle();
    expect(s.n['agents-status'].textContent).toContain('up to 5 calls, $0.00, 1 min');
    await vi.advanceTimersByTimeAsync(151000);
    expect(text(s.n['agents-run'])).toContain('Stopped waiting: the wall-clock budget plus grace has passed.'); expect(s.api.active()).toBeNull();
  });
  it('shows a refused submission and does not poll', async () => {
    const s = await setup({ runStatus: 400, run: () => ({ error: 'Echo ADK answered HTTP 403 (gated): lease required. Needs: echo.shell.run. How: grant a Lease' }) });
    await s.open(); await s.submit(); await settle();
    expect(s.n['agents-status'].textContent).toContain('The run was not started: Echo ADK answered HTTP 403 (gated): lease required. Needs: echo.shell.run. How: grant a Lease');
    expect(s.n['agents-status'].textContent).toContain('No fallback provider was used'); expect(s.polls()).toBe(0); expect(s.n['agents-submit'].disabled).toBe(false);
  });
  it('refuses an over-long or empty prompt and an unlisted agent in the browser before any request', async () => {
    const s = await setup();
    await s.open();
    await s.submit('x'.repeat(12001)); expect(s.n['agents-status'].textContent).toContain('12000');
    await s.submit('   '); expect(s.n['agents-status'].textContent).toContain('Enter a prompt');
    await s.submit('ok', 'ghost');
    expect(s.calls.filter(c => c.url === '/api/prime/adk/runs' && c.method === 'POST')).toHaveLength(0);
  });
  it('an account change clears the view, closes it and stops watching', async () => {
    const s = await setup();
    await s.open(); await s.submit(); await settle(); expect(s.api.active()).toBe(RUN);
    s.fire('echo-account-changed');
    expect(s.api.active()).toBeNull(); expect(s.n['agents-dialog'].open).toBe(false); expect(s.n['agents-prompt'].value).toBe(''); expect(s.n['agents-list'].children).toHaveLength(0);
    const n = s.polls(); await vi.advanceTimersByTimeAsync(10000); expect(s.polls()).toBe(n);
  });
  it('closing the view stops watching without another request', async () => {
    const s = await setup();
    await s.open(); await s.submit(); await settle();
    s.n['agents-dialog'].close();
    expect(s.api.active()).toBeNull();
    const n = s.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(s.calls.length).toBe(n);
  });
});

describe('living orb wiring: agents.js publishes moons and states, and opens an agent from its moon', () => {
  type Moon = { id: string; kind: string; name: string; status: string; busy: boolean };
  const states = (s: Awaited<ReturnType<typeof setup>>) => s.orbEvents.filter(e => e.type === 'echo-orb-state').map(e => e.detail.mode);
  const moons = (s: Awaited<ReturnType<typeof setup>>) => s.orbEvents.filter(e => e.type === 'echo-orb-satellites').at(-1)?.detail.satellites as Moon[] | undefined;
  const idle = (name: string): Moon => ({ id: 'agent:' + name, kind: 'agent', name, status: 'idle', busy: false });
  const runningMoon = (name: string): Moon => ({ id: 'agent:' + name, kind: 'agent', name, status: 'running', busy: true });
  it('dispatches nothing before the view loads, then one idle moon per agent definition, always as the agents source', async () => {
    const s = await setup({ workspace: workspaceStub(owner()) });
    expect(s.orbEvents).toEqual([]);
    await s.open();
    expect(moons(s)).toEqual([idle('researcher'), idle('builder')]); expect(states(s)).toEqual([]);
    expect(s.orbEvents.every(e => e.detail.source === 'agents')).toBe(true);
  });
  it('anonymous visitor: no agent list is fetched, so no moon is published', async () => {
    const s = await setup({ workspace: workspaceStub(anonymous()), healthStatus: 401, health: { error: 'Sign in required' } });
    await s.open();
    expect(s.calls).toHaveLength(0); expect(s.orbEvents.filter(e => e.type === 'echo-orb-satellites' && (e.detail.satellites as Moon[]).length)).toEqual([]);
  });
  it('a watched run puts the orb in deep thought with its moon running; done flashes success, then idle with every moon idle', async () => {
    const s = await setup({ poll: n => n < 2 ? { body: running() } : { body: finished() } });
    await s.open(); await s.submit('Find the port.', 'researcher'); await settle();
    expect(states(s)).toEqual(['deep']); expect(moons(s)).toEqual([runningMoon('researcher'), idle('builder')]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(s.api.active()).toBeNull(); expect(states(s)).toEqual(['deep', 'success', 'idle']); expect(moons(s)).toEqual([idle('researcher'), idle('builder')]);
  });
  it('a failed run flashes error, then idle', async () => {
    const s = await setup({ poll: () => ({ body: { ...running([]), status: 'failed', done: true, error: { code: 'invalid', message: 'agent rejected the prompt' } } }) });
    await s.open(); await s.submit(); await settle();
    expect(states(s)).toEqual(['deep', 'error', 'idle']); expect(moons(s)).toEqual([idle('researcher'), idle('builder')]);
  });
  it('a run that stops watching without a result (unknown run, lost contact, wall clock) returns the orb to idle without an error flash', async () => {
    const unknown = await setup({ poll: () => ({ status: 404, body: { error: 'Echo ADK answered HTTP 404 (not_found): unknown run' } }) });
    await unknown.open(); await unknown.submit(); await settle();
    expect(states(unknown)).toEqual(['deep', 'idle']); expect(moons(unknown)).toEqual([idle('researcher'), idle('builder')]);
    const lost = await setup({ poll: () => ({ status: 502, body: { error: 'Echo ADK unreachable at http://127.0.0.1:8378' } }) });
    await lost.open(); await lost.submit(); await settle(); await vi.advanceTimersByTimeAsync(13000);
    expect(lost.api.active()).toBeNull(); expect(states(lost)).toEqual(['deep', 'idle']);
    const slow = await setup({ run: () => ({ runId: RUN, agent: 'researcher', status: 'queued', budget: { max_calls: 5, max_cost_usd: 0, max_wall_s: 30 } }) });
    await slow.open(); await slow.submit(); await settle(); await vi.advanceTimersByTimeAsync(151000);
    expect(slow.api.active()).toBeNull(); expect(states(slow)).toEqual(['deep', 'idle']); expect(moons(slow)).toEqual([idle('researcher'), idle('builder')]);
  });
  it('closing the view stops the run on the orb: idle and the moon stops running', async () => {
    const s = await setup();
    await s.open(); await s.submit(); await settle();
    s.n['agents-dialog'].close();
    expect(states(s)).toEqual(['deep', 'idle']); expect(moons(s)).toEqual([idle('researcher'), idle('builder')]);
  });
  it('an account change returns the orb to idle and clears every agent moon', async () => {
    const s = await setup();
    await s.open(); await s.submit(); await settle();
    s.fire('echo-account-changed');
    expect(states(s)).toEqual(['deep', 'idle']); expect(moons(s)).toEqual([]);
  });
  it('a reload never blanks the moons: Refresh, reopening and a moon click publish only what Echo ADK answered', async () => {
    const opts: Opts = { workspace: workspaceStub(owner()) }; const s = await setup(opts);
    const published = (from: number) => s.orbEvents.slice(from).filter(e => e.type === 'echo-orb-satellites').map(e => e.detail.satellites as Moon[]);
    await s.open(); await settle(); expect(moons(s)).toEqual([idle('researcher'), idle('builder')]);
    let from = s.orbEvents.length;
    await s.api.refresh(); await settle();
    s.n['agents-dialog'].close(); await s.open(); await settle();
    s.fireDoc('echo-orb-open', { id: 'agent:builder', kind: 'agent' }); await settle();
    expect(s.count('/api/prime/adk/agents')).toBe(4); expect(published(from)).toEqual(Array(3).fill([idle('researcher'), idle('builder')]));
    // A reload that fails keeps the moons; one that answers with fewer definitions publishes exactly those.
    opts.healthStatus = 503; opts.health = { error: 'Echo ADK unreachable' }; from = s.orbEvents.length;
    await s.api.refresh(); await settle(); expect(s.n['agents-status'].textContent).toContain('unavailable'); expect(published(from)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000); opts.healthStatus = 200; opts.health = HEALTH; opts.agents = [AGENTS[1]];
    await s.api.refresh(); await settle(); expect(published(from)).toEqual([[idle('builder')]]);
  });
  it('the watched agent orbits even when it is listed past the 24th definition', async () => {
    const s = await setup({ agents: Array.from({ length: 30 }, (_, i) => ({ ...AGENTS[0], name: 'agent-' + i })) });
    await s.open(); await settle(); expect(moons(s)).toHaveLength(24); expect(moons(s)!.map(m => m.name)).not.toContain('agent-28');
    await s.submit('Find the port.', 'agent-28'); await settle();
    const now = moons(s)!; expect(now).toHaveLength(24); expect(now[0]).toEqual(runningMoon('agent-28')); expect(now.slice(1).every(m => !m.busy)).toBe(true);
  });
  it('a click on an agent moon opens the view, loads it and selects that agent; other moons and malformed details are ignored', async () => {
    const s = await setup();
    s.fireDoc('echo-orb-open', { id: 'bot:' + 'a'.repeat(32), kind: 'bot' }); s.fireDoc('echo-orb-open', { id: 'builder', kind: 'agent' }); s.fireDoc('echo-orb-open', null);
    await settle(); expect(s.n['agents-dialog'].open).toBe(false); expect(s.calls).toHaveLength(0);
    s.fireDoc('echo-orb-open', { id: 'agent:builder', kind: 'agent' }); await settle();
    expect(s.n['agents-dialog'].open).toBe(true); expect(s.count('/api/prime/adk/agents')).toBe(1);
    expect(s.n['agents-agent'].value).toBe('builder'); expect(JSON.parse(s.store.get('echo-prime-adk-v1')!).agent).toBe('builder');
    // A moon whose agent is no longer listed opens the view but selects nothing that does not exist.
    s.n['agents-dialog'].close(); s.fireDoc('echo-orb-open', { id: 'agent:ghost', kind: 'agent' }); await settle();
    expect(s.n['agents-dialog'].open).toBe(true); expect(s.n['agents-agent'].children.map(o => o.value)).toEqual(['researcher', 'builder']); expect(s.n['agents-agent'].value).not.toBe('ghost');
  });
});
