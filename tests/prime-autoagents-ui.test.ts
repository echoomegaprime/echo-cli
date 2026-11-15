/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The shipped autoagents.js (and, for the badge, agents.js and bots.js) run unchanged in a small DOM harness against synthetic
// Prime responses: card states, approval box, two-step delete, Open in echoBots / Open agent, the orb event, member explanation.
const source = readFileSync(new URL('../ui/echo-prime/autoagents.js', import.meta.url), 'utf8');
const agentsSource = readFileSync(new URL('../ui/echo-prime/agents.js', import.meta.url), 'utf8');
const botsSource = readFileSync(new URL('../ui/echo-prime/bots.js', import.meta.url), 'utf8');
const BOT = 'a'.repeat(32), SHA = 'c'.repeat(64);

class Node {
  tagName: string; textContent = ''; className = ''; hidden = false; disabled = false; open = false; value = ''; checked = false;
  attributes: Record<string, string> = {}; children: Node[] = []; events: Record<string, ((e: any) => unknown)[]> = {};
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  append(...items: Node[]) { this.children.push(...items); }
  replaceChildren(...items: Node[]) { this.children = [...items]; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, fn: (e: any) => unknown) { (this.events[name] ??= []).push(fn); }
  async fire(name: string, event: any = {}) { if (name === 'click' && this.disabled) return; for (const fn of this.events[name] ?? []) await fn({ target: this, ...event }); }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; void this.fire('close'); }
}
const all = (node: Node): Node[] => node.children.flatMap(child => [child, ...all(child)]);
const text = (node: Node): string => [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
const buttons = (root: Node) => all(root).filter(n => n.tagName === 'BUTTON');
const find = (root: Node, label: string) => buttons(root).find(n => n.textContent === label);
class FakeEvent { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } }

interface Session { workspaceConfigured: boolean; authenticated: boolean; ownerAccess: boolean; csrf: string | null; user: { uid: string; role: string; status: string } | null }
const owner = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'csrf-owner', user: { uid: 'owner', role: 'owner', status: 'approved' } });
const member = (): Session => ({ workspaceConfigured: true, authenticated: true, ownerAccess: false, csrf: 'csrf-member', user: { uid: 'member', role: 'member', status: 'approved' } });
const anonymous = (): Session => ({ workspaceConfigured: true, authenticated: false, ownerAccess: false, csrf: null, user: null });
function workspaceStub(session: Session | null, enabled = true) {
  const ws = { ready: Promise.resolve(enabled), enabled, session, ownerHeaders: vi.fn(async () => { if (!ws.session?.ownerAccess) throw new Error('Primary owner admission required.'); return { 'x-echo-csrf': ws.session.csrf! }; }), invalidate: vi.fn(() => { ws.session = null; }) };
  return ws;
}
const agent = (over: Record<string, unknown> = {}) => ({ name: 'queue-scout', role: 'observer', purpose: 'Watch the FORGE build queue each morning', capabilities: [{ id: 'echo.knowledge.search', tier: 0 }, { id: 'echo.context.recall', tier: 1 }], skills: ['echo-observer-power'],
  lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 } }, maxSteps: 12, schedule: { every_s: 3600 }, origin: { by: 'echo', prompt_sha256: SHA, created_at: '2026-11-04T21:00:00Z' }, existing: false, ...over });
const bot = (over: Record<string, unknown> = {}) => ({ botId: BOT, name: 'Queue scout', agent: 'queue-scout', mode: 'personal', status: 'idle', schedule: { every_s: 3600 }, dailyCostCapUsd: 0, existing: false, autoResumed: true, approval: { required: false, reasons: [] }, ...over });
const built = (over: Record<string, unknown> = {}) => ({ kind: 'autoagent', tool: 'make_bot', promptSha256: SHA, agent: agent(), bot: bot(), summary: 'Created.', ...over });
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

