import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAction, type Action, type Model } from './model.js';
import { redact } from './workspace.js';
import type { Message } from './sessions.js';

/**
 * Subscription-backed models, reached only through each vendor's own CLI.
 * Prime never reads, copies, logs or forwards a token: the child process finds its own login in its own store.
 * There is no fallback. A provider that is missing, signed out or timed out fails the turn and says so.
 */
export type ProviderId = 'claude' | 'gpt' | 'grok';
export interface RunOptions { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; signal?: AbortSignal; maxBytes: number }
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (cmd: string, args: string[], options: RunOptions) => Promise<RunResult>;
export interface Answered { provider: ProviderId; requested: string | null; model: string | null; reported: boolean }
export class ProviderUnavailableError extends Error {
  constructor(readonly provider: ProviderId, detail: string) { super(`${LABEL[provider]} is unavailable: ${detail}; no fallback was used`); this.name = 'ProviderUnavailableError'; }
}
const LABEL: Record<ProviderId, string> = { claude: 'Claude (claude CLI)', gpt: 'GPT (codex CLI)', grok: 'Grok (grok CLI)' };
const BIN: Record<ProviderId, string> = { claude: 'claude', gpt: 'codex', grok: 'grok' };
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
// Only what a CLI needs to find its own login and run. Nothing named like a key, token or secret ever passes through.
const ENV_ALLOW = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'LANG', 'TERM'];
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) env[key] = source[key];
  return env;
}
const SYSTEM = 'You are the planning model inside a read-only coding agent. You have no tools. Reply with one JSON object and nothing else.';
const ACTIONS = 'Reply with exactly one JSON object and nothing else, shaped as one of:\n'
  + '{"action":"list","path":"<dir>"} {"action":"read","path":"<file>"} {"action":"search","query":"<text>"} '
  + '{"action":"propose","path":"<file>","content":"<full new content>"} {"action":"final","content":"<answer>"}';
