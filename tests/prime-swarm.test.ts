import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { SwarmClient, SwarmError, clampBudget, parseSwarmConfig, sanitize, DEFAULT_SWARM } from '../src/prime/swarm.js';

const RUN = 'a'.repeat(32);
type Seen = { method: string; url: string; body: string };
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
/** A stand-in for the FORGE worker: it records every request and answers like the documented routes. No real worker or model is ever called. */
async function stopLast() { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
async function fakeWorker(handler?: Handler) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      if (handler) { handler(req, res, entry); return; }
      res.setHeader('content-type', 'application/json');
      if (entry.method === 'GET' && entry.url === '/health') res.end(JSON.stringify({ ok: true, version: '0.5.0', profile: 'MAXIMALIST_RECONSTRUCTED', seats_fingerprint: 'abc123', active_runs: 0 }));
      else if (entry.method === 'POST' && entry.url === '/run') { res.statusCode = 202; res.end(JSON.stringify({ run_id: RUN, phase: 'independent' })); }
      else if (entry.method === 'GET' && entry.url === `/runs/${RUN}`) res.end(JSON.stringify({ run_id: RUN, phase: 'complete', done: true, result: { answer: 'fused', confidence: 0.8, provenance: { profile: 'MAXIMALIST_RECONSTRUCTED', historical_parity: false } } }));
      else { res.statusCode = 404; res.end(JSON.stringify({ detail: 'not found' })); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('swarm config and budget', () => {
  it('defaults to the loopback worker on 8358 and refuses anything else', () => {
    expect(parseSwarmConfig({})).toEqual({ baseUrl: 'http://127.0.0.1:8358', defaultBudget: DEFAULT_SWARM.defaultBudget });
    expect(parseSwarmConfig({ baseUrl: 'http://localhost:9000' }).baseUrl).toBe('http://localhost:9000');
    for (const bad of ['http://192.168.1.220:8358', 'https://forge.example', 'http://user:pw@127.0.0.1:8358', 'http://127.0.0.1:8358/run', 'http://127.0.0.1:8358/?x=1', 5])
      expect(() => parseSwarmConfig({ baseUrl: bad })).toThrow(/loopback origin|baseUrl/);
    expect(() => parseSwarmConfig({ token: 'x' })).toThrow(/unknown field/);
    expect(() => parseSwarmConfig('on')).toThrow(/object/);
    expect(() => parseSwarmConfig({ defaultBudget: { max_cost_usd: 'free' } })).toThrow(/defaultBudget/);
  });
  it('clamps the budget to the worker maxima, defaults cost to 1 USD and never exceeds 5', () => {
    expect(clampBudget(undefined).max_cost_usd).toBe(1);
    expect(clampBudget({ max_calls: 9999, max_cost_usd: 50, max_wall_s: 99999 })).toEqual({ max_calls: 120, max_cost_usd: 5, max_wall_s: 4800 });
    expect(clampBudget({ max_calls: -5, max_cost_usd: 0, max_wall_s: 1 })).toEqual({ max_calls: 1, max_cost_usd: 0.01, max_wall_s: 30 });
    expect(clampBudget({ max_calls: 10.9 }).max_calls).toBe(10);
    expect(clampBudget({ max_cost_usd: 2.499 }).max_cost_usd).toBe(2.5);
    expect(parseSwarmConfig({ defaultBudget: { max_cost_usd: 99 } }).defaultBudget.max_cost_usd).toBe(5);
  });
  it('refuses non-numeric and unknown budget fields instead of guessing', () => {
    for (const bad of [{ max_calls: '5' }, { max_cost_usd: NaN }, { max_wall_s: null }, { extra: 1 }, [], 'big'])
      expect(() => clampBudget(bad)).toThrow(SwarmError);
  });
  it('redacts secrets and bounds depth in anything it sanitizes', () => {
    const out = sanitize({ a: 'api_key=sk-abcdefghijklmnopqrstuvwx and password: hunter2', n: [1, true, null], deep: { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: { l11: { l12: 'x' } } } } } } } } } } } } });
    const text = JSON.stringify(out);
    expect(text).not.toContain('hunter2'); expect(text).not.toContain('sk-abcdefghijklmnop'); expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('"l12"');
  });
});

