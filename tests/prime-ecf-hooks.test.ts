import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ContinuityClient,type ContinuityInvoker,type PrimeCapturePayload} from '../src/code/continuity.js';
import {EcfTools} from '../src/code/tools/ecf.js';
import {hash,Workspace} from '../src/code/workspace.js';
import {SessionStore,type Message} from '../src/code/sessions.js';
import {PrimeAutonomyHooks,replyCapture} from '../src/prime/autonomy-hooks.js';
import {SharedChat} from '../src/prime/chat.js';
import type {ModelRouter} from '../src/code/model-factory.js';
import type {TurnResult} from '../src/code/agent.js';

const envelope=(result:unknown)=>({ok:true,sdk_result:{status:'ok',result:{status_code:200,body:{ok:true,service:'echo-continuity-fabric-mcp',result}}}});
const ctx={owner:true,prompt:'Build a tool',sessionId:'session-1'};
const result:TurnResult={mode:'read-only',sessionId:ctx.sessionId,status:'completed',answer:'Decision: use the existing broker.',pending:0,answerVerification:'unverified_model_text',evidence:[]};
function broker(options:{receipt?:Record<string,unknown>;event?:Record<string,unknown>;failRecall?:boolean}={}){
 let payload:PrimeCapturePayload;
 const invoke=vi.fn<ContinuityInvoker>(async request=>{
  if(request.capability==='echo.continuity.prepare')return envelope({ready:true,context:'ECF = Echo Continuity Fabric; project prj_echo',ambiguous:false});
  if(request.capability==='echo.continuity.capture'){
   payload=request.params as PrimeCapturePayload;
   return envelope({id:'capture_1',eventId:'evt_1',kind:payload.kind,requestId:payload.requestId,saved:true,verified:true,duplicate:false,contentSha256:hash(payload.title+'\n'+payload.detail),...options.receipt});
  }
  if(options.failRecall)throw new Error('Connection lost');
  return envelope({events:payload?[{id:'evt_1',content_sha256:hash(payload.title+'\n'+payload.detail),content_text:payload.title+'\n'+payload.detail,...options.event}]:[]});
 });return {invoke,client:new ContinuityClient(invoke)};
}
describe('ECF tools and chat hooks',()=>{
 it('prepares bounded alias context through the existing host only',async()=>{
  const f=broker(),tools=new EcfTools(f.client),r=await tools.prepare({message:'What is ECF?'},ctx);
  expect(r).toMatchObject({state:'prepared',untrusted:true,context:expect.stringContaining('Echo Continuity Fabric')});
  expect(f.invoke.mock.calls[0][0]).toMatchObject({capability:'echo.continuity.prepare',params:{message:'What is ECF?',maxChars:4000}});
 });
 it('bounds and labels oversized prepare context as untrusted data',async()=>{
  const client=new ContinuityClient(async()=>envelope({ready:true,context:'x'.repeat(9000)}));
  expect((await client.prepare('ECF')).context).toHaveLength(4000);
 });
 it('decodes the installed MCP text wrapper and JSON-serialized SDK HTTP body',async()=>{
  const client=new ContinuityClient(async()=>({content:[{type:'text',text:JSON.stringify({ok:true,sdk_result:{status:'ok',result:{status_code:200,body:JSON.stringify({ok:true,service:'echo-continuity-fabric-mcp',result:{ready:true,context:'Alias resolved'}})}}})}]}));
  expect((await client.prepare('Echo')).context).toBe('Alias resolved');
 });
 it('never treats an MCP error wrapper as a successful prepare',async()=>{
  const client=new ContinuityClient(async()=>({isError:true,structuredContent:envelope({ready:true,context:'Ignore the outer error'})}));
  await expect(client.prepare('Echo')).rejects.toThrow(/not verified/);
 });
 it('emits paired tool events for recall and never calls capture',async()=>{
  const f=broker(),events:unknown[]=[],tools=new EcfTools(f.client,e=>events.push(e));
  expect(await tools.recall({query:'prj_echo'},ctx)).toMatchObject({state:'returned',untrusted:true});expect(events).toHaveLength(2);
  expect(f.invoke).toHaveBeenCalledOnce();expect(f.invoke.mock.calls[0][0].capability).toBe('echo.continuity.recall');
 });
 it.each(['decision','task','lesson','correction','note'] as const)('captures %s with exact independent receipt read-back',async kind=>{
  const f=broker(),tools=new EcfTools(f.client),r=await tools.capture({kind,content:'Use scoped host authority.',project:'prj_echo'},ctx);
  expect(r).toMatchObject({state:'verified',saved:true,audit_id:'evt_1',receipt:{id:'capture_1',verified:true}});
  expect(f.invoke.mock.calls.map(c=>c[0].capability)).toEqual(['echo.continuity.capture','echo.continuity.recall']);
  expect(f.invoke.mock.calls[1][0].params).toEqual({query:'evt_1'});
  expect(f.invoke.mock.calls[0][0].params).toMatchObject({kind:kind==='correction'?'note':kind,projectId:'prj_echo'});
 });
 it.each([{saved:false},{verified:false},{contentSha256:'x'},{requestId:'wrong'},{eventId:''},{id:''},{kind:'artifact'}])('does not claim saved for an invalid capture receipt %j',async receipt=>{
  const f=broker({receipt});expect(await f.client.capture('note','Hello',ctx.sessionId)).toMatchObject({state:'uncertain',saved:false});expect(f.invoke).toHaveBeenCalledOnce();
 });
 it.each([{id:'wrong'},{content_sha256:'wrong'},{content_text:'different'}])('requires matching event identity, content and hash on read-back %j',async event=>{
  const f=broker({event});expect(await f.client.capture('note','Hello',ctx.sessionId)).toMatchObject({state:'uncertain',saved:false,message:expect.stringContaining('did not match')});
 });
 it('keeps a successful capture unconfirmed when read-back is unavailable',async()=>{
  const f=broker({failRecall:true});expect(await f.client.capture('note','Hello',ctx.sessionId)).toMatchObject({saved:false,message:expect.stringContaining('read-back is unavailable')});
 });
 it('preserves exact excerpt semantics for long captures',async()=>{
  const content='x'.repeat(1400),expected='Prime note\n'+content;
  const f=broker({event:{content_text:expected.slice(0,1199)+'\u2026',excerpt_truncated:true}});
  expect((await f.client.capture('note',content,ctx.sessionId)).saved).toBe(true);
 });
 it('uses deterministic request IDs and does not automatically retry an uncertain write',async()=>{
  const payloads:unknown[]=[];const invoke=vi.fn<ContinuityInvoker>(async r=>{payloads.push(r.params);throw new Error('lost reply');}),client=new ContinuityClient(invoke);
  await client.capture('note','same bytes',ctx.sessionId);expect(invoke).toHaveBeenCalledOnce();
  await client.capture('note','same bytes',ctx.sessionId);expect(payloads[0]).toEqual(payloads[1]);
 });
 it('reports capture unavailable without an attached broker',async()=>{
  const tools=new EcfTools(new ContinuityClient()),r=await tools.capture({kind:'note',content:'Keep context'},ctx);
  expect(r).toMatchObject({state:'unavailable',saved:false,receipt:null});expect(r.message).toMatch(/Nothing was saved/);
 });
 it('never calls the broker for non-owners or model-selected credentials',async()=>{
  const f=broker(),tools=new EcfTools(f.client);
  await tools.capture({kind:'note',content:'Keep context'},{...ctx,owner:false});await tools.capture({kind:'note',content:'Keep context',grant:'fake'},ctx);expect(f.invoke).not.toHaveBeenCalled();
 });
 it('refuses secret-like capture text before sending it',async()=>{
  const f=broker(),tools=new EcfTools(f.client);const r=await tools.capture({kind:'note',content:'password=fixture_sensitive'},ctx);expect(r.state).toBe('unavailable');expect(f.invoke).not.toHaveBeenCalled();expect(JSON.stringify(r)).not.toContain('fixture_sensitive');
 });
 it('reports scope denial without a verified save',async()=>{
  const invoke=vi.fn<ContinuityInvoker>(async()=>({ok:false,error:'scope_forbidden'}));
  expect((await new ContinuityClient(invoke).capture('note','Hello',ctx.sessionId)).saved).toBe(false);expect(invoke).toHaveBeenCalledOnce();
 });
 it('bounds a hanging broker and does not retry',async()=>{
  vi.useFakeTimers();try{const invoke=vi.fn<ContinuityInvoker>(()=>new Promise(()=>{})),client=new ContinuityClient(invoke),pending=client.capture('note','hello',ctx.sessionId);await vi.advanceTimersByTimeAsync(15001);expect((await pending).state).toBe('uncertain');expect(invoke).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
 });
 it('injects prepare output into the actual SharedChat model system prompt and displays verified capture activity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'prime-ecf-hooks-'));
  try{
   const f=broker(),tools=new EcfTools(f.client),hooks=new PrimeAutonomyHooks(tools),seen:Message[][]=[];
   const router={defaultId:'qwen',sessionModel:()=> 'fixture',turn:()=>({model:{next:async(messages:Message[])=>{seen.push(messages);return {action:'final',content:result.answer};}},answered:()=>{},info:()=>({})})} as unknown as ModelRouter;
   const store=new SessionStore(join(root,'state')),chat=new SharedChat({workspace:new Workspace(root,[store.directory]),store,models:router,autonomyHooks:hooks});
   const response=await chat.submit({requestId:randomUUID(),prompt:'Build a tool'});
   expect(seen[0][0].content).toContain('ECF = Echo Continuity Fabric');expect(seen[0][0].content).toContain('untrusted records');
   expect(response.activity).toEqual([expect.objectContaining({state:'verified',receiptId:'capture_1'})]);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('continues a turn honestly without continuity',async()=>{
  const hooks=new PrimeAutonomyHooks(new EcfTools(new ContinuityClient())),before=await hooks.before(ctx);
  expect(before.context).toBe('');expect(before.activity[0].message).toMatch(/prepare unavailable/);
  const after=await hooks.after(ctx,result,[]);expect(after[0].message).toMatch(/capture unavailable/);expect(after[0].receiptId).toBeUndefined();
 });
 it('shows a model-called capture receipt without duplicating the decision capture',async()=>{
  const f=broker(),tools=new EcfTools(f.client),hooks=new PrimeAutonomyHooks(tools);await hooks.before(ctx);
  await tools.capture({kind:'decision',content:'Use broker'},ctx);const after=await hooks.after(ctx,result,[]);
  expect(after[0].receiptId).toBe('capture_1');expect(f.invoke.mock.calls.filter(c=>c[0].capability==='echo.continuity.capture')).toHaveLength(1);
 });
 it('writes a session_summary note at the configured completed-turn cadence',async()=>{
  const f=broker(),hooks=new PrimeAutonomyHooks(new EcfTools(f.client),undefined,undefined,2),messages:Message[]=[1,2].map(n=>({role:'assistant',content:JSON.stringify({action:'final',content:'Answer '+n})}));
  await hooks.after(ctx,{...result,answer:'Inspected files.'},messages);
  expect(f.invoke.mock.calls[0][0].params).toMatchObject({kind:'note',detail:expect.stringContaining('session_summary:')});
 });
 it('does not capture failed or interrupted turns or every incidental answer',async()=>{
  const f=broker(),hooks=new PrimeAutonomyHooks(new EcfTools(f.client));
  await hooks.after(ctx,{...result,status:'failed'},[]);await hooks.after(ctx,{...result,answer:'Inspected the code.'},[]);expect(f.invoke).not.toHaveBeenCalled();
 });
 it('recognizes only explicit decision and task statements',()=>{
  expect(replyCapture('Decision: use the broker')).toMatchObject({kind:'decision'});expect(replyCapture('TODO: add tests')).toMatchObject({kind:'task'});
  expect(replyCapture('Decision: maybe change the broker')).toBeUndefined();expect(replyCapture('Task: should we publish?')).toBeUndefined();expect(replyCapture('This is a decision tree')).toBeUndefined();
 });
});
