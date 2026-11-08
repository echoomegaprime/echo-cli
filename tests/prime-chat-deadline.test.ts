import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SharedChat} from '../src/prime/chat.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore} from '../src/code/sessions.js';
import {DEFAULT_MODELS,ModelRouter} from '../src/code/model-factory.js';
import type {Action,Model} from '../src/code/model.js';
import {AdkClient,type AdkRunStatus} from '../src/prime/agents.js';
import {AutoAgents} from '../src/code/tools/autoagents.js';

const dirs:string[]=[],RUN='a'.repeat(32);
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});});
function fixture(model:Model){
 vi.useFakeTimers();
 const root=mkdtempSync(join(tmpdir(),'prime-chat-deadline-')),state=mkdtempSync(join(tmpdir(),'prime-chat-deadline-state-'));dirs.push(root,state);
 const models=new ModelRouter({...DEFAULT_MODELS}),info={...models.turn('qwen').info(),answered:true};
 vi.spyOn(models,'turn').mockReturnValue({model,answered:()=>info,info:()=>info});
 return {workspace:new Workspace(root,[state]),store:new SessionStore(state),models};
}
const request=()=>({requestId:randomUUID(),prompt:'Observe the bounded host deadline.'});

describe('host-configured SharedChat turn deadline',()=>{
 it.each([undefined,180000,300000])('propagates the %s/default deadline to the model using the existing cancellation path',async turnTimeoutMs=>{
  let reached!:()=>void,signal:AbortSignal|undefined;
  const entered=new Promise<void>(resolve=>{reached=resolve;});
  const model:Model={next:vi.fn(async(_messages,seen)=>{signal=seen;reached();return await new Promise<Action>(resolve=>seen!.addEventListener('abort',()=>resolve({action:'final',content:'Late answer must be ignored'}),{once:true}));})};
  const f=fixture(model),chat=new SharedChat({...f,...(turnTimeoutMs===undefined?{}:{turnTimeoutMs})}),pending=chat.submit(request());
  await entered;await vi.advanceTimersByTimeAsync((turnTimeoutMs??120000)-1);expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);expect(await pending).toMatchObject({status:'interrupted'});expect((await pending).answer).not.toContain('Late answer');
  expect(chat.status().busy).toBe(false);expect(model.next).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('allows a declared longer turn to complete and clears the remaining deadline timer',async()=>{
  const model:Model={next:vi.fn(async()=>await new Promise<Action>(resolve=>setTimeout(()=>resolve({action:'final',content:'Finished within the declared host limit.'}),150000)))};
  const f=fixture(model),chat=new SharedChat({...f,turnTimeoutMs:180000}),pending=chat.submit(request());
  await vi.advanceTimersByTimeAsync(150000);
  expect(await pending).toMatchObject({status:'completed',answer:'Finished within the declared host limit.'});expect(vi.getTimerCount()).toBe(0);
 });
 it('still cancels immediately on caller interruption before the configured deadline',async()=>{
  let reached!:()=>void,signal:AbortSignal|undefined;
  const entered=new Promise<void>(resolve=>{reached=resolve;});
  const model:Model={next:vi.fn(async(_messages,seen)=>{signal=seen;reached();return await new Promise<Action>(resolve=>seen!.addEventListener('abort',()=>resolve({action:'final',content:'Ignored'}),{once:true}));})};
  const f=fixture(model),chat=new SharedChat({...f,turnTimeoutMs:180000}),controller=new AbortController(),pending=chat.submit(request(),controller.signal);
  await entered;controller.abort();expect(await pending).toMatchObject({status:'interrupted'});expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });
 it('propagates expiry into an in-flight status read while retaining only the queried run ID',async()=>{
  let reached!:()=>void,readSignal:AbortSignal|undefined;
  const entered=new Promise<void>(resolve=>{reached=resolve;});
  const model:Model={next:vi.fn(async()=>({action:'tool',tool:'bot_run_status',args:{run_id:RUN,wait_ms:25000}}))};
  const f=fixture(model),adk=new AdkClient(),read=vi.spyOn(adk,'status').mockImplementation(async(_run,signal)=>{readSignal=signal;reached();return await new Promise<AdkRunStatus>(()=>{});});
  const chat=new SharedChat({...f,autoagents:new AutoAgents({adk}),turnTimeoutMs:1000}),pending=chat.submit(request());
  await entered;await vi.advanceTimersByTimeAsync(1000);const result=await pending;
  expect(result.status).toBe('interrupted');expect(readSignal?.aborted).toBe(true);expect(read).toHaveBeenCalledOnce();
  expect(result.tools?.events.find(event=>event.type==='tool_result')).toMatchObject({result:{kind:'bot_run',runId:RUN,status:'unavailable',done:false}});
  expect(result.delegatedTasks).toEqual([]);expect(vi.getTimerCount()).toBe(0);
 });
 it.each([null,'180000',0,999,300001,1000.5,NaN,Infinity])('rejects invalid host timeout %s at construction',turnTimeoutMs=>{
  const model:Model={next:vi.fn()},f=fixture(model);
  expect(()=>new SharedChat({...f,turnTimeoutMs} as ConstructorParameters<typeof SharedChat>[0])).toThrow(/turnTimeoutMs/);
  expect(model.next).not.toHaveBeenCalled();
 });
 it('rejects browser/model supplied deadline overrides before transmitting a prompt',async()=>{
  const model:Model={next:vi.fn()},f=fixture(model),chat=new SharedChat({...f,turnTimeoutMs:180000});
  await expect(chat.submit({...request(),turnTimeoutMs:300000})).rejects.toThrow('Invalid chat request');expect(model.next).not.toHaveBeenCalled();expect(f.store.list()).toEqual([]);
 });
});
