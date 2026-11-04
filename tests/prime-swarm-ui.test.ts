import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const modelsSource = readFileSync(new URL('../ui/echo-prime/models.js', import.meta.url), 'utf8');
const swarmSource = readFileSync(new URL('../ui/echo-prime/swarm.js', import.meta.url), 'utf8');
const RUN = 'c'.repeat(32);

interface El {
  tag: string; textContent: string; className: string; hidden: boolean; disabled: boolean; open: boolean; value: string; children: El[];
  append(...n: El[]): void; replaceChildren(...n: El[]): void; setAttribute: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn>;
  addEventListener(name: string, fn: (e?: unknown) => void): void; fire(name: string): void;
}
function element(tag = 'div'): El {
  const handlers: Record<string, ((e?: unknown) => void)[]> = {};
  const el: El = {
    tag, textContent: '', className: '', hidden: false, disabled: false, open: false, value: '', children: [],
    append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; },
    setAttribute: vi.fn(), scrollIntoView: vi.fn(),
    addEventListener(name, fn) { (handlers[name] ??= []).push(fn); },
    fire(name) { (handlers[name] ?? []).forEach(fn => fn({ target: el })); },
  };
  return el;
}
const flat = (e: El): El[] => [e, ...e.children.flatMap(flat)];
const text = (e: El): string => flat(e).map(x => x.textContent).join(' | ');

const report = () => ({ configured: true, routing: true, default: 'qwen', contextTokens: 262144, providers: [
  { id: 'qwen', label: 'Qwen (FORGE, 256K)', available: true, last: null }, { id: 'claude', label: 'Claude (claude CLI)', available: true, last: null },
  { id: 'gpt', label: 'GPT (codex CLI)', available: true, last: null }, { id: 'grok', label: 'Grok (grok CLI)', available: true, last: null },
  { id: 'argon', label: 'Argon (Gemini 4, agy CLI)', available: true, last: null, variants: [] }] });
const fusion = (over: Record<string, unknown> = {}) => ({
  run_id: RUN, answer: 'Ship it behind a flag.', confidence: 0.82, fusion_passes: 2,
  major_findings: [{ claim: 'The migration is reversible', evidence: ['plan.md#rollback'], confidence: 0.9, seat_id: 'seat-07', role: 'verifier', verified: true }],
  dissent: [{ claim: 'Rollback hides data loss', dissenting_seats: ['seat-31'], majority_position: 'Rollback is safe', evidence: [], confidence: 0.4, reason_rejected: 'No evidence offered' }],
  unresolved: ['Is the replica lag bounded?'], contradictions: [{ topic: 'rollback safety', resolved: false }], models_used: ['a', 'b', 'c'],
  provenance: { profile: 'MAXIMALIST_RECONSTRUCTED', historical_parity: false, seats: 40 }, ...over });
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

interface Opts { health?: unknown; healthStatus?: number; run?: () => unknown; runStatus?: number; runs?: (n: number) => { status?: number; body: unknown } }
async function setup(opts: Opts = {}) {
  const toolbar = element(), composer = element(), send = element(), stop = element(), log = element(), welcome = element();
  const nodes: Record<string, El> = { '.composer-toolbar': toolbar, '#composer': composer, '#composer .send': send, '#stop-chat': stop, '#chat-log': log, '#welcome': welcome };
  stop.hidden = true; log.hidden = true;
  const doc = { hidden: false, querySelector: (s: string) => nodes[s] ?? null, createElement: (t: string) => element(t), addEventListener: vi.fn() };
  const visibility: (() => void)[] = []; doc.addEventListener = vi.fn((name: string, fn: () => void) => { if (name === 'visibilitychange') visibility.push(fn); });
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let polls = 0;
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/prime/models') return json(200, report());
    if (url === '/api/prime/swarm/health') return json(opts.healthStatus ?? 200, opts.health ?? { configured: true, available: true, defaultBudget: { max_calls: 80, max_cost_usd: 1, max_wall_s: 1800 }, worker: { profile: 'MAXIMALIST_RECONSTRUCTED' } });
    if (url === '/api/prime/swarm/run') return json(opts.runStatus ?? 202, opts.run ? opts.run() : { runId: RUN, phase: 'independent', budget: { max_calls: 80, max_cost_usd: 1, max_wall_s: 1800 }, idempotencyKey: 'prime-x' });
    if (url === `/api/prime/swarm/runs/${RUN}`) { polls++; const r = opts.runs ? opts.runs(polls) : { body: { runId: RUN, phase: 'independent', done: false } }; return json(r.status ?? 200, r.body); }
    throw new Error('unexpected url ' + url);
  });
  const chat = { send: vi.fn(async () => ({ sent: true, detail: 'original' })), cancel: vi.fn(), reset: vi.fn() };
  const window: Record<string, unknown> = { addEventListener: vi.fn(), EchoPrimeChat: chat };
  const context = { window, document: doc, fetch, localStorage: { getItem: () => null, setItem: () => undefined }, setTimeout, clearTimeout, Date, AbortController, Error, console: { debug: vi.fn(), log: console.log } };
  runInNewContext(modelsSource, context);
  const models = window.EchoPrimeModels as { ready: Promise<void>; provider(): string | undefined; swarm(): boolean };
  await models.ready;
  const { send: sentChat, cancel: cancelSpy, reset: resetSpy } = chat; // swarm.js wraps these; the originals are what other providers must still reach
  runInNewContext(swarmSource, context);
  await (window.EchoPrimeSwarm as { ready: Promise<unknown> }).ready;
  const select = flat(toolbar).find(e => e.tag === 'select')!;
  const choose = (id: string) => { select.value = id; select.fire('change'); };
  return { chat: window.EchoPrimeChat as { send(t: string): Promise<Record<string, unknown>>; cancel(): void; reset(): void }, original: sentChat, originalCancel: cancelSpy, originalReset: resetSpy,
    select, choose, toolbar, calls, models, send, stop, log, doc, visibility, polls: () => polls, windowHandlers: window.addEventListener as ReturnType<typeof vi.fn> };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
