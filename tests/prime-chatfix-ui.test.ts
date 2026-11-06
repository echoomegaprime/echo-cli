/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// Live end-to-end test of echoomegaprime.com, 2026-11-06: the model picker was ignored in the default Echo conversation
// (Claude picked, Qwen answered, nothing said so), Workspace replies carried no model label, ECHO Code showed a model-switch
// refusal as "Connection failed.", New chat left ECHO Code, every ECHO Code reply was filed as an "Echo Build" artifact,
// failures were prefixed "Model text; verify claims.", auto-personality never handed back, the NEXUS row read n.state,
// aborted probes rendered as offline, and the Swarm brain / Fleet nodes items did not exist. The shipped controllers run
// here unchanged against a small DOM; every network answer is synthetic.
class Node {
 textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;inert=false;isConnected=true;
 tagName:string;dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};
 classList={add:vi.fn(),remove:vi.fn(),toggle:vi.fn(),contains:()=>false};
 style={setProperty:vi.fn()};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:Node[]){for(const item of items){if(item.parent)item.parent.children=item.parent.children.filter(c=>c!==item);item.parent=this;item.isConnected=true;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children){child.isConnected=false;child.parent=null;}this.children=[];this.append(...items);}
 remove(){if(!this.parent)return;this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;this.isConnected=false;}
 setAttribute(key:string,value:string){this.attributes[key]=String(value);if(key==='value')this.value=String(value);if(key==='id')(this as any).id=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
 getAttribute(key:string){return this.attributes[key]??null;}
 removeAttribute(key:string){delete this.attributes[key];}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of [...(this.events[name]||[])])await fn({preventDefault(){},target:this,...event});}
 dispatchEvent(event:any){void this.fire(event.type,event);return true;}
 showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}
 focus(){} before(){} scrollIntoView(){} click(){return this.fire('click');}
 querySelector(selector:string):Node|null{const tag=selector.toLowerCase();for(const child of this.children){if(child.tagName.toLowerCase()===tag)return child;const deep=child.querySelector(selector);if(deep)return deep;}return null;}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
}
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
const descendants=(node:Node):Node[]=>node.children.flatMap(child=>[child,...descendants(child)]);
const text=(node:Node):string=>[node.textContent,...node.children.map(text)].join(' ').replace(/\s+/g,' ').trim();
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setTimeout(resolve,0));};
function harness(files:string|string[],options:{window?:Record<string,any>;fetch?:any;storage?:Record<string,string>;globals?:Record<string,any>}={}){
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},documentEvents:Record<string,((event:any)=>unknown)[]>={};
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node(selector.startsWith('#prime-nav')?'nav':'div'));return nodes.get(selector)!;};
 const stored=new Map(Object.entries(options.storage||{}));
 const localStorage={getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>{stored.set(key,value);},removeItem:(key:string)=>{stored.delete(key);}};
 const window:any={addEventListener:(name:string,callback:(event:any)=>unknown)=>(events[name]??=[]).push(callback),removeEventListener(){},dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);return true;},...options.window};
 const body=new Node('body');
 const document:any={hidden:false,readyState:'complete',head:new Node('head'),body,documentElement:new Node('html'),querySelector:(selector:string)=>selector==='nav[aria-label="Workspace"]'?get('#prime-nav'):get(selector),querySelectorAll:()=>[],createElement:(tag:string)=>new Node(tag),createTextNode:(value:string)=>Object.assign(new Node('#text'),{textContent:value}),createElementNS:(_ns:string,tag:string)=>new Node(tag),addEventListener:(name:string,callback:(event:any)=>unknown)=>(documentEvents[name]??=[]).push(callback),removeEventListener(){},dispatchEvent(){return true;}};
 const context={window,document,localStorage,matchMedia:()=>({matches:false,addEventListener(){}}),navigator:{userAgent:'fixture'},location:{protocol:'http:',origin:'http://127.0.0.1'},crypto:{randomUUID},setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,TypeError,console:{debug:vi.fn(),warn:vi.fn()},fetch:options.fetch||vi.fn(),MutationObserver:class{observe(){}},Promise,...options.globals};
 for(const name of [files].flat())runInNewContext(source(name),context);
 return {get,window,document,stored,events,documentEvents,emit:(type:string)=>window.dispatchEvent(new Event(type))};
}
const owner={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
const MODEL='c3po-code:echo-qwen38-abliterated-256k';
const savedChat=()=>({id:'c1',title:'Saved',messages:[
 {id:'m1',role:'user',content:'What is FORGE?',created:'2026-11-06T09:00:00+00:00',request_id:'r1'},
 {id:'m2',role:'assistant',content:'FORGE is the Postgres and SDK gate host.',created:'2026-11-06T09:00:05+00:00',request_id:'r1:reply'},
],events:[
 {kind:'chat_started',content:'Title: Saved\nSource: qwen',created:'2026-11-06T08:59:59+00:00'},
 {kind:'user',content:'Message: m1\nSource time: local\n\nWhat is FORGE?',created:'2026-11-06T09:00:00+00:00'},
 {kind:'context',content:JSON.stringify({model:MODEL,prompt_characters:18000}),created:'2026-11-06T09:00:01+00:00'},
 {kind:'model_usage',content:JSON.stringify({prompt_tokens:18722,completion_tokens:25}),created:'2026-11-06T09:00:04+00:00'},
 {kind:'assistant',content:'Message: m2\nSource time: local\n\nFORGE is the Postgres and SDK gate host.',created:'2026-11-06T09:00:05+00:00'},
]});
function workspace(windowExtra:Record<string,any>={},chat=savedChat()){
 let identity!:(session:any)=>void;
 const request=vi.fn(async(path:string,_body?:any)=>path==='/state'?{chats:[],projects:[],library:[],preferences:[],personalities:[],model:MODEL,context_length:262144}:path==='/chats'?{id:'c-new',title:'New chat',messages:[],events:[]}:path.startsWith('/chats/')?structuredClone(chat):{});
 const chatTurn=vi.fn(async(input:any)=>({id:input.chat_id,messages:[...chat.messages,{id:'m3',role:'user',content:input.content},{id:'m4',role:'assistant',content:'Workspace reply',request_id:input.request_id+':reply'}],events:chat.events}));
 class Transport {session=owner;generation=0;constructor(o:any){identity=o.onIdentityChange;}loadSession=async()=>this.session;request=request;chat=chatTurn;text=async()=>'';audio=async()=>new Blob();headers=()=>({'x-prime-request':'1','x-echo-csrf':'owner'});clear(){identity(null);}auth=async()=>({});}
 const h=harness('workspace.js',{window:{EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn(),send:vi.fn()},...windowExtra}});
 h.get('#workspace-chat-kind').value='workspace';
 return {...h,ws:h.window.EchoPrimeWorkspace,request,chatTurn,identity:(s:any)=>identity(s)};
}
const routeTo=(route:any)=>({ready:Promise.resolve(),conversationRoute:vi.fn(()=>route)});
function vendorChat(log:()=>Node){
 let n=0;
 return vi.fn(async(value:string,_options?:any)=>{n++;const user=new Node('article'),reply=new Node('article');user.textContent='U'+n+':'+value;reply.textContent='A'+n;log().append(user,reply);return {sent:true,detail:'Answer received.',sessionId:'11111111-1111-4111-8111-11111111111'+n,nodes:[user,reply]};});
}

