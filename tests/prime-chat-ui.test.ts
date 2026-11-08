import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SharedChat} from '../src/prime/chat.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore} from '../src/code/sessions.js';
import {DEFAULT_MODELS,ModelRouter} from '../src/code/model-factory.js';
const source=readFileSync(new URL('../ui/echo-prime/chat.js',import.meta.url),'utf8');
const dirs:string[]=[];
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});});
function hostStatus(turnTimeoutMs?:number){
 const root=mkdtempSync(join(tmpdir(),'prime-chat-ui-deadline-')),state=mkdtempSync(join(tmpdir(),'prime-chat-ui-state-'));dirs.push(root,state);
 return new SharedChat({workspace:new Workspace(root,[state]),store:new SessionStore(state),models:new ModelRouter({...DEFAULT_MODELS}),...(turnTimeoutMs===undefined?{}:{turnTimeoutMs})}).status();
}
function fixture(fetch:ReturnType<typeof vi.fn>){
 function element(){return {textContent:'',className:'',hidden:false,disabled:false,children:[] as unknown[],
  append(...nodes:unknown[]){this.children.push(...nodes);},replaceChildren(){this.children=[];},setAttribute:vi.fn(),scrollIntoView:vi.fn(),addEventListener:vi.fn()};}
 const nodes=new Map(['#composer .send','#stop-chat','#chat-log','#welcome'].map(k=>[k,element()]));
 const listeners=new Map<string,()=>void>(),window={addEventListener:vi.fn((name:string,callback:()=>void)=>listeners.set(name,callback))} as Record<string,unknown>;
 runInNewContext(source,{window,document:{querySelector:(s:string)=>nodes.get(s),createElement:element},
  fetch,crypto:{randomUUID},AbortController,setTimeout,clearTimeout,Error});
 const chat=window.EchoPrimeChat as {send:(text:string)=>Promise<{sent?:boolean;cancelled?:boolean;detail:string}>;reset:()=>void;cancel:()=>void};
 return {nodes,chat,notify:(name:string)=>listeners.get(name)?.()};
}
it('renders model text as literal text with evidence and keeps the session on the next turn',async()=>{
 const payload='<img src=x onerror=alert(1)>',sessionId=randomUUID();
 const fetch=vi.fn(async(path:string)=>({ok:true,json:async()=>path.endsWith('status')?{chat:{state:'attached'}}:
  {status:'completed',sessionId,answer:payload,answerVerification:'unverified_model_text',evidence:[{path:'info.txt',sha256:'a'.repeat(64)}]}}));
 const {chat,nodes}=fixture(fetch);
 expect((await chat.send('inspect')).sent).toBe(true);
 const messages=nodes.get('#chat-log')!.children as {children:{textContent:string}[]}[];
 expect(messages[1].children[1].textContent).toBe(payload);expect(messages[1].children[2].textContent).toContain('Model text; verify claims.');
 expect(messages[1].children[2].textContent).toContain('info.txt');
 await chat.send('continue');
 const request=JSON.parse((fetch.mock.calls[3] as unknown as [string,{body:string}])[1].body);
 expect(request.sessionId).toBe(sessionId);expect(request).not.toHaveProperty('mode');
 expect(nodes.get('#composer .send')!.disabled).toBe(false);
});
it('keeps disconnected prompts as drafts without sending a model request',async()=>{
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({chat:{state:'disconnected',detail:'Owner admission pending'}})}));
 const {chat,nodes}=fixture(fetch);expect(await chat.send('private draft')).toMatchObject({sent:false,detail:'Owner admission pending'});
 expect(fetch).toHaveBeenCalledTimes(1);expect(nodes.get('#chat-log')!.children).toEqual([]);
});
it('cancels a replaced conversation and prevents late results from appearing in the new chat',async()=>{
 let finish!:(value:unknown)=>void;let signal:AbortSignal|undefined;
 const fetch=vi.fn(async(path:string,options:{signal:AbortSignal})=>{
  if(path.endsWith('status'))return {ok:true,json:async()=>({chat:{state:'attached'}})};
  signal=options.signal;return new Promise(resolve=>{finish=resolve;});
 });
 const {chat,nodes}=fixture(fetch),pending=chat.send('first');
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 chat.reset();expect(signal!.aborted).toBe(true);
 finish({ok:true,json:async()=>({sessionId:randomUUID(),status:'completed',answer:'late'})});
 expect(await pending).toMatchObject({cancelled:true});expect(nodes.get('#chat-log')!.children).toEqual([]);
});
it('does not submit a prompt if the conversation changed during the status check',async()=>{
 let finish!:(value:unknown)=>void;
 const fetch=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
 const {chat}=fixture(fetch),pending=chat.send('old draft');chat.reset();
 finish({ok:true,json:async()=>({chat:{state:'attached'}})});
 expect(await pending).toMatchObject({cancelled:true});expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([undefined,180000,300000])('uses the actual host status deadline %s/default with five seconds of browser grace',async turnTimeoutMs=>{
 vi.useFakeTimers();const status=hostStatus(turnTimeoutMs);let signal:AbortSignal|undefined;
 const fetch=vi.fn(async(path:string,options:{signal:AbortSignal;body?:string})=>{
  if(path==='/api/status')return {ok:true,json:async()=>({chat:status})};
  signal=options.signal;return await new Promise<never>((_,reject)=>signal!.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));
 });
 const {chat}=fixture(fetch),pending=chat.send('Wait for the existing run.');
 await vi.advanceTimersByTimeAsync(0);expect(signal).toBeInstanceOf(AbortSignal);
 expect(JSON.parse(fetch.mock.calls[1][1].body!)).not.toHaveProperty('turnTimeoutMs');
 await vi.advanceTimersByTimeAsync((turnTimeoutMs??120000)+4999);expect(signal?.aborted).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(signal?.aborted).toBe(true);
 expect(await pending).toMatchObject({sent:false,detail:expect.stringContaining('Turn cancelled')});expect(fetch).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
});
it('renders a real-status-configured longer turn that finishes after the old browser deadline',async()=>{
 vi.useFakeTimers();const status=hostStatus(180000);
 const fetch=vi.fn(async(path:string,options:{signal:AbortSignal})=>{
  if(path==='/api/status')return {ok:true,json:async()=>({chat:status})};
  return await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>resolve({ok:true,json:async()=>({sessionId:randomUUID(),status:'completed',answer:'Worker proof was gathered.'})}),150000);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('Cancelled'));},{once:true});
  });
 });
 const {chat,nodes}=fixture(fetch),pending=chat.send('Gather the worker proof.');
 await vi.advanceTimersByTimeAsync(150000);
 expect(await pending).toMatchObject({sent:true});expect(JSON.stringify(nodes.get('#chat-log')!.children)).toContain('Worker proof was gathered.');expect(vi.getTimerCount()).toBe(0);
});
it('starts the response allowance after a slow status lookup instead of subtracting lookup time',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;
 const fetch=vi.fn(async(path:string,options:{signal:AbortSignal})=>{
  if(path==='/api/status')return await new Promise(resolve=>setTimeout(()=>resolve({ok:true,json:async()=>({chat:{state:'attached',turnTimeoutMs:180000}})}),20000));
  signal=options.signal;return await new Promise<never>((_,reject)=>signal!.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));
 });
 const {chat}=fixture(fetch),pending=chat.send('Long status lookup.');
 await vi.advanceTimersByTimeAsync(20000);expect(signal).toBeInstanceOf(AbortSignal);
 await vi.advanceTimersByTimeAsync(184999);expect(signal?.aborted).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(await pending).toMatchObject({sent:false});expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('keeps the initial status lookup bounded without ever submitting the prompt',async()=>{
 vi.useFakeTimers();
 const fetch=vi.fn(async(_path:string,options:{signal:AbortSignal})=>await new Promise<never>((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true})));
 const {chat}=fixture(fetch),pending=chat.send('Unsent prompt.');await vi.advanceTimersByTimeAsync(125000);
 expect(await pending).toMatchObject({sent:false});expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/status',expect.anything());expect(vi.getTimerCount()).toBe(0);
});
it.each([undefined,null,'180000',0,999,180000.5,300001,NaN,Infinity])('falls back to the existing125s browser limit for malformed/missing status timeout %s',async turnTimeoutMs=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;
 const fetch=vi.fn(async(path:string,options:{signal:AbortSignal})=>{
  if(path==='/api/status')return {ok:true,json:async()=>({chat:{state:'attached',turnTimeoutMs}})};
  signal=options.signal;return await new Promise<never>((_,reject)=>signal!.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));
 });
 const {chat}=fixture(fetch),pending=chat.send('Read the worker status.');
 await vi.advanceTimersByTimeAsync(124999);expect(signal?.aborted).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(signal?.aborted).toBe(true);expect(await pending).toMatchObject({sent:false});expect(fetch).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
});
it.each(['cancel','reset'] as const)('never rearms or submits after %s during a slow status lookup',async action=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void;
 const fetch=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
 const {chat}=fixture(fetch),pending=chat.send('Unsent prompt.');chat[action]();
 finish({ok:true,json:async()=>({chat:{state:'attached',turnTimeoutMs:180000}})});
 await pending;await vi.advanceTimersByTimeAsync(300000);
 expect(fetch).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it.each(['cancel','pagehide'])('keeps %s immediate during a configured long turn',async action=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;
 const fetch=vi.fn(async(path:string,options:{signal:AbortSignal})=>{
  if(path==='/api/status')return {ok:true,json:async()=>({chat:{state:'attached',turnTimeoutMs:180000}})};
  signal=options.signal;return await new Promise<never>((_,reject)=>signal!.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));
 });
 const {chat,notify}=fixture(fetch),pending=chat.send('Long task.');await vi.advanceTimersByTimeAsync(1);if(action==='cancel')chat.cancel();else notify('pagehide');
 expect(signal?.aborted).toBe(true);expect(await pending).toMatchObject({sent:false});expect(vi.getTimerCount()).toBe(0);expect(fetch).toHaveBeenCalledTimes(2);
});
