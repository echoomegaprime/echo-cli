import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { AdkClient, AdkError, DEFAULT_ADK, clampAdkBudget, parseAdkConfig, requireHexId } from '../src/prime/agents.js';

// Stand-in for the loopback echo-adk-api service, implementing docs/echo-code/ECHO_ADK_API_CONTRACT.md (v1). No real service or model is called.
const RUN = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const AGENT = { name: 'researcher', role: 'Finds and verifies facts', skills: ['search', 'summarize'], capabilities: ['echo.knowledge.search', 'echo.context.recall'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 60, max_cost_usd: 0, max_wall_s: 1200 } }, max_steps: 12, instruction: 'Verify before claiming.', source: 'agents/researcher.yaml' };
const BUILDER = { ...AGENT, name: 'builder', role: 'Ships code', skills: ['edit'], capabilities: ['echo.fs.write'], source: 'agents/builder.yaml' };
const envelope = (step: number, kind: string, over: Record<string, unknown> = {}) => ({ envelope_version: 1, run_id: RUN, step, kind, verdict: 'allowed', ok: true, untrusted: true, redacted: 0, duration_ms: 120, data: {}, ...over });
const DONE = { run_id: RUN, agent: 'researcher', status: 'done', started_at: '2026-11-04T19:00:00Z', finished_at: '2026-11-04T19:00:09Z',
  steps: [envelope(1, 'cap', { capability: 'echo.knowledge.search', tier: 0, audit_id: 'aud-1' }), envelope(2, 'model', { data: { answered: { provider: 'forge-qwen', requested: 'qwen-local', model: 'qwen3.5-27b', reported: true } } }), envelope(3, 'final', { data: { text: 'Verified: the port is 8378.' } })],
  proof: { run_id: RUN, lease_id: 'l'.repeat(32), events_sha256: 'e'.repeat(64), actions: [{ cap: 'echo.knowledge.search', tier: 0, verdict: 'allowed', audit_id: 'aud-1' }], artifacts: [], receipts: [], verdict: 'PASS' },
  budget: { max_calls: 40, max_cost_usd: 0, max_wall_s: 900 }, spent: { calls: 2, cost_usd: 0, wall_s: 9 } };