describe('Echo conversation: the picked model really answers',()=>{
 it('sends a vendor pick through the ECHO Code vendor path with the saved conversation, never the Workspace model',async()=>{
  let h!:ReturnType<typeof workspace>;
  const send=vendorChat(()=>h.get('#chat-log'));
  h=workspace({EchoPrimeModels:routeTo({vendor:{id:'claude',label:'Claude (claude CLI)'}})});
  h.window.EchoPrimeChat.send=send;
  await h.ws.ready;await h.ws.bridge.openChat('c1');
  const outcome=await h.ws.send('Summarise what we said.');
  expect(h.chatTurn).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  const [shown,options]=send.mock.calls[0];
  expect(shown).toBe('Summarise what we said.');
  expect(options.workspace.chatId).toBe('c1');expect(options.workspace.sessionId).toBeUndefined();
  expect(options.workspace.prompt).toContain('What is FORGE?');expect(options.workspace.prompt).toContain('FORGE is the Postgres and SDK gate host.');
  expect(options.workspace.prompt.endsWith('Summarise what we said.')).toBe(true);expect(options.workspace.prompt.length).toBeLessThanOrEqual(12000);
  expect(options.workspace.note).toMatch(/2 earlier Workspace messages/);
  expect(outcome).toMatchObject({handled:true,sent:true});
 });
 it('continues the same vendor session, sends only newer Workspace messages, and starts a new one when the pick changes',async()=>{
  let h!:ReturnType<typeof workspace>;
  const route={current:{vendor:{id:'claude',label:'Claude (claude CLI)'}} as any};
  const send=vendorChat(()=>h.get('#chat-log'));
  h=workspace({EchoPrimeModels:{ready:Promise.resolve(),conversationRoute:()=>route.current}});h.window.EchoPrimeChat.send=send;
  await h.ws.ready;await h.ws.bridge.openChat('c1');
  await h.ws.send('first');await h.ws.send('second');
  expect(send.mock.calls[1][1].workspace.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  expect(send.mock.calls[1][1].workspace.prompt).toBe('second');
  route.current={vendor:{id:'gpt',label:'GPT (codex CLI)'}};
  await h.ws.send('third');
  expect(send.mock.calls[2][1].workspace.sessionId).toBeUndefined();expect(send.mock.calls[2][1].workspace.prompt).toContain('What is FORGE?');
 });
 it('keeps the vendor exchange in place after the saved conversation is re-rendered',async()=>{
  let h!:ReturnType<typeof workspace>;
  const send=vendorChat(()=>h.get('#chat-log'));
  h=workspace({EchoPrimeModels:routeTo({vendor:{id:'claude',label:'Claude (claude CLI)'}})});h.window.EchoPrimeChat.send=send;
  await h.ws.ready;await h.ws.bridge.openChat('c1');await h.ws.send('vendor question');
  h.ws.bridge.setChat(savedChat());
  const log=h.get('#chat-log').children.map(n=>text(n));
  expect(log).toHaveLength(4);expect(log[0]).toContain('What is FORGE?');expect(log[1]).toContain('FORGE is the Postgres');
  expect(log[2]).toContain('U1:vendor question');expect(log[3]).toBe('A1');
  h.identity({...owner,user:{uid:'member',role:'member',status:'approved'},ownerAccess:false});await flush();
  h.ws.bridge.setChat(savedChat());// another account's page never shows the previous account's exchange
  expect(h.get('#chat-log').children.map(n=>text(n)).join(' ')).not.toContain('vendor question');
 });
 it('refuses plainly when the pick cannot be honoured, and keeps Qwen on the Workspace path',async()=>{
  const blocked=workspace({EchoPrimeModels:routeTo({blocked:'Model status is unavailable, so Claude (claude CLI) could not be confirmed. Nothing was sent.'})});
  await blocked.ws.ready;await blocked.ws.bridge.openChat('c1');
  expect(await blocked.ws.send('hello')).toEqual({handled:true,sent:false,detail:'Model status is unavailable, so Claude (claude CLI) could not be confirmed. Nothing was sent.'});
  expect(blocked.chatTurn).not.toHaveBeenCalled();expect(blocked.window.EchoPrimeChat.send).not.toHaveBeenCalled();
  const qwen=workspace({EchoPrimeModels:routeTo({})});await qwen.ws.ready;await qwen.ws.bridge.openChat('c1');
  await qwen.ws.send('hello');
  expect(qwen.chatTurn).toHaveBeenCalledTimes(1);expect(qwen.window.EchoPrimeChat.send).not.toHaveBeenCalled();
 });
});

describe('Echo conversation: every reply says which model answered',()=>{
 it('labels a saved Workspace reply from its context event and the Workspace state',async()=>{
  const h=workspace();await h.ws.ready;await h.ws.bridge.refresh();await h.ws.bridge.openChat('c1');
  const reply=h.get('#chat-log').children[1];
  const meta=text(reply.children.find(n=>n.tagName==='SMALL')!);
  expect(meta).toContain('answered by Qwen 3.8 256K');expect(meta).toContain(MODEL);expect(meta).toContain('Workspace');
  expect(meta).toContain('2026-11-06T09:00:05+00:00');
  const user=text(h.get('#chat-log').children[0].children.find(n=>n.tagName==='SMALL')!);expect(user).not.toContain('answered by');
 });
 it('never guesses: an imported reply says so and a reply without a recorded model says that',async()=>{
  const chat=savedChat();chat.messages[1].request_id='import-1';chat.events=chat.events.filter(e=>e.kind!=='context');
  chat.messages.push({id:'m9',role:'assistant',content:'Copied reply',created:'2026-11-06T09:01:00+00:00',request_id:'copy-x'});
  const h=workspace({},chat);await h.ws.ready;await h.ws.bridge.openChat('c1');
  const metas=h.get('#chat-log').children.map(n=>{const meta=n.children.find(c=>c.tagName==='SMALL');return meta?text(meta):'';});
  expect(metas[1]).toContain('Imported message');expect(metas[1]).not.toContain('answered by');
  expect(metas[2]).toContain('model not recorded');
 });
});

describe('New conversation keeps the conversation kind',()=>{
 it('leaves ECHO Code in ECHO Code and creates no Workspace chat',async()=>{
  const h=workspace();await h.ws.ready;
  h.get('#workspace-chat-kind').value='coding';
  expect(await h.ws.newChat()).toBe(false);
  expect(h.request.mock.calls.filter(c=>c[0]==='/chats')).toHaveLength(0);expect(h.get('#workspace-chat-kind').value).toBe('coding');
  h.get('#workspace-chat-kind').value='workspace';
  expect(await h.ws.newChat()).toBe(true);expect(h.request.mock.calls.filter(c=>c[0]==='/chats')).toHaveLength(1);
 });
});

describe('ECHO Code chat (chat.js)',()=>{
 const reply=(over:Record<string,any>={})=>({status:'completed',sessionId:'22222222-2222-4222-8222-222222222222',answer:'Here is the summary.',answerVerification:'unverified_model_text',evidence:[],model:{id:'claude',label:'Claude (claude CLI)',model:'claude-opus-5-5',answered:true},...over});
 function chat(responses:any[],windowExtra:Record<string,any>={}){
  const bodies:any[]=[];
  const fetch=vi.fn(async(path:string,init:any)=>{
   if(path.endsWith('/status'))return {ok:true,status:200,json:async()=>({chat:{state:'attached'}})};
   bodies.push(JSON.parse(init.body));const next=responses.shift();
   return next&&next.status>=400?{ok:false,status:next.status,json:async()=>next.body}:{ok:true,status:200,json:async()=>next};
  });
  const strip={thinking:vi.fn(),done:vi.fn(),fail:vi.fn(),status:vi.fn()};
  const pick={id:'claude'};
  const models={provider:()=>pick.id,model:()=>undefined,label:(id?:string)=>({claude:'Claude (claude CLI)',gpt:'GPT (codex CLI)'} as any)[id||pick.id],describe:(m:any)=>m.answered===false?'no model answered':'answered by '+m.model};
  const register=vi.fn(async()=>({}));
  const h=harness('chat.js',{fetch,window:{EchoPrimeActivity:{start:()=>strip,clear(){}},EchoPrimeModels:models,EchoPrimeArtifacts:{register},...windowExtra}});
  return {...h,fetch,bodies,strip,pick,register,api:h.window.EchoPrimeChat};
 }
 const metaOf=(node:Node)=>node.children.find(n=>n.tagName==='SMALL')?.textContent||'';
 it('answers an Echo conversation turn: sends the prepared prompt, labels the model and says it is not saved to the Workspace',async()=>{
  const h=chat([reply()]);
  const result=await h.api.send('Summarise.',{workspace:{chatId:'c1',prompt:'Earlier messages…\n\nSummarise.',note:'Context: 2 earlier Workspace messages'}});
  expect(h.bodies[0].prompt).toBe('Earlier messages…\n\nSummarise.');expect(h.bodies[0].sessionId).toBeUndefined();expect(h.bodies[0].provider).toBe('claude');
  expect(result).toMatchObject({sent:true,sessionId:'22222222-2222-4222-8222-222222222222'});expect(result.nodes).toHaveLength(2);
  const [user,answer]=result.nodes;
  expect(user.children[1].textContent).toBe('Summarise.');
  expect(answer.children[0].textContent).toBe('Echo Prime');
  const meta=metaOf(answer);
  expect(meta).toContain('Model text; verify claims.');expect(meta).toContain('answered by claude-opus-5-5');
  expect(meta).toContain('Not saved to your Workspace conversation');expect(meta).toContain('Context: 2 earlier Workspace messages');
  expect(h.register).not.toHaveBeenCalled();
  await h.api.send('Next ECHO Code question');// the ECHO Code conversation never inherits the Workspace-mode session
  expect(h.bodies[1].sessionId).toBeUndefined();
 });
 it('files no "Echo Build" artifact for an ordinary ECHO Code reply',async()=>{
  const h=chat([reply()]);await h.api.send('Write a function');
  expect(h.register).not.toHaveBeenCalled();expect(h.get('#chat-log').children[1].children[0].textContent).toBe('ECHO Code');
 });
 it('never prefixes a host or provider failure with "Model text; verify claims."',async()=>{
  const h=chat([reply({status:'failed',answer:'Claude (claude CLI) is unavailable: Failed to authenticate: OAuth session expired; no fallback was used',answerVerification:'unverified_model_text',model:{id:'claude',label:'Claude (claude CLI)',model:null,answered:false}})]);
  await h.api.send('hello');
  const meta=metaOf(h.get('#chat-log').children[1]);
  expect(meta).not.toContain('Model text; verify claims.');expect(meta).toContain('no model answered');
 });
 it('shows the real model-switch refusal and offers a new conversation with the picked model, staying in ECHO Code',async()=>{
  const refusal='This conversation was started with a different model; start a new conversation to switch models';
  const h=chat([reply(),{status:400,body:{error:refusal}}]);
  const composer=h.get('#composer');(composer as any).requestSubmit=vi.fn();
  await h.api.send('first');
  h.pick.id='gpt';
  const outcome=await h.api.send('second');
  expect(h.bodies[1].sessionId).toBe('22222222-2222-4222-8222-222222222222');
  expect(outcome.sent).toBe(false);expect(outcome.detail).toContain(refusal);
  expect(h.strip.fail).toHaveBeenLastCalledWith(refusal);expect(h.strip.fail).not.toHaveBeenCalledWith('Connection failed.');
  const box=h.get('#chat-log').children.at(-1)!;
  expect(text(box)).toContain(refusal);
  const offer=descendants(box).find(n=>n.tagName==='BUTTON')!;expect(offer.textContent).toBe('Start a new conversation with GPT (codex CLI)');
  await offer.fire('click');
  expect(h.get('#chat-log').children).toEqual([]);expect(h.get('#prompt').value).toBe('second');expect((composer as any).requestSubmit).toHaveBeenCalledTimes(1);
  expect(h.window.EchoPrimeWorkspace).toBeUndefined();// no Workspace call: the kind stays ECHO Code
 });
 it('keeps "Connection failed." for a real transport failure',async()=>{
  const h=harness('chat.js',{fetch:vi.fn(async(path:string)=>{if(path.endsWith('/status'))return {ok:true,status:200,json:async()=>({chat:{state:'attached'}})};throw new TypeError('Failed to fetch');}),window:{EchoPrimeActivity:{start:()=>strip,clear(){}}}});
  const strip={thinking:vi.fn(),done:vi.fn(),fail:vi.fn()};
  await h.window.EchoPrimeChat.send('hello');
  expect(strip.fail).toHaveBeenCalledWith('Connection failed.');
 });
});

describe('model picker in an Echo conversation (models.js)',()=>{
 const report=(over:Record<string,any>={})=>({configured:true,routing:true,default:'qwen',contextTokens:262144,auto:{enabled:false,chains:{}},providers:[
  {id:'qwen',label:'Qwen (FORGE, 256K)',available:true},{id:'claude',label:'Claude (claude CLI)',available:false,reason:'not signed in ("claude auth status" exited with code 1)'},
  {id:'gpt',label:'GPT (codex CLI)',available:true},{id:'grok',label:'Grok (grok CLI)',available:false,reason:'could not start "grok"'},{id:'argon',label:'Argon (agy CLI)',available:true,variants:[]}],...over});
 async function picker(stored:string|null,options:{status?:number;generalMode?:boolean}={}){
  const fetch=vi.fn(async()=>({ok:(options.status??200)<400,status:options.status??200,json:async()=>report()}));
  const ws={enabled:true,session:owner,ready:Promise.resolve(true),generalMode:options.generalMode!==false,ownerHeaders:async()=>({}),invalidate:vi.fn()};
  const h=harness('models.js',{fetch,storage:stored?{'echo-prime-model-v1':stored}:{},window:{EchoPrimeWorkspace:ws}});
  const api=h.window.EchoPrimeModels;await api.ready;
  const select=descendants(h.get('.composer-toolbar')).find(n=>n.tagName==='SELECT'&&(n as any).id==='model-select')!;
  const note=descendants(h.get('.composer-toolbar')).find(n=>n.tagName==='SMALL')!;
  return {...h,api,select,note,ws};
 }
 it('routes a vendor pick to the vendor, Qwen and Auto to the Workspace, and refuses the Swarm with a reason',async()=>{
  expect((await picker('gpt')).api.conversationRoute()).toEqual({vendor:{id:'gpt',label:'GPT (codex CLI)'}});
  expect((await picker('qwen')).api.conversationRoute()).toEqual({});
  const swarm=(await picker('swarm')).api.conversationRoute();expect(swarm.blocked).toMatch(/ECHO Code/);
 });
 it('refuses a vendor pick while the status route is down instead of quietly using Qwen',async()=>{
  const h=await picker('claude',{status:500});
  expect(h.api.conversationRoute().blocked).toMatch(/Claude \(claude CLI\).*Nothing was sent/);
  expect((await picker('qwen',{status:500})).api.conversationRoute()).toEqual({});
 });
 it('says in the note what will answer an Echo conversation, and names the picker plainly',async()=>{
  const qwen=await picker('qwen');
  expect(qwen.select.attributes['aria-label']).toBe('Model');
  expect(qwen.note.textContent).toMatch(/Workspace/);expect(qwen.note.textContent).toMatch(/memory/);
  const gpt=await picker('gpt');expect(gpt.note.textContent).toMatch(/GPT \(codex CLI\).*not saved to the Workspace/);
  const claude=await picker('claude');expect(claude.note.textContent).toContain('not signed in ("claude auth status" exited with code 1)');
 });
 it('lets another module choose a model and persists it',async()=>{
  const h=await picker('qwen');
  expect(h.api.choose('swarm')).toBe(true);expect(h.stored.get('echo-prime-model-v1')).toBe('swarm');expect(h.select.value).toBe('swarm');
  expect(h.api.choose('nonsense')).toBe(false);expect(h.api.label('gpt')).toBe('GPT (codex CLI)');
 });
});

describe('auto-personality hand-back (brain.js)',()=>{
 it('gives the Workspace chat back to auto when the owner turns auto-selection off',async()=>{
  const fetch=vi.fn(async(path:string,init:any)=>{
   const body=init?.body?JSON.parse(init.body):undefined;
   const json=path==='/api/prime/personality'&&!body?{configured:true,settings:{enabled:true,pinned:null},catalog:{entries:[{id:'echo',name:'Echo Prime',registered:true}]}}
    :path==='/api/prime/personality/select'?{selection:{id:'echo',name:'Echo Prime',pinned:false}}:path==='/api/prime/personality'?{enabled:false,pinned:null}:{};
   return {ok:true,status:200,json:async()=>json};
  });
  const bridgeApi=vi.fn(async()=>({ok:true}));
  const ws={enabled:true,session:owner,ready:Promise.resolve(true),ownerHeaders:async()=>({}),bridge:Object.freeze({state:{chat:{id:'c1'}},api:bridgeApi})};
  const h=harness('brain.js',{fetch,window:{EchoPrimeWorkspace:ws}});
  await h.window.EchoPrimeBrain.ready;
  await h.window.EchoPrimeBrain.beforeWorkspaceTurn({text:'hello',chatId:'c1',api:bridgeApi,messages:[]});
  expect(bridgeApi).toHaveBeenCalledWith('/action',{action:'personality_select',chat_id:'c1',profile:'echo'});
  const toggle=descendants(h.get('.composer-toolbar')).find(n=>(n as any).id==='personality-toggle')!;
  await toggle.fire('click');await flush();
  expect(bridgeApi).toHaveBeenLastCalledWith('/action',{action:'personality_select',chat_id:'c1',profile:'auto'});
 });
});

describe('Echo systems panel (systems.js)',()=>{
 const load=()=>harness('systems.js',{window:{EchoPrimeStudio:{}}});
 const healthy:any={health:{ok:true,value:{model:{ok:true,model:MODEL,context_length:262144}}},plugins:{ok:true,value:{}},swarm:{ok:true,value:{configured:true,available:true}},adk:{ok:true,value:{configured:true,available:true}},bots:{ok:true,value:{configured:true,available:true}},browser:{ok:true,value:{configured:true,available:true}}};
 it('reads the fleet schema field `connection` and treats dormant as an expected policy state',()=>{
  const nodes=['quench','forge','anvil','hammer','temper'].map(id=>({id,connection:'connected',reason:id+' answered'})).concat([{id:'crucible',connection:'dormant',reason:'dormant by policy'}] as any);
  const v=load().window.EchoPrimeSystems.verdicts({...healthy,fleet:{ok:true,value:{nodes,summary:{connected:5,dormant:1}}}});
  expect(v.NEXUS).toMatchObject({state:'connected',text:'5 of 6 nodes connected · 1 dormant (policy)'});
  expect(v.NEXUS.reason).toContain('crucible: dormant by policy');
  const down=load().window.EchoPrimeSystems.verdicts({...healthy,fleet:{ok:true,value:{nodes:[{id:'forge',connection:'connected'},{id:'anvil',connection:'offline',reason:'ssh timed out'},{id:'crucible',connection:'dormant'}]}}});
  expect(down.NEXUS).toMatchObject({state:'degraded',text:'1 of 3 nodes connected · 1 dormant (policy)'});expect(down.NEXUS.reason).toContain('anvil: ssh timed out');
 });
 it('never renders an interrupted probe as offline',()=>{
  const sys=load().window.EchoPrimeSystems;
  const abort=Object.assign(new Error('signal is aborted without reason'),{name:'AbortError'});
  expect(sys.interrupted(abort)).toBe(true);expect(sys.interrupted(new Error('Workspace view changed; response discarded.'))).toBe(true);expect(sys.interrupted(new Error('No answer within 12 s'))).toBe(false);
  const v=sys.verdicts({...healthy,health:{ok:false,interrupted:true,error:'signal is aborted without reason'},plugins:{ok:false,interrupted:true,error:'aborted'},fleet:{ok:false,interrupted:true,error:'aborted'}});
  for(const name of ['FORGE','CONTINUITY','CRYSTAL','ESH','PERSONALITY','NEXUS'])expect(v[name],name).toBeUndefined();
  expect(v.SWARM.state).toBe('connected');
 });
 it('re-checks after an account change, which workspace.js announces on window',()=>{
  const h=load();expect(h.events['echo-account-changed']?.length).toBeGreaterThan(0);
 });
});

describe('side panel items that were declared but missing',()=>{
 it('swarm.js adds a real Swarm brain item that picks the Swarm for the next ECHO Code message',async()=>{
  const choose=vi.fn(()=>true);
  const h=harness('swarm.js',{fetch:vi.fn(async()=>({ok:true,status:200,json:async()=>({available:true})})),window:{EchoPrimeModels:{setSwarm:vi.fn(),swarm:()=>false,choose},EchoPrimeChat:{send:vi.fn(),cancel:vi.fn(),reset:vi.fn()}}});
  const item=h.get('#prime-nav').children.find(n=>n.attributes.id==='open-swarm')!;
  expect(item).toBeDefined();expect(item.className).toBe('nav-item');expect(item.attributes['data-owner-only']).toBe('');expect(text(item)).toBe('Swarm brain');
  const kind=h.get('#workspace-chat-kind');kind.value='workspace';const changed=vi.fn();kind.addEventListener('change',changed);
  await item.fire('click');
  expect(choose).toHaveBeenCalledWith('swarm');expect(kind.value).toBe('coding');expect(changed).toHaveBeenCalledTimes(1);
  expect(h.get('#draft-notice').textContent).toMatch(/Swarm/);expect(h.get('#draft-notice').hidden).toBe(false);
 });
 it('swarm.js forwards the Echo conversation options to the chat for every non-Swarm turn',async()=>{
  const send=vi.fn(async()=>({sent:true}));
  const h=harness('swarm.js',{fetch:vi.fn(async()=>({ok:true,status:200,json:async()=>({available:true})})),window:{EchoPrimeModels:{setSwarm:vi.fn(),swarm:()=>false,choose:vi.fn()},EchoPrimeChat:{send,cancel:vi.fn(),reset:vi.fn()}}});
  await h.window.EchoPrimeChat.send('hello',{workspace:{chatId:'c1'}});
  expect(send).toHaveBeenCalledWith('hello',{workspace:{chatId:'c1'}});
 });
 it('fleet.js adds a real Fleet nodes item that opens every node with its state and reason',async()=>{
  class Transport{session=owner;loadSession=async()=>owner;request=vi.fn(async()=>({}));headers=()=>({});}
  const h=harness('fleet.js',{window:{EchoPrimeWorkspaceTransport:Transport,EchoPrimeWorkspace:{ready:Promise.resolve(true),session:owner,enabled:true}}});
  const item=h.get('#prime-nav').children.find(n=>n.attributes.id==='open-fleet')!;
  expect(item).toBeDefined();expect(item.className).toBe('nav-item');expect(text(item)).toBe('Fleet nodes');
  await item.fire('click');
  const dialog=h.document.body.children.find((n:Node)=>n.tagName==='DIALOG')!;
  expect(dialog.open).toBe(true);
  const body=text(dialog);for(const id of ['QUENCH','FORGE','ANVIL','HAMMER','TEMPER','CRUCIBLE'])expect(body).toContain(id);
 });
});

describe('boot admission read under load (workspace-client.js)',()=>{
 const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const anonymousSession={workspaceConfigured:true,authenticated:false,user:null,csrf:null,ownerAccess:false};
 it('retries a 429 on /api/session with backoff and returns the readback',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(json(429,{error:'Too many requests'})).mockResolvedValueOnce(json(429,{error:'Too many requests'})).mockResolvedValue(json(200,anonymousSession));
  const h=harness('workspace-client.js',{fetch});const Transport=h.window.EchoPrimeWorkspaceTransport;
  Transport.SESSION_RETRY_MS=[0,0,0];
  const value=await new Transport({fetch}).loadSession();
  expect(value).toMatchObject({workspaceConfigured:true,authenticated:false});expect(fetch).toHaveBeenCalledTimes(3);
 });
 it('gives up after the bounded attempts and says the host was busy',async()=>{
  const fetch=vi.fn(async()=>json(429,{error:'Too many requests'}));
  const h=harness('workspace-client.js',{fetch});const Transport=h.window.EchoPrimeWorkspaceTransport;
  Transport.SESSION_RETRY_MS=[0,0,0];
  const error=await new Transport({fetch}).loadSession().catch((e:any)=>e);
  expect(error.status).toBe(429);expect(fetch).toHaveBeenCalledTimes(4);
  const other=vi.fn(async()=>json(500,{error:'boom'}));const again=harness('workspace-client.js',{fetch:other}).window.EchoPrimeWorkspaceTransport;again.SESSION_RETRY_MS=[0,0,0];
  expect((await new again({fetch:other}).loadSession().catch((e:any)=>e)).status).toBe(500);expect(other).toHaveBeenCalledTimes(1);// only "too many requests" is retried
 });
 it('the page reports a busy host instead of a dead Workspace when every attempt was refused',async()=>{
  class Transport {session=null;constructor(_o:any){}loadSession=async()=>{throw Object.assign(new Error('Account admission unavailable.'),{status:429});};request=vi.fn();headers=()=>({});clear(){}}
  const h=harness('workspace.js',{window:{EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()}}});
  expect(await h.window.EchoPrimeWorkspace.ready).toBe(false);
  expect(h.get('#workspace-panel-status').textContent).toMatch(/busy/i);expect(h.get('#workspace-panel-status').textContent).toMatch(/Reload/);
 });
});

