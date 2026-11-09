import { expect, it, vi } from 'vitest';
import { OwnerBotTools } from '../src/prime/bot-tools.js';
import type { ChatTool, DelegatedTask } from '../src/code/tools/autoagents.js';
import { PrimeHub, type McpConnection, type Tool } from '../src/prime/hub.js';

it('does not record owner tool success when cancellation occurs before an immediately returned result', async () => {
  const controller = new AbortController();
  const run = vi.fn<ChatTool['run']>(async () => {
    controller.abort();
    return { ok: true, marker: 'result-after-abort' };
  });
  const tool: ChatTool = { name: 'owner_fixture', description: 'Controlled cancellation fixture', inputSchema: { type: 'object' }, run };
  const tools = new OwnerBotTools({ tools: () => [tool] }, { owner: true, prompt: 'fixture' });
  const result = await tools.execute({ action: 'tool', tool: tool.name, args: {} }, undefined, controller.signal);
  expect(controller.signal.aborted).toBe(true);
  expect(result.result).toMatchObject({ state: 'unknown' });
  expect(result.result).not.toMatchObject({ ok: true });
  expect(tools.events.at(-1)).toMatchObject({ evidence: { status: 'failed' } });
  expect(run).toHaveBeenCalledOnce();
});

const eshTools: Tool[] = [
  { name: 'esh_status', inputSchema: {} },
  { name: 'esh_run', inputSchema: { properties: { dry_run: { type: 'boolean' } } } },
];
function esh(tier = 0) {
  const connection = {
    listTools: vi.fn<McpConnection['listTools']>(async () => eshTools),
    call: vi.fn<McpConnection['call']>(async (name, args) => name === 'esh_status'
      ? { ok: true, version: 'fixture', ledger: { ok: true } }
      : args.dry_run ? { ok: true, tier, verdict: 'explain', authorised: true, session_version: 7 }
      : { ok: true, verdict: 'allowed', exit: 0, audit_id: 'fixture-execution' }),
  };
  return { connection, hub: new PrimeHub({ capabilities: [], esh: connection }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  let outcome: { state: 'pending' } | { state: 'resolved'; value: T } | { state: 'rejected'; error: unknown } = { state: 'pending' };
  const settled = promise.then(value => { outcome = { state: 'resolved', value }; }, error => { outcome = { state: 'rejected', error }; });
  return { current: () => outcome, settled };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('forwards the owner signal through ESH classification, review prerequisites and ticket execution', async () => {
  const f = esh(), controller = new AbortController();
  const result = await f.hub.autonomyTools()[0].run({ command: 'git status' }, { owner: true, prompt: 'fixture', sessionId: 'fixture-session', signal: controller.signal }) as Record<string, unknown>;
  expect(result.state).toBe('returned');
  expect(f.connection.call.mock.calls.every(call => call[2]?.signal === controller.signal)).toBe(true);
  expect(f.connection.listTools.mock.calls.every(call => call[0] === controller.signal)).toBe(true);
  const actual = f.connection.call.mock.calls.filter(([name, args]) => name === 'esh_run' && !args.dry_run);
  expect(actual).toHaveLength(1);
  expect(actual[0][1]).toMatchObject({ cmd: 'git status', timeout: 15, budget_bytes: 16384, expect_version: 7, idempotency_key: result.requestId });
});

async function reviewed() {
  const f = esh(2);
  const result = await f.hub.autonomyTools()[0].run({ command: 'git status' }, { owner: true, prompt: 'fixture' }) as { review: { id: string; digest: string; requestId: string } };
  f.connection.call.mockClear(); f.connection.listTools.mockClear();
  return { ...f, ticket: result.review };
}

it('refuses an already-aborted ESH execute before dispatch or consuming the reviewed ticket', async () => {
  const f = await reviewed(), controller = new AbortController(); controller.abort();
  await expect(f.hub.execute(f.ticket.id, f.ticket.digest, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.connection.call).not.toHaveBeenCalled();
  await expect(f.hub.execute(f.ticket.id, f.ticket.digest)).resolves.toMatchObject({ state: 'returned', requestId: f.ticket.requestId });
  expect(f.connection.call).toHaveBeenCalledOnce();
});

it('settles an interrupted ESH execution as uncertain with its original request ID and no replay', async () => {
  const f = await reviewed(), controller = new AbortController(), late = deferred<unknown>();
  f.connection.call.mockImplementation(() => late.promise);
  const result = observe(f.hub.execute(f.ticket.id, f.ticket.digest, controller.signal));
  controller.abort(); await tick();
  expect(result.current()).toMatchObject({ state: 'resolved', value: { state: 'uncertain', requestId: f.ticket.requestId } });
  expect(f.connection.call).toHaveBeenCalledExactlyOnceWith('esh_run', expect.objectContaining({ idempotency_key: f.ticket.requestId }), { signal: controller.signal });
  late.resolve({ ok: true, verdict: 'allowed', exit: 0 }); await result.settled;
  expect(result.current()).toMatchObject({ state: 'resolved', value: { state: 'uncertain' } });
  await expect(f.hub.execute(f.ticket.id, f.ticket.digest)).rejects.toThrow('already submitted');
  expect(f.connection.call).toHaveBeenCalledOnce();
});

it('bounds ESH review discovery and refuses a late inventory after cancellation', async () => {
  const f = esh(), controller = new AbortController(), entered = deferred<void>(), late = deferred<Tool[]>();
  f.connection.listTools.mockImplementation(async () => { entered.resolve(); return late.promise; });
  const result = observe(f.hub.prepare({ target: 'esh', name: 'esh_status', arguments: {} }, controller.signal));
  await entered.promise; controller.abort(); await tick();
  expect(result.current()).toMatchObject({ state: 'rejected', error: { name: 'AbortError' } });
  expect(f.connection.listTools).toHaveBeenCalledExactlyOnceWith(controller.signal);
  late.resolve(eshTools); await result.settled;
  expect(result.current()).toMatchObject({ state: 'rejected' });
  expect(f.connection.call).toHaveBeenCalledExactlyOnceWith('esh_status', {}, { signal: controller.signal });
});

it('retains admitted delegation IDs as unknown when an immediate completion races caller cancellation', async () => {
  const controller = new AbortController();
  const receipt = {
    kind: 'delegated_task', tool: 'delegate_task', taskKey: 'fixture-task', task: 'Controlled admitted task', agent: 'fixture_agent',
    botId: 'a'.repeat(32), runId: 'b'.repeat(32), messageId: 'c'.repeat(32), eventId: 'fixture-event',
    duplicate: false, untrusted: true, status: 'succeeded', done: true, botStatus: 'running', summary: 'Fixture result',
  } as DelegatedTask;
  const run = vi.fn<ChatTool['run']>(async (_args, context) => {
    context.onDelegationAdmission?.(receipt);
    controller.abort();
    return receipt;
  });
  const tool: ChatTool = { name: 'delegate_task', description: 'Controlled admission fixture', inputSchema: { type: 'object' }, run };
  const tools = new OwnerBotTools({ tools: () => [tool] }, { owner: true, prompt: 'fixture', signal: controller.signal });
  const result = await tools.execute({ action: 'tool', tool: tool.name, args: { task_key: 'fixture-task' } });
  expect(result.result).toMatchObject({ state: 'unknown', done: false, status: 'unavailable', runId: receipt.runId, botId: receipt.botId, eventId: receipt.eventId, messageId: receipt.messageId });
  expect(tools.delegatedTasks).toEqual([expect.objectContaining({ done: false, status: 'unavailable', runId: receipt.runId })]);
  expect(tools.events.at(-1)).toMatchObject({ evidence: { status: 'failed' } });
  expect(run).toHaveBeenCalledOnce();
});
