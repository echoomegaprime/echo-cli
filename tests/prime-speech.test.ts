/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM, bridge and media stand-ins mirror prime-composer-ui.test.ts */
import {expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPrimeServer} from '../src/prime/server.js';
import {PrimeHub} from '../src/prime/hub.js';

// Executes the shipped speech.js (Echo talks: ConvAI-style spoken replies) against a small DOM
// stand-in, a synthetic Workspace bridge with stand-in /voice routes and fake media APIs.
// Nothing here talks to a real backend, microphone or speaker.
class Node {
 tagName:string;_text='';className='';hidden=false;disabled=false;checked=false;open=false;value='';volume=1;isConnected=true;
 dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];inserted:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};style={setProperty:vi.fn()};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 get textContent():string{return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(value:string){this._text=String(value);this.children=[];}
 get classList(){const tokens=()=>this.className.split(/\s+/).filter(Boolean),set=(list:string[])=>{this.className=list.join(' ');};const api={add:(c:string)=>{if(!tokens().includes(c))set([...tokens(),c]);},remove:(c:string)=>{set(tokens().filter(x=>x!==c));},toggle:(c:string,on?:boolean)=>{if(on===undefined?!tokens().includes(c):on)api.add(c);else api.remove(c);},contains:(c:string)=>tokens().includes(c)};return api;}
 get parentNode(){return this.parent;}
 append(...items:Node[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this._text='';this.append(...items);}
 after(...items:Node[]){for(const item of items)item.parent=this.parent;this.inserted.push(...items);} before(...items:Node[]){this.inserted.push(...items);}
 setAttribute(key:string,value:string){this.attributes[key]=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},stopPropagation(){},target:this,...event});}
 focus(){} click(){return this.fire('click');}
 querySelector(selector:string):Node|null{return walk(this).find(n=>matches(n,selector))||null;}
}
function matches(n:Node,selector:string){return selector.startsWith('.')?n.className.split(/\s+/).includes(selector.slice(1)):selector.startsWith('#')?n.attributes.id===selector.slice(1):n.tagName===selector.toUpperCase();}
function walk(root:Node):Node[]{return [...root.children,...root.inserted].flatMap(c=>[c,...walk(c)]);}
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const voiceFixture=(extra:Record<string,unknown>={})=>({configured:true,persona:'forge-voice',label:'Test Voice',provider:'elevenlabs',provider_usage:'Cloud speech uses your ElevenLabs account.',end_of_turn_ms:1500,...extra});
const reply=(id='a1',content='Hello there. This is Echo speaking to you now.')=>({id,role:'assistant',content});

