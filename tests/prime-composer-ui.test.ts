/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM and bridge stand-ins mirror prime-workspace-ui.test.ts */
import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPrimeServer} from '../src/prime/server.js';
import {PrimeHub} from '../src/prime/hub.js';

// Executes the shipped composer, voice bar and plugins controllers against a small
// DOM stand-in and a synthetic Workspace bridge. Nothing here talks to a real backend.
class Node {
 tagName:string;_text='';className='';hidden=false;disabled=false;checked=false;open=false;value='';max=0;isConnected=true;
 dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];inserted:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};style={setProperty:vi.fn()};files:any[]=[];
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 get textContent():string{return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(value:string){this._text=String(value);this.children=[];}
 get classList(){const tokens=()=>this.className.split(/\s+/).filter(Boolean),set=(list:string[])=>{this.className=list.join(' ');};const api={add:(c:string)=>{if(!tokens().includes(c))set([...tokens(),c]);},remove:(c:string)=>{set(tokens().filter(x=>x!==c));},toggle:(c:string,on?:boolean)=>{if(on===undefined?!tokens().includes(c):on)api.add(c);else api.remove(c);},contains:(c:string)=>tokens().includes(c)};return api;}
 append(...items:Node[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this._text='';this.append(...items);}
 after(...items:Node[]){this.inserted.push(...items);} before(...items:Node[]){this.inserted.push(...items);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key==='value')this.value=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},stopPropagation(){},target:this,...event});}
 showModal(){this.open=true;} close(){this.open=false;void this.fire('close');} focus(){} click(){return this.fire('click');}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
 querySelector(selector:string):Node|null{return walk(this).find(n=>matches(n,selector))||null;}
}
function matches(n:Node,selector:string){return selector.startsWith('.')?n.className.split(/\s+/).includes(selector.slice(1)):selector.startsWith('#')?n.attributes.id===selector.slice(1):n.tagName===selector.toUpperCase();}
function walk(root:Node):Node[]{return [...root.children,...root.inserted].flatMap(c=>[c,...walk(c)]);}
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));

interface World {nodes:Map<string,Node>;window:any;body:Node;get:(s:string)=>Node;emit:(t:string)=>void;all:()=>Node[];button:(label:string)=>Node|undefined;input:(attr:string,value:string)=>Node|undefined;storage:Record<string,unknown>;clipboard:string[]}
function voiceFixture(extra:Record<string,unknown>={}){return {configured:true,persona:'forge-voice',label:'Test Voice',provider:'elevenlabs',provider_usage:'Cloud speech uses your ElevenLabs account.',...extra};}
function fakeBridge(over:Record<string,any>={}){
 const hooks:Array<(text:string)=>void>=[];
 const state:any={data:{context_length:262144,base_context_chars:600,library:[{id:'f1',name:'notes.md',path:'a/notes.md'},{id:'f2',name:'app.py',path:'a/app.py'}],projects:[],personalities:[{id:'auto',name:'Auto'},{id:'forge',name:'Forge'}],sync:{verified:3,remaining:1,mode:'ecf'},directive:{loaded:true},voice:{configured:false}},
  chat:{id:'c1',title:'T',project_id:null,messages:[],events:[]},attachments:new Set<string>(),speech:null,capture:null,micPending:false,accountEpoch:0,epoch:0,voiceBar:false,...over.state};
 const voiceOptions={spoken:false,brief:false,autoSend:false,conversation:false,remaining:0,limitReached:false};
 const bridge:any={state,voiceOptions,session:{authenticated:true,ownerAccess:true,user:{uid:'owner',status:'approved'}},hooks,
  api:vi.fn(async(path:string)=>path==='/mcp'?{connections:[]}:path==='/plugins'?{crystal:{ok:true},ecf:{ok:false,error:'HTTP 403 continuity.read'},esh:{ok:true}}:{}),
  refresh:vi.fn(async()=>{}),openChat:vi.fn(async()=>{}),updateContext:vi.fn(),dictate:vi.fn(async()=>{}),speakReply:vi.fn(async()=>true),stopAudio:vi.fn(),endConversation:vi.fn(),
  startConversation:vi.fn(async()=>{}),stopVoice:vi.fn(async()=>{}),interrupt:vi.fn(async()=>{}),setChat:vi.fn(),onStatus:vi.fn((fn:(t:string)=>void)=>{hooks.push(fn);}),...over.bridge};
 return bridge;
}
async function world(files:string[],bridge:any,options:{enabled?:boolean}={}):Promise<World>{
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},storage:Record<string,unknown>={},clipboard:string[]=[];
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector)!;};
 const body=new Node('body');
 const window:any={addEventListener:(name:string,fn:(e:any)=>unknown)=>(events[name]??=[]).push(fn),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);},
  EchoPrimeWorkspace:{ready:Promise.resolve(options.enabled??true),get enabled(){return options.enabled??true;},bridge}};
 const document:any={body,head:new Node('head'),hidden:false,querySelector:get,querySelectorAll:()=>[],createElement:(t:string)=>new Node(t),createTextNode:(t:string)=>Object.assign(new Node('#text'),{_text:t}),addEventListener(){}};
 const localStorage={getItem:()=>{storage.read=true;return null;},setItem:()=>{storage.written=true;},removeItem:()=>{storage.written=true;}};
 const context={window,document,localStorage,sessionStorage:localStorage,navigator:{clipboard:{writeText:async(t:string)=>{clipboard.push(t);}}},crypto:{randomUUID},Event,setTimeout,clearTimeout,console:{debug:vi.fn()},Error,Number,Math,JSON,Set,Array,Object,String,Promise,Boolean};
 for(const file of files)runInNewContext(source(file),context);
 await tick();
 const all=()=>[body,...nodes.values()].flatMap(n=>[n,...walk(n)]);
 const button=(label:string)=>all().find(n=>n.tagName==='BUTTON'&&n.textContent.trim()===label);
 const input=(attr:string,value:string)=>all().find(n=>n.attributes[attr]===value);
 return {nodes,window,body,get,emit:(t:string)=>window.dispatchEvent(new Event(t)),all,button,input,storage,clipboard};
}

