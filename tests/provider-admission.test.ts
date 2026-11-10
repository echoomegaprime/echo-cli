import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { DEFAULT_MODELS, ModelRouter, parseModelsConfig } from '../src/code/model-factory.js';
import { ProviderProcessCleanupError, providerExecutionBlock, type Runner } from '../src/code/providers.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Unexpected native provider launch'); }),
}));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
const messages = [{ role: 'user' as const, content: 'Explain this code.' }];

describe('native provider admission', () => {
  it('reports the blocked GPT boundary without probing a vendor login', async () => {
    const router = new ModelRouter();
    expect(await router.available('gpt')).toEqual({ available: false, reason: providerExecutionBlock('gpt') });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a pinned GPT turn without a subprocess, local fallback or answered receipt', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected model request'); });
    vi.stubGlobal('fetch', fetch);
    const router = new ModelRouter(parseModelsConfig({ default: 'gpt' }));
    const turn = router.turn('gpt');
    await expect(turn.model.next(messages)).rejects.toThrow(providerExecutionBlock('gpt'));
    expect(turn.info()).toMatchObject({ id: 'gpt', answered: false });
    expect(turn.answered()).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('labels execution admission separately from installation and sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{ name: DEFAULT_MODELS.model }] }), { headers: { 'content-type': 'application/json' } })));
    const report = await new ModelRouter().report();
    expect(report.providers.find(p => p.id === 'gpt')).toMatchObject({
      available: false, check: 'execution-blocked', reason: providerExecutionBlock('gpt'), last: null,
    });
    expect(report.providers.find(p => p.id === 'qwen')).toMatchObject({ available: true, check: 'model-listed' });
  });

  it('keeps reviewed host runner injection separate from the default native path', async () => {
    const runner: Runner = vi.fn(async (_cmd, args) => ({
      code: 0, stderr: '', timedOut: false,
      stdout: args[0] === 'exec' ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"action":"final","content":"controlled host result"}' } }) : '',
    }));
    const router = new ModelRouter(DEFAULT_MODELS, { runner });
    expect(await router.available('gpt')).toEqual({ available: true });
    expect(await router.turn('gpt').model.next(messages)).toEqual({ action: 'final', content: 'controlled host result' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not treat a signalled login/version probe as successful admission', async () => {
    const runner: Runner = vi.fn(async () => ({ code: null, stderr: '', timedOut: false, stdout: 'success-looking output' }));
    const router = new ModelRouter(DEFAULT_MODELS, { runner });
    for (const id of ['claude', 'gpt', 'grok', 'argon'] as const) {
      expect(await router.available(id)).toMatchObject({ available: false, reason: expect.stringContaining('without a success code') });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not admit Argon variants from a signalled model-list subprocess', async () => {
    const runner: Runner = vi.fn(async (_cmd, args) => ({ code: args[0] === 'models' ? null : 0, stderr: '', timedOut: false, stdout: 'gemini-fixture\tFixture model' }));
    const router = new ModelRouter(DEFAULT_MODELS, { runner });
    await expect(router.variant('argon', 'gemini-fixture')).rejects.toThrow(/cannot be verified/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves safe cleanup uncertainty in provider status and model-list refusals', async () => {
    const error = new ProviderProcessCleanupError();
    const probeRunner: Runner = async () => { throw error; };
    expect(await new ModelRouter(DEFAULT_MODELS, { runner: probeRunner }).available('claude')).toEqual({ available: false, reason: error.message });
    const listRunner: Runner = async (_cmd, args) => {
      if (args[0] === 'models') throw error;
      return { code: 0, stderr: '', stdout: '', timedOut: false };
    };
    await expect(new ModelRouter(DEFAULT_MODELS, { runner: listRunner }).variant('argon', 'gemini-fixture')).rejects.toThrow(error.message);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['cli', 'runner', 'allowUnqualifiedProviders', 'providerAdmission'])('rejects browser/JSON attempts to introduce %s as an override', key => {
    const value = key === 'cli' ? { cli: { gpt: { enabled: true } } } : { [key]: true };
    expect(() => parseModelsConfig(value)).toThrow(/Invalid models configuration/);
  });

  it.runIf(process.platform === 'win32')('reports all native Windows CLI lanes unavailable without launching processes', async () => {
    const router = new ModelRouter();
    for (const id of ['claude', 'gpt', 'grok', 'argon'] as const) {
      expect(await router.available(id)).toEqual({ available: false, reason: providerExecutionBlock(id) });
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