class FakeAudio {
 static instances:FakeAudio[]=[];static block=false;
 src:string;volume=1;paused=true;listeners:Record<string,((e?:any)=>unknown)[]>={};
 constructor(src:string){this.src=src;FakeAudio.instances.push(this);}
 addEventListener(name:string,fn:(e?:any)=>unknown){(this.listeners[name]??=[]).push(fn);}
 removeEventListener(name:string,fn:(e?:any)=>unknown){this.listeners[name]=(this.listeners[name]||[]).filter(f=>f!==fn);}
 play(){if(FakeAudio.block){const error=new Error('play() failed because the user did not interact with the document first');(error as any).name='NotAllowedError';return Promise.reject(error);}this.paused=false;return Promise.resolve();}
 pause(){this.paused=true;}
 end(){this.paused=true;for(const fn of this.listeners.ended||[])fn();}
 fail(){for(const fn of this.listeners.error||[])fn();}
}
interface World {window:any;document:any;get:(s:string)=>Node;emit:(type:string,detail?:unknown)=>void;emitDocument:(type:string)=>void;all:()=>Node[];button:(label:string)=>Node|undefined;attr:(name:string)=>Node|undefined;storage:Map<string,string>;audios:()=>FakeAudio[];spoken:()=>FakeAudio[];utterances:any[];synth:any;orb:any[];debug:any[];speech:any;bridge:any;media:any;dispose:()=>void}
function fakeBridge(over:Record<string,any>={}){
 const hooks:Array<(text:string)=>void>=[];
 const state:any={data:{context_length:262144,library:[],projects:[],personalities:[],voice:voiceFixture()},chat:{id:'c1',title:'T',project_id:null,messages:[],events:[]},attachments:new Set<string>(),speech:null,capture:null,micPending:false,turn:null,accountEpoch:0,epoch:0,voiceBar:false,...over.state};
 const voiceOptions={spoken:false,brief:false,autoSend:false,conversation:false,remaining:0,limitReached:false};
 const api=vi.fn(async(path:string,body:any)=>{
  if(path==='/voice/start')return {audio_url:'/api/voice/audio/chunk0',has_more:true,session_id:'s1',chunk_index:0,provider:'elevenlabs',voice:'Test Voice'};
  if(path==='/voice/next')return {audio_url:'/api/voice/audio/chunk'+body.chunk_index,has_more:body.chunk_index<2,session_id:'s1',chunk_index:body.chunk_index};
  if(path==='/voice/cancel')return {stopped:true,in_flight_provider_work_may_finish:true};
  if(path==='/voice/transcribe')return {provider:'elevenlabs-scribe',text:'hello echo'};
  return {};
 });
 const bridge:any={state,voiceOptions,session:{authenticated:true,ownerAccess:true,user:{uid:'owner',status:'approved'}},hooks,api,
  audio:vi.fn(async(path:string)=>new Blob([path])),refresh:vi.fn(async()=>{}),openChat:vi.fn(async()=>{}),updateContext:vi.fn(),dictate:vi.fn(async()=>{}),speakReply:vi.fn(async()=>true),stopAudio:vi.fn(),endConversation:vi.fn(),
  startConversation:vi.fn(async()=>{}),stopVoice:vi.fn(async()=>{}),interrupt:vi.fn(async()=>{}),setChat:vi.fn(),onStatus:vi.fn((fn:(t:string)=>void)=>{hooks.push(fn);}),...over.bridge};
 return bridge;
}
async function world(files:string[],bridge:any,options:{enabled?:boolean;storage?:Map<string,string>;storageThrows?:boolean;rms?:{value:number}}={}):Promise<World>{
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},documentEvents:Record<string,((event:any)=>unknown)[]>={},orb:any[]=[],debug:any[]=[],utterances:any[]=[];
 const storage=options.storage??new Map<string,string>();
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector)!;};
 const body=new Node('body');
 const all=()=>[body,...nodes.values()].flatMap(n=>[n,...walk(n)]);
 // Attribute selectors resolve against rendered nodes like a real document; other selectors are stable stand-ins.
 const query=(selector:string)=>{const attribute=/^\[([\w-]+)\]$/.exec(selector);if(attribute)return all().find(n=>n.attributes[attribute[1]]!==undefined)||null;return get(selector);};
 FakeAudio.instances=[];FakeAudio.block=false;
 const send=vi.fn(async()=>({handled:true,sent:true,verified:true,detail:'ok'})),newChat=vi.fn(async()=>true);
 const window:any={addEventListener:(name:string,fn:(e:any)=>unknown)=>(events[name]??=[]).push(fn),removeEventListener(){},dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);},
  EchoPrimeWorkspace:{ready:Promise.resolve(options.enabled??true),get enabled(){return options.enabled??true;},bridge,get session(){return bridge.session;},send,newChat}};
 const document:any={body,head:new Node('head'),hidden:false,querySelector:query,querySelectorAll:()=>[],createElement:(t:string)=>new Node(t),createTextNode:(t:string)=>Object.assign(new Node('#text'),{_text:t}),
  addEventListener:(name:string,fn:(e:any)=>unknown)=>(documentEvents[name]??=[]).push(fn),dispatchEvent:(event:any)=>{orb.push(event.detail);}};
 const localStorage=options.storageThrows?{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}}:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v);},removeItem:(k:string)=>{storage.delete(k);}};
 const synth={speak:vi.fn((u:any)=>{utterances.push(u);setTimeout(()=>{u.onstart?.();u.onend?.();},0);}),cancel:vi.fn(),getVoices:()=>[{lang:'en-US',name:'Device English'},{lang:'ja-JP',name:'Device Japanese'}]};
 class SpeechSynthesisUtterance {text:string;lang='';voice:any=null;onstart:any=null;onend:any=null;onerror:any=null;constructor(text:string){this.text=text;}}
 const rms=options.rms??{value:0};
 const media={tracks:[{stop:vi.fn()}],processor:null as any,getUserMedia:vi.fn(async()=>({getTracks:()=>media.tracks}))};
 class AudioContext {state='running';sampleRate=16000;destination={};
  createMediaStreamSource(){return {connect(){},disconnect(){}};}
  createAnalyser(){return {fftSize:1024,connect(){},disconnect(){},getFloatTimeDomainData(buffer:Float32Array){buffer.fill(rms.value);}};}
  createScriptProcessor(){media.processor={connect(){},disconnect(){},onaudioprocess:null as any};return media.processor;}
  createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
  async resume(){} async close(){}}
 let urls=0;
 const context={window,document,localStorage,sessionStorage:localStorage,navigator:{mediaDevices:{getUserMedia:media.getUserMedia}},crypto:{randomUUID},Event,CustomEvent,setTimeout,clearTimeout,console:{debug:(_tag:string,event:any)=>debug.push(event),warn:vi.fn()},
  Audio:FakeAudio,URL:{createObjectURL:()=>'blob:echo-'+(++urls),revokeObjectURL:vi.fn()},Blob,atob:(x:string)=>Buffer.from(x,'base64').toString('binary'),btoa:(x:string)=>Buffer.from(x,'binary').toString('base64'),
  speechSynthesis:synth,SpeechSynthesisUtterance,AudioContext,AbortController,Error,Number,Math,JSON,Set,Map,Array,Object,String,Promise,Boolean,Float32Array,Uint8Array,ArrayBuffer,DataView,Infinity};
 for(const file of files)runInNewContext(source(file),context);
 await tick();
 const button=(label:string)=>all().find(n=>n.tagName==='BUTTON'&&n.textContent.trim()===label);
 const attr=(name:string)=>all().find(n=>n.attributes[name]!==undefined);
 const speech=window.EchoPrimeSpeech;
 return {window,document,get,emit:(type,detail)=>window.dispatchEvent(Object.assign(new Event(type),{detail})),emitDocument:(type)=>{for(const fn of documentEvents[type]||[])fn(new Event(type));},all,button,attr,storage,
  audios:()=>FakeAudio.instances,spoken:()=>FakeAudio.instances.filter(a=>a.volume!==0),utterances,synth,orb,debug,speech,bridge,media,
  dispose(){try{speech?.stop('cleanup',{quiet:true,cancelBackend:false});speech?.conversation?.stop('cleanup');}catch{}}};
}
const pure=async()=>(await world(['speech.js'],fakeBridge(),{enabled:false})).window.EchoPrimeSpeech;
const voiceWorld=async(over:Record<string,any>={},options:Record<string,any>={})=>{const bridge=fakeBridge(over);const w=await world(['speech.js'],bridge,options);return {w,bridge};};
async function speaking(w:World,message=reply()){const before=w.spoken().length;w.emit('echo-reply-saved',{chatId:'c1',message});await vi.waitFor(()=>expect(w.spoken().length).toBeGreaterThan(before));const audio=w.spoken()[w.spoken().length-1];await vi.waitFor(()=>expect(audio.paused).toBe(false));return audio;}