interface Opts { workspace?: ReturnType<typeof workspaceStub>; responses?: Record<string, { status: number; body: unknown }>; bots?: boolean; agents?: boolean; customEvent?: boolean }
function boot(opts: Opts = {}) {
  const log = new Node('section'); log.attributes.id = 'chat-log'; log.hidden = true;
  const created: Node[] = [];
  const document: any = { hidden: false, querySelector: (s: string) => s === '#chat-log' ? log : null, createElement: (tag: string) => { const n = new Node(tag); created.push(n); return n; }, addEventListener: vi.fn() };
  const calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers ?? {} });
    const forced = opts.responses?.[url]; if (forced) return json(forced.status, forced.body);
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/(pause|resume)$/.exec(url))) return json(200, { bot_id: m[1], name: 'Queue scout', status: m[2] === 'pause' ? 'paused' : 'idle' });
    if ((m = /^\/api\/prime\/bots\/([0-9a-f]{32})\/delete$/.exec(url))) return json(200, { botId: m[1], deleted: true });
    if ((m = /^\/api\/prime\/adk\/agents\/([^/]+)\/delete$/.exec(url))) return json(200, { name: decodeURIComponent(m[1]), deleted: true });
    throw new Error('unexpected url ' + url);
  });
  const dispatched: { type: string; detail: unknown }[] = [];
  const storage: Record<string, string> = {};
  const localStorage = { getItem: (k: string) => storage[k] ?? null, setItem: vi.fn((k: string, v: string) => { storage[k] = v; }), removeItem: (k: string) => { delete storage[k]; } };
  const openBots = vi.fn(async () => undefined), openAgents = vi.fn(async () => undefined);
  const window: Record<string, unknown> = { addEventListener: vi.fn(), dispatchEvent: vi.fn((e: { type: string; detail: unknown }) => { dispatched.push({ type: e.type, detail: e.detail }); return true; }),
    ...(opts.workspace ? { EchoPrimeWorkspace: opts.workspace } : {}), ...(opts.bots === false ? {} : { EchoPrimeBots: { open: openBots } }), ...(opts.agents === false ? {} : { EchoPrimeAgents: { open: openAgents } }) };
  const context: Record<string, unknown> = { window, document, fetch, localStorage, Date, Error, Map, Set, Number, Math, String, Array, Object, Promise, JSON, encodeURIComponent, Event: FakeEvent, console: { debug: vi.fn(), log: console.log } };
  if (opts.customEvent !== false) context.CustomEvent = FakeEvent;
  runInNewContext(source, context);
  const api = window.EchoPrimeAutoagents as { render(result: unknown): Node[]; card(b: unknown): Node; badge(r: unknown): Node | null; explain(): Node; admission(): string; satellites(d: unknown): void; ORB_EVENT: string };
  return { api, log, calls, dispatched, localStorage, openBots, openAgents, created, window, document, ws: opts.workspace };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function click(root: Node, label: string) { const b = find(root, label); if (!b) throw new Error('no button ' + label + ' in: ' + buttons(root).map(x => x.textContent).join(', ')); await b.fire('click'); await settle(); }
