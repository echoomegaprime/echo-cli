import {afterEach, describe, expect, it, vi} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {debuglog} from 'node:util';
import {DEFAULT_MODELS, MODEL_IDS, ModelRouter, type ModelId} from '../src/code/model-factory.js';
import type {Runner, RunResult} from '../src/code/providers.js';
import {ENHANCE_MAX_INPUT, ENHANCE_MODES, ENHANCE_SYSTEM, EnhanceError, PromptEnhancer,
  derivedAdditions, parseEnhancement, type EnhanceMode} from '../src/prime/enhance.js';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';

const final = (content: string) => JSON.stringify({action: 'final', content});
const ok = (stdout = ''): RunResult => ({code: 0, stdout, stderr: '', timedOut: false});
const claudeJson = (text: string, model = 'claude-sonnet-5-5') => JSON.stringify({is_error: false, result: text, modelUsage: {[model]: {outputTokens: 5}}});
const codexEvents = (text: string) => JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text}});
const enhanced = {text: 'a red fox, 85mm lens, golden hour', added: ['85mm lens', 'golden hour']};
const answer = final(JSON.stringify(enhanced));
const request = {mode: 'image', text: 'a red fox', provider: 'claude'};
const debug = debuglog('echo-prime-test');

const servers: Server[] = [];
const primeServers: Awaited<ReturnType<typeof startPrimeServer>>[] = [];
const cleanups: string[] = [];
afterEach(async () => {
  while (primeServers.length) await primeServers.pop()!.close();
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  while (cleanups.length) rmSync(cleanups.pop()!, {recursive: true, force: true});
});

/** Exercise the real CLI envelopes and prompt transports without starting a vendor CLI. */
function cli(action = answer, unavailable?: string) {
  const calls: {cmd: string; prompt: string}[] = [];
  const runner = vi.fn<Runner>(async (cmd, args, options) => {
    let prompt: string;
    if (cmd === 'claude' || cmd === 'codex') prompt = options.input ?? '';
    else if (cmd === 'grok') {
      const index = args.indexOf('--prompt-file');
      if (index < 0 || !args[index + 1]) throw new Error('Missing Grok prompt file');
      prompt = readFileSync(args[index + 1], 'utf8');
    } else if (cmd === 'agy') prompt = args.find(arg => arg.startsWith('-p='))?.slice(3) ?? '';
    else throw new Error(`Unexpected provider binary: ${cmd}`);
    calls.push({cmd, prompt});
    debug('%j', {event: 'prime_enhance_test_cli', cmd, inputChars: prompt.length, unavailable: cmd === unavailable});
    if (cmd === unavailable) throw Object.assign(new Error('x'), {spawnFailed: true});
    if (cmd === 'claude') return ok(claudeJson(action));
    if (cmd === 'codex') return ok(codexEvents(action));
    if (cmd === 'grok') return ok(JSON.stringify({text: action, modelUsage: {'grok-4': {outputTokens: 5}}}));
    return ok(JSON.stringify({status: 'SUCCESS', response: action}));
  });
  return {runner, calls};
}

/** Stand-in Ollama, including the model inventory used by the existing Prime fixture. */
async function ollama() {
  const chats: {method: string | undefined; body: {messages: {role: string; content: string}[]; model: string}}[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({models: [{name: DEFAULT_MODELS.model}]}));
        return;
      }
      if (req.url !== '/api/chat') { res.writeHead(404); res.end('{}'); return; }
      chats.push({method: req.method, body: JSON.parse(Buffer.concat(chunks).toString('utf8'))});
      debug('%j', {event: 'prime_enhance_test_ollama', path: req.url, chats: chats.length});
      res.end(JSON.stringify({done: true, model: DEFAULT_MODELS.model, message: {content: answer}}));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats};
}