// ---------- text normalisation ----------
it('strips markdown headings, emphasis and list markers and reads inline code verbatim',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('# Title\n\n**Bold** and *em* text with `npm test` here.\n- first point\n2. second point')).toBe('Title. Bold and em text with npm test here. first point. second point.');
});
it('reads URLs and markdown links as "link" and email addresses generically',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('See https://example.com/a?b=1 and [docs](https://x.y/z). Mail ops@example.com.')).toBe('See link and docs (link). Mail email address.');
});
it('replaces fenced code with "code block omitted" and keeps surrounding prose',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('Run:\n```sh\nnpm test\n```\nDone.')).toBe('Run: Code block omitted. Done.');
 expect(s.normalizeForSpeech('Open fence\n```js\nlet x=1')).toBe('Open fence. Code block omitted.');
});
it('summarises markdown tables instead of reading cells',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toBe('Table with two rows and two columns, columns: a, b.');
});
it('expands numbers, decimals, percentages, currency and ordinals',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('We shipped 1,234 fixes and 3.5 units at 42% for $19.99 on the 3rd try.')).toBe('We shipped one thousand two hundred thirty-four fixes and three point five units at forty-two percent for nineteen dollars and ninety-nine cents on the third try.');
 expect(s.normalizeForSpeech('Version 1.2.3 took 250 ms and -4 steps.')).toBe('Version one point two point three took two hundred fifty milliseconds and minus four steps.');
 expect(s.cardinal('1000000')).toBe('one million');expect(s.ordinal('22')).toBe('twenty-second');expect(s.cardinal('1234567890123456')).toBe('one two three four five six seven eight nine zero one two three four five six');
});
it('expands ISO and US dates, times and years',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('Due 2026-11-04 at 4:05 pm.')).toBe('Due November fourth, twenty twenty-six at four oh five p m.');
 expect(s.normalizeForSpeech('On 7/4/1999 and in 2005.')).toBe('On July fourth, nineteen ninety-nine and in twenty oh five.');
});
it('hides identifiers and file paths and never speaks screen-only hashes',async()=>{
 const s=await pure();
 expect(s.normalizeForSpeech('Hash 0123456789abcdef0123456789abcdef in /home/forge/x.txt')).toBe('Hash identifier in file path.');
 expect(s.normalizeForSpeech('')).toBe('');expect(s.normalizeForSpeech(null)).toBe('');
});
it('detects the language of a reply for passthrough to the voice',async()=>{
 const s=await pure();
 expect(s.detectLanguage('こんにちは、元気ですか？今日はいい天気ですね。')).toBe('ja');expect(s.detectLanguage('Привет, как дела сегодня?')).toBe('ru');
 expect(s.detectLanguage('Hello there, how are you today?')).toBe('en');expect(s.detectLanguage('Gracias por la ayuda con el proyecto de la semana.')).toBe('es');
});

// ---------- sentence chunking ----------
it('splits sentences while respecting abbreviations, decimals and closing quotes',async()=>{
 const s=await pure(),chunk=(t:string)=>{const c=s.createChunker({min:1});return c.push(t).concat(c.flush());};
 expect(chunk('Dr. Smith, e.g. a doctor, paid $3.50 at 5 p.m. He left! Did he? "Yes." Next')).toEqual(['Dr. Smith, e.g. a doctor, paid $3.50 at 5 p.m. He left!','Did he?','"Yes."','Next']);
 expect(chunk('1. First item is here.\n2. Second item is here.')).toEqual(['1. First item is here.','2. Second item is here.']);
 expect(chunk('こんにちは。元気ですか？')).toEqual(['こんにちは。','元気ですか？']);
});
it('emits complete sentences incrementally from a token stream and flushes the remainder',async()=>{
 const s=await pure(),c=s.createChunker({min:1});
 expect(c.push('Pi is 3.')).toEqual([]);expect(c.push('14 exactly. And here is')).toEqual(['Pi is 3.14 exactly.']);
 expect(c.push(' more text')).toEqual([]);expect(c.pending).toBe('And here is more text');expect(c.flush()).toEqual(['And here is more text']);
});
it('merges short fragments and force-splits very long sentences at natural pauses',async()=>{
 const s=await pure();
 expect(s.chunkSentences('Hi. Yes. This is a sentence that is long enough to stand alone.')).toEqual(['Hi. Yes. This is a sentence that is long enough to stand alone.']);
 const long=Array.from({length:40},(_,i)=>'clause number '+i).join(', ')+'.';
 const parts=s.chunkSentences(long);expect(parts.length).toBeGreaterThan(1);for(const part of parts)expect(part.length).toBeLessThanOrEqual(300);expect(parts.join(' ')).toBe(long);
});

// ---------- ordered queue with one-ahead prefetch ----------
it('plays items in order and prefetches exactly the next item while the current one plays',async()=>{
 const s=await pure(),order:string[]=[];const resolvers:Array<()=>void>=[];
 const fetchNext=vi.fn(async(item:any,index:number)=>{order.push('fetch'+index);return {name:'item'+index,hasMore:index<2};});
 const play=vi.fn((item:any)=>{order.push('play:'+item.name);return new Promise<boolean>(resolve=>{resolvers.push(()=>resolve(true));});});
 const queue=s.createQueue({fetchNext,play});const run=queue.run({name:'item0',hasMore:true});
 await vi.waitFor(()=>expect(order).toEqual(['play:item0','fetch1']));
 resolvers[0]();await vi.waitFor(()=>expect(order).toEqual(['play:item0','fetch1','play:item1','fetch2']));
 resolvers[1]();await vi.waitFor(()=>expect(order).toEqual(['play:item0','fetch1','play:item1','fetch2','play:item2']));
 expect(fetchNext).toHaveBeenCalledTimes(2);resolvers[2]();expect(await run).toBe(true);
});
it('cancelling the queue aborts playback and ignores a prefetch that lands afterwards',async()=>{
 const s=await pure();let abortSeen=false;
 const fetchNext=vi.fn(async()=>({name:'late',hasMore:false}));
 const play=vi.fn((_item:any,signal:AbortSignal)=>new Promise<boolean>(resolve=>{signal.addEventListener('abort',()=>{abortSeen=true;resolve(false);});}));
 const queue=s.createQueue({fetchNext,play});const run=queue.run({name:'first',hasMore:true});
 await vi.waitFor(()=>expect(play).toHaveBeenCalledTimes(1));queue.cancel('test');
 expect(await run).toBe(false);expect(abortSeen).toBe(true);expect(play).toHaveBeenCalledTimes(1);expect(queue.cancelled).toBe(true);
});