const note = (card: Node) => all(card).find(n => n.attributes.role === 'status')!.textContent;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the chat card', () => {
  it('renders "Echo built an agent and a bot for this" with name, role, purpose, capabilities and tiers, lane, budget, steps, schedule, bot status and the origin badge', () => {
    const s = boot();
    const [card] = s.api.render({ autoagents: [built()] });
    expect(s.log.children).toEqual([card]); expect(s.log.hidden).toBe(false); expect(card.className).toContain('autoagent-card'); expect(card.attributes['data-autoagent']).toBe(SHA); expect(card.attributes['data-bot-id']).toBe(BOT);
    const shown = text(card);
    for (const expected of ['Echo built an agent and a bot for this', 'Echo-made from your prompt', 'Agent queue-scout', 'observer', 'Purpose Watch the FORGE build queue each morning', 'echo.knowledge.search tier 0', 'echo.context.recall tier 1',
      'Lane forge · qwen-local', 'Budget up to 40 calls, $0.00, 15 min', 'Max steps 12', 'Schedule every 60 min', 'Bot Queue scout', 'personal', 'idle', 'Daily cost cap $0.00 per day', 'so Echo resumed it', 'verify the capabilities and schedule'])
      expect(shown).toContain(expected);
    expect(shown).not.toContain('Approval needed'); expect(shown).not.toContain('already existed');
    expect(buttons(card).map(b => b.textContent)).toEqual(['Pause', 'Open in echoBots', 'Open agent', 'Delete']);
    const tiers = all(card).filter(n => n.className.startsWith('autoagent-tier ')).map(n => n.className);
    expect(tiers).toEqual(['autoagent-tier autoagent-tier-0', 'autoagent-tier autoagent-tier-1']);
  });
  it('shows the approval box with every reason and an "Approve and resume" button when the gate kept the bot paused', () => {
    const s = boot();
    const [card] = s.api.render({ autoagents: [built({ agent: agent({ capabilities: [{ id: 'echo.shell.run', tier: 2 }, { id: 'echo.odd.cap', tier: null }] }), bot: bot({ status: 'paused', autoResumed: false, approval: { required: true, reasons: ['echo.shell.run is tier 2 (auto-resume allows tier 0 or 1)', 'echo.odd.cap has no reported tier (treated as not auto-approvable)'] } }) })] });
    const shown = text(card);
    for (const expected of ['paused', 'Approval needed: the bot stays paused until you resume it.', 'echo.shell.run is tier 2', 'echo.odd.cap has no reported tier', 'echo.shell.run tier 2', 'echo.odd.cap tier unknown']) expect(shown).toContain(expected);
    expect(shown).not.toContain('so Echo resumed it');
    expect(buttons(card).map(b => b.textContent)).toEqual(['Approve and resume', 'Open in echoBots', 'Open agent', 'Delete']);
    expect(all(card).some(n => n.className === 'autoagent-tier autoagent-tier-unknown')).toBe(true);
  });
  it('renders an agent-only card, an "already existed" card and a plain paused card with the right titles and buttons', () => {
    const s = boot();
    const agentOnly = s.api.card(built({ tool: 'make_agent', bot: undefined }));
    expect(text(agentOnly)).toContain('Echo built an agent for this'); expect(text(agentOnly)).toContain('Schedule every 60 min');
    expect(buttons(agentOnly).map(b => b.textContent)).toEqual(['Open agent', 'Delete']);
    const existing = s.api.card(built({ agent: agent({ existing: true }), bot: bot({ existing: true, autoResumed: false }) }));
    expect(text(existing)).toContain('Echo already had an agent and a bot for this'); expect(text(existing).match(/already existed/g)).toHaveLength(2);
    const paused = s.api.card(built({ bot: bot({ status: 'paused', autoResumed: false, schedule: null }) }));
    expect(text(paused)).toContain('Paused: resume it when you are ready'); expect(text(paused)).toContain('Schedule on message only'); expect(find(paused, 'Resume')).toBeTruthy(); expect(find(paused, 'Pause')).toBeUndefined();
    expect(text(s.api.card(built({ agent: agent({ existing: true }), bot: undefined })))).toContain('Echo already had an agent for this');
  });
  it('Resume and Pause post to the owner-only bot routes with the Prime headers, update the status badge and the note, and tell the orb', async () => {
    const ws = workspaceStub(owner()); const s = boot({ workspace: ws });
    const [card] = s.api.render({ autoagents: [built({ bot: bot({ status: 'paused', autoResumed: false, approval: { required: true, reasons: ['echo.shell.run is tier 2'] } }) })] });
    await click(card, 'Approve and resume');
    expect(s.calls).toEqual([{ url: `/api/prime/bots/${BOT}/resume`, method: 'POST', body: {}, headers: { 'x-prime-request': '1', 'x-echo-csrf': 'csrf-owner', 'content-type': 'application/json' } }]);
    expect(text(card)).toContain('idle'); expect(text(card)).not.toContain('Approval needed'); expect(note(card)).toBe('Resumed Queue scout: status idle.');
    expect(buttons(card)[0].textContent).toBe('Pause');
    await click(card, 'Pause');
    expect(s.calls.at(-1)!.url).toBe(`/api/prime/bots/${BOT}/pause`); expect(text(card)).toContain('paused'); expect(note(card)).toBe('Paused Queue scout: status paused.'); expect(find(card, 'Resume')).toBeTruthy();
    expect(s.dispatched.every(d => d.type === s.api.ORB_EVENT)).toBe(true);
    expect(s.dispatched.map(d => (d.detail as { action: string }).action)).toEqual(['created', 'resume', 'pause']); // render announces the new bot, then each transition
  });
  it('a refused Resume keeps the card as it was, says so, and never retries or invalidates a member-less session', async () => {
    const s = boot({ responses: { [`/api/prime/bots/${BOT}/resume`]: { status: 502, body: { error: 'echoBots service unreachable at http://127.0.0.1:8378' } } } });
    const [card] = s.api.render({ autoagents: [built({ bot: bot({ status: 'paused', autoResumed: false }) })] });
    await click(card, 'Resume');
    expect(s.calls).toHaveLength(1); expect(text(card)).toContain('paused'); expect(find(card, 'Resume')).toBeTruthy();
    expect(note(card)).toBe('Resume failed: echoBots service unreachable at http://127.0.0.1:8378. No automatic retry was made.');
    expect(s.dispatched.map(d => (d.detail as { action: string }).action)).toEqual(['created']); // the failed resume announced nothing
  });
  it('deletes only after an inline two-step confirmation: bot first, then the agent definition; Cancel backs out without a request', async () => {
    const s = boot();
    const [card] = s.api.render({ autoagents: [built()] });
    await click(card, 'Delete');
    expect(s.calls).toHaveLength(0); expect(find(card, 'Confirm delete')).toBeTruthy(); expect(find(card, 'Cancel')).toBeTruthy(); expect(find(card, 'Delete')).toBeUndefined();
    expect(note(card)).toBe('Select Confirm delete to remove the bot and agent queue-scout, or Cancel.'); expect(text(card)).toContain('The bot is deleted first');
    await click(card, 'Cancel');
    expect(find(card, 'Confirm delete')).toBeUndefined(); expect(find(card, 'Delete')).toBeTruthy(); expect(s.calls).toHaveLength(0);
    await click(card, 'Delete'); await click(card, 'Confirm delete');
    expect(s.calls.map(c => c.url)).toEqual([`/api/prime/bots/${BOT}/delete`, '/api/prime/adk/agents/queue-scout/delete']);
    expect(s.calls.every(c => c.method === 'POST')).toBe(true);
    expect(text(card)).toContain('Echo removed this agent and its bot'); expect(note(card)).toBe('Deleted bot Queue scout and agent queue-scout (confirmed by the service).');
    expect(buttons(card)).toHaveLength(0);
    expect(s.dispatched.at(-1)).toEqual({ type: s.api.ORB_EVENT, detail: { source: 'autoagents', action: 'delete', botId: BOT } });
  });
  it('a delete that fails at the agent step reports how far it got and makes no retry; an agent-only card deletes just the definition', async () => {
    const s = boot({ responses: { '/api/prime/adk/agents/queue-scout/delete': { status: 400, body: { error: 'Echo ADK answered HTTP 409 (invalid): a bot references this agent' } } } });
    const [card] = s.api.render({ autoagents: [built()] });
    await click(card, 'Delete'); await click(card, 'Confirm delete');
    expect(s.calls).toHaveLength(2);
    expect(note(card)).toBe('Delete stopped after bot Queue scout: Echo ADK answered HTTP 409 (invalid): a bot references this agent. No automatic retry was made.');
    expect(text(card)).not.toContain('Echo removed'); expect(find(card, 'Delete')).toBeTruthy(); expect(find(card, 'Open in echoBots')).toBeUndefined();
    const only = boot(); const agentOnly = only.api.card(built({ bot: undefined }));
    await click(agentOnly, 'Delete'); expect(note(agentOnly)).toBe('Select Confirm delete to remove agent queue-scout, or Cancel.'); await click(agentOnly, 'Confirm delete');
    expect(only.calls.map(c => c.url)).toEqual(['/api/prime/adk/agents/queue-scout/delete']); expect(text(agentOnly)).toContain('Echo removed this agent'); expect(text(agentOnly)).not.toContain('and its bot');
  });
  it('Open in echoBots remembers the bot for the echoBots view and opens it; Open agent opens the Agents view; missing views are explained', async () => {
    const s = boot();
    const [card] = s.api.render({ autoagents: [built()] });
    await click(card, 'Open in echoBots');
    expect(s.localStorage.setItem).toHaveBeenCalledWith('echo-prime-bot-v1', BOT); expect(s.openBots).toHaveBeenCalledTimes(1);
    await click(card, 'Open agent'); expect(s.openAgents).toHaveBeenCalledTimes(1);
    expect(s.calls).toHaveLength(0);
    const bare = boot({ bots: false, agents: false }); const [c2] = bare.api.render({ autoagents: [built()] });
    await click(c2, 'Open in echoBots'); expect(note(c2)).toBe('Bot ' + BOT + '. Open it in the echoBots view once that view is installed.');
    await click(c2, 'Open agent'); expect(note(c2)).toBe('Agent queue-scout. Open it in the Agents view once that view is installed.');
  });
  it('dispatches echo-orb-satellites when a newly created bot is rendered, not for an existing one, and survives a runtime without CustomEvent', () => {
    const s = boot();
    s.api.render({ autoagents: [built(), built({ bot: bot({ existing: true }) }), built({ bot: undefined })] });
    expect(s.dispatched).toEqual([{ type: 'echo-orb-satellites', detail: { source: 'autoagents', action: 'created', botId: BOT, status: 'idle' } }]);
    const legacy = boot({ customEvent: false });
    legacy.api.render({ autoagents: [built()] });
    expect(legacy.dispatched).toEqual([{ type: 'echo-orb-satellites', detail: { source: 'autoagents', action: 'created', botId: BOT, status: 'idle' } }]);
    legacy.api.satellites({ source: 'bots', action: 'created', botId: BOT, status: 'paused' });
    expect(legacy.dispatched).toHaveLength(2);
  });
});

