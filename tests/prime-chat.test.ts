import {expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {SharedChat} from '../src/prime/chat.js';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore} from '../src/code/sessions.js';
import type {CodingInvoker} from '../src/code/shared.js';

const admission={contractSha256:'a'.repeat(64),admissionId:'prime-test-only'};
const contract={ok:true,service:'echo-core',contract:'echo-code/v1',...admission,
 enabled:true,model:'qwen2.5-coder:7b',requiredScope:'coding.invoke',execution:'inference_only',
 modes:['read-only','propose'],defaultMode:'read-only',maxContextBytes:98304,maxTokens:2048,
 deadlineSeconds:30,paidFallback:false,automaticMemory:false,toolsExecutedBy:'client',
 sessionDurability:'client',cancellation:'best_effort',requestIdSemantics:'correlation_only_no_automatic_retry'};
const envelope=(body:unknown)=>({ok:true,sdk_result:{status:'ok',result:{status_code:200,body}}});
function broker(actions:unknown[]){return vi.fn<CodingInvoker>(async r=>r.capability==='echo.core.coding.contract'?envelope(contract):envelope({
 ok:true,service:'echo-core',contract:'echo-code/v1',...admission,model:contract.model,
 sessionId:r.params.sessionId,requestId:r.params.requestId,workspaceId:r.params.workspaceId,mode:r.params.mode,
 action:actions.shift(),execution:'inference_only',sourceWritten:false,memoryWritten:false,answerVerification:'unverified_model_text',
}));}
async function fixture(run:(f:{root:string;store:SessionStore;workspace:Workspace;ui:string})=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'prime-chat-')),state=mkdtempSync(join(tmpdir(),'prime-state-'));
 try{writeFileSync(join(root,'info.txt'),'calibration=714\n');writeFileSync(join(root,'index.html'),'Prime');
  await run({root,store:new SessionStore(state),workspace:new Workspace(root,[state]),ui:root});
 }finally{rmSync(root,{recursive:true,force:true});rmSync(state,{recursive:true,force:true});}
}
it('round trips authenticated HTTP chat through shared read-only tools and resumes its durable session',async()=>fixture(async f=>{
 const invoke=broker([{action:'read',path:'info.txt'},{action:'final',content:'info.txt: calibration 714.'},{action:'final',content:'Still 714.'}]);
 const chat=new SharedChat({...f,invoke,admission}),s=await startPrimeServer(new PrimeHub({capabilities:[],chat}),f.ui,0);
 try{
  const page=await fetch(s.url),cookie=page.headers.get('set-cookie')!.split(';')[0];
  const headers={cookie,origin:s.url,'x-prime-request':'1','content-type':'application/json'};
  const send=(data:unknown,h=headers)=>fetch(s.url+'/api/chat',{method:'POST',headers:h,body:JSON.stringify(data)});
  const data={requestId:randomUUID(),prompt:'Read info.txt.'};
  expect((await send(data,{...headers,cookie:''})).status).toBe(403);
  expect((await send(data,{...headers,origin:'https://attacker.example'})).status).toBe(403);
  expect(invoke).not.toHaveBeenCalled();
  const response=await send(data);expect(response.status).toBe(200);const result=await response.json();
  expect(result).toMatchObject({requestId:data.requestId,status:'completed',mode:'read-only',pending:0,answer:'info.txt: calibration 714.',answerVerification:'unverified_model_text'});
  expect(result.evidence[0]).toMatchObject({path:'info.txt',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect((await send(data)).status).toBe(400);expect(invoke).toHaveBeenCalledTimes(3);
  // A new host adapter can resume the existing store, without creating a second engine.
  const resumed=new SharedChat({...f,invoke,admission});
  const again=await resumed.submit({requestId:randomUUID(),prompt:'And now?',sessionId:result.sessionId});
  expect(again.sessionId).toBe(result.sessionId);expect(again.answer).toBe('Still 714.');
  expect(f.store.get(result.sessionId).messages.some(m=>m.content==='Read info.txt.')).toBe(true);
  expect(readFileSync(join(f.root,'info.txt'),'utf8')).toBe('calibration=714\n');
 }finally{await s.close();}
}));
it('fails closed without an attached owner, and never sends browser policy overrides',async()=>fixture(async f=>{
 const invoke=broker([]),chat=new SharedChat({...f,invoke,admission});
 for(const change of [{mode:'propose'},{workspace:'other'},{admission},{invoke:'other'},{requestId:'bad'},{prompt:' '},{prompt:'x'.repeat(12001)}]){
  await expect(chat.submit({requestId:randomUUID(),prompt:'inspect',...change})).rejects.toThrow();
 }
 expect(invoke).not.toHaveBeenCalled();expect(f.store.list()).toEqual([]);
 const hub=new PrimeHub({capabilities:[]});
 await expect(hub.chat({requestId:randomUUID(),prompt:'inspect'})).rejects.toThrow('not connected');
 expect((await hub.status()).chat.state).toBe('disconnected');
}));
it('keeps scope denial and mismatched sessions ahead of prompt transmission',async()=>fixture(async f=>{
 const invoke=vi.fn<CodingInvoker>(async()=>({ok:false,error:'scope_forbidden',body:'PRIVATE OWNER BODY'}));
 const chat=new SharedChat({...f,invoke,admission});
 await expect(chat.submit({requestId:randomUUID(),prompt:'PRIVATE PROMPT'})).rejects.toThrow('coding.invoke');
 expect(JSON.stringify(invoke.mock.calls)).not.toContain('PRIVATE PROMPT');
 expect(f.store.list().every(s=>f.store.get(s.id).messages.length===0)).toBe(true);
 const wrong=f.store.create(f.root,'other-model');
 await expect(chat.submit({requestId:randomUUID(),prompt:'inspect',sessionId:wrong.id})).rejects.toThrow('mismatch');
 expect(invoke).toHaveBeenCalledTimes(1);
}));
it('aborts the existing transport, excludes overlapping turns and refuses request replay',async()=>fixture(async f=>{
 let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let remoteSignal:AbortSignal|undefined;
 const invoke=vi.fn<CodingInvoker>(async r=>{remoteSignal=r.signal;entered();return new Promise(()=>{});});
 const chat=new SharedChat({...f,invoke,admission}),abort=new AbortController(),request={requestId:randomUUID(),prompt:'inspect'};
 const pending=chat.submit(request,abort.signal);await Promise.race([ready,pending.then(()=>{},()=>{})]);
 await expect(chat.submit({requestId:randomUUID(),prompt:'parallel'})).rejects.toThrow('busy');
 abort.abort();await expect(pending).rejects.toThrow('Interrupted');expect(remoteSignal!.aborted).toBe(true);
 await expect(chat.submit(request)).rejects.toThrow('already');expect(invoke).toHaveBeenCalledTimes(1);
}));
it('propagates an HTTP client disconnect to the admitted transport',async()=>fixture(async f=>{
 let entered!:()=>void,aborted!:()=>void;
 const ready=new Promise<void>(r=>entered=r),cancelled=new Promise<void>(r=>aborted=r);
 const invoke: CodingInvoker=async r=>{r.signal.addEventListener('abort',()=>aborted(),{once:true});entered();return new Promise(()=>{});};
 const chat=new SharedChat({...f,invoke,admission}),s=await startPrimeServer(new PrimeHub({capabilities:[],chat}),f.ui,0);
 try{
  const page=await fetch(s.url),cookie=page.headers.get('set-cookie')!.split(';')[0];
  const client=request(s.url+'/api/chat',{method:'POST',headers:{cookie,origin:s.url,'x-prime-request':'1','content-type':'application/json'}});
  client.on('error',()=>{});client.end(JSON.stringify({requestId:randomUUID(),prompt:'inspect'}));
  await ready;client.destroy();await cancelled;
  await vi.waitFor(()=>expect(chat.status().busy).toBe(false));
 }finally{await s.close();}
}));