// ---------- context meter maths ----------
const meterOf=async()=>{const w=await world(['composer.js'],fakeBridge());return w.window.EchoPrimeComposer;};
it('shows the Workspace estimate format when no turn has been measured',async()=>{
 const c=await meterOf();
 const m=c.contextMeter({capacity:262144,contextChars:30000,baseChars:600,draft:'x'.repeat(28),events:[]});
 expect(m.text).toBe('7,657 / 262,144 · 2.9% · estimate');expect(m.measured).toBe(false);expect(m.used).toBe(7657);
});
it('prefers the last measured model_usage and labels the draft estimate separately',async()=>{
 const c=await meterOf(),events=[{kind:'model_usage',content:JSON.stringify({prompt_tokens:7000,completion_tokens:500})}];
 expect(c.contextMeter({capacity:262144,contextChars:1,baseChars:1,draft:'',events}).text).toBe('7,500 / 262,144 · 2.9% · measured last turn');
 const withDraft=c.contextMeter({capacity:262144,contextChars:1,baseChars:1,draft:'y'.repeat(40),events});
 expect(withDraft.used).toBe(7510);expect(withDraft.text.endsWith('last turn + draft estimate')).toBe(true);expect(withDraft.measured).toBe(true);
});
it('stops measuring at a compaction checkpoint and ignores unreadable usage records',async()=>{
 const c=await meterOf(),usage={kind:'model_usage',content:JSON.stringify({prompt_tokens:9000})};
 expect(c.contextMeter({capacity:1000,contextChars:400,baseChars:0,draft:'',events:[usage,{kind:'compacted'}]}).measured).toBe(false);
 expect(c.contextMeter({capacity:1000,contextChars:400,baseChars:0,draft:'',events:[{kind:'compacted'},usage]}).used).toBe(9000);
 const bad=c.contextMeter({capacity:1000,contextChars:400,baseChars:0,draft:'',events:[usage,{kind:'model_usage',content:'{not json'}]});
 expect(bad.measured).toBe(false);expect(bad.used).toBe(100);
 expect(c.contextMeter({capacity:1000,contextChars:0,baseChars:0,draft:'',events:[{kind:'model_usage',content:'{"completion_tokens":5}'}]}).measured).toBe(false);
});
it('clamps the percentage, hides without a capacity and falls back to message lengths',async()=>{
 const c=await meterOf();
 const over=c.contextMeter({capacity:100,contextChars:4000,baseChars:0,draft:'',events:[]});expect(over.percent).toBe(100);expect(over.text).toContain('100.0%');
 expect(c.contextMeter({capacity:0,contextChars:1,baseChars:0,draft:'',events:[]})).toBeNull();
 expect(c.contextMeter({capacity:undefined,draft:'',events:[]})).toBeNull();
 expect(c.chatChars({context_chars:77,messages:[{content:'abc'}]})).toBe(77);
 expect(c.chatChars({messages:[{content:'abc'},{content:'de'},{content:7}]})).toBe(5);expect(c.chatChars(null)).toBe(0);
});
it('renders the meter bar from backend values and refreshes while the draft changes',async()=>{
 const bridge=fakeBridge();const w=await world(['composer.js'],bridge);
 w.get('#prompt').value='z'.repeat(40);w.emit('echo-workspace-context');
 const bar=w.all().find(n=>n.tagName==='PROGRESS')!,label=w.all().find(n=>n.attributes['data-context-label']!==undefined)!;
 expect(bar.max).toBe(262144);expect(bar.value).toBe(Math.ceil((600+40)/4));expect(label.textContent).toBe('160 / 262,144 · 0.1% · estimate');
 bridge.state.chat.events=[{kind:'model_usage',content:JSON.stringify({prompt_tokens:7000,completion_tokens:500})}];w.get('#prompt').value='';w.emit('echo-workspace-context');
 expect(label.textContent).toBe('7,500 / 262,144 · 2.9% · measured last turn');
 bridge.state.data=null;w.emit('echo-account-changed');expect(bar.parent!.hidden).toBe(true);
});