function render(messages: Message[]): string {
  return `${ACTIONS}\n\n<conversation>\n${messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n')}\n</conversation>\n`;
}
function lines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try { const v = JSON.parse(line); if (v && typeof v === 'object') out.push(v as Record<string, unknown>); } catch { /* CLI log noise */ }
  }
  return out;
}
const mostOutput = (usage: unknown): string | null => {
  if (!usage || typeof usage !== 'object') return null;
  let best: string | null = null, top = -1;
  for (const [name, value] of Object.entries(usage as Record<string, { outputTokens?: number }>)) {
    const n = typeof value?.outputTokens === 'number' ? value.outputTokens : 0;
    if (n > top) { top = n; best = name; }
  }
  return best;
};
interface Parsed { text: string; model: string | null }
interface Spec { args(model: string | null, dir: string): string[]; stdin: boolean; prompt?: string; parse(stdout: string, provider: ProviderId): Parsed }
const SPECS: Record<ProviderId, Spec> = {
  claude: {
    stdin: true,
    // Not --bare: bare skips the subscription login. Project-only settings in an empty directory keep the user's hooks, memory and plugins out of the call.
    args: model => ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config', '--system-prompt', SYSTEM, ...(model ? ['--model', model] : [])],
    parse(stdout) {
      let v: { is_error?: boolean; result?: unknown; modelUsage?: unknown };
      try { v = JSON.parse(stdout); } catch { throw new ProviderUnavailableError('claude', 'returned unreadable output'); }
      if (v.is_error || typeof v.result !== 'string') throw new ProviderUnavailableError('claude', typeof v.result === 'string' ? v.result.slice(0, 200) : 'returned an error');
      return { text: v.result, model: mostOutput(v.modelUsage) };
    },
  },
  gpt: {
    stdin: true,
    args: model => ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', ...(model ? ['-m', model] : [])],
    parse(stdout) {
      const events = lines(stdout);
      const failed = events.find(e => e.type === 'turn.failed' || e.type === 'error');
      const messages = events.filter(e => e.type === 'item.completed' && (e.item as { type?: string })?.type === 'agent_message');
      const text = (messages.at(-1)?.item as { text?: unknown } | undefined)?.text;
      if (typeof text !== 'string') throw new ProviderUnavailableError('gpt', failed ? 'the CLI reported a failed turn' : 'returned no answer');
      return { text, model: null }; // the codex CLI does not say which model answered
    },
  },
  grok: {
    stdin: false,
    args: (model, dir) => ['--output-format', 'json', '--prompt-file', join(dir, 'prompt.txt'), '--tools', '', '--max-turns', '1', ...(model ? ['-m', model] : [])],
    parse(stdout) {
      let v: { text?: unknown; modelUsage?: unknown };
      try { v = JSON.parse(stdout); } catch { throw new ProviderUnavailableError('grok', 'returned unreadable output'); }
      if (typeof v.text !== 'string') throw new ProviderUnavailableError('grok', 'returned no answer');
      return { text: v.text, model: mostOutput(v.modelUsage) };
    },
  },
};
export const run: Runner = (cmd, args, o) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [], err: Buffer[] = []; let size = 0, timedOut = false, done = false;
  const finish = (r: RunResult | Error) => { if (done) return; done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); if (r instanceof Error) reject(r); else resolve(r); };
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs);
  const onAbort = () => { child.kill(); finish(new Error('Interrupted')); };
  if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (d: Buffer) => { size += d.length; if (size > o.maxBytes) child.kill(); else out.push(d); });
  child.stderr.on('data', (d: Buffer) => { if (err.reduce((n, b) => n + b.length, 0) < 8000) err.push(d); });
  child.on('error', e => finish(Object.assign(e, { spawnFailed: true })));
  child.on('close', code => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut: timedOut || size > o.maxBytes }));
  child.stdin.on('error', () => { /* child exited before reading */ });
  child.stdin.end(o.input ?? '');
});
export interface CliModelOptions { model?: string; runner?: Runner; bin?: string; timeoutMs?: number }
export class CliModel implements Model {
  last?: Answered;
  private runner: Runner; private bin: string; private timeoutMs: number; private requested: string | null;
  constructor(readonly provider: ProviderId, options: CliModelOptions = {}) {
    if (!SPECS[provider]) throw new Error('Unknown provider');
    if (options.model !== undefined && !MODEL_NAME.test(options.model)) throw new Error('Invalid model name');
    const timeout = options.timeoutMs ?? 180000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600000) throw new Error('Invalid model timeout');
    this.requested = options.model ?? null; this.runner = options.runner ?? run; this.bin = options.bin ?? BIN[provider]; this.timeoutMs = timeout;
  }
  async next(messages: Message[], signal?: AbortSignal): Promise<Action> {
    if (Buffer.byteLength(JSON.stringify(messages)) > 180000) throw new Error('Context limit reached; start a focused session');
    const spec = SPECS[this.provider], dir = mkdtempSync(join(tmpdir(), 'echo-prime-provider-')), prompt = render(messages);
    let result: RunResult;
    try {
      if (!spec.stdin) writeFileSync(join(dir, 'prompt.txt'), prompt, { mode: 0o600 });
      result = await this.runner(this.bin, spec.args(this.requested, dir), { cwd: dir, env: childEnv(), input: spec.stdin ? prompt : undefined, timeoutMs: this.timeoutMs, signal, maxBytes: 4_000_000 });
    } catch (error) {
      if (signal?.aborted) throw new Error('Interrupted');
      throw new ProviderUnavailableError(this.provider, (error as { spawnFailed?: boolean }).spawnFailed ? `could not start "${this.bin}"` : 'could not run');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    if (result.timedOut) throw new ProviderUnavailableError(this.provider, 'timed out or returned too much output');
    let parsed: Parsed;
    try { parsed = spec.parse(result.stdout, this.provider); }
    catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError(this.provider, result.code ? `exited with code ${result.code}` : 'returned no usable answer');
    }
    if (result.code) throw new ProviderUnavailableError(this.provider, `exited with code ${result.code}`);
    let action: Action;
    try { action = parseAction(JSON.parse(extractJson(redact(parsed.text)))); }
    catch { throw new Error(`${LABEL[this.provider]} returned an invalid action; no tools were executed for that response`); }
    this.last = { provider: this.provider, requested: this.requested, model: parsed.model, reported: parsed.model !== null };
    return action;
  }
}
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON');
  return body.slice(start, end + 1);
}