// ---------- defaults, mute persistence, anonymous ----------
it('turns spoken replies on by default for a signed-in approved account and shows the dock',async()=>{
 const {w,bridge}=await voiceWorld();
 expect(bridge.voiceOptions.spoken).toBe(true);expect(w.attr('data-speech-dock')!.hidden).toBe(false);
 expect(w.attr('data-speech-voice')!.textContent).toBe("Echo's voice · Test Voice · elevenlabs");expect(w.attr('data-speech-count')!.textContent).toBe('Spoken: 0');
 expect(w.attr('data-speech-mute')!.textContent).toBe('🔇 Mute Echo');
});
it('keeps anonymous and unapproved visitors silent with the dock hidden',async()=>{
 const anon=await voiceWorld({bridge:{session:{authenticated:false,ownerAccess:false,user:null}}});
 expect(anon.bridge.voiceOptions.spoken).toBe(false);expect(anon.w.attr('data-speech-dock')!.hidden).toBe(true);
 anon.w.emit('echo-reply-saved',{chatId:'c1',message:reply()});await tick();expect(anon.bridge.api).not.toHaveBeenCalled();expect(anon.w.spoken()).toEqual([]);
 const pending=await voiceWorld({bridge:{session:{authenticated:true,ownerAccess:false,user:{uid:'m',status:'pending'}}}});
 expect(pending.bridge.voiceOptions.spoken).toBe(false);expect(pending.w.attr('data-speech-dock')!.hidden).toBe(true);
});
it('persists mute in browser storage, restores it on load and survives a blocked storage',async()=>{
 const storage=new Map<string,string>();const first=await voiceWorld({},{storage});
 await first.w.attr('data-speech-mute')!.click();
 expect(first.bridge.voiceOptions.spoken).toBe(false);expect(first.w.attr('data-speech-mute')!.textContent).toBe('🔊 Unmute Echo');
 expect(JSON.parse(storage.get('echo-prime-speech-v1')!)).toMatchObject({muted:true});
 first.w.emit('echo-reply-saved',{chatId:'c1',message:reply()});await tick();expect(first.bridge.api).not.toHaveBeenCalledWith('/voice/start',expect.anything());
 const second=await voiceWorld({},{storage});expect(second.bridge.voiceOptions.spoken).toBe(false);expect(second.w.attr('data-speech-mute')!.textContent).toBe('🔊 Unmute Echo');
 await second.w.attr('data-speech-mute')!.click();expect(second.bridge.voiceOptions.spoken).toBe(true);expect(JSON.parse(storage.get('echo-prime-speech-v1')!)).toMatchObject({muted:false});
 const blocked=await voiceWorld({},{storageThrows:true});expect(blocked.bridge.voiceOptions.spoken).toBe(true);await blocked.w.attr('data-speech-mute')!.click();expect(blocked.bridge.voiceOptions.spoken).toBe(false);
});
it('adds a mute control to the voice bar when it is present',async()=>{
 const bridge=fakeBridge();const w=await world(['voicebar.js','speech.js'],bridge);
 expect(w.attr('data-speech-bar-mute')).toBeTruthy();expect(w.attr('data-speech-voice')!.textContent).toBe("Echo's voice · Test Voice · ElevenLabs");
 await w.attr('data-speech-bar-mute')!.click();expect(bridge.voiceOptions.spoken).toBe(false);expect(w.attr('data-speech-mute')!.textContent).toBe('🔊 Unmute Echo');
});

