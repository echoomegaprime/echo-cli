import { it, expect, describe, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcp } from '../src/prime/stdio.js';
import { sdkBroker } from '../src/prime/sdk.js';
import { unwrap, type Json } from '../src/prime/hub.js';

const BRIDGE = fileURLToPath(new URL('../src/bridge/sdk-stdio.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FAKE_KEY = 'fake-test-key-do-not-use';

interface Recorded { apiKey: string; capability: string; params: Json; context: Json }
let lastRequest: Recorded | undefined;

function obj(v: unknown): Json { return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}; }

function gateHandler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { chunks.push(c); });
  req.on('end', () => {
    const envelope = obj(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    const capability = String(envelope.capability ?? '');
    const params = obj(envelope.params);
    const options = obj(params.options);
    lastRequest = { apiKey: String(req.headers['x-echo-api-key'] ?? ''), capability, params, context: obj(envelope.context) };
    const okEnvelope = (body: unknown, statusCode = 200): string =>
      JSON.stringify({ run_id: 'r1', status: 'ok', result: { status_code: statusCode, body }, trace: {}, warnings: [] });
    const send = (code: number, text: string): void => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(text); };

    if (capability === 'echo.caps.search') {
      const q = String(options.q ?? '');
      if (q === 'HUGE') { send(200, okEnvelope({ ok: true, query: q, count: 1, caps: [{ id: 'echo.big.one', description: 'x'.repeat(1_200_000), tier: 0, scope: 'tier:0' }] })); return; }
      const caps = [
        { id: 'echo.alpha.one', namespace: 'alpha', description: 'first', tier: 0, method: 'POST', scope: 'tier:0' },
        { id: 'echo.beta.two', namespace: 'beta', description: 'second', tier: 2, method: 'POST', scope: 'tier:2' },
      ];
      const body: Json = { ok: true, query: q, count: caps.length, caps };
      if (q === 'TRUNCATE') body.truncated = true;
      send(200, okEnvelope(body));
      return;
    }
    if (capability === 'echo.caps.detail') {
      const id = String(options.capability ?? '');
      send(200, okEnvelope({ ok: true, cap: { id, namespace: 'alpha', description: 'first cap', tier: 0, tier_name: 'open', scope: 'tier:0', method: 'POST', health: 'green', verb: 'one', params: [{ name: 'question', type: 'string', required: true }] } }));
      return;
    }
    if (capability === 'echo.test.ok') { send(200, okEnvelope({ ok: true, answer: 42 })); return; }
    if (capability === 'echo.test.denied') { send(200, okEnvelope({ ok: false, error: 'scope forbidden', required: 'tier:2' }, 403)); return; }
    if (capability === 'echo.test.failbody') { send(200, okEnvelope({ ok: false, error: 'domain said no' }, 200)); return; }
    if (capability === 'echo.test.statusfail') { send(200, JSON.stringify({ run_id: 'r1', status: 'failed', warnings: ['the run failed'] })); return; }
    if (capability === 'echo.test.http4xx') { send(422, JSON.stringify({ detail: 'bad params' })); return; }
    if (capability === 'echo.test.malformed') { send(200, 'not json'); return; }
    send(200, okEnvelope({ ok: true }));
  });
}

let server: Server;
let gateUrl = '';
let keyDir = '';
let keyFile = '';
let conn: StdioMcp;
let broker: Awaited<ReturnType<typeof sdkBroker>>;