// Review 2026-11-06 (round 2). A vendor turn forwarded the Workspace's attachment set (Workspace library ids) to /api/chat,
// where only Prime uploads are read, so a ticked Library file silently never reached Claude; the model report was read
// once at boot, so a failed boot read blocked vendor picks for the life of the page and a provider that signed out
// mid-session still read available; and a Google refusal carried no status for the sign-in card to act on.
describe('vendor turns carry attachments explicitly',()=>{
 const UPL='upl_'+'b'.repeat(32);
 const bigChat=()=>({id:'c1',title:'Long',events:[],messages:Array.from({length:6},(_,i)=>({id:'h'+i,role:i%2?'assistant':'user',content:String.fromCharCode(97+i).repeat(3900),created:'2026-11-06T09:00:0'+i+'+00:00'}))});
 function vendor(windowExtra:Record<string,any>={},chat?:any){
  let h!:ReturnType<typeof workspace>;
  const send=vendorChat(()=>h.get('#chat-log'));
  h=workspace({EchoPrimeModels:routeTo({vendor:{id:'claude',label:'Claude (claude CLI)'}}),...windowExtra},chat);h.window.EchoPrimeChat.send=send;
  const base=h.request.getMockImplementation()!;
  const files:Record<string,any>={lib1:{id:'lib1',name:'plan.md',content:'Step one: ship it.',sha256:'9f'.repeat(32),path:'/srv/ws/library/lib1/plan.md'}};
  h.request.mockImplementation(async(path:string,body?:any)=>{if(path.startsWith('/library/')){const item=files[decodeURIComponent(path.slice(9))];if(!item)throw new Error('Library item not found.');return item;}return base(path,body);});
  return {h,send,files};
 }
 it('inlines an attached Workspace library file, passes only Prime uploads on, and names what was sent',async()=>{
  const {h,send}=vendor();await h.ws.ready;await h.ws.bridge.openChat('c1');
  h.ws.bridge.state.attachments.add('lib1');h.ws.bridge.state.attachments.add(UPL);
  const outcome=await h.ws.send('What is step one?');
  expect(outcome).toMatchObject({handled:true,sent:true});
  expect(h.request.mock.calls.map(c=>c[0])).toContain('/library/lib1');
  const options=send.mock.calls[0][1].workspace;
  expect(options.prompt).toContain('plan.md');expect(options.prompt).toContain('Step one: ship it.');expect(options.prompt).toMatch(/untrusted/i);
  expect(options.prompt).not.toContain('/srv/ws/library');expect(options.prompt.endsWith('What is step one?')).toBe(true);
  expect(options.prompt.length).toBeLessThanOrEqual(12000);
  expect(options.attachments).toEqual([UPL]);
  expect(options.note).toContain('plan.md');
 });
 it('refuses, naming the file, when an attached Workspace file cannot be read or does not fit',async()=>{
  const missing=vendor();await missing.h.ws.ready;await missing.h.ws.bridge.openChat('c1');
  missing.h.ws.bridge.state.attachments.add('gone');
  const refused=await missing.h.ws.send('hello');
  expect(refused.sent).toBe(false);expect(refused.detail).toMatch(/Workspace file .*could not be read.*Library item not found.*nothing was sent to Claude \(claude CLI\)/i);
  expect(missing.send).not.toHaveBeenCalled();
  const big=vendor();big.files.lib1.content='x'.repeat(12500);await big.h.ws.ready;await big.h.ws.bridge.openChat('c1');
  big.h.ws.bridge.state.attachments.add('lib1');
  const tooBig=await big.h.ws.send('hello');
  expect(tooBig.sent).toBe(false);expect(tooBig.detail).toMatch(/12,000-character limit/);expect(tooBig.detail).toMatch(/Qwen/);
  expect(big.send).not.toHaveBeenCalled();
 });
 it('leaves room for a Prime upload the server adds, instead of filling the limit with history',async()=>{
  const uploads:Record<string,any>={[UPL]:{id:UPL,name:'notes.txt',type:'text/plain',bytes:5000}};
  const {h,send}=vendor({EchoPrimeLibrary:{uploadById:(id:string)=>uploads[id]||null}},bigChat());
  await h.ws.ready;await h.ws.bridge.openChat('c1');h.ws.bridge.state.attachments.add(UPL);
  await h.ws.send('Compare the notes with what we said.');
  const options=send.mock.calls[0][1].workspace;
  expect(options.attachments).toEqual([UPL]);expect(options.prompt.length).toBeLessThanOrEqual(12000-5000);
  expect(options.note).toMatch(/left out/);
 });
});

