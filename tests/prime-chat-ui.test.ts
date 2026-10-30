import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
const source=readFileSync(new URL('../ui/echo-prime/chat.js',import.meta.url),'utf8');
function fixture(fetch:ReturnType<typeof vi.fn>){
 function element(){return {textContent:'',className:'',hidden:false,disabled:false,children:[] as unknown[],
  append(...nodes:unknown[]){this.children.push(...nodes);},replaceChildren(){this.children=[];},setAttribute:vi.fn(),scrollIntoView:vi.fn(),addEventListener:vi.fn()};}
 const nodes=new Map(['#composer .send','#stop-chat','#chat-log','#welcome'].map(k=>[k,element()]));
 const window={addEventListener:vi.fn()} as Record<string,unknown>;
 runInNewContext(source,{window,document:{querySelector:(s:string)=>nodes.get(s),createElement:element},
  fetch,crypto:{randomUUID},AbortController,setTimeout,clearTimeout,Error});
 const chat=window.EchoPrimeChat as {send:(text:string)=>Promise<{sent?:boolean;cancelled?:boolean;detail:string}>;reset:()=>void;cancel:()=>void};
 return {nodes,chat};
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