describe('SwarmClient against a fake worker', () => {
  it('reads health, submits a run with a server-made idempotency key and the clamped budget, and polls status', async () => {
    const w = await fakeWorker(); const client = new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url });
    expect(await client.health()).toMatchObject({ version: '0.5.0', profile: 'MAXIMALIST_RECONSTRUCTED', seatsFingerprint: 'abc123', activeRuns: 0 });
    const run = await client.run({ objective: 'Should we ship?', budget: { max_cost_usd: 40 } });
    expect(run).toMatchObject({ runId: RUN, phase: 'independent', budget: { max_cost_usd: 5, max_calls: 80, max_wall_s: 1800 } });
    expect(run.idempotencyKey).toMatch(/^prime-[0-9a-f-]{36}$/);
    const posted = JSON.parse(w.seen[1].body);
    expect(posted).toEqual({ objective: 'Should we ship?', budget: { max_calls: 80, max_cost_usd: 5, max_wall_s: 1800 }, idempotency_key: run.idempotencyKey });
    expect(await client.status(RUN)).toMatchObject({ runId: RUN, phase: 'complete', done: true, result: { answer: 'fused' } });
    expect(w.seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /health', 'POST /run', `GET /runs/${RUN}`]);
  });
  it('uses a fresh idempotency key for every submission', async () => {
    const w = await fakeWorker(); const client = new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url });
    const a = await client.run({ objective: 'one' }), b = await client.run({ objective: 'two' });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
  it('rejects bad objectives and bodies before any request is made', async () => {
    const w = await fakeWorker(); const client = new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url });
    for (const bad of [{}, { objective: '' }, { objective: '   ' }, { objective: 5 }, { objective: 'x'.repeat(12001) }, { objective: 'ok', url: 'http://evil' }, { objective: 'ok', path: '/etc/passwd' }])
      await expect(client.run(bad)).rejects.toMatchObject({ status: 400 });
    expect((await client.run({ objective: 'x'.repeat(12000) })).runId).toBe(RUN);
    expect(w.seen).toHaveLength(1);
  });
  it('only ever reaches three fixed routes: run ids that are not 32 hex characters never produce a request', async () => {
    const w = await fakeWorker(); const client = new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url });
    for (const id of ['../health', '..%2fhealth', 'a/b', `${RUN}/x`, `${RUN}?x=1`, 'A'.repeat(32), 'a'.repeat(31), 'http://evil.example/', '', 'run-1'])
      await expect(client.status(id)).rejects.toMatchObject({ status: 400 });
    expect(w.seen).toHaveLength(0);
  });
  it('refuses a worker that returns a bad run id, another run, a redirect, an unexpected profile or an oversized body', async () => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_q, res) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const bad = async (h: Handler) => new SwarmClient({ ...DEFAULT_SWARM, baseUrl: (await fakeWorker(h)).url });
    await expect((await bad(reply(202, { run_id: '../../x', phase: 'p' }))).run({ objective: 'o' })).rejects.toMatchObject({ status: 502, message: /invalid run id/ });
    await expect((await bad(reply(200, { run_id: 'b'.repeat(32), done: false }))).status(RUN)).rejects.toMatchObject({ status: 502, message: /different run/ });
    await expect((await bad(reply(302, '', { location: 'http://127.0.0.1:1/' }))).health()).rejects.toMatchObject({ status: 502, message: /unreachable/ });
    await expect((await bad(reply(200, { ok: true, profile: 'SOMETHING_ELSE' }))).health()).rejects.toMatchObject({ message: /unexpected profile/ });
    await expect((await bad(reply(200, { ok: false, profile: 'MAXIMALIST_RECONSTRUCTED' }))).health()).rejects.toMatchObject({ message: /not healthy/ });
    await expect((await bad(reply(200, 'not json'))).health()).rejects.toMatchObject({ status: 502, message: /unrecognized/ });
    await expect((await bad(reply(200, 'x'.repeat(1048577)))).status(RUN)).rejects.toMatchObject({ status: 502, message: /1 MiB/ });
  });
  it('maps worker errors to explicit messages without echoing secrets', async () => {
    const reply = (status: number, body: unknown): Handler => (_q, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const clientFor = async (h: Handler) => new SwarmClient({ ...DEFAULT_SWARM, baseUrl: (await fakeWorker(h)).url });
    await expect((await clientFor(reply(422, { detail: 'budget invalid api_key=sk-abcdefghijklmnopqrstuvwx' }))).run({ objective: 'o' }))
      .rejects.toSatisfy((e: SwarmError) => e.status === 400 && /HTTP 422/.test(e.message) && !e.message.includes('sk-abcdefghijklmnop'));
    await expect((await clientFor(reply(404, { detail: 'unknown run' }))).status(RUN)).rejects.toMatchObject({ status: 404 });
    await expect((await clientFor(reply(500, { detail: 'boom' }))).status(RUN)).rejects.toMatchObject({ status: 502 });
  });
  it('reports a down worker and a stalled worker explicitly', async () => {
    const w = await fakeWorker(); const url = w.url; await stopLast();
    await expect(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: url }).health()).rejects.toMatchObject({ status: 502, message: `Swarm worker unreachable at ${url}` });
    const slow = await fakeWorker(() => { /* never answers */ });
    await expect(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: slow.url }, { health: 60, run: 60, status: 60 }).status(RUN)).rejects.toMatchObject({ status: 504, message: /timed out.*outcome unknown/ });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    await expect(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: slow.url }).status(RUN, controller.signal)).rejects.toMatchObject({ message: 'Interrupted' });
  });
  it('redacts secrets inside results', async () => {
    const w = await fakeWorker((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ run_id: RUN, phase: 'complete', done: true, result: { answer: 'token=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl and api_key: abc123secret' } })); });
    const result = JSON.stringify((await new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url }).status(RUN)).result);
    expect(result).not.toContain('abc123secret'); expect(result).not.toContain('eyJhbGci');
  });
  it('shows an error run as an error and withholds partial results until done', async () => {
    const w = await fakeWorker((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ run_id: RUN, phase: 'failed', done: true, error: 'budget exhausted: max_calls', result: null })); });
    expect(await new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url }).status(RUN)).toEqual({ runId: RUN, phase: 'failed', done: true, error: 'budget exhausted: max_calls' });
    const running = await fakeWorker((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ run_id: RUN, phase: 'independent', done: false, result: { answer: 'partial' } })); });
    expect(await new SwarmClient({ ...DEFAULT_SWARM, baseUrl: running.url }).status(RUN)).toEqual({ runId: RUN, phase: 'independent', done: false });
  });
});