describe('the model report is re-read when it matters (models.js)',()=>{
 const rows=(claude:boolean)=>({configured:true,routing:true,default:'qwen',contextTokens:262144,auto:{enabled:false,chains:{}},providers:[
  {id:'qwen',label:'Qwen (FORGE, 256K)',available:true},
  claude?{id:'claude',label:'Claude (claude CLI)',available:true}:{id:'claude',label:'Claude (claude CLI)',available:false,reason:'signed out: the last call failed with "OAuth session expired"'},
  {id:'gpt',label:'GPT (codex CLI)',available:true}]});
 function boot(answer:()=>any){
  const fetch=vi.fn(async()=>{const next=answer();return {ok:next.status<400,status:next.status,json:async()=>next.body};});
  const ws={enabled:true,session:owner,ready:Promise.resolve(true),generalMode:true,ownerHeaders:async()=>({}),invalidate:vi.fn()};
  const h=harness('models.js',{fetch,storage:{'echo-prime-model-v1':'claude'},window:{EchoPrimeWorkspace:ws}});
  const select=descendants(h.get('.composer-toolbar')).find(n=>n.tagName==='SELECT'&&(n as any).id==='model-select')!;
  return {...h,fetch,api:h.window.EchoPrimeModels,claudeOption:()=>select.children.find(n=>n.value==='claude')!.textContent};
 }
 it('re-reads after a failed turn, so a provider that signed out reads unavailable without a reload',async()=>{
  let up=true;
  const h=boot(()=>({status:200,body:rows(up)}));await h.api.ready;
  expect(h.claudeOption()).toBe('Claude (claude CLI)');
  up=false;h.emit('echo-model-outcome');await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);expect(h.claudeOption()).toBe('Claude (claude CLI) (unavailable)');
 });
 it('marks a pick blocked by a failed status read as retryable',async()=>{
  const h=boot(()=>({status:500,body:{error:'busy'}}));await h.api.ready;
  const route=h.api.conversationRoute();
  expect(route.blocked).toMatch(/Claude \(claude CLI\).*Nothing was sent/);expect(route.retry).toBe(true);
 });
});

