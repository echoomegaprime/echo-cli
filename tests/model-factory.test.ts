import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_MODELS, MODEL_IDS, ModelRouter, buildModel, parseModelsConfig, sessionModelName } from '../src/code/model-factory.js';
import { LocalModel } from '../src/code/model.js';
import { CliModel, type Runner, type RunResult } from '../src/code/providers.js';

const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];
const final = (content = 'done') => JSON.stringify({ action: 'final', content });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const claudeJson = (result: string, model = 'claude-sonnet-5-5') => JSON.stringify({ is_error: false, result, modelUsage: { [model]: { outputTokens: 5 } } });

const servers: Server[] = [];
afterEach(async () => { while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r())); });
async function ollama(installed: string[], reply = 'c3po-code:echo-qwen38-abliterated-256k') {
  const chats: { options: { num_ctx: number }; model: string }[] = []; let tags = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { tags++; res.end(JSON.stringify({ models: installed.map(name => ({ name })) })); return; }
      chats.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({ done: true, model: reply, message: { content: final('from qwen') } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats, tags: () => tags };
}
function runner(handler: (cmd: string, args: string[]) => RunResult | Error) {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    const r = handler(cmd, args); if (r instanceof Error) throw r; return r;
  };
  return { calls, run };
}
const spawnFailed = () => Object.assign(new Error('ENOENT'), { spawnFailed: true });

describe('models config', () => {
  it('defaults to Qwen 3.8 256K on the loopback tunnel with no secret in it', () => {
    expect(DEFAULT_MODELS).toEqual({ default: 'qwen', endpoint: 'http://127.0.0.1:11450', model: 'c3po-code:echo-qwen38-abliterated-256k', contextTokens: 262144, cli: {} });
    expect(JSON.stringify(DEFAULT_MODELS)).not.toMatch(/api[_-]?key|secret|password|bearer|\btoken\b/i);
    expect(MODEL_IDS).toEqual(['qwen', 'claude', 'gpt', 'grok', 'argon']);
  });
  it('parses a reviewed section and fills the rest from defaults', () => {
    expect(parseModelsConfig(undefined)).toEqual(DEFAULT_MODELS);
    expect(parseModelsConfig({ default: 'claude', cli: { claude: { model: 'sonnet' } } })).toMatchObject({ default: 'claude', endpoint: DEFAULT_MODELS.endpoint, cli: { claude: { model: 'sonnet' } } });
  });
  it.each([
    [{ endpoint: 'https://api.example.com' }], [{ endpoint: 'http://127.0.0.1.evil.test' }], [{ endpoint: 'http://user:pw@127.0.0.1:11450' }],
    [{ model: 'qwen:cloud' }], [{ default: 'other' }], [{ contextTokens: 12 }], [{ contextTokens: 'big' }], [{ apiKey: 'x' }],
    [{ cli: { claude: { model: 'sonnet', token: 'x' } } }], [{ cli: { gemini: {} } }], [{ cli: { claude: { model: 'bad model!' } } }], ['string'], [[]],
  ])('refuses %j', value => { expect(() => parseModelsConfig(value)).toThrow(); });
});

describe('buildModel', () => {
  it('builds Local for qwen and a CLI model for each subscription provider', () => {
    expect(buildModel('qwen', DEFAULT_MODELS)).toBeInstanceOf(LocalModel);
    for (const id of ['claude', 'gpt', 'grok', 'argon'] as const) {
      const m = buildModel(id, DEFAULT_MODELS);
      expect(m).toBeInstanceOf(CliModel); expect((m as CliModel).provider).toBe(id);
    }
  });
  it('refuses unknown provider ids instead of choosing another', () => {
    expect(() => buildModel('gemini' as never, DEFAULT_MODELS)).toThrow(/Unknown model provider/);
    expect(() => buildModel('__proto__' as never, DEFAULT_MODELS)).toThrow(/Unknown model provider/);
  });
  it('passes the configured CLI model name and names sessions per provider', async () => {
    const r = runner(() => ok(claudeJson(final())));
    const config = parseModelsConfig({ cli: { claude: { model: 'sonnet' } } });
    await buildModel('claude', config, { runner: r.run }).next(messages);
    expect(r.calls[0].args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
    expect(sessionModelName('qwen', config)).toBe(config.model);
    expect(sessionModelName('claude', config)).toBe('claude:sonnet');
    expect(sessionModelName('gpt', config)).toBe('gpt');
  });
  it('sends the configured context size to the local endpoint and records what the endpoint reports', async () => {
    const fake = await ollama(['c3po-code:echo-qwen38-abliterated-256k']);
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url });
    const turn = router.turn('qwen');
    expect(await turn.model.next(messages)).toEqual({ action: 'final', content: 'from qwen' });
    expect(fake.chats[0].options.num_ctx).toBe(262144);
    expect(fake.chats[0].model).toBe('c3po-code:echo-qwen38-abliterated-256k');
    expect(turn.answered()).toMatchObject({ id: 'qwen', requested: 'c3po-code:echo-qwen38-abliterated-256k', model: 'c3po-code:echo-qwen38-abliterated-256k', reported: true });
  });
});

