import { describe, expect, it } from 'vitest';
import { CliModel, ProviderUnavailableError, childEnv, type Runner, type RunResult } from '../src/code/providers.js';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const action = JSON.stringify({ action: 'final', content: 'done' });
const claudeJson = (result: string, usage: Record<string, number> = { 'claude-haiku-5-5': 4 }) => JSON.stringify({
  is_error: false, result, modelUsage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, { outputTokens: v }])),
});
const grokJson = (text: string, model = 'grok-4.7-build') => JSON.stringify({ text, modelUsage: { [model]: { outputTokens: 9 } } });
const codexEvents = (text: string) => [
  '2026 ERROR noise that is not json',
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'skills budget' } }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n');
function recorder(result: RunResult) {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; input?: string; cwd: string }[] = [];
  const runner: Runner = async (cmd, args, o) => { calls.push({ cmd, args, env: o.env, input: o.input, cwd: o.cwd }); return result; };
  return { calls, runner };
}
const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];

describe('CLI provider models', () => {
  it('claude: parses the action and reports the model that answered', async () => {
    const { calls, runner } = recorder(ok(claudeJson(action, { 'claude-sonnet-5-5': 40, 'claude-haiku-5-5': 3 })));
    const model = new CliModel('claude', { model: 'sonnet', runner });
    expect(await model.next(messages)).toEqual({ action: 'final', content: 'done' });
    expect(model.last).toMatchObject({ provider: 'claude', requested: 'sonnet', model: 'claude-sonnet-5-5', reported: true });
    const { args, input } = calls[0];
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--model', 'sonnet']));
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(input).toContain('hello');
  });
  it('claude: accepts a fenced JSON action', async () => {
    const { runner } = recorder(ok(claudeJson('```json\n' + action + '\n```')));
    expect(await new CliModel('claude', { runner }).next(messages)).toEqual({ action: 'final', content: 'done' });
  });
  it('gpt: reads the last agent_message and says the CLI does not report a model', async () => {
    const { calls, runner } = recorder(ok(codexEvents(action)));
    const model = new CliModel('gpt', { model: 'gpt-5', runner });
    expect(await model.next(messages)).toEqual({ action: 'final', content: 'done' });
    expect(model.last).toMatchObject({ provider: 'gpt', requested: 'gpt-5', model: null, reported: false });
    expect(calls[0].args).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '-s', 'read-only', '-m', 'gpt-5']));
  });
  it('grok: reads text and reports the model', async () => {
    const { calls, runner } = recorder(ok(grokJson(action)));
    const model = new CliModel('grok', { runner });
    expect(await model.next(messages)).toEqual({ action: 'final', content: 'done' });
    expect(model.last).toMatchObject({ provider: 'grok', requested: null, model: 'grok-4.7-build', reported: true });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(calls[0].args).not.toContain('--always-approve');
  });
  it('runs in an empty directory with a minimal environment and no secrets', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-leak-0000000000'; process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak-00000'; process.env.XAI_API_KEY = 'xai-nope';
    try {
      const { calls, runner } = recorder(ok(claudeJson(action)));
      await new CliModel('claude', { runner }).next(messages);
      const env = calls[0].env;
      expect(Object.keys(env).some(k => /KEY|TOKEN|SECRET|PASSWORD/i.test(k))).toBe(false);
      expect(JSON.stringify(env)).not.toMatch(/should-not-leak|xai-nope/);
      expect(env.PATH ?? env.Path).toBeTruthy();
      expect(calls[0].cwd).not.toBe(process.cwd());
      expect(childEnv()).toEqual(env);
    } finally { delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.XAI_API_KEY; }
  });
  it('fails loudly, with the provider named, and never falls back', async () => {
    for (const [provider, result] of [
      ['claude', { code: 1, stdout: claudeJson('Not logged in'), stderr: '', timedOut: false }],
      ['gpt', { code: 1, stdout: '', stderr: 'not signed in', timedOut: false }],
      ['grok', { code: 2, stdout: '', stderr: 'auth required', timedOut: false }],
      ['grok', { code: null, stdout: '', stderr: '', timedOut: true }],
    ] as const) {
      const { runner } = recorder(result as RunResult);
      const model = new CliModel(provider, { runner });
      const err = await model.next(messages).catch(e => e);
      expect(err).toBeInstanceOf(ProviderUnavailableError);
      expect(String(err.message)).toMatch(new RegExp(provider, 'i'));
      expect(String(err.message)).toMatch(/no fallback/i);
      expect(model.last).toBeUndefined();
    }
  });
  it('rejects a non-JSON or unsupported answer without executing anything', async () => {
    const { runner } = recorder(ok(claudeJson('I think you should read the file')));
    await expect(new CliModel('claude', { runner }).next(messages)).rejects.toThrow(/invalid action/i);
  });
  it('flags an is_error claude result even when the exit code is 0', async () => {
    const { runner } = recorder(ok(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login', modelUsage: {} })));
    await expect(new CliModel('claude', { runner }).next(messages)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it('redacts secrets that come back in model output', async () => {
    const { runner } = recorder(ok(claudeJson(JSON.stringify({ action: 'final', content: 'key sk-abcdefghijklmnopqrstuvwx' }))));
    const result = await new CliModel('claude', { runner }).next(messages);
    expect(JSON.stringify(result)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });
  it('refuses overlong or malformed model names', () => {
    for (const bad of ['', 'x'.repeat(200), 'a b', '--flag', 'a\nb']) expect(() => new CliModel('claude', { model: bad, runner: recorder(ok('')).runner })).toThrow();
  });
});

describe('argon (Antigravity agy CLI)', () => {
  const agy = (response: string, status = 'SUCCESS') => JSON.stringify({ conversation_id: 'c', status, response, num_turns: 1 });
  it('parses the action, defaults to Gemini 4 Argon and says the CLI does not report the answering model', async () => {
    const { calls, runner } = recorder(ok(agy(action)));
    const model = new CliModel('argon', { runner });
    expect(await model.next(messages)).toEqual({ action: 'final', content: 'done' });
    expect(model.last).toMatchObject({ provider: 'argon', requested: 'gemini-4-argon-medium', model: null, reported: false });
    const { args, input } = calls[0];
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json', '--mode', 'plan', '--model', 'gemini-4-argon-medium']));
    expect(args.some(a => a.startsWith('-p=') && a.includes('hello'))).toBe(true);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(input).toBeUndefined();
  });
  it('uses the requested model', async () => {
    const { calls, runner } = recorder(ok(agy(action)));
    const model = new CliModel('argon', { model: 'gemini-4-argon-high', runner });
    await model.next(messages);
    expect(calls[0].args).toEqual(expect.arrayContaining(['--model', 'gemini-4-argon-high']));
    expect(model.last?.requested).toBe('gemini-4-argon-high');
  });
  it('fails loudly when the CLI reports a non-success status', async () => {
    const { runner } = recorder(ok(agy('', 'ERROR')));
    const err = await new CliModel('argon', { runner }).next(messages).catch(e => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(String(err.message)).toMatch(/argon/i); expect(String(err.message)).toMatch(/no fallback/i);
  });
  it('refuses a prompt too large for the command line instead of truncating or falling back', async () => {
    const { calls, runner } = recorder(ok(agy(action)));
    const big = [{ role: 'user' as const, content: 'x'.repeat(40000) }];
    const err = await new CliModel('argon', { runner }).next(big).catch(e => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(String(err.message)).toMatch(/command line|too large/i); expect(String(err.message)).toMatch(/no fallback/i);
    expect(calls.length).toBe(0);
  });
});
