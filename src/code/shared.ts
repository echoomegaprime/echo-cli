import { randomUUID } from 'node:crypto';
import { runTurn, type TurnOptions, type TaskMode } from './agent.js';
import { hash, redact } from './workspace.js';
import type { Action, Model } from './model.js';
import type { Message } from './sessions.js';

export interface CodingAdmission { contractSha256: string; admissionId: string }
export type CodingInvoker = (request: {
  capability: 'echo.core.coding.contract' | 'echo.core.coding.step';
  params: Record<string, unknown>; reason: string; signal: AbortSignal;
}) => Promise<unknown>;
export type SharedTurnOptions = Omit<TurnOptions, 'model'> & {
  /** Supplied by the authenticated host; no key discovery or alternate account. */
  invoke: CodingInvoker;
  /** Pinned by the host's real owner admission, never taken from model text. */
  admission: CodingAdmission;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function call(invoke: CodingInvoker, capability: Parameters<CodingInvoker>[0]['capability'],
  params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response: unknown = await new Promise((resolve, reject) => {
    const controller = new AbortController(); let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { controller.abort(); finish(new Error('Interrupted')); };
    const timer = setTimeout(() => { controller.abort(); finish(new Error('Shared coding transport timed out; no retry was made')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Interrupted');
      return invoke({ capability, params, signal: controller.signal,
        reason: 'ECHO Code admitted bounded inference; no server tools, source edits or memory writes.' });
    }).then(value => finish(undefined,value), () => finish(new Error('Shared coding transport unavailable; no fallback was used')));
  });
  let reply: Record<string, unknown>;
  try {
    if (Buffer.byteLength(JSON.stringify(response)) > 400000) throw new Error();
    reply = record(response);
  } catch { throw new Error('Shared coding response is invalid or oversized'); }
  if (reply.error === 'scope_forbidden') throw new Error('Shared coding requires coding.invoke on the existing host connection');
  const sdk = record(reply.sdk_result), result = record(sdk.result), body = record(result.body);
  if (reply.ok !== true || sdk.status !== 'ok' || result.status_code !== 200 || body.ok !== true)
    throw new Error('Shared coding response not verified; no tools were executed');
  return body;
}
function validateContract(c: Record<string, unknown>, expected: CodingAdmission): number {
  if (c.service !== 'echo-core' || c.contract !== 'echo-code/v1' || c.enabled !== true ||
      c.contractSha256 !== expected.contractSha256 || c.admissionId !== expected.admissionId ||
      c.model !== 'qwen2.5-coder:7b' || c.requiredScope !== 'coding.invoke' ||
      c.execution !== 'inference_only' || JSON.stringify(c.modes) !== '["read-only","propose"]' ||
      c.defaultMode !== 'read-only' || c.maxContextBytes !== 98304 || c.maxTokens !== 2048 ||
      c.paidFallback !== false || c.automaticMemory !== false || c.toolsExecutedBy !== 'client' ||
      c.sessionDurability !== 'client' || c.cancellation !== 'best_effort' ||
      c.requestIdSemantics !== 'correlation_only_no_automatic_retry' ||
      typeof c.deadlineSeconds !== 'number' || !Number.isInteger(c.deadlineSeconds) ||
      c.deadlineSeconds < 1 || c.deadlineSeconds > 60)
    throw new Error('Shared coding contract is not the pinned admitted policy');
  return (c.deadlineSeconds + 10) * 1000;
}
function action(value: unknown, mode: TaskMode): Action {
  const a = record(value);
  const shapes: Record<string, string[]> = {
    list: ['action','path'], read: ['action','path'], search: ['action','query'],
    final: ['action','content'], ...(mode === 'propose' ? { propose: ['action','path','content'] } : {}),
  };
  const fields = typeof a.action === 'string' ? shapes[a.action] : undefined;
  if (!fields || Object.keys(a).length !== fields.length || fields.some(k => typeof a[k] !== 'string'))
    throw new Error('Shared coding action refused');
  if (typeof a.path === 'string' && (!a.path || a.path.length > 240 || (a.path.includes('\\') || a.path.includes(':') || [...a.path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) ||
      a.path.startsWith('/') || a.path.split('/').includes('..'))) throw new Error('Shared coding path refused');
  if (typeof a.query === 'string' && (!a.query || a.query.length > 200)) throw new Error('Shared coding query refused');
  if (typeof a.content === 'string' && (!a.content.trim() || Buffer.byteLength(a.content) > 65536))
    throw new Error('Shared coding content refused');
  if (a.action === 'list' || a.action === 'read') return { action: a.action, path: a.path as string };
  if (a.action === 'search') return { action: 'search', query: a.query as string };
  if (a.action === 'propose') return { action: 'propose', path: a.path as string, content: redact(a.content as string) };
  return { action: 'final', content: redact(a.content as string) };
}
/** Host entrypoint. The existing runTurn still owns tools, evidence, sessions and
 * explicit file approval. Discovery is required before any workspace text is sent.
 * No CLI credential loader, auto-grant, retry, scheduler or provider fallback. */
export async function runSharedTurn(options: SharedTurnOptions) {
  const { invoke, admission, ...turn } = options;
  if (typeof invoke !== 'function' || !admission || !/^[0-9a-f]{64}$/.test(admission.contractSha256) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(admission.admissionId))
    throw new Error('Shared coding needs an authenticated host and pinned owner admission');
  // Copy admission so a host mutation during an await cannot change the pinned policy.
  const pinned = { ...admission }, mode = turn.mode ?? 'read-only';
  if (mode !== 'read-only' && mode !== 'propose') throw new Error('Invalid task mode');
  const workspaceId = hash(turn.workspace.root), sessionId = turn.sessionId;
  const contract = await call(invoke,'echo.core.coding.contract',{command:'contract'},10000,turn.signal);
  const timeoutMs = validateContract(contract,pinned);
  const model: Model = { async next(messages: Message[], signal?: AbortSignal) {
    // Only runTurn's leading instruction is omitted; later system-role messages
    // indicate corrupt/untrusted history and must not cross the owner boundary.
    if (messages[0]?.role !== 'system') throw new Error('Shared coding needs the trusted turn boundary');
    const history = messages.slice(1);
    if (!history.length || history.length > 50 || history.some(m => !['user','assistant'].includes(m.role) ||
        typeof m.content !== 'string' || !m.content) ||
        history.reduce((n,m)=>n+Buffer.byteLength(m.content),0) > 98304)
      throw new Error('Shared coding context exceeds the admitted contract');
    const requestId = randomUUID();
    const body = await call(invoke,'echo.core.coding.step',{
      command:'step', contract:'echo-code/v1', contractSha256:pinned.contractSha256,
      sessionId, requestId, workspaceId, mode, messages:history, maxTokens:2048,
    },timeoutMs,signal);
    if (body.service !== 'echo-core' || body.contract !== 'echo-code/v1' ||
        body.contractSha256 !== pinned.contractSha256 || body.model !== 'qwen2.5-coder:7b' ||
        body.sessionId !== sessionId || body.requestId !== requestId ||
        body.workspaceId !== workspaceId || body.mode !== mode || body.execution !== 'inference_only' ||
        body.sourceWritten !== false || body.memoryWritten !== false ||
        body.answerVerification !== 'unverified_model_text')
      throw new Error('Shared coding response identity or policy mismatch');
    return action(body.action,mode);
  }};
  return runTurn({...turn,mode,model});
}
