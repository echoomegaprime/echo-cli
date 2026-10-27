import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let events: typeof import('../src/code/events.js');
beforeAll(async () => {
  const modulePath = '../src/code/events.js';
  events = existsSync(new URL('../src/code/events.ts', import.meta.url))
    ? await import(modulePath) : {} as typeof events;
});
const roots: string[] = [];
const sessionId = 'd68a60c1-d7f9-45b0-9a8b-d6ff6e0f8c65';
const correlationId = '93653b42-f242-4656-a6ca-42d216114544';
const input = { event: 'operation_completed', operation: 'approve', status: 'succeeded', sessionId, correlationId, durationMs: 12 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-events-')); roots.push(root);
  const directory = join(root, 'sessions'); mkdirSync(directory);
  return { root, directory, path: join(directory, 'events.jsonl') };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('metadata-only structured events', () => {
  it('keeps only fixed fields and replaces any supplied timestamp with the current UTC time', () => {
    expect(typeof events.makeEvent).toBe('function');
    const event = events.makeEvent({ ...input, prompt: 'private prompt', path: '/secret/location', source: 'private source',
      auth: 'private auth', error: { body: 'private error' }, details: 'private details', timestamp: 'private timestamp' });
    expect(Object.keys(event).sort()).toEqual(['timestamp', 'event', 'operation', 'status', 'sessionId', 'correlationId', 'durationMs'].sort());
    expect(JSON.stringify(event)).not.toContain('private');
    expect(event).toMatchObject(input);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });
  it.each([
    { event: 'secret-event-name' }, { operation: 'secret-operation' }, { status: 'secret-status' },
    { sessionId: '../secret' }, { correlationId: 'secret-credential' },
    { durationMs: NaN }, { durationMs: Infinity }, { durationMs: -1 }, { durationMs: 86400001 },
  ])('refuses invalid known fields without copying their contents into the error: %j', invalid => {
    expect(typeof events.makeEvent).toBe('function');
    expect(() => events.makeEvent({ ...input, ...invalid })).toThrow(/^Invalid event (name|operation|status|sessionId|correlationId|durationMs)$/);
  });
});

describe('private bounded audit sink', () => {
  it('appends only validated metadata as complete JSON lines and preserves event identity', () => {
    const { directory, path } = fixture();
    expect(typeof events.appendAuditEvent).toBe('function');
    const event = events.makeEvent(input);
    expect(events.appendAuditEvent(directory, { ...event, details: 'private payload', prompt: 'private prompt' })).toEqual({ status: 'written' });
    expect(events.appendAuditEvent(directory, event)).toEqual({ status: 'written' });
    const text = readFileSync(path, 'utf8'); expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n').map(line => JSON.parse(line))).toEqual([event, event]);
    expect(text).not.toContain('private');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('returns a safe blocked result rather than throwing or writing a malformed event', () => {
    const { directory, path } = fixture();
    expect(typeof events.appendAuditEvent).toBe('function');
    expect(events.appendAuditEvent(directory, { ...input, timestamp: 'private-invalid-time' })).toEqual({ status: 'blocked', reason: 'invalid_event' });
    expect(existsSync(path)).toBe(false);
  });
  it('keeps the five MiB ceiling without truncating existing audit records', () => {
    const { directory, path } = fixture();
    expect(typeof events.appendAuditEvent).toBe('function');
    const event = events.makeEvent(input), lineBytes = Buffer.byteLength(JSON.stringify(event) + '\n');
    const prior = Buffer.alloc(5 * 1024 * 1024 - lineBytes + 1, 32); writeFileSync(path, prior);
    expect(events.appendAuditEvent(directory, event)).toEqual({ status: 'blocked', reason: 'size_limit' });
    expect(readFileSync(path).equals(prior)).toBe(true);
    expect(existsSync(join(directory, 'events.jsonl.lock'))).toBe(false);
  });
  it('refuses hard-linked audit files and leaves the link target unchanged', () => {
    const { root, directory, path } = fixture();
    expect(typeof events.appendAuditEvent).toBe('function');
    const target = join(root, 'outside.txt'); writeFileSync(target, 'untouched'); linkSync(target, path);
    expect(events.appendAuditEvent(directory, events.makeEvent(input))).toEqual({ status: 'blocked', reason: 'unsafe_path' });
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
  it('refuses linked audit directories, including ancestor junctions', () => {
    const { root, directory } = fixture();
    expect(typeof events.appendAuditEvent).toBe('function');
    const linked = join(root, 'linked'); symlinkSync(directory, linked, 'junction');
    mkdirSync(join(directory, 'nested'));
    expect(events.appendAuditEvent(linked, events.makeEvent(input))).toEqual({ status: 'blocked', reason: 'unsafe_path' });
    expect(events.appendAuditEvent(join(linked, 'nested'), events.makeEvent(input))).toEqual({ status: 'blocked', reason: 'unsafe_path' });
    expect(existsSync(join(directory, 'events.jsonl'))).toBe(false);
  });
  it('does not steal an existing writer lock or create the audit in a missing directory', () => {
    const { root, directory, path } = fixture();
    expect(typeof events.appendAuditEvent).toBe('function');
    const lock = join(directory, 'events.jsonl.lock'); writeFileSync(lock, 'existing-owner');
    expect(events.appendAuditEvent(directory, events.makeEvent(input))).toEqual({ status: 'blocked', reason: 'busy' });
    expect(readFileSync(lock, 'utf8')).toBe('existing-owner'); expect(existsSync(path)).toBe(false);
    expect(events.appendAuditEvent(join(root, 'missing'), events.makeEvent(input))).toEqual({ status: 'blocked', reason: 'unsafe_path' });
  });
});
