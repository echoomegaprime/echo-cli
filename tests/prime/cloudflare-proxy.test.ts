import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker from '../../deploy/cloudflare/echoprime-proxy.js';
import baseline from '../fixtures/echoprime-proxy-2bb0c38f.js';

type Worker = { fetch(request: Request): Promise<Response> };

async function invoke(
  handler: Worker,
  path: string,
  method = 'GET',
  upstream = () => new Response('<html>callback page</html>', {
    headers: { 'content-type': 'text/html', 'referrer-policy': 'no-referrer' },
  }),
) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return upstream();
  }));
  const input = new Request('https://echoomegaprime.com' + path, {
    method,
    headers: { 'x-test-header': 'preserved' },
    ...(method === 'POST' ? { body: '{"task":"local-fixture"}' } : {}),
  });
  const originalUrl = input.url;
  const response = await handler.fetch(input);
  return {
    requests,
    originalUrl,
    inputUrlAfter: input.url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    cookies: response.headers.getSetCookie(),
    body: await response.text(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Prime OAuth callback edge privacy', () => {
  it.each(['GET', 'HEAD'])('removes the entire callback query upstream for %s', async method => {
    const path = '/bots-oauth-callback.html?code=synthetic-code&state=synthetic-state&scope=openid';
    const result = await invoke(worker, path, method);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].url).toBe('https://desktop-web.echo-op.com/bots-oauth-callback.html');
    expect(result.requests[0].method).toBe(method);
    expect(result.requests[0].headers['x-forwarded-host']).toBe('echoomegaprime.com');
    expect(result.requests[0].headers['x-test-header']).toBe('preserved');
    expect(result.inputUrlAfter).toBe(result.originalUrl);
    expect(result.inputUrlAfter).toContain('code=synthetic-code');
  });

  it.each([
    '?error=access_denied&state=synthetic-state',
    '?code=one&code=two&state=state%2Bvalue&extra=%E2%9C%93',
    '',
  ])('keeps callback rendering independent of provider query %s', async query => {
    const result = await invoke(worker, '/bots-oauth-callback.html' + query);
    expect(result.requests[0].url).toBe('https://desktop-web.echo-op.com/bots-oauth-callback.html');
    expect(result.body).toBe('<html>callback page</html>');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
  });

  it('keeps the real callback script able to consume browser code/state and POST them once', async () => {
    const path = '/bots-oauth-callback.html?code=synthetic-code%2Bvalue&state=synthetic-state';
    const edge = await invoke(worker, path);
    expect(new URL(edge.requests[0].url).search).toBe('');
    const location = new URL(edge.inputUrlAfter);
    const events: string[] = [];
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    const status = { textContent: '' };
    const browserFetch = async (url: string, init?: RequestInit) => {
      events.push('fetch:' + url);
      posts.push({ url, init });
      if (url === '/api/session') return { ok: true, json: async () => ({
        workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'synthetic-csrf',
      }) };
      return { ok: true, json: async () => ({ status: 'connected' }) };
    };
    const script = readFileSync(new URL('../../ui/echo-prime/bots-oauth-callback.js', import.meta.url), 'utf8');
    runInNewContext(script, {
      URLSearchParams,
      location,
      history: { replaceState: (_state: unknown, _title: string, url: string) => {
        events.push('replace:' + url);
        location.search = '';
      } },
      document: { getElementById: () => status },
      fetch: browserFetch,
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(events[0]).toBe('replace:/bots-oauth-callback.html');
    expect(location.search).toBe('');
    expect(posts).toHaveLength(2);
    expect(posts[1].url).toBe('/api/prime/bots/workspace/connection.callback');
    expect(posts[1].init?.method).toBe('POST');
    expect(JSON.parse(String(posts[1].init?.body))).toEqual({
      state: 'synthetic-state', code: 'synthetic-code+value',
    });
    expect(status.textContent).toBe('App connected to its selected bot. Return to Echo Prime and refresh the bot’s Apps tab.');
  });

  it.each([
    ['/', 'GET'],
    ['/api/prime/bots/health?include=counts', 'GET'],
    ['/app/home?next=%2Fbots', 'GET'],
    ['/sentinel-chat.js?v=2', 'GET'],
    ['/agent-api/tasks?limit=5', 'GET'],
    ['/agent-api/tasks?dry_run=true', 'POST'],
    ['/bots-oauth-callback.js?v=3', 'GET'],
    ['/bots-oauth-callback.html/extra?code=synthetic', 'GET'],
    ['/BOTS-oauth-callback.html?code=synthetic', 'GET'],
    ['/bots-oauth-callback.html?not_a_provider_redirect=true', 'POST'],
  ])('preserves the verified live Worker behavior for %s %s', async (path, method) => {
    const before = await invoke(baseline, path, method);
    const after = await invoke(worker, path, method);
    expect(after).toEqual(before);
  });

  it('preserves JavaScript rewriting, response headers and multiple cookies', async () => {
    const upstream = () => {
      const headers = new Headers({
        'content-type': 'application/javascript',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'",
        'content-length': '123',
      });
      headers.append('set-cookie', 'session=synthetic; Path=/; HttpOnly; Secure');
      headers.append('set-cookie', 'refresh=synthetic; Path=/; HttpOnly; Secure');
      return new Response("const agent='https://agent.echo-op.com';", { headers });
    };
    const before = await invoke(baseline, '/app.js?v=1', 'GET', upstream);
    const after = await invoke(worker, '/app.js?v=1', 'GET', upstream);
    expect(after).toEqual(before);
    expect(after.body).toBe("const agent='/agent-api';");
    expect(after.headers['content-length']).toBeUndefined();
    expect(after.cookies).toHaveLength(2);
  });

  it.each([404, 502])('preserves upstream callback status %s and body', async status => {
    const result = await invoke(worker, '/bots-oauth-callback.html?code=synthetic&state=synthetic', 'GET',
      () => new Response('Upstream response', { status, headers: { 'cache-control': 'no-store' } }));
    expect(result.status).toBe(status);
    expect(result.body).toBe('Upstream response');
    expect(result.headers['cache-control']).toBe('no-store');
  });
});
