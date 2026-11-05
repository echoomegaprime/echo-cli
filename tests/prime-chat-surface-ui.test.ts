/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM, transport and bridge stand-ins */
import {expect,it,vi} from 'vitest';
import {Node,walk,world,storage,primeShell,source,tick} from './fixtures/prime-fake-dom.js';

// Chat-surface parity: activity cards and the thinking panel (chat-actions.js), import source and
// file picker, the password-reset button, branding strings, the remembered voice toggles and the
// two-minute chunked microphone capture. Everything runs against the shipped controllers with a
// DOM stand-in and a synthetic Workspace transport; nothing reaches a backend.
const actions=()=>world(['chat-actions.js']).window.EchoPrimeChatActions;
const text=(n:Node)=>walk(n).map(x=>x.textContent).join('|');

// ---------- activity cards ----------
it('models saved tool, action and preference events the way the Workspace activity card does',()=>{
 const a=actions();
 const tool=a.activityModel({kind:'tool_result',content:JSON.stringify({tool:'esh',request_id:'r1',result:{ok:true,exit:0,stdout:'done'}})});
 expect(tool).toMatchObject({kind:'tool_result',preference:false,label:'esh',failed:false,marker:'⌘',status:' · recorded',body:{ok:true,exit:0,stdout:'done'}});expect(tool.note).toContain('Actual tool response');
 expect(a.activityModel({kind:'tool_result',content:JSON.stringify({tool:'esh',result:{ok:false,error:'denied'}})})).toMatchObject({failed:true,status:' · needs attention'});
 expect(a.activityModel({kind:'action_receipt',content:JSON.stringify({action:'vault',request:{action:'vault'},result:{ok:true}})})).toMatchObject({label:'vault',failed:false});
 const pref=a.activityModel({kind:'preference_saved',content:JSON.stringify({content:'Prefers short answers.'})});
 expect(pref).toMatchObject({preference:true,label:'Memory saved',marker:'◈',body:'Prefers short answers.'});expect(pref.note).toContain('ECF delivery is tracked separately');
 expect(a.activityModel({kind:'tool_result',content:'{not json'})).toMatchObject({label:'Plugin action',body:{detail:'{not json'}});
 expect(a.activityModel({type:'tool_result',tool:'files',result:{ok:true}})).toMatchObject({kind:'tool_result',label:'files',body:{ok:true}});// a streamed event object
 expect(a.activityModel(null)).toMatchObject({label:'Plugin action',failed:false});expect(a.activityModel({kind:'tool_result',content:JSON.stringify({tool:'x'.repeat(500)})}).label).toHaveLength(100);
});
it('renders an inert activity card without the message class tokens that composer.js indexes',()=>{
 const a=actions(),card=a.activityCard({kind:'tool_result',content:JSON.stringify({tool:'esh',result:{ok:false,error:'<img src=x onerror=alert(1)>'}})});
 expect(card.tagName).toBe('DETAILS');expect(card.className).toBe('tool-card failed');expect(card.attributes['data-activity']).toBe('tool_result');
 expect(card.className).not.toMatch(/\b(user|assistant|chat-message)\b/);
 const summary=card.children[0];expect(summary.tagName).toBe('SUMMARY');expect(summary.textContent).toBe('⌘ esh · needs attention');expect(summary.children[0].className).toBe('pill pending');
 expect(card.children[1].tagName).toBe('PRE');expect(card.children[1].textContent).toContain('"error": "<img src=x onerror=alert(1)>"');expect(card.children[2].textContent).toContain('Actual tool response');
 const pref=a.activityCard({kind:'preference_saved',content:JSON.stringify({content:'Keep voice off.'})});expect(pref.className).toBe('tool-card');expect(pref.children[1].tagName).toBe('P');expect(pref.children[1].textContent).toBe('Keep voice off.');expect(pref.children[0].children[0].className).toBe('pill good');
});
it('interleaves messages and activity events by saved time, keeping unknown kinds out and undated events last',()=>{
 const a=actions();
 const chat={messages:[{role:'user',content:'a',created:'2026-11-04T10:00:00Z'},{role:'assistant',content:'b',created:'2026-11-04T10:00:05Z'},{role:'system',content:'hidden',created:'2026-11-04T09:00:00Z'}],
  events:[{kind:'tool_result',created:'2026-11-04T10:00:02Z',content:'{}'},{kind:'model_usage',created:'2026-11-04T10:00:03Z',content:'{}'},{kind:'preference_saved',content:'{}'},{kind:'action_receipt',created:'2026-11-04T09:59:00Z',content:'{}'}]};
 expect(a.timeline(chat).map(i=>i.kind==='message'?i.message.content:i.event.kind)).toEqual(['action_receipt','a','tool_result','b','preference_saved']);
 expect(a.timeline(null)).toEqual([]);expect(a.timeline({messages:[{role:'user',content:'x'},{role:'assistant',content:'y'}]}).map(i=>i.message.content)).toEqual(['x','y']);
 expect([...a.activityKinds]).toEqual(['tool_result','action_receipt','preference_saved']);
});
it('builds a thinking panel whose status, steps and tool entries stay bounded',()=>{
 const a=actions(),panel=a.thinkingPanel(),status=walk(panel.node).find(n=>n.className==='thinking-text')!,steps=walk(panel.node).find(n=>n.tagName==='OL')!;
 expect(panel.node.className).toBe('thinking');expect(panel.node.attributes['data-thinking']).toBe('');expect(status.textContent).toBe('Echo is thinking…');expect(text(panel.node)).toContain('View activity');
 panel.status('Reading memory…');expect(status.textContent).toBe('Reading memory…');panel.status('');expect(status.textContent).toBe('Echo is thinking…');panel.status('x'.repeat(700));expect(status.textContent).toHaveLength(600);
 panel.step('Checked Crystal');panel.tool('esh',{command:'Get-Location'});
 expect(steps.children).toHaveLength(2);expect(steps.children[0].textContent).toBe('Checked Crystal');expect(text(steps.children[1])).toContain('esh · started');expect(text(steps.children[1])).toContain('"command": "Get-Location"');
 for(let i=0;i<250;i++)panel.step('s'+i);expect(steps.children).toHaveLength(200);expect(steps.children[0].textContent).toBe('s50');
 const host=new Node('section');host.append(panel.node);panel.remove();expect(host.children).toEqual([]);panel.remove();
});

