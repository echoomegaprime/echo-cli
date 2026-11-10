import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliModel, ProviderDeclinedError, ProviderProcessCleanupError, ProviderUnavailableError, run, type RunOptions, type RunResult, type Runner } from '../src/code/providers.js';

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

const fixture = fileURLToPath(new URL('./fixtures/provider-process.mjs', import.meta.url));
const owned: { directory: string; controller: AbortController }[] = [];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch { return false; }
}
function pids(directory: string): number[] {
  return readdirSync(directory).filter(name => name.endsWith('.pid')).map(name => Number(readFileSync(join(directory, name), 'utf8')));
}
function ownedRunning(pid: number, directory: string): boolean {
  if (!running(pid)) return false;
  if (process.platform !== 'linux') return true;
  try { return readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes(directory); } catch { return false; }
}
async function until(check: () => boolean, ms = 2500): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await pause(10);
  expect(check()).toBe(true);
}
function start(mode: string, overrides: Partial<RunOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'echo-provider-process-test-')), controller = new AbortController();
  owned.push({ directory, controller });
  const options: RunOptions = { cwd: directory, env: { PATH: process.env.PATH, ECHO_FIXTURE_SENTINEL: 'owned-nonsecret' }, timeoutMs: 4000, maxBytes: 200000, signal: controller.signal, ...overrides };
  const pending = run(process.execPath, [fixture, mode, directory], options).then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error: error as Error }));
  return { directory, controller, pending };
}
async function within<T>(pending: Promise<T>, ms: number): Promise<T | 'unsettled'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<'unsettled'>(resolve => { timer = setTimeout(() => resolve('unsettled'), ms); })]); }
  finally { clearTimeout(timer); }
}
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.controller.abort();
    for (const pid of pids(item.directory)) if (ownedRunning(pid, item.directory)) try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    await until(() => pids(item.directory).every(pid => !ownedRunning(pid, item.directory)));
    rmSync(item.directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('native provider process containment', () => {
  it('does not spawn for a pre-aborted raw runner call', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(run(process.execPath, ['-e', 'process.exit(1)'], { cwd: tmpdir(), env: {}, timeoutMs: 500, maxBytes: 500, signal: controller.signal })).rejects.toThrow(/Interrupted/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('returns normal output and preserves input/environment without a shell', async () => {
    const task = start('normal', { input: 'owned input' });
    const result = await task.pending;
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.value).toMatchObject({ code: 0, timedOut: false, stderr: 'normal diagnostic' });
    expect(JSON.parse(result.value.stdout)).toEqual({ input: 'owned input', token: 'owned-nonsecret' });
  });
  it.skipIf(process.platform === 'win32')('drains complete stdout before accepting normal completion and caps stderr bytes', async () => {
    const result = await start('large-normal').pending;
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.value.stdout).toBe('x'.repeat(128000));
    expect(Buffer.byteLength(result.value.stderr)).toBeLessThanOrEqual(8000);
    expect(result.value).toMatchObject({ code: 0, timedOut: false });
  });
  it.skipIf(process.platform === 'win32')('preserves a nonzero provider exit code and diagnostic output', async () => {
    const result = await start('exit-error').pending;
    expect(result).toMatchObject({ kind: 'resolved', value: { code: 7, stdout: 'partial', stderr: 'failure', timedOut: false } });
  });
  it.skipIf(process.platform === 'win32')('marks vendor spawn errors and settles without waiting for its deadline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-provider-missing-test-')), controller = new AbortController(); owned.push({ directory, controller });
    await expect(run(join(directory, 'missing-vendor'), [], { cwd: directory, env: {}, timeoutMs: 4000, maxBytes: 1024 })).rejects.toMatchObject({ spawnFailed: true });
  });
  it.skipIf(process.platform === 'win32')('settles the model deadline and stops a resistant child', async () => {
    const task = start('resistant', { timeoutMs: 1000 });
    await until(() => pids(task.directory).length === 1);
    const result = await within(task.pending, 1400);
    expect(result).toMatchObject({ kind: 'resolved', value: { timedOut: true } });
    await until(() => pids(task.directory).every(pid => !running(pid)));
  });
  it.skipIf(process.platform === 'win32')('Stop settles once and stops a resistant child, ignoring late output', async () => {
    const task = start('late-output'); await until(() => pids(task.directory).length === 1);
    let settlements = 0; void task.pending.then(() => { settlements++; });
    task.controller.abort();
    const result = await within(task.pending, 500);
    expect(result).toMatchObject({ kind: 'rejected', error: { message: 'Interrupted' } });
    await until(() => pids(task.directory).every(pid => !running(pid)));
    await pause(50); expect(settlements).toBe(1);
  });
  it.skipIf(process.platform === 'win32')('overflow settles independently of close and stops a resistant writer', async () => {
    const task = start('overflow', { maxBytes: 64 });
    await until(() => pids(task.directory).length === 1);
    const result = await within(task.pending, 800);
    expect(result).toMatchObject({ kind: 'resolved', value: { timedOut: true } });
    if (result !== 'unsettled' && result.kind === 'resolved') expect(Buffer.byteLength(result.value.stdout)).toBeLessThanOrEqual(64);
    await until(() => pids(task.directory).every(pid => !running(pid)));
  });
  it.skipIf(process.platform === 'win32')('Stop terminates a normal parent and resistant descendant', async () => {
    const task = start('tree'); await until(() => pids(task.directory).length === 2);
    task.controller.abort(); expect(await within(task.pending, 500)).toMatchObject({ kind: 'rejected' });
    await until(() => pids(task.directory).every(pid => !running(pid)));
  });
  it.skipIf(process.platform === 'win32')('contains a descendant after the vendor parent exits first', async () => {
    const task = start('parent-exits', { timeoutMs: 1000 }); await until(() => pids(task.directory).length === 2);
    await until(() => !running(Number(readFileSync(join(task.directory, 'parent.pid'), 'utf8'))));
    const result = await within(task.pending, 1400);
    expect(result).not.toBe('unsettled');
    await until(() => pids(task.directory).every(pid => !running(pid)));
  });
  it.skipIf(process.platform === 'win32')('reports unknown cleanup when group signalling fails, while disconnect still closes the owned supervisor', async () => {
    const task = start('tree'); await until(() => pids(task.directory).length === 2);
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL') throw Object.assign(new Error('owned signal failure'), { code: 'EPERM' });
      return originalKill(pid, signal);
    });
    try {
      task.controller.abort();
      const result = await within(task.pending, 500);
      expect(result).toMatchObject({ kind: 'rejected', error: { name: 'ProviderProcessCleanupError' } });
    } finally { kill.mockRestore(); }
    await until(() => pids(task.directory).every(pid => !running(pid)));
  });
  it.runIf(process.platform === 'linux')('caller death disconnects IPC and stops the recorded supervisor, vendor and descendant', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-provider-caller-test-')), controller = new AbortController();
    owned.push({ directory, controller });
    const caller = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture, 'caller', directory], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    const exited = new Promise<void>(resolve => caller.once('exit', () => resolve()));
    caller.stdout.resume(); caller.stderr.resume();
    const identity = (pid: number) => {
      const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const stat = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      expect(ownedRunning(pid, directory)).toBe(true);
      return { pid, started: stat[19] };
    };
    let identities: ReturnType<typeof identity>[] = [];
    const sameOwnedProcess = (item: ReturnType<typeof identity>) => {
      if (!ownedRunning(item.pid, directory)) return false;
      try { const stat = readFileSync('/proc/' + item.pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === item.started; } catch { return false; }
    };
    try {
      await until(() => { try { return !!JSON.parse(readFileSync(join(directory, 'descendant.json'), 'utf8')).pid; } catch { return false; } });
      const vendor = JSON.parse(readFileSync(join(directory, 'parent.json'), 'utf8')) as { pid: number; parent: number };
      const descendant = JSON.parse(readFileSync(join(directory, 'descendant.json'), 'utf8')) as { pid: number; parent: number };
      expect(vendor.parent).not.toBe(caller.pid); expect(descendant.parent).toBe(vendor.pid);
      identities = [vendor.parent, vendor.pid, descendant.pid].map(identity);
      caller.kill('SIGKILL'); expect(await within(exited, 1000)).not.toBe('unsettled');
      await until(() => identities.every(item => !sameOwnedProcess(item)));
    } finally {
      if (caller.exitCode === null && caller.signalCode === null) { caller.kill('SIGKILL'); await within(exited, 1000); }
      for (const item of identities) if (sameOwnedProcess(item)) try { process.kill(item.pid, 'SIGKILL'); } catch { /* recorded owned process already stopped */ }
    }
  });
});

