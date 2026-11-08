import {afterEach,describe,expect,it,vi} from 'vitest';
import {AdkClient,AdkError,type AdkRunStatus} from '../src/prime/agents.js';
import {AutoAgents,type ToolContext} from '../src/code/tools/autoagents.js';

const RUN='a'.repeat(32),PROOF='b'.repeat(64);
const ctx:ToolContext={owner:true,prompt:'Gather the existing worker result.',sessionId:'parent-session',requestId:'parent-request'};
const pending=(status='running'):AdkRunStatus=>({runId:RUN,status,done:false,steps:[],spent:{calls:1,cost_usd:0,wall_s:2}});
const finished=():AdkRunStatus=>({...pending('done'),done:true,steps:[{kind:'final',ok:true,data:{text:'Delayed worker evidence'}}],proof:{run_id:RUN,verdict:'PASS',events_sha256:PROOF}});
const network=()=>vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network operation in read-only unit test'));
function fixture(){
 vi.useFakeTimers();
 const fetch=network(),adk=new AdkClient(),status=vi.spyOn(adk,'status'),auto=new AutoAgents({adk});
 return {auto,status,fetch};
}
afterEach(()=>{expect(vi.mocked(globalThis.fetch).mock.calls).toEqual([]);vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('bounded read-only bot result waiting',()=>{
 it.each([undefined,0])('keeps wait_ms=%s as one immediate read with unchanged error propagation',async wait_ms=>{
  const f=fixture(),controller=new AbortController();f.status.mockResolvedValueOnce(pending()).mockRejectedValueOnce(new AdkError(404,'Run is absent','not_found'));
  const args={run_id:RUN,...(wait_ms===undefined?{}:{wait_ms})};
  expect(await f.auto.runStatus(args,{...ctx,signal:controller.signal})).toMatchObject({kind:'bot_run',runId:RUN,status:'running',done:false});
  expect(f.status).toHaveBeenCalledExactlyOnceWith(RUN,controller.signal);
  await expect(f.auto.runStatus(args,ctx)).rejects.toMatchObject({status:404,code:'not_found'});
  expect(f.status).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
 it('waits for delayed terminal output/proof without consuming a second parent call and reads afresh next time',async()=>{
  const f=fixture(),started=Date.now();
  f.status.mockImplementation(async()=>Date.now()-started<1250?pending():finished());
  const result=f.auto.runStatus({run_id:RUN,wait_ms:5000},ctx);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toMatchObject({kind:'bot_run',runId:RUN,status:'done',done:true,output:'Delayed worker evidence',proof:{events_sha256:PROOF},untrusted:true});
  expect(f.status).toHaveBeenCalledTimes(4);expect(vi.getTimerCount()).toBe(0);
  f.status.mockResolvedValueOnce({...pending('failed'),done:true,error:{code:'budget_exceeded',message:'Limit reached'}});
  expect(await f.auto.runStatus({run_id:RUN,wait_ms:5000},ctx)).toMatchObject({status:'failed',done:true,error:{code:'budget_exceeded'}});
  expect(f.status).toHaveBeenCalledTimes(5);expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['done','failed','gated'])('returns an already %s run without sleeping',async status=>{
  const f=fixture();f.status.mockResolvedValue({...pending(status),done:true});
  expect(await f.auto.runStatus({run_id:RUN,wait_ms:25000},ctx)).toMatchObject({runId:RUN,status,done:true});
  expect(f.status).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['queued','running'])('returns the latest %s snapshot honestly at the bounded deadline',async status=>{
  const f=fixture();f.status.mockResolvedValue(pending(status));
  const result=f.auto.runStatus({run_id:RUN,wait_ms:1200},ctx);
  await vi.advanceTimersByTimeAsync(1200);
  expect(await result).toMatchObject({runId:RUN,status,done:false,waitExpired:true});
  expect(await result).not.toHaveProperty('error');expect(await result).not.toHaveProperty('proof');
  expect(f.status).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);expect(f.status).toHaveBeenCalledTimes(3);
 });
 it.each([1000,25000])('bounds a transport that ignores cancellation at %s ms and never accepts a late terminal result',async wait_ms=>{
  const f=fixture();let finish!:(run:AdkRunStatus)=>void;let signal:AbortSignal|undefined;
  f.status.mockImplementation(async(_run,seen)=>{signal=seen;return await new Promise<AdkRunStatus>(resolve=>{finish=resolve;});});
  const result=f.auto.runStatus({run_id:RUN,wait_ms},ctx);
  await vi.advanceTimersByTimeAsync(wait_ms);
  expect(await result).toMatchObject({runId:RUN,status:'unavailable',done:false,error:{code:'status_unavailable'}});
  expect(signal?.aborted).toBe(true);expect(await result).not.toHaveProperty('output');expect(await result).not.toHaveProperty('proof');
  finish(finished());await vi.advanceTimersByTimeAsync(1000);
  expect(f.status).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['read','sleep'])('cancels during %s with the queried ID, no stale result and no later polling',async stage=>{
  const f=fixture(),controller=new AbortController();
  f.status.mockImplementation(async()=>stage==='read'?await new Promise<AdkRunStatus>(()=>{}):pending());
  const result=f.auto.runStatus({run_id:RUN,wait_ms:5000},{...ctx,signal:controller.signal});
  await vi.advanceTimersByTimeAsync(100);controller.abort();
  expect(await result).toMatchObject({runId:RUN,status:'unavailable',done:false,error:{code:'interrupted'}});
  expect(await result).not.toHaveProperty('proof');expect(await result).not.toHaveProperty('output');
  await vi.advanceTimersByTimeAsync(10000);expect(f.status).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('stops on an actual read failure and retains the run ID without claiming prior output or retrying',async()=>{
  const f=fixture();f.status.mockResolvedValueOnce(pending()).mockRejectedValueOnce(new AdkError(503,'Run status service is unavailable','unavailable'));
  const result=f.auto.runStatus({run_id:RUN,wait_ms:5000},ctx);
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toMatchObject({runId:RUN,status:'unavailable',done:false,error:{code:'status_unavailable',message:'Run status service is unavailable'}});
  expect(await result).not.toHaveProperty('proof');expect(await result).not.toHaveProperty('output');
  await vi.advanceTimersByTimeAsync(10000);expect(f.status).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
 it.each([-1,25001,1.5,'1000',null,Infinity,NaN])('refuses invalid wait %s before any read',async wait_ms=>{
  const f=fixture();await expect(f.auto.runStatus({run_id:RUN,wait_ms},ctx)).rejects.toMatchObject({status:400,code:'invalid'});expect(f.status).not.toHaveBeenCalled();
 });
 it('checks host owner admission and pre-cancellation before reading',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await expect(f.auto.runStatus({run_id:RUN,wait_ms:1000},{...ctx,owner:false})).rejects.toMatchObject({status:403});
  await expect(f.auto.runStatus({run_id:RUN,wait_ms:1000},{...ctx,signal:controller.signal})).rejects.toMatchObject({code:'interrupted'});
  expect(f.status).not.toHaveBeenCalled();
 });
 it('advertises bounded optional waiting on the read-only status tool',()=>{
  const f=fixture(),tool=f.auto.tools().find(item=>item.name==='bot_run_status')!;
  expect(tool.readOnly).toBe(true);
  expect(tool.inputSchema).toMatchObject({required:['run_id'],properties:{wait_ms:{type:'integer',minimum:0,maximum:25000}}});
 });
});