// ---------- Echo voice pipeline ----------
it('speaks a saved reply through /voice/start, fetches the governed audio and reports time-to-first-audio',async()=>{
 const {w,bridge}=await voiceWorld();
 const audio=await speaking(w);
 expect(bridge.api).toHaveBeenCalledWith('/voice/start',expect.objectContaining({chat_id:'c1',message_id:'a1',mode:'full',read_identifiers:false}));
 const start=bridge.api.mock.calls.find((c:any[])=>c[0]==='/voice/start')!;expect(start[1].request_id).toMatch(/^[0-9a-f-]{36}$/);
 expect(bridge.audio).toHaveBeenCalledWith('/voice/audio/chunk0');expect(audio.paused).toBe(false);
 expect(bridge.state.speech).toEqual({chat_id:'c1',session_id:'s1'});
 const first=w.debug.find(e=>e.event==='first_audio');expect(first).toBeTruthy();expect(first.ttfa_ms).toBeGreaterThanOrEqual(0);expect(first.source).toBe('echo');expect(first.lang).toBe('en');
 expect(JSON.stringify(w.debug)).not.toContain('Hello there');
 expect(w.attr('data-speech-count')!.textContent).toBe('Spoken: 1');expect(w.attr('data-speech-status')!.textContent).toContain('Speaking · Test Voice');
 w.dispose();
});
it('prefetches the next chunk while the current one plays and plays chunks in order until has_more is false',async()=>{
 const {w,bridge}=await voiceWorld();
 const first=await speaking(w);
 await vi.waitFor(()=>expect(bridge.api).toHaveBeenCalledWith('/voice/next',{chat_id:'c1',session_id:'s1',chunk_index:1}));
 expect(bridge.audio).toHaveBeenCalledWith('/voice/audio/chunk1');expect(w.spoken().length).toBe(1);
 first.end();await vi.waitFor(()=>expect(w.spoken().length).toBe(2));
 await vi.waitFor(()=>expect(bridge.api).toHaveBeenCalledWith('/voice/next',{chat_id:'c1',session_id:'s1',chunk_index:2}));
 w.spoken()[1].end();await vi.waitFor(()=>expect(w.spoken().length).toBe(3));
 expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/next').map((c:any[])=>c[1].chunk_index)).toEqual([1,2]);
 w.spoken()[2].end();await vi.waitFor(()=>expect(w.speech.speaking).toBe(false));
 expect(bridge.state.speech).toBeNull();expect(w.debug.find(e=>e.event==='speech_finished')).toMatchObject({chunks:3});
 expect(w.attr('data-speech-status')!.textContent).toContain('Spoke with Test Voice');
});
it('suppresses duplicate speech for the same saved reply and reuses the request id on an explicit replay',async()=>{
 const {w,bridge}=await voiceWorld();
 await speaking(w);w.emit('echo-reply-saved',{chatId:'c1',message:reply()});await tick();
 expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start').length).toBe(1);
 expect(w.debug.find(e=>e.event==='duplicate_suppressed')).toMatchObject({message_id:'a1'});
 void w.speech.speakMessage(reply(),'c1',{force:true});
 await vi.waitFor(()=>expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start').length).toBe(2));
 const [a,b]=bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start');expect(a[1].request_id).toBe(b[1].request_id);
 w.dispose();
});
it('barges in when the user types, sends, presses Stop or the microphone: playback pauses and the provider session is cancelled',async()=>{
 const {w,bridge}=await voiceWorld();
 let audio=await speaking(w);await w.get('#prompt').fire('input');
 expect(audio.paused).toBe(true);await vi.waitFor(()=>expect(bridge.api).toHaveBeenCalledWith('/voice/cancel',{chat_id:'c1',session_id:'s1'}));expect(bridge.state.speech).toBeNull();
 expect(w.attr('data-speech-status')!.textContent).toContain('Stopped');expect(w.debug.find(e=>e.event==='stopped')).toMatchObject({reason:'typing'});
 audio=await speaking(w,reply('a2'));await w.get('#composer').fire('submit');expect(audio.paused).toBe(true);
 audio=await speaking(w,reply('a3'));await w.get('#stop-chat').fire('click');expect(audio.paused).toBe(true);
 audio=await speaking(w,reply('a4'));await w.get('#voice-button').fire('click');expect(audio.paused).toBe(true);expect(bridge.dictate).toHaveBeenCalledTimes(1);
 audio=await speaking(w,reply('a5'));w.emit('echo-voice-stop');expect(audio.paused).toBe(true);expect(w.speech.speaking).toBe(false);
});
it('stops when the tab is hidden and resumes only on request',async()=>{
 const {w,bridge}=await voiceWorld();
 const audio=await speaking(w);w.document.hidden=true;w.emitDocument('visibilitychange');
 expect(audio.paused).toBe(true);expect(w.speech.deferred).toBe(true);expect(w.attr('data-speech-resume')!.hidden).toBe(true);
 w.emit('echo-reply-saved',{chatId:'c1',message:reply('a9')});await tick();expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start').length).toBe(1);
 w.document.hidden=false;w.emitDocument('visibilitychange');expect(w.attr('data-speech-resume')!.hidden).toBe(false);
 await w.attr('data-speech-resume')!.click();
 await vi.waitFor(()=>expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start').length).toBe(2));expect(w.attr('data-speech-resume')!.hidden).toBe(true);
 w.dispose();
});
it('shows "Tap to hear Echo" when autoplay is blocked and never throws; tapping unlocks and replays',async()=>{
 const {w,bridge}=await voiceWorld();FakeAudio.block=true;
 w.emit('echo-reply-saved',{chatId:'c1',message:reply()});
 await vi.waitFor(()=>expect(w.attr('data-speech-tap')!.hidden).toBe(false));
 expect(w.speech.blocked).toBe(true);expect(w.attr('data-speech-status')!.textContent).toBe('Tap to hear Echo.');expect(w.debug.find(e=>e.event==='autoplay_blocked')).toBeTruthy();
 FakeAudio.block=false;await w.attr('data-speech-tap')!.click();
 await vi.waitFor(()=>expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start').length).toBe(2));
 await vi.waitFor(()=>expect(w.spoken().some(a=>!a.paused)).toBe(true));expect(w.attr('data-speech-tap')!.hidden).toBe(true);
 w.dispose();
});
it('counts spoken turns, resets them with the account and clears duplicate memory',async()=>{
 const {w,bridge}=await voiceWorld();
 const audio=await speaking(w);expect(w.speech.turns).toBe(1);expect(w.speech.snapshot().spoken).toEqual(['a1']);
 bridge.state.accountEpoch++;w.emit('echo-account-changed');
 expect(audio.paused).toBe(true);expect(w.speech.turns).toBe(0);expect(w.speech.snapshot().spoken).toEqual([]);expect(w.attr('data-speech-count')!.textContent).toBe('Spoken: 0');
 expect(bridge.api).not.toHaveBeenCalledWith('/voice/cancel',expect.anything());
});
it('drives the orb with echo-orb-state events: speaking with amplitude, then idle',async()=>{
 const {w,bridge}=await voiceWorld();
 bridge.api.mockImplementation(async(path:string)=>path==='/voice/start'?{audio_url:'/api/voice/audio/only',has_more:false,session_id:'s1',chunk_index:0}:{stopped:true});
 const audio=await speaking(w);await vi.waitFor(()=>expect(w.orb.some(e=>e?.mode==='speaking')).toBe(true));
 const speakingEvent=w.orb.find(e=>e?.mode==='speaking');expect(speakingEvent.amplitude).toBeGreaterThan(0);expect(speakingEvent.amplitude).toBeLessThanOrEqual(1);expect(speakingEvent.source).toBe('speech');
 audio.end();await vi.waitFor(()=>expect(w.speech.speaking).toBe(false));
 expect(w.orb[w.orb.length-1]).toMatchObject({mode:'idle',source:'speech'});
});
it('reports a failed synthesis plainly and never substitutes another voice',async()=>{
 const bridge=fakeBridge();bridge.api=vi.fn(async(path:string)=>{if(path==='/voice/start')throw new Error('Personality Forge did not confirm the requested voice provider and format.');return {};});
 const w=await world(['speech.js'],bridge);
 w.emit('echo-reply-saved',{chatId:'c1',message:reply()});
 await vi.waitFor(()=>expect(w.attr('data-speech-status')!.textContent).toContain('Echo could not speak this reply: Personality Forge did not confirm'));
 expect(w.synth.speak).not.toHaveBeenCalled();expect(w.spoken()).toEqual([]);expect(bridge.state.speech).toBeNull();
 void w.speech.speakMessage(reply(),'c1',{force:true});await vi.waitFor(()=>expect(bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start').length).toBe(2));
 const [a,b]=bridge.api.mock.calls.filter((c:any[])=>c[0]==='/voice/start');expect(a[1].request_id).not.toBe(b[1].request_id);
});

// ---------- no silent fallback, device voice ----------
it('shows why Echo cannot speak when the backend voice is not configured and stays silent',async()=>{
 const {w,bridge}=await voiceWorld({state:{data:{voice:{configured:false}}}});
 expect(w.attr('data-speech-voice')!.textContent).toBe("Echo's voice unavailable · the Workspace backend reports no configured voice");expect(w.attr('data-speech-conversation')!.hidden).toBe(true);
 w.emit('echo-reply-saved',{chatId:'c1',message:reply()});await tick();
 expect(bridge.api).not.toHaveBeenCalled();expect(w.synth.speak).not.toHaveBeenCalled();expect(w.spoken()).toEqual([]);
 expect(w.attr('data-speech-status')!.textContent).toContain("Echo's voice is unavailable: the Workspace backend reports no configured voice. Device voice (not Echo's) is off.");
 bridge.state.data.voice={configured:false,reason:'ElevenLabs quota exhausted'};w.emit('echo-workspace-context');
 expect(w.attr('data-speech-voice')!.textContent).toBe("Echo's voice unavailable · ElevenLabs quota exhausted");
});
it('speaks ECHO Code replies only through the explicitly labelled device voice, with normalised text and language passthrough',async()=>{
 const {w,bridge}=await voiceWorld();
 const article=new Node('article');w.emit('echo-code-reply',{text:'See https://x.y/z for 3 items.',article,status:'completed',sessionId:'s'});await tick();
 expect(w.synth.speak).not.toHaveBeenCalled();expect(bridge.api).not.toHaveBeenCalled();
 expect(w.attr('data-speech-status')!.textContent).toContain("Turn on \"Device voice (not Echo's)\" to hear this ECHO Code reply.");
 expect(walk(article).find(n=>n.tagName==='BUTTON')!.textContent).toBe('🔊 Speak');
 const toggle=w.attr('data-speech-device')!;expect(toggle.parent!.textContent).toContain("Device voice (not Echo's)");toggle.checked=true;await toggle.fire('change');
 w.emit('echo-code-reply',{text:'See https://x.y/z for 3 items.',article:new Node('article'),status:'completed',sessionId:'s'});
 await vi.waitFor(()=>expect(w.synth.speak).toHaveBeenCalledTimes(1));
 expect(w.utterances[0].text).toBe('See link for three items.');expect(w.utterances[0].lang).toBe('en');expect(w.utterances[0].voice.name).toBe('Device English');
 await vi.waitFor(()=>expect(w.speech.speaking).toBe(false));expect(w.debug.find(e=>e.event==='first_audio'&&e.source==='device')).toBeTruthy();expect(JSON.parse(w.storage.get('echo-prime-speech-v1')!)).toMatchObject({device:true});
 void w.speech.speakText('こんにちは。元気ですか？今日はいい天気ですね。',{source:'code'});
 await vi.waitFor(()=>expect(w.utterances.length).toBeGreaterThanOrEqual(2));expect(w.utterances[1].lang).toBe('ja');expect(w.utterances[1].voice.name).toBe('Device Japanese');
 w.dispose();
});
it('adds "Speak result" to Swarm answers and "Speak advice" beside Steward output, acting as speak/stop toggles',async()=>{
 const {w}=await voiceWorld();
 const article=new Node('article');w.emit('echo-result-rendered',{source:'swarm',text:'The swarm agrees.',article});
 const speak=walk(article).find(n=>n.tagName==='BUTTON')!;expect(speak.textContent).toBe('🔊 Speak result');expect(speak.parent!.className).toContain('speech-actions');
 await speak.click();expect(w.synth.speak).not.toHaveBeenCalled();expect(w.attr('data-speech-status')!.textContent).toContain('Swarm result');
 const pre=new Node('pre');const host=new Node('div');host.append(pre);w.emit('echo-result-rendered',{source:'steward',text:'Restart the unit.',container:pre});
 const advice=walk(host).find(n=>n.tagName==='BUTTON')!;expect(advice.textContent).toBe('🔊 Speak advice');
 w.attr('data-speech-device')!.checked=true;await w.attr('data-speech-device')!.fire('change');
 w.synth.speak=vi.fn((u:any)=>{w.utterances.push(u);setTimeout(()=>u.onstart?.(),0);});
 await speak.click();await vi.waitFor(()=>expect(w.speech.speaking).toBe(true));expect(speak.textContent).toBe('⏹ Stop');
 await speak.click();expect(w.speech.speaking).toBe(false);expect(w.synth.cancel).toHaveBeenCalled();expect(speak.textContent).toBe('🔊 Speak result');
});
it('speaks the first streamed sentence while the rest streams when only the device voice can speak',async()=>{
 const {w}=await voiceWorld({state:{data:{voice:{configured:false}}}});
 w.attr('data-speech-device')!.checked=true;await w.attr('data-speech-device')!.fire('change');
 w.emit('echo-reply-stream',{chatId:'c1',text:'First sentence of the streamed reply is here'});expect(w.synth.speak).not.toHaveBeenCalled();
 w.emit('echo-reply-stream',{chatId:'c1',text:' indeed. Second part'});
 await vi.waitFor(()=>expect(w.synth.speak).toHaveBeenCalledTimes(1));expect(w.utterances[0].text).toBe('First sentence of the streamed reply is here indeed.');
 expect(w.debug.find(e=>e.event==='sentence_ready')).toMatchObject({count:1});
 w.emit('echo-reply-saved',{chatId:'c1',message:reply('a1','First sentence of the streamed reply is here indeed. Second part')});await tick();
 expect(w.synth.speak).toHaveBeenCalledTimes(1);expect(w.debug.find(e=>e.event==='stream_closed')).toBeTruthy();
 w.dispose();
});

// ---------- conversation mode (continuous, VAD) ----------
it('detects start and end of speech from RMS samples with a raised threshold while Echo speaks',async()=>{
 const s=await pure(),vad=s.createVad({endOfTurnMs:1000,startMs:150,bargeStartMs:300});
 expect(vad.update(0.1,50)).toBeNull();expect(vad.update(0.1,50)).toBeNull();expect(vad.update(0.1,50)).toBe('start');expect(vad.speaking).toBe(true);
 for(let i=0;i<19;i++)expect(vad.update(0,50)).toBeNull();expect(vad.update(0,50)).toBe('end');expect(vad.speaking).toBe(false);
 for(let i=0;i<5;i++)expect(vad.update(0.1,50,true)).toBeNull();expect(vad.update(0.1,50,true)).toBe('start');
 const quiet=s.createVad({noise:0.001});for(let i=0;i<50;i++)quiet.update(0.0005,50);expect(quiet.threshold(false)).toBe(0.012);
});
it('encodes the canonical mono 16 kHz WAV clip and resamples microphone audio',async()=>{
 const s=await pure();
 const samples=s.resample([new Float32Array(48000).fill(0.5)],48000);expect(samples.length).toBe(16000);expect(samples[100]).toBeCloseTo(0.5,5);
 const wav=Buffer.from(s.encodeWav(samples),'base64');expect(wav.subarray(0,4).toString()).toBe('RIFF');expect(wav.readUInt32LE(24)).toBe(16000);expect(wav.readUInt16LE(22)).toBe(1);expect(wav.length).toBe(44+16000*2);
 expect(()=>s.encodeWav(new Float32Array(0))).toThrow();expect(()=>s.encodeWav(new Float32Array(128001))).toThrow();
});
it('runs conversation mode off by default, opens the microphone on request and auto-sends after end of speech',async()=>{
 const rms={value:0};const {w,bridge}=await voiceWorld({},{rms});
 const button=w.attr('data-speech-conversation')!;expect(button.hidden).toBe(false);expect(button.textContent).toBe('◉ Conversation mode');expect(w.speech.conversation.active()).toBe(false);
 await button.click();
 expect(w.media.getUserMedia).toHaveBeenCalledWith({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
 expect(w.speech.conversation.active()).toBe(true);expect(button.textContent).toBe('◉ Conversation mode on');expect(button.attributes['aria-pressed']).toBe('true');
 expect(w.orb[w.orb.length-1]).toMatchObject({mode:'listening',source:'speech'});
 rms.value=0.1;expect([w.speech.conversation.pump(100),w.speech.conversation.pump(100)]).toContain('start');
 for(let i=0;i<4;i++)w.media.processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(0.1)}});
 rms.value=0;w.speech.conversation.pump(800);expect(w.speech.conversation.pump(800)).toBe('end');
 await vi.waitFor(()=>expect(bridge.api).toHaveBeenCalledWith('/voice/transcribe',expect.objectContaining({chat_id:'c1'})));
 const clip=bridge.api.mock.calls.find((c:any[])=>c[0]==='/voice/transcribe')![1];expect(clip.request_id).toMatch(/^[0-9a-f-]{36}$/);expect(Buffer.from(clip.audio_b64,'base64').subarray(0,4).toString()).toBe('RIFF');
 await vi.waitFor(()=>expect(w.window.EchoPrimeWorkspace.send).toHaveBeenCalledWith('hello echo'));
 expect(JSON.stringify(w.debug)).not.toContain('hello echo');
 await button.click();expect(w.speech.conversation.active()).toBe(false);expect(w.media.tracks[0].stop).toHaveBeenCalled();expect(w.orb[w.orb.length-1]).toMatchObject({mode:'idle'});
});
it('lets the user barge in on Echo by speaking during playback in conversation mode',async()=>{
 const rms={value:0};const {w,bridge}=await voiceWorld({},{rms});
 await w.attr('data-speech-conversation')!.click();expect(w.speech.conversation.active()).toBe(true);
 const audio=await speaking(w);
 rms.value=0.1;const verdicts=[w.speech.conversation.pump(100),w.speech.conversation.pump(100),w.speech.conversation.pump(100),w.speech.conversation.pump(100)];
 expect(verdicts).toContain('start');expect(audio.paused).toBe(true);await vi.waitFor(()=>expect(bridge.api).toHaveBeenCalledWith('/voice/cancel',{chat_id:'c1',session_id:'s1'}));
 expect(w.debug.find(e=>e.event==='stopped')).toMatchObject({reason:'barge-in'});expect(w.debug.find(e=>e.event==='utterance_started')).toMatchObject({barge_in:true});
 w.dispose();
});
it('refuses conversation mode without the backend voice, a signed-in account or while the legacy microphone is active',async()=>{
 const off=await voiceWorld({state:{data:{voice:{configured:false}}}});expect(await off.w.speech.conversation.start()).toBe(false);expect(off.w.media.getUserMedia).not.toHaveBeenCalled();
 const busy=await voiceWorld({state:{capture:{finish(){}}}});expect(await busy.w.speech.conversation.start()).toBe(false);expect(busy.w.attr('data-speech-status')!.textContent).toContain('Stop the active microphone');
 const anon=await voiceWorld({bridge:{session:{authenticated:false,user:null}}});expect(await anon.w.speech.conversation.start()).toBe(false);
});

// ---------- integration with the shipped modules ----------
it('workspace.js announces streamed and saved replies, exposes bridge.audio and defers spoken replies to speech.js',async()=>{
 const nodes=new Map<string,Node>(),events:Record<string,((e:any)=>unknown)[]>={},seen:any[]=[];
 const get=(s:string)=>{if(!nodes.has(s))nodes.set(s,new Node());return nodes.get(s)!;};
 const session={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
 const saved={id:'c1',messages:[{id:'u1',role:'user',content:'hi'},{id:'reply',role:'assistant',content:'Hello. Saved reply.'}]};
 const request=vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],preferences:[],personalities:[],context_length:1000,voice:voiceFixture()}:path==='/chats'?{id:'c1',messages:[]}:path==='/chats/c1'?saved:{});
 const audio=vi.fn(async()=>new Blob(['wav']));
 class Transport {session=session;constructor(){}loadSession=async()=>this.session;request=request;chat=vi.fn(async(_input:any,onEvent:(e:any)=>void)=>{onEvent({type:'token',text:'Hello. '});onEvent({type:'token',text:'Saved reply.'});return saved;});text=vi.fn();audio=audio;headers=()=>({});clear(){}auth=vi.fn();}
 const window:any={addEventListener:(n:string,f:(e:any)=>unknown)=>(events[n]??=[]).push(f),dispatchEvent:(e:any)=>{seen.push(e);for(const f of events[e.type]||[])f(e);},EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()},EchoPrimeSpeech:{handlesReplies:true}};
 const document:any={hidden:false,head:new Node(),querySelector:get,querySelectorAll:()=>[],createElement:(t:string)=>new Node(t),createTextNode:(t:string)=>Object.assign(new Node('#text'),{_text:t}),addEventListener(){}};
 get('#workspace-chat-kind').value='workspace';
 runInNewContext(source('workspace.js'),{window,document,navigator:{},crypto:{randomUUID},setTimeout,clearTimeout,AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,console:{debug:vi.fn()}});
 await window.EchoPrimeWorkspace.ready;const bridge=window.EchoPrimeWorkspace.bridge;
 expect(bridge.voiceOptions.spoken).toBe(false);// speech.js applies the signed-in default; workspace.js keeps false
 await bridge.audio('/voice/audio/x');expect(audio).toHaveBeenCalledWith('/voice/audio/x',expect.anything());
 bridge.stopAudio();expect(seen.some(e=>e.type==='echo-voice-stop')).toBe(true);
 await window.EchoPrimeWorkspace.newChat();bridge.voiceOptions.spoken=true;
 const outcome=await window.EchoPrimeWorkspace.send('hi');expect(outcome).toMatchObject({handled:true,sent:true,verified:true});
 expect(seen.filter(e=>e.type==='echo-reply-stream').map(e=>e.detail.text)).toEqual(['Hello. ','Saved reply.']);
 const savedEvent=seen.find(e=>e.type==='echo-reply-saved');expect(savedEvent.detail).toEqual({chatId:'c1',message:saved.messages[1]});
 expect(request).not.toHaveBeenCalledWith('/voice/start',expect.anything(),expect.anything());
 expect(bridge.voiceOptions.remaining).toBe(0);
});
it('composer Listen and ◉ Voice route through speech.js when it is loaded',async()=>{
 const bridge=fakeBridge();bridge.state.chat.messages=[{id:'a1',role:'assistant',content:'ok'}];
 const w=await world(['composer.js','speech.js'],bridge);
 const article=new Node('article');article.className='chat-message assistant';const p=new Node('p');p._text='ok';article.append(new Node('strong'),p);w.get('#chat-log').append(article);w.emit('echo-workspace-context');
 await walk(article).find(n=>n.tagName==='BUTTON'&&n.textContent==='▶ Listen')!.click();
 await vi.waitFor(()=>expect(bridge.api).toHaveBeenCalledWith('/voice/start',expect.objectContaining({message_id:'a1'})));expect(bridge.speakReply).not.toHaveBeenCalled();
 const voice=w.button('◉ Voice')!;await voice.click();
 expect(bridge.startConversation).not.toHaveBeenCalled();expect(w.speech.conversation.active()).toBe(true);
 w.emit('echo-speech-changed');expect(voice.textContent).toBe('◉ Voice on');expect(voice.attributes['aria-pressed']).toBe('true');
 await voice.click();expect(w.speech.conversation.active()).toBe(false);
 w.dispose();
});
it('keeps the module free of hardcoded voice names and guards every storage access',async()=>{
 const text=source('speech.js');
 expect(text).not.toMatch(/Freeman/);
 const storageLines=text.split('\n').filter(line=>/localStorage/.test(line));expect(storageLines.length).toBeGreaterThan(0);for(const line of storageLines)expect(line).toMatch(/try\{/);
 expect(text).not.toMatch(/data:audio/);// CSP media-src allows blob:, never data:
 expect(text).not.toMatch(/session\.csrf|x-echo-csrf/);
 const html=source('index.html');expect(html).toContain('speech.js');expect(html).toContain('speech.css');
});
it('serves speech.js and speech.css from the Prime asset allowlist',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prime-speech-'));
 for(const name of ['index.html','speech.js','speech.css'])writeFileSync(join(dir,name),'/* '+name+' */');
 const s=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0);
 try{
  const page=await fetch(s.url),cookie=page.headers.get('set-cookie')!.split(';')[0];
  for(const name of ['speech.js','speech.css']){const r=await fetch(s.url+'/'+name,{headers:{cookie}});expect(r.status).toBe(200);expect(await r.text()).toContain(name);}
  expect((await fetch(s.url+'/speech-private.js',{headers:{cookie}})).status).toBe(404);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});
