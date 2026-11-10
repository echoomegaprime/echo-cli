import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sessions from '../src/code/sessions.js';
import { Workspace, hash } from '../src/code/workspace.js';
import type { Proposal } from '../src/code/workspace.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-review-')); roots.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  const ws = new Workspace(project), store = new sessions.SessionStore(join(root, 'sessions'));
  return { project, ws, store, session: store.create(project, 'local') };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('explicit proposal rejection', () => {
  it('records rejection without writing source, and survives a fresh store', () => {
    const { project, ws, store, session } = fixture();
    writeFileSync(join(project, 'a.txt'), 'old\r\n');
    const proposal = ws.propose('a.txt', 'new\r\n'); store.addProposal(session.id, proposal);
    expect(typeof store.reject).toBe('function');
    expect(store.reject(session.id, proposal.id, ws)).toEqual({ status: 'rejected', alreadyRejected: false });
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('old\r\n');
    const restored = new sessions.SessionStore(store.directory).get(session.id);
    expect(restored.proposals[0]).toEqual({ ...proposal, status: 'rejected' });
    expect(() => store.approve(session.id, proposal.id, ws)).toThrow(/state/i);
    expect(() => store.revert(session.id, proposal.id, ws)).toThrow(/state/i);
  });
  it('treats a repeated rejection as an idempotent read without altering the journal', () => {
    const { ws, store, session } = fixture(); const proposal = ws.propose('new.txt', 'text');
    store.addProposal(session.id, proposal);
    expect(typeof store.reject).toBe('function');
    store.reject(session.id, proposal.id, ws);
    const saved = readFileSync(join(store.directory, `${session.id}.json`));
    expect(store.reject(session.id, proposal.id, ws)).toEqual({ status: 'rejected', alreadyRejected: true });
    expect(readFileSync(join(store.directory, `${session.id}.json`))).toEqual(saved);
    expect(existsSync(join(ws.root, 'new.txt'))).toBe(false);
  });
  it.each(['applying', 'applied', 'reverting', 'reverted'] as const)('refuses rejection from %s state', state => {
    const { ws, store, session } = fixture(); const proposal = ws.propose('a.txt', 'new');
    proposal.status = state; store.addProposal(session.id, proposal);
    expect(typeof store.reject).toBe('function');
    expect(() => store.reject(session.id, proposal.id, ws)).toThrow(/pending/i);
    expect(store.get(session.id).proposals[0].status).toBe(state);
  });
  it('preserves pending proposals when the workspace or proposal identity is wrong', () => {
    const { ws, store, session } = fixture(); const proposal = ws.propose('a.txt', 'new');
    store.addProposal(session.id, proposal);
    expect(typeof store.reject).toBe('function');
    expect(() => store.reject(session.id, proposal.id, fixture().ws)).toThrow(/workspace/i);
    expect(() => store.reject(session.id, 'unknown', ws)).toThrow(/proposal/i);
    expect(store.get(session.id).proposals[0].status).toBe('pending');
  });
  it('respects a live lease and does not change an unrelated pending proposal', () => {
    const { ws, store, session } = fixture();
    const first = ws.propose('a.txt', 'a'), second = ws.propose('b.txt', 'b');
    store.addProposal(session.id, first); store.addProposal(session.id, second);
    expect(typeof store.reject).toBe('function');
    const release = store.lease(session.id);
    try { expect(() => store.reject(session.id, first.id, ws)).toThrow(/busy/i); }
    finally { release(); }
    store.reject(session.id, first.id, ws);
    expect(store.get(session.id).proposals[1]).toEqual(second);
  });
  it('clears pending approval only after the last proposal is rejected', () => {
    const { ws, store, session } = fixture(); session.status = 'pending_approval'; store.save(session);
    const first = ws.propose('a.txt', 'a'), second = ws.propose('b.txt', 'b');
    store.addProposal(session.id, first); store.addProposal(session.id, second);
    store.reject(session.id, first.id, ws);
    expect(store.get(session.id).status).toBe('pending_approval');
    store.reject(session.id, second.id, ws);
    expect(store.get(session.id).status).toBe('completed');
    expect(store.list()[0].pending).toBe(0);
  });
  it('preserves the original journal and releases the lease when persistence fails', () => {
    const { ws, store, session } = fixture(); const p = ws.propose('new.txt', 'text');
    store.addProposal(session.id, p);
    const saved = readFileSync(join(store.directory, `${session.id}.json`));
    const failure = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('disk write failed'); });
    try { expect(() => store.reject(session.id, p.id, ws)).toThrow('disk write failed'); }
    finally { failure.mockRestore(); }
    expect(readFileSync(join(store.directory, `${session.id}.json`))).toEqual(saved);
    expect(existsSync(join(store.directory, `${session.id}.json.lock`))).toBe(false);
    expect(existsSync(join(ws.root, 'new.txt'))).toBe(false);
    expect(store.reject(session.id, p.id, ws)).toEqual({ status: 'rejected', alreadyRejected: false });
  });
});