describe('a blocked pick re-reads the model status once before refusing (workspace.js)',()=>{
 it('reads the status again and answers with the pick when it now confirms',async()=>{
  let h!:ReturnType<typeof workspace>;
  const send=vendorChat(()=>h.get('#chat-log'));
  const conversationRoute=vi.fn().mockReturnValueOnce({blocked:'Model status is unavailable.',retry:true}).mockReturnValue({vendor:{id:'claude',label:'Claude (claude CLI)'}});
  const refresh=vi.fn(async()=>{});
  h=workspace({EchoPrimeModels:{ready:Promise.resolve(),conversationRoute,refresh}});h.window.EchoPrimeChat.send=send;
  await h.ws.ready;await h.ws.bridge.openChat('c1');
  expect(await h.ws.send('hello')).toMatchObject({handled:true,sent:true});
  expect(refresh).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);expect(h.chatTurn).not.toHaveBeenCalled();
 });
 it('refuses after one re-read that still cannot confirm the pick',async()=>{
  const refresh=vi.fn(async()=>{});
  const h=workspace({EchoPrimeModels:{ready:Promise.resolve(),conversationRoute:()=>({blocked:'Model status is unavailable.',retry:true}),refresh}});
  await h.ws.ready;await h.ws.bridge.openChat('c1');
  expect(await h.ws.send('hello')).toEqual({handled:true,sent:false,detail:'Model status is unavailable.'});
  expect(refresh).toHaveBeenCalledTimes(1);expect(h.chatTurn).not.toHaveBeenCalled();
 });
});

