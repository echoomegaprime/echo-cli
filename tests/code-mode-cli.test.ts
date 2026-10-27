import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../src/code/sessions.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function run(args: string[], modelEnv?: string) {
  const env = { ...process.env }; delete env.ECHO_CODE_MODEL;
  if (modelEnv !== undefined) env.ECHO_CODE_MODEL = modelEnv;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/code-main.ts'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')); }, 10000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
  });
}

it.each([undefined, 'propose'])('enforces mode %s through the standalone CLI', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'echo-mode-cli-')); roots.push(root);
  const state = join(root, 'state');
  writeFileSync(join(root, 'a.txt'), 'before');
  const actions = [
    { action: 'read', path: 'a.txt' },
    { action: 'propose', path: 'a.txt', content: 'after' },
    { action: 'final', content: 'a.txt contains before.' },
  ];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify(actions.shift()) }, done: true }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await run(['run', 'Inspect a.txt', '--workspace', root, '--state-dir', state,
      '--model', 'fixture', '--endpoint', `http://127.0.0.1:${port}`, ...(mode ? ['--mode', mode] : [])]);
    expect(response.code).toBe(0);
    const result = JSON.parse(response.stdout);
    expect(result).toMatchObject({ mode: mode ?? 'read-only', status: mode ? 'pending_approval' : 'completed', pending: mode ? 1 : 0 });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before');
    expect(new SessionStore(state).get(result.sessionId).proposals).toHaveLength(mode ? 1 : 0);
    if (!mode) expect(response.stderr).toContain('Read-only task mode refuses edit proposals');
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 15000);

it('rejects invalid CLI modes before creating session state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-mode-invalid-')); roots.push(root);
  const state = join(root, 'state');
  const response = await run(['run', 'Inspect', '--mode', 'automatic', '--workspace', root, '--state-dir', state]);
  expect(response.code).not.toBe(0);
  expect(response.stderr).toMatch(/allowed choices.*read-only.*propose/i);
  expect(existsSync(state)).toBe(false);
});

it.each([
  { envModel: undefined, flagModel: undefined, expected: 'qwen2.5-coder:7b' },
  { envModel: 'fixture-env', flagModel: undefined, expected: 'fixture-env' },
  { envModel: 'fixture-env', flagModel: 'fixture-cli', expected: 'fixture-cli' },
])('selects the qualified default with preserved override precedence: $expected', async ({ envModel, flagModel, expected }) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ models: ['qwen2.5-coder:7b', 'fixture-env', 'fixture-cli'].map(name => ({ name })) }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await run(['doctor', '--endpoint', `http://127.0.0.1:${port}`,
      ...(flagModel ? ['--model', flagModel] : [])], envModel);
    expect(response.code).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({ selected: expected, available: true, modelGenerationTested: false });
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
