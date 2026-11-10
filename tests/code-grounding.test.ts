import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, hash } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import { runTurn } from '../src/code/agent.js';
import type { Action } from '../src/code/model.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'echo-grounding-')); roots.push(root);
  const store = new SessionStore(join(root, 'state'));
  const ws = new Workspace(root, [store.directory]);
  writeFileSync(join(root, 'main.ts'), 'export const answer = 42;\n');
  return { root, store, ws, session: store.create(root, 'fixture') };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('source grounding across a coding turn', () => {
  it('refuses to stage an existing file the model has not read in this turn', async () => {
    const { root, store, ws, session } = setup();
    const actions: Action[] = [{ action: 'propose', path: 'main.ts', content: 'invented replacement' }, { action: 'final', content: 'I need to inspect the file.' }];
    await runTurn({ workspace: ws, store, sessionId: session.id, mode: 'propose', prompt: 'Improve main.ts', model: { next: async () => actions.shift()! } });
    expect(store.get(session.id).proposals).toHaveLength(0);
    expect(readFileSync(join(root, 'main.ts'), 'utf8')).toContain('answer = 42');
    expect(store.get(session.id).messages.some(m => m.content.includes('Read the complete current file before proposing'))).toBe(true);
  });

  it('refuses a proposal when the file changed after the model read it', async () => {
    const { root, store, ws, session } = setup(); let step = 0;
    const model = { next: async (): Promise<Action> => {
      if (step++ === 0) return { action: 'read', path: 'main.ts' };
      if (step === 2) { writeFileSync(join(root, 'main.ts'), 'concurrent author edit\n'); return { action: 'propose', path: 'main.ts', content: 'stale replacement' }; }
      return { action: 'final', content: 'The source changed; inspect it again.' };
    } };
    await runTurn({ workspace: ws, store, sessionId: session.id, mode: 'propose', prompt: 'Improve main.ts', model });
    expect(store.get(session.id).proposals).toHaveLength(0);
    expect(readFileSync(join(root, 'main.ts'), 'utf8')).toBe('concurrent author edit\n');
  });

  it('returns real source evidence without treating a model explanation as verified', async () => {
    const { store, ws, session } = setup();
    const actions: Action[] = [{ action: 'read', path: 'main.ts' }, { action: 'final', content: 'The file exports answer with the value 42.' }];
    const result = await runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'Explain main.ts', model: { next: async () => actions.shift()! } });
    expect(result.answerVerification).toBe('unverified_model_text');
    expect(result).toHaveProperty('evidence', [{ path: 'main.ts', sha256: hash('export const answer = 42;\n'), lineCount: 1 }]);
    expect(store.get(session.id).messages.some(m => m.content.includes('completeFile') && m.content.includes('sha256'))).toBe(true);
  });

  it('does not accept an old turn read as proof for a new edit', async () => {
    const { store, ws, session } = setup();
    const actions: Action[] = [{ action: 'read', path: 'main.ts' }, { action: 'final', content: 'Read completed.' }];
    await runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'Read main.ts', model: { next: async () => actions.shift()! } });
    const second: Action[] = [{ action: 'propose', path: 'main.ts', content: 'stale' }, { action: 'final', content: 'Need a fresh read.' }];
    await runTurn({ workspace: ws, store, sessionId: session.id, mode: 'propose', prompt: 'Now change it', model: { next: async () => second.shift()! } });
    expect(store.get(session.id).proposals).toHaveLength(0);
  });
});
