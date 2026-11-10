import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAction, type Action, type Model } from './model.js';
import { redact } from './workspace.js';
import { detectRefusal, type RefusalDetection } from './refusal.js';
import type { Message } from './sessions.js';

/**
 * Subscription-backed models, reached only through each vendor's own CLI.
 * Prime never reads, copies, logs or forwards a token: the child process finds its own login in its own store.
 * There is no fallback. A provider that is missing, signed out or timed out fails the turn and says so.
 */
export type ProviderId = 'claude' | 'gpt' | 'grok' | 'argon';
export interface RunOptions { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; signal?: AbortSignal; maxBytes: number }
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (cmd: string, args: string[], options: RunOptions) => Promise<RunResult>;
/** `declinedBy` is set by the Prime chat when a vendor declined and the turn was re-run on Qwen (Commander directive 2026-11-04). */
export interface Answered { provider: ProviderId; requested: string | null; model: string | null; reported: boolean; declinedBy?: ProviderId }
export class ProviderUnavailableError extends Error {
  constructor(readonly provider: ProviderId, readonly detail: string) { super(`${PROVIDER_LABEL[provider]} is unavailable: ${detail}; no fallback was used`); this.name = 'ProviderUnavailableError'; }
}
/** Fixed safe diagnostic, never a vendor-supplied error or a claim that remote work was rolled back. */
export class ProviderProcessCleanupError extends Error {
  constructor() { super('Provider process group cleanup could not be confirmed; outcome unknown'); this.name = 'ProviderProcessCleanupError'; }
}
/**
 * The vendor answered, but with a refusal instead of an action (its classifier declined the request).
 * Distinct from ProviderUnavailableError on purpose: an outage is never re-routed; a decline is re-run on
 * Qwen by the Prime chat and labelled. The refusal text itself is kept out of the message so it never
 * reaches the owner as a final reply; only the detector's pattern names and confidence are carried.
 */
export class ProviderDeclinedError extends Error {
  constructor(readonly provider: ProviderId, readonly detection: RefusalDetection) {
    super(`${PROVIDER_LABEL[provider]} declined the request (refusal detected, confidence ${detection.confidence}, patterns: ${detection.matched.join(', ') || 'none'}); the declined reply was not used`);
    this.name = 'ProviderDeclinedError';
  }
}
export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude (claude CLI)', gpt: 'GPT (codex CLI)', grok: 'Grok (grok CLI)', argon: 'Argon (agy CLI)' };
export const PROVIDER_BIN: Record<ProviderId, string> = { claude: 'claude', gpt: 'codex', grok: 'grok', argon: 'agy' };
const WINDOWS_EXECUTION_BLOCK = 'native Windows CLI execution is unavailable until owned Job Object process-tree containment is qualified';
/** Native execution admission only. Injected runners are a trusted host integration, never a browser/config setting. */
export function providerExecutionBlock(provider: ProviderId, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return WINDOWS_EXECUTION_BLOCK;
  if (provider === 'gpt') return 'native GPT execution is unavailable until a model-only Codex tool contract is qualified';
  return undefined;
}
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
// Only what a CLI needs to find its own login and run. Nothing named like a key, token or secret ever passes through.
const ENV_ALLOW = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'LANG', 'TERM'];
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) env[key] = source[key];
  return env;
}
const SYSTEM = 'You are the planning model inside a read-only coding agent. You have no tools. Reply with one JSON object and nothing else.';
// Tool shapes are valid only when the [system] message carries a "Live tools" catalogue; Prime runs the tool and feeds the
// result back as the next [user] message: `UNTRUSTED TOOL RESULT (tool <name>):\n<json>` (see docs/echo-code/PRIME_TOOLS.md).
const ACTIONS = 'Reply with exactly one JSON object and nothing else, shaped as one of:\n'
  + '{"action":"list","path":"<dir>"} {"action":"read","path":"<file>"} {"action":"search","query":"<text>"} '
  + '{"action":"propose","path":"<file>","content":"<full new content>"} {"action":"final","content":"<answer>"} '
  + '{"action":"tool","tool":"<name from the Live tools catalogue>","args":{...}} {"action":"tools","calls":[{"tool":"<name>","args":{...}},...]}';
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
/** Gemini 4 Argon through Google's Antigravity CLI. Used when no model is requested. */
export const DEFAULT_MODEL: Partial<Record<ProviderId, string>> = { argon: 'gemini-4-argon-medium' };
interface Spec { args(model: string | null, dir: string, prompt: string): string[]; maxPromptChars?: number; stdin: boolean; prompt?: string; parse(stdout: string, provider: ProviderId): Parsed }
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
  argon: {
    // agy takes the prompt only on its command line (stdin is ignored), so the prompt must fit Windows' argv limit.
    stdin: false, maxPromptChars: 28000,
    args: (model, _dir, prompt) => ['--output-format', 'json', '--mode', 'plan', '--model', model ?? DEFAULT_MODEL.argon!, '--print-timeout', '150s', `-p=${prompt}`],
    parse(stdout) {
      let v: { status?: unknown; response?: unknown };
      try { v = JSON.parse(stdout); } catch { throw new ProviderUnavailableError('argon', 'returned unreadable output'); }
      if (v.status !== 'SUCCESS' || typeof v.response !== 'string') throw new ProviderUnavailableError('argon', `the CLI reported status ${typeof v.status === 'string' ? v.status : 'unknown'}`);
      return { text: v.response, model: null }; // agy does not say which model answered
    },
  },
};
/**
 * The supervisor remains the POSIX group leader even after the vendor exits. Its live PID anchors the
 * group until the parent kills it, including descendants that kept output pipes open. Vendor arguments
 * are argv entries, never interpolated into this fixed program. The vendor receives no IPC descriptor.
 * On parent disconnect the supervisor kills its own group while it still owns that identity.
 */
