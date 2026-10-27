import type { SessionStore, Session } from './sessions.js';
import { hash, redact } from './workspace.js';
import type { Workspace } from './workspace.js';

export interface CapturePayload { kind: 'artifact'; title: string; detail: string; requestId: string }
export interface CaptureReceipt {
  id: string; eventId: string; kind: 'artifact'; requestId: string;
  saved: true; verified: true; duplicate: boolean; contentSha256: string;
}
export interface MemoryCheckpoint {
  version: 1; payload: CapturePayload; contentSha256: string;
  state: 'prepared' | 'blocked' | 'uncertain' | 'saved' | 'verified' | 'conflict';
  reason?: 'host_broker_not_attached' | 'write_scope_missing' | 'read_scope_missing' |
    'capture_transport_unavailable' | 'capture_receipt_invalid' | 'request_id_conflict' |
    'capture_outcome_unknown' | 'recall_transport_unavailable' | 'recall_not_matched';
  receipt?: CaptureReceipt;
}
export type ContinuityInvoker = (request: {
  capability: 'echo.continuity.capture' | 'echo.continuity.recall';
  params: CapturePayload | { query: string }; idempotencyKey?: string;
  reason: string; signal: AbortSignal;
}) => Promise<unknown>;

const hasControl = (text: string) => [...text].some(char => {
  const code = char.charCodeAt(0); return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
});
const contentOf = (payload: CapturePayload) => `${payload.title}\n${payload.detail}`.trim();
function payloadFor(sessionId: string, title: string, detail: string): CapturePayload {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
      typeof detail !== 'string' || detail.length > 20000 ||
      hasControl(title + detail)) throw new Error('Invalid checkpoint title or detail');
  title = title.trim(); detail = detail.trim();
  if (redact(title) !== title || redact(detail) !== detail) throw new Error('Secret-like checkpoint content refused');
  const digest = hash(JSON.stringify({ kind: 'artifact', title, detail }));
  return { kind: 'artifact', title, detail, requestId: `echo-code:${sessionId}:${digest}` };
}
function checkpoints(session: Session): MemoryCheckpoint[] {
  const items = session.checkpoints ?? [];
  if (!Array.isArray(items) || items.length > 20) throw new Error('Checkpoint integrity invalid');
  for (const item of items) {
    if (!item || item.version !== 1 || !item.payload || item.payload.kind !== 'artifact') throw new Error('Checkpoint integrity invalid');
    const expected = payloadFor(session.id, item.payload.title, item.payload.detail);
    if (JSON.stringify(item.payload) !== JSON.stringify(expected) || item.contentSha256 !== hash(contentOf(expected)) ||
        !['prepared', 'blocked', 'uncertain', 'saved', 'verified', 'conflict'].includes(item.state)) throw new Error('Checkpoint integrity invalid');
    if (item.receipt && !validReceipt(item.receipt, item)) throw new Error('Checkpoint receipt integrity invalid');
    if (['saved', 'verified'].includes(item.state) && !item.receipt) throw new Error('Checkpoint receipt missing');
  }
  return items;
}
function sessionFor(store: SessionStore, workspace: Workspace, id: string) {
  const session = store.get(id);
  if (session.workspace !== workspace.root) throw new Error('Session workspace mismatch');
  return session;
}
export function listCheckpoints(store: SessionStore, workspace: Workspace, sessionId: string): MemoryCheckpoint[] {
  return checkpoints(sessionFor(store, workspace, sessionId));
}
/** Explicit caller-supplied summary only. Never copy source, paths or transcripts automatically. */
export function prepareCheckpoint(store: SessionStore, workspace: Workspace, sessionId: string, title: string, detail: string): MemoryCheckpoint {
  const payload = payloadFor(sessionId, title, detail), release = store.lease(sessionId);
  try {
    const session = sessionFor(store, workspace, sessionId), items = checkpoints(session);
    const existing = items.find(item => item.payload.requestId === payload.requestId);
    if (existing) return existing;
    if (items.length >= 20) throw new Error('Checkpoint limit reached');
    const item: MemoryCheckpoint = { version: 1, payload, contentSha256: hash(contentOf(payload)), state: 'prepared' };
    session.checkpoints = [...items, item]; store.save(session); return item;
  } finally { release(); }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function response(value: unknown) {
  const wrapper = record(value), root = record(wrapper.structuredContent ?? value);
  const sdk = record(root.sdk_result), result = record(sdk.result), body = record(result.body);
  return { root, sdk, result, body, data: record(body.result) };
}
function ownerData(value: unknown): Record<string, unknown> | undefined {
  const r = response(value);
  if (r.root.ok !== true || r.sdk.status !== 'ok' || r.result.status_code !== 200 ||
      r.body.ok !== true || r.body.service !== 'echo-continuity-fabric-mcp') return;
  return r.data;
}
function denied(value: unknown) {
  const r = response(value);
  return r.root.error === 'scope_forbidden' || r.sdk.error === 'scope_forbidden' ||
    r.result.status_code === 401 || r.result.status_code === 403 ||
    ['scope_forbidden', 'insufficient_scope', 'operator_required'].includes(String(r.body.error));
}
function conflicting(value: unknown) {
  const r = response(value);
  return r.root.error === 'request_id_conflict' || r.result.status_code === 409 || r.body.error === 'request_id_conflict';
}
function validReceipt(value: unknown, checkpoint: MemoryCheckpoint): value is CaptureReceipt {
  const r = record(value), id = /^[a-zA-Z0-9_-]{1,100}$/;
  return typeof r.id === 'string' && id.test(r.id) && typeof r.eventId === 'string' && id.test(r.eventId) &&
    r.kind === 'artifact' && r.requestId === checkpoint.payload.requestId && r.saved === true &&
    r.verified === true && typeof r.duplicate === 'boolean' && r.contentSha256 === checkpoint.contentSha256;
}
function receiptFields(receipt: CaptureReceipt): CaptureReceipt {
  return { id: receipt.id, eventId: receipt.eventId, kind: receipt.kind, requestId: receipt.requestId,
    saved: true, verified: true, duplicate: receipt.duplicate, contentSha256: receipt.contentSha256 };
}
function recallMatches(value: unknown, checkpoint: MemoryCheckpoint): boolean {
  const data = ownerData(value), receipt = checkpoint.receipt;
  if (!data || !receipt || !Array.isArray(data.events) || data.events.length > 20) return false;
  const expected = contentOf(checkpoint.payload);
  return data.events.some(value => {
    const event = record(value);
    if (event.id !== receipt.eventId || event.event_type !== 'ARTIFACT_REGISTERED' ||
        event.content_sha256 !== checkpoint.contentSha256) return false;
    return event.content_text === expected || (expected.length > 1200 && event.excerpt_truncated === true &&
      event.content_text === expected.slice(0, 1199) + '\u2026');
  });
}
/** Bounds local waiting; abort is best effort. A late remote write remains uncertain and
 * must be retried with this same durable request ID through the same authorized owner. */
async function boundedInvoke(invoke: ContinuityInvoker, request: Omit<Parameters<ContinuityInvoker>[0], 'signal'>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke({ ...request, signal: controller.signal })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Owner timeout')); }, 15000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
/** Existing host broker only. No credentials, scopes, alternate transport or automatic retry.
 * Receipt verification confirms persisted bytes, never the truth of captured assertions. */
export async function syncCheckpoint(store: SessionStore, workspace: Workspace, sessionId: string, requestId: string, invoke?: ContinuityInvoker): Promise<MemoryCheckpoint> {
  const release = store.lease(sessionId);
  try {
    const session = sessionFor(store, workspace, sessionId);
    const item = checkpoints(session).find(c => c.payload.requestId === requestId);
    if (!item) throw new Error('Checkpoint not found');
    if (item.state === 'verified' || item.state === 'conflict') return item;
    const save = (state: MemoryCheckpoint['state'], reason?: MemoryCheckpoint['reason']) => {
      item.state = state; if (reason) item.reason = reason; else delete item.reason;
      store.save(session); return item;
    };
    if (!invoke) return save(item.receipt ? 'saved' : item.state === 'uncertain' ? 'uncertain' : 'blocked', 'host_broker_not_attached');
    if (!item.receipt) {
      // Persist before the call: process death or a lost reply cannot erase request identity.
      save('uncertain', 'capture_outcome_unknown');
      let reply: unknown;
      try {
        reply = await boundedInvoke(invoke, { capability: 'echo.continuity.capture',
          params: structuredClone(item.payload), idempotencyKey: item.payload.requestId,
          reason: 'Save the explicitly prepared ECHO Code checkpoint through the existing authorized Fabric owner.' });
      } catch { return save('uncertain', 'capture_transport_unavailable'); }
      if (denied(reply)) return save('blocked', 'write_scope_missing');
      if (conflicting(reply)) return save('conflict', 'request_id_conflict');
      const receipt = ownerData(reply);
      if (!validReceipt(receipt, item)) return save('uncertain', 'capture_receipt_invalid');
      item.receipt = receiptFields(receipt); save('saved');
    }
    let recall: unknown;
    try {
      recall = await boundedInvoke(invoke, { capability: 'echo.continuity.recall',
        params: { query: item.receipt.eventId },
        reason: 'Verify the saved ECHO Code checkpoint by exact event identity and content hash.' });
    } catch { return save('saved', 'recall_transport_unavailable'); }
    if (denied(recall)) return save('saved', 'read_scope_missing');
    return recallMatches(recall, item) ? save('verified') : save('saved', 'recall_not_matched');
  } finally { release(); }
}