describe('admission and malformed payloads', () => {
  it('a signed-in member sees one explanation that only the owner can create agents, with no buttons and no request', () => {
    const s = boot({ workspace: workspaceStub(member()) });
    const nodes = s.api.render({ autoagents: [built(), built()] });
    expect(nodes).toHaveLength(1); expect(s.log.children).toEqual(nodes); expect(nodes[0].className).toContain('autoagent-explain');
    expect(text(nodes[0])).toContain('Agents and bots are owner-only'); expect(text(nodes[0])).toContain('Echo builds agents and bots only for the primary owner. Nothing was created for your account');
    expect(buttons(nodes[0])).toHaveLength(0); expect(s.calls).toHaveLength(0); expect(s.dispatched).toHaveLength(0);
    expect(s.api.admission()).toBe('member');
    const visitor = boot({ workspace: workspaceStub(anonymous()) });
    expect(visitor.api.admission()).toBe('signin'); expect(visitor.api.render({ autoagents: [built()] })[0].className).toContain('autoagent-explain');
    expect(boot({ workspace: workspaceStub(owner()) }).api.admission()).toBe('owner'); expect(boot().api.admission()).toBe('open');
  });
  it('ignores malformed autoagents payloads without touching the log', () => {
    const s = boot();
    for (const bad of [undefined, null, 'x', {}, { autoagents: 'none' }, { autoagents: [] }, { autoagents: [{ kind: 'other', agent: agent() }] }, { autoagents: [{ kind: 'autoagent', agent: { name: 'Bad Name' } }] }, { autoagents: [{ kind: 'autoagent', agent: agent(), bot: { botId: 'short' } }] }, { autoagents: [null, 5] }])
      expect(s.api.render(bad)).toEqual([]);
    expect(s.log.children).toHaveLength(0); expect(s.log.hidden).toBe(true); expect(s.calls).toHaveLength(0);
    expect(s.api.render({ autoagents: [built({ bot: { ...bot(), botId: undefined, bot_id: BOT } })] })).toHaveLength(1); // the service spelling is accepted too
  });
  it('badge() marks only records whose origin.by is echo', () => {
    const s = boot();
    const b = s.api.badge({ name: 'x', origin: { by: 'echo', prompt_sha256: SHA } })!;
    expect(b.textContent).toBe('Echo-made from your prompt'); expect(b.className).toBe('autoagent-badge'); expect(b.attributes.title).toContain(SHA.slice(0, 12));
    for (const record of [{ origin: { by: 'owner' } }, { origin: 'echo' }, {}, null, undefined, { origin: { by: 'Echo' } }]) expect(s.api.badge(record)).toBeNull();
  });
});

