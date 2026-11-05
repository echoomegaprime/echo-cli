import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import { BrowserClient, BrowserError, parseBrowserConfig, assertWebUrl, sanitize, DEFAULT_BROWSER } from '../src/prime/browser.js';

type Seen = { method: string; url: string; body: string; type?: string };
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length) { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
type Handler = (type: string, body: Record<string, unknown>, res: ServerResponse) => void;
async function stopLast() { const s = servers.pop()!; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
/** A stand-in for the ShadowGlass relay: records every /rpc, and either runs a custom handler or answers like the
 *  documented routes. Never a real Chrome or extension. `GET /status` reports the extension connected by default. */
async function fakeRelay(handler?: Handler, opts: { extConnected?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/status') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, ext_connected: opts.extConnected ?? true, port: 9780, sol: true }));
        return;
      }
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* */ }
      const type = String(parsed.type ?? '');
      seen.push({ method: req.method ?? '', url: req.url ?? '', body, type });
      res.setHeader('content-type', 'application/json');
      if (handler) { handler(type, parsed, res); return; }
      const ok = (data: unknown) => res.end(JSON.stringify({ ok: true, data }));
      switch (type) {
        case 'tabs_list': return ok([{ id: 1798546071, url: 'https://echoomegaprime.com/', title: 'ECHO Prime', active: true, windowId: 7, incognito: false }, { id: 42, url: 'chrome://settings', title: 'Settings', active: false }]);
        case 'tabs_new': return ok({ id: 9001, url: parsed.url });
        case 'tabs_close': return ok({ closed: parsed.id });
        case 'navigate': return ok({ tabId: parsed.tabId, url: parsed.url });
        case 'cdp_evaluate': return ok(type && String(parsed.expression).startsWith('JSON.stringify') ? '[951,937,2,0,0,1349]' : undefined);
        case 'cdp_click_at': return ok({ x: parsed.x, y: parsed.y });
        case 'click_text': return ok({ clicked: parsed.text });
        case 'cdp_type': return ok({ typed: true });
        case 'fill': return ok({ filled: parsed.selector });
        case 'read_field': return ok({ value: 'field value' });
        case 'cdp_screenshot': return ok({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAA=' });
        case 'page_content': return ok({ url: 'https://echoomegaprime.com/', title: 'ECHO Prime', body: 'Readable page text', nodes: [{ ref: 'n0', role: 'link', name: 'Home', selector: 'a#home' }] });
        default: res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_rpc:' + type }));
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const clientFor = (url: string, timeouts?: { rpc: number; shot: number }) => new BrowserClient({ relayUrl: url }, timeouts);
const bodyOf = (s: Seen) => JSON.parse(s.body) as Record<string, unknown>;

describe('browser config', () => {
  it('defaults to the loopback relay on 9780 and refuses anything else', () => {
    expect(parseBrowserConfig({})).toEqual({ relayUrl: 'http://127.0.0.1:9780' });
    expect(parseBrowserConfig({ relayUrl: 'http://localhost:9780' }).relayUrl).toBe('http://localhost:9780');
    for (const bad of ['http://192.168.1.220:9780', 'https://forge.example', 'http://user:pw@127.0.0.1:9780', 'http://127.0.0.1:9780/rpc', 'http://127.0.0.1:9780/?x=1', 5])
      expect(() => parseBrowserConfig({ relayUrl: bad })).toThrow(/loopback origin|relayUrl/);
    expect(() => parseBrowserConfig({ token: 'x' })).toThrow(/unknown field/);
    expect(() => parseBrowserConfig('on')).toThrow(/object/);
    expect(() => parseBrowserConfig(['x'])).toThrow(/object/);
  });
});
describe('browser URL scheme allowlist', () => {
  it('accepts only http/https and refuses file:, chrome:, javascript:, data:, about:', () => {
    expect(assertWebUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(assertWebUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/');
    for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x', 'about:blank', 'ftp://h/f', 'not a url', '', 'x'.repeat(5000)])
      expect(() => assertWebUrl(bad)).toThrow(BrowserError);
  });
});
describe('sanitize', () => {
  it('redacts secrets and bounds depth/breadth', () => {
    const out = sanitize({ s: 'api_key=sk-abcdefghijklmnopqrstuvwx and password: hunter2', n: [1, true, null], deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 'x' } } } } } } } } } } } });
    const text = JSON.stringify(out);
    expect(text).not.toContain('hunter2'); expect(text).not.toContain('sk-abcdefghijklmnop'); expect(text).toContain('[REDACTED]');
  });
});