// ---------- composer controls ----------
it('shows the exact keyboard hint and the automatic Memory chip only for an enabled Workspace',async()=>{
 const w=await world(['composer.js'],fakeBridge());
 expect(w.get('.keyboard-hint').textContent).toBe('Enter to send · Shift+Enter for a new line');
 expect(w.all().some(n=>n.textContent==='◈ Memory · automatic')).toBe(true);
 const off=await world(['composer.js'],fakeBridge(),{enabled:false});
 expect(off.get('.keyboard-hint').textContent).toBe('');expect(off.all().some(n=>n.textContent==='◈ Memory · automatic')).toBe(false);
});
it('attaches library files as removable chips that feed the next message',async()=>{
 const bridge=fakeBridge();const w=await world(['composer.js'],bridge);
 await w.button('＋ Attach')!.click();
 const dialog=w.all().find(n=>n.tagName==='DIALOG'&&n.attributes['data-composer-dialog']==='attach')!;expect(dialog.open).toBe(true);
 const box=w.all().find(n=>n.tagName==='INPUT'&&n.attributes['data-file']==='f2')!;box.checked=true;await box.fire('change');
 expect([...bridge.state.attachments]).toEqual(['f2']);expect(bridge.updateContext).toHaveBeenCalled();w.emit('echo-workspace-context');
 const chip=w.button('app.py ×')!;expect(chip).toBeTruthy();await chip.click();
 expect(bridge.state.attachments.size).toBe(0);
 bridge.state.attachments.add('gone');w.emit('echo-workspace-context');expect(w.button('File ×')).toBeTruthy();
});
it('offers the hands-free Voice button only when Personality Forge is configured and routes through the capped bridge helper',async()=>{
 const off=fakeBridge();const a=await world(['composer.js'],off);const hidden=a.button('◉ Voice')!;expect(hidden.hidden).toBe(true);
 const on=fakeBridge();on.state.data.voice=voiceFixture();const b=await world(['composer.js'],on);const voice=b.button('◉ Voice')!;expect(voice.hidden).toBe(false);
 await voice.click();expect(on.startConversation).toHaveBeenCalledTimes(1);expect(on.voiceOptions.remaining).toBe(0);
 on.voiceOptions.conversation=true;b.emit('echo-workspace-context');expect(voice.attributes['aria-pressed']).toBe('true');
 await voice.click();expect(on.stopVoice).toHaveBeenCalledTimes(1);
});
it('adds Copy, Save to library and Listen to the right saved messages without mutating live streams',async()=>{
 const bridge=fakeBridge();bridge.state.data.voice=voiceFixture();
 const reply='Here:\n```python\nprint(1)\n```\nDone.';
 bridge.state.chat.messages=[{id:'u1',role:'user',content:'hi'},{id:'a1',role:'assistant',content:reply}];
 const w=await world(['composer.js'],bridge),log=w.get('#chat-log');
 const make=(role:string,text:string)=>{const a=new Node('article');a.className='chat-message '+role;const p=new Node('p');p._text=text;a.append(new Node('strong'),p);return a;};
 const user=make('user','hi'),assistant=make('assistant',reply),streamed=make('assistant','still streaming'),activity=make('activity','Using esh');
 log.append(user,assistant,activity,streamed);w.emit('echo-workspace-context');
 const labels=(n:Node)=>walk(n).filter(x=>x.tagName==='BUTTON').map(x=>x.textContent);
 expect(labels(user)).toEqual(['Copy']);expect(labels(assistant)).toEqual(['Save file','Copy','Save to library','▶ Listen']);expect(labels(activity)).toEqual([]);expect(labels(streamed)).toEqual([]);
 w.emit('echo-workspace-context');expect(labels(assistant).length).toBe(4);
 await w.button('Copy')!.click();expect(w.clipboard).toEqual(['hi']);
 await walk(assistant).find(x=>x.tagName==='BUTTON'&&x.textContent==='▶ Listen')!.click();expect(bridge.speakReply).toHaveBeenCalledWith(bridge.state.chat.messages[1],'c1');
 expect(walk(assistant).find(x=>x.tagName==='CODE')!.textContent).toBe('print(1)');
 const plain=fakeBridge();plain.state.chat.messages=[{id:'a2',role:'assistant',content:'ok'}];const p=await world(['composer.js'],plain);const a=make('assistant','ok');p.get('#chat-log').append(a);p.emit('echo-workspace-context');expect(labels(a)).toEqual(['Copy','Save to library']);
});
it('splits fenced code, names saved files by language and keeps unbalanced fences as text',async()=>{
 const c=await meterOf();
 expect(c.splitBlocks('a\n```ts\nlet x=1\n```\nb')).toEqual([{type:'text',text:'a'},{type:'code',language:'ts',text:'let x=1'},{type:'text',text:'b'}]);
 expect(c.splitBlocks('x\n```js\nopen')).toEqual([{type:'text',text:'x\n```js\nopen'}]);expect(c.splitBlocks('')).toEqual([]);
 expect(c.fileNameFor('python')).toBe('note.py');expect(c.fileNameFor('Rust')).toBe('note.rs');expect(c.fileNameFor('')).toBe('note.txt');expect(c.fileNameFor('md')).toBe('note.md');expect(c.fileNameFor('weird language')).toBe('note.txt');
});
it('saves a message or code block to the library with chat linkage and refuses credential-looking names',async()=>{
 const bridge=fakeBridge();bridge.state.chat.project_id='p1';bridge.state.chat.messages=[{id:'a1',role:'assistant',content:'```python\nx=1\n```'}];
 const w=await world(['composer.js'],bridge),log=w.get('#chat-log');
 const a=new Node('article');a.className='chat-message assistant';const p=new Node('p');p._text='```python\nx=1\n```';a.append(p);log.append(a);w.emit('echo-workspace-context');
 await walk(a).find(x=>x.textContent==='Save file')!.click();
 const dialog=w.all().find(n=>n.attributes['data-composer-dialog']==='save')!;expect(dialog.open).toBe(true);
 const name=walk(dialog).find(n=>n.attributes['data-field']==='name')!,text=walk(dialog).find(n=>n.attributes['data-field']==='content')!;
 expect(name.value).toBe('note.py');expect(text.value).toBe('x=1');
 name.value='.env';await walk(dialog).find(n=>n.tagName==='BUTTON'&&n.textContent==='Save to your library')!.click();expect(bridge.api).not.toHaveBeenCalledWith('/library',expect.anything());
 name.value='ok.py';await walk(dialog).find(n=>n.tagName==='BUTTON'&&n.textContent==='Save to your library')!.click();
 expect(bridge.api).toHaveBeenCalledWith('/library',{name:'ok.py',content:'x=1',chat_id:'c1',project_id:'p1'});expect(bridge.refresh).toHaveBeenCalled();expect(dialog.open).toBe(false);expect(text.value).toBe('');
});
it('chooses a personality through the tenant-safe action and renders the checkpoint banner',async()=>{
 const bridge=fakeBridge();bridge.state.chat.events=[{kind:'personality_selected',content:'forge'}];bridge.state.chat.summary='Earlier work summarised.';
 bridge.api=vi.fn(async(path:string)=>path==='/chats/c1'?{id:'c1',messages:[],events:[]}:{});
 const w=await world(['composer.js'],bridge);w.emit('echo-workspace-context');
 const select=w.all().find(n=>n.tagName==='SELECT'&&n.attributes['data-personality']!==undefined)!;
 expect(select.value).toBe('forge');expect(select.children.map(o=>o.value)).toEqual(['auto','forge']);
 select.value='auto';await select.fire('change');
 expect(bridge.api).toHaveBeenCalledWith('/action',{action:'personality_select',chat_id:'c1',profile:'auto'});expect(bridge.setChat).toHaveBeenCalled();
 const banner=w.all().find(n=>n.tagName==='DETAILS'&&n.attributes['data-checkpoint']!==undefined)!;expect(banner.hidden).toBe(false);expect(banner.textContent).toContain('Checkpoint active · original history preserved');expect(banner.textContent).toContain('Earlier work summarised.');
 bridge.state.chat.summary='';w.emit('echo-workspace-context');expect(banner.hidden).toBe(true);
});