describe('chat.js sends only the attachments it was handed and reports a failed turn',()=>{
 const UPL='upl_'+'c'.repeat(32);
 function chat(answer:any){
  const bodies:any[]=[];
  const fetch=vi.fn(async(path:string,init:any)=>{if(path.endsWith('/status'))return {ok:true,status:200,json:async()=>({chat:{state:'attached'}})};bodies.push(JSON.parse(init.body));return {ok:true,status:200,json:async()=>answer};});
  const h=harness('chat.js',{fetch,window:{EchoPrimeActivity:{start:()=>({thinking(){},done(){},fail(){}}),clear(){}},EchoPrimeModels:{provider:()=>'claude',model:()=>undefined,describe:()=>'',label:()=>'Claude (claude CLI)'},EchoPrimeWorkspace:{ownerHeaders:async()=>({}),bridge:{state:{attachments:new Set(['lib1',UPL])}}}}});
  const outcomes=vi.fn();h.window.addEventListener('echo-model-outcome',outcomes);
  return {...h,bodies,outcomes,api:h.window.EchoPrimeChat};
 }
 const done={status:'completed',sessionId:'33333333-3333-4333-8333-333333333333',answer:'ok',evidence:[]};
 it('never forwards the Workspace attachment set on an Echo conversation turn',async()=>{
  const h=chat(done);
  await h.api.send('q',{workspace:{chatId:'c1',prompt:'q',attachments:[UPL]}});
  expect(h.bodies[0].attachments).toEqual([UPL]);
  await h.api.send('q2',{workspace:{chatId:'c1',prompt:'q2'}});
  expect(h.bodies[1]).not.toHaveProperty('attachments');
  expect(h.outcomes).not.toHaveBeenCalled();
 });
 it('announces a failed turn so the model report is read again',async()=>{
  const h=chat({...done,status:'failed',answer:'Claude (claude CLI) is unavailable: OAuth session expired'});
  await h.api.send('q');
  expect(h.outcomes).toHaveBeenCalledTimes(1);
 });
});

describe('a refused account request keeps its HTTP status (workspace-client.js)',()=>{
 it('attaches the status to the error so the sign-in card can tell a refusal from an outage',async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({error:'Sign-in failed.'}),{status:401,headers:{'content-type':'application/json'}}));
  const Transport=harness('workspace-client.js',{fetch}).window.EchoPrimeWorkspaceTransport;
  const error=await new Transport({fetch}).auth('login',{provider:'google',id_token:'eyJ.fixture'}).catch((e:any)=>e);
  expect(error.message).toBe('Sign-in failed.');expect(error.status).toBe(401);
 });
});