async function setup(action = answer, unavailable?: string, defaultId: ModelId = 'qwen') {
  const fake = await ollama(), standIn = cli(action, unavailable);
  const router = new ModelRouter({...DEFAULT_MODELS, default: defaultId, endpoint: fake.url}, {runner: standIn.runner});
  return {...standIn, fake, router, enhancer: new PromptEnhancer(router)};
}

async function expectEnhanceError(promise: Promise<unknown>, status: number, message: RegExp) {
  await expect(promise).rejects.toBeInstanceOf(EnhanceError);
  await expect(promise).rejects.toMatchObject({status, message: expect.stringMatching(message)});
}

const phrases: Record<EnhanceMode, string> = {
  chat: 'about to send to an AI assistant', image: 'text-to-image prompt', video: 'text-to-video prompt',
  music: 'music generation prompt', sfx: 'sound-effect prompt', voice: 'text-to-speech request',
};

describe('PromptEnhancer modes and provider routing', () => {
  it.each(ENHANCE_MODES)('sends the %s system prompt and returns the reported Claude model', async mode => {
    const s = await setup();
    const result = await s.enhancer.enhance({...request, mode}, 'session-a');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].cmd).toBe('claude');
    expect(s.calls[0].prompt).toContain(phrases[mode]);
    expect(s.calls[0].prompt).toContain(ENHANCE_SYSTEM[mode]);
    expect(s.calls[0].prompt).toContain('PROMPT TO ENHANCE:\na red fox');
    expect(result).toMatchObject({mode, ...enhanced, addedSource: 'model', provider: 'claude',
      model: {id: 'claude', model: 'claude-sonnet-5-5', reported: true, answered: true}});
    expect(s.fake.chats).toHaveLength(0);
  });

  it.each([
    {provider: 'grok', binary: 'grok'},
    {provider: 'gpt', binary: 'codex'},
    {provider: 'argon', binary: 'agy'},
  ])('pins $provider to only the $binary binary', async ({provider, binary}) => {
    const s = await setup();
    const result = await s.enhancer.enhance({...request, provider}, 'session-a');
    expect(result).toMatchObject({mode: 'image', ...enhanced, provider, model: {id: provider, answered: true}});
    expect(s.runner).toHaveBeenCalledTimes(1);
    expect(s.calls.map(call => call.cmd)).toEqual([binary]);
    expect(s.calls[0].prompt).toContain(ENHANCE_SYSTEM.image);
    expect(s.calls[0].prompt).toContain('PROMPT TO ENHANCE:\na red fox');
    expect(s.fake.chats).toHaveLength(0);
  });

  it('uses the default Qwen Ollama endpoint when no provider is supplied', async () => {
    const s = await setup();
    expect(s.router.defaultId).toBe('qwen');
    const result = await s.enhancer.enhance({mode: 'image', text: 'a red fox'}, 'session-a');
    expect(result).toMatchObject({mode: 'image', ...enhanced, provider: 'qwen',
      model: {id: 'qwen', model: DEFAULT_MODELS.model, reported: true, answered: true}});
    expect(s.runner).not.toHaveBeenCalled();
    expect(s.fake.chats).toHaveLength(1);
    expect(s.fake.chats[0]).toMatchObject({method: 'POST', body: {model: DEFAULT_MODELS.model}});
    expect(s.fake.chats[0].body.messages).toEqual([
      {role: 'system', content: expect.stringContaining(ENHANCE_SYSTEM.image)},
      {role: 'user', content: 'PROMPT TO ENHANCE:\na red fox'},
    ]);
  });

  it('uses router.defaultId rather than hard-coding Qwen when the provider is omitted', async () => {
    const s = await setup(answer, undefined, 'claude');
    const result = await s.enhancer.enhance({mode: 'chat', text: 'explain DNS'}, 'session-a');
    expect(result.provider).toBe('claude');
    expect(s.calls.map(call => call.cmd)).toEqual(['claude']);
    expect(s.fake.chats).toHaveLength(0);
  });

  it('does not invent a reported model for GPT', async () => {
    const s = await setup();
    const result = await s.enhancer.enhance({...request, provider: 'gpt'}, 'session-a');
    expect(result.model).toMatchObject({id: 'gpt', reported: false, model: null, answered: true});
  });
});

