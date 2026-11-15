import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// Run the shipped controller. Only browser/device/network boundaries are synthetic.
function harness(options:Record<string,any>={}){
 const nodes=new Map<string,Node>(),events:Record<string,((e:any)=>unknown)[]>={},documentEvents:Record<string,((e:any)=>unknown)[]>={};
 class Node {
  textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;isConnected=true;tagName:string;
  dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;events:Record<string,((e:any)=>unknown)[]>={};files:any[]=[];
  classList={add(){},remove(){},toggle(){},contains(){return false;}};style={setProperty(){}};
  constructor(tag='div'){this.tagName=tag.toUpperCase();}
  append(...items:Node[]){for(const item of items){if(item.parent)item.parent.children=item.parent.children.filter(child=>child!==item);item.parent=this;item.isConnected=true;this.children.push(item);}}
  replaceChildren(...items:Node[]){const disconnect=(n:Node)=>{n.isConnected=false;n.children.forEach(disconnect);};this.children.forEach(child=>{disconnect(child);child.parent=null;});this.children=[];this.append(...items);}
  setAttribute(k:string,v:string){this.attributes[k]=v;if(k==='id')nodes.set('#'+v,this);if(k==='value')this.value=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())]=v;}
  getAttribute(k:string){return this.attributes[k]??null;}
  addEventListener(k:string,fn:(e:any)=>unknown){(this.events[k]??=[]).push(fn);}
  async fire(k:string,extra:any={}){for(const fn of this.events[k]||[])await fn({target:this,preventDefault(){},...extra});}
  querySelector(k:string):Node|null{return descendants(this).find(n=>n.tagName.toLowerCase()===k)||null;}
  showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}focus=vi.fn();before(){}click(){return this.fire('click');}
 }
 const get=(s:string)=>{if(!nodes.has(s))nodes.set(s,new Node());return nodes.get(s)!;};
 function descendants(n:Node):Node[]{return n.children.flatMap(c=>[c,...descendants(c)]);}
 const text=(n:Node):string=>n.textContent+n.children.map(text).join('');
 let identity!:(s:any)=>void,sessionLoads=0,session:any={workspaceConfigured:true,authenticated:true,ownerAccess:true,user:{uid:'owner',status:'approved',role:'owner'},...options.session};
 const chat=options.chat||{id:'chat',title:'Saved',messages:[],events:[]};
 const data={chats:[],projects:[],library:[],preferences:[],personalities:[],context_length:262144,base_context_chars:400,voice:{configured:true,provider:'fixture-provider'},memory_mode:'automatic',...options.data};
 const request=vi.fn(async(path:string,body?:any)=>options.request?options.request(path,body):path==='/state'?data:path==='/chats'||path.startsWith('/chats/')?chat:path==='/mcp'?{connections:[]}:{});
 class Transport {
  get session(){return session;}constructor(o:any){identity=o.onIdentityChange;}
  loadSession=async()=>{sessionLoads++;await options.loadSession?.(sessionLoads);return session;};request=request;text=async()=>'';audio=async()=>new Blob();headers=()=>({});auth=async()=>({});clear(){session=null;identity(null);}
  chat=vi.fn(async(_input:any,onEvent:any)=>{for(const event of options.chatEvents||[])onEvent(event);if(options.chatError)throw new Error(options.chatError);return chat;});
 }
 const window:any={EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()},addEventListener:(k:string,fn:(e:any)=>unknown)=>(events[k]??=[]).push(fn),dispatchEvent:(e:any)=>{for(const fn of events[e.type]||[])fn(e);}};
 const document:any={hidden:false,head:new Node(),querySelector:get,querySelectorAll:(s:string)=>[...new Set(nodes.values())].filter(n=>s==='[data-owner-only]'?'data-owner-only'in n.attributes:s==='[data-workspace-view]'?'data-workspace-view'in n.attributes:s==='.nav-item'?n.className.split(' ').includes('nav-item'):s==='[data-view="conversation"]'?n.dataset.view==='conversation':false),createElement:(s:string)=>new Node(s),createTextNode:(s:string)=>Object.assign(new Node('text'),{textContent:s}),addEventListener:(name:string,fn:(e:any)=>unknown)=>(documentEvents[name]??=[]).push(fn)};
 for(const view of ['projects','library','plugins','memory']){const node=get('[data-workspace-view="'+view+'"]');node.className='nav-item';node.setAttribute('data-workspace-view',view);}get('[data-view="conversation"]').className='nav-item';get('[data-view="conversation"]').setAttribute('data-view','conversation');
 get('#workspace-chat-kind').value='workspace';
 const clipboard=vi.fn(async()=>{}),debug=vi.fn();
 runInNewContext(readFileSync(new URL('../ui/echo-prime/workspace.js',import.meta.url),'utf8'),{window,document,navigator:{clipboard:{writeText:clipboard},...options.navigator},crypto:{randomUUID},setTimeout,clearTimeout,AbortController,URL,Blob,Event,console:{debug},Audio:vi.fn(),btoa:(s:string)=>Buffer.from(s,'binary').toString('base64')});
 return {get,window,document,request,clipboard,debug,chat,data,text,descendants,sessionLoads:()=>sessionLoads,fireDocument:async(name:string,event:any)=>{for(const fn of documentEvents[name]||[])await fn({preventDefault(){},...event});},find:(label:string,root=get('#workspace-panel-content'))=>descendants(root).find(n=>n.tagName==='BUTTON'&&text(n)===label)!,change:()=>{session={...session,ownerAccess:false,user:{uid:'other',role:'member',status:'approved'}};identity(session);}};
}