// ---------- voice bar ----------
it('only models a visible voice bar when the backend explicitly reports voice configured',async()=>{
 const w=await world(['voicebar.js'],fakeBridge()),v=w.window.EchoPrimeVoiceBar;
 const base={options:{},capture:null,micPending:false,speaking:false};
 for(const voice of [undefined,null,{},{configured:false},{configured:'true'},{configured:1}])expect(v.model({...base,voice}).visible).toBe(false);
 expect(v.model({...base,voice:voiceFixture()}).visible).toBe(true);
});
it('builds the status line from the real backend voice and provider values',async()=>{
 const w=await world(['voicebar.js'],fakeBridge()),v=w.window.EchoPrimeVoiceBar,base={options:{},capture:null,micPending:false,speaking:false};
 expect(v.model({...base,voice:voiceFixture()}).line).toBe('Test Voice · ElevenLabs · Microphone off');
 expect(v.model({...base,voice:voiceFixture({label:'Aria',provider:'acme-speech'})}).line).toBe('Aria · acme-speech · Microphone off');
 expect(v.model({...base,voice:voiceFixture({label:'Aria'}),capture:{}}).line).toContain('Listening');
 expect(v.model({...base,voice:voiceFixture(),micPending:true}).line).toContain('Transcribing');
 expect(v.model({...base,voice:voiceFixture(),speaking:true}).line).toBe('Test Voice · ElevenLabs · Speaking · Microphone off');
 expect(v.model({...base,voice:voiceFixture({label:undefined,persona:'forge-voice',provider:undefined})}).line).toBe('forge-voice · Microphone off');
 expect(v.model({...base,voice:voiceFixture({provider_usage:'Cloud speech uses your acme account.'})}).footer).toBe('Personality Forge · Cloud speech uses your acme account.');
 expect(JSON.stringify(source('voicebar.js'))).not.toMatch(/M Freeman|Freeman/);
});
it('starts with every voice preference off and never reads or writes browser storage',async()=>{
 const bridge=fakeBridge();bridge.state.data.voice=voiceFixture();const w=await world(['voicebar.js'],bridge);
 const box=(k:string)=>w.input('data-voice-option',k)!;
 for(const k of ['spoken','brief','autoSend'])expect(box(k).checked).toBe(false);
 box('brief').checked=true;await box('brief').fire('change');box('autoSend').checked=true;await box('autoSend').fire('change');box('spoken').checked=true;await box('spoken').fire('change');
 expect(bridge.voiceOptions).toMatchObject({spoken:true,brief:true,autoSend:true,conversation:false});
 box('spoken').checked=false;await box('spoken').fire('change');expect(bridge.voiceOptions.spoken).toBe(false);expect(bridge.endConversation).toHaveBeenCalled();expect(bridge.stopAudio).toHaveBeenCalled();
 expect(w.storage).toEqual({});
 // A new account resets the shared options in place; the bar must follow, not remember.
 Object.assign(bridge.voiceOptions,{spoken:false,brief:false,autoSend:false});w.emit('echo-account-changed');
 for(const k of ['spoken','brief','autoSend'])expect(box(k).checked).toBe(false);
 expect(JSON.stringify(source('voicebar.js'))).not.toMatch(/localStorage|sessionStorage|indexedDB/);
});
it('shows or hides the bar with the account and lets the bridge know it is visible',async()=>{
 const bridge=fakeBridge();const w=await world(['voicebar.js'],bridge),root=w.all().find(n=>n.attributes['data-voice-bar']!==undefined)!;
 expect(root.hidden).toBe(true);expect(bridge.state.voiceBar).toBe(false);
 bridge.state.data.voice=voiceFixture();w.emit('echo-workspace-context');expect(root.hidden).toBe(false);expect(bridge.state.voiceBar).toBe(true);
 expect(w.all().find(n=>n.attributes['data-voice-line']!==undefined)!.textContent).toBe('Test Voice · ElevenLabs · Microphone off');
 bridge.state.data=null;w.emit('echo-account-changed');expect(root.hidden).toBe(true);expect(bridge.state.voiceBar).toBe(false);
});
it('routes Interrupt & speak and Stop voice through the bridge and reports failures in the bar',async()=>{
 const bridge=fakeBridge();bridge.state.data.voice=voiceFixture();const w=await world(['voicebar.js'],bridge);
 await w.button('Interrupt & speak')!.click();expect(bridge.interrupt).toHaveBeenCalledTimes(1);
 await w.button('Stop voice')!.click();expect(bridge.stopVoice).toHaveBeenCalledTimes(1);
 bridge.interrupt=vi.fn(async()=>{throw new Error('Open an idle saved conversation before dictating.');});
 await w.button('Interrupt & speak')!.click();
 expect(w.all().find(n=>n.attributes['data-voice-message']!==undefined)!.textContent).toContain('Open an idle saved conversation');
 bridge.hooks[0]('Listening · Up to eight seconds');expect(w.all().find(n=>n.attributes['data-voice-message']!==undefined)!.textContent).toContain('Listening');
});