/** Starts a turn, lets the first poll happen on the fake clock, and returns the settled result. */
async function go(chat: { send(t: string): Promise<Record<string, unknown>> }, prompt = 'q') { const turn = chat.send(prompt); await vi.advanceTimersByTimeAsync(50); return turn; }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Swarm entry in the model picker', () => {
  it('appears next to the other providers and is selectable when the worker is healthy', async () => {
    const s = await setup();
    const options = s.select.children.map(o => o.textContent);
    expect(options).toHaveLength(6); expect(options[5]).toBe('Swarm (40-seat brain)');
    s.choose('swarm');
    expect(s.models.provider()).toBe('swarm'); expect(s.models.swarm()).toBe(true);
    expect(text(s.toolbar)).toMatch(/Swarm \(40-seat brain\) selected\..*many minutes.*no cancel.*no other model is used/is);
  });
  it('says plainly that the feature is off when there is no swarm section, and refuses to send anywhere', async () => {
    const s = await setup({ health: { configured: false, available: false, reason: 'Swarm is not enabled: the reviewed Prime configuration has no swarm section' } });
    expect(s.select.children[5].textContent).toBe('Swarm (40-seat brain) (unavailable)');
    s.choose('swarm');
    expect(text(s.toolbar)).toMatch(/unavailable: Swarm is not enabled.*No other model will be used/is);
    const result = await s.chat.send('hello');
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toMatch(/Swarm is unavailable.*Nothing was sent to any model/is);
    expect(s.original).not.toHaveBeenCalled(); expect(s.calls.some(c => c.url.endsWith('/swarm/run'))).toBe(false);
  });
  it('shows a failed status check as unavailable, never as ready', async () => {
    const s = await setup({ healthStatus: 500, health: { error: 'boom' } });
    expect(s.select.children[5].textContent).toContain('(unavailable)');
    s.choose('swarm');
    expect(text(s.toolbar)).toMatch(/Swarm status unavailable \(boom\)/);
  });
  it('leaves every other provider on the original chat route', async () => {
    const s = await setup();
    s.choose('claude');
    expect(await s.chat.send('hi')).toMatchObject({ detail: 'original' });
    expect(s.original).toHaveBeenCalledTimes(1); expect(s.calls.some(c => c.url.endsWith('/swarm/run'))).toBe(false);
  });
});

