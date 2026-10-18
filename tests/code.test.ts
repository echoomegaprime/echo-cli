import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import { LocalModel, validateEndpoint } from '../src/code/model.js';
import { runTurn } from '../src/code/agent.js';
import { dispatchMcp } from '../src/code/mcp.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-code-test-'));
  roots.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  return { root, project, ws: new Workspace(project), store: new SessionStore(join(root, 'sessions')) };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('workspace trust boundary', () => {
  it('reads source but rejects traversal, secrets, metadata and oversized input', () => {
    const { project, ws } = fixture();
    writeFileSync(join(project, 'main.ts'), 'export const n = 1;');
    writeFileSync(join(project, '.env'), 'TOKEN=private');
    writeFileSync(join(project, 'large.txt'), 'x'.repeat(70000));
    expect(ws.read('main.ts')).toContain('n = 1');
    for (const p of ['../outside', '.env', '.git/config', 'C:\\Windows\\x', 'a:stream', 'AGENTS.md', 'large.txt']) {
      expect(() => ws.read(p)).toThrow();
    }
    expect(ws.list('.')).toEqual(['main.ts', 'large.txt'].sort());
  });
  it('rejects directory symlinks leading outside the workspace', () => {
    const { root, project, ws } = fixture(); mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'other', 'private.txt'), 'private');
    symlinkSync(join(root, 'other'), join(project, 'linked'), 'junction');
    expect(() => ws.read('linked/private.txt')).toThrow();
  });
  it('rejects hard links, alternate streams and Windows device names', () => {
    const { project, root, ws } = fixture(); writeFileSync(join(root, 'outside.txt'), 'private');
    linkSync(join(root, 'outside.txt'), join(project, 'linked.txt'));
    for (const path of ['linked.txt', 'NUL', 'con.txt', 'a.txt:stream', '.echo-prime/config.json']) expect(() => ws.read(path)).toThrow();
  });
  it('stages without writing, rejects stale approval, applies once and restores only unchanged edits', () => {
    const { project, ws, store } = fixture(); writeFileSync(join(project, 'a.txt'), 'old');
    const session = store.create(project, 'local-model');
    const proposal = ws.propose('a.txt', 'new'); store.addProposal(session.id, proposal);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('old');
    writeFileSync(join(project, 'a.txt'), 'concurrent');
    expect(() => store.approve(session.id, proposal.id, ws)).toThrow(/changed/i);
    writeFileSync(join(project, 'a.txt'), 'old');
    store.approve(session.id, proposal.id, ws);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('new');
    expect(() => store.approve(session.id, proposal.id, ws)).toThrow(/pending/i);
    writeFileSync(join(project, 'a.txt'), 'later');
    expect(() => store.revert(session.id, proposal.id, ws)).toThrow(/changed/i);
    writeFileSync(join(project, 'a.txt'), 'new'); store.revert(session.id, proposal.id, ws);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('old');
  });
  it('does not read or export common credential values in otherwise ordinary files', () => {
    const { project, ws } = fixture(); writeFileSync(join(project, 'settings.txt'), 'api_key = "sensitive-example-value"');
    expect(ws.read('settings.txt')).not.toContain('sensitive-example-value');
    expect(() => ws.propose('x.txt', 'api_key="sensitive-example-value"')).toThrow(/secret/i);
  });
});

describe('durability and approval', () => {
  it('reads sessions in a fresh store and rejects session path injection and wrong workspace', () => {
    const { project, store } = fixture(); const s = store.create(project, 'm');
    store.append(s.id, { role: 'user', content: 'hello' });
    expect(new SessionStore(store.directory).get(s.id).messages[0].content).toBe('hello');
    expect(() => store.get('../elsewhere')).toThrow();
    const p = new Workspace(project).propose('a.txt', 'new'); store.addProposal(s.id, p);
    const other = fixture(); expect(() => store.approve(s.id, p.id, other.ws)).toThrow(/workspace/i);
  });
  it('reconciles an edit interrupted after the source write and after a revert', () => {
    const { project, store, ws } = fixture(); writeFileSync(join(project, 'a.txt'), 'old');
    const s = store.create(project, 'm'), p = ws.propose('a.txt', 'new'); store.addProposal(s.id, p);
    const applying = store.get(s.id); applying.proposals[0].status = 'applying'; store.save(applying); ws.apply(p);
    expect(new SessionStore(store.directory).recover(s.id, ws).proposals[0].status).toBe('applied');
    const reverting = store.get(s.id); reverting.proposals[0].status = 'reverting'; store.save(reverting); ws.apply(p, true);
    expect(store.recover(s.id, ws).proposals[0].status).toBe('reverted');
  });
  it('does not steal a live session lease', () => {
    const { store, project, ws } = fixture(); const s = store.create(project, 'm'), release = store.lease(s.id);
    try { expect(() => store.recover(s.id, ws)).toThrow(/still running/i); expect(() => store.lease(s.id)).toThrow(/busy/i); }
    finally { release(); }
  });
});