describe('BrowserClient against a fake relay — verb → RPC allowlist', () => {
  it('maps every verb to the documented relay RPC type with the right payload, always passing tabId explicitly', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    await c.open('https://example.com/a');
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'tabs_new', url: 'https://example.com/a', active: false });
    await c.navigate(9001, 'https://example.com/b');
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'navigate', tabId: 9001, url: 'https://example.com/b' });
    await c.close(9001);
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'tabs_close', id: 9001 });
    await c.click(9001, { text: 'Sign in' });
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'click_text', tabId: 9001, text: 'Sign in' });
    await c.click(9001, { x: 10.6, y: 20.4 });
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'cdp_click_at', tabId: 9001, x: 11, y: 20 });
    await c.type(9001, 'hello');
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'cdp_type', tabId: 9001, text: 'hello' });
    await c.fill(9001, '#q', 'echo');
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'fill', tabId: 9001, selector: '#q', text: 'echo' });
    expect(await c.read(9001, '#q')).toEqual({ tab: 9001, value: 'field value' });
    expect(bodyOf(r.seen.at(-1)!)).toEqual({ type: 'read_field', tabId: 9001, selector: '#q' });
  });
  it('implements back/forward/reload/scroll via FIXED cdp_evaluate expressions that never contain caller text', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    await c.nav(5, 'back'); await c.nav(5, 'forward'); await c.nav(5, 'reload');
    await c.scroll(5, 99999999); await c.scroll(5, -300.9);
    const exprs = r.seen.filter(s => s.type === 'cdp_evaluate').map(s => bodyOf(s).expression as string);
    expect(exprs.slice(0, 3)).toEqual(['history.back()', 'history.forward()', 'location.reload()']);
    expect(exprs[3]).toBe('window.scrollBy(0,100000)');   // clamped to MAX_SCROLL
    expect(exprs[4]).toBe('window.scrollBy(0,-300)');      // truncated integer
    for (const e of exprs) expect(e).toMatch(/^(?:history\.(?:back|forward)\(\)|location\.reload\(\)|window\.scrollBy\(0,-?\d+\))$/);
  });
  it('refuses a scroll that tries to smuggle code through the distance argument', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    for (const bad of ['1);alert(1)//', NaN, Infinity, '5', {}]) await expect(c.scroll(5, bad as unknown)).rejects.toMatchObject({ status: 400 });
    expect(r.seen.filter(s => s.type === 'cdp_evaluate')).toHaveLength(0);
  });
});
describe('BrowserClient validation and caps', () => {
  it('validates tab ids as positive safe integers, never 32-hex, before any request', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    for (const bad of [0, -1, 1.5, '42', 'a'.repeat(32), NaN, null, undefined, {}, Number.MAX_SAFE_INTEGER + 1])
      await expect(c.close(bad as unknown)).rejects.toMatchObject({ status: 400 });
    expect(r.seen).toHaveLength(0);
    expect((await c.close(42)).closed).toBe(42);
  });
  it('refuses non-web schemes in open and navigate before any request', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    for (const bad of ['file:///x', 'chrome://x', 'javascript:1'])
      { await expect(c.open(bad)).rejects.toMatchObject({ status: 400 }); await expect(c.navigate(5, bad)).rejects.toMatchObject({ status: 400 }); }
    expect(r.seen).toHaveLength(0);
  });
  it('caps owner-supplied text at 64 KiB for type and fill', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    await expect(c.type(5, 'x'.repeat(65537))).rejects.toMatchObject({ status: 400, message: /64 KiB/ });
    await expect(c.fill(5, '#q', 'x'.repeat(65537))).rejects.toMatchObject({ status: 400, message: /64 KiB/ });
    expect(r.seen).toHaveLength(0);
  });
  it('clamps click coordinates to a sane range', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    for (const bad of [{ x: -1, y: 0 }, { x: 0, y: 99999 }, { x: NaN, y: 0 }]) await expect(c.click(5, bad)).rejects.toMatchObject({ status: 400 });
  });
});
describe('BrowserClient snapshot', () => {
  it('always returns readable text + nodes, and a validated screenshot + metrics only when asked', async () => {
    const r = await fakeRelay(); const c = clientFor(r.url);
    const text = await c.snapshot(1798546071, false);
    expect(text).toMatchObject({ tab: 1798546071, url: 'https://echoomegaprime.com/', title: 'ECHO Prime', text: 'Readable page text' });
    expect(text.screenshot).toBeUndefined();
    expect(r.seen.map(s => s.type)).toEqual(['page_content']);
    const shot = await c.snapshot(1798546071, true);
    expect(shot.screenshot).toMatch(/^data:image\/png;base64,/);
    expect(shot.metrics).toEqual({ innerWidth: 951, innerHeight: 937, dpr: 2, scrollX: 0, scrollY: 0, scrollHeight: 1349 });
  });
  it('falls back to text with a reason when the screenshot is oversized or not an image', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024 + 16);
    const r = await fakeRelay((type, _b, res) => {
      if (type === 'page_content') return res.end(JSON.stringify({ ok: true, data: { url: 'u', title: 't', body: 'b', nodes: [] } }));
      if (type === 'cdp_screenshot') return res.end(JSON.stringify({ ok: true, data: { dataUrl: big } }));
      return res.end(JSON.stringify({ ok: true, data: null }));
    });
    const shot = await clientFor(r.url).snapshot(5, true);
    expect(shot.screenshot).toBeUndefined();
    expect(shot.screenshotReason).toMatch(/unavailable|large/i);
  });
  it('redacts secrets found in page text, title and field reads', async () => {
    const r = await fakeRelay((type, _b, res) => {
      if (type === 'page_content') return res.end(JSON.stringify({ ok: true, data: { url: 'u', title: 'api_key=sk-abcdefghijklmnopqrstuvwx', body: 'password: hunter2', nodes: [] } }));
      return res.end(JSON.stringify({ ok: true, data: { value: 'token=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl' } }));
    });
    const c = clientFor(r.url);
    const snap = await c.snapshot(5, false);
    expect(JSON.stringify(snap)).not.toContain('hunter2'); expect(JSON.stringify(snap)).not.toContain('sk-abcdefghijklmnop');
    expect((await c.read(5, '#t')).value).not.toContain('eyJhbGci');
  });
});
describe('BrowserClient error mapping', () => {
  it('maps relay ok:false, refused-secret, ext_offline, unknown_rpc and a down relay to explicit statuses', async () => {
    const refusing = await fakeRelay((_t, _b, res) => res.end(JSON.stringify({ ok: false, error: 'refused_secret_field' })));
    await expect(clientFor(refusing.url).fill(5, '#pw', 'x')).rejects.toMatchObject({ status: 400, message: /credential-bearing/ });
    const offline = await fakeRelay((_t, _b, res) => { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: 'ext_offline' })); });
    await expect(clientFor(offline.url).tabs()).rejects.toMatchObject({ status: 502, message: /not connected/ });
    const unknown = await fakeRelay((_t, _b, res) => res.end(JSON.stringify({ ok: false, error: 'unknown_rpc:foo' })));
    await expect(clientFor(unknown.url).read(5, '#q')).rejects.toMatchObject({ status: 400 });
    const r = await fakeRelay(); const url = r.url; await stopLast();
    await expect(clientFor(url).tabs()).rejects.toMatchObject({ status: 502, message: /unreachable/ });
  });
  it('times out with outcome-unknown and honours an abort signal', async () => {
    const slow = await fakeRelay(() => { /* never answers */ });
    await expect(clientFor(slow.url, { rpc: 60, shot: 60 }).tabs()).rejects.toMatchObject({ status: 504, message: /timed out.*outcome unknown/ });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    await expect(clientFor(slow.url).tabs(controller.signal)).rejects.toMatchObject({ message: 'Interrupted' });
  });
  it('health reports extConnected from GET /status and never attaches the debugger', async () => {
    const on = await fakeRelay(undefined, { extConnected: true });
    expect(await clientFor(on.url).health()).toMatchObject({ extConnected: true });
    const off = await fakeRelay(undefined, { extConnected: false });
    expect(await clientFor(off.url).health()).toMatchObject({ extConnected: false });
    expect([...on.seen, ...off.seen]).toHaveLength(0); // /status is not an /rpc call
  });
});

