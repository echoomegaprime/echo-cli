import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { BotsClient, BotsError, DEFAULT_BOTS, clampBotsBudget, parseBotCreate, parseBotsConfig, parseGroupCreate } from '../src/prime/bots.js';

// Stand-in for the loopback echo-adk-api service: the echoBots and groups routes of docs/echo-code/ECHO_ADK_API_CONTRACT.md,
// with every request recorded. No real service, agent or model is ever called.
const BOT = 'a'.repeat(32), BOT2 = 'b'.repeat(32), BOT3 = 'c'.repeat(32), GROUP = 'd'.repeat(32), MSG = 'e'.repeat(32), RUN = 'f'.repeat(32);
const automationHealth = { contract_version: 2, features: { calendar_schedules: true, idempotent_events: true, memory_recall: true }, budgets: { daily_cap_usd: 200, spent_today_usd: 1, reserved_usd: 2, available_usd: 197 }, connections: { memory: { provider: 'local', recall: true, durable: true, shared: false }, browser: { available: false, reason: 'No isolated browser provider is configured' } } };
type Seen = { method: string; url: string; body: string };
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function stopLast() { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
const bot = (over: Record<string, unknown> = {}) => ({
  bot_id: BOT, name: 'Release scout', agent: 'release-scout', mode: 'team', status: 'paused', schedule: { every_s: 900 }, instruction: 'Watch the release queue.',
  plugins: ['git-status', 'changelog'], memory: { scope: 'bot:' + BOT }, lease: { scopes: ['echo.builds.recent'], max_uses: 50, ttl_s: 3600 },
  daily_cost_cap_usd: 1, spent_today_usd: 0.12, inbox_depth: 2, last_run_at: '2026-11-04T10:00:00Z', last_error: null, created_at: '2026-11-04T09:00:00Z', ...over });
async function fakeService(handler?: Handler) {
  const seen: Seen[] = [];
  const bots = new Map<string, Record<string, unknown>>([[BOT, bot()], [BOT2, bot({ bot_id: BOT2, name: 'Second', status: 'idle' })]]);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      if (handler) { handler(req, res, entry); return; }
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const fail = (status: number, error: string, message: string) => json(status, { error, message });
      const url = new URL(entry.url, 'http://x'), path = url.pathname.replace(/^\/v2\//, '/'), m = entry.method;
      const parsed = entry.body ? JSON.parse(entry.body) as Record<string, unknown> : {};
      let match: RegExpExecArray | null;
      if (m === 'GET' && path === '/health') return json(200, { ok: true, service: 'echo-adk-api', profile: 'ECHO_ADK', version: '0.1.0', agents: 2, bots: bots.size, runs_active: 0, ...automationHealth });
      if (m === 'GET' && path === '/bots') return json(200, { bots: [...bots.values()] });
      if (m === 'POST' && path === '/bots') {
        if (typeof parsed.name !== 'string' || parsed.name.length > 64) return fail(422, 'invalid', 'name');
        const created = bot({ bot_id: BOT3, name: parsed.name, agent: parsed.agent, mode: parsed.mode ?? 'personal', status: 'paused', schedule: parsed.schedule ?? null, plugins: parsed.plugins ?? [], daily_cost_cap_usd: parsed.daily_cost_cap_usd, spent_today_usd: 0, inbox_depth: 0, last_run_at: undefined });
        bots.set(BOT3, created); return json(201, created);
      }
      if ((match = /^\/bots\/([0-9a-f]{32})$/.exec(path))) {
        const row = bots.get(match[1]); if (!row) return fail(404, 'not_found', 'no such bot');
        if (m === 'GET') return json(200, row);
        if (m === 'DELETE') { bots.delete(match[1]); return json(200, { bot_id: match[1], deleted: true }); }
      }
      if (m === 'POST' && (match = /^\/bots\/([0-9a-f]{32})\/(pause|resume)$/.exec(path))) {
        const row = bots.get(match[1]); if (!row) return fail(404, 'not_found', 'no such bot');
        const next = { ...row, status: match[2] === 'pause' ? 'paused' : 'idle' }; bots.set(match[1], next); return json(200, next);
      }
      if (m === 'POST' && (match = /^\/bots\/([0-9a-f]{32})\/message$/.exec(path))) {
        if (!bots.has(match[1])) return fail(404, 'not_found', 'no such bot');
        if (typeof parsed.text !== 'string' || parsed.text.length > 12000) return fail(422, 'invalid', 'text');
        return json(202, { message_id: MSG, run_id: RUN });
      }
      if (m === 'GET' && (match = /^\/bots\/([0-9a-f]{32})\/messages$/.exec(path))) {
        if (!bots.has(match[1])) return fail(404, 'not_found', 'no such bot');
        const all = [{ message_id: '1'.repeat(32), role: 'user', text: 'status?', created_at: '2026-11-04T10:00:00Z' }, { message_id: MSG, role: 'bot', text: 'Two builds pending.', created_at: '2026-11-04T10:00:05Z', run_id: RUN }];
        return json(200, { messages: url.searchParams.get('since') ? all.slice(1) : all });
      }
      if (m === 'POST' && path === '/groups') {
        if (!Array.isArray(parsed.bots) || parsed.bots.length < 2 || parsed.bots.length > 6) return fail(422, 'invalid', 'bots');
        return json(202, { group_id: GROUP, run_ids: [RUN, '9'.repeat(32)] });
      }
      if (m === 'GET' && path === `/groups/${GROUP}`) return json(200, { group_id: GROUP, name: 'Standup', bots: [BOT, BOT2], status: 'done', messages: [{ bot_id: BOT, text: 'Release looks clear.', created_at: '2026-11-04T10:01:00Z' }, { bot_id: BOT2, text: 'Docs lag by one PR.', created_at: '2026-11-04T10:01:04Z' }], summary: 'Ship; docs follow.' });
      return fail(404, 'not_found', 'unknown route');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_q, res) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const clientFor = async (h?: Handler) => { const w = await fakeService(h); return { client: new BotsClient({ ...DEFAULT_BOTS, baseUrl: w.url }), seen: w.seen, url: w.url }; };

describe('bots config, budget and request validation', () => {
  it('accepts calendar schedules with an explicit timezone and rejects ambiguous or malformed schedules', () => {
    const calendar = { at: '09:00', tz: 'America/Chicago', weekdays: [1, 2, 3, 4, 5], missed: 'skip' };
    expect(parseBotCreate({ name: 'Morning', agent: 'scout', schedule: calendar }, 0).schedule).toEqual(calendar);
    expect(parseBotCreate({ name: 'Morning', agent: 'scout', schedule: { at: '09:00', tz: 'UTC', weekdays: [7] } }, 0).schedule).toEqual({ at: '09:00', tz: 'UTC', weekdays: [7], missed: 'skip' });
    for (const schedule of [{ ...calendar, every_s: 60 }, { ...calendar, at: '24:00' }, { ...calendar, tz: 'Not/AZone' }, { ...calendar, weekdays: [] }, { ...calendar, weekdays: [0, 1] }, { ...calendar, weekdays: [1, 1] }, { ...calendar, missed: 'all' }, { ...calendar, missed: null }, { every_s: 604801 }])
      expect(() => parseBotCreate({ name: 'Morning', agent: 'scout', schedule }, 0)).toThrow(BotsError);
    expect(parseBotCreate({ name: 'Morning', agent: 'scout', schedule: { every_s: 604800, missed: 'once' } }, 0).schedule).toEqual({ every_s: 604800, missed: 'once' });
  });
  it('defaults to the loopback service on 8378 and refuses anything else', () => {
    expect(parseBotsConfig({})).toEqual({ baseUrl: 'http://127.0.0.1:8378', defaultBudget: DEFAULT_BOTS.defaultBudget });
    expect(parseBotsConfig({ baseUrl: 'http://localhost:9000' }).baseUrl).toBe('http://localhost:9000');
    for (const bad of ['http://192.168.1.220:8378', 'https://forge.example', 'http://user:pw@127.0.0.1:8378', 'http://127.0.0.1:8378/bots', 'http://127.0.0.1:8378/?x=1', 5])
      expect(() => parseBotsConfig({ baseUrl: bad })).toThrow(/loopback origin|baseUrl/);
    expect(() => parseBotsConfig({ token: 'x' })).toThrow(/unknown field/);
    expect(() => parseBotsConfig('on')).toThrow(/object/);
    expect(() => parseBotsConfig({ defaultBudget: { max_cost_usd: 'free' } })).toThrow(/defaultBudget/);
  });
  it('clamps the budget to the service maxima, defaults cost to 0 (local lane) and never exceeds 5 USD', () => {
    expect(clampBotsBudget(undefined)).toEqual({ max_calls: 80, max_cost_usd: 0, max_wall_s: 1800 });
    expect(clampBotsBudget({ max_calls: 9999, max_cost_usd: 50, max_wall_s: 99999 })).toEqual({ max_calls: 120, max_cost_usd: 5, max_wall_s: 4800 });
    expect(clampBotsBudget({ max_calls: -5, max_cost_usd: -1, max_wall_s: 1 })).toEqual({ max_calls: 1, max_cost_usd: 0, max_wall_s: 30 });
    for (const bad of [{ max_calls: '5' }, { max_cost_usd: NaN }, { extra: 1 }, [], 'big']) expect(() => clampBotsBudget(bad)).toThrow(BotsError);
  });
  it('refuses, never clamps, a bot that breaks the contract limits: name > 64, every_s < 60, daily cap > 5, unknown fields', () => {
    const ok = parseBotCreate({ name: ' Scout ', agent: 'release-scout', mode: 'team', schedule: { every_s: 60 }, instruction: 'x', plugins: ['a', 'a', 'b'], lease: { scopes: ['echo.builds.recent'], ttl_s: 60, max_uses: 3 }, daily_cost_cap_usd: 2.499 }, 0);
    expect(ok).toEqual({ name: 'Scout', agent: 'release-scout', mode: 'team', schedule: { every_s: 60 }, instruction: 'x', plugins: ['a', 'b'], lease: { scopes: ['echo.builds.recent'], ttl_s: 60, max_uses: 3 }, daily_cost_cap_usd: 2.5 });
    expect(parseBotCreate({ name: 'n', agent: 'a' }, 0.75)).toEqual({ name: 'n', agent: 'a', daily_cost_cap_usd: 0.75 });
    expect(parseBotCreate({ name: 'n', agent: 'a', schedule: null }, 0).schedule).toBeNull();
    const refused: [unknown, RegExp][] = [
      [{ name: 'x'.repeat(65), agent: 'a' }, /exceeds 64/], [{ name: '   ', agent: 'a' }, /Invalid bot name/], [{ agent: 'a' }, /Invalid bot name/],
      [{ name: 'n', agent: '../x' }, /agent/], [{ name: 'n' }, /agent/], [{ name: 'n', agent: 'a', mode: 'shared' }, /mode/],
      [{ name: 'n', agent: 'a', schedule: { every_s: 59 } }, /at least 60/], [{ name: 'n', agent: 'a', schedule: { every_s: 60.5 } }, /at least 60/], [{ name: 'n', agent: 'a', schedule: { cron: '* *' } }, /unknown field/],
      [{ name: 'n', agent: 'a', daily_cost_cap_usd: 5.01 }, /exceeds 5/], [{ name: 'n', agent: 'a', daily_cost_cap_usd: -1 }, /daily cost cap/], [{ name: 'n', agent: 'a', daily_cost_cap_usd: '1' }, /daily cost cap/],
      [{ name: 'n', agent: 'a', instruction: 'x'.repeat(12001) }, /exceeds 12000/], [{ name: 'n', agent: 'a', plugins: ['ok', 5] }, /plugins/], [{ name: 'n', agent: 'a', plugins: 'git' }, /plugins/],
      [{ name: 'n', agent: 'a', lease: { scopes: ['not-a-cap'], ttl_s: 1, max_uses: 1 } }, /exact capability ids/], [{ name: 'n', agent: 'a', lease: { scopes: ['echo.x'], ttl_s: 0, max_uses: 1 } }, /ttl_s/],
      [{ name: 'n', agent: 'a', lease: { scopes: ['echo.x'], ttl_s: 1, max_uses: 1, token: 't' } }, /unknown field/], [{ name: 'n', agent: 'a', token: 'x' }, /unknown field/], ['bot', /Invalid bot request/]];
    for (const [input, message] of refused) expect(() => parseBotCreate(input, 0)).toThrow(message);
  });
  it('refuses a group outside 2..6 bots, duplicate bots, bad ids and over-long prompts', () => {
    expect(parseGroupCreate({ name: 'Standup', bots: [BOT, BOT2], prompt: 'Status?' })).toEqual({ name: 'Standup', bots: [BOT, BOT2], prompt: 'Status?' });
    expect(parseGroupCreate({ name: 'Six', bots: ['0', '1', '2', '3', '4', '5'].map(c => c.repeat(32)), prompt: 'p' }).bots).toHaveLength(6);
    for (const bad of [{ name: 'g', bots: [BOT], prompt: 'p' }, { name: 'g', bots: ['0', '1', '2', '3', '4', '5', '6'].map(c => c.repeat(32)), prompt: 'p' }, { name: 'g', bots: [BOT, BOT], prompt: 'p' },
      { name: 'g', bots: [BOT, 'A'.repeat(32)], prompt: 'p' }, { name: 'g', bots: [BOT, BOT2], prompt: 'x'.repeat(12001) }, { name: 'g', bots: [BOT, BOT2], prompt: '' }, { name: '', bots: [BOT, BOT2], prompt: 'p' },
      { name: 'g', bots: [BOT, BOT2], prompt: 'p', lease: {} }, { name: 'g', bots: 'all', prompt: 'p' }])
      expect(() => parseGroupCreate(bad)).toThrow(BotsError);
  });
});

describe('BotsClient against a stand-in service', () => {
  it('requires v2 health and never retries a calendar mutation against legacy routes', async () => {
    const legacy = await clientFor(reply(404, { error: 'not_found', message: 'unknown route' }));
    await expect(legacy.client.health()).rejects.toMatchObject({ code: 'unsupported_contract', message: /API v2 is unavailable/ });
    await expect(legacy.client.create({ name: 'Morning', agent: 'scout', schedule: { at: '09:00', tz: 'UTC', weekdays: [1] } })).rejects.toMatchObject({ status: 404 });
    expect(legacy.seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /v2/health', 'POST /v2/bots']);
    await expect((await clientFor(reply(200, { ok: true, profile: 'ECHO_ADK', contract_version: 1 }))).client.health()).rejects.toMatchObject({ code: 'unsupported_contract' });
  });
  it('validates idempotent event identifiers and receipts without a preliminary request or retry', async () => {
    const event = { event_id: 'github:push/123', source: 'github', text: 'Review this change' };
    const accepted = await clientFor(reply(202, { event_id: event.event_id, message_id: MSG, run_id: RUN, duplicate: true, status: 'queued' }));
    expect(await accepted.client.event(BOT, event)).toEqual({ botId: BOT, eventId: event.event_id, messageId: MSG, runId: RUN, duplicate: true, status: 'queued' });
    expect(accepted.seen).toHaveLength(1); expect(accepted.seen[0].url).toBe(`/v2/bots/${BOT}/events`); expect(JSON.parse(accepted.seen[0].body)).toEqual(event);
    for (const bad of [{ ...event, event_id: 'x'.repeat(129) }, { ...event, source: 'GitHub' }, { ...event, source: '../x' }, { ...event, text: '' }, { ...event, resume: true }])
      await expect(accepted.client.event(BOT, bad)).rejects.toMatchObject({ status: 400 });
    expect(accepted.seen).toHaveLength(1);
    const wrong = await clientFor(reply(202, { event_id: 'different', message_id: MSG, run_id: RUN, duplicate: false, status: 'queued' }));
    await expect(wrong.client.event(BOT, event)).rejects.toMatchObject({ status: 502, message: /invalid event receipt/ }); expect(wrong.seen).toHaveLength(1);
  });
  it('returns the original completed run for a duplicate event and rejects invented receipt states', async () => {
    const event = { event_id: 'push-1', source: 'github', text: 'Review' };
    for (const status of ['queued', 'running', 'gated', 'done', 'failed', 'unavailable']) {
      const duplicate = await clientFor(reply(202, { event_id: event.event_id, message_id: MSG, run_id: RUN, duplicate: true, status }));
      expect(await duplicate.client.event(BOT, event)).toEqual({ botId: BOT, eventId: event.event_id, messageId: MSG, runId: RUN, duplicate: true, status });
      expect(duplicate.seen).toHaveLength(1);
    }
    for (const receipt of [{ duplicate: true, status: 'cancelled' }, { duplicate: false, status: 'done' }]) {
      const wrong = await clientFor(reply(202, { event_id: event.event_id, message_id: MSG, run_id: RUN, ...receipt }));
      await expect(wrong.client.event(BOT, event)).rejects.toMatchObject({ status: 502, message: /invalid event receipt/ });
    }
  });
  it('reads health and refuses a service that is unhealthy, another profile, not JSON, redirecting, oversized, down or stalled', async () => {
    const { client } = await clientFor();
    expect(await client.health()).toEqual({ service: 'echo-adk-api', version: '0.1.0', profile: 'ECHO_ADK', agents: 2, bots: 2, runsActive: 0, ...automationHealth });
    await expect((await clientFor(reply(200, { ok: true, profile: 'MAXIMALIST_RECONSTRUCTED' }))).client.health()).rejects.toMatchObject({ status: 502, message: /unexpected profile/ });
    await expect((await clientFor(reply(200, { ok: false, profile: 'ECHO_ADK' }))).client.health()).rejects.toMatchObject({ message: /not healthy/ });
    await expect((await clientFor(reply(200, 'not json'))).client.health()).rejects.toMatchObject({ status: 502, message: /unrecognized/ });
    await expect((await clientFor(reply(302, '', { location: 'http://127.0.0.1:1/' }))).client.health()).rejects.toMatchObject({ status: 502, message: /unreachable/ });
    await expect((await clientFor(reply(200, 'x'.repeat(1048577)))).client.list()).rejects.toMatchObject({ status: 502, message: /1 MiB/ });
    const w = await fakeService(); const url = w.url; await stopLast();
    await expect(new BotsClient({ ...DEFAULT_BOTS, baseUrl: url }).health()).rejects.toMatchObject({ status: 502, message: `echoBots service unreachable at ${url}` });
    const slow = await fakeService(() => { /* never answers */ });
    await expect(new BotsClient({ ...DEFAULT_BOTS, baseUrl: slow.url }, { health: 60, mutate: 60, poll: 60 }).list()).rejects.toMatchObject({ status: 504, message: /timed out.*outcome unknown/ });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    await expect(new BotsClient({ ...DEFAULT_BOTS, baseUrl: slow.url }).list(controller.signal)).rejects.toMatchObject({ status: 499, message: 'Interrupted' });
  });
  it('runs a bot lifecycle through exactly the contract routes: list, create (201, paused), get, pause, resume, message (202), messages?since=, delete', async () => {
    const { client, seen } = await clientFor();
    expect((await client.list()).bots.map(b => b.bot_id)).toEqual([BOT, BOT2]);
    const created = await client.create({ name: 'Docs bot', agent: 'docs', schedule: { every_s: 120 }, plugins: ['changelog'], daily_cost_cap_usd: 0.5 });
    expect(created).toMatchObject({ bot_id: BOT3, name: 'Docs bot', status: 'paused', schedule: { every_s: 120 }, daily_cost_cap_usd: 0.5 });
    expect(JSON.parse(seen[1].body)).toEqual({ name: 'Docs bot', agent: 'docs', schedule: { every_s: 120 }, plugins: ['changelog'], daily_cost_cap_usd: 0.5 });
    expect(await client.get(BOT)).toMatchObject({ bot_id: BOT, name: 'Release scout', spent_today_usd: 0.12, inbox_depth: 2 });
    expect((await client.pause(BOT2)).status).toBe('paused');
    expect((await client.resume(BOT2)).status).toBe('idle');
    expect(await client.message(BOT, { text: 'status?' })).toEqual({ botId: BOT, messageId: MSG, runId: RUN });
    expect(JSON.parse(seen[5].body)).toEqual({ text: 'status?' });
    const all = await client.messages(BOT, { limit: 50 });
    expect(all.messages).toHaveLength(2); expect(all.messages[1]).toMatchObject({ message_id: MSG, role: 'bot', run_id: RUN });
    expect((await client.messages(BOT, { since: '1'.repeat(32) })).messages).toHaveLength(1);
    expect(await client.remove(BOT3)).toEqual({ botId: BOT3, deleted: true });
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /v2/bots', 'POST /v2/bots', `GET /v2/bots/${BOT}`, `POST /v2/bots/${BOT2}/pause`, `POST /v2/bots/${BOT2}/resume`, `POST /bots/${BOT}/message`,
      `GET /bots/${BOT}/messages?limit=50`, `GET /bots/${BOT}/messages?since=${'1'.repeat(32)}`, `DELETE /bots/${BOT3}`]);
    expect(seen.every(s => s.method !== 'POST' || s.body === '' || s.body.startsWith('{'))).toBe(true);
  });
  it('creates and reads a group of 2..6 bots', async () => {
    const { client, seen } = await clientFor();
    expect(await client.createGroup({ name: 'Standup', bots: [BOT, BOT2], prompt: 'Status?' })).toEqual({ groupId: GROUP, runIds: [RUN, '9'.repeat(32)], name: 'Standup', bots: [BOT, BOT2] });
    expect(JSON.parse(seen[0].body)).toEqual({ name: 'Standup', bots: [BOT, BOT2], prompt: 'Status?' });
    expect(await client.group(GROUP)).toMatchObject({ group_id: GROUP, status: 'done', summary: 'Ship; docs follow.', messages: [{ bot_id: BOT }, { bot_id: BOT2 }] });
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual(['POST /groups', `GET /groups/${GROUP}`]);
  });
  it('never builds a URL from an id that is not 32 lowercase hex characters, nor from an invalid message, limit or group', async () => {
    const { client, seen } = await clientFor();
    for (const id of ['../health', '..%2fhealth', 'a/b', `${BOT}/x`, `${BOT}?x=1`, 'A'.repeat(32), 'a'.repeat(31), 'http://evil.example/', '', 'bot-1']) {
      await expect(client.get(id)).rejects.toMatchObject({ status: 400 });
      await expect(client.pause(id)).rejects.toMatchObject({ status: 400 });
      await expect(client.resume(id)).rejects.toMatchObject({ status: 400 });
      await expect(client.remove(id)).rejects.toMatchObject({ status: 400 });
      await expect(client.message(id, { text: 'x' })).rejects.toMatchObject({ status: 400 });
      await expect(client.messages(id)).rejects.toMatchObject({ status: 400 });
      await expect(client.group(id)).rejects.toMatchObject({ status: 400 });
    }
    await expect(client.messages(BOT, { since: 'abc' })).rejects.toMatchObject({ status: 400, message: /message id/ });
    await expect(client.messages(BOT, { limit: 201 })).rejects.toMatchObject({ status: 400, message: /1 to 200/ });
    await expect(client.messages(BOT, { limit: 0 })).rejects.toMatchObject({ status: 400 });
    for (const bad of [{}, { text: '' }, { text: '  ' }, { text: 5 }, { text: 'x'.repeat(12001) }, { text: 'ok', run_id: RUN }, 'hi'])
      await expect(client.message(BOT, bad)).rejects.toMatchObject({ status: 400 });
    for (const bad of [{ name: 'g', bots: [BOT], prompt: 'p' }, { name: 'g', bots: [BOT, BOT], prompt: 'p' }, { name: 'x'.repeat(65), bots: [BOT, BOT2], prompt: 'p' }])
      await expect(client.createGroup(bad)).rejects.toMatchObject({ status: 400 });
    await expect(client.create({ name: 'n', agent: 'a', daily_cost_cap_usd: 9 })).rejects.toMatchObject({ status: 400, message: /exceeds 5/ });
    expect(seen).toHaveLength(0);
  });
  it('refuses a service that returns a bad bot id, another bot, bad message ids, an unconfirmed delete or another group', async () => {
    const bad = async (h: Handler) => (await clientFor(h)).client;
    await expect((await bad(reply(201, bot({ bot_id: '../../x' })))).create({ name: 'n', agent: 'a' })).rejects.toMatchObject({ status: 502, message: /invalid bot id/ });
    await expect((await bad(reply(200, bot({ bot_id: BOT2 })))).get(BOT)).rejects.toMatchObject({ status: 502, message: /different bot/ });
    await expect((await bad(reply(200, { bots: [bot(), { name: 'no id' }] }))).list()).rejects.toMatchObject({ status: 502, message: /invalid bot id/ });
    await expect((await bad(reply(200, { bots: 'none' }))).list()).rejects.toMatchObject({ status: 502, message: /unrecognized bot list/ });
    await expect((await bad(reply(202, { message_id: 'short', run_id: RUN }))).message(BOT, { text: 'x' })).rejects.toMatchObject({ status: 502, message: /invalid message or run id/ });
    await expect((await bad(reply(200, { messages: [{ message_id: MSG, role: 'bot', text: 'x', run_id: 'nope' }] }))).messages(BOT)).rejects.toMatchObject({ status: 502, message: /invalid run id/ });
    await expect((await bad(reply(200, { bot_id: BOT, deleted: false }))).remove(BOT)).rejects.toMatchObject({ status: 502, message: /did not confirm/ });
    await expect((await bad(reply(200, { group_id: 'e'.repeat(32), status: 'done' }))).group(GROUP)).rejects.toMatchObject({ status: 502, message: /different group/ });
    await expect((await bad(reply(202, { group_id: GROUP, run_ids: ['bad'] }))).createGroup({ name: 'g', bots: [BOT, BOT2], prompt: 'p' })).rejects.toMatchObject({ status: 502, message: /invalid run id/ });
  });
  it('maps contract errors {error, message} to explicit statuses and codes without echoing secrets; gated names what it needs', async () => {
    const e = async (h: Handler, work: (c: BotsClient) => Promise<unknown>) => { try { await work((await clientFor(h)).client); } catch (error) { return error as BotsError; } throw new Error('expected a refusal'); };
    const invalid = await e(reply(422, { error: 'invalid', message: 'bad name api_key=sk-abcdefghijklmnopqrstuvwx' }), c => c.create({ name: 'n', agent: 'a' }));
    expect(invalid).toMatchObject({ status: 400, code: 'invalid' }); expect(invalid.message).toMatch(/HTTP 422: invalid: bad name/); expect(invalid.message).not.toContain('sk-abcdefghijklmnop');
    const gated = await e(reply(403, { error: 'gated', message: 'needs a Lease', needs: ['echo.fs.read'], how: 'grant echo.fs.read to the bot lease' }), c => c.message(BOT, { text: 'x' }));
    expect(gated).toMatchObject({ status: 400, code: 'gated' }); expect(gated.message).toContain('needs: echo.fs.read'); expect(gated.message).toContain('how: grant echo.fs.read');
    expect(await e(reply(404, { error: 'not_found', message: 'no such bot' }), c => c.get(BOT))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await e(reply(402, { error: 'budget_exceeded', message: 'daily cap reached' }), c => c.message(BOT, { text: 'x' }))).toMatchObject({ status: 400, code: 'budget_exceeded', message: /daily cap reached/ });
    expect(await e(reply(503, { error: 'unavailable', message: 'provider down', provider: 'qwen-local' }), c => c.group(GROUP))).toMatchObject({ status: 502, code: 'unavailable', message: /HTTP 503: unavailable: provider down/ });
    expect(await e(reply(500, 'boom'), c => c.list())).toMatchObject({ status: 502, message: 'echoBots service answered HTTP 500' });
  });
  it('redacts secrets inside bots, transcripts and groups before they reach the browser', async () => {
    const leak = 'token=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl and api_key: abc123secret';
    const { client } = await clientFor((_q, res) => {
      res.setHeader('content-type', 'application/json');
      const url = _q.url ?? '';
      if (url === '/v2/bots') res.end(JSON.stringify({ bots: [bot({ instruction: leak, last_error: leak })] }));
      else if (url.startsWith(`/bots/${BOT}/messages`)) res.end(JSON.stringify({ messages: [{ message_id: MSG, role: 'bot', text: leak, run_id: RUN }] }));
      else res.end(JSON.stringify({ group_id: GROUP, status: 'done', messages: [{ bot_id: BOT, text: leak }], summary: leak }));
    });
    for (const text of [JSON.stringify(await client.list()), JSON.stringify(await client.messages(BOT)), JSON.stringify(await client.group(GROUP))]) {
      expect(text).not.toContain('abc123secret'); expect(text).not.toContain('eyJhbGci'); expect(text).toContain('[REDACTED]');
    }
  });
});

async function primeServer(bots: BotsClient | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-bots-')); dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), 'Prime'); writeFileSync(join(dir, 'bots.js'), '// bots'); writeFileSync(join(dir, 'bots.css'), '/* bots */');
  const server = await startPrimeServer(new PrimeHub({ capabilities: [], bots }), dir, 0);
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-prime-request': '1' };
  const get = (path: string) => fetch(server.url + path, { headers });
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { ...headers, origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { server, headers, get, post, close: () => server.close() };
}
describe('Prime echoBots routes', () => {
  it('is off without a bots section: health says so and every other route is refused with 503', async () => {
    const p = await primeServer(undefined);
    try {
      expect(await (await p.get('/api/prime/bots/health')).json()).toMatchObject({ configured: false, available: false, reason: expect.stringMatching(/no bots section/) });
      expect((await p.get('/api/prime/bots/list')).status).toBe(503);
      expect((await p.get(`/api/prime/bots/${BOT}`)).status).toBe(503);
      expect((await p.get(`/api/prime/bots/groups/${GROUP}`)).status).toBe(503);
      expect((await p.post('/api/prime/bots/create', { name: 'n', agent: 'a' })).status).toBe(503);
      expect((await p.post(`/api/prime/bots/${BOT}/message`, { text: 'hi' })).status).toBe(503);
      expect((await p.post('/api/prime/bots/groups/create', { name: 'g', bots: [BOT, BOT2], prompt: 'p' })).status).toBe(503);
    } finally { await p.close(); }
  });
  it('requires the same-origin Prime session on every bots route and forwards nothing without it', async () => {
    const w = await fakeService(); const p = await primeServer(new BotsClient({ ...DEFAULT_BOTS, baseUrl: w.url }));
    try {
      for (const path of ['/api/prime/bots/health', '/api/prime/bots/list', `/api/prime/bots/${BOT}`, `/api/prime/bots/${BOT}/messages`, `/api/prime/bots/groups/${GROUP}`]) {
        expect((await fetch(p.server.url + path, { headers: { 'x-prime-request': '1' } })).status).toBe(403);
        expect((await fetch(p.server.url + path, { headers: { cookie: p.headers.cookie } })).status).toBe(403);
      }
      for (const path of ['/api/prime/bots/create', `/api/prime/bots/${BOT}/delete`, `/api/prime/bots/${BOT}/message`, '/api/prime/bots/groups/create'])
        expect((await fetch(p.server.url + path, { method: 'POST', headers: { ...p.headers, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
      expect((await fetch(p.server.url + `/api/prime/bots/${BOT}`, { method: 'DELETE', headers: p.headers })).status).toBe(405);
      expect(w.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
  it('serves every echoBots route with the contract statuses and the bots assets', async () => {
    const w = await fakeService(); const p = await primeServer(new BotsClient({ ...DEFAULT_BOTS, baseUrl: w.url }));
    try {
      expect(await (await p.get('/api/prime/bots/health')).json()).toMatchObject({ configured: true, available: true, defaultBudget: { max_cost_usd: 0 }, service: { profile: 'ECHO_ADK', bots: 2 } });
      expect((await (await p.get('/api/prime/bots/list')).json()).bots).toHaveLength(2);
      const created = await p.post('/api/prime/bots/create', { name: 'Docs bot', agent: 'docs', mode: 'personal', schedule: { every_s: 60 }, daily_cost_cap_usd: 1 });
      expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ bot_id: BOT3, status: 'paused' });
      expect(await (await p.get(`/api/prime/bots/${BOT}`)).json()).toMatchObject({ bot_id: BOT, name: 'Release scout' });
      const paused = await p.post(`/api/prime/bots/${BOT2}/pause`, {}); expect(paused.status).toBe(200); expect((await paused.json()).status).toBe('paused');
      expect((await (await p.post(`/api/prime/bots/${BOT2}/resume`, {})).json()).status).toBe('idle');
      const message = await p.post(`/api/prime/bots/${BOT}/message`, { text: 'status?' }); expect(message.status).toBe(202); expect(await message.json()).toEqual({ botId: BOT, messageId: MSG, runId: RUN });
      expect((await (await p.get(`/api/prime/bots/${BOT}/messages?since=${'1'.repeat(32)}&limit=20`)).json()).messages).toHaveLength(1);
      expect(w.seen.at(-1)!.url).toBe(`/bots/${BOT}/messages?since=${'1'.repeat(32)}&limit=20`);
      const group = await p.post('/api/prime/bots/groups/create', { name: 'Standup', bots: [BOT, BOT2], prompt: 'Status?' }); expect(group.status).toBe(202); expect(await group.json()).toMatchObject({ groupId: GROUP });
      expect(await (await p.get(`/api/prime/bots/groups/${GROUP}`)).json()).toMatchObject({ group_id: GROUP, summary: 'Ship; docs follow.' });
      const deleted = await p.post(`/api/prime/bots/${BOT3}/delete`, {}); expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ botId: BOT3, deleted: true });
      expect((await fetch(p.server.url + '/bots.js')).status).toBe(200);
      expect((await fetch(p.server.url + '/bots.css')).headers.get('content-type')).toContain('text/css');
    } finally { await p.close(); }
  });
  it('reports a down service in health and refuses the other routes with an explicit 502, never a substitute', async () => {
    const w = await fakeService(); const url = w.url; await stopLast();
    const p = await primeServer(new BotsClient({ ...DEFAULT_BOTS, baseUrl: url }));
    try {
      expect(await (await p.get('/api/prime/bots/health')).json()).toMatchObject({ configured: true, available: false, reason: `echoBots service unreachable at ${url}` });
      const list = await p.get('/api/prime/bots/list'); expect(list.status).toBe(502); expect((await list.json()).error).toContain('unreachable');
      expect((await p.post('/api/prime/bots/create', { name: 'n', agent: 'a' })).status).toBe(502);
    } finally { await p.close(); }
  });
  it('rejects malformed ids, limits and bodies with 400/404/405 and forwards nothing', async () => {
    const w = await fakeService(); const p = await primeServer(new BotsClient({ ...DEFAULT_BOTS, baseUrl: w.url }));
    try {
      for (const id of ['..%2Fhealth', 'abc', `${BOT}%2Fx`, 'groups']) expect((await p.get(`/api/prime/bots/${id}`)).status).toBe(400);
      expect((await p.get(`/api/prime/bots/groups/abc`)).status).toBe(400);
      expect((await p.get(`/api/prime/bots/${BOT}/messages?since=abc`)).status).toBe(400);
      expect((await p.get(`/api/prime/bots/${BOT}/messages?limit=500`)).status).toBe(400);
      expect((await p.get(`/api/prime/bots/${BOT}/extra`)).status).toBe(405);
      expect((await p.post(`/api/prime/bots/${BOT}/explode`, {})).status).toBe(404);
      expect((await p.post('/api/prime/bots/create', { name: 'x'.repeat(65), agent: 'a' })).status).toBe(400);
      expect((await p.post('/api/prime/bots/create', { name: 'n', agent: 'a', schedule: { every_s: 10 } })).status).toBe(400);
      expect((await p.post('/api/prime/bots/create', { name: 'n', agent: 'a', daily_cost_cap_usd: 50 })).status).toBe(400);
      expect((await p.post(`/api/prime/bots/${BOT}/message`, { text: 'x'.repeat(12001) })).status).toBe(400);
      expect((await p.post('/api/prime/bots/groups/create', { name: 'g', bots: [BOT], prompt: 'p' })).status).toBe(400);
      expect((await p.post(`/api/prime/bots/abc/delete`, {})).status).toBe(400);
      expect(w.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
});