// ---------- the shipped workspace.js ----------
interface Deferred<T=any> {promise:Promise<T>;resolve:(value:T)=>void}
function deferred<T=any>():Deferred<T>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function workspaceWorld(options:{request?:ReturnType<typeof vi.fn>;chat?:(input:any,onEvent:(event:any)=>void)=>Promise<any>;auth?:ReturnType<typeof vi.fn>;session?:any;files?:string[];globals?:Record<string,any>;storage?:ReturnType<typeof storage>}={}){
 let identity!:(session:any)=>void;
 const request=options.request??vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],preferences:[],personalities:[],context_length:262144}:path==='/chats'?{id:'c1',title:'Fresh',messages:[],events:[]}:path.startsWith('/chats/')?{id:path.slice(7),messages:[],events:[]}:path==='/import'?{id:'imported'}:{});
 const auth=options.auth??vi.fn(async(operation:string)=>operation==='config'?{google_login_enabled:false}:operation==='reset'?{message:'Recovery email requested.'}:{});
 const session=options.session??{workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved',name:'Owner'}};
 class Transport {session=session;constructor(o:any){identity=o.onIdentityChange;}loadSession=async()=>this.session;request=request;chat=options.chat??(async(input:any)=>({id:input.chat_id,messages:[]}));text=async()=>'';audio=async()=>new Blob();headers=()=>({'x-echo-csrf':'owner'});clear(){identity(null);}auth=auth;}
 const w=world(options.files??['workspace.js','chat-actions.js'],{body:primeShell,storage:options.storage,globals:options.globals,window:{EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()}}});
 w.get('#workspace-chat-kind').value='workspace';
 const panel=()=>walk(w.get('#workspace-panel-content'));
 const find=(label:string)=>panel().find(n=>n.tagName==='BUTTON'&&n.textContent.trim()===label)!;
 return {...w,request,auth,find,panel,change:()=>identity({...session,user:{uid:'member',role:'member',status:'approved'},ownerAccess:false})};
}
it('renders saved activity cards between the messages of an opened conversation',async()=>{
 const chat={id:'saved',title:'Saved',messages:[{id:'u',role:'user',content:'run it',created:'2026-11-04T10:00:00Z'},{id:'a',role:'assistant',content:'done',created:'2026-11-04T10:00:09Z'}],
  events:[{kind:'tool_result',created:'2026-11-04T10:00:04Z',content:JSON.stringify({tool:'esh',result:{ok:true,exit:0}})},{kind:'preference_saved',created:'2026-11-04T10:00:08Z',content:JSON.stringify({content:'Likes receipts.'})},{kind:'model_usage',created:'2026-11-04T10:00:09Z',content:'{"prompt_tokens":5}'}]};
 const request=vi.fn(async(path:string)=>path==='/state'?{chats:[{id:'saved',title:'Saved'}],projects:[],library:[],personalities:[],context_length:262144}:path==='/chats/saved'?chat:{});
 const w=workspaceWorld({request});await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.bridge.openChat('saved');
 const log=w.get('#chat-log').children;expect(log.map(n=>n.className)).toEqual(['chat-message user','tool-card','tool-card','chat-message assistant']);
 expect(text(log[1])).toContain('⌘ esh · recorded');expect(text(log[2])).toContain('◈ Memory saved · recorded');expect(text(log[2])).toContain('Likes receipts.');
 expect(w.get('#chat-log').hidden).toBe(false);expect(w.get('#conversation-title').textContent).toBe('Saved');
 // Without chat-actions.js the conversation still renders its messages.
 const plain=workspaceWorld({request,files:['workspace.js']});await plain.window.EchoPrimeWorkspace.ready;await plain.window.EchoPrimeWorkspace.bridge.openChat('saved');
 expect(plain.get('#chat-log').children.map(n=>n.className)).toEqual(['chat-message user','chat-message assistant']);
});
// ---------- import: source select + file picker ----------
it('imports with the chosen source, reads an export file under 1.9 MB into the form and refuses larger ones',async()=>{
 const w=workspaceWorld();await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.open('library');
 const select=w.panel().find(n=>n.tagName==='SELECT'&&n.attributes['aria-label']==='Import source')!,file=w.panel().find(n=>n.attributes.type==='file'&&n.attributes.accept==='.json,.txt,.md')!,textarea=w.panel().find(n=>n.tagName==='TEXTAREA'&&n.attributes.maxlength==='1500000')!,title=w.panel().find(n=>n.tagName==='INPUT'&&n.attributes.placeholder==='Imported conversation')!;
 expect(select.children.map(o=>o.value)).toEqual(['chatgpt','claude','grok','other']);expect(select.value).toBe('chatgpt');expect(text(w.get('#workspace-panel-content'))).toContain('does not connect to or monitor another provider');
 file.files=[{name:'big.json',size:1900001,text:async()=>'nope'}];await file.fire('change');
 expect(w.get('#workspace-panel-status').textContent).toBe('Choose an export under 1.9 MB.');expect(textarea.value).toBe('');expect(file.value).toBe('');
 const exported=JSON.stringify({name:'Claude export',chat_messages:[{sender:'human',text:'hello',created_at:'2026-11-01T00:00:00Z'},{sender:'assistant',text:'hi there'}]});
 file.files=[{name:'claude-export.json',size:exported.length,text:async()=>exported}];await file.fire('change');
 expect(textarea.value).toBe(exported);expect(title.value).toBe('claude-export.json');
 select.value='claude';await w.find('Import').fire('click');
 const call=w.request.mock.calls.find(c=>c[0]==='/import')!;expect(call[1]).toEqual({source:'claude',title:'claude-export.json',messages:[{role:'user',content:'hello',timestamp:'2026-11-01T00:00:00Z'},{role:'assistant',content:'hi there'}]});
 expect(w.request.mock.calls.some(c=>c[0]==='/chats/imported')).toBe(true);
});
it('unwraps a single-conversation array export, refuses several, and ignores a file read that finishes after the account changed',async()=>{
 const w=workspaceWorld();await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.open('library');
 const textarea=()=>w.panel().find(n=>n.tagName==='TEXTAREA'&&n.attributes.maxlength==='1500000')!;
 textarea().value=JSON.stringify([{title:'One',messages:[{role:'user',content:'x'}]}]);await w.find('Import').fire('click');
 expect(w.request.mock.calls.find(c=>c[0]==='/import')![1]).toMatchObject({source:'chatgpt',title:'One',messages:[{role:'user',content:'x'}]});
 await w.window.EchoPrimeWorkspace.open('library');textarea().value=JSON.stringify([{messages:[{role:'user',content:'x'}]},{messages:[{role:'user',content:'y'}]}]);await w.find('Import').fire('click');
 expect(w.get('#workspace-panel-status').textContent).toBe('Choose one exported conversation at a time.');expect(w.request.mock.calls.filter(c=>c[0]==='/import')).toHaveLength(1);
 await w.window.EchoPrimeWorkspace.open('library');const file=w.panel().find(n=>n.attributes.type==='file'&&n.attributes.accept==='.json,.txt,.md')!,late=deferred<string>(),target=textarea();
 file.files=[{name:'old-account.json',size:10,text:()=>late.promise}];const pending=file.fire('change');w.change();late.resolve('OLD ACCOUNT EXPORT');await pending;
 expect(target.value).toBe('');expect(w.get('#workspace-panel-content').children).toEqual([]);
});

