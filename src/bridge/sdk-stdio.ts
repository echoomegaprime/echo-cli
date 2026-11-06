/**
 * Echo Prime SDK bridge — a zero-dependency Node stdio MCP server.
 *
 * Prime's `sdkBroker` (src/prime/sdk.ts) speaks to its authenticated SDK host
 * through `StdioMcp` (src/prime/stdio.ts). In production that host was absent
 * (`"sdk":false` at startup), so the SDK-backed live tools, autonomous
 * agent/bot creation and the ECF hooks could not act. This process IS that
 * host: it advertises exactly the three tools the broker calls and forwards
 * them to the Echo SDK gate on loopback.
 *
 *   sdk_search  -> echo.caps.search   (reshaped to the broker's catalog rows)
 *   sdk_read    -> echo.caps.detail   (reshaped to the broker's cap record)
 *   sdk_invoke  -> the requested echo.* capability with its params
 *
 * Security properties:
 *   - The API key is read only from the file named by ECHO_PRIME_SDK_KEY_FILE
 *     and is never written to stdout, stderr, or any result.
 *   - The gate URL (ECHO_GATE_URL) must be loopback; anything else refuses at
 *     startup.
 *   - 30 s per-call timeout, 1 MiB caps on gate bodies and emitted results.
 *   - Every tool result is returned as MCP text content (untrusted data that
 *     Prime's `unwrap` decodes); strings are redacted before they leave.
 *   - No npm dependencies: Node built-ins and the global fetch only.
 */
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const MAX_BYTES = 1024 * 1024; // 1 MiB
const GATE_TIMEOUT_MS = 30_000;
/** Ceiling for a caller-chosen invoke wait (`timeout_ms`): long generations (music, video submits, on-prem images). */
const MAX_INVOKE_TIMEOUT_MS = Math.min(900_000, Math.max(GATE_TIMEOUT_MS, Number(process.env.ECHO_PRIME_SDK_MAX_TIMEOUT_MS) || 600_000));
const PROTOCOL_VERSION = '2024-11-05';
const CAP_ID_RE = /^echo\.[A-Za-z0-9_.-]{1,180}$/;

const GATE_URL = process.env.ECHO_GATE_URL ?? 'http://127.0.0.1:8000/sdk/invoke';
const KEY_FILE = process.env.ECHO_PRIME_SDK_KEY_FILE ?? '/home/forge/prime-prod/sdk-bridge.env';
const TOOL_SEARCH = process.env.ECHO_PRIME_SDK_TOOL_SEARCH ?? 'sdk_search';
const TOOL_READ = process.env.ECHO_PRIME_SDK_TOOL_READ ?? 'sdk_read';
const TOOL_INVOKE = process.env.ECHO_PRIME_SDK_TOOL_INVOKE ?? 'sdk_invoke';