// ---------- plugins & memory ----------
const pluginsWorld=async(bridge:any)=>{const w=await world(['plugins.js'],bridge);await w.window.EchoPrimePlugins.open();await tick();return w;};
const cardTitles=(w:World)=>w.all().filter(n=>n.tagName==='H3').map(n=>n.textContent);
it('shows a non-owner only their MCP connections and private preferences',async()=>{
 const bridge=fakeBridge();bridge.session={authenticated:true,ownerAccess:false,user:{uid:'m',status:'approved'}};
 bridge.api=vi.fn(async(path:string)=>path==='/mcp'?{connections:[{id:'k1',name:'Docs',url:'https://docs.example/mcp',enabled:true,tool_count:3}]}:{});
 const w=await pluginsWorld(bridge),titles=cardTitles(w);
 expect(titles).toContain('Docs');expect(titles).toContain('Connect a Streamable HTTP MCP server');expect(titles).toContain('Private preferences');
 for(const owner of ['Check connections','Recall a memory','Store a memory','Automatic journal hooks','Personality Forge','Directive profile'])expect(titles).not.toContain(owner);
 expect(bridge.api.mock.calls.map((c:any[])=>c[0])).toEqual(['/mcp']);
});
it('gives the primary owner connection checks, recall, Crystal storage, journal hooks and assets',async()=>{
 const bridge=fakeBridge();bridge.state.data.voice=voiceFixture();const w=await pluginsWorld(bridge),titles=cardTitles(w);
 for(const t of ['Check connections','Recall a memory','Store a memory','Automatic journal hooks','Personality Forge','Directive profile','Private preferences'])expect(titles).toContain(t);
 await w.button('Check connections')!.click();
 const text=w.all().map(n=>n.textContent).join('|');
 expect(bridge.api).toHaveBeenCalledWith('/plugins');expect(text).toContain('Crystal memory');expect(text).toContain('Continuity Fabric (ECF)');expect(text).toContain('ESH');expect(text).toContain('HTTP 403 continuity.read');expect(text).toContain('Readable');expect(text).toContain('Unavailable');
 const noVoice=fakeBridge();expect(cardTitles(await pluginsWorld(noVoice))).not.toContain('Personality Forge');
});
it('recalls with the chosen source and stores to Crystal with the exact backend action',async()=>{
 const bridge=fakeBridge();const w=await pluginsWorld(bridge);
 const field=(k:string)=>w.input('data-field',k)!;
 field('recall-query').value='open decisions';field('recall-source').value='crystal';await w.button('Search memories')!.click();
 expect(bridge.api).toHaveBeenCalledWith('/action',{action:'memory_search',plugin:'crystal',query:'open decisions',chat_id:'c1'});
 await w.button('Save to Crystal')!.click();expect(bridge.api).not.toHaveBeenCalledWith('/action',expect.objectContaining({action:'crystal_save'}));
 field('crystal-content').value='Decision: keep voice off by default.';await w.button('Save to Crystal')!.click();
 expect(bridge.api).toHaveBeenCalledWith('/action',{action:'crystal_save',content:'Decision: keep voice off by default.',chat_id:'c1'});
 expect(w.all().map(n=>n.textContent).join('|')).toContain('receipt');
});
it('requests personality assets only for the owner when voice is configured',async()=>{
 const bridge=fakeBridge();bridge.state.data.voice=voiceFixture();const w=await pluginsWorld(bridge);
 await w.button('View personality assets')!.click();expect(bridge.api).toHaveBeenCalledWith('/action',{action:'personality_assets',chat_id:'c1'});
});
it('revalidates owner admission at click time instead of trusting the rendered view',async()=>{
 const bridge=fakeBridge();const w=await pluginsWorld(bridge);bridge.api.mockClear();
 bridge.session={authenticated:true,ownerAccess:false,user:{uid:'owner',status:'approved'}};
 await w.button('Check connections')!.click();(w.input('data-field','crystal-content')!).value='x';await w.button('Save to Crystal')!.click();
 expect(bridge.api).not.toHaveBeenCalled();
});
it('lists journal hook delivery from the saved sync counts',async()=>{
 const w=await pluginsWorld(fakeBridge()),text=w.all().map(n=>n.textContent).join('|');
 expect(text).toContain('3 records have exact ECF readback; 1 awaiting confirmation');
});
it('adds, enables and removes MCP connections with exact payloads and clears the credential field',async()=>{
 const bridge=fakeBridge();bridge.api=vi.fn(async(path:string)=>path==='/mcp'?{connections:[{id:'k1',name:'Docs',url:'https://docs.example/mcp',enabled:true,tool_count:3}]}:{});
 const w=await pluginsWorld(bridge),f=(k:string)=>w.input('data-field',k)!;
 const token=f('mcp-token');f('mcp-name').value='Search';f('mcp-url').value='https://search.example/mcp';f('mcp-auth').value='bearer';f('mcp-token').value='secret-token';
 await w.button('Connect and discover tools')!.click();
 expect(bridge.api).toHaveBeenCalledWith('/mcp',{action:'add',name:'Search',url:'https://search.example/mcp',auth:'bearer',token:'secret-token'});
 await w.button('Disable')!.click();expect(bridge.api).toHaveBeenCalledWith('/mcp',{action:'enable',id:'k1',enabled:false});
 await w.button('Remove connection')!.click();expect(bridge.api).toHaveBeenCalledWith('/mcp',{action:'remove',id:'k1'});
 expect(token.value).toBe('');
});
it('summarises MCP tool schemas as names and descriptions and falls back to text',async()=>{
 const w=await world(['plugins.js'],fakeBridge()),p=w.window.EchoPrimePlugins;
 expect(p.toolSummary({tools:[{name:'search',description:'Find things'},{name:'read'}]})).toBe('search — Find things\nread');
 expect(p.toolSummary({other:1})).toBe(JSON.stringify({other:1},null,2));
 expect(p.connectionCards({crystal:{ok:true},ecf:{ok:false,error:'denied'}}).map((c:any)=>[c.key,c.ok,c.detail])).toEqual([['crystal',true,'Live read succeeded'],['ecf',false,'denied'],['esh',false,'Not checked']]);
});
it('does not call the backend for a signed-out visitor and clears the dialog when the account changes',async()=>{
 const bridge=fakeBridge();bridge.state.data=null;bridge.session={authenticated:false,ownerAccess:false,user:null};
 const w=await pluginsWorld(bridge);expect(bridge.api).not.toHaveBeenCalled();expect(w.all().map(n=>n.textContent).join('|')).toContain('Sign in to an approved account');
 const owner=fakeBridge();const o=await pluginsWorld(owner);const token=o.input('data-field','mcp-token')!;token.value='tmp';
 const dialog=o.all().find(n=>n.tagName==='DIALOG')!;expect(dialog.open).toBe(true);o.emit('echo-account-changed');expect(dialog.open).toBe(false);expect(token.value).toBe('');
});
it('adds first-class navigation entries and workspace labels without touching offline Prime',async()=>{
 const bridge=fakeBridge();const w=await world(['plugins.js'],bridge);
 expect(w.window.EchoPrimePlugins.navLabels).toMatchObject({chats:'Chats',recent:'Recent chats'});
 const off=await world(['plugins.js'],fakeBridge(),{enabled:false});expect(off.get('.history-heading').textContent).toBe('');
 const html=readFileSync(new URL('../ui/echo-prime/index.html',import.meta.url),'utf8');
 for(const label of ['Projects','Library','Plugins &amp; memory','SDK','Vault','Code review','Logs &amp; debugging'])expect(html).toContain('>'+label+'</button>');
 expect(html).toContain('data-view="logs"');expect(html).toMatch(/data-view="logs"[^>]*data-owner-only|data-owner-only[^>]*data-view="logs"/);
 expect(html).toContain('composer.css');
 for(const file of ['composer.js','voicebar.js','plugins.js'])expect(html).toContain(file);
});