beforeAll(async () => {
  server = createServer(gateHandler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  gateUrl = 'http://127.0.0.1:' + port + '/sdk/invoke';
  keyDir = mkdtempSync(join(tmpdir(), 'sdkbridge-'));
  keyFile = join(keyDir, 'sdk-bridge.env');
  writeFileSync(keyFile, 'ECHO_PRIME_SDK_KEY=' + FAKE_KEY + '\n', { mode: 0o600 });
  conn = await StdioMcp.connect({ command: process.execPath, args: ['--import', 'tsx', BRIDGE], cwd: REPO, env: { ECHO_GATE_URL: gateUrl, ECHO_PRIME_SDK_KEY_FILE: keyFile } }, 15000);
  broker = await sdkBroker(conn, { search: 'sdk_search', read: 'sdk_read', invoke: 'sdk_invoke' }, { link_id: 'fixture-account' });
}, 30000);

afterAll(async () => {
  try { conn?.close(); } catch { /* ignore */ }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { rmSync(keyDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('prime sdk bridge', () => {
  it('advertises exactly the three broker tools', async () => {
    const names = (await conn.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['sdk_invoke', 'sdk_read', 'sdk_search']);
  }, 20000);

  it('search returns mapped catalog rows', async () => {
    const rows = await broker.search('alpha');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'echo.alpha.one', tier: 0, scope: 'tier:0', registered: true, category: 'discovered' });
  }, 20000);

  it('search maps the second row tier and scope', async () => {
    const rows = await broker.search('alpha');
    expect(rows[1]).toMatchObject({ id: 'echo.beta.two', tier: 2, scope: 'tier:2' });
  }, 20000);

  it('search sends the exact gate capability and {command,options}', async () => {
    await broker.search('alpha');
    expect(lastRequest?.capability).toBe('echo.caps.search');
    expect(lastRequest?.params).toEqual({ command: 'search', options: { q: 'alpha', limit: 100 } });
  }, 20000);

  it('search forwards the key file value as the gate api key', async () => {
    await broker.search('alpha');
    expect(lastRequest?.apiKey).toBe(FAKE_KEY);
  }, 20000);

  it('search yields a string health even when the gate omits it', async () => {
    const rows = await broker.search('alpha');
    expect(typeof rows[0].health).toBe('string');
  }, 20000);

  it('search throws when the gate reports the catalog truncated', async () => {
    await expect(broker.search('TRUNCATE')).rejects.toThrow(/truncat/i);
  }, 20000);

  it('search with an empty query is refused', async () => {
    await expect(broker.search('')).rejects.toThrow();
  }, 20000);

  it('search throws when the gate body exceeds the 1 MiB bound', async () => {
    await expect(broker.search('HUGE')).rejects.toThrow();
  }, 20000);

  it('read returns a reshaped registered capability record', async () => {
    const record = obj(await broker.read('echo.alpha.one'));
    const cap = obj(record.capability);
    expect(cap.id).toBe('echo.alpha.one');
    expect(record.registration_state).toBe('registered');
    expect(record.health_status).toBe('green');
    expect(cap.required_scope).toBe('tier:0');
  }, 20000);

  it('read sends the exact gate capability and {command,options}', async () => {
    await broker.read('echo.alpha.one');
    expect(lastRequest?.capability).toBe('echo.caps.detail');
    expect(lastRequest?.params).toEqual({ command: 'detail', options: { capability: 'echo.alpha.one' } });
  }, 20000);

  it('read rejects a non-echo capability id', async () => {
    await expect(broker.read('not-an-echo-id')).rejects.toThrow();
  }, 20000);

  it('invoke unwraps to the gate capability body', async () => {
    const raw = await broker.invoke({ capability: 'echo.test.ok', params: { command: 'go', options: {} }, reason: 'because', idempotency_key: 'k1' });
    expect(unwrap(raw)).toEqual({ ok: true, answer: 42 });
  }, 20000);

  it('invoke forwards params and binds reason, idempotency and the fixed account into context', async () => {
    await broker.invoke({ capability: 'echo.test.ok', params: { command: 'go', options: { x: 1 } }, reason: 'because', idempotency_key: 'k1' });
    expect(lastRequest?.capability).toBe('echo.test.ok');
    expect(lastRequest?.params).toEqual({ command: 'go', options: { x: 1 } });
    expect(lastRequest?.context).toMatchObject({ reason: 'because', idempotency_key: 'k1', link_id: 'fixture-account' });
  }, 20000);

  it('invoke sets bypass_reason when the reason is long enough for a tiered cap', async () => {
    const reason = 'This is an explicitly reviewed request that is well over fifty characters long.';
    await broker.invoke({ capability: 'echo.test.ok', params: {}, reason, idempotency_key: 'k2' });
    expect(lastRequest?.context.bypass_reason).toBe(reason);
  }, 20000);

  it('invoke surfaces a scope-denied (403) gate result', async () => {
    const raw = await broker.invoke({ capability: 'echo.test.denied', params: {}, reason: 'r', idempotency_key: 'k3' });
    expect(() => unwrap(raw)).toThrow(/scope/i);
  }, 20000);

  it('invoke surfaces a domain-level body.ok:false', async () => {
    const raw = await broker.invoke({ capability: 'echo.test.failbody', params: {}, reason: 'r', idempotency_key: 'k4' });
    expect(() => unwrap(raw)).toThrow(/domain said no/i);
  }, 20000);

  it('invoke surfaces a failed run envelope', async () => {
    const raw = await broker.invoke({ capability: 'echo.test.statusfail', params: {}, reason: 'r', idempotency_key: 'k5' });
    expect(() => unwrap(raw)).toThrow();
  }, 20000);

  it('invoke surfaces an HTTP 4xx error envelope that has no status field', async () => {
    const raw = await broker.invoke({ capability: 'echo.test.http4xx', params: {}, reason: 'r', idempotency_key: 'k6' });
    expect(() => unwrap(raw)).toThrow(/bad params/i);
  }, 20000);

  it('invoke surfaces a malformed gate response', async () => {
    const raw = await broker.invoke({ capability: 'echo.test.malformed', params: {}, reason: 'r', idempotency_key: 'k7' });
    expect(() => unwrap(raw)).toThrow();
  }, 20000);

  it('invoke rejects a non-echo capability id', async () => {
    const raw = await broker.invoke({ capability: 'bad id', params: {}, reason: 'r', idempotency_key: 'k8' });
    expect(() => unwrap(raw)).toThrow();
  }, 20000);

  it('rejects a tools/call for an unadvertised tool', async () => {
    await expect(conn.call('sdk_unknown', {})).rejects.toThrow();
  }, 20000);
});

describe('prime sdk bridge startup refusals', () => {
  it('refuses a non-loopback gate url', async () => {
    await expect(StdioMcp.connect({ command: process.execPath, args: ['--import', 'tsx', BRIDGE], cwd: REPO, env: { ECHO_GATE_URL: 'http://8.8.8.8:8000/sdk/invoke', ECHO_PRIME_SDK_KEY_FILE: keyFile } }, 8000)).rejects.toThrow();
  }, 20000);

  it('refuses when the key file is missing', async () => {
    await expect(StdioMcp.connect({ command: process.execPath, args: ['--import', 'tsx', BRIDGE], cwd: REPO, env: { ECHO_GATE_URL: gateUrl, ECHO_PRIME_SDK_KEY_FILE: join(keyDir, 'does-not-exist.env') } }, 8000)).rejects.toThrow();
  }, 20000);
});

describe('prime sdk bridge secret hygiene', () => {
  it('never writes the key to stdout/stderr and logs structured events, and initialize advertises tools', async () => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', BRIDGE], { cwd: REPO, env: { ...process.env, ECHO_GATE_URL: gateUrl, ECHO_PRIME_SDK_KEY_FILE: keyFile } });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.on('data', (d: string) => { err += d; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sdk_search', arguments: { query: 'alpha' } } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    child.kill();

    const initLine = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return obj(JSON.parse(l)); } catch { return {}; } }).find((m) => m.id === 1);
    const initResult = obj(initLine?.result);
    expect(initResult.protocolVersion).toBe('2024-11-05');
    expect(obj(initResult.capabilities).tools).toBeDefined();

    expect(out.includes(FAKE_KEY)).toBe(false);
    expect(err.includes(FAKE_KEY)).toBe(false);
    const hasStructured = err.split('\n').some((l) => { try { return typeof obj(JSON.parse(l)).event === 'string'; } catch { return false; } });
    expect(hasStructured).toBe(true);
  }, 20000);
});
