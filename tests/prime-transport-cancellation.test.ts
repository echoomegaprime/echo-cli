import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mcpPlugins } from '../src/code/tools/mcp-plugins.js';
import type { ToolEnvironment } from '../src/code/tools/types.js';
import { type Json, type McpConnection, type SdkBroker, type Tool } from '../src/prime/hub.js';
import { sdkBroker } from '../src/prime/sdk.js';
import { StdioMcp } from '../src/prime/stdio.js';
import { connectionGateway, sdkToolInvoke } from '../src/prime/tools-bridge.js';

const advertised: Tool[] = [{ name: 'read_status', inputSchema: { type: 'object' } }];
const action = { action: 'call', connection: 'fixture', tool: 'read_status', arguments: {} };
const sdkRequest = { capability: 'echo.test.read', params: { command: 'lookup', query: 'fixture' }, reason: 'Controlled fixture', idempotency_key: 'same-request' };
const clients: StdioMcp[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function connection(listTools: McpConnection['listTools'] = async () => advertised) {
  return { listTools: vi.fn(listTools), call: vi.fn<McpConnection['call']>(async () => ({ ok: true })) };
}
function broker() {
  return { search: vi.fn<SdkBroker['search']>(async () => []), read: vi.fn<SdkBroker['read']>(async () => ({})), invoke: vi.fn<SdkBroker['invoke']>(async () => ({ ok: true })) };
}
function environment(mcp: ToolEnvironment['mcp']): ToolEnvironment {
  return { mcp, mcpAllow: ['fixture:read_status'], skillRoots: [], crystal: false, now: Date.now };
}
function observe<T>(promise: Promise<T>) {
  let outcome: { state: 'pending' } | { state: 'resolved'; value: T } | { state: 'rejected'; error: unknown } = { state: 'pending' };
  const settled = promise.then(value => { outcome = { state: 'resolved', value }; }, error => { outcome = { state: 'rejected', error }; });
  return { current: () => outcome, settled };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function stdio(mode = '') {
  const client = await StdioMcp.connect({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/prime-cancellation-mcp.mjs', import.meta.url))], env: { PRIME_TEST_LIST_MODE: mode } }, 2000);
  clients.push(client); return client;
}
async function state(client: StdioMcp) {
  return await client.call('fixture_state', {}) as { requests: Array<{ method: string; params: Json }>; heldCalls: number; heldLists: number };
}

describe('MCP cancellation across discovery and dispatch', () => {
  it('refuses an already-aborted plugin call before discovery', async () => {
    const controller = new AbortController(), list = vi.fn(async () => [{ id: 'fixture', name: 'fixture', tools: advertised }]), call = vi.fn(async () => ({}));
    controller.abort();
    await expect(mcpPlugins.run(action, environment({ list, call }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(list).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });

  it('does not dispatch after an uncooperative plugin lookup finishes late', async () => {
    const controller = new AbortController(), lookup = deferred<Array<{ id: string; name: string; tools: Tool[] }>>(), call = vi.fn(async () => ({}));
    const pending = mcpPlugins.run(action, environment({ list: () => lookup.promise, call }), controller.signal);
    controller.abort(); lookup.resolve([{ id: 'fixture', name: 'fixture', tools: advertised }]);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses already-aborted gateway listing and calls before discovery', async () => {
    const owner = connection(), gateway = connectionGateway({ fixture: owner }), controller = new AbortController(); controller.abort();
    await expect(gateway.list(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(gateway.call('fixture', 'read_status', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(owner.listTools).not.toHaveBeenCalled(); expect(owner.call).not.toHaveBeenCalled();
  });

  it('refuses an already-aborted gateway call even when discovery is cached', async () => {
    const owner = connection(), gateway = connectionGateway({ fixture: owner }), controller = new AbortController();
    await gateway.list(); controller.abort();
    await expect(gateway.call('fixture', 'read_status', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(owner.listTools).toHaveBeenCalledTimes(1); expect(owner.call).not.toHaveBeenCalled();
  });

  it('does not dispatch or cache the result of a cancelled discovery', async () => {
    const lookup = deferred<Tool[]>(), owner = connection(() => lookup.promise), gateway = connectionGateway({ fixture: owner }), controller = new AbortController();
    const pending = gateway.call('fixture', 'read_status', {}, controller.signal);
    controller.abort(); lookup.resolve(advertised);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(owner.call).not.toHaveBeenCalled();
    await gateway.list(); expect(owner.listTools).toHaveBeenCalledTimes(2);
  });

  it('does not swallow cancellation or start discovery on the next connection', async () => {
    const lookup = deferred<Tool[]>(), first = connection(() => lookup.promise), second = connection(), controller = new AbortController();
    const pending = connectionGateway({ first, second }).list(controller.signal);
    controller.abort(); lookup.resolve(advertised);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(second.listTools).not.toHaveBeenCalled();
  });

  it('propagates one signal to both discovery and the actual MCP call', async () => {
    const owner = connection(), controller = new AbortController();
    await expect(connectionGateway({ fixture: owner }).call('fixture', 'read_status', { detail: true }, controller.signal)).resolves.toEqual({ ok: true });
    expect(owner.listTools).toHaveBeenCalledWith(controller.signal);
    expect(owner.call).toHaveBeenCalledExactlyOnceWith('read_status', { detail: true }, { signal: controller.signal });
  });
});

describe('SDK cancellation propagation', () => {
  it('passes the live-tool signal without changing the authenticated command or idempotency fields', async () => {
    const owner = broker(), controller = new AbortController();
    await sdkToolInvoke(owner)('echo.test.read', 'lookup', { query: 'fixture' }, controller.signal);
    expect(owner.invoke).toHaveBeenCalledExactlyOnceWith({ capability: 'echo.test.read', params: { command: 'lookup', query: 'fixture' }, reason: expect.stringContaining('ECHO Prime live tool call'), idempotency_key: expect.stringMatching(/^[a-f0-9-]{36}$/) }, { signal: controller.signal });
  });

  it('does not send an already-aborted live SDK request', async () => {
    const owner = broker(), controller = new AbortController(); controller.abort();
    await expect(sdkToolInvoke(owner)('echo.test.read', 'lookup', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(owner.invoke).not.toHaveBeenCalled();
  });

  it('rejects a late SDK adapter result after its caller aborts', async () => {
    const owner = broker(), reply = deferred<unknown>(), controller = new AbortController(); owner.invoke.mockImplementation(() => reply.promise);
    const pending = sdkToolInvoke(owner)('echo.test.read', 'lookup', {}, controller.signal);
    controller.abort(); reply.resolve({ ok: true });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(owner.invoke).toHaveBeenCalledTimes(1);
  });

  async function sdk() {
    const owner = connection(async () => ['search', 'read', 'invoke'].map(name => ({ name, inputSchema: {} })));
    return { owner, sdk: await sdkBroker(owner, { search: 'search', read: 'read', invoke: 'invoke' }, { link_id: 'fixture-account' }) };
  }

  it('preserves the bridge timeout, account and exact request ID while forwarding the signal', async () => {
    const f = await sdk(), controller = new AbortController();
    await f.sdk.invoke(sdkRequest, { timeoutMs: 1250, signal: controller.signal });
    expect(f.owner.call).toHaveBeenCalledExactlyOnceWith('invoke', { link_id: 'fixture-account', ...sdkRequest, timeout_ms: 1250 }, { timeoutMs: 6250, signal: controller.signal });
  });

  it('refuses an already-aborted broker request before connection dispatch', async () => {
    const f = await sdk(), controller = new AbortController(); controller.abort();
    await expect(f.sdk.invoke(sdkRequest, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.owner.call).not.toHaveBeenCalled();
  });

  it('does not accept a cancelled broker invocation that resolves late or retry it', async () => {
    const f = await sdk(), reply = deferred<unknown>(), controller = new AbortController(); f.owner.call.mockImplementation(() => reply.promise);
    const pending = f.sdk.invoke(sdkRequest, { signal: controller.signal });
    controller.abort(); reply.resolve({ ok: true });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(f.owner.call).toHaveBeenCalledTimes(1);
  });
});

describe('stdio RPC cancellation with an independent owner process', () => {
  it('writes neither list nor tool requests when already aborted', async () => {
    const client = await stdio(), controller = new AbortController(); controller.abort();
    await expect(client.listTools(controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: expect.stringContaining('not sent') });
    await expect(client.call('read_status', {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: expect.stringContaining('not sent') });
    expect((await state(client)).requests.map(r => r.params.name)).toEqual(['fixture_state']);
  });

  it('settles a sent call locally, removes its listener and ignores its late reply without retrying', async () => {
    const client = await stdio(), controller = new AbortController(), result = observe(client.call('delayed', {}, { signal: controller.signal }));
    expect((await state(client)).heldCalls).toBe(1);
    controller.abort(); await tick();
    expect(result.current()).toMatchObject({ state: 'rejected', error: { name: 'AbortError', message: expect.stringContaining('outcome unknown') } });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await client.call('release_calls', {});
    await expect(client.call('read_status', {})).resolves.toEqual({ ok: true });
    expect((await state(client)).requests.filter(r => r.params.name === 'delayed')).toHaveLength(1);
    expect(result.current()).toMatchObject({ state: 'rejected' }); await result.settled;
  });

  it('cancels the full SDK adapter and broker path without serializing the signal or resending the command', async () => {
    const client = await stdio(), sdk = await sdkBroker(client, { search: 'read_status', read: 'read_status', invoke: 'delayed' }, { link_id: 'fixture-account' });
    const controller = new AbortController(), result = observe(sdkToolInvoke(sdk)('echo.test.read', 'lookup', { query: 'fixture' }, controller.signal));
    const sent = await state(client); expect(sent.heldCalls).toBe(1);
    expect(sent.requests.find(r => r.params.name === 'delayed')?.params).toEqual({ name: 'delayed', arguments: { link_id: 'fixture-account', capability: 'echo.test.read', params: { command: 'lookup', query: 'fixture' }, reason: expect.stringContaining('ECHO Prime live tool call'), idempotency_key: expect.stringMatching(/^[a-f0-9-]{36}$/) } });
    controller.abort(); await tick();
    expect(result.current()).toMatchObject({ state: 'rejected', error: { name: 'AbortError', message: expect.stringContaining('outcome unknown') } });
    await client.call('release_calls', {});
    expect((await state(client)).requests.filter(r => r.params.name === 'delayed')).toHaveLength(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); await result.settled;
  });

  it('frees all occupied short-request slots on cancellation even while remote calls remain pending', async () => {
    const client = await stdio(), controllers = Array.from({ length: 16 }, () => new AbortController());
    const results = controllers.slice(0, 15).map(controller => observe(client.call('delayed', {}, { signal: controller.signal })));
    expect((await state(client)).heldCalls).toBe(15);
    results.push(observe(client.call('delayed', {}, { signal: controllers[15].signal })));
    controllers.forEach(controller => controller.abort()); await tick();
    expect(results.map(result => result.current().state)).toEqual(Array(16).fill('rejected'));
    const remote = await state(client); expect(remote.heldCalls).toBe(16);
    expect(controllers.every(controller => getEventListeners(controller.signal, 'abort').length === 0)).toBe(true);
    await client.call('release_calls', {}); await Promise.all(results.map(result => result.settled));
  });

  it('does not request the next inventory page after cancellation during a pending page', async () => {
    const client = await stdio('held'), controller = new AbortController(), result = observe(client.listTools(controller.signal));
    expect((await state(client)).heldLists).toBe(1);
    controller.abort(); await tick();
    expect(result.current()).toMatchObject({ state: 'rejected', error: { name: 'AbortError' } });
    await client.call('release_list', {}); await tick();
    expect((await state(client)).requests.filter(r => r.method === 'tools/list')).toHaveLength(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); await result.settled;
  });

  it('removes abort listeners after a response, timeout and connection close', async () => {
    const client = await stdio(), success = new AbortController(), timeout = new AbortController(), close = new AbortController();
    await client.call('read_status', {}, { signal: success.signal });
    expect(getEventListeners(success.signal, 'abort')).toHaveLength(0);
    const timedOut = observe(client.call('delayed', {}, { timeoutMs: 100, signal: timeout.signal }));
    expect(getEventListeners(timeout.signal, 'abort')).toHaveLength(1);
    await timedOut.settled;
    expect(timedOut.current()).toMatchObject({ state: 'rejected', error: { message: 'MCP request timed out; outcome unknown' } });
    expect(getEventListeners(timeout.signal, 'abort')).toHaveLength(0);
    const closed = observe(client.call('delayed', {}, { signal: close.signal }));
    expect(getEventListeners(close.signal, 'abort')).toHaveLength(1);
    client.close(); await closed.settled;
    expect(closed.current()).toMatchObject({ state: 'rejected' }); expect(getEventListeners(close.signal, 'abort')).toHaveLength(0);
  });
});