// ---------- workspace.js facade ----------
it('exposes a narrow bridge, caps hands-free voice at ten turns and publishes context updates',async()=>{
 const nodes=new Map<string,Node>(),events:Record<string,((e:any)=>unknown)[]>={};
 const get=(s:string)=>{if(!nodes.has(s))nodes.set(s,new Node());return nodes.get(s)!;};
 const session={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
 const request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],preferences:[],personalities:[],context_length:1000,voice:voiceFixture()}:path==='/chats'?{id:'c1',messages:[]}:{});
 class Transport {session=session;constructor(){}loadSession=async()=>this.session;request=request;chat=vi.fn();text=vi.fn();audio=vi.fn();headers=()=>({});clear(){}auth=vi.fn();}
 const window:any={addEventListener:(n:string,f:(e:any)=>unknown)=>(events[n]??=[]).push(f),dispatchEvent:(e:any)=>{for(const f of events[e.type]||[])f(e);},EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()}};
 const gum=new Promise<never>(()=>{});
 const document:any={hidden:false,head:new Node(),querySelector:get,querySelectorAll:()=>[],createElement:(t:string)=>new Node(t),createTextNode:(t:string)=>Object.assign(new Node('#text'),{_text:t}),addEventListener(){}};
 get('#workspace-chat-kind').value='workspace';
 runInNewContext(source('workspace.js'),{window,document,navigator:{mediaDevices:{getUserMedia:()=>gum}},crypto:{randomUUID},setTimeout,clearTimeout,AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,console:{debug:vi.fn()}});
 await window.EchoPrimeWorkspace.ready;const bridge=window.EchoPrimeWorkspace.bridge;
 expect(Object.keys(bridge).sort()).toEqual(expect.arrayContaining(['api','dictate','endConversation','interrupt','onStatus','refresh','session','setChat','speakReply','startConversation','state','stopAudio','stopVoice','updateContext','voiceOptions']));
 expect(JSON.stringify(Object.keys(bridge))).not.toMatch(/csrf|token|headers/i);
 expect(bridge.voiceOptions).toMatchObject({spoken:false,brief:false,autoSend:false,conversation:false,remaining:0});
 let updates=0;window.addEventListener('echo-workspace-context',()=>{updates++;});bridge.updateContext();expect(updates).toBe(1);
 const seen:string[]=[];bridge.onStatus((t:string)=>seen.push(t));
 await window.EchoPrimeWorkspace.newChat();void bridge.startConversation().catch(()=>{});await tick();
 expect(bridge.voiceOptions.conversation).toBe(true);expect(bridge.voiceOptions.remaining).toBe(10);expect(bridge.state.micPending).toBe(true);
 await bridge.stopVoice();expect(bridge.voiceOptions.conversation).toBe(false);expect(bridge.voiceOptions.remaining).toBe(0);expect(seen.length).toBeGreaterThan(0);
});

it('serves the composer, voice bar, plugins and stylesheet assets from the allowlist',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prime-composer-'));
 for(const name of ['index.html','composer.js','voicebar.js','plugins.js','composer.css'])writeFileSync(join(dir,name),'/* '+name+' */');
 const s=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0);
 try{
  const page=await fetch(s.url),cookie=page.headers.get('set-cookie')!.split(';')[0];
  for(const name of ['composer.js','voicebar.js','plugins.js','composer.css']){const r=await fetch(s.url+'/'+name,{headers:{cookie}});expect(r.status).toBe(200);expect(await r.text()).toContain(name);}
  expect((await fetch(s.url+'/logs-private.js',{headers:{cookie}})).status).toBe(404);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});