// ---------- password reset ----------
it('offers Forgot password? on the sign-in card and only requests recovery with an email address',async()=>{
 const anonymous={workspaceConfigured:true,authenticated:false,ownerAccess:false,csrf:null,user:null};
 const w=workspaceWorld({session:anonymous});await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.open('account');
 const button=w.find('Forgot password?');expect(button).toBeDefined();expect(w.panel().some(n=>n.tagName==='BUTTON'&&/recovery/i.test(n.textContent))).toBe(false);
 const email=w.panel().find(n=>n.tagName==='INPUT'&&n.attributes.placeholder==='Email or existing supported user ID')!;
 email.value='commander';await button.fire('click');
 expect(w.get('#workspace-panel-status').textContent).toBe('Enter your email address first.');expect(w.auth.mock.calls.some(c=>c[0]==='reset')).toBe(false);
 email.value='  owner@example.test ';await button.fire('click');
 expect(w.auth.mock.calls.filter(c=>c[0]==='reset').map(c=>c[1])).toEqual([{email:'owner@example.test'}]);expect(w.get('#workspace-panel-status').textContent).toBe('Recovery email requested.');
});

// ---------- branding ----------
it('shows the Workspace brand line and the context subtitle only when a Workspace is configured',async()=>{
 const w=workspaceWorld();await w.window.EchoPrimeWorkspace.ready;
 expect(w.get('.brand small').textContent).toBe('YOUR PRIVATE WORKSPACE');
 const subtitle=w.get('#conversation-subtitle');expect(subtitle.textContent).toBe('Echo Prime · 256K context · Automatic memory');expect(subtitle.hidden).toBe(false);
 const off=workspaceWorld({session:{workspaceConfigured:false,authenticated:false,ownerAccess:false,csrf:null,user:null}});await off.window.EchoPrimeWorkspace.ready;
 expect(off.get('.brand small').textContent).toBe('FORGE WORKSPACE');expect(off.get('#conversation-subtitle').hidden).toBe(true);expect(off.get('#conversation-subtitle').textContent).toBe('');
 const small=workspaceWorld({request:vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],context_length:32768}:{})});await small.window.EchoPrimeWorkspace.ready;
 expect(small.get('#conversation-subtitle').textContent).toBe('Echo Prime · 32K context · Automatic memory');
});