describe('PromptEnhancer session rate limits', () => {
  async function limited() {
    const s = await setup();
    let time = 1000;
    const enhancer = new PromptEnhancer(s.router, {limit: 2, windowMs: 60000, now: () => time});
    return {...s, enhancer, advance: (ms: number) => { time += ms; }};
  }

  it('refuses the third request for one session before sending anything to a model', async () => {
    const s = await limited();
    await s.enhancer.enhance(request, 'session-a');
    await s.enhancer.enhance(request, 'session-a');
    await expectEnhanceError(s.enhancer.enhance(request, 'session-a'), 429, /nothing was sent/i);
    expect(s.runner).toHaveBeenCalledTimes(2);
    expect(s.fake.chats).toHaveLength(0);
  });

  it('admits a different session even when the first session has exhausted its budget', async () => {
    const s = await limited();
    await s.enhancer.enhance(request, 'session-a');
    await s.enhancer.enhance(request, 'session-a');
    await expectEnhanceError(s.enhancer.enhance(request, 'session-a'), 429, /nothing was sent/i);
    await expect(s.enhancer.enhance(request, 'session-b')).resolves.toMatchObject(enhanced);
    expect(s.runner).toHaveBeenCalledTimes(3);
  });

  it('admits the same session again once the sliding window expires', async () => {
    const s = await limited();
    await s.enhancer.enhance(request, 'session-a');
    await s.enhancer.enhance(request, 'session-a');
    s.advance(59999);
    await expectEnhanceError(s.enhancer.enhance(request, 'session-a'), 429, /nothing was sent/i);
    s.advance(2);
    await expect(s.enhancer.enhance(request, 'session-a')).resolves.toMatchObject(enhanced);
    expect(s.runner).toHaveBeenCalledTimes(3);
  });

  it('does not charge the session budget for validation failures', async () => {
    const s = await limited();
    await expectEnhanceError(s.enhancer.enhance({...request, mode: 'bogus'}, 'session-a'), 400, /invalid enhance mode/i);
    expect(s.runner).not.toHaveBeenCalled();
    await expect(s.enhancer.enhance(request, 'session-a')).resolves.toMatchObject(enhanced);
    await expect(s.enhancer.enhance(request, 'session-a')).resolves.toMatchObject(enhanced);
    await expectEnhanceError(s.enhancer.enhance(request, 'session-a'), 429, /nothing was sent/i);
    expect(s.runner).toHaveBeenCalledTimes(2);
  });
});

