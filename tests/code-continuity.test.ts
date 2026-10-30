import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/code/sessions.js';
import { Workspace } from '../src/code/workspace.js';
import { prepareCheckpoint, listCheckpoints, syncCheckpoint } from '../src/code/continuity.js';
import type { MemoryCheckpoint, ContinuityInvoker } from '../src/code/continuity.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-continuity-')); roots.push(root);
  const store = new SessionStore(join(root, 'state')), workspace = new Workspace(root, [store.directory]);
  writeFileSync(join(root, 'source.txt'), 'unchanged');
  const session = store.create(workspace.root, 'fixture');
  const checkpoint = prepareCheckpoint(store, workspace, session.id, 'Checkpoint', 'Tests passed; release remains open.');
  return { root, store, workspace, session, checkpoint };
}
afterEach(() => { vi.useRealTimers(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const envelope = (result: unknown) => ({ ok: true, sdk_result: { status: 'ok', result: {
  status_code: 200, body: { ok: true, service: 'echo-continuity-fabric-mcp', result },
} } });
function receipt(c: MemoryCheckpoint, overrides = {}) {
  return { id: 'art_1234567890abcdef1234567890abcdef', eventId: 'evt_1234567890abcdef1234567890abcdef',
    kind: 'artifact', requestId: c.payload.requestId, saved: true, verified: true, duplicate: false,
    contentSha256: c.contentSha256, ...overrides };
}
function recalled(c: MemoryCheckpoint, overrides = {}) {
  return envelope({ events: [{ id: receipt(c).eventId, event_type: 'ARTIFACT_REGISTERED',
    content_text: `${c.payload.title}\n${c.payload.detail}`.trim(),
    content_sha256: c.contentSha256, ...overrides }] });
}
function sync(f: ReturnType<typeof fixture>, invoke?: ContinuityInvoker) {
  return syncCheckpoint(f.store, f.workspace, f.session.id, f.checkpoint.payload.requestId, invoke);
}

describe('durable continuity outbox', () => {
  it('preserves one immutable request across prepare and process restart without including source or transcripts', () => {
    const f = fixture();
    f.store.append(f.session.id, { role: 'user', content: 'PRIVATE TRANSCRIPT' });
    const same = prepareCheckpoint(f.store, f.workspace, f.session.id, ' Checkpoint ', ' Tests passed; release remains open. ');
    expect(same).toEqual(f.checkpoint);
    expect(listCheckpoints(new SessionStore(f.store.directory), f.workspace, f.session.id)).toEqual([f.checkpoint]);
    expect(JSON.stringify(f.checkpoint)).not.toContain(f.root);
    expect(JSON.stringify(f.checkpoint)).not.toContain('PRIVATE TRANSCRIPT');
    expect(JSON.stringify(f.checkpoint)).not.toContain('source.txt');
  });

  it('keeps a denied write blocked and does not treat owner status or tier:1 as a write grant', async () => {
    const f = fixture(); let calls = 0;
    const result = await sync(f, async request => {
      calls++; expect(request.capability).toBe('echo.continuity.capture');
      expect(request.params).toEqual(f.checkpoint.payload);
      expect(request.idempotencyKey).toBe(f.checkpoint.payload.requestId);
      return { ok: false, error: 'scope_forbidden', required: 'continuity.write', canWrite: true, granted: ['tier:1'], secret: 'DO NOT PERSIST' };
    });
    expect(result).toMatchObject({ state: 'blocked', reason: 'write_scope_missing' });
    expect(result.receipt).toBeUndefined(); expect(calls).toBe(1);
    expect(JSON.stringify(f.store.get(f.session.id))).not.toContain('DO NOT PERSIST');
  });

  it('accepts a save only after a matching receipt and independent recall', async () => {
    const f = fixture(), calls: string[] = [];
    const result = await sync(f, async request => {
      calls.push(request.capability);
      return request.capability === 'echo.continuity.capture' ? envelope(receipt(f.checkpoint)) : recalled(f.checkpoint);
    });
    expect(result.state).toBe('verified');
    expect(calls).toEqual(['echo.continuity.capture', 'echo.continuity.recall']);
    expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('unchanged');
    expect(listCheckpoints(new SessionStore(f.store.directory), f.workspace, f.session.id)[0].state).toBe('verified');
    expect((await sync(f, async () => { throw new Error('No replay after verification'); })).state).toBe('verified');
  });

  it.each([
    { requestId: 'wrong-request' }, { contentSha256: '0'.repeat(64) },
    { saved: false }, { verified: false }, { kind: 'decision' }, { eventId: '' },
  ])('refuses a receipt with mismatched or missing evidence: %j', async overrides => {
    const f = fixture(); let calls = 0;
    const result = await sync(f, async () => { calls++; return envelope(receipt(f.checkpoint, overrides)); });
    expect(result).toMatchObject({ state: 'uncertain', reason: 'capture_receipt_invalid' });
    expect(calls).toBe(1); expect(result.receipt).toBeUndefined();
  });

  it('does not infer persistence from HTTP 200 or the wrong service identity', async () => {
    const f = fixture();
    const result = await sync(f, async () => ({ ok: true, sdk_result: { status: 'ok', result: {
      status_code: 200, body: { ok: true, service: 'unrelated-service', result: receipt(f.checkpoint) },
    } } }));
    expect(result.state).toBe('uncertain');
  });

  it('reuses the same payload after a lost response and accepts a duplicate receipt', async () => {
    const f = fixture(), requests: unknown[] = [];
    const first = await sync(f, async request => { requests.push(request.params); throw new Error('PRIVATE FAILURE'); });
    expect(first).toMatchObject({ state: 'uncertain', reason: 'capture_transport_unavailable' });
    const restored = { ...f, store: new SessionStore(f.store.directory) };
    const result = await sync(restored, async request => {
      if (request.capability === 'echo.continuity.capture') { requests.push(request.params); return envelope(receipt(f.checkpoint, { duplicate: true })); }
      return recalled(f.checkpoint);
    });
    expect(result.state).toBe('verified'); expect(requests[0]).toEqual(requests[1]);
    expect(result.receipt?.duplicate).toBe(true);
    expect(JSON.stringify(f.store.get(f.session.id))).not.toContain('PRIVATE FAILURE');
  });

  it('retries only recall when capture succeeded but recall was unavailable', async () => {
    const f = fixture();
    const first = await sync(f, async request => {
      if (request.capability === 'echo.continuity.capture') return envelope(receipt(f.checkpoint));
      throw new Error('offline');
    });
    expect(first).toMatchObject({ state: 'saved', reason: 'recall_transport_unavailable' });
    const result = await sync(f, async request => {
      expect(request.capability).toBe('echo.continuity.recall');
      expect(request.params).toEqual({ query: receipt(f.checkpoint).eventId });
      return recalled(f.checkpoint);
    });
    expect(result.state).toBe('verified');
  });

  it('preserves a conflict and refuses another automatic capture attempt', async () => {
    const f = fixture();
    const first = await sync(f, async () => ({ ok: true, sdk_result: { status: 'error', result: { status_code: 409, body: { error: 'request_id_conflict' } } } }));
    expect(first).toMatchObject({ state: 'conflict', reason: 'request_id_conflict' });
    expect((await sync(f, async () => { throw new Error('Must not retry conflict'); })).state).toBe('conflict');
  });

  it('does not mark a receipt verified when recall content differs', async () => {
    const f = fixture();
    const result = await sync(f, async request => request.capability === 'echo.continuity.capture'
      ? envelope(receipt(f.checkpoint)) : recalled(f.checkpoint, { content_text: 'different content' }));
    expect(result).toMatchObject({ state: 'saved', reason: 'recall_not_matched' });
  });

  it('matches a bounded recall excerpt only with the full expected content hash', async () => {
    const f = fixture();
    f.checkpoint = prepareCheckpoint(f.store, f.workspace, f.session.id, 'Long checkpoint', 'x'.repeat(1300));
    const content = `${f.checkpoint.payload.title}\n${f.checkpoint.payload.detail}`;
    const result = await sync(f, async request => request.capability === 'echo.continuity.capture'
      ? envelope(receipt(f.checkpoint)) : recalled(f.checkpoint, { content_text: content.slice(0, 1199) + '\u2026', excerpt_truncated: true }));
    expect(result.state).toBe('verified');
  });

  it('rejects modified pending payloads before dispatch', async () => {
    const f = fixture(), session = f.store.get(f.session.id);
    session.checkpoints![0].payload.detail = 'tampered'; f.store.save(session);
    let calls = 0;
    await expect(sync(f, async () => { calls++; return {}; })).rejects.toThrow(/checkpoint integrity/i);
    expect(calls).toBe(0);
  });

  it('rejects secret-like input and a wrong workspace before persistence', () => {
    const f = fixture(), before = f.store.get(f.session.id);
    expect(() => prepareCheckpoint(f.store, f.workspace, f.session.id, 'Secrets', 'api_key="sensitive-example-value"')).toThrow(/secret/i);
    const other = fixture();
    expect(() => listCheckpoints(f.store, other.workspace, f.session.id)).toThrow(/workspace/i);
    expect(f.store.get(f.session.id)).toEqual(before);
  });

  it('retains uncertainty when the broker is later unavailable', async () => {
    const f = fixture();
    await sync(f, async () => { throw new Error('lost reply'); });
    expect(await sync(f)).toMatchObject({ state: 'uncertain', reason: 'host_broker_not_attached' });
  });

  it('does not dispatch while another operation holds the session lease', async () => {
    const f = fixture(), release = f.store.lease(f.session.id), invoke = vi.fn(async () => ({}));
    try { await expect(sync(f, invoke)).rejects.toThrow(/session busy/i); }
    finally { release(); }
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['title', 'detail'] as const)('rejects control characters in %s', field => {
    const f = fixture();
    expect(() => prepareCheckpoint(f.store, f.workspace, f.session.id,
      field === 'title' ? 'title' + String.fromCharCode(0) : 'title',
      field === 'detail' ? 'detail' + String.fromCharCode(27) : 'detail')).toThrow(/invalid checkpoint/i);
  });

  it('bounds a hung capture, preserves the uncertain request and releases the session lease', async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = sync(f, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toMatchObject({ state: 'uncertain', reason: 'capture_transport_unavailable' });
    const release = f.store.lease(f.session.id); release();
  });
});
