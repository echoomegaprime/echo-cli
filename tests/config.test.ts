import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the `conf` package so tests never touch the real on-disk config store
// (~/.echo-prime/config.json on the machine running the suite).
const store: Record<string, unknown> = {
  apiKey: '',
  gatewayUrl: 'https://echo-sdk-gateway.bmcii1976.workers.dev',
};

vi.mock('conf', () => ({
  default: class MockConf {
    get(key: string) {
      return store[key];
    }
    set(key: string, value: unknown) {
      store[key] = value;
    }
  },
}));

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    store.apiKey = '';
    store.gatewayUrl = 'https://echo-sdk-gateway.bmcii1976.workers.dev';
    delete process.env.ECHO_API_KEY;
    delete process.env.ECHO_GATEWAY_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getApiKey prefers ECHO_API_KEY env var over stored config', async () => {
    store.apiKey = 'stored-key';
    process.env.ECHO_API_KEY = 'env-key';
    const { getApiKey } = await import('../src/config.js');
    expect(getApiKey()).toBe('env-key');
  });

  it('getApiKey falls back to stored config when env var is unset', async () => {
    store.apiKey = 'stored-key';
    const { getApiKey } = await import('../src/config.js');
    expect(getApiKey()).toBe('stored-key');
  });

  it('getApiKey returns an empty string when neither source is configured', async () => {
    const { getApiKey } = await import('../src/config.js');
    expect(getApiKey()).toBe('');
  });

  it('getGatewayUrl prefers ECHO_GATEWAY_URL env var over stored config', async () => {
    process.env.ECHO_GATEWAY_URL = 'https://custom-gateway.example.com';
    const { getGatewayUrl } = await import('../src/config.js');
    expect(getGatewayUrl()).toBe('https://custom-gateway.example.com');
  });

  it('getGatewayUrl falls back to the stored default gateway', async () => {
    const { getGatewayUrl } = await import('../src/config.js');
    expect(getGatewayUrl()).toBe('https://echo-sdk-gateway.bmcii1976.workers.dev');
  });

  it('requireApiKey returns the key when one is configured', async () => {
    process.env.ECHO_API_KEY = 'a-real-key';
    const { requireApiKey } = await import('../src/config.js');
    expect(requireApiKey()).toBe('a-real-key');
  });

  it('requireApiKey exits the process with a helpful message when no key is configured', async () => {
    const { requireApiKey } = await import('../src/config.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => requireApiKey()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No API key configured'));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