it('shows context percentage with a bounded meter and labels measured usage separately',async()=>{
 const h=harness({chat:{id:'chat',messages:[{role:'assistant',content:'A'.repeat(400),request_id:'measured:reply'}],events:[{kind:'model_identity',content:JSON.stringify({provider:'qwen',request_id:'measured',reported:true,model:'qwen',requested:'qwen'})},{kind:'model_usage',content:JSON.stringify({provider:'qwen',request_id:'measured',prompt_tokens:65536,context_length:262144,measured_at:'fixture'})}]}});
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();
 expect(h.get('#workspace-context').textContent).toContain('25.0%');expect(h.get('#workspace-context').textContent).toContain('last measured');
 expect(h.get('#workspace-context-meter').value).toBe(25);
});

it('attaches library items as removable chips and clears them when the account changes',async()=>{
 const h=harness({data:{library:[{id:'file1',name:'safe.md'}]}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');
 const attach=h.descendants(h.get('#workspace-panel-content')).find(n=>n.attributes['aria-label']==='Attach safe.md')!;attach.checked=true;await attach.fire('change');
 expect(h.text(h.get('#workspace-attachment-chips'))).toContain('safe.md');
 await h.find('Remove safe.md',h.get('#workspace-attachment-chips')).fire('click');expect(h.text(h.get('#workspace-attachment-chips'))).not.toContain('safe.md');
 attach.checked=true;await attach.fire('change');h.change();expect(h.text(h.get('#workspace-attachment-chips'))).not.toContain('safe.md');
});

it('renders saved message and code actions without interpreting markup and rejects stale account buttons',async()=>{
 const answer='Hello <img src=x onerror=alert(1)>\n```js\nconsole.log(4)\n```';
 const h=harness({chat:{id:'chat',messages:[{id:'answer',role:'assistant',content:answer}],events:[]}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();
 const copy=h.find('Copy',h.get('#chat-log'));await copy.fire('click');expect(h.clipboard).toHaveBeenCalledWith(answer);
 expect(h.find('Save file',h.get('#chat-log'))).toBeDefined();expect(h.descendants(h.get('#chat-log')).some(n=>n.tagName==='IMG')).toBe(false);
 h.change();await copy.fire('click');expect(h.clipboard).toHaveBeenCalledTimes(1);
});

it('requires review of the exact SDK request and invalidates review when its arguments change',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('sdk');
 h.get('#workspace-sdk-capability').value='echo.caps.search';h.get('#workspace-sdk-command').value='search';h.get('#workspace-sdk-options').value='{"q":"safe"}';
 await h.find('Review SDK request').fire('click');expect(h.request.mock.calls.some(c=>c[1]?.capability==='echo.caps.search')).toBe(false);
 h.get('#workspace-sdk-options').value='{"q":"changed"}';await h.get('#workspace-sdk-options').fire('input');await h.find('Run reviewed SDK request').fire('click');
 expect(h.request.mock.calls.some(c=>c[1]?.action==='sdk')).toBe(false);
 await h.find('Review SDK request').fire('click');await h.find('Run reviewed SDK request').fire('click');await h.find('Run reviewed SDK request').fire('click');
 const calls=h.request.mock.calls.filter(c=>c[1]?.action==='sdk');expect(calls).toHaveLength(1);expect(calls[0][1].options).toEqual({q:'changed'});
});

it('combines private memory and connections while hiding global tools for members',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;h.change();await h.window.EchoPrimeWorkspace.open('plugins');
 const view=h.text(h.get('#workspace-panel-content'));expect(view).toContain('Private preferences');expect(view).toContain('Connect a Streamable HTTP MCP server');expect(view).not.toContain('Save a Crystal memory');
 await h.window.EchoPrimeWorkspace.open('vault');expect(h.get('#workspace-panel-status').textContent).toContain('Primary owner');
});

it('captures up to the selected 120 seconds but sends only eight-second WAV segments and one reviewed draft',async()=>{
 let processor:any;const stop=vi.fn(),audioNode=()=>({connect(){},disconnect(){}});
 const data={chats:[],projects:[],library:[],personalities:[],voice:{configured:true}},chat={id:'dictation',messages:[]};let transcripts=0;
 const h=harness({request:async(path:string)=>path==='/state'?data:path==='/chats'?chat:path==='/voice/transcribe'?{provider:'elevenlabs-scribe',text:'segment '+(++transcripts)}:{},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop}]})}}});
 h.window.AudioContext=class {sampleRate=16000;destination={};close=async()=>{};resume=async()=>{};createMediaStreamSource=audioNode;createScriptProcessor=()=>processor={...audioNode(),onaudioprocess:null};createGain=()=>({...audioNode(),gain:{value:0}});};
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();h.get('#workspace-capture-duration').value='120';await h.get('#workspace-capture-duration').fire('change');
 await h.get('#workspace-voice-dictate').fire('click');processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(256000).fill(.15)}});await h.get('#workspace-voice-finish').fire('click');
 const calls=h.request.mock.calls.filter(c=>c[0]==='/voice/transcribe');expect(calls).toHaveLength(2);
 for(const call of calls){const wav=Buffer.from(call[1].audio_b64,'base64');expect(wav.readUInt32LE(40)).toBeLessThanOrEqual(256000);expect(wav.readUInt32LE(24)).toBe(16000);}
 expect(h.get('#prompt').value).toBe('segment 1 segment 2');expect(stop).toHaveBeenCalledTimes(1);expect(h.request.mock.calls.some(c=>c[0]==='/chat')).toBe(false);
 expect(h.debug.mock.calls.flat().join(' ')).not.toContain('segment 1');
});