describe('PromptEnhancer redaction and provider failures', () => {
  it('redacts an API key before the prompt reaches the provider', async () => {
    const s = await setup();
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123'; // Synthetic redaction fixture.
    await s.enhancer.enhance({...request, text: `explain api_key=${key}`}, 'session-a');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].prompt).toContain('api_key=[REDACTED]');
    expect(s.calls[0].prompt).not.toContain(key);
  });

  it('redacts a GitHub token in the enhanced text and the model additions', async () => {
    const token = 'ghp_' + 'a'.repeat(36); // Synthetic, never a credential.
    const s = await setup(final(JSON.stringify({text: `Use ${token} for this example`, added: [`reference ${token}`]})));
    const result = await s.enhancer.enhance(request, 'session-a');
    expect(result.text).toBe('Use [REDACTED] for this example');
    expect(result.added).toEqual(['reference [REDACTED]']);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('reports an unavailable Grok with no CLI or Ollama fallback', async () => {
    const s = await setup(answer, 'grok');
    await expectEnhanceError(s.enhancer.enhance({...request, provider: 'grok'}, 'session-a'), 503, /Grok.*no fallback/);
    expect(s.calls.map(call => call.cmd)).toEqual(['grok']);
    expect(s.runner).toHaveBeenCalledTimes(1);
    expect(s.fake.chats).toHaveLength(0);
  });

  it('remembers the last failure per provider for the Enhance chip and forgets it when that provider answers', async () => {
    const s = await setup(answer, 'grok');
    await expect(s.enhancer.enhance({...request, provider: 'grok'}, 'session-a')).rejects.toBeInstanceOf(EnhanceError);
    expect(s.enhancer.failures()).toMatchObject({grok: {category: 'unavailable', reason: expect.stringContaining('Grok')}});
    const hub = new PrimeHub({capabilities: [], models: s.router, enhancer: s.enhancer});
    expect((await hub.models()).enhance).toEqual({failures: {grok: expect.objectContaining({category: 'unavailable'})}});
    await s.enhancer.enhance(request, 'session-a');
    expect(Object.keys(s.enhancer.failures())).toEqual(['grok']);
  });

  it('rejects a tool action instead of executing or retrying it', async () => {
    const s = await setup(JSON.stringify({action: 'read', path: 'x'}));
    await expectEnhanceError(s.enhancer.enhance(request, 'session-a'), 502, /returned a tool action/i);
    expect(s.calls.map(call => call.cmd)).toEqual(['claude']);
    expect(s.fake.chats).toHaveLength(0);
  });

  it('rejects an empty provider answer with status 502', async () => {
    const s = await setup(final(''));
    await expectEnhanceError(s.enhancer.enhance(request, 'session-a'), 502, /invalid action/i);
    expect(s.runner).toHaveBeenCalledTimes(1);
    expect(s.fake.chats).toHaveLength(0);
  });
});

describe('PromptEnhancer validation and automatic classification', () => {
  it('rejects text longer than ENHANCE_MAX_INPUT before invoking a provider', async () => {
    const s = await setup();
    await expectEnhanceError(s.enhancer.enhance({...request, text: 'x'.repeat(ENHANCE_MAX_INPUT + 1)}, 'session-a'), 400, /exceeds.*characters/i);
    expect(s.runner).not.toHaveBeenCalled();
    expect(s.fake.chats).toHaveLength(0);
  });

  it('rejects an unknown mode and lists all allowed modes', async () => {
    const s = await setup();
    const promise = s.enhancer.enhance({...request, mode: 'bogus'}, 'session-a');
    await expectEnhanceError(promise, 400, /chat, image, video, music, sfx, voice or auto/);
    expect(s.runner).not.toHaveBeenCalled();
    expect(s.fake.chats).toHaveLength(0);
  });

  it('rejects an unknown provider and lists the supported provider ids', async () => {
    const s = await setup();
    const promise = s.enhancer.enhance({...request, provider: 'unknown'}, 'session-a');
    await expectEnhanceError(promise, 400, /unknown provider/i);
    await expect(promise).rejects.toMatchObject({message: expect.stringContaining(MODEL_IDS.join(', '))});
    expect(s.runner).not.toHaveBeenCalled();
    expect(s.fake.chats).toHaveLength(0);
  });

  it('rejects extra request fields before invoking a provider', async () => {
    const s = await setup();
    await expectEnhanceError(s.enhancer.enhance({...request, model: 'unreviewed-model'}, 'session-a'), 400, /invalid enhance request/i);
    expect(s.runner).not.toHaveBeenCalled();
    expect(s.fake.chats).toHaveLength(0);
  });

  it('classifies an automatic request for a clip as video and uses the video instructions', async () => {
    const s = await setup();
    const result = await s.enhancer.enhance({...request, mode: 'auto', text: 'a 10 second clip of waves crashing, camera pans'}, 'session-a');
    expect(result).toMatchObject({mode: 'video', classified: {kind: 'video'}});
    expect(s.calls[0].prompt).toContain(ENHANCE_SYSTEM.video);
  });

  it('classifies an automatic explanatory request as chat', async () => {
    const s = await setup();
    const result = await s.enhancer.enhance({...request, mode: 'auto', text: 'explain how DNS works'}, 'session-a');
    expect(result).toMatchObject({mode: 'chat', classified: {kind: 'chat'}});
    expect(s.calls[0].prompt).toContain(ENHANCE_SYSTEM.chat);
  });
});

