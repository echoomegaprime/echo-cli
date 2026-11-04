import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_NAMES = ['operation_started', 'operation_completed', 'operation_failed'] as const;
const OPERATIONS = ['run', 'chat', 'review', 'approve', 'reject', 'revert', 'recover', 'sessions', 'doctor', 'integrations', 'models', 'read', 'list', 'search', 'propose'] as const;
const STATUSES = ['started', 'succeeded', 'failed', 'blocked'] as const;
export interface CodeEvent {
  timestamp: string;
  event: typeof EVENT_NAMES[number];
  operation: typeof OPERATIONS[number];
  status: typeof STATUSES[number];
  sessionId?: string;
  correlationId?: string;
  durationMs?: number;
}
export type AuditResult = { status: 'written' } | {
  status: 'blocked'; reason: 'invalid_event' | 'unsafe_path' | 'busy' | 'size_limit' | 'write_failed';
};
function field(input: object, key: string): unknown {
  // Never execute getters from an untrusted event envelope.
  return Object.getOwnPropertyDescriptor(input, key)?.value;
}
function validated(input: unknown, preserveTimestamp: boolean): CodeEvent {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid event envelope');
  const event = field(input, 'event'), operation = field(input, 'operation'), status = field(input, 'status');
  if (typeof event !== 'string' || !(EVENT_NAMES as readonly string[]).includes(event)) throw new Error('Invalid event name');
  if (typeof operation !== 'string' || !(OPERATIONS as readonly string[]).includes(operation)) throw new Error('Invalid event operation');
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) throw new Error('Invalid event status');
  const result: CodeEvent = { timestamp: new Date().toISOString(), event: event as CodeEvent['event'],
    operation: operation as CodeEvent['operation'], status: status as CodeEvent['status'] };
  for (const key of ['sessionId', 'correlationId'] as const) {
    const value = field(input, key);
    if (value !== undefined) {
      if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid event ${key}`);
      result[key] = value;
    }
  }
  const duration = field(input, 'durationMs');
  if (duration !== undefined) {
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 86400000) throw new Error('Invalid event durationMs');
    result.durationMs = duration;
  }
  if (preserveTimestamp) {
    const timestamp = field(input, 'timestamp');
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
        || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error('Invalid event timestamp');
    result.timestamp = timestamp;
  }
  return result;
}
/** Fixed metadata only: prompts, paths, model text, credentials and raw errors are never copied. */
export function makeEvent(input: unknown): CodeEvent { return validated(input, false); }

function safeDirectory(directory: string): boolean {
  if (typeof directory !== 'string' || !isAbsolute(directory)) return false;
  let current = resolve(directory);
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
function ordinaryFile(stat: Stats): boolean { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }

/** Best-effort audit. A blocked sink must never turn a completed edit into an apparent failure. */
export function appendAuditEvent(directory: string, event: unknown): AuditResult {
  let line: Buffer;
  try { line = Buffer.from(JSON.stringify(validated(event, true)) + '\n'); }
  catch { return { status: 'blocked', reason: 'invalid_event' }; }
  try { if (!safeDirectory(directory)) return { status: 'blocked', reason: 'unsafe_path' }; }
  catch { return { status: 'blocked', reason: 'unsafe_path' }; }
  const path = join(directory, 'events.jsonl'), lock = `${path}.lock`;
  let lockFd: number | undefined, lockStat: Stats | undefined, fd: number | undefined;
  try {
    try { lockFd = openSync(lock, 'wx', 0o600); lockStat = fstatSync(lockFd); }
    catch { return { status: 'blocked', reason: 'busy' }; }
    if (!safeDirectory(directory)) return { status: 'blocked', reason: 'unsafe_path' };
    let prior: Stats | undefined;
    try { prior = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (prior && !ordinaryFile(prior)) return { status: 'blocked', reason: 'unsafe_path' };
    fd = openSync(path, prior ? 'a' : 'ax', 0o600);
    const opened = fstatSync(fd), current = lstatSync(path);
    if (!ordinaryFile(opened) || !ordinaryFile(current) || !sameFile(opened, current)
        || prior && !sameFile(prior, opened)) return { status: 'blocked', reason: 'unsafe_path' };
    if (opened.size + line.length > MAX_AUDIT_BYTES) return { status: 'blocked', reason: 'size_limit' };
    fchmodSync(fd, 0o600);
    let written = 0;
    while (written < line.length) {
      const count = writeSync(fd, line, written, line.length - written);
      if (count <= 0) throw new Error('Incomplete audit append');
      written += count;
    }
    fsyncSync(fd);
    return { status: 'written' };
  } catch { return { status: 'blocked', reason: 'write_failed' }; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Never override an edit result with audit cleanup. */ } }
    if (lockFd !== undefined) { try { closeSync(lockFd); } catch { /* Cleanup remains best-effort. */ } }
    if (lockStat) {
      try { const current = lstatSync(lock); if (ordinaryFile(current) && sameFile(current, lockStat)) unlinkSync(lock); }
      catch { /* Do not remove another writer's lock or expose raw filesystem errors. */ }
    }
  }
}