describe('availability report', () => {
  it('reports each provider with the reason when unavailable and never touches tokens', async () => {
    const fake = await ollama(['c3po-code:echo-qwen38-abliterated-256k']);
    const r = runner((cmd, args) => cmd === 'claude' ? ok('2.1.0')
      : cmd === 'codex' ? (args[0] === 'login' ? { code: 1, stdout: 'secret@example.com', stderr: 'no', timedOut: false } : ok()) : spawnFailed());
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: r.run });
    process.env.FAKE_API_TOKEN = 'must-not-pass'; process.env.OPENAI_API_KEY = 'must-not-pass';
    let report;
    try { report = await router.report(); } finally { delete process.env.FAKE_API_TOKEN; delete process.env.OPENAI_API_KEY; }
    const by = Object.fromEntries(report.providers.map(p => [p.id, p]));
    expect(report.default).toBe('qwen'); expect(report.contextTokens).toBe(262144);
    expect(by.qwen).toMatchObject({ available: true, kind: 'local', check: 'model-listed', requested: 'c3po-code:echo-qwen38-abliterated-256k' });
    expect(by.claude).toMatchObject({ available: true, kind: 'cli', check: 'installed' });
    expect(by.gpt).toMatchObject({ available: false, check: 'signed-in' }); expect(by.gpt.reason).toMatch(/not signed in/i);
    expect(by.grok).toMatchObject({ available: false }); expect(by.grok.reason).toMatch(/could not start "grok"/);
    expect(JSON.stringify(report)).not.toContain('secret@example.com');
    expect(r.calls.find(c => c.cmd === 'claude')!.args).toEqual(['--version']);
    expect(r.calls.find(c => c.cmd === 'codex')!.args).toEqual(['login', 'status']);
    expect(r.calls.every(c => !Object.keys(c.env).some(k => /KEY|TOKEN|SECRET/i.test(k)))).toBe(true);
  });
  it('says so when the local endpoint is down or the model is not installed', async () => {
    const fake = await ollama(['other:model']);
    const r = runner(() => ok());
    const missing = await new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: r.run }).report();
    expect(missing.providers[0]).toMatchObject({ id: 'qwen', available: false }); expect(missing.providers[0].reason).toMatch(/not installed/);
    const down = await new ModelRouter({ ...DEFAULT_MODELS, endpoint: 'http://127.0.0.1:1' }, { runner: r.run }).report();
    expect(down.providers[0]).toMatchObject({ id: 'qwen', available: false }); expect(down.providers[0].reason).toMatch(/unreachable/);
  });
  it('caches availability for 60 seconds, then probes again', async () => {
    const fake = await ollama([DEFAULT_MODELS.model]);
    let now = 1_000_000; const r = runner(() => ok());
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: r.run, now: () => now });
    await router.report(); await router.report();
    expect(r.calls).toHaveLength(4); expect(fake.tags()).toBe(1);
    now += 59_000; await router.report(); expect(r.calls).toHaveLength(4);
    now += 2_000; await router.report(); expect(r.calls).toHaveLength(8); expect(fake.tags()).toBe(2);
  });
  it('exposes the model that actually answered the last turn and keeps it after a failed turn', async () => {
    const fake = await ollama([DEFAULT_MODELS.model]);
    let fail = false;
    const r = runner(cmd => cmd === 'claude' && !fail ? ok(claudeJson(final())) : cmd === 'claude' ? ok('not json') : ok());
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: r.run, now: () => 5 });
    const first = router.turn('claude'); await first.model.next(messages);
    expect(first.answered()).toMatchObject({ id: 'claude', model: 'claude-sonnet-5-5', reported: true });
    fail = true;
    const second = router.turn('claude');
    await expect(second.model.next(messages)).rejects.toThrow(/unavailable/);
    expect(second.answered()).toBeNull();
    const claude = (await router.report()).providers.find(p => p.id === 'claude')!;
    expect(claude.last).toMatchObject({ id: 'claude', model: 'claude-sonnet-5-5' });
  });
  it('says the CLI did not report a model instead of guessing one', async () => {
    const events = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: final() } });
    const r = runner(() => ok(events));
    const router = new ModelRouter(DEFAULT_MODELS, { runner: r.run });
    const turn = router.turn('gpt'); await turn.model.next(messages);
    expect(turn.answered()).toEqual(expect.objectContaining({ id: 'gpt', model: null, reported: false, requested: null }));
  });
});

describe('no fallback', () => {
  it('a failing provider throws its own error and no other provider is called', async () => {
    const fake = await ollama([DEFAULT_MODELS.model]);
    const r = runner(() => spawnFailed());
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: r.run });
    await expect(router.turn('claude').model.next(messages)).rejects.toThrow(/Claude .*unavailable.*no fallback was used/);
    expect(fake.chats).toHaveLength(0);
    expect(new Set(r.calls.map(c => c.cmd))).toEqual(new Set(['claude']));
  });
  it('a down local model throws its own error and never starts a CLI', async () => {
    const r = runner(() => ok(claudeJson(final())));
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: 'http://127.0.0.1:1' }, { runner: r.run });
    await expect(router.turn('qwen').model.next(messages)).rejects.toThrow(/no provider fallback was used/);
    expect(r.calls).toHaveLength(0);
  });
  it('refuses an unknown provider id without building anything', () => {
    const r = runner(() => ok());
    const router = new ModelRouter(DEFAULT_MODELS, { runner: r.run });
    expect(() => router.turn('gemini' as never)).toThrow(/Unknown model provider/); expect(r.calls).toHaveLength(0);
  });
});