// ---------- voice bar: remembered toggles ----------
function voiceBridge(uid='owner'){
 const hooks:Array<(t:string)=>void>=[];
 return {state:{data:{voice:{configured:true,label:'Test Voice',provider:'elevenlabs'}},chat:null,capture:null,micPending:false,speech:null,accountEpoch:0,voiceBar:false},
  voiceOptions:{spoken:false,brief:false,autoSend:false,conversation:false,remaining:0,limitReached:false},session:{authenticated:true,ownerAccess:true,user:{uid,status:'approved'}},hooks,
  endConversation:vi.fn(),stopAudio:vi.fn(),interrupt:vi.fn(async()=>{}),stopVoice:vi.fn(async()=>{}),onStatus:(fn:(t:string)=>void)=>{hooks.push(fn);}} as any;
}
const voiceWorld=async(bridge:any,store?:ReturnType<typeof storage>)=>{const w=world(['voicebar.js'],{storage:store,window:{EchoPrimeWorkspace:{ready:Promise.resolve(true),enabled:true,bridge}}});await tick();return w;};
const box=(w:ReturnType<typeof world>,key:string)=>w.find('[data-voice-option="'+key+'"]')!;
it('remembers brief speech and automatic sends per account, restores them next session and never stores spoken replies',async()=>{
 const store=storage(),first=voiceBridge();const w=await voiceWorld(first,store);
 for(const key of ['spoken','brief','autoSend'])expect(box(w,key).checked).toBe(false);
 box(w,'brief').checked=true;await box(w,'brief').fire('change');box(w,'spoken').checked=true;await box(w,'spoken').fire('change');
 expect(JSON.parse(store.map.get('echo-prime-voice-v1')!)).toEqual({owner:{brief:true,autoSend:false}});
 // Next session, same browser, same account: the two toggles come back, spoken replies stay off.
 const second=voiceBridge();const again=await voiceWorld(second,store);
 expect(second.voiceOptions).toMatchObject({spoken:false,brief:true,autoSend:false,conversation:false});expect(box(again,'brief').checked).toBe(true);expect(box(again,'spoken').checked).toBe(false);
 box(again,'autoSend').checked=true;await box(again,'autoSend').fire('change');expect(JSON.parse(store.map.get('echo-prime-voice-v1')!)).toEqual({owner:{brief:true,autoSend:true}});
 // Changes made elsewhere (the Voice & personality dialog shares voiceOptions) are persisted on the next sync.
 second.voiceOptions.brief=false;again.emit('echo-workspace-context');expect(JSON.parse(store.map.get('echo-prime-voice-v1')!)).toEqual({owner:{brief:false,autoSend:true}});
 for(const value of store.writes)expect(value).not.toMatch(/spoken|conversation/);
 // Another account on the same browser starts from its own (empty) memory and the owner's stays untouched.
 Object.assign(second.voiceOptions,{spoken:false,brief:false,autoSend:false});second.session={authenticated:true,ownerAccess:false,user:{uid:'member',status:'approved'}};again.emit('echo-account-changed');
 expect(second.voiceOptions).toMatchObject({brief:false,autoSend:false});box(again,'brief').checked=true;await box(again,'brief').fire('change');
 expect(JSON.parse(store.map.get('echo-prime-voice-v1')!)).toEqual({owner:{brief:false,autoSend:true},member:{brief:true,autoSend:false}});
 expect(again.window.EchoPrimeVoiceBar.savedFor('nobody')).toEqual({brief:false,autoSend:false});
});
it('ignores corrupt or unavailable storage and a signed-out visitor without touching the shared options',async()=>{
 const corrupt=voiceBridge();const w=await voiceWorld(corrupt,storage({'echo-prime-voice-v1':'[1,2'}));expect(corrupt.voiceOptions).toMatchObject({brief:false,autoSend:false});
 box(w,'brief').checked=true;await box(w,'brief').fire('change');expect(JSON.parse(w.storage.map.get('echo-prime-voice-v1')!)).toEqual({owner:{brief:true,autoSend:false}});
 const broken=voiceBridge();const b=await voiceWorld(broken,storage({},{throws:true}));box(b,'autoSend').checked=true;await box(b,'autoSend').fire('change');expect(broken.voiceOptions.autoSend).toBe(true);expect(b.storage.writes).toEqual([]);
 const visitor=voiceBridge();visitor.session={authenticated:false,ownerAccess:false,user:null};const store=storage({'echo-prime-voice-v1':JSON.stringify({owner:{brief:true,autoSend:true}})});
 const v=await voiceWorld(visitor,store);expect(visitor.voiceOptions).toMatchObject({brief:false,autoSend:false});expect(store.writes).toEqual([]);
 expect(v.window.EchoPrimeVoiceBar.remember('x'.repeat(10),{brief:true})).toBe(true);
 const seeded:Record<string,unknown>={};for(let i=0;i<20;i++)seeded['u'+i]={brief:true,autoSend:false};const bounded=storage({'echo-prime-voice-v1':JSON.stringify(seeded)});
 const bb=await voiceWorld(voiceBridge('fresh'),bounded);box(bb,'brief').checked=true;await box(bb,'brief').fire('change');expect(Object.keys(JSON.parse(bounded.map.get('echo-prime-voice-v1')!))).toHaveLength(16);
});