it('exposes current state and emits hooks without starting microphone access at startup',async()=>{
 const microphone=vi.fn(),h=harness({navigator:{mediaDevices:{getUserMedia:microphone}}});await h.window.EchoPrimeWorkspace.ready;
 expect(h.window.EchoPrimeWorkspace.data).toBe(h.data);expect(h.window.EchoPrimeWorkspace.session.user.uid).toBe('owner');expect(h.window.EchoPrimeWorkspace.request).toBeTypeOf('function');
 expect(h.get('#workspace-voice-bar').hidden).toBe(false);expect(microphone).not.toHaveBeenCalled();
});

it('selects a personality from the composer and confirms its saved event without changing grants',async()=>{
 const chat={id:'chat',messages:[],events:[] as any[]},data={chats:[],projects:[],library:[],personalities:[{id:'auto',name:'Auto',registered:true},{id:'gs343',name:'GS343',registered:true}],voice:{configured:false}};
 const h=harness({request:async(path:string,body:any)=>{if(path==='/state')return data;if(path==='/chats'||path==='/chats/chat')return chat;if(path==='/action'){chat.events.push({kind:'personality_selected',content:body.profile});return {profile:body.profile,permissions_changed:false};}return {};}});
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();const select=h.get('#workspace-personality');select.value='gs343';await select.fire('change');
 expect(h.request.mock.calls.find(c=>c[0]==='/action')?.[1]).toEqual({action:'personality_select',chat_id:'chat',profile:'gs343'});
 expect(h.get('#workspace-personality').value).toBe('gs343');expect(h.get('#workspace-panel-status').textContent).toContain('saved and read back');
 h.change();select.value='auto';await select.fire('change');expect(h.request.mock.calls.filter(c=>c[0]==='/action')).toHaveLength(1);
});

