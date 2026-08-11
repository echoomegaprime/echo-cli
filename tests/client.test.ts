import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  getGatewayUrl: () => 'https://gateway.example.com',
  requireApiKey: () => 'test-api-key',
}));

import { EchoClient } from '../src/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EchoClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends the API key on X-Echo-API-Key for authenticated requests', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, data: { ok: true }, error: null, meta: {} })
    );
    const client = new EchoClient('https://gateway.example.com', 'my-key');
    await client.health();

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['X-Echo-API-Key']).toBe('my-key');
  });

  it('publicRequest does NOT send an API key header', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, data: { plans: [] }, error: null, meta: {} })
    );
    const client = new EchoClient('https://gateway.example.com', 'my-key');
    await client.publicRequest('/plans');

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['X-Echo-API-Key']).toBeUndefined();
  });

  it('throws EchoApiError with the server-provided code and message on a non-success envelope', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        { success: false, data: null, error: { message: 'Invalid key', code: 'UNAUTHORIZED' }, meta: {} },
        401
      )
    );
    const client = new EchoClient('https://gateway.example.com', 'bad-key');

    await expect(client.health()).rejects.toMatchObject({
      message: 'Invalid key',
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });

  it('throws a TIMEOUT EchoApiError when the request is aborted', async () => {
    fetchSpy.mockImplementation((_url: string | URL | Request, opts?: RequestInit) => {
      const signal = (opts as RequestInit).signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new EchoClient('https://gateway.example.com', 'my-key');

    await expect(
      client.request('/engine/query', { method: 'POST', timeout: 5 })
    ).rejects.toMatchObject({ code: 'TIMEOUT', status: 408 });
  });

  it('returns unwrapped data on success', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, data: { engines: 5 }, error: null, meta: {} })
    );
    const client = new EchoClient('https://gateway.example.com', 'my-key');
    const result = await client.engineStats();
    expect(result).toEqual({ engines: 5 });
  });

  it('builds query params for GET requests without a body', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, data: [], error: null, meta: {} })
    );
    const client = new EchoClient('https://gateway.example.com', 'my-key');
    await client.engineSearch('hello world', 3);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/engine/search');
    expect(parsed.searchParams.get('q')).toBe('hello world');
    expect(parsed.searchParams.get('limit')).toBe('3');
  });
});
