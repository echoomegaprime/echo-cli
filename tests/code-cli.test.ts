import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/code/sessions.js';
import { Workspace } from '../src/code/workspace.js';
import { registerCodeCommands } from '../src/code/commands.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-code-cli-')); roots.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'a.txt'), 'before\n');
  const store = new SessionStore(join(root, 'state')), ws = new Workspace(project, [store.directory]);
  const session = store.create(ws.root, 'test-local'), proposal = ws.propose('a.txt', 'after\n');
  store.addProposal(session.id, proposal);
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  async function run(args: string[], workspace = project) {
    const command = new Command().exitOverride(); registerCodeCommands(command);
    await command.parseAsync([...args, '--workspace', workspace, '--state-dir', store.directory], { from: 'user' });
    return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  }
  return { project, root, store, session, proposal, run };
}
it('reviews a complete diff, rejects explicitly, and refuses later approval without changing source', async () => {
  const f = fixture();
  const review = await f.run(['review', f.session.id, f.proposal.id]);
  expect(review.before).toBe('before\n'); expect(review.after).toBe('after\n');
  expect(review.unifiedDiff).toContain('-before'); expect(review.unifiedDiff).toContain('+after');
  const rejection = await f.run(['reject', f.session.id, f.proposal.id]);
  expect(rejection).toMatchObject({ status: 'rejected', alreadyRejected: false });
  expect(await f.run(['reject', f.session.id, f.proposal.id])).toMatchObject({ status: 'rejected', alreadyRejected: true });
  await expect(f.run(['approve', f.session.id, f.proposal.id])).rejects.toThrow(/pending/i);
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('before\n');
});
it('refuses review and transcript display when a different workspace is selected', async () => {
  const f = fixture(), other = join(f.root, 'other'); mkdirSync(other);
  for (const args of [['review', f.session.id, f.proposal.id], ['show', f.session.id]]) {
    await expect(f.run(args, other)).rejects.toThrow(/workspace mismatch/i);
  }
});

it('records successful approval and revert with linked metadata-only events', async () => {
  const f = fixture();
  await f.run(['approve', f.session.id, f.proposal.id]);
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('after\n');
  await f.run(['revert', f.session.id, f.proposal.id]);
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('before\n');
  const text = readFileSync(join(f.store.directory, 'events.jsonl'), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(e => [e.operation, e.event, e.status])).toEqual([
    ['approve', 'operation_started', 'started'], ['approve', 'operation_completed', 'succeeded'],
    ['revert', 'operation_started', 'started'], ['revert', 'operation_completed', 'succeeded'],
  ]);
  expect(events[0].correlationId).toBe(events[1].correlationId);
  expect(events[2].correlationId).toBe(events[3].correlationId);
  expect(events[0].correlationId).not.toBe(events[2].correlationId);
  expect(events.every(e => e.sessionId === f.session.id)).toBe(true);
  for (const event of events) {
    expect(Object.keys(event).every(key => ['timestamp', 'event', 'operation', 'status', 'sessionId', 'correlationId', 'durationMs'].includes(key))).toBe(true);
  }
  expect(text).not.toContain(f.project);
  expect(text).not.toContain('a.txt');
  expect(text).not.toContain('after');
});
it('records failed stale approval without overwriting concurrent source or logging its contents', async () => {
  const f = fixture();
  writeFileSync(join(f.project, 'a.txt'), 'private concurrent edit');
  await expect(f.run(['approve', f.session.id, f.proposal.id])).rejects.toThrow();
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('private concurrent edit');
  const text = readFileSync(join(f.store.directory, 'events.jsonl'), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(e => e.status)).toEqual(['started', 'failed']);
  expect(events[1].event).toBe('operation_failed');
  expect(text).not.toContain('private');
});
it('records review, rejection and recovery without exposing source or changing the file', async () => {
  const f = fixture();
  await f.run(['review', f.session.id, f.proposal.id]);
  await f.run(['reject', f.session.id, f.proposal.id]);
  await f.run(['recover', f.session.id]);
  const events = readFileSync(join(f.store.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.filter(e => e.event === 'operation_completed').map(e => e.operation)).toEqual(['review', 'reject', 'recover']);
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('before\n');
});
it('reports an unavailable audit sink while preserving a successful edit result and another writer lock', async () => {
  const f = fixture();
  const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const lock = join(f.store.directory, 'events.jsonl.lock');
  writeFileSync(lock, 'other writer');
  expect(await f.run(['approve', f.session.id, f.proposal.id])).toMatchObject({ status: 'applied' });
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('after\n');
  expect(readFileSync(lock, 'utf8')).toBe('other writer');
  expect(warning.mock.calls.map(call => String(call[0])).join('')).toContain('audit unavailable: busy');
});
