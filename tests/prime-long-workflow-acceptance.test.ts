import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Command} from 'commander';
import {randomUUID} from 'node:crypto';
import {createServer,request,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clearTimeout as realClearTimeout,setTimeout as realSetTimeout} from 'node:timers';
import {runInNewContext} from 'node:vm';
import {registerPrimeCommands} from '../src/prime/commands.js';
import * as serverModule from '../src/prime/server.js';
import {SharedChat} from '../src/prime/chat.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore,type Message} from '../src/code/sessions.js';
import {DEFAULT_MODELS,ModelRouter} from '../src/code/model-factory.js';
import type {Action,Model} from '../src/code/model.js';
import {AutoAgents} from '../src/code/tools/autoagents.js';
import {PersonalityForge,type Selection} from '../src/prime/personality.js';

const directories:string[]=[],modelServers:Server[]=[];
const primeServers:Awaited<ReturnType<typeof serverModule.startPrimeServer>>[]=[];
const signals=['SIGINT','SIGTERM'] as const;
const allowedOrigins=new Set<string>();
const browserSource=readFileSync(new URL('../ui/echo-prime/chat.js',import.meta.url),'utf8');
let originalListeners:Map<(typeof signals)[number],Set<(...args:unknown[])=>void>>;

beforeEach(()=>{
 originalListeners=new Map(signals.map(name=>[name,new Set(process.listeners(name))]));
 const start=serverModule.startPrimeServer;
 vi.spyOn(serverModule,'startPrimeServer').mockImplementation(async(...args)=>{
  const server=await start(...args);primeServers.push(server);allowedOrigins.add(server.url);return server;
 });
 const realFetch=globalThis.fetch;
 // Both the browser adapter and the real LocalModel use HTTP. Any endpoint
 // except the test-owned listeners is an error; no paid/production model runs.
 vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(!allowedOrigins.has(url.origin))throw new Error('Acceptance fixture refused an unowned network origin');
  return realFetch(input,init);
 });
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
});
afterEach(async()=>{
 // Restore the real clock before socket cleanup; request timers are tested
 // under virtual time, while the fixture's HTTP I/O uses actual loopback.
 vi.clearAllTimers();vi.useRealTimers();
 for(const server of modelServers.splice(0))await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
 for(const server of primeServers.splice(0))await server.close();
 for(const name of signals)for(const listener of process.listeners(name))if(!originalListeners.get(name)!.has(listener))process.removeListener(name,listener);
 vi.restoreAllMocks();allowedOrigins.clear();
 directories.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}));
});

