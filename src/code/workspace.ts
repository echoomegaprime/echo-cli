import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';

const MAX_FILE = 65536;
const BLOCKED = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.codex|\.claude|\.echo(?:-code|-prime)?|node_modules|appdata|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|pfx|p12)|AGENTS\.md|CLAUDE\.md)$/i;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function redact(text: string): string {
  return text.replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[=:]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}
export interface Proposal {
  id: string; path: string; before: string | null; beforeHash: string | null;
  after: string; afterHash: string; status: 'pending' | 'applying' | 'applied' | 'reverting' | 'reverted';
}

/** Application boundary only; this is not an operating-system sandbox. */
export class Workspace {
  readonly root: string;
  constructor(root: string, private excluded: string[] = []) {
    this.root = realpathSync(resolve(root));
    if (!lstatSync(this.root).isDirectory()) throw new Error('Workspace must be a directory');
    this.excluded = excluded.map(p => resolve(p));
  }
  private target(path: string): string {
    if (typeof path !== 'string' || !path || path.length > 1000 || isAbsolute(path) || path.includes(':') || [...path].some(c => c.charCodeAt(0) < 32) || /^[\\/]/.test(path)) throw new Error('Invalid relative path');
    const parts = path.replace(/\\/g, '/').split('/');
    if (parts.some(p => p === '..' || BLOCKED.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[ .]$/.test(p) && p !== '.')) throw new Error('Protected path');
    const target = resolve(this.root, ...parts);
    const rel = relative(this.root, target);
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || this.excluded.some(p => target === p || target.startsWith(p + sep))) throw new Error('Path outside allowed workspace');
    let current = this.root;
    for (const part of relative(this.root, target).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error('Linked paths are not allowed');
      }
    }
    return target;
  }
  private raw(path: string): string {
    const target = this.target(path), stat = lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('File is not bounded text');
    const content = readFileSync(target);
    if (content.includes(0)) throw new Error('Binary file refused');
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  }
  read(path: string): string { return redact(this.raw(path)); }
  list(path = '.'): string[] {
    return readdirSync(this.target(path)).sort().filter(name => {
      try { const p = path === '.' ? name : `${path}/${name}`; this.target(p); return true; } catch { return false; }
    }).slice(0, 150);
  }
  search(query: string): { path: string; line: number; text: string }[] {
    if (!query || query.length > 200) throw new Error('Search query must contain 1-200 literal characters');
    const hits: { path: string; line: number; text: string }[] = []; let visited = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || visited >= 500 || hits.length >= 40) return;
      for (const name of this.list(dir)) {
        if (++visited > 500 || hits.length >= 40) break;
        const path = dir === '.' ? name : `${dir}/${name}`;
        try {
          if (lstatSync(this.target(path)).isDirectory()) walk(path, depth + 1);
          else this.read(path).split('\n').forEach((line, i) => {
            if (hits.length < 40 && line.includes(query)) hits.push({ path, line: i + 1, text: line.slice(0, 400) });
          });
        } catch { /* Protected, binary and oversized entries are omitted. */ }
      }
    };
    walk('.', 0); return hits;
  }
  propose(path: string, content: string): Proposal {
    const target = this.target(path);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE || content.includes('\0')) throw new Error('Invalid proposed text');
    const before = existsSync(target) ? this.raw(path) : null;
    if (redact(content) !== content || before !== null && redact(before) !== before) throw new Error('Potential secret in edit; review outside the agent');
    if (!lstatSync(dirname(target)).isDirectory()) throw new Error('Parent directory must already exist');
    return { id: randomUUID(), path, before, beforeHash: before === null ? null : hash(before), after: content, afterHash: hash(content), status: 'pending' };
  }
  currentHash(path: string): string | null { return existsSync(this.target(path)) ? hash(this.raw(path)) : null; }
  apply(proposal: Proposal, revert = false): void {
    if (hash(proposal.after) !== proposal.afterHash || (proposal.before === null ? null : hash(proposal.before)) !== proposal.beforeHash) throw new Error('Proposal integrity failed');
    const expected = revert ? proposal.afterHash : proposal.beforeHash;
    if (this.currentHash(proposal.path) !== expected) throw new Error('File changed since review; refusing to overwrite');
    const target = this.target(proposal.path), text = revert ? proposal.before : proposal.after;
    if (text === null) { unlinkSync(target); return; }
    const temp = join(dirname(target), `.echo-code-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', existsSync(target) ? lstatSync(target).mode & 0o777 : 0o600);
      writeFileSync(fd, text, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (this.currentHash(proposal.path) !== expected) throw new Error('File changed during approval');
      renameSync(temp, target);
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
  }
}
