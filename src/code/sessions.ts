import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Workspace, redact } from './workspace.js';
import type { Proposal } from './workspace.js';
export { previewProposal } from './review.js';

export interface Message { role: 'user' | 'assistant' | 'system'; content: string }
export interface Session {
  version: 1; id: string; workspace: string; model: string; createdAt: string;
  status: 'idle' | 'running' | 'completed' | 'pending_approval' | 'failed' | 'step_limit' | 'interrupted';
  messages: Message[]; proposals: Proposal[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class SessionStore {
  readonly directory: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Linked session directory refused');
    this.directory = realpathSync(resolve(directory));
  }
  private path(id: string) {
    if (!UUID.test(id)) throw new Error('Invalid session ID');
    const path = join(this.directory, `${id}.json`);
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || lstatSync(path).nlink > 1)) throw new Error('Linked session refused');
    return path;
  }
  save(session: Session) {
    const path = this.path(session.id), text = JSON.stringify(session, null, 2);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Session size limit reached');
    const temp = `${path}.${randomUUID()}.tmp`; let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path);
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
  }
  create(workspace: string, model: string): Session {
    const session: Session = { version: 1, id: randomUUID(), workspace: realpathSync(workspace), model, createdAt: new Date().toISOString(), status: 'idle', messages: [], proposals: [] };
    this.save(session); return session;
  }
  get(id: string): Session {
    const path = this.path(id);
    if (lstatSync(path).size > 4 * 1024 * 1024) throw new Error('Session exceeds limit');
    const session = JSON.parse(readFileSync(path, 'utf8')) as Session;
    if (session.version !== 1 || session.id !== id || !Array.isArray(session.messages) || !Array.isArray(session.proposals)) throw new Error('Unsupported or corrupt session');
    return session;
  }
  list() { return readdirSync(this.directory).filter(n => n.endsWith('.json') && UUID.test(n.slice(0, -5))).map(n => { const s = this.get(n.slice(0, -5)); return { id: s.id, workspace: s.workspace, model: s.model, status: s.status, pending: s.proposals.filter(p => p.status === 'pending').length }; }); }
  append(id: string, message: Message) { const s = this.get(id); s.messages.push({ role: message.role, content: redact(message.content) }); this.save(s); }
  addProposal(id: string, proposal: Proposal) {
    const s = this.get(id); if (s.proposals.length >= 100) throw new Error('Proposal limit reached');
    s.proposals.push(proposal); this.save(s);
  }
  lease(id: string): () => void {
    const path = `${this.path(id)}.lock`;
    try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
    catch { throw new Error('Session busy or has an interrupted lease; inspect with recover'); }
    return () => unlinkSync(path);
  }
  private edit(id: string, proposalId: string, ws: Workspace, revert: boolean) {
    const release = this.lease(id);
    try {
      const s = this.get(id);
      if (s.workspace !== ws.root) throw new Error('Session workspace mismatch');
      const p = s.proposals.find(p => p.id === proposalId);
      if (!p || p.status !== (revert ? 'applied' : 'pending')) throw new Error('Proposal is not in the required pending/applied state');
      p.status = revert ? 'reverting' : 'applying'; this.save(s);
      try { ws.apply(p, revert); }
      catch (error) { p.status = revert ? 'applied' : 'pending'; this.save(s); throw error; }
      p.status = revert ? 'reverted' : 'applied'; this.save(s);
    } finally { release(); }
  }
  approve(id: string, proposalId: string, ws: Workspace) { this.edit(id, proposalId, ws, false); }
  revert(id: string, proposalId: string, ws: Workspace) { this.edit(id, proposalId, ws, true); }
  reject(id: string, proposalId: string, ws: Workspace): { status: 'rejected'; alreadyRejected: boolean } {
    const release = this.lease(id);
    try {
      const s = this.get(id);
      if (s.workspace !== ws.root) throw new Error('Session workspace mismatch');
      const p = s.proposals.find(p => p.id === proposalId);
      if (!p) throw new Error('Proposal not found');
      if (p.status === 'rejected') return { status: 'rejected', alreadyRejected: true };
      if (p.status !== 'pending') throw new Error('Only a pending proposal can be rejected');
      // Rejection updates only the atomic session journal, never workspace content.
      p.status = 'rejected';
      if (s.status === 'pending_approval' && !s.proposals.some(proposal => proposal.status === 'pending')) s.status = 'completed';
      this.save(s);
      return { status: 'rejected', alreadyRejected: false };
    } finally { release(); }
  }
  recover(id: string, ws: Workspace) {
    const lock = `${this.path(id)}.lock`;
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Malformed lease; manual owner review required');
      try { process.kill(pid, 0); throw new Error('Lease owner is still running'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      unlinkSync(lock);
    }
    const release = this.lease(id);
    try {
      const s = this.get(id); if (s.workspace !== ws.root) throw new Error('Session workspace mismatch');
      for (const p of s.proposals.filter(p => p.status === 'applying' || p.status === 'reverting')) {
        const actual = ws.currentHash(p.path);
        const wasReverting = p.status === 'reverting';
        if (actual === p.afterHash) p.status = 'applied';
        else if (actual === p.beforeHash) p.status = wasReverting ? 'reverted' : 'pending';
        else throw new Error('Interrupted edit conflicts with current file; manual review required');
      }
      if (s.status === 'running') s.status = 'interrupted'; this.save(s); return s;
    } finally { release(); }
  }
}