async function primeServer(swarm: SwarmClient | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-swarm-')); dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), 'Prime'); writeFileSync(join(dir, 'swarm.js'), '// swarm'); writeFileSync(join(dir, 'swarm.css'), '/* swarm */');
  const server = await startPrimeServer(new PrimeHub({ capabilities: [], swarm }), dir, 0);
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-prime-request': '1' };
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { ...headers, origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { server, headers, post, close: () => server.close() };
}
describe('Prime swarm routes', () => {
  it('is off without a swarm section: health says so, run and status are refused with 503', async () => {
    const p = await primeServer(undefined);
    try {
      expect(await (await fetch(p.server.url + '/api/prime/swarm/health', { headers: p.headers })).json()).toMatchObject({ configured: false, available: false, reason: expect.stringMatching(/no swarm section/) });
      const run = await p.post('/api/prime/swarm/run', { objective: 'hi' });
      expect(run.status).toBe(503);
      expect((await fetch(p.server.url + `/api/prime/swarm/runs/${RUN}`, { headers: p.headers })).status).toBe(503);
    } finally { await p.close(); }
  });
  it('requires the same-origin Prime session on every swarm route', async () => {
    const w = await fakeWorker(); const p = await primeServer(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url }));
    try {
      expect((await fetch(p.server.url + '/api/prime/swarm/health', { headers: { 'x-prime-request': '1' } })).status).toBe(403);
      expect((await fetch(p.server.url + `/api/prime/swarm/runs/${RUN}`)).status).toBe(403);
      const cross = await fetch(p.server.url + '/api/prime/swarm/run', { method: 'POST', headers: { ...p.headers, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{"objective":"x"}' });
      expect(cross.status).toBe(403);
      expect(w.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
  it('serves health, accepts a run (202), polls it, and serves the swarm assets', async () => {
    const w = await fakeWorker(); const p = await primeServer(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url }));
    try {
      const health = await (await fetch(p.server.url + '/api/prime/swarm/health', { headers: p.headers })).json();
      expect(health).toMatchObject({ configured: true, available: true, defaultBudget: { max_cost_usd: 1 }, worker: { profile: 'MAXIMALIST_RECONSTRUCTED' } });
      const run = await p.post('/api/prime/swarm/run', { objective: 'Decide', budget: { max_cost_usd: 100 } });
      expect(run.status).toBe(202);
      expect(await run.json()).toMatchObject({ runId: RUN, budget: { max_cost_usd: 5 } });
      const status = await (await fetch(p.server.url + `/api/prime/swarm/runs/${RUN}`, { headers: p.headers })).json();
      expect(status).toMatchObject({ done: true, result: { answer: 'fused' } });
      expect((await fetch(p.server.url + '/swarm.js')).status).toBe(200);
      expect((await fetch(p.server.url + '/swarm.css')).headers.get('content-type')).toContain('text/css');
    } finally { await p.close(); }
  });
  it('reports a down worker in health and refuses run with an explicit 502, never another model', async () => {
    const w = await fakeWorker(); const url = w.url; await stopLast();
    const p = await primeServer(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: url }));
    try {
      expect(await (await fetch(p.server.url + '/api/prime/swarm/health', { headers: p.headers })).json()).toMatchObject({ configured: true, available: false, reason: `Swarm worker unreachable at ${url}` });
      const run = await p.post('/api/prime/swarm/run', { objective: 'hi' });
      expect(run.status).toBe(502); expect((await run.json()).error).toContain('unreachable');
    } finally { await p.close(); }
  });
  it('rejects oversized objectives and malformed run ids with 400/404 and forwards nothing', async () => {
    const w = await fakeWorker(); const p = await primeServer(new SwarmClient({ ...DEFAULT_SWARM, baseUrl: w.url }));
    try {
      expect((await p.post('/api/prime/swarm/run', { objective: 'x'.repeat(12001) })).status).toBe(400);
      expect((await p.post('/api/prime/swarm/run', { objective: 'ok', budget: { max_calls: 'many' } })).status).toBe(400);
      for (const id of ['..%2Fhealth', 'abc', `${RUN}%2Fx`])
        expect((await fetch(p.server.url + `/api/prime/swarm/runs/${id}`, { headers: p.headers })).status).toBe(400);
      expect((await fetch(p.server.url + '/api/prime/swarm/runs/' + RUN + '/extra', { headers: p.headers })).status).toBe(405);
      expect(w.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
});
