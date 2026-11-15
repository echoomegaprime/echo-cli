import { expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../src/code/sessions.js';
import { Workspace } from '../src/code/workspace.js';

const entry = resolve('src/code-main.ts');
function cli(args: string[]) { return execFileSync(process.execPath, ['--import', 'tsx', entry, ...args], { encoding: 'utf8', timeout: 15000 }); }
it('provides a standalone entry point and inspects a persisted proposal before approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-code-cli-'));
  try {
    expect(cli(['--version'])).toContain('0.1.0');
    const store = new SessionStore(join(root, 'state')); writeFileSync(join(root, 'a.txt'), 'before');
    const ws = new Workspace(root, [store.directory]), s = store.create(root, 'fake');
    const p = ws.propose('a.txt', 'after'); store.addProposal(s.id, p);
    const args = ['--workspace', root, '--state-dir', store.directory];
    const inspected = cli(['show', s.id, ...args]); expect(inspected).toContain('before'); expect(inspected).toContain('after');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before');
    expect(cli(['approve', s.id, p.id, ...args])).toContain('applied');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after');
    expect(cli(['revert', s.id, p.id, ...args])).toContain('reverted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('speaks clean JSON-RPC over stdio from a fresh process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-code-mcp-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'mcp fixture');
    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'mcp', '--workspace', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo_code_read', arguments: { path: 'a.txt' } } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const exit = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('MCP subprocess timed out')); }, 10000); child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve(code); }); });
    expect(exit).toBe(0); expect(stderr).toBe('');
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(responses).toHaveLength(3); expect(responses[2].result.content[0].text).toContain('mcp fixture');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