it('shows a saved continuation checkpoint and clears its private text on account change',async()=>{
 const h=harness({chat:{id:'chat',summary:'PRIVATE CHECKPOINT fixture',cutoff:12,messages:[],events:[]}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();
 expect(h.get('#workspace-checkpoint').hidden).toBe(false);expect(h.text(h.get('#workspace-checkpoint'))).toContain('PRIVATE CHECKPOINT fixture');
 h.change();expect(h.get('#workspace-checkpoint').hidden).toBe(true);expect(h.text(h.get('#workspace-checkpoint'))).not.toContain('PRIVATE CHECKPOINT');
});

it('sanitizes a conversation title before saving a message and verifies exact library readback',async()=>{
 const message={id:'reply',role:'assistant',content:'Saved message'},chat={id:'chat',title:'Read D:\\project <source>?*|"',messages:[message],events:[]};
 const h=harness({request:async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[]}:path==='/chats'||path==='/chats/chat'?chat:path==='/library'?{id:'saved'}:path==='/library/saved'?{content:message.content}:{}});
 await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.find('Save to library',h.get('#chat-log')).fire('click');
 const call=h.request.mock.calls.find(c=>c[0]==='/library')!;expect(call[1].name).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/);expect(call[1].name.length).toBeLessThanOrEqual(120);expect(h.get('#workspace-panel-status').textContent).toContain('exact content read back');
});

it('rejects an oversized text upload before reading it and exposes the real library character budget',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');
 const fields=h.descendants(h.get('#workspace-panel-content')),file=fields.find(n=>n.attributes.type==='file')!,read=vi.fn(async()=>'x');file.files=[{name:'large.txt',size:100001,text:read}];await file.fire('change');
 expect(read).not.toHaveBeenCalled();expect(h.get('#workspace-panel-status').textContent).toContain('100,000 bytes');expect(fields.find(n=>n.tagName==='TEXTAREA')?.attributes.maxlength).toBe('100000');
});

it('imports a selected source file through the normalized account-owned chat route',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');
 h.get('#workspace-import-source').value='grok';const file=h.get('#workspace-import-file');file.files=[{name:'grok-chat.json',size:80,text:async()=>JSON.stringify([{title:'Old chat',messages:[{role:'user',content:'Imported message'}]}])}];await file.fire('change');
 await h.find('Import').fire('click');const request=h.request.mock.calls.find(c=>c[0]==='/import')!;expect(request[1]).toMatchObject({source:'grok',messages:[{role:'user',content:'Imported message'}]});
});

it('drops a late import file read after account changes',async()=>{
 let resolve!:(text:string)=>void;const pending=new Promise<string>(done=>{resolve=done;}),h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('library');
 const file=h.get('#workspace-import-file'),text=h.get('#workspace-import-data');file.files=[{name:'old.md',size:10,text:()=>pending}];const read=file.fire('change');h.change();resolve('OLD ACCOUNT TRANSCRIPT');await read;
 expect(text.value).not.toContain('OLD ACCOUNT');expect(h.request.mock.calls.some(c=>c[0]==='/import')).toBe(false);
});

it('applies only canonical allowlisted navigation after the saved reply is read back',async()=>{
 const events=[{type:'tool_result',tool:'workspace',request_id:'nav',result:{ui_action:{action:'navigate',view:'projects'}}}],h=harness({chatEvents:events});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.send('Show projects');
 expect(h.get('#workspace-panel-title').textContent).toBe('Projects');expect(h.find('Create project')).toBeDefined();expect(h.request.mock.calls.findIndex(c=>c[0]==='/chats/chat')).toBeGreaterThanOrEqual(0);
 const rejected=harness({chatEvents:[{type:'tool_result',tool:'workspace',result:{ui_action:{action:'navigate',view:'https://external.invalid'}}}]});await rejected.window.EchoPrimeWorkspace.ready;await rejected.window.EchoPrimeWorkspace.send('Show link');expect(rejected.get('#workspace-dialog').open).toBe(false);
});

it('renders persisted structured tool receipts as text and redacts secret-shaped fields',async()=>{
 const event={type:'tool_result',tool:'workspace',request_id:'receipt',result:{ok:true,secret:'PRIVATE SECRET',nested:{password:'PRIVATE PASSWORD'},summary:'<img src=x>'}},h=harness({chat:{id:'chat',messages:[],events:[{kind:'tool_result',content:JSON.stringify(event)}]}});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();
 const view=h.text(h.get('#chat-log'));expect(view).toContain('Receipt metadata');expect(view).toContain('[redacted]');expect(view).not.toContain('PRIVATE SECRET');expect(view).not.toContain('PRIVATE PASSWORD');expect(h.descendants(h.get('#chat-log')).some(n=>n.tagName==='IMG')).toBe(false);
});