async function primeServer(browser: BrowserClient | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-browser-')); dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), 'Prime'); writeFileSync(join(dir, 'browser.js'), '// browser'); writeFileSync(join(dir, 'browser.css'), '/* browser */');
  const server = await startPrimeServer(new PrimeHub({ capabilities: [], browser }), dir, 0);
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-prime-request': '1' };
  const get = (path: string) => fetch(server.url + path, { headers });
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { ...headers, origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { server, headers, get, post, close: () => server.close() };
}
describe('Prime browser routes', () => {
  it('is off without a browser section: status says so, tabs/snapshot/act refused with 503', async () => {
    const p = await primeServer(undefined);
    try {
      expect(await (await p.get('/api/prime/browser/status')).json()).toMatchObject({ configured: false, available: false, reason: expect.stringMatching(/no browser section/) });
      expect((await p.get('/api/prime/browser/tabs')).status).toBe(503);
      expect((await p.get('/api/prime/browser/snapshot/42')).status).toBe(503);
      expect((await p.post('/api/prime/browser/act', { verb: 'open', url: 'https://x.com' })).status).toBe(503);
    } finally { await p.close(); }
  });
  it('requires the same-origin Prime session on every browser route', async () => {
    const r = await fakeRelay(); const p = await primeServer(clientFor(r.url));
    try {
      expect((await fetch(p.server.url + '/api/prime/browser/tabs', { headers: { 'x-prime-request': '1' } })).status).toBe(403);
      const cross = await fetch(p.server.url + '/api/prime/browser/act', { method: 'POST', headers: { ...p.headers, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{"verb":"open","url":"https://x.com"}' });
      expect(cross.status).toBe(403);
      expect(r.seen).toHaveLength(0);
    } finally { await p.close(); }
  });
  it('serves status, tabs, a snapshot and an act, plus the browser assets', async () => {
    const r = await fakeRelay(); const p = await primeServer(clientFor(r.url));
    try {
      expect(await (await p.get('/api/prime/browser/status')).json()).toMatchObject({ configured: true, available: true, relayUrl: r.url });
      expect(await (await p.get('/api/prime/browser/tabs')).json()).toMatchObject({ tabs: expect.arrayContaining([expect.objectContaining({ id: 1798546071 })]) });
      expect(await (await p.get('/api/prime/browser/snapshot/1798546071?shot=1')).json()).toMatchObject({ screenshot: expect.stringMatching(/^data:image/) });
      const act = await p.post('/api/prime/browser/act', { verb: 'open', url: 'https://example.com/z' });
      expect(act.status).toBe(200); expect(await act.json()).toMatchObject({ id: 9001 });
      expect((await fetch(p.server.url + '/browser.js')).status).toBe(200);
      expect((await fetch(p.server.url + '/browser.css')).headers.get('content-type')).toContain('text/css');
    } finally { await p.close(); }
  });
  it('refuses an unknown verb and a non-web URL through the act route', async () => {
    const r = await fakeRelay(); const p = await primeServer(clientFor(r.url));
    try {
      expect((await p.post('/api/prime/browser/act', { verb: 'nuke', tab: 5 })).status).toBe(400);
      expect((await p.post('/api/prime/browser/act', { verb: 'open', url: 'file:///etc/passwd' })).status).toBe(400);
      expect(r.seen.filter(s => s.type === 'tabs_new')).toHaveLength(0);
    } finally { await p.close(); }
  });
});
