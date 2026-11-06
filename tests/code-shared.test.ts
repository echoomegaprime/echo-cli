import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import { runSharedTurn, type CodingInvoker } from '../src/code/shared.js';

const admission = { contractSha256: 'a'.repeat(64), admissionId: 'review-fixture' };
const contract = { ok: true, service: 'echo-core', contract: 'echo-code/v1', ...admission,
  enabled: true, model: 'qwen2.5-coder:7b', requiredScope: 'coding.invoke',
  execution: 'inference_only', modes: ['read-only', 'propose'], defaultMode: 'read-only',
  maxContextBytes: 98304, maxTokens: 2048, deadlineSeconds: 30, paidFallback: false,
  automaticMemory: false, toolsExecutedBy: 'client', sessionDurability: 'client',
  cancellation: 'best_effort', requestIdSemantics: 'correlation_only_no_automatic_retry' };
function envelope(body: unknown) {
  return { ok: true, sdk_result: { status: 'ok', result: { status_code: 200, body } } };
}
async function fixture(run: (f: { root: string; workspace: Workspace; store: SessionStore; sessionId: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'echo-shared-'));
  const state = mkdtempSync(join(tmpdir(), 'echo-shared-state-'));
  try {
    writeFileSync(join(root,'a.ts'),'export const value = 1;\n');
    const workspace = new Workspace(root), store = new SessionStore(state);
    const sessionId = store.create(root,'qwen2.5-coder:7b').id;
    await run({root,workspace,store,sessionId});
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(state,{recursive:true,force:true}); }
}
function broker(actions: unknown[], mutate?: (body: Record<string, unknown>) => void) {
  return vi.fn<CodingInvoker>(async r => {
    if (r.capability === 'echo.core.coding.contract') return envelope(contract);
    const p = r.params;
    const body: Record<string, unknown> = { ok: true, service: 'echo-core',
      contract: 'echo-code/v1', contractSha256: admission.contractSha256,
      model: contract.model, sessionId: p.sessionId, requestId: p.requestId,
      workspaceId: p.workspaceId, mode: p.mode, action: actions.shift(),
      execution: 'inference_only', sourceWritten: false, memoryWritten: false,
      answerVerification: 'unverified_model_text' };
    mutate?.(body); return envelope(body);
  });
}
describe('admitted shared coding client', () => {
  it('runs existing grounded file tools with pinned identity and flat SDK params', async () => fixture(async f => {
    const invoke = broker([{action:'read',path:'a.ts'},{action:'final',content:'a.ts defines value.'}]);
    const result = await runSharedTurn({...f,invoke,admission,prompt:'Inspect a.ts'});
    expect(result.status).toBe('completed'); expect(result.evidence[0].path).toBe('a.ts');
    const requests = invoke.mock.calls.map(c => c[0]);
    expect(requests.map(r=>r.capability)).toEqual(['echo.core.coding.contract','echo.core.coding.step','echo.core.coding.step']);
    const first = requests[1].params, second = requests[2].params;
    expect(first.sessionId).toBe(f.sessionId); expect(first.mode).toBe('read-only');
    expect(first.workspaceId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.options).toBeUndefined();
    expect((first.messages as {role:string}[]).every(m=>m.role!=='system')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(f.root);
  }));
  it('requires a pinned admission before calling the broker', async () => fixture(async f => {
    const invoke=broker([]);
    await expect(runSharedTurn({...f,invoke,admission:{...admission,contractSha256:''},prompt:'inspect'})).rejects.toThrow('admission');
    expect(invoke).not.toHaveBeenCalled();
  }));
  it.each([
    {enabled:false},{contractSha256:'b'.repeat(64)},{admissionId:'other'},
    {model:'paid'},{paidFallback:true},{automaticMemory:true},{deadlineSeconds:120},
    {toolsExecutedBy:'server'},{sessionDurability:'server'}
  ])('rejects unapproved policy %j before sending source', async change => fixture(async f => {
    const invoke=vi.fn<CodingInvoker>(async()=>envelope({...contract,...change}));
    await expect(runSharedTurn({...f,invoke,admission,prompt:'inspect'})).rejects.toThrow('contract');
    expect(invoke).toHaveBeenCalledTimes(1);
  }));
  it('returns a fixed scope denial without raw provider content', async () => fixture(async f => {
    const invoke=vi.fn<CodingInvoker>(async()=>({ok:false,error:'scope_forbidden',body:'PRIVATE KEY TEXT'}));
    await expect(runSharedTurn({...f,invoke,admission,prompt:'inspect'})).rejects.toThrow('coding.invoke');
    expect(invoke).toHaveBeenCalledTimes(1);
  }));
  it.each([
    {sessionId:'wrong'}, {workspaceId:'wrong'}, {requestId:'wrong'}, {mode:'propose'},
    {sourceWritten:true}, {memoryWritten:true}, {contractSha256:'b'.repeat(64)},
    {action:{action:'shell',command:'whoami'}},
    {action:{action:'read',path:'../a.ts'}}, {action:{action:'read',path:'C:/a.ts'}},
    {action:{action:'read',path:'sub\\a.ts'}}
  ])('rejects mismatched response %j before tools execute', async change => fixture(async f => {
    const invoke=broker([{action:'read',path:'a.ts'}], body=>Object.assign(body,change));
    const result=await runSharedTurn({...f,invoke,admission,prompt:'inspect'});
    expect(result.status).toBe('failed'); expect(result.evidence).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  }));
  it('refuses a proposal in read-only mode', async () => fixture(async f => {
    const invoke=broker([{action:'propose',path:'a.ts',content:'changed'}]);
    const result=await runSharedTurn({...f,invoke,admission,prompt:'inspect'});
    expect(result.status).toBe('failed'); expect(result.pending).toBe(0);
    expect(readFileSync(join(f.root,'a.ts'),'utf8')).toContain('value = 1');
  }));
  it('proposal mode still reads first and stages hash-bound approval', async () => fixture(async f => {
    const invoke=broker([{action:'read',path:'a.ts'},{action:'propose',path:'a.ts',content:'export const value = 2;\n'}]);
    const result=await runSharedTurn({...f,invoke,admission,mode:'propose',prompt:'change'});
    expect(result.status).toBe('pending_approval'); expect(result.pending).toBe(1);
    expect(readFileSync(join(f.root,'a.ts'),'utf8')).toContain('value = 1');
  }));
  it('cancels the host invocation and does not retry', async () => fixture(async f => {
    const controller=new AbortController();
    let observed: AbortSignal | undefined;
    const invoke=vi.fn<CodingInvoker>(async r=>{
      if(r.capability==='echo.core.coding.contract') return envelope(contract);
      observed=r.signal;
      controller.abort();
      return new Promise(()=>{});
    });
    const result=await runSharedTurn({...f,invoke,admission,signal:controller.signal,prompt:'inspect'});
    expect(result.status).toBe('interrupted'); expect(observed?.aborted).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  }));
});
