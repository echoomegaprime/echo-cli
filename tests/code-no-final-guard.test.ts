import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import { runTurn } from '../src/code/agent.js';
import type { Action } from '../src/code/model.js';

// Server-side "no final text" guard: when the model ends the loop (step budget, empty reply,
// interruption) without a `final` action, runTurn must still return a truthful, non-empty answer
// instead of the blank string the browser rendered as "Turn ended without an answer."
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-no-final-')); roots.push(root);
  const store = new SessionStore(join(root, 'state'));
  const workspace = new Workspace(root, [store.directory]);
  writeFileSync(join(root, 'main.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'util.ts'), 'export const u = 1;\n');
  const session = store.create(workspace.root, 'fixture');
  return { root, store, workspace, sessionId: session.id };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const scripted = (actions: Action[]) => ({ next: async () => actions.shift() ?? { action: 'list' as const, path: '.' } });

describe('no-final-text guard', () => {
  it('summarises inspected files when the step budget runs out without a final action', async () => {
    const f = fixture();
    const r = await runTurn({ ...f, prompt: 'Inspect', maxSteps: 2,
      model: scripted([{ action: 'read', path: 'main.ts' }, { action: 'read', path: 'util.ts' }]) });
    expect(r.status).toBe('step_limit');
    expect(r.answer.trim()).not.toBe('');
    expect(r.answer).toContain('step limit');
    expect(r.answer).toContain('main.ts');
    expect(r.answer).toContain('util.ts');
    expect(r.answer).toContain('2 files');
    expect(r.answer).not.toContain('Turn ended without an answer');
  });

  it('still answers truthfully when the step budget runs out with no files read', async () => {
    const f = fixture();
    const r = await runTurn({ ...f, prompt: 'look', maxSteps: 2,
      model: { next: async () => ({ action: 'list' as const, path: '.' }) } });
    expect(r.status).toBe('step_limit');
    expect(r.answer.trim()).not.toBe('');
    expect(r.answer).toContain('did not read any files');
    expect(r.answer).toContain('step limit');
  });

  it('reports an interruption with a non-empty grounded message', async () => {
    const f = fixture();
    const signal = AbortSignal.abort();
    const r = await runTurn({ ...f, prompt: 'stop', signal,
      model: { next: async () => ({ action: 'list' as const, path: '.' }) } });
    expect(r.status).toBe('interrupted');
    expect(r.answer.trim()).not.toBe('');
    expect(r.answer.toLowerCase()).toContain('interrupted');
    expect(r.answer).not.toContain('Turn ended without an answer');
  });

  it('does not alter a real final answer', async () => {
    const f = fixture();
    const r = await runTurn({ ...f, prompt: 'answer', maxSteps: 3,
      model: scripted([{ action: 'final', content: 'main.ts exports answer = 42.' }]) });
    expect(r.status).toBe('completed');
    expect(r.answer).toBe('main.ts exports answer = 42.');
  });

  it('marks the synthesized summary as unverified model text, not application-generated', async () => {
    const f = fixture();
    const r = await runTurn({ ...f, prompt: 'look', maxSteps: 1,
      model: { next: async () => ({ action: 'list' as const, path: '.' }) } });
    expect(r.status).toBe('step_limit');
    expect(r.answerVerification).toBe('unverified_model_text');
    expect(r.answer).toMatch(/No edit was applied|nothing was retried/);
  });
});