const PROCESS_SUPERVISOR = String.raw`
const { spawn } = require('node:child_process');
const stop = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
process.on('uncaughtException', stop);
process.on('unhandledRejection', stop);
const env = { ...process.env };
delete env.NODE_CHANNEL_FD;
delete env.NODE_CHANNEL_SERIALIZATION_MODE;
const child = spawn(process.argv[1], process.argv.slice(2), { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.on('error', () => { if (process.connected) process.send({ type: 'spawn-error' }); });
child.on('close', code => {
  process.stdout.end();
  process.stderr.end();
  if (process.connected) process.send({ type: 'completed', code });
});
`;
export const run: Runner = (cmd, args, o) => new Promise((resolve, reject) => {
  if (o.signal?.aborted) { reject(new Error('Interrupted')); return; }
  // taskkill cannot contain descendants after their parent exits; no unqualified Windows dispatch.
  if (process.platform === 'win32') { reject(new Error(WINDOWS_EXECUTION_BLOCK)); return; }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ['--input-type=commonjs', '-e', PROCESS_SUPERVISOR, '--', cmd, ...args], {
      cwd: o.cwd, env: o.env, shell: false, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
  } catch (error) { reject(Object.assign(error as Error, { spawnFailed: true })); return; }
  const out: Buffer[] = [], err: Buffer[] = [];
  let size = 0, errSize = 0, done = false, completed = false, code: number | null = null;
  let stdoutEnded = false, stderrEnded = false;
  const result = (timedOut: boolean): RunResult => ({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
  const finish = (value: RunResult | Error) => {
    if (done) return;
    done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort);
    // Signal only the still-live supervisor's owned group, once, with no delayed PID/group reuse window.
    // Immediate termination is intentional: graceful vendor shutdown and remote rollback are not claimed.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') value = new ProviderProcessCleanupError();
      }
    }
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    if (child.connected) child.disconnect();
    child.unref();
    if (value instanceof Error) reject(value); else resolve(value);
  };
  const onAbort = () => finish(new Error('Interrupted'));
  const finishCompleted = () => { if (completed && stdoutEnded && stderrEnded) finish(result(false)); };
  const timer = setTimeout(() => finish(result(true)), o.timeoutMs);
  child.stdout!.on('data', (data: Buffer) => {
    if (done) return;
    size += data.length;
    if (size > o.maxBytes) { finish(result(true)); return; }
    out.push(data);
  });
  child.stderr!.on('data', (data: Buffer) => {
    if (done || errSize >= 8000) return;
    const kept = data.subarray(0, 8000 - errSize); err.push(kept); errSize += kept.length;
  });
  child.stdout!.on('end', () => { stdoutEnded = true; finishCompleted(); });
  child.stderr!.on('end', () => { stderrEnded = true; finishCompleted(); });
  child.on('message', message => {
    if (done || !message || typeof message !== 'object') return;
    const event = message as { type?: unknown; code?: unknown };
    if (event.type === 'spawn-error') finish(Object.assign(new Error('Provider process could not start'), { spawnFailed: true }));
    else if (event.type === 'completed' && (event.code === null || Number.isInteger(event.code))) {
      completed = true; code = event.code as number | null; finishCompleted();
    }
  });
  child.on('error', error => finish(Object.assign(error, { spawnFailed: true })));
  child.on('exit', () => { if (!done) finish(new ProviderProcessCleanupError()); });
  child.stdin!.on('error', () => { /* vendor exited before reading */ });
  o.signal?.addEventListener('abort', onAbort, { once: true });
  if (o.signal?.aborted) { onAbort(); return; }
  child.stdin!.end(o.input ?? '');
});
export interface CliModelOptions { model?: string; runner?: Runner; bin?: string; timeoutMs?: number }
export class CliModel implements Model {
  last?: Answered;
  private runner: Runner; private bin: string; private timeoutMs: number; private requested: string | null; private nativeRunner: boolean;
  constructor(readonly provider: ProviderId, options: CliModelOptions = {}) {
    if (!SPECS[provider]) throw new Error('Unknown provider');
    if (options.model !== undefined && !MODEL_NAME.test(options.model)) throw new Error('Invalid model name');
    const timeout = options.timeoutMs ?? 180000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600000) throw new Error('Invalid model timeout');
    this.requested = options.model ?? null; this.runner = options.runner ?? run; this.nativeRunner = this.runner === run; this.bin = options.bin ?? PROVIDER_BIN[provider]; this.timeoutMs = timeout;
  }
  async next(messages: Message[], signal?: AbortSignal): Promise<Action> {
    if (signal?.aborted) throw new Error('Interrupted');
    const blocked = this.nativeRunner ? providerExecutionBlock(this.provider) : undefined;
    if (blocked) throw new ProviderUnavailableError(this.provider, blocked);
    if (Buffer.byteLength(JSON.stringify(messages)) > 180000) throw new Error('Context limit reached; start a focused session');
    const spec = SPECS[this.provider], prompt = render(messages);
    if (spec.maxPromptChars && prompt.length > spec.maxPromptChars) throw new ProviderUnavailableError(this.provider, `the prompt is too large for this CLI's command line (${prompt.length} > ${spec.maxPromptChars} characters); start a focused session`);
    const dir = mkdtempSync(join(tmpdir(), 'echo-prime-provider-'));
    let result: RunResult;
    try {
      if (!spec.stdin) writeFileSync(join(dir, 'prompt.txt'), prompt, { mode: 0o600 });
      result = await this.runner(this.bin, spec.args(this.requested, dir, prompt), { cwd: dir, env: childEnv(), input: spec.stdin ? prompt : undefined, timeoutMs: this.timeoutMs, signal, maxBytes: 4_000_000 });
    } catch (error) {
      if (error instanceof ProviderProcessCleanupError) throw new ProviderUnavailableError(this.provider, error.message);
      if (signal?.aborted) throw new Error('Interrupted');
      throw new ProviderUnavailableError(this.provider, (error as { spawnFailed?: boolean }).spawnFailed ? `could not start "${this.bin}"` : 'could not run');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    if (signal?.aborted) throw new Error('Interrupted');
    if (result.timedOut) throw new ProviderUnavailableError(this.provider, 'timed out or returned too much output');
    // A signal-terminated vendor may already have printed valid-looking JSON or refusal text.
    // Only an explicit successful exit may be parsed, attributed, or considered for decline rerouting.
    if (result.code !== 0) throw new ProviderUnavailableError(this.provider, result.code === null ? 'terminated without a successful exit' : `exited with code ${result.code}`);
    let parsed: Parsed;
    try { parsed = spec.parse(result.stdout, this.provider); }
    catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError(this.provider, 'returned no usable answer');
    }
    let action: Action;
    try { action = parseAction(JSON.parse(extractJson(redact(parsed.text)))); }
    catch {
      // A vendor that declines answers in prose, never with an action. Tell a decline apart from garbage so the chat can re-route it (labelled) instead of failing the turn.
      const detection = detectRefusal(parsed.text);
      if (detection.refused) throw new ProviderDeclinedError(this.provider, detection);
      throw new Error(`${PROVIDER_LABEL[this.provider]} returned an invalid action; no tools were executed for that response`);
    }
    this.last = { provider: this.provider, requested: this.requested ?? DEFAULT_MODEL[this.provider] ?? null, model: parsed.model, reported: parsed.model !== null };
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