type Seen = { method: string; url: string; body: string };
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
async function stopLast() { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
async function fakeAdk(handler?: Handler) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      if (handler) { handler(req, res, entry); return; }
      res.setHeader('content-type', 'application/json');
      const reply = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
      const path = entry.url.split('?')[0];
      if (entry.method === 'GET' && path === '/health') reply(200, { ok: true, service: 'echo-adk-api', profile: 'ECHO_ADK', version: '0.1.0', agents: 2, bots: 0, runs_active: 0 });
      else if (entry.method === 'GET' && path === '/agents') reply(200, { agents: [AGENT, BUILDER] });
      else if (entry.method === 'GET' && path === '/agents/researcher') reply(200, AGENT);
      else if (entry.method === 'GET' && path.startsWith('/agents/')) reply(404, { error: 'not_found', message: 'no such agent' });
      else if (entry.method === 'POST' && path === '/runs') reply(202, { run_id: RUN, status: 'queued' });
      else if (entry.method === 'GET' && path === `/runs/${RUN}`) reply(200, DONE);
      else if (entry.method === 'POST' && path === `/runs/${RUN}/stop`) reply(200, { run_id: RUN, status: 'running' });
      else if (entry.method === 'GET' && path === '/runs') reply(200, { runs: [{ run_id: RUN, agent: 'researcher', status: 'done', started_at: '2026-11-04T19:00:00Z' }] });
      else reply(404, { error: 'not_found', message: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_q, res) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const clientFor = async (h?: Handler) => { const w = await fakeAdk(h); return { client: new AdkClient({ ...DEFAULT_ADK, baseUrl: w.url }), w }; };

describe('adk config and budget', () => {
  it('defaults to the loopback service on 8378 and refuses anything else', () => {
    expect(parseAdkConfig({})).toEqual({ baseUrl: 'http://127.0.0.1:8378', defaultBudget: DEFAULT_ADK.defaultBudget });
    expect(parseAdkConfig({ baseUrl: 'http://localhost:9000' }).baseUrl).toBe('http://localhost:9000');
    for (const bad of ['http://192.168.1.220:8378', 'https://forge.example', 'http://user:pw@127.0.0.1:8378', 'http://127.0.0.1:8378/runs', 'http://127.0.0.1:8378/?x=1', 5])
      expect(() => parseAdkConfig({ baseUrl: bad })).toThrow(/loopback origin|baseUrl/);
    expect(() => parseAdkConfig({ token: 'x' })).toThrow(/unknown field/);
    expect(() => parseAdkConfig({ lease: { scopes: [] } })).toThrow(/unknown field/);
    expect(() => parseAdkConfig('on')).toThrow(/object/);
    expect(() => parseAdkConfig({ defaultBudget: { max_cost_usd: 'free' } })).toThrow(/defaultBudget/);
  });
  it('clamps the budget to the service caps and keeps the contract default cost of 0', () => {
    expect(clampAdkBudget(undefined)).toEqual({ max_calls: 40, max_cost_usd: 0, max_wall_s: 900 });
    expect(clampAdkBudget({ max_calls: 9999, max_cost_usd: 50, max_wall_s: 99999 })).toEqual({ max_calls: 120, max_cost_usd: 5, max_wall_s: 4800 });
    expect(clampAdkBudget({ max_calls: -5, max_cost_usd: -1, max_wall_s: 1 })).toEqual({ max_calls: 1, max_cost_usd: 0, max_wall_s: 30 });
    expect(clampAdkBudget({ max_cost_usd: 0 }).max_cost_usd).toBe(0);
    expect(clampAdkBudget({ max_calls: 10.9 }).max_calls).toBe(10);
    expect(clampAdkBudget({ max_cost_usd: 2.499 }).max_cost_usd).toBe(2.5);
    expect(parseAdkConfig({ defaultBudget: { max_cost_usd: 99 } }).defaultBudget.max_cost_usd).toBe(5);
  });
  it('refuses non-numeric and unknown budget fields instead of guessing', () => {
    for (const bad of [{ max_calls: '5' }, { max_cost_usd: NaN }, { max_wall_s: null }, { extra: 1 }, [], 'big'])
      expect(() => clampAdkBudget(bad)).toThrow(AdkError);
  });
  it('accepts only 32 lowercase hex ids', () => {
    expect(requireHexId(RUN)).toBe(RUN);
    for (const bad of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '../health', `${RUN}/x`, '', 5, null])
      expect(() => requireHexId(bad)).toThrow(/Invalid agent run id/);
  });
});

describe('AdkClient against a stand-in echo-adk-api', () => {
  it('reads health and refuses an unexpected profile, an unhealthy service, non-JSON and a redirect', async () => {
    const { client } = await clientFor();
    expect(await client.health()).toEqual({ service: 'echo-adk-api', profile: 'ECHO_ADK', version: '0.1.0', agents: 2, bots: 0, runsActive: 0 });
    await expect((await clientFor(reply(200, { ok: true, service: 'echo-adk-api', profile: 'MAXIMALIST_RECONSTRUCTED' }))).client.health()).rejects.toMatchObject({ status: 502, message: /unexpected profile/ });
    await expect((await clientFor(reply(200, { ok: false, profile: 'ECHO_ADK' }))).client.health()).rejects.toMatchObject({ message: /not healthy/ });
    await expect((await clientFor(reply(200, 'not json'))).client.health()).rejects.toMatchObject({ status: 502, message: /unrecognized/ });
    await expect((await clientFor(reply(302, '', { location: 'http://127.0.0.1:1/' }))).client.health()).rejects.toMatchObject({ status: 502, message: /unreachable/ });
  });
  it('lists agent definitions and refuses a malformed list', async () => {
    const { client, w } = await clientFor();
    const listed = await client.agents();
    expect(listed.agents).toHaveLength(2);
    expect(listed.agents[0]).toMatchObject({ name: 'researcher', role: 'Finds and verifies facts', skills: ['search', 'summarize'], lane: { node: 'forge', model: 'qwen-local', budget: { max_calls: 60 } }, max_steps: 12, source: 'agents/researcher.yaml' });
    expect(w.seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /agents']);
    await expect((await clientFor(reply(200, { agents: 'none' }))).client.agents()).rejects.toMatchObject({ status: 502, message: /invalid agent list/ });
    await expect((await clientFor(reply(200, { agents: [{ name: '../etc' }] }))).client.agents()).rejects.toMatchObject({ status: 502, message: /invalid agent name/ });
  });
  it('reads one agent by a strictly validated name; bad names never produce a request', async () => {
    const { client, w } = await clientFor();
    expect(await client.agent('researcher')).toMatchObject({ name: 'researcher' });
    for (const bad of ['../health', 'a b', 'x'.repeat(65), '', '-lead', 'name?x=1', 7])
      await expect(client.agent(bad)).rejects.toMatchObject({ status: 400, message: /Invalid agent name/ });
    await expect(client.agent('missing')).rejects.toMatchObject({ status: 404, code: 'not_found', message: /HTTP 404 \(not_found\): no such agent/ });
    await expect((await clientFor(reply(200, { ...AGENT, name: 'builder' }))).client.agent('researcher')).rejects.toMatchObject({ status: 502, message: /different agent/ });
    expect(w.seen.map(s => s.url)).toEqual(['/agents/researcher', '/agents/missing']);
  });
  it('submits a run with the clamped budget and refuses bad requests (including a lease) before any request', async () => {
    const { client, w } = await clientFor();
    const run = await client.run({ agent: 'researcher', prompt: 'Find the port.', budget: { max_cost_usd: 40, max_calls: 3 } });
    expect(run).toEqual({ runId: RUN, agent: 'researcher', status: 'queued', budget: { max_calls: 3, max_cost_usd: 5, max_wall_s: 900 } });
    expect(JSON.parse(w.seen[0].body)).toEqual({ agent: 'researcher', prompt: 'Find the port.', budget: { max_calls: 3, max_cost_usd: 5, max_wall_s: 900 } });
    for (const bad of [{}, { agent: 'researcher' }, { agent: 'researcher', prompt: '   ' }, { agent: 'researcher', prompt: 5 }, { agent: 'researcher', prompt: 'x'.repeat(12001) }, { agent: '../x', prompt: 'ok' },
      { agent: 'researcher', prompt: 'ok', lease: { scopes: ['echo.shell.run'], ttl_s: 60, max_uses: 1 } }, { agent: 'researcher', prompt: 'ok', url: 'http://evil' }, { agent: 'researcher', prompt: 'ok', budget: { max_calls: 'many' } }])
      await expect(client.run(bad)).rejects.toMatchObject({ status: 400 });
    expect((await client.run({ agent: 'researcher', prompt: 'x'.repeat(12000) })).runId).toBe(RUN);
    expect(w.seen).toHaveLength(2);
    await expect((await clientFor(reply(202, { run_id: '../../x', status: 'queued' }))).client.run({ agent: 'researcher', prompt: 'o' })).rejects.toMatchObject({ status: 502, message: /invalid run id/ });
  });
  it('maps contract errors to explicit messages: gated carries needs and how, unavailable names the provider, secrets are redacted', async () => {
    const gated = await clientFor(reply(403, { error: 'gated', message: 'lease required', needs: ['echo.shell.run', 'echo.fs.write'], how: 'grant a Lease with those scopes' }));
    await expect(gated.client.run({ agent: 'researcher', prompt: 'o' })).rejects.toSatisfy((e: AdkError) => e.status === 400 && e.code === 'gated' && /HTTP 403 \(gated\): lease required\. Needs: echo\.shell\.run, echo\.fs\.write\. How: grant a Lease/.test(e.message) && e.detail.needs?.length === 2);
    const down = await clientFor(reply(503, { error: 'unavailable', message: 'provider down', provider: 'anthropic' }));
    await expect(down.client.run({ agent: 'researcher', prompt: 'o' })).rejects.toSatisfy((e: AdkError) => e.status === 502 && e.code === 'unavailable' && /Provider anthropic is unavailable; no fallback was used/.test(e.message) && e.detail.provider === 'anthropic');
    const budget = await clientFor(reply(409, { error: 'budget_exceeded', message: 'max_cost_usd' }));
    await expect(budget.client.run({ agent: 'researcher', prompt: 'o' })).rejects.toMatchObject({ status: 400, code: 'budget_exceeded', message: /\(budget_exceeded\): max_cost_usd/ });
    const leaky = await clientFor(reply(422, { error: 'invalid', message: 'bad body api_key=sk-abcdefghijklmnopqrstuvwx' }));
    await expect(leaky.client.run({ agent: 'researcher', prompt: 'o' })).rejects.toSatisfy((e: AdkError) => e.status === 400 && /HTTP 422 \(invalid\)/.test(e.message) && !e.message.includes('sk-abcdefghijklmnop'));
    await expect((await clientFor(reply(500, { detail: 'boom' }))).client.status(RUN)).rejects.toMatchObject({ status: 502, message: /HTTP 500: boom/ });
  });
  it('polls a run: refuses bad ids before any request, another run, and normalizes steps, proof, error and spend', async () => {
    const { client, w } = await clientFor();
    for (const id of ['../health', '..%2fhealth', 'a/b', `${RUN}/x`, `${RUN}?x=1`, 'A'.repeat(32), 'a'.repeat(31), '', 'run-1'])
      await expect(client.status(id)).rejects.toMatchObject({ status: 400 });
    expect(w.seen).toHaveLength(0);
    const done = await client.status(RUN);
    expect(done).toMatchObject({ runId: RUN, agent: 'researcher', status: 'done', done: true, startedAt: '2026-11-04T19:00:00Z', finishedAt: '2026-11-04T19:00:09Z', spent: { calls: 2 }, budget: { max_calls: 40 } });
    expect(done.steps).toHaveLength(3);
    expect(done.steps[1]).toMatchObject({ kind: 'model', data: { answered: { model: 'qwen3.5-27b', reported: true } } });
    expect(done.proof).toMatchObject({ verdict: 'PASS', events_sha256: 'e'.repeat(64), actions: [{ cap: 'echo.knowledge.search' }] });
    expect(done.error).toBeUndefined();
    await expect((await clientFor(reply(200, { run_id: OTHER, status: 'running' }))).client.status(RUN)).rejects.toMatchObject({ status: 502, message: /different run/ });
    const gated = await (await clientFor(reply(200, { run_id: RUN, status: 'gated', steps: [envelope(1, 'cap', { verdict: 'gated', needs: ['echo.shell.run'], how: 'grant a Lease' })] }))).client.status(RUN);
    expect(gated).toMatchObject({ status: 'gated', done: false });
    expect(gated.steps[0]).toMatchObject({ verdict: 'gated', needs: ['echo.shell.run'], how: 'grant a Lease' });
    const failed = await (await clientFor(reply(200, { run_id: RUN, status: 'failed', steps: [], error: { code: 'unavailable', message: 'provider down token=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', provider: 'anthropic' } }))).client.status(RUN);
    expect(failed).toMatchObject({ status: 'failed', done: true, error: { code: 'unavailable', provider: 'anthropic' } });
    expect(failed.error!.message).not.toContain('eyJhbGci');
    const odd = await (await clientFor(reply(200, { run_id: RUN, status: 'weird', steps: 'none', error: 'plain text' }))).client.status(RUN);
    expect(odd).toMatchObject({ status: 'unknown', done: false, steps: [], error: { message: 'plain text' } });
  });
  it('redacts secrets inside step data and refuses an oversized body', async () => {
    const leaky = await clientFor(reply(200, { run_id: RUN, status: 'done', steps: [envelope(1, 'final', { data: { text: 'api_key: abc123secret and password=hunter2' } })] }));
    const text = JSON.stringify((await leaky.client.status(RUN)).steps);
    expect(text).not.toContain('abc123secret'); expect(text).not.toContain('hunter2'); expect(text).toContain('[REDACTED]');
    await expect((await clientFor(reply(200, 'x'.repeat(1048577)))).client.status(RUN)).rejects.toMatchObject({ status: 502, message: /1 MiB/ });
  });
  it('stops a run with an explicit POST and refuses bad ids or another run', async () => {
    const { client, w } = await clientFor();
    expect(await client.stop(RUN)).toEqual({ runId: RUN, status: 'running' });
    expect(w.seen[0]).toMatchObject({ method: 'POST', url: `/runs/${RUN}/stop`, body: '{}' });
    for (const id of ['A'.repeat(32), `${RUN}/x`, '']) await expect(client.stop(id)).rejects.toMatchObject({ status: 400 });
    expect(w.seen).toHaveLength(1);
    await expect((await clientFor(reply(200, { run_id: OTHER, status: 'running' }))).client.stop(RUN)).rejects.toMatchObject({ status: 502, message: /different run/ });
    await expect((await clientFor(reply(404, { error: 'not_found', message: 'unknown run' }))).client.stop(RUN)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
  it('lists runs with a bounded limit and optional agent filter, refusing bad queries and bad ids', async () => {
    const { client, w } = await clientFor();
    expect(await client.runs()).toEqual({ runs: [{ runId: RUN, agent: 'researcher', status: 'done', startedAt: '2026-11-04T19:00:00Z' }] });
    await client.runs({ agent: 'researcher', limit: 7 }); await client.runs({ limit: '500' }); await client.runs({ limit: 0 });
    expect(w.seen.map(s => s.url)).toEqual(['/runs?limit=20', '/runs?agent=researcher&limit=7', '/runs?limit=50', '/runs?limit=1']);
    for (const bad of [{ since: 1 }, { agent: '../x' }, { limit: 'abc' }, { limit: 2.5 }]) await expect(client.runs(bad)).rejects.toMatchObject({ status: 400 });
    expect(w.seen).toHaveLength(4);
    await expect((await clientFor(reply(200, { runs: [{ run_id: 'nope', agent: 'a', status: 'done' }] }))).client.runs()).rejects.toMatchObject({ status: 502, message: /invalid run id/ });
    await expect((await clientFor(reply(200, { runs: 'many' }))).client.runs()).rejects.toMatchObject({ status: 502, message: /invalid run list/ });
    const odd = await (await clientFor(reply(200, { runs: [{ run_id: RUN, agent: 7, status: 'odd' }] }))).client.runs();
    expect(odd).toEqual({ runs: [{ runId: RUN, agent: '', status: 'unknown' }] });
  });
  it('reports a down service, a stalled service and an interrupted request explicitly', async () => {
    const w = await fakeAdk(); const url = w.url; await stopLast();
    await expect(new AdkClient({ ...DEFAULT_ADK, baseUrl: url }).health()).rejects.toMatchObject({ status: 502, message: `Echo ADK unreachable at ${url}` });
    const slow = await fakeAdk(() => { /* never answers */ });
    await expect(new AdkClient({ ...DEFAULT_ADK, baseUrl: slow.url }, { health: 60, mutate: 60, read: 60 }).status(RUN)).rejects.toMatchObject({ status: 504, message: /timed out.*outcome unknown/ });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    await expect(new AdkClient({ ...DEFAULT_ADK, baseUrl: slow.url }).status(RUN, controller.signal)).rejects.toMatchObject({ status: 499, message: 'Interrupted' });
  });
});

async function primeServer(adk: AdkClient | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-adk-')); dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), 'Prime'); writeFileSync(join(dir, 'agents.js'), '// agents'); writeFileSync(join(dir, 'agents.css'), '/* agents */');
  const server = await startPrimeServer(new PrimeHub({ capabilities: [], adk }), dir, 0);
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-prime-request': '1' };
  const get = (path: string) => fetch(server.url + path, { headers });
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { ...headers, origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { server, headers, get, post, close: () => server.close() };
}
describe('Prime adk routes', () => {
  it('is off without an adk section: health says so and every other route is refused with 503', async () => {
    const p = await primeServer(undefined);
    try {
      expect(await (await p.get('/api/prime/adk/health')).json()).toEqual({ configured: false, available: false, reason: 'Echo ADK is off: add an `adk` section to the Prime config' });
      expect((await p.get('/api/prime/adk/agents')).status).toBe(503);
      expect((await p.get('/api/prime/adk/agents/researcher')).status).toBe(503);
      expect((await p.get('/api/prime/adk/runs')).status).toBe(503);
      expect((await p.get(`/api/prime/adk/runs/${RUN}`)).status).toBe(503);
      expect((await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'hi' })).status).toBe(503);
      expect((await p.post(`/api/prime/adk/runs/${RUN}/stop`, {})).status).toBe(503);
    } finally { await p.close(); }
  });
  it('requires the same-origin Prime session on every adk route and forwards nothing without it', async () => {
    const w = await fakeAdk(); const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: w.url }));
    try {
      for (const path of ['/api/prime/adk/health', '/api/prime/adk/agents', '/api/prime/adk/runs', `/api/prime/adk/runs/${RUN}`])
        expect((await fetch(p.server.url + path, { headers: { 'x-prime-request': '1' } })).status).toBe(403);
      expect((await fetch(p.server.url + `/api/prime/adk/runs/${RUN}`)).status).toBe(403);
      const cross = await fetch(p.server.url + '/api/prime/adk/runs', { method: 'POST', headers: { ...p.headers, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{"agent":"researcher","prompt":"x"}' });
      expect(cross.status).toBe(403);
      const stop = await fetch(p.server.url + `/api/prime/adk/runs/${RUN}/stop`, { method: 'POST', headers: { ...p.headers, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
      expect(stop.status).toBe(403);
      expect(w.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
  it('serves every route of the contract and the agents assets', async () => {
    const w = await fakeAdk(); const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: w.url }));
    try {
      expect(await (await p.get('/api/prime/adk/health')).json()).toMatchObject({ configured: true, available: true, defaultBudget: { max_cost_usd: 0 }, service: { profile: 'ECHO_ADK', version: '0.1.0' } });
      expect((await (await p.get('/api/prime/adk/agents')).json()).agents).toHaveLength(2);
      expect(await (await p.get('/api/prime/adk/agents/researcher')).json()).toMatchObject({ name: 'researcher' });
      const run = await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'Find the port.', budget: { max_cost_usd: 100 } });
      expect(run.status).toBe(202);
      expect(await run.json()).toEqual({ runId: RUN, agent: 'researcher', status: 'queued', budget: { max_calls: 40, max_cost_usd: 5, max_wall_s: 900 } });
      expect(await (await p.get(`/api/prime/adk/runs/${RUN}`)).json()).toMatchObject({ runId: RUN, status: 'done', done: true, proof: { verdict: 'PASS' } });
      const stop = await p.post(`/api/prime/adk/runs/${RUN}/stop`, {});
      expect(stop.status).toBe(200); expect(await stop.json()).toEqual({ runId: RUN, status: 'running' });
      expect(await (await p.get('/api/prime/adk/runs?agent=researcher&limit=5')).json()).toEqual({ runs: [{ runId: RUN, agent: 'researcher', status: 'done', startedAt: '2026-11-04T19:00:00Z' }] });
      expect(w.seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /health', 'GET /agents', 'GET /agents/researcher', 'POST /runs', `GET /runs/${RUN}`, `POST /runs/${RUN}/stop`, 'GET /runs?agent=researcher&limit=5']);
      expect((await fetch(p.server.url + '/agents.js')).status).toBe(200);
      expect((await fetch(p.server.url + '/agents.css')).headers.get('content-type')).toContain('text/css');
    } finally { await p.close(); }
  });
  it('reports a down service in health and refuses a run with an explicit 502, never another provider', async () => {
    const w = await fakeAdk(); const url = w.url; await stopLast();
    const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: url }));
    try {
      expect(await (await p.get('/api/prime/adk/health')).json()).toMatchObject({ configured: true, available: false, reason: `Echo ADK unreachable at ${url}` });
      const run = await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'hi' });
      expect(run.status).toBe(502); expect((await run.json()).error).toContain('unreachable');
    } finally { await p.close(); }
  });
  it('rejects oversized prompts, bad budgets, malformed ids and bad queries with 400/404/405 and forwards nothing', async () => {
    const w = await fakeAdk(); const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: w.url }));
    try {
      expect((await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'x'.repeat(12001) })).status).toBe(400);
      expect((await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'ok', budget: { max_calls: 'many' } })).status).toBe(400);
      expect((await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'ok', lease: { scopes: [] } })).status).toBe(400);
      for (const id of ['..%2Fhealth', 'abc', `${RUN}%2Fx`]) {
        expect((await p.get(`/api/prime/adk/runs/${id}`)).status).toBe(400);
        expect((await p.post(`/api/prime/adk/runs/${id}/stop`, {})).status).toBe(400);
      }
      expect((await p.get('/api/prime/adk/agents/..%2Fx')).status).toBe(400);
      expect((await p.get('/api/prime/adk/runs?limit=abc')).status).toBe(400);
      expect((await p.get('/api/prime/adk/runs?agent=..%2Fx')).status).toBe(400);
      expect((await p.get(`/api/prime/adk/runs/${RUN}/extra`)).status).toBe(405);
      expect((await p.get(`/api/prime/adk/runs/${RUN}/stop`)).status).toBe(405);
      expect(w.seen).toHaveLength(0);
      expect((await p.get('/api/prime/adk/agents/missing')).status).toBe(404);
    } finally { await p.close(); }
  });
  it('passes a gated refusal through with its needs and how in the error text', async () => {
    const w = await fakeAdk(reply(403, { error: 'gated', message: 'lease required', needs: ['echo.shell.run'], how: 'grant a Lease' }));
    const p = await primeServer(new AdkClient({ ...DEFAULT_ADK, baseUrl: w.url }));
    try {
      const run = await p.post('/api/prime/adk/runs', { agent: 'researcher', prompt: 'hi' });
      expect(run.status).toBe(400);
      expect((await run.json()).error).toMatch(/\(gated\): lease required\. Needs: echo\.shell\.run\. How: grant a Lease/);
    } finally { await p.close(); }
  });
});