describe('provider cancellation and default native admission', () => {
  const messages = [{ role: 'user' as const, content: 'fixture' }];
  const answer = (model: string): RunResult => ({ code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ is_error: false, result: '{"action":"final","content":"fixture"}', modelUsage: { [model]: { outputTokens: 1 } } }) });
  it('refuses a pre-aborted model call before invoking even a trusted host runner', async () => {
    const runner = vi.fn<Runner>(async () => answer('fixture-model'));
    const controller = new AbortController(); controller.abort();
    await expect(new CliModel('claude', { runner }).next(messages, controller.signal)).rejects.toThrow(/Interrupted/);
    expect(runner).not.toHaveBeenCalled();
  });
  it('does not accept or publish an injected runner answer that arrives after abort', async () => {
    const controller = new AbortController();
    let release!: (value: RunResult) => void;
    const runner: Runner = () => new Promise(resolve => { release = resolve; });
    const model = new CliModel('claude', { runner });
    const pending = model.next(messages, controller.signal).catch(error => error as Error);
    controller.abort(); release(answer('late-model'));
    expect(await pending).toBeInstanceOf(Error); expect(model.last).toBeUndefined();
  });
  it('a cancelled older call cannot overwrite a later successful model attribution', async () => {
    const controller = new AbortController(); let release!: (value: RunResult) => void; let calls = 0;
    const runner: Runner = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(answer('current-model'));
    const model = new CliModel('claude', { runner });
    const old = model.next(messages, controller.signal).catch(error => error as Error);
    controller.abort(); await model.next(messages); release(answer('late-model')); await old;
    expect(model.last?.model).toBe('current-model');
  });
  it('preserves the fixed cleanup-unknown reason even when the caller has aborted', async () => {
    const controller = new AbortController();
    const runner: Runner = async () => { controller.abort(); throw new ProviderProcessCleanupError(); };
    await expect(new CliModel('claude', { runner }).next(messages, controller.signal)).rejects.toMatchObject({ name: 'ProviderUnavailableError', detail: 'Provider process group cleanup could not be confirmed; outcome unknown' });
  });
  it.skipIf(process.platform === 'win32').each(['signal-answer', 'signal-refusal'])('rejects real %s output after signal exit without attribution or refusal fallback', async mode => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-provider-signal-test-')), controller = new AbortController(); owned.push({ directory, controller });
    let observed: RunResult | undefined;
    const runner: Runner = async (_command, _args, options) => {
      observed = await run(process.execPath, [fixture, mode, directory], options);
      return observed;
    };
    const model = new CliModel('claude', { runner });
    const failure = await model.next(messages).catch(error => error as Error);
    expect(observed).toMatchObject({ code: null, timedOut: false });
    expect(observed?.stdout).toContain('owned-signalled-model');
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure).not.toBeInstanceOf(ProviderDeclinedError);
    expect(model.last).toBeUndefined();
  });
  it('fails the native GPT lane closed before starting Codex', async () => {
    await expect(new CliModel('gpt').next(messages)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'win32')('fails native Windows runner and CLI lanes closed before spawn', async () => {
    await expect(run(process.execPath, [], { cwd: tmpdir(), env: {}, timeoutMs: 1000, maxBytes: 1024 })).rejects.toThrow(/Job Object/);
    await expect(new CliModel('claude').next(messages)).rejects.toThrow(/Job Object/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