// ---------- microphone capture: two minutes in eight-second parts ----------
function captureWorld(request:ReturnType<typeof vi.fn>){
 let processor:any;const audioNode=()=>({connect(){},disconnect(){}});
 const w=workspaceWorld({request,globals:{navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},userAgent:'fixture'},btoa:(s:string)=>Buffer.from(s,'binary').toString('base64')}});
 w.window.AudioContext=class {sampleRate=16000;destination={};close=async()=>{};resume=async()=>{};createMediaStreamSource=audioNode;createScriptProcessor=()=>processor={...audioNode(),onaudioprocess:null};createGain=()=>({...audioNode(),gain:{value:0}});};
 // A finished capture nulls onaudioprocess, exactly as a real ScriptProcessorNode then stops calling it.
 return {...w,feed:(samples:Float32Array)=>processor.onaudioprocess?.({inputBuffer:{getChannelData:()=>samples}})};
}
const captureRequest=()=>vi.fn(async(path:string,body?:any)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],voice:{configured:true}}:path==='/chats'?{id:'dictation',messages:[]}:path==='/voice/transcribe'?{provider:'elevenlabs-scribe',text:'part '+Buffer.from(body.audio_b64,'base64').length}:{});
it('captures up to two minutes and transcribes it in eight-second PCM parts that are joined for review',async()=>{
 const request=captureRequest(),w=captureWorld(request);await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.newChat();await w.window.EchoPrimeWorkspace.open('voice');
 expect(text(w.get('#workspace-panel-content'))).toContain('up to two minutes');
 await w.find('Dictate a message').fire('click');expect(w.get('#workspace-panel-status').textContent).toContain('Up to two minutes');
 w.feed(new Float32Array(128000).fill(.15));w.feed(new Float32Array(128000).fill(.15));w.feed(new Float32Array(16000).fill(.15));// 17 s of speech
 expect(request.mock.calls.some(c=>c[0]==='/voice/transcribe')).toBe(false);// speech continues: nothing sent yet
 await w.find('Finish and transcribe').fire('click');
 const parts=request.mock.calls.filter(c=>c[0]==='/voice/transcribe');expect(parts).toHaveLength(3);
 const sizes=parts.map(c=>Buffer.from(c[1].audio_b64,'base64'));expect(sizes.map(b=>b.readUInt32LE(40))).toEqual([256000,256000,32000]);// data bytes per part: 8 s, 8 s, 1 s
 for(const wav of sizes){expect(wav.toString('ascii',0,4)).toBe('RIFF');expect(wav.readUInt32LE(24)).toBe(16000);}
 expect(w.get('#prompt').value).toBe('part 256044 part 256044 part 32044');expect(request.mock.calls.some(c=>c[0]==='/chat')).toBe(false);
});
it('stops a capture by itself after two seconds of silence or fifteen silent seconds, and caps the raw capture at two minutes',async()=>{
 const request=captureRequest(),w=captureWorld(request);await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.newChat();await w.window.EchoPrimeWorkspace.open('voice');
 await w.find('Dictate a message').fire('click');w.feed(new Float32Array(48000).fill(.15));w.feed(new Float32Array(32000));await tick();await tick();
 expect(request.mock.calls.filter(c=>c[0]==='/voice/transcribe')).toHaveLength(1);expect(w.get('#prompt').value).toBe('part 160044');// 3 s speech + 2 s silence, one part
 await w.find('Dictate a message').fire('click');w.feed(new Float32Array(16000*15));await tick();await tick();
 expect(request.mock.calls.filter(c=>c[0]==='/voice/transcribe')).toHaveLength(1);expect(w.get('#workspace-panel-status').textContent).toBe('No speech detected. Microphone off.');
 w.get('#prompt').value='';await w.find('Dictate a message').fire('click');for(let i=0;i<16;i++)w.feed(new Float32Array(128000).fill(.15));await tick();await tick();// 128 s offered, 120 s kept
 expect(request.mock.calls.filter(c=>c[0]==='/voice/transcribe')).toHaveLength(16);// 1,920,000 samples = 15 parts of 128,000
 const total=request.mock.calls.filter(c=>c[0]==='/voice/transcribe').slice(1).reduce((n,c)=>n+Buffer.from(c[1].audio_b64,'base64').readUInt32LE(40),0);expect(total).toBe(1920000*2);
});
it('leaves the index.html wiring and the Workspace parity strings in place',()=>{
 const html=source('index.html');expect(html).toContain('<script src="chat-actions.js"></script>');expect(html).toContain('conversation-subtitle');
 const js=source('workspace.js');expect(js).toContain('captureSeconds=120');expect(js).not.toContain('Up to eight seconds');expect(js).toContain("'Forgot password?'");
 expect(source('voicebar.js')).not.toMatch(/M Freeman|Freeman/);
});