function proposal(before: string | null, after: string): Proposal {
  return { id: 'preview-fixture', path: 'main.txt', before, after,
    beforeHash: before === null ? null : hash(before), afterHash: hash(after), status: 'pending' };
}

describe('bounded human edit preview', () => {
  it('shows a contextual unified diff while retaining the full source versions', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    const p = proposal('one\ntwo\nthree\n', 'one\nchanged\nthree\n');
    const preview = sessions.previewProposal(p);
    expect(preview.unifiedDiff).toBe('--- a/main.txt\n+++ b/main.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n');
    expect(preview.before).toBe(p.before); expect(preview.after).toBe(p.after);
    expect(preview.beforeHash).toBe(p.beforeHash); expect(preview.afterHash).toBe(p.afterHash);
    expect(preview.change).toBe('modify');
  });
  it('renders creation and removal of all file content with correct zero-length ranges', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    expect(sessions.previewProposal(proposal(null, 'new\n')).unifiedDiff)
      .toBe('--- /dev/null\n+++ b/main.txt\n@@ -0,0 +1,1 @@\n+new\n');
    const emptied = sessions.previewProposal(proposal('old\n', ''));
    expect(emptied.unifiedDiff).toBe('--- a/main.txt\n+++ b/main.txt\n@@ -1,1 +0,0 @@\n-old\n');
    expect(emptied.change).toBe('modify');
    expect(sessions.previewProposal(proposal(null, '')).change).toBe('create');
  });
  it('makes final newline changes and CRLF changes visible without normalizing stored text', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    const finalNewline = sessions.previewProposal(proposal('same', 'same\n'));
    expect(finalNewline.unifiedDiff).toContain('-same\n\\ No newline at end of file\n+same\n');
    const windows = sessions.previewProposal(proposal('one\r\n', 'one\n'));
    expect(windows.unifiedDiff).toContain('-one\\r\n+one\n');
    expect(windows.before).toBe('one\r\n'); expect(windows.beforeLineEndings).toBe('CRLF');
    expect(windows.afterLineEndings).toBe('LF');
  });
  it('does not present unchanged text as an edit', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    const preview = sessions.previewProposal(proposal('same\n', 'same\n'));
    expect(preview.change).toBe('unchanged'); expect(preview.unifiedDiff).toBe('');
  });
  it('refuses corrupt and oversized proposals rather than previewing an incomplete edit', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    expect(() => sessions.previewProposal({ ...proposal('old', 'new'), afterHash: 'invalid' })).toThrow(/integrity/i);
    expect(() => sessions.previewProposal(proposal('old', 'x'.repeat(65537)))).toThrow(/limit/i);
    expect(() => sessions.previewProposal(proposal('x'.repeat(65537), 'new'))).toThrow(/limit/i);
  });
  it('handles the maximum line count with bounded output and complete original text', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    const p = proposal('\n'.repeat(65536), 'x\n'.repeat(32768));
    const preview = sessions.previewProposal(p);
    expect(preview.before).toBe(p.before); expect(preview.after).toBe(p.after);
    expect(Buffer.byteLength(preview.unifiedDiff)).toBeLessThan(1024 * 1024);
    expect(preview.unifiedDiff).toContain('@@ -1,65536 +1,32768 @@');
  });
  it('escapes terminal controls in the display without changing the underlying proposal', () => {
    expect(typeof sessions.previewProposal).toBe('function');
    const preview = sessions.previewProposal(proposal('old\n', '\u001b[2Jnew\n'));
    expect(preview.unifiedDiff).not.toContain('\u001b');
    expect(preview.unifiedDiff).toContain('\\u001b[2Jnew');
    expect(preview.after).toBe('\u001b[2Jnew\n');
  });
});