describe('a swarm turn', () => {
  it('submits once, polls every 3 s, then renders the fused answer, findings, dissent, uncertainty, provenance and the honest badge', async () => {
    const s = await setup({ runs: n => n < 3 ? { body: { runId: RUN, phase: n === 1 ? 'independent' : 'fusion', done: false } } : { body: { runId: RUN, phase: 'complete', done: true, result: fusion() } } });
    s.choose('swarm');
    const turn = s.chat.send('Should we ship the migration?');
    await settle();
    expect(s.send.disabled).toBe(true); expect(s.stop.hidden).toBe(false);
    const submits = s.calls.filter(c => c.url.endsWith('/swarm/run'));
    expect(submits).toHaveLength(1); expect(submits[0].body).toEqual({ objective: 'Should we ship the migration?' });
    expect(s.polls()).toBe(1);
    const progress = text(s.log);
    expect(progress).toContain('Should we ship the migration?'); expect(progress).toContain('Running 40 seats'); expect(progress).toContain('up to 80 calls, $1.00, 30 min');
    expect(progress).toContain('MAXIMALIST_RECONSTRUCTED · historical_parity: false'); expect(progress).toContain('worker has no cancel');
    await vi.advanceTimersByTimeAsync(2900); expect(s.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(200); expect(s.polls()).toBe(2);
    expect(text(s.log)).toContain('Phase: fusion'); expect(text(s.log)).toContain('0:03');
    await vi.advanceTimersByTimeAsync(3000); expect(s.polls()).toBe(3);
    await expect(turn).resolves.toEqual({ sent: true, detail: 'Swarm answer received.' });
    const done = text(s.log);
    for (const expected of ['Ship it behind a flag.', 'Confidence 82% · 2 fusion passes', 'MAXIMALIST_RECONSTRUCTED · historical_parity: false', 'a reconstruction, not the historical original',
      'Major findings (1)', 'The migration is reversible', 'seat seat-07 (verifier) · confidence 90% · verified · evidence: plan.md#rollback',
      'Preserved dissent (1)', 'Rollback hides data loss', 'dissenting seats: seat-31', 'majority held: Rollback is safe', 'set aside because: No evidence offered',
      'Unresolved uncertainty (2)', 'Is the replica lag bounded?', 'rollback safety (unresolved)', 'Provenance', 'Seats used: 3', 'verify claims'])
      expect(done).toContain(expected);
    expect(done).not.toContain('Running 40 seats');
    expect(s.original).not.toHaveBeenCalled();
    expect(s.send.disabled).toBe(false); expect(s.stop.hidden).toBe(true);
    const before = s.polls(); await vi.advanceTimersByTimeAsync(20000); expect(s.polls()).toBe(before);
  });
  it('stops polling while the tab is hidden and polls again the moment it is visible', async () => {
    const s = await setup();
    s.choose('swarm'); void s.chat.send('q'); await settle(); expect(s.polls()).toBe(1);
    s.doc.hidden = true; s.visibility.forEach(f => f());
    await vi.advanceTimersByTimeAsync(15000); expect(s.polls()).toBe(1);
    expect(text(s.log)).toContain('polling paused while this tab is hidden');
    s.doc.hidden = false; s.visibility.forEach(f => f()); await settle(); expect(s.polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3100); expect(s.polls()).toBe(3);
  });
  it('Stop only stops waiting: it says the worker cannot cancel and polls no more', async () => {
    const s = await setup();
    s.choose('swarm'); const turn = s.chat.send('q'); await settle();
    s.chat.cancel();
    const result = await turn;
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toMatch(/Stopped waiting for swarm run c{32}\. The worker has no cancel.*spend up to its budget/s);
    expect(text(s.log)).toContain('No other model was used');
    const n = s.polls(); await vi.advanceTimersByTimeAsync(20000); expect(s.polls()).toBe(n);
    expect(s.send.disabled).toBe(false); expect(s.stop.hidden).toBe(true);
    expect(s.originalCancel).not.toHaveBeenCalled();
  });
  it('the in-card Stop waiting button does the same', async () => {
    const s = await setup();
    s.choose('swarm'); const turn = s.chat.send('q'); await settle();
    const button = flat(s.log).find(e => e.tag === 'button')!; button.fire('click');
    await expect(turn).resolves.toMatchObject({ sent: false });
  });
  it('reset cancels the watch quietly and resets the original chat', async () => {
    const s = await setup();
    s.choose('swarm'); const turn = s.chat.send('q'); await settle();
    s.chat.reset(); await expect(turn).resolves.toEqual({ cancelled: true });
    expect(s.originalReset).toHaveBeenCalled();
  });
  it('refuses a second run while one is in progress', async () => {
    const s = await setup();
    s.choose('swarm'); void s.chat.send('one'); await settle();
    expect(await s.chat.send('two')).toMatchObject({ sent: false, detail: expect.stringContaining('in progress') });
    expect(s.calls.filter(c => c.url.endsWith('/swarm/run'))).toHaveLength(1);
  });
  it('refuses an over-long objective in the browser before any request', async () => {
    const s = await setup(); s.choose('swarm');
    expect(await s.chat.send('x'.repeat(12001))).toMatchObject({ sent: false, detail: expect.stringContaining('12000') });
    expect(s.calls.filter(c => c.url.endsWith('/swarm/run'))).toHaveLength(0);
  });
});

describe('swarm failures are explicit', () => {
  it('shows a refused submission (budget, worker down) and does not poll or fall back', async () => {
    const s = await setup({ runStatus: 502, run: () => ({ error: 'Swarm worker unreachable at http://127.0.0.1:8358' }) });
    s.choose('swarm');
    const result = await go(s.chat);
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toContain('Swarm worker unreachable'); expect(String(result.detail)).toContain('No other model was used');
    expect(text(s.log)).toContain('The swarm run was not started: Swarm worker unreachable'); expect(s.polls()).toBe(0); expect(s.original).not.toHaveBeenCalled();
    expect(s.send.disabled).toBe(false);
  });
  it('shows a run that ends with an error, including a budget stop', async () => {
    const s = await setup({ runs: () => ({ body: { runId: RUN, phase: 'failed', done: true, error: 'budget exhausted: max_cost_usd' } }) });
    s.choose('swarm'); const result = await go(s.chat);
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toContain('budget exhausted: max_cost_usd');
    expect(text(s.log)).toContain('The swarm run failed: budget exhausted: max_cost_usd');
  });
  it('shows a done run with no result instead of pretending', async () => {
    const s = await setup({ runs: () => ({ body: { runId: RUN, phase: 'complete', done: true } }) });
    s.choose('swarm'); const result = await go(s.chat);
    expect(result).toMatchObject({ sent: false }); expect(text(s.log)).toContain('finished without a result');
  });
  it('retries transient status errors, then gives up loudly after five in a row', async () => {
    const s = await setup({ runs: () => ({ status: 502, body: { error: 'Swarm worker unreachable' } }) });
    s.choose('swarm'); const turn = s.chat.send('q'); await settle();
    expect(text(s.log)).toContain('Status check failed (1/5)');
    await vi.advanceTimersByTimeAsync(13000);
    const result = await turn;
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toContain('Lost contact'); expect(text(s.log)).toContain('may still be running and spending its budget');
    expect(s.polls()).toBe(5);
  });
  it('stops at once when the worker does not know the run', async () => {
    const s = await setup({ runs: () => ({ status: 404, body: { error: 'Swarm worker answered HTTP 404' } }) });
    s.choose('swarm'); const result = await go(s.chat);
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toContain('not found'); expect(s.polls()).toBe(1);
  });
  it('gives up after the wall-clock budget plus grace and says the run may still be running', async () => {
    const s = await setup({ run: () => ({ runId: RUN, phase: 'independent', budget: { max_calls: 10, max_cost_usd: 0.5, max_wall_s: 30 } }) });
    s.choose('swarm'); const turn = s.chat.send('q'); await settle();
    expect(text(s.log)).toContain('up to 10 calls, $0.50, 1 min');
    await vi.advanceTimersByTimeAsync(151000);
    const result = await turn;
    expect(result).toMatchObject({ sent: false }); expect(String(result.detail)).toMatch(/Timed out waiting for swarm run .*may still be running.*No other model was used/s);
    expect(text(s.log)).toContain('worker has no cancel');
  });
  it('flags a result that is not the reconstructed profile instead of claiming it is', async () => {
    const s = await setup({ runs: () => ({ body: { runId: RUN, phase: 'complete', done: true, result: fusion({ provenance: { profile: 'HISTORICAL', historical_parity: true } }) } }) });
    s.choose('swarm'); await go(s.chat);
    const shown = text(s.log);
    expect(shown).toContain('Profile not confirmed'); expect(shown).toContain('HISTORICAL'); expect(shown).toContain('historical_parity true');
    expect(shown).not.toContain('MAXIMALIST_RECONSTRUCTED · historical_parity: false');
  });
  it('tolerates a sparse result (no findings, dissent or provenance) without throwing', async () => {
    const s = await setup({ runs: () => ({ body: { runId: RUN, phase: 'complete', done: true, result: { answer: '' } } }) });
    s.choose('swarm'); const result = await go(s.chat);
    expect(result).toMatchObject({ sent: true });
    const shown = text(s.log);
    expect(shown).toContain('The run finished without an answer.'); expect(shown).toContain('Profile not confirmed'); expect(shown).toContain('No dissent was recorded');
    expect(shown).toContain('That is not proof there is nothing');
  });
});