let apiKey = '';

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Only the loopback interface is ever an acceptable gate. */
function isLoopback(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Strip the live key and obvious secret shapes from anything we emit. */
function redact(text: string): string {
  let out = text;
  if (apiKey.length >= 6 && out.includes(apiKey)) out = out.split(apiKey).join('[REDACTED]');
  out = out.replace(/((?:x-echo-api-key|authorization|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
  out = out.replace(/\b(sk-[A-Za-z0-9]{8,})\b/g, '[REDACTED]');
  return out;
}

/** Structured stderr log line; never carries the key or a full body. */
function log(entry: Json): void {
  try { process.stderr.write(redact(JSON.stringify(entry)) + '\n'); } catch { /* best effort */ }
}

interface GateOk { ok: true; body: Json }
interface GateErr { ok: false; error: string; required?: string }
type GateResult = GateOk | GateErr;

function detailOf(obj: Json): string {
  const direct = asString(obj.error) || asString(obj.detail) || asString(obj.reason) || asString(obj.message);
  if (direct) return redact(direct).slice(0, 600);
  if (obj.detail !== undefined) return redact(JSON.stringify(obj.detail)).slice(0, 600);
  return '';
}

/** Forward one envelope to the loopback gate and peel its result, failing closed. */
async function callGate(capability: string, params: Json, context: Json, timeoutMs = GATE_TIMEOUT_MS): Promise<GateResult> {
  const payload = JSON.stringify({ envelope_version: 1, capability, params, context });
  if (Buffer.byteLength(payload) > MAX_BYTES) return { ok: false, error: 'SDK request exceeds bounded limit' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(GATE_URL, {
      method: 'POST',
      headers: { 'X-Echo-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === 'AbortError';
    log({ event: 'gate_error', capability, ms: Date.now() - started, reason: aborted ? 'timeout' : 'unreachable' });
    return { ok: false, error: aborted ? 'SDK gate timed out; outcome unknown' : 'SDK gate unreachable' };
  }
  clearTimeout(timer);

  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) {
    log({ event: 'gate_error', capability, reason: 'response_too_large', bytes: Buffer.byteLength(text) });
    return { ok: false, error: 'SDK gate response exceeds bounded limit' };
  }
  const parsed = safeParse(text);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log({ event: 'gate_error', capability, reason: 'malformed_json' });
    return { ok: false, error: 'SDK gate returned an unrecognized response' };
  }
  const envelope = parsed as Json;

  // Transport failure first — error envelopes do not carry the success shape.
  if (!response.ok) {
    const required = asString(envelope.required) || undefined;
    log({ event: 'gate_error', capability, http: response.status, ms: Date.now() - started });
    return { ok: false, error: detailOf(envelope) || 'SDK gate HTTP ' + response.status, ...(required ? { required } : {}) };
  }
  const status = asString(envelope.status).toLowerCase();
  if (status && !['ok', 'success', 'succeeded', 'completed', 'done'].includes(status)) {
    const warn = Array.isArray(envelope.warnings) && envelope.warnings.length ? redact(String(envelope.warnings[0])).slice(0, 600) : '';
    log({ event: 'gate_error', capability, status, ms: Date.now() - started });
    return { ok: false, error: detailOf(envelope) || warn || 'SDK gate status ' + status };
  }

  // Extract the gate's result ({status_code, body}); tolerate a REST {success,data} shape.
  let result: Json | undefined;
  if (envelope.result !== undefined) {
    result = asObject(envelope.result);
  } else if (envelope.data !== undefined && 'success' in envelope) {
    if (envelope.success === false) return { ok: false, error: detailOf(envelope) || 'SDK gate reported failure' };
    result = { status_code: 200, body: envelope.data };
  }
  if (!result) {
    log({ event: 'gate_error', capability, reason: 'no_result' });
    return { ok: false, error: 'SDK gate returned no result' };
  }

  const statusCode = result.status_code;
  let body: unknown = result.body;
  if (typeof statusCode === 'number' && (statusCode < 200 || statusCode >= 300)) {
    const parsedBody = typeof body === 'string' ? asObject(safeParse(body)) : asObject(body);
    const required = asString(parsedBody.required) || (statusCode === 401 || statusCode === 403 ? 'scope required' : '') || undefined;
    log({ event: 'gate_error', capability, status_code: statusCode, ms: Date.now() - started });
    return { ok: false, error: detailOf(parsedBody) || 'SDK capability HTTP ' + statusCode, ...(required ? { required } : {}) };
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_BYTES) return { ok: false, error: 'SDK gate body exceeds bounded limit' };
    const decoded = safeParse(body);
    if (decoded === undefined) return { ok: false, error: 'SDK gate returned an unrecognized body' };
    body = decoded;
  }
  log({ event: 'gate_ok', capability, ms: Date.now() - started });
  return { ok: true, body: asObject(body) };
}

/** echo.caps.search body.caps[] -> the row shape sdkBroker.search maps. */
function mapSearch(body: Json): Json {
  const rows = Array.isArray(body.caps) ? body.caps : Array.isArray(body.results) ? body.results : [];
  const results = rows.map((row) => {
    const cap = asObject(row);
    const scope = asString(cap.scope) || asString(cap.required_scope);
    const tier = Number(cap.tier ?? cap.danger_tier ?? 0);
    return {
      id: asString(cap.id) || asString(cap.capability_id),
      description: asString(cap.description),
      registered: typeof cap.registered === 'boolean' ? cap.registered : true,
      health_status: asString(cap.health) || asString(cap.health_status) || 'unknown',
      metadata: { required_scope: scope, danger_tier: Number.isFinite(tier) ? tier : 0 },
    };
  });
  return { results, sdk_catalog: { truncated: body.truncated === true } };
}

/** echo.caps.detail body.cap -> the record hub.ts/autoagents read (capability + registration_state + health_status). */
function mapRead(body: Json): Json {
  const cap = asObject(body.cap ?? body.capability);
  const scope = asString(cap.scope) || asString(cap.required_scope);
  const capability: Json = { ...cap, required_scope: scope, metadata: { danger_tier: cap.tier, required_scope: scope } };
  return {
    ok: true,
    capability,
    registration_state: 'registered',
    health_status: asString(cap.health) || asString(cap.health_status) || 'unknown',
  };
}

async function handleSearch(args: Json): Promise<Json> {
  const query = (asString(args.query) || asString(args.q)).trim();
  if (!query) return { ok: false, error: 'search requires a query' };
  if (query.length > 300) return { ok: false, error: 'search query is too long' };
  let limit = Number(args.max_results ?? args.limit ?? 100);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  limit = Math.min(200, Math.floor(limit));
  const gate = await callGate('echo.caps.search', { command: 'search', options: { q: query, limit } }, {});
  if (!gate.ok) return { ok: false, error: gate.error, ...(gate.required ? { required: gate.required } : {}) };
  return mapSearch(gate.body);
}

async function handleRead(args: Json): Promise<Json> {
  const capability = asString(args.capability).trim();
  if (!CAP_ID_RE.test(capability)) return { ok: false, error: 'read requires a valid echo.* capability id' };
  const gate = await callGate('echo.caps.detail', { command: 'detail', options: { capability } }, {});
  if (!gate.ok) return { ok: false, error: gate.error, ...(gate.required ? { required: gate.required } : {}) };
  return mapRead(gate.body);
}

async function handleInvoke(args: Json): Promise<Json> {
  const capability = asString(args.capability).trim();
  if (!CAP_ID_RE.test(capability)) return { ok: false, error: 'invoke requires a valid echo.* capability id' };
  const params = asObject(args.params);
  const reason = asString(args.reason);
  const idempotency = asString(args.idempotency_key);
  const context: Json = {};
  // The authenticated host owns account/credential selection: forward any fixed
  // arguments (anything beyond the known fields) to the gate as context rather
  // than dropping them.
  for (const [key, value] of Object.entries(args)) {
    if (key === 'capability' || key === 'params' || key === 'reason' || key === 'idempotency_key' || key === 'timeout_ms') continue;
    context[key] = value;
  }
  // The caller's wait for this one call (Prime sends it for long generations); bounded, and never forwarded to the gate.
  const requested = Number(args.timeout_ms);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_INVOKE_TIMEOUT_MS, Math.max(1000, Math.round(requested))) : GATE_TIMEOUT_MS;
  if (reason) context.reason = reason.slice(0, 600);
  if (idempotency) context.idempotency_key = idempotency.slice(0, 200);
  if (reason.length >= 50) context.bypass_reason = reason.slice(0, 600);
  const gate = await callGate(capability, params, context, timeoutMs);
  if (!gate.ok) return { ok: false, error: gate.error, ...(gate.required ? { required: gate.required } : {}) };
  return gate.body;
}

function toolDefinitions(): Json[] {
  return [
    {
      name: TOOL_SEARCH,
      description: 'Search the Echo SDK capability registry (read-only).',
      inputSchema: { type: 'object', additionalProperties: true, properties: { query: { type: 'string' }, q: { type: 'string' }, max_results: { type: 'integer' }, limit: { type: 'integer' }, target: { type: 'string' } } },
    },
    {
      name: TOOL_READ,
      description: 'Read the detail and schema of one Echo SDK capability (read-only).',
      inputSchema: { type: 'object', additionalProperties: true, required: ['capability'], properties: { capability: { type: 'string' }, target: { type: 'string' } } },
    },
    {
      name: TOOL_INVOKE,
      description: 'Invoke an Echo SDK capability through the authenticated loopback gate.',
      inputSchema: { type: 'object', additionalProperties: true, required: ['capability'], properties: { capability: { type: 'string' }, params: { type: 'object' }, reason: { type: 'string' }, idempotency_key: { type: 'string' }, timeout_ms: { type: 'integer' } } },
    },
  ];
}

function write(message: Json): void {
  try { process.stdout.write(JSON.stringify(message) + '\n'); } catch { /* best effort */ }
}
function sendResult(id: unknown, result: Json): void {
  write({ jsonrpc: '2.0', id, result });
}
function sendError(id: unknown, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}
function sendContent(id: unknown, payload: Json): void {
  let text = redact(JSON.stringify(payload));
  if (Buffer.byteLength(text) > MAX_BYTES) {
    log({ event: 'result_too_large', bytes: Buffer.byteLength(text) });
    text = JSON.stringify({ ok: false, error: 'SDK result exceeds bounded limit' });
  }
  sendResult(id, { content: [{ type: 'text', text }] });
}

async function handleToolCall(id: unknown, params: Json): Promise<void> {
  const name = asString(params.name);
  const args = asObject(params.arguments);
  if (name === TOOL_SEARCH) return sendContent(id, await handleSearch(args));
  if (name === TOOL_READ) return sendContent(id, await handleRead(args));
  if (name === TOOL_INVOKE) return sendContent(id, await handleInvoke(args));
  sendError(id, -32602, 'Unknown tool');
}

async function handleLine(line: string): Promise<void> {
  const parsed = safeParse(line);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log({ event: 'bad_input', reason: 'parse' });
    return;
  }
  const message = parsed as Json;
  if (message.jsonrpc !== '2.0') { log({ event: 'bad_input', reason: 'jsonrpc' }); return; }
  const id = message.id;
  const method = asString(message.method);
  if (id === undefined || id === null) return; // notification; nothing to answer
  try {
    if (method === 'initialize') {
      return sendResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'echo-prime-sdk-bridge', version: '1.0.0' } });
    }
    if (method === 'tools/list') return sendResult(id, { tools: toolDefinitions() });
    if (method === 'ping') return sendResult(id, {});
    if (method === 'tools/call') return await handleToolCall(id, asObject(message.params));
    sendError(id, -32601, 'Method not found');
  } catch (error) {
    log({ event: 'handler_error', method, error: redact(error instanceof Error ? error.message : 'error').slice(0, 200) });
    sendError(id, -32603, 'Internal error');
  }
}

function main(): void {
  if (!isLoopback(GATE_URL)) { log({ event: 'startup_refused', reason: 'gate_url_not_loopback' }); process.exit(1); }
  try {
    const raw = readFileSync(KEY_FILE, 'utf8');
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('ECHO_PRIME_SDK_KEY='));
    let value = line ? line.slice('ECHO_PRIME_SDK_KEY='.length).trim() : '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    apiKey = value;
  } catch {
    log({ event: 'startup_refused', reason: 'key_file_unreadable' });
    process.exit(1);
  }
  if (!apiKey) { log({ event: 'startup_refused', reason: 'key_missing' }); process.exit(1); }

  let buffer = '';
  const onData = (chunk: string): void => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 2 * MAX_BYTES) { buffer = ''; log({ event: 'input_overflow' }); return; }
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) void handleLine(line);
      index = buffer.indexOf('\n');
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  log({ event: 'started', gate: GATE_URL, tools: [TOOL_SEARCH, TOOL_READ, TOOL_INVOKE] });
}

main();
