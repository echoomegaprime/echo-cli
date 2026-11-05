import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// The browser is the boundary here: execute the shipped controllers with a small
// DOM/event harness, keeping network and Workspace admission explicitly synthetic.
class Node {
 textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;inert=false;isConnected=true;
 tagName:string;dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};files:any[]=[];
 classList={add:vi.fn(),remove:vi.fn(),toggle:vi.fn(),contains:()=>false};
 style={setProperty:vi.fn()};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:Node[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this.append(...items);}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key==='value')this.value=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},target:this,...event});}
 showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}
 focus(){} before(){} scrollIntoView(){} click(){return this.fire('click');}
 querySelector(selector:string):Node|null{return this.children.find(n=>n.tagName.toLowerCase()===selector)||this.children.map(n=>n.querySelector(selector)).find(Boolean)||null;}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
}
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
function deferred<T=any>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function harness(file:string|string[],options:Record<string,any>={}){
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},documentEvents:Record<string,((event:any)=>unknown)[]>={};
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector)!;};
 const stored=new Map([['echo-prime-interface-v1',JSON.stringify({drafts:[{id:'owner-old',text:'OWNER PRIVATE LEGACY'}],palette:'aurora'})]]);
 const storage={getItem:(key:string)=>stored.get(key)||null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)};
 const window:any={addEventListener:(name:string,callback:(event:any)=>unknown)=>(events[name]??=[]).push(callback),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);},EchoPrimeChat:{reset:vi.fn(),send:vi.fn(async()=>({sent:true,detail:'coding reply'}))},EchoPrimeOrb:{mount:()=>({motion:true,setPalette(){},setQuality(){},setMotion(){},destroy(){}})},...options.window};
 const document:any={hidden:false,head:new Node(),querySelector:get,querySelectorAll:(selector:string)=>options.lists?.[selector]||[],createElement:(tag:string)=>new Node(tag),createTextNode:(text:string)=>Object.assign(new Node('text'),{textContent:text}),createElementNS:(_ns:string,tag:string)=>new Node(tag),addEventListener:(name:string,callback:(event:any)=>unknown)=>(documentEvents[name]??=[]).push(callback)};
 const context={window,document,localStorage:storage,matchMedia:()=>({matches:false,addEventListener(){}}),navigator:{userAgent:'fixture'},location:{protocol:'http:'},crypto:{randomUUID},setTimeout,clearTimeout,AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,console:{debug:vi.fn()},fetch:options.fetch||vi.fn(),...options.globals};
 for(const name of [file].flat())runInNewContext(source(name),context);
 return {get,nodes,window,stored,document,emit:(type:string)=>window.dispatchEvent(new Event(type)),emitDocument:(type:string)=>{for(const fn of documentEvents[type]||[])fn(new Event(type));}};
}
function descendants(node:Node):Node[]{return node.children.flatMap(child=>[child,...descendants(child)]);}
function workspaceHarness(request=vi.fn(async(path:string,body?:any)=>path==='/state'?{chats:[],projects:[],library:[],preferences:[],personalities:[]}:path==='/import'?{id:'imported'}:path==='/auth/accounts'?{accounts:[{uid:'member',email:'member@example.test',role:'member',status:'pending'}]}:path.startsWith('/chats/')?{id:path.slice(7),messages:[]}:{}),globals:Record<string,any>={}){
 let identity!:(session:any)=>void;
 const session={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
 class Transport {session=session;constructor(options:any){identity=options.onIdentityChange;}loadSession=async()=>this.session;request=request;chat=async(input:any)=>({id:input.chat_id,messages:[{id:'reply',role:'assistant',content:'synthetic reply'}]});text=async()=>'';audio=async()=>new Blob();headers=()=>({'x-echo-csrf':'owner'});clear(){identity(null);}auth=async()=>({google_login_enabled:false});}
 const h=harness('workspace.js',{window:{EchoPrimeWorkspaceTransport:Transport},globals});h.get('#workspace-chat-kind').value='workspace';
 const find=(label:string)=>descendants(h.get('#workspace-panel-content')).find(n=>n.tagName==='BUTTON'&&n.children.some(c=>c.textContent===label))!;
 return {...h,request,find,change:()=>identity({...session,user:{uid:'member',role:'member',status:'approved'},ownerAccess:false})};
}

it('waits for canonical readiness and sends general messages without persisting private drafts',async()=>{
 const admission=deferred(),send=vi.fn(async()=>({handled:true,sent:true,detail:'saved canonical reply'}));
 const h=harness('app.js',{window:{EchoPrimeWorkspace:{ready:admission.promise,enabled:true,generalMode:true,send,newChat:vi.fn(async()=>true)}}});
 h.get('#prompt').value='member private message';const pending=h.get('#composer').fire('submit');
 await Promise.resolve();expect(send).not.toHaveBeenCalled();
 admission.resolve(true);await pending;
 expect(send).toHaveBeenCalledWith('member private message');expect(h.window.EchoPrimeChat.send).not.toHaveBeenCalled();
 expect([...h.stored.values()].join('')).not.toContain('member private message');expect([...h.stored.values()].join('')).not.toContain('OWNER PRIVATE LEGACY');
 expect(h.get('#history').children.some(n=>n.textContent.includes('OWNER PRIVATE LEGACY'))).toBe(false);
});
it('clears a private prompt on identity change and discards a late composer outcome',async()=>{
 const result=deferred(),send=vi.fn(()=>result.promise),h=harness('app.js',{window:{EchoPrimeWorkspace:{ready:Promise.resolve(true),enabled:true,generalMode:true,send,newChat:vi.fn()}}});
 h.get('#prompt').value='account A private';const pending=h.get('#composer').fire('submit');await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));
 h.emit('echo-account-changed');result.resolve({handled:true,sent:true,detail:'OLD ACCOUNT RECEIPT'});await pending;
 expect(h.get('#prompt').value).toBe('');expect(h.get('#draft-notice').textContent).not.toContain('OLD ACCOUNT RECEIPT');
 expect(h.get('#toast').textContent).not.toContain('OLD ACCOUNT RECEIPT');
});
it('binds coding status and sends to current canonical owner headers',async()=>{
 const fetch=vi.fn(async(path:string)=>({ok:true,json:async()=>path.endsWith('status')?{chat:{state:'attached'}}:{status:'completed',sessionId:'fixture',answer:'answer'}}));
 const headers=vi.fn(async()=>({'x-echo-csrf':'current-owner'}));
 const h=harness('chat.js',{fetch,window:{EchoPrimeWorkspace:{ownerHeaders:headers}}});
 expect((await h.window.EchoPrimeChat.send('code')).sent).toBe(true);
 expect(fetch.mock.calls).toHaveLength(2);for(const call of fetch.mock.calls as any[])expect(call[1].headers['x-echo-csrf']).toBe('current-owner');
});
it('clears coding results and rejects a late owner response after account change',async()=>{
 const done=deferred(),fetch=vi.fn(async(path:string)=>path.endsWith('status')?{ok:true,json:async()=>({chat:{state:'attached'}})}:done.promise);
 const h=harness('chat.js',{fetch,window:{EchoPrimeWorkspace:{ownerHeaders:async()=>({'x-echo-csrf':'owner'})}}}),pending=h.window.EchoPrimeChat.send('private code');
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));h.emit('echo-account-changed');done.resolve({ok:true,json:async()=>({status:'completed',sessionId:'old',answer:'PRIVATE OLD ANSWER'})});
 expect(await pending).toMatchObject({cancelled:true});expect(h.get('#chat-log').children).toEqual([]);
});
it('revokes a pending creative review and clears its private prompt on identity change',async()=>{
 const done=deferred(),fetch=vi.fn(()=>done.promise),tool={id:'echo.media.image_generate',category:'image',description:'fixture',health:'unknown'};
 const h=harness('integrations.js',{fetch,window:{EchoPrimeCatalog:{capabilities:[tool],models:[]},EchoPrimeWorkspace:{ownerHeaders:async()=>({'x-echo-csrf':'owner'})}}});
 h.window.EchoPrimeStudio.open('image','private image');const pending=h.get('#prepare-creative').fire('click');await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
 h.emit('echo-account-changed');done.resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>({id:'old-ticket',digest:'old',request:{prompt:'PRIVATE REVIEW'},cost:'fixture'})});await pending;
 expect(h.get('#creative-prompt').value).toBe('');expect(h.get('#review-dialog').open).toBe(false);expect(h.get('#request-review').textContent).not.toContain('PRIVATE REVIEW');
 await h.get('#execute-request').fire('click');expect(fetch).toHaveBeenCalledTimes(1);
});
it('clears Steward inventory and ignores late advice after identity changes',async()=>{
 const done=deferred(),inventory={state:'connected',nodes:[{id:'fixture',advisoryAvailable:true,runtime:{},evaluation:{}}]};
 const fetch=vi.fn(async(path:string)=>path.endsWith('status')?{ok:true,json:async()=>inventory}:done.promise);
 const h=harness('steward.js',{fetch,window:{EchoPrimeWorkspace:{ownerHeaders:async()=>({'x-echo-csrf':'owner'})}}});
 await h.get('#open-steward').fire('click');h.get('#steward-text').value='private incident';const pending=h.get('#steward-form').fire('submit');await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 h.emit('echo-account-changed');done.resolve({ok:true,json:async()=>({text:'PRIVATE ADVICE'})});await pending;
 expect(h.get('#steward-text').value).toBe('');expect(h.get('#steward-nodes').children).toEqual([]);expect(h.get('#steward-result').textContent).not.toContain('PRIVATE ADVICE');expect(h.get('#steward-submit').disabled).toBe(true);
});
it('normalizes the selected ChatGPT branch into the canonical import messages contract',async()=>{
 const h=workspaceHarness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');
 const fields=descendants(h.get('#workspace-panel-content')),text=fields.find(n=>n.tagName==='TEXTAREA'&&n.attributes.maxlength==='1500000')!;
 text.value=JSON.stringify({title:'branch',current_node:'b',mapping:{a:{parent:null,message:{author:{role:'user'},content:{parts:['selected user']}}},b:{parent:'a',message:{author:{role:'assistant'},content:{parts:['selected answer']}}},c:{parent:'a',message:{author:{role:'assistant'},content:{parts:['UNSELECTED PRIVATE BRANCH']}}}}});
 await h.find('Import').fire('click');
 const call=h.request.mock.calls.find((c:any)=>c[0]==='/import') as any[];
 expect(call[1]).toMatchObject({source:'chatgpt',messages:[{role:'user',content:'selected user'},{role:'assistant',content:'selected answer'}]});expect(call[1]).not.toHaveProperty('content');expect(JSON.stringify(call[1])).not.toContain('UNSELECTED');
});
it('never restores an old account file after a pending local file read completes',async()=>{
 const h=workspaceHarness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');
 const fields=descendants(h.get('#workspace-panel-content')),file=fields.find(n=>n.attributes.type==='file')!,text=fields.find(n=>n.tagName==='TEXTAREA')!,done=deferred<string>();
 file.files=[{name:'private.md',size:12,text:()=>done.promise}];const pending=file.fire('change');h.change();done.resolve('OLD ACCOUNT FILE');await pending;
 expect(text.value).not.toContain('OLD ACCOUNT FILE');expect(h.get('#workspace-panel-content').children).toEqual([]);
});
it('reviews a primary owner account decision and sends only its exact canonical UID/decision',async()=>{
 const h=workspaceHarness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('account');
 await h.find('Approve account').fire('click');expect(h.request.mock.calls.some((c:any)=>c[0]==='/auth/decide')).toBe(false);
 await h.find('Confirm this account decision').fire('click');
 expect(h.request.mock.calls.find((c:any)=>c[0]==='/auth/decide')?.[1]).toEqual({uid:'member',decision:'approve'});
});
it('stops a pending speech start before an old audio artifact can play',async()=>{
 const done=deferred(),play=vi.fn(),chat={id:'voice-chat',messages:[{id:'answer',role:'assistant',content:'Saved answer'}]};
 const request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'?chat:path==='/voice/start'?done.promise:{});
 const h=workspaceHarness(request,{Audio:class {play=play;pause(){}addEventListener(){}}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');
 const reply=descendants(h.get('#workspace-panel-content')).filter(n=>n.tagName==='SELECT').at(-1)!;reply.value='answer';
 const pending=h.find('Listen').fire('click');await vi.waitFor(()=>expect(request.mock.calls.some(c=>c[0]==='/voice/start')).toBe(true));await h.find('Stop speech').fire('click');
 done.resolve({audio_url:'/api/voice/audio/fixture',session_id:'speech',chunk_index:0,has_more:false});await pending;expect(play).not.toHaveBeenCalled();
});
it('dispatches echo-account-changed only on a real identity change: anonymous re-reads and invalidations are silent, a sign-in fires once',async()=>{
 // The shipped transport runs here too, because the 2026-11-04 request storm was the pair of them:
 // an owner-only 401 -> invalidate() -> /api/session re-read -> echo-account-changed -> refetch -> 401 ...
 const anonymous={workspaceConfigured:true,authenticated:false,ownerAccess:false,csrf:null,user:null},owner={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'csrf-owner',user:{uid:'owner',role:'owner',status:'approved'}};
 let current:any=anonymous;
 const fetch=vi.fn(async(url:string)=>{if(url!=='/api/session')throw new Error('unexpected '+url);return new Response(JSON.stringify(current),{status:200,headers:{'content-type':'application/json'}});});
 const h=harness(['workspace-client.js','workspace.js'],{window:{fetch}}),dispatched=vi.fn();h.window.addEventListener('echo-account-changed',dispatched);
 const ws=h.window.EchoPrimeWorkspace;await ws.ready;
 expect(fetch).toHaveBeenCalledTimes(1);expect(ws.session).toMatchObject({authenticated:false});expect(ws.enabled).toBe(true);
 expect(dispatched).not.toHaveBeenCalled();// the first readback is an observation, not a change; every module bootstraps from the session itself
 expect(h.get('#draft-notice').hidden).toBe(false);expect(h.get('#draft-notice').textContent).toContain('Sign in');
 for(let i=0;i<5;i++){ws.invalidate();await expect(ws.ownerHeaders()).rejects.toThrow('Primary owner admission required.');}
 expect(fetch).toHaveBeenCalledTimes(6);expect(dispatched).not.toHaveBeenCalled();
 expect(h.get('#draft-notice').hidden).toBe(false);// an unchanged anonymous identity must not wipe the visitor's page either
 current=owner;await ws.ownerHeaders();expect(dispatched).toHaveBeenCalledTimes(1);// anonymous -> owner
 await ws.ownerHeaders();await ws.ownerHeaders();expect(dispatched).toHaveBeenCalledTimes(1);// owner -> owner
 ws.invalidate();expect(dispatched).toHaveBeenCalledTimes(2);expect(ws.session).toBeNull();// owner -> signed out is a real change
 ws.invalidate();expect(dispatched).toHaveBeenCalledTimes(2);
 expect(h.get('.profile > span:nth-child(2)').textContent).toBe('Sign in');
});
it('hides owner entry points on the initial anonymous configured session',async()=>{
 class Transport {session=null;loadSession=async()=>({workspaceConfigured:true,authenticated:false,ownerAccess:false,user:null});}
 const h=harness('workspace.js',{window:{EchoPrimeWorkspaceTransport:Transport}});await h.window.EchoPrimeWorkspace.ready;
 expect(h.get('#open-steward').hidden).toBe(true);expect(h.get('#workspace-chat-kind option[value="coding"]').disabled).toBe(true);expect(h.get('.profile > span:nth-child(2)').textContent).toBe('Sign in');
 expect(h.get('#welcome-audience').textContent).toBe('together?');
});
it('invalidates every private surface when a coding operation loses owner admission',async()=>{
 const invalidate=vi.fn(),fetch=vi.fn(async()=>({ok:false,status:403,json:async()=>({error:'Revoked'})}));
 const h=harness('chat.js',{fetch,window:{EchoPrimeWorkspace:{ownerHeaders:async()=>({'x-echo-csrf':'owner'}),invalidate}}});
 await h.window.EchoPrimeChat.send('private prompt');expect(invalidate).toHaveBeenCalledTimes(1);
});
it('clears private Workspace content before a page is retained in the browser back cache',async()=>{
 const h=workspaceHarness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');expect(h.get('#workspace-panel-content').children.length).toBeGreaterThan(0);
 h.emit('pagehide');expect(h.get('#workspace-panel-content').children.length).toBe(0);expect(h.get('#chat-log').children.length).toBe(0);
});
it('requests a microphone only after explicit Dictate and stops a late permission stream on account change',async()=>{
 const grant=deferred(),stop=vi.fn(),getUserMedia=vi.fn(()=>grant.promise),request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'?{id:'dictate',messages:[]}:{});
 const h=workspaceHarness(request,{navigator:{mediaDevices:{getUserMedia},userAgent:'fixture'}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');expect(getUserMedia).not.toHaveBeenCalled();
 const pending=h.find('Dictate a message').fire('click');await vi.waitFor(()=>expect(getUserMedia).toHaveBeenCalledTimes(1));h.change();grant.resolve({getTracks:()=>[{stop}]});await pending;
 expect(stop).toHaveBeenCalledTimes(1);expect(request.mock.calls.some(c=>c[0]==='/voice/transcribe')).toBe(false);
});
it('requires exact ESH command review and drops it when the current account changes',async()=>{
 const h=workspaceHarness();await h.window.EchoPrimeWorkspace.ready;await h.get('#workspace-open-esh').fire('click');
 h.get('#workspace-esh-command').value='Get-Location';await h.get('#workspace-esh-review').fire('click');
 h.change();await h.get('#workspace-esh-run').fire('click');
 expect(h.get('#workspace-esh-command').value).toBe('');expect(h.get('#workspace-esh').hidden).toBe(true);expect(h.request.mock.calls.some(c=>c[0]==='/action')).toBe(false);
});
it('supports keyboard floating and docking of ESH without storing command content',async()=>{
 const h=workspaceHarness(undefined,{innerWidth:1200,innerHeight:800});await h.window.EchoPrimeWorkspace.ready;await h.get('#workspace-open-esh').fire('click');
 await h.get('#workspace-esh-grip').fire('keydown',{key:'ArrowRight'});expect(h.get('#workspace-esh-float').textContent).toBe('Dock');
 await h.get('#workspace-esh-float').fire('click');expect(h.get('#workspace-esh-float').textContent).toBe('Float');
 expect([...h.stored.values()].join('')).not.toContain('Get-Location');
});
it('encodes bounded synthetic captured samples as canonical PCM WAV and leaves the transcript for manual review',async()=>{
 let processor:any;const stop=vi.fn(),close=vi.fn(async()=>{}),stream={getTracks:()=>[{stop}]},request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'?{id:'dictation',messages:[]}:path==='/voice/transcribe'?{provider:'elevenlabs-scribe',text:'synthetic reviewed transcript'}:{});
 const audioNode=()=>({connect(){},disconnect(){}});
 const h=workspaceHarness(request,{navigator:{mediaDevices:{getUserMedia:async()=>stream},userAgent:'fixture'},btoa:(text:string)=>Buffer.from(text,'binary').toString('base64')});
 h.window.AudioContext=class {sampleRate=16000;destination={};close=close;resume=async()=>{};createMediaStreamSource=audioNode;createScriptProcessor=()=>processor={...audioNode(),onaudioprocess:null};createGain=()=>({...audioNode(),gain:{value:0}});};
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');await h.find('Dictate a message').fire('click');
 processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(.15)}});await h.find('Finish and transcribe').fire('click');
 const call=request.mock.calls.find(c=>c[0]==='/voice/transcribe') as any[];expect(call).toBeDefined();const wav=Buffer.from(call[1].audio_b64,'base64');
 expect(wav.toString('ascii',0,4)).toBe('RIFF');expect(wav.readUInt16LE(22)).toBe(1);expect(wav.readUInt32LE(24)).toBe(16000);expect(wav.readUInt16LE(34)).toBe(16);expect(wav.readUInt32LE(40)).toBe(8192);expect(wav.length).toBeLessThanOrEqual(262144);
 expect(stop).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);expect(h.get('#prompt').value).toBe('synthetic reviewed transcript');expect(request.mock.calls.some(c=>c[0]==='/chat')).toBe(false);
});
it('dispatches one reviewed ESH request and reads back its saved conversation receipt',async()=>{
 const chat={id:'shell-chat',messages:[],events:[]},request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[]}:path==='/chats'||path==='/chats/shell-chat'?chat:path==='/action'?{ok:true,exit:0,stdout:'fixture location'}:{}),h=workspaceHarness(request);
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.get('#workspace-open-esh').fire('click');h.get('#workspace-esh-command').value='Get-Location';await h.get('#workspace-esh-review').fire('click');
 expect(request.mock.calls.some(c=>c[0]==='/action')).toBe(false);await h.get('#workspace-esh-run').fire('click');await h.get('#workspace-esh-run').fire('click');
 const writes=request.mock.calls.filter(c=>c[0]==='/action') as any[][];expect(writes).toHaveLength(1);expect(writes[0][1]).toMatchObject({action:'esh',command:'Get-Location',chat_id:'shell-chat'});expect(writes[0][1].request_id).toMatch(/^[a-f0-9-]{36}$/);expect(request.mock.calls.some(c=>c[0]==='/chats/shell-chat')).toBe(true);
});
it('sends only after explicit auto-send opt-in and keeps voice preferences off at startup',async()=>{
 let processor:any;const chat={id:'opt-in',messages:[],events:[]},request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'||path==='/chats/opt-in'?chat:path==='/voice/transcribe'?{provider:'elevenlabs-scribe',text:'opted in message'}:{});
 const h=workspaceHarness(request,{navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},userAgent:'fixture'},btoa:(text:string)=>Buffer.from(text,'binary').toString('base64')});
 const audioNode=()=>({connect(){},disconnect(){}});h.window.AudioContext=class {sampleRate=16000;destination={};close=async()=>{};resume=async()=>{};createMediaStreamSource=audioNode;createScriptProcessor=()=>processor={...audioNode(),onaudioprocess:null};createGain=()=>({...audioNode(),gain:{value:0}});};
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');
 const toggle=descendants(h.get('#workspace-panel-content')).find(n=>n.attributes.id==='workspace-voice-auto-send')!;expect(toggle).toBeDefined();expect(toggle.checked).not.toBe(true);toggle.checked=true;await toggle.fire('change');
 await h.find('Dictate a message').fire('click');processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(.15)}});await h.find('Finish and transcribe').fire('click');
 expect(h.get('#prompt').value).toBe('');expect(h.get('#workspace-panel-status').textContent).toContain('sent');
});
it('uses canonical summary mode only after explicit brief spoken-reply opt-ins',async()=>{
 let ended!:()=>void;const play=vi.fn(async()=>{}),chat={id:'spoken',messages:[{id:'reply',role:'assistant',content:'saved reply'}],events:[]},request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'||path==='/chats/spoken'?chat:path==='/voice/start'?{audio_url:'/api/voice/audio/fixture',session_id:'speech',chunk_index:0,has_more:false}:{});
 const h=workspaceHarness(request,{Audio:class {play=play;pause(){}addEventListener(type:string,fn:()=>void){if(type==='ended')ended=fn;}removeEventListener(){}}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');
 for(const id of ['workspace-voice-spoken','workspace-voice-brief']){const toggle=descendants(h.get('#workspace-panel-content')).find(n=>n.attributes.id===id)!;expect(toggle).toBeDefined();expect(toggle.checked).not.toBe(true);toggle.checked=true;await toggle.fire('change');}
 const pending=h.window.EchoPrimeWorkspace.send('new prompt');await vi.waitFor(()=>expect(play).toHaveBeenCalledTimes(1));ended();await pending;
 const call=request.mock.calls.find(c=>c[0]==='/voice/start') as any[];expect(call[1]).toMatchObject({chat_id:'spoken',message_id:'reply',mode:'summary',read_identifiers:false});expect(call[1].request_id).toMatch(/^[a-f0-9-]{36}$/);
});
it('opens a saved canonical code review from a private library file',async()=>{
 const request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],personalities:[],library:[{id:'source',name:'fixture.py',project_id:'project'}]}:path==='/library/source'?{name:'fixture.py',content:'print(1)',project_id:'project'}:path==='/review'||path==='/chats/reviewed'?{id:'reviewed',messages:[]}:{}),h=workspaceHarness(request);
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');const action=h.find('Review code');expect(action).toBeDefined();await action.fire('click');
 expect(request.mock.calls.find(c=>c[0]==='/review')?.[1]).toEqual({name:'fixture.py',content:'print(1)',project_id:'project'});expect(request.mock.calls.some(c=>c[0]==='/chats/reviewed')).toBe(true);
});
it('cancels opted-in late speech on visibility loss without starting a microphone',async()=>{
 const done=deferred(),play=vi.fn(),getUserMedia=vi.fn(),chat={id:'hidden',messages:[{id:'reply',role:'assistant',content:'saved'}]},request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'||path==='/chats/hidden'?chat:path==='/voice/start'?done.promise:{});
 const h=workspaceHarness(request,{Audio:class {play=play;pause(){}addEventListener(){}removeEventListener(){}},navigator:{mediaDevices:{getUserMedia},userAgent:'fixture'}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');
 const toggle=descendants(h.get('#workspace-panel-content')).find(n=>n.attributes.id==='workspace-voice-spoken')!;toggle.checked=true;await toggle.fire('change');const pending=h.window.EchoPrimeWorkspace.send('prompt');await vi.waitFor(()=>expect(request.mock.calls.some(c=>c[0]==='/voice/start')).toBe(true));
 h.document.hidden=true;h.emitDocument('visibilitychange');done.resolve({audio_url:'/api/voice/audio/fixture',session_id:'speech',chunk_index:0,has_more:false});await pending;expect(play).not.toHaveBeenCalled();expect(getUserMedia).not.toHaveBeenCalled();
});
it('bounds an explicitly started hands-free conversation to ten captures before explicit resume',async()=>{
 let processor:any,grants=0;const chat={id:'bounded',messages:[{id:'reply',role:'assistant',content:'saved'}]},getUserMedia=vi.fn(async()=>{if(++grants>11)throw new Error('fixture budget exceeded');return {getTracks:()=>[{stop(){}}]};}),request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'||path==='/chats/bounded'?chat:path==='/voice/start'?{audio_url:'/api/voice/audio/fixture',session_id:'speech',chunk_index:0,has_more:false}:path==='/voice/transcribe'?{provider:'elevenlabs-scribe',text:'synthetic turn'}:{});
 const audioNode=()=>({connect(){},disconnect(){}}),h=workspaceHarness(request,{navigator:{mediaDevices:{getUserMedia},userAgent:'fixture'},btoa:(text:string)=>Buffer.from(text,'binary').toString('base64'),setTimeout:(fn:()=>void,delay:number)=>setTimeout(fn,delay===300?0:delay),Audio:class {events:Record<string,()=>void>={};addEventListener(type:string,fn:()=>void){this.events[type]=fn;}removeEventListener(type:string){delete this.events[type];}play=async()=>{queueMicrotask(()=>this.events.ended?.());};pause(){}}});
 // Eight seconds of speech followed by two seconds of silence ends each capture (the cap is now two minutes).
 h.window.AudioContext=class {sampleRate=16000;destination={};close=async()=>{};resume=async()=>{processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(128000).fill(.15)}});processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(32000)}});};createMediaStreamSource=audioNode;createScriptProcessor=()=>processor={...audioNode(),onaudioprocess:null};createGain=()=>({...audioNode(),gain:{value:0}});};
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');expect(getUserMedia).not.toHaveBeenCalled();await h.find('Start voice conversation · up to ten turns').fire('click');
 await vi.waitFor(()=>expect(h.get('#workspace-panel-status').textContent).toContain('paused after ten turns'),{timeout:4000});expect(getUserMedia).toHaveBeenCalledTimes(10);expect(request.mock.calls.filter(c=>c[0]==='/voice/start')).toHaveLength(10);
});
it('reports rejected audio playback as unavailable and releases the player instead of claiming Playing',async()=>{
 const pause=vi.fn(),play=vi.fn(async()=>{throw new Error('synthetic autoplay rejection');}),chat={id:'rejected-audio',messages:[{id:'reply',role:'assistant',content:'saved reply'}]},request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'?chat:path==='/voice/start'?{audio_url:'/api/voice/audio/fixture',session_id:'speech',chunk_index:0,has_more:false}:{});
 const h=workspaceHarness(request,{Audio:class {play=play;pause=pause;addEventListener(){}removeEventListener(){}}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.window.EchoPrimeWorkspace.open('voice');
 const reply=descendants(h.get('#workspace-panel-content')).filter(n=>n.tagName==='SELECT').at(-1)!;reply.value='reply';await h.find('Listen').fire('click');
 expect(play).toHaveBeenCalledTimes(1);expect(pause).toHaveBeenCalledTimes(1);expect(h.get('#workspace-panel-status').textContent).toContain('Audio playback was unavailable');expect(h.get('#workspace-panel-status').textContent).not.toContain('Playing');
 expect(request.mock.calls.filter(c=>c[0]==='/voice/start')).toHaveLength(1);
});
it('keeps saved history buttons usable after closing a Workspace panel and opening another saved chat',async()=>{
 const chats=[{id:'first',title:'First saved'},{id:'second',title:'Second saved'}],request=vi.fn(async(path:string)=>path==='/state'?{chats,projects:[],library:[],preferences:[],personalities:[]}:path.startsWith('/chats/')?{id:path.slice(7),title:path.endsWith('first')?'First saved':'Second saved',messages:[{role:'assistant',content:'Saved canonical answer'}]}:{}),h=workspaceHarness(request);
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');const first=h.get('#history').children[0],second=h.get('#history').children[1];h.get('#workspace-dialog').close();
 await first.fire('click');expect(request.mock.calls.some(c=>c[0]==='/chats/first')).toBe(true);expect(h.get('#conversation-title').textContent).toBe('First saved');expect(h.get('#chat-log').children.length).toBe(1);
 await second.fire('click');expect(request.mock.calls.some(c=>c[0]==='/chats/second')).toBe(true);expect(h.get('#conversation-title').textContent).toBe('Second saved');
});
function outageAccountHarness(ambiguous=false,readback:'anonymous'|'unavailable'|'authenticated'='anonymous'){
 let phase='healthy',identity!:(session:any)=>void,sessionReads=0;const request=vi.fn(async(path:string)=>{
  if(path==='/state')return {chats:[{id:'private',title:'PRIVATE ACCOUNT HISTORY'}],projects:[],library:[],personalities:[]};
  if(path==='/auth/logout'){if(ambiguous)throw new Error('synthetic network outcome unknown');phase='anonymous';transport.clear();return {ok:true};}return {};
 });let transport:any;
 class Transport {
  session:any=null;canLogout=false;
  constructor(options:any){identity=options.onIdentityChange;transport=this;}
  async loadSession(){sessionReads++;if(phase==='outage'||phase==='anonymous'&&readback==='unavailable'){this.session=null;identity(null);throw new Error('synthetic issuer unavailable');}if(phase==='anonymous'&&readback==='anonymous'){return this.session={workspaceConfigured:true,authenticated:false,user:null,csrf:null,ownerAccess:false};}this.canLogout=true;this.session={workspaceConfigured:true,authenticated:true,csrf:'logout-proof-fixture',ownerAccess:true,user:{uid:'owner',name:'PRIVATE ACCOUNT NAME',role:'owner',status:'approved'}};if(phase==='anonymous')identity(this.session);return this.session;}
  request=request;auth=async()=>({google_login_enabled:false});headers=()=>({});
  clear(){this.canLogout=false;this.session=null;identity(null);}
 }
 const h=harness('workspace.js',{window:{EchoPrimeWorkspaceTransport:Transport}}),find=(label:string)=>descendants(h.get('#workspace-panel-content')).find(n=>n.tagName==='BUTTON'&&n.children.some(c=>c.textContent===label));
 return {...h,find,request,outage:()=>{phase='outage';},sessionReads:()=>sessionReads};
}
it('offers generic local sign-out during issuer outage and verifies anonymous readback before showing sign-in',async()=>{
 const h=outageAccountHarness();await h.window.EchoPrimeWorkspace.ready;h.outage();await h.window.EchoPrimeWorkspace.open('account');
 const view=descendants(h.get('#workspace-panel-content')).map(n=>n.textContent).join(' ');expect(view).not.toContain('PRIVATE ACCOUNT');expect(h.get('#history').children.length).toBe(0);
 const signOut=h.find('Sign out locally');expect(signOut).toBeDefined();expect(h.get('#workspace-panel-status').textContent).toContain('Session verification is unavailable');const before=h.sessionReads();await signOut!.fire('click');
 expect(h.request.mock.calls.filter(c=>c[0]==='/auth/logout')).toHaveLength(1);expect(h.sessionReads()).toBeGreaterThan(before);expect(h.find('Sign in')).toBeDefined();expect(h.get('#workspace-panel-status').textContent).toContain('Signed out');
});
it('keeps an ambiguous outage logout cleared and uncertain without retrying or re-admitting',async()=>{
 const h=outageAccountHarness(true);await h.window.EchoPrimeWorkspace.ready;h.outage();await h.window.EchoPrimeWorkspace.open('account');const before=h.sessionReads(),signOut=h.find('Sign out locally');expect(signOut).toBeDefined();await signOut!.fire('click');
 expect(h.request.mock.calls.filter(c=>c[0]==='/auth/logout')).toHaveLength(1);expect(h.sessionReads()).toBe(before);expect(h.get('#workspace-panel-status').textContent).toContain('could not be confirmed');expect(h.get('#workspace-panel-status').textContent).not.toContain('Signed out');expect(h.get('#workspace-panel-content').children.length).toBe(0);
});
it('preserves only the local sign-out option after an owner-header verification outage',async()=>{
 const h=outageAccountHarness();await h.window.EchoPrimeWorkspace.ready;h.outage();await expect(h.window.EchoPrimeWorkspace.ownerHeaders()).rejects.toThrow('Current account admission unavailable');await h.window.EchoPrimeWorkspace.open('account');
 expect(h.find('Sign out locally')).toBeDefined();expect(h.get('#history').children.length).toBe(0);expect(h.request.mock.calls.filter(c=>c[0]==='/auth/logout')).toHaveLength(0);
});
it.each(['unavailable','authenticated'] as const)('does not claim logout or re-admit private content after %s anonymous readback',async(readback)=>{
 const h=outageAccountHarness(false,readback);await h.window.EchoPrimeWorkspace.ready;h.outage();await h.window.EchoPrimeWorkspace.open('account');await h.find('Sign out locally')!.fire('click');
 expect(h.request.mock.calls.filter(c=>c[0]==='/auth/logout')).toHaveLength(1);expect(h.get('#workspace-panel-content').children.length).toBe(0);expect(h.get('#history').children.length).toBe(0);expect(h.get('#workspace-panel-status').textContent).toContain('could not be confirmed');expect(h.get('.profile > span:nth-child(2)').textContent).toBe('Sign in');
});