it('uses the Workspace composer budget only in general conversation mode',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;expect(h.get('#prompt').attributes.maxlength).toBe('100000');h.get('#workspace-chat-kind').value='coding';await h.get('#workspace-chat-kind').fire('change');expect(h.get('#prompt').attributes.maxlength).toBe('12000');
 const local=harness({session:{workspaceConfigured:false}});await local.window.EchoPrimeWorkspace.ready;expect(local.get('#prompt').attributes.maxlength).toBe('12000');
});

it('does not reuse an old Qwen context measurement after a provider-managed CLI reply',async()=>{
 const chat={id:'chat',messages:[{role:'assistant',content:'Old',request_id:'qwen-turn:reply'},{role:'assistant',content:'New',request_id:'gpt-turn:reply'}],events:[{kind:'model_identity',content:JSON.stringify({provider:'qwen',request_id:'qwen-turn',reported:true,model:'qwen',requested:'qwen'})},{kind:'model_usage',content:JSON.stringify({provider:'qwen',request_id:'qwen-turn',prompt_tokens:65536,context_length:262144})},{kind:'model_identity',content:JSON.stringify({provider:'gpt',request_id:'gpt-turn',reported:false,model:null,requested:null})},{kind:'model_usage',content:JSON.stringify({provider:'gpt',request_id:'gpt-turn',provider_managed:true})}]};
 const h=harness({chat});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();expect(h.get('#workspace-context').textContent).toContain('Provider-managed');expect(h.get('#workspace-context').textContent).not.toContain('262,144');expect(h.get('#workspace-context').textContent).not.toContain('last measured');
});

it('invalidates successful Qwen usage when the latest persisted request failed on another provider',async()=>{
 const chat={id:'chat',messages:[{role:'assistant',content:'Old answer',request_id:'old:reply'}],events:[{kind:'model_identity',content:JSON.stringify({provider:'qwen',request_id:'old'})},{kind:'model_usage',content:JSON.stringify({provider:'qwen',request_id:'old',prompt_tokens:65536,context_length:262144})},{kind:'context',content:JSON.stringify({request_id:'new',model_provider:'gpt'})},{kind:'request_failed',content:JSON.stringify({request_id:'new',provider:'gpt',state:'failed'})}]};
 const h=harness({chat});await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();expect(h.get('#workspace-context').textContent).toContain('Latest request did not complete');expect(h.get('#workspace-context').textContent).not.toContain('262,144');expect(h.get('#workspace-context-meter').hidden).toBe(true);
});

it('reads the saved failure receipt once without resending a failed provider turn',async()=>{
 const h=harness({chatError:'Provider unavailable'});await h.window.EchoPrimeWorkspace.ready;const outcome=await h.window.EchoPrimeWorkspace.send('Attempt once');expect(outcome.sent).toBe(false);expect(h.request.mock.calls.filter(c=>c[0]==='/chats/chat')).toHaveLength(1);
});

it('renders Workspace navigation as first-class main pages without opening a modal',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;
 for(const [view,title] of [['projects','Projects'],['library','Library'],['plugins','Plugins & memory'],['memory','Memory'],['sdk','SDK'],['vault','Vault'],['review','Code review']]){
  await h.window.EchoPrimeWorkspace.open(view);expect(h.get('#workspace-main-view').hidden).toBe(false);expect(h.get('.workspace-body').hidden).toBe(true);expect(h.get('#workspace-dialog').open).toBe(false);expect(h.get('#workspace-view-title').textContent).toBe(title);expect(h.get('#workspace-view-subtitle').textContent.length).toBeGreaterThan(10);expect(h.descendants(h.get('#workspace-main-view'))).toContain(h.get('#workspace-panel-content'));
 }
 expect(h.get('#prompt').focus).not.toHaveBeenCalled();
});

it('restores the existing conversation and draft when leaving a page, including keyboard back',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();h.get('#prompt').value='Unsent private draft';h.get('#prompt').focus.mockClear();
 await h.window.EchoPrimeWorkspace.open('library');await h.get('#workspace-view-back').fire('click');expect(h.get('.workspace-body').hidden).toBe(false);expect(h.get('#workspace-main-view').hidden).toBe(true);expect(h.get('#prompt').value).toBe('Unsent private draft');expect(h.window.EchoPrimeWorkspace.chat.id).toBe('chat');expect(h.get('#scene').isConnected).toBe(true);
 await h.window.EchoPrimeWorkspace.open('projects');await h.fireDocument('keydown',{key:'Escape'});expect(h.get('#workspace-main-view').hidden).toBe(true);expect(h.get('#conversation-title').textContent).toBe('Saved');
});