function bounded<T>(pending:Promise<T>,what:string):Promise<T>{
 return new Promise((resolve,reject)=>{
  const timer=realSetTimeout(()=>reject(new Error('Acceptance fixture did not observe '+what)),2000);
  pending.then(value=>{realClearTimeout(timer);resolve(value);},error=>{realClearTimeout(timer);reject(error);});
 });
}
function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(done=>{resolve=done;});
 return {promise,resolve};
}
interface ModelCall {body:{model:string;messages:Message[]};closed:Promise<void>;respond:(action:Action)=>void}
async function localModel(){
 const calls:ModelCall[]=[],arrivals=new Map<number,ReturnType<typeof deferred<ModelCall>>>();
 const server=createServer((req,res)=>{
  const chunks:Buffer[]=[];
  req.on('data',chunk=>chunks.push(Buffer.from(chunk)));
  req.on('end',()=>{
   if(req.method!=='POST'||req.url!=='/api/chat'){res.writeHead(404);res.end();return;}
   const closed=deferred<void>();
   res.once('close',()=>closed.resolve());
   const call:ModelCall={body:JSON.parse(Buffer.concat(chunks).toString('utf8')),closed:closed.promise,
    respond(action){if(!res.destroyed){res.setHeader('content-type','application/json');res.end(JSON.stringify({done:true,model:DEFAULT_MODELS.model,message:{content:JSON.stringify(action)}}));}}};
   calls.push(call);arrivals.get(calls.length)?.resolve(call);
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));modelServers.push(server);
 const url='http://127.0.0.1:'+(server.address() as AddressInfo).port;allowedOrigins.add(url);
 return {url,calls,arrival(number:number){
  if(calls[number-1])return Promise.resolve(calls[number-1]);
  if(!arrivals.has(number))arrivals.set(number,deferred<ModelCall>());
  return bounded(arrivals.get(number)!.promise,'model request '+number);
 }};
}
async function cli(turnTimeoutMs:number){
 const endpoint=await localModel(),root=mkdtempSync(join(tmpdir(),'prime-long-workflow-'));directories.push(root);
 const workspace=join(root,'workspace'),state=join(root,'state'),config=join(root,'prime.json');mkdirSync(workspace);
 writeFileSync(join(workspace,'info.txt'),'calibration=714\n');
 writeFileSync(config,JSON.stringify({models:{endpoint:endpoint.url},chat:{turnTimeoutMs}}));
 const command=new Command().exitOverride();registerPrimeCommands(command);
 await command.parseAsync(['prime','--config',config,'--port','0','--code-workspace',workspace,'--code-state-dir',state],{from:'user'});
 expect(primeServers).toHaveLength(1);
 const url=primeServers[0].url,page=await fetch(url),cookie=page.headers.get('set-cookie')!.split(';')[0];await page.arrayBuffer();
 const headers={cookie,origin:url,'x-prime-request':'1','content-type':'application/json'};
 const status=async()=>{
  const response=await fetch(url+'/api/status',{headers});expect(response.status).toBe(200);return response.json();
 };
 expect((await status()).chat).toMatchObject({state:'attached',routing:true,turnTimeoutMs});
 expect(endpoint.calls).toEqual([]);
 return {endpoint,url,headers,status,state,workspace};
}
function browser(url:string,headers:Record<string,string>){
 function element(){
  const listeners=new Map<string,()=>void>();
  return {textContent:'',className:'',hidden:false,disabled:false,children:[] as unknown[],
   append(...nodes:unknown[]){this.children.push(...nodes);},replaceChildren(){this.children=[];},setAttribute:vi.fn(),scrollIntoView:vi.fn(),
   addEventListener:(event:string,callback:()=>void)=>listeners.set(event,callback),fire:(event:string)=>listeners.get(event)?.()};
 }
 const nodes=new Map(['#composer .send','#stop-chat','#chat-log','#welcome'].map(selector=>[selector,element()]));
 const window={addEventListener:vi.fn()} as Record<string,unknown>,requests:{path:string;body?:string;signal?:AbortSignal|null}[]=[];
 runInNewContext(browserSource,{window,document:{querySelector:(selector:string)=>nodes.get(selector),createElement:element},
  fetch:(path:string,options:RequestInit)=>{
   requests.push({path,body:typeof options.body==='string'?options.body:undefined,signal:options.signal});
   return fetch(url+path,{...options,headers:{...options.headers,...headers}});
  },crypto:{randomUUID},AbortController,setTimeout,clearTimeout,Error,console:{debug:vi.fn()}});
 return {nodes,requests,chat:window.EchoPrimeChat as {send:(text:string)=>Promise<{sent?:boolean;detail:string}>}};
}

describe('ordinary CLI configuration to model submission and browser contract',()=>{
 it.each([120000,300000])('uses reviewed %ims for a three-step 150-second workflow through real loopback HTTP',async turnTimeoutMs=>{
  const f=await cli(turnTimeoutMs);
  // Advance only application timers and clocks. The test controls each real
  // HTTP response at 50-second intervals; no individual model call exceeds 120s.
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
  const ui=browser(f.url,f.headers),pending=ui.chat.send('Read info.txt twice, then report the calibration.');
  const first=await f.endpoint.arrival(1);
  expect(first.body.model).toBe(DEFAULT_MODELS.model);
  expect(first.body.messages.some(message=>message.role==='user'&&message.content.includes('Read info.txt twice'))).toBe(true);
  await vi.advanceTimersByTimeAsync(50000);first.respond({action:'read',path:'info.txt'});
  const second=await f.endpoint.arrival(2);
  expect(second.body.messages.some(message=>message.content.includes('calibration=714'))).toBe(true);
  await vi.advanceTimersByTimeAsync(50000);second.respond({action:'read',path:'info.txt'});
  const third=await f.endpoint.arrival(3);
  expect(ui.requests.map(request=>request.path)).toEqual(['/api/status','/api/chat']);
  const submitted=ui.requests[1];expect(JSON.parse(submitted.body!)).not.toHaveProperty('turnTimeoutMs');
  if(turnTimeoutMs===120000){
   await vi.advanceTimersByTimeAsync(19999);expect(submitted.signal?.aborted).toBe(false);
   await vi.advanceTimersByTimeAsync(1);
   const result=await bounded(pending,'the host deadline response');
   expect(result).toMatchObject({sent:false,detail:expect.stringContaining('interrupted')});
   // Host expiry returns before the browser's separate 5-second grace elapses.
   expect(submitted.signal?.aborted).toBe(false);await bounded(third.closed,'local model request cancellation');
   third.respond({action:'final',content:'Late final must never be accepted.'});
   expect(JSON.stringify(ui.nodes.get('#chat-log')!.children)).not.toContain('Late final');
  }else{
   await vi.advanceTimersByTimeAsync(49999);expect(submitted.signal?.aborted).toBe(false);
   await vi.advanceTimersByTimeAsync(1);third.respond({action:'final',content:'info.txt reports calibration 714.'});
   expect(await bounded(pending,'the longer configured reply')).toMatchObject({sent:true});
   expect(JSON.stringify(ui.nodes.get('#chat-log')!.children)).toContain('info.txt reports calibration 714.');
  }
  expect(f.endpoint.calls).toHaveLength(3);expect((await f.status()).chat.busy).toBe(false);
  expect(ui.nodes.get('#composer .send')!.disabled).toBe(false);expect(ui.nodes.get('#stop-chat')!.hidden).toBe(true);
  const store=new SessionStore(f.state),sessions=store.list();expect(sessions).toHaveLength(1);
  expect(store.get(sessions[0].id).status).toBe(turnTimeoutMs===120000?'interrupted':'completed');
  expect(readFileSync(join(f.workspace,'info.txt'),'utf8')).toBe('calibration=714\n');
 });

 it('the shipped Stop button disconnects ordinary HTTP chat and aborts its real local model request',async()=>{
  const f=await cli(300000),ui=browser(f.url,f.headers),pending=ui.chat.send('Observe the existing local request.');
  const call=await f.endpoint.arrival(1);ui.nodes.get('#stop-chat')!.fire('click');
  expect(await bounded(pending,'the Stop result')).toMatchObject({sent:false,detail:expect.stringContaining('Turn cancelled')});
  expect(ui.requests[1].signal?.aborted).toBe(true);await bounded(call.closed,'the local model socket close after Stop');
  await vi.waitFor(async()=>expect((await f.status()).chat.busy).toBe(false));
  expect(f.endpoint.calls).toHaveLength(1);expect(ui.requests.map(item=>item.path)).toEqual(['/api/status','/api/chat']);
  expect(ui.nodes.get('#composer .send')!.disabled).toBe(false);
 });

 it('an HTTP client disconnect releases the ordinary router turn without replaying its model request',async()=>{
  const f=await cli(300000),client=request(f.url+'/api/chat',{method:'POST',headers:f.headers});
  client.on('error',()=>{});client.end(JSON.stringify({requestId:randomUUID(),prompt:'Observe cancellation of this request.'}));
  const call=await f.endpoint.arrival(1);client.destroy();
  await bounded(call.closed,'the local model socket close after disconnect');
  await vi.waitFor(async()=>expect((await f.status()).chat.busy).toBe(false));
  expect(f.endpoint.calls).toHaveLength(1);
  const store=new SessionStore(f.state),sessions=store.list();expect(sessions).toHaveLength(1);
  expect(store.get(sessions[0].id).status).toBe('interrupted');
 });
});

describe('one parent model-step allowance across a configured decline reroute',()=>{
 function fixture(limit:10|30,declineAt:number,finalOnRemaining=false){
  const root=mkdtempSync(join(tmpdir(),'prime-parent-steps-'));directories.push(root);
  const state=join(root,'state');writeFileSync(join(root,'info.txt'),'calibration=714\n');
  const workspace=new Workspace(root,[state]),store=new SessionStore(state),models=new ModelRouter({...DEFAULT_MODELS,default:'gpt'});
  const info={gpt:models.turn('gpt').info(),qwen:models.turn('qwen').info()};let primaryCalls=0;
  const answered={gpt:vi.fn(()=>info.gpt),qwen:vi.fn(()=>info.qwen)};
  const primary:Model={next:vi.fn(async():Promise<Action>=>++primaryCalls===declineAt?{action:'final',content:'I cannot help with that request.'}:{action:'read',path:'info.txt'})};
  const fallback:Model={next:vi.fn(async():Promise<Action>=>finalOnRemaining?{action:'final',content:'The remaining step is complete.'}:{action:'read',path:'info.txt'})};
  vi.spyOn(models,'turn').mockImplementation(id=>{
   if(id!=='gpt'&&id!=='qwen')throw new Error('Unexpected provider');
   return {model:id==='gpt'?primary:fallback,answered:answered[id],info:()=>info[id]};
  });
  const chat=new SharedChat({workspace,store,models,...(limit===30?{autoagents:new AutoAgents({})}:{})});
  return {chat,store,primary,fallback,answered};
 }
 it.each([[10,10],[10,9],[30,30],[30,29]] as const)('retains the %i-step parent ceiling when the vendor declines on step %i',async(limit,declineAt)=>{
  const f=fixture(limit,declineAt),result=await f.chat.submit({requestId:randomUUID(),prompt:'Inspect the calibration with the admitted step allowance.'});
  expect(f.primary.next).toHaveBeenCalledTimes(declineAt);
  expect(f.fallback.next).toHaveBeenCalledTimes(limit-declineAt);
  expect(f.answered.qwen).toHaveBeenCalledTimes(declineAt===limit?0:1);
  expect(result.status).toBe('step_limit');expect(f.store.get(result.sessionId).status).toBe('step_limit');
  expect(result.answer).not.toContain('I cannot help');expect(f.chat.status().busy).toBe(false);
  if(declineAt<limit)expect(result.evidence).toContainEqual(expect.objectContaining({path:'info.txt',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}));
 });
 it.each([10,30] as const)('permits a final on the sole remaining step of the %i-step parent allowance',async limit=>{
  const f=fixture(limit,limit-1,true),result=await f.chat.submit({requestId:randomUUID(),prompt:'Complete within the remaining allowance.'});
  expect(f.primary.next).toHaveBeenCalledTimes(limit-1);expect(f.fallback.next).toHaveBeenCalledOnce();
  expect(result).toMatchObject({status:'completed',answer:'The remaining step is complete.'});
  expect(f.store.get(result.sessionId).status).toBe('completed');
 });
});

describe('host cancellation without cooperation from an awaited phase',()=>{
 function fixture(model:Model,personality?:PersonalityForge){
  const root=mkdtempSync(join(tmpdir(),'prime-host-settlement-'));directories.push(root);
  const state=join(root,'state'),store=new SessionStore(state),workspace=new Workspace(root,[state]),models=new ModelRouter({...DEFAULT_MODELS});
  const info=models.turn('qwen').info();
  vi.spyOn(models,'turn').mockReturnValue({model,answered:()=>info,info:()=>info});
  return {store,chat:new SharedChat({workspace,store,models,personality,turnTimeoutMs:1000})};
 }
 it('settles a model that ignores abort, releases its session lease, and discards a late final',async()=>{
  vi.useFakeTimers();const arrived=deferred<void>(),late=deferred<Action>();let modelSignal:AbortSignal|undefined;
  const model:Model={next:vi.fn(async(_messages,signal)=>{modelSignal=signal;arrived.resolve();return late.promise;})};
  const f=fixture(model),pending=f.chat.submit({requestId:randomUUID(),prompt:'Observe the bounded model wait.'});
  await arrived.promise;await vi.advanceTimersByTimeAsync(1000);
  const result=await bounded(pending,'settlement of a model that ignores abort');
  expect(result.status).toBe('interrupted');expect(modelSignal?.aborted).toBe(true);expect(f.chat.status().busy).toBe(false);
  const release=f.store.lease(result.sessionId);release();
  const before=structuredClone(f.store.get(result.sessionId));
  late.resolve({action:'final',content:'Late non-cooperative model answer must be discarded.'});await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(result.sessionId)).toEqual(before);expect(model.next).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('settles hung personality preparation without starting a model after cancellation or late selection',async()=>{
  vi.useFakeTimers();const arrived=deferred<void>(),late=deferred<Selection|null>();
  const personality=new PersonalityForge(),select=vi.spyOn(personality,'select').mockImplementation(async()=>{arrived.resolve();return late.promise;});
  const model:Model={next:vi.fn()},f=fixture(model,personality);
  const pending=f.chat.submit({requestId:randomUUID(),prompt:'Observe the bounded preparation wait.'}).then(result=>({result,error:undefined}),error=>({result:undefined,error}));
  await arrived.promise;await vi.advanceTimersByTimeAsync(1000);
  const outcome=await bounded(pending,'settlement of preparation that ignores abort');
  expect(outcome.error).toBeInstanceOf(Error);expect(f.chat.status().busy).toBe(false);expect(model.next).not.toHaveBeenCalled();
  const before=f.store.list().map(session=>structuredClone(f.store.get(session.id)));
  late.resolve(null);await vi.advanceTimersByTimeAsync(0);
  expect(f.store.list().map(session=>f.store.get(session.id))).toEqual(before);expect(select).toHaveBeenCalledOnce();
  expect(model.next).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
});