describe('badges in the Agents and echoBots views', () => {
  it('agents.js shows "Echo-made from your prompt" on definitions with origin.by === "echo" and nothing on owner-made ones', async () => {
    const IDS = ['agents-dialog', 'open-agents', 'close-agents', 'refresh-agents', 'agents-status', 'agents-list', 'agents-form', 'agents-agent', 'agents-prompt', 'agents-calls', 'agents-cost', 'agents-wall', 'agents-submit', 'agents-run', 'agents-runs'];
    const nodes: Record<string, Node> = Object.fromEntries(IDS.map(id => [id, new Node(id === 'agents-dialog' ? 'dialog' : id === 'agents-form' ? 'form' : id === 'agents-agent' ? 'select' : 'div')]));
    for (const id of IDS) nodes[id].attributes.id = id;
    const document: any = { hidden: false, querySelector: (s: string) => nodes[s.slice(1)] ?? null, createElement: (t: string) => new Node(t), addEventListener: vi.fn() };
    const agents = [{ name: 'queue-scout', role: 'observer', capabilities: ['echo.knowledge.search'], lane: { node: 'forge', model: 'qwen-local' }, origin: { by: 'echo', prompt_sha256: SHA } }, { name: 'researcher', role: 'Finds facts', capabilities: ['echo.knowledge.search'], origin: { by: 'owner' } }];
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/prime/adk/health') return json(200, { configured: true, available: true, defaultBudget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 }, service: { profile: 'ECHO_ADK', version: '0.2.0', runsActive: 0 } });
      if (url === '/api/prime/adk/agents') return json(200, { agents });
      if (url === '/api/prime/adk/runs?limit=20') return json(200, { runs: [] });
      throw new Error('unexpected ' + url);
    });
    const window: Record<string, unknown> = { addEventListener: vi.fn() };
    runInNewContext(agentsSource, { window, document, fetch, localStorage: { getItem: () => null, setItem: () => undefined }, setTimeout, clearTimeout, Date, AbortController, Error, Number, String, Math, JSON, Promise, Array, Object, console: { debug: vi.fn(), log: console.log } });
    await (window.EchoPrimeAgents as { open(): Promise<void> }).open();
    const cards = nodes['agents-list'].children;
    expect(cards).toHaveLength(2);
    expect(text(cards[0])).toContain('Echo-made from your prompt'); expect(all(cards[0]).some(n => n.className === 'autoagent-badge')).toBe(true);
    expect(text(cards[1])).not.toContain('Echo-made from your prompt');
  });
  it('bots.js shows the badge on a bot whose record carries origin.by === "echo" and tells the orb when a bot is created from its form', async () => {
    const created: Node[] = [], nav = new Node('nav'), body = new Node('body');
    const document: any = { hidden: false, body, querySelector: (s: string) => s === 'nav[aria-label="Workspace"]' ? nav : null, createElement: (tag: string) => { const n = new Node(tag); created.push(n); return n; }, addEventListener: vi.fn() };
    const bots = [{ bot_id: BOT, name: 'Queue scout', agent: 'queue-scout', mode: 'personal', status: 'paused', schedule: null, plugins: [], daily_cost_cap_usd: 0, spent_today_usd: 0, inbox_depth: 0, created_at: '2026-11-04T21:00:00Z', origin: { by: 'echo', prompt_sha256: SHA } },
      { bot_id: 'b'.repeat(32), name: 'Docs bot', agent: 'docs', mode: 'personal', status: 'idle', schedule: null, plugins: [], daily_cost_cap_usd: 0, spent_today_usd: 0, inbox_depth: 0, created_at: '2026-11-04T21:00:00Z' }];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === '/api/prime/bots/health') return json(200, { configured: true, available: true, defaultBudget: { max_calls: 80, max_cost_usd: 0, max_wall_s: 1800 }, service: { version: '0.2.0', bots: 2, agents: 2, runsActive: 0 } });
      if (url === '/api/prime/bots/list') return json(200, { bots });
      if (url === '/api/prime/adk/agents') return json(405, { error: 'JSON POST required' });
      if (url === '/api/prime/bots/create') { const b = JSON.parse(init!.body!); return json(201, { bot_id: 'c'.repeat(32), name: b.name, agent: b.agent, mode: 'personal', status: 'paused', schedule: null, plugins: [], daily_cost_cap_usd: 0, spent_today_usd: 0, inbox_depth: 0 }); }
      if (/\/messages\?/.test(url)) return json(200, { botId: 'c'.repeat(32), messages: [] });
      throw new Error('unexpected ' + url);
    });
    const satellites = vi.fn();
    const window: Record<string, unknown> = { addEventListener: vi.fn(), EchoPrimeAutoagents: { satellites } };
    runInNewContext(botsSource, { window, document, fetch, localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, setTimeout, clearTimeout, Date, AbortController, Error, Map, Set, Number, Math, String, Array, Object, Promise, JSON, encodeURIComponent, console: { debug: vi.fn(), log: console.log } });
    const api = window.EchoPrimeBots as { ready: Promise<unknown>; open(): Promise<void> };
    await api.ready; await api.open(); for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const dialog = created.find(n => n.attributes.id === 'bots-dialog')!;
    const cards = all(dialog).filter(n => n.className.startsWith('bots-card ') || n.className === 'bots-card');
    expect(cards).toHaveLength(2);
    expect(text(cards[0])).toContain('Echo-made from your prompt'); expect(all(cards[0]).some(n => n.className === 'bots-badge autoagent-badge')).toBe(true);
    expect(text(cards[1])).not.toContain('Echo-made from your prompt');
    await find(dialog, 'New bot')!.fire('click'); for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const pane = created.find(n => n.attributes.id === 'bots-pane')!;
    all(pane).find(n => (n.attributes.placeholder ?? '').startsWith('Bot name'))!.value = 'Night watch'; all(pane).find(n => (n.attributes.placeholder ?? '').startsWith('Echo ADK agent name'))!.value = 'watcher';
    await find(pane, 'Create bot (starts paused)')!.fire('click'); for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    expect(satellites).toHaveBeenCalledWith({ source: 'bots', action: 'created', botId: 'c'.repeat(32), status: 'paused' });
  });
});