it('tracks the active sidebar page and clears main-page private content on account change',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.open('projects');expect(h.get('[data-workspace-view="projects"]').getAttribute('aria-current')).toBe('page');
 await h.window.EchoPrimeWorkspace.open('library');expect(h.get('[data-workspace-view="projects"]').getAttribute('aria-current')).toBe('false');expect(h.get('[data-workspace-view="library"]').getAttribute('aria-current')).toBe('page');h.change();expect(h.get('#workspace-main-view').hidden).toBe(true);expect(h.get('#workspace-panel-content').children).toHaveLength(0);expect(h.get('.workspace-body').hidden).toBe(false);
});

it('provides an epoch-bound shared page handle for fleet pages and rejects stale receipt rendering',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;const page=await h.window.EchoPrimeWorkspace.presentView({id:'logs',title:'Logs & debugging',subtitle:'Current canonical observations',ownerOnly:true});expect(page.isCurrent()).toBe(true);page.setStatus('Read-only receipt returned');expect(h.get('#workspace-panel-status').textContent).toContain('receipt');h.change();expect(page.isCurrent()).toBe(false);page.setStatus('OLD PRIVATE RECEIPT');expect(h.get('#workspace-panel-status').textContent).not.toContain('OLD PRIVATE');
});

it('reviews ESH on the first Ctrl+Enter and runs only the unchanged reviewed command on the second',async()=>{
 const h=harness();await h.window.EchoPrimeWorkspace.ready;await h.window.EchoPrimeWorkspace.newChat();await h.get('#workspace-open-esh').fire('click');h.get('#workspace-esh-command').value='Get-Date';await h.get('#workspace-esh-command').fire('keydown',{key:'Enter',ctrlKey:true});
 expect(h.request.mock.calls.some(c=>c[1]?.action==='esh')).toBe(false);expect(h.get('#workspace-esh-badge').textContent).toContain('Reviewed');await h.get('#workspace-esh-command').fire('keydown',{key:'Enter',ctrlKey:true});await vi.waitFor(()=>expect(h.request.mock.calls.filter(c=>c[1]?.action==='esh')).toHaveLength(1));
 expect(h.text(h.get('#workspace-esh-prompt'))).toBe('PS >');expect(h.request.mock.calls.find(c=>c[1]?.action==='esh')?.[1].command).toBe('Get-Date');
});

it('discards a slow owner page admission when newer navigation has already opened a page',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),h=harness({loadSession:async(count:number)=>{if(count===2)await gate;}});await h.window.EchoPrimeWorkspace.ready;
 const old=h.window.EchoPrimeWorkspace.presentView({id:'logs',title:'OLD Logs',subtitle:'Old observations',ownerOnly:true});await vi.waitFor(()=>expect(h.sessionLoads()).toBe(2));await h.window.EchoPrimeWorkspace.open('library');release();const page=await old;
 expect(h.window.EchoPrimeWorkspace.view).toBe('library');expect(h.get('#workspace-view-title').textContent).toBe('Library');expect(page.isCurrent()).toBe(false);page.setStatus('OLD PRIVATE STATUS');expect(h.get('#workspace-panel-status').textContent).not.toContain('OLD PRIVATE');
});

it('discards delayed owner page admission after the account changes without opening an old page',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),h=harness({loadSession:async(count:number)=>{if(count===2)await gate;}});await h.window.EchoPrimeWorkspace.ready;
 const old=h.window.EchoPrimeWorkspace.presentView({id:'logs',title:'Old account logs',ownerOnly:true});await vi.waitFor(()=>expect(h.sessionLoads()).toBe(2));h.change();release();const page=await old;
 expect(page.isCurrent()).toBe(false);expect(h.window.EchoPrimeWorkspace.view).toBe('chats');expect(h.get('#workspace-view-title').textContent).not.toContain('Old account');
});

it('allows the first requested page to wait for initial session readiness for the same account',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),h=harness({loadSession:async(count:number)=>{if(count===1)await gate;}});
 const pending=h.window.EchoPrimeWorkspace.presentView({id:'projects',title:'Projects',subtitle:'Current account projects'});release();const page=await pending;expect(page.isCurrent()).toBe(true);expect(h.window.EchoPrimeWorkspace.view).toBe('projects');expect(h.get('#workspace-view-title').textContent).toBe('Projects');
});
