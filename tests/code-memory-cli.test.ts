import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../src/code/sessions.js';
import { Workspace } from '../src/code/workspace.js';

it('persists a memory checkpoint, shows it after restart, and reports a missing broker without claiming a save', () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-memory-cli-'));
  try {
    const store = new SessionStore(join(root, 'state')), workspace = new Workspace(root, [store.directory]);
    writeFileSync(join(root, 'source.txt'), 'unchanged');
    const session = store.create(workspace.root, 'fixture');
    const base = ['--import', 'tsx', resolve('src/code-main.ts')];
    const opts = ['--workspace', root, '--state-dir', store.directory];
    const prepared = spawnSync(process.execPath, [...base, 'memory', 'prepare', session.id, 'Project checkpoint', 'Tests passed; runtime admission pending.', ...opts], { encoding: 'utf8', timeout: 10000 });
    expect(prepared.status, prepared.stderr).toBe(0);
    const checkpoint = JSON.parse(prepared.stdout);
    expect(checkpoint.state).toBe('prepared');
    expect(checkpoint.payload.kind).toBe('artifact');
    const status = JSON.parse(execFileSync(process.execPath, [...base, 'memory', 'status', session.id, ...opts], { encoding: 'utf8', timeout: 10000 }));
    expect(status).toEqual([checkpoint]);
    const synced = spawnSync(process.execPath, [...base, 'memory', 'sync', session.id, checkpoint.payload.requestId, ...opts], { encoding: 'utf8', timeout: 10000 });
    expect(synced.status).toBe(2);
    expect(JSON.parse(synced.stdout)).toMatchObject({ state: 'blocked', reason: 'host_broker_not_attached' });
    expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