describe('local model and agent integration', () => {
  it('rejects public endpoints, embedded credentials, redirect paths and cloud model names', () => {
    for (const url of ['https://api.meta.ai', 'http://user:password@127.0.0.1:11434', 'http://127.0.0.1:11434/path', 'http://127.0.0.1.evil.test']) {
      expect(() => validateEndpoint(url)).toThrow();
    }
    expect(() => new LocalModel('http://127.0.0.1:11434', 'qwen:cloud')).toThrow(/cloud/i);
  });
  it('runs a multi-step model conversation, persists a proposal, and requires a separate approval', async () => {
    const { project, ws, store } = fixture(); writeFileSync(join(project, 'main.txt'), 'old');
    const actions = [
      { action: 'read', path: 'main.txt' },
      { action: 'propose', path: 'main.txt', content: 'new' },
      { action: 'final', content: 'Edit staged for your review.' },
    ];
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(actions.shift()) }, done: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const model = new LocalModel(`http://127.0.0.1:${address.port}`, 'test-local');
      const s = store.create(project, 'test-local');
      const result = await runTurn({ workspace: ws, store, sessionId: s.id, model, prompt: 'Update main.txt', maxSteps: 4 });
      expect(result.status).toBe('pending_approval'); expect(requests).toHaveLength(2);
      expect(result.answer).toContain('No source file has been changed');
      expect(readFileSync(join(project, 'main.txt'), 'utf8')).toBe('old');
      const restored = new SessionStore(store.directory).get(s.id);
      expect(restored.proposals).toHaveLength(1);
      store.approve(s.id, restored.proposals[0].id, ws);
      expect(readFileSync(join(project, 'main.txt'), 'utf8')).toBe('new');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('bounds a looping model and records interruption without replaying a mutation', async () => {
    const { ws, project, store } = fixture(); const s = store.create(project, 'fake');
    const model = { next: async () => ({ action: 'list' as const, path: '.' }) };
    const r = await runTurn({ workspace: ws, store, sessionId: s.id, model, prompt: 'look', maxSteps: 2 });
    expect(r.status).toBe('step_limit'); expect(store.get(s.id).proposals).toHaveLength(0);
    const signal = AbortSignal.abort();
    const interrupted = await runTurn({ workspace: ws, store, sessionId: s.id, model, prompt: 'stop', signal });
    expect(interrupted.status).toBe('interrupted');
  });
  it('refuses redirects and times out without contacting a fallback provider', async () => {
    const server = createServer((req, res) => { if (req.url === '/api/chat') { res.writeHead(302, { location: 'http://example.com' }); res.end(); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await expect(new LocalModel(`http://127.0.0.1:${port}`, 'local').next([{ role: 'user', content: 'hi' }])).rejects.toThrow(/no provider fallback/i);
      await expect(new LocalModel(`http://127.0.0.1:${port}`, 'local', 25).models()).rejects.toThrow(/timed out/i);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe('read-only MCP bridge', () => {
  it('requires initialization, lists bounded read tools and refuses write or unknown methods', async () => {
    const { ws, project } = fixture(); writeFileSync(join(project, 'a.txt'), 'hello');
    const state = { initialized: false };
    const early = await dispatchMcp({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, ws, state);
    expect(early).toHaveProperty('error');
    const init = await dispatchMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, ws, state);
    expect(JSON.stringify(init)).toContain('echo-code');
    const tools = await dispatchMcp({ id: 2, method: 'tools/list' }, ws, state);
    expect(JSON.stringify(tools)).toContain('echo_code_read');
    expect(JSON.stringify(tools)).not.toContain('write');
    const read = await dispatchMcp({ id: 3, method: 'tools/call', params: { name: 'echo_code_read', arguments: { path: 'a.txt' } } }, ws, state);
    expect(JSON.stringify(read)).toContain('hello');
    const denied = await dispatchMcp({ id: 4, method: 'tools/call', params: { name: 'write', arguments: {} } }, ws, state);
    expect(JSON.stringify(denied)).toContain('isError');
  });
});