describe('enhancement content parsing', () => {
  it('keeps the additions reported by a JSON answer instead of deriving replacements', () => {
    const content = {text: enhanced.text, added: ['lens selection', 'warm lighting']};
    expect(parseEnhancement(JSON.stringify(content), 'a red fox')).toEqual({...content, addedSource: 'model'});
  });

  it('keeps the whole plain-text answer and derives only phrases absent from the original', () => {
    expect(parseEnhancement(enhanced.text, 'a red fox')).toEqual({...enhanced, addedSource: 'derived'});
  });

  it('derives lens and lighting additions without repeating the original subject', () => {
    expect(derivedAdditions('a red fox', 'a red fox, 85mm lens, golden hour')).toEqual(['85mm lens', 'golden hour']);
  });

  it('rejects empty enhancement content with a 502 EnhanceError', () => {
    expect(() => parseEnhancement('   ', 'a red fox')).toThrow(EnhanceError);
    expect(() => parseEnhancement('   ', 'a red fox')).toThrow(expect.objectContaining({status: 502, message: expect.stringMatching(/empty enhancement/i)}));
  });
});

describe('POST /api/prime/enhance', () => {
  async function fixture(hub: PrimeHub) {
    const dir = mkdtempSync(join(tmpdir(), 'prime-enhance-route-'));
    cleanups.push(dir);
    writeFileSync(join(dir, 'index.html'), 'Prime');
    const server = await startPrimeServer(hub, dir, 0);
    primeServers.push(server);
    const page = await fetch(server.url);
    await page.text();
    expect(page.status).toBe(200);
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^echo_prime=/);
    return {
      post: (input: unknown, authenticated = true) => fetch(server.url + '/api/prime/enhance', {
        method: 'POST',
        headers: {...(authenticated ? {cookie} : {}), origin: server.url, 'content-type': 'application/json', 'x-prime-request': '1'},
        body: JSON.stringify(input),
      }),
    };
  }

  it('refuses a request without the Prime session cookie', async () => {
    const s = await setup(), http = await fixture(new PrimeHub({capabilities: [], models: s.router}));
    const response = await http.post(request, false);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({error: expect.stringMatching(/Prime session required/i)});
    expect(s.runner).not.toHaveBeenCalled();
    expect(s.fake.chats).toHaveLength(0);
  });

  it('returns the image enhancement with a cookie and same-origin headers', async () => {
    const s = await setup(), http = await fixture(new PrimeHub({capabilities: [], models: s.router}));
    const response = await http.post(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({mode: 'image', ...enhanced, provider: 'claude',
      model: {id: 'claude', model: 'claude-sonnet-5-5', reported: true}});
    expect(s.calls.map(call => call.cmd)).toEqual(['claude']);
    expect(s.fake.chats).toHaveLength(0);
  });

  it('preserves the 503 status and Grok error without falling back', async () => {
    const s = await setup(answer, 'grok'), http = await fixture(new PrimeHub({capabilities: [], models: s.router}));
    const response = await http.post({...request, provider: 'grok'});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error: expect.stringMatching(/Grok.*no fallback/)});
    expect(s.calls.map(call => call.cmd)).toEqual(['grok']);
    expect(s.fake.chats).toHaveLength(0);
  });

  it('returns 503 and explains that enhancement is off when no models are configured', async () => {
    const http = await fixture(new PrimeHub({capabilities: []}));
    const response = await http.post(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error: expect.stringMatching(/enhancement is off.*no models section/i)});
  });
});
