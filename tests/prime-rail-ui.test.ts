/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM and Workspace bridge stand-ins */
import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {Node,world,storage,source,tick,walk} from './fixtures/prime-fake-dom.js';

// The Echo controls rail (rail.js, rail.css): the voice, context, mode, model and personality controls
// live in one right-hand column. These tests parse the shipped index.html into the DOM stand-in, run the
// shipped controllers against it and assert where every control lands, that nothing is duplicated, and
// how the rail behaves (collapse memory, docked toggle, slide-over drawer, switches, meter, contrast).
const index=source('index.html'),railCss=source('rail.css'),KEY='echo-prime-rail-v1';
const CARDS=['mode','model','personality','voice','context'];

// ---------- a small HTML reader so the tests run against the real markup ----------
const VOID=new Set(['meta','link','input','br','img','hr','source']);
const ENT:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&nbsp;':' '};
const decode=(s:string)=>s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g,m=>ENT[m]);
function parseFragment(html:string):Node[]{
 const root=new Node('div'),stack:Node[]=[root];
 const token=/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
 let m:RegExpExecArray|null;
 while((m=token.exec(html))){
  if(m[0].startsWith('<!--'))continue;
  if(m[5]!==undefined){const text=decode(m[5]);if(text.trim())stack[stack.length-1]._text+=text.replace(/\s+/g,' ');continue;}
  const [,closing,rawTag,attrs,selfClose]=m,tag=rawTag.toLowerCase();
  if(closing){while(stack.length>1&&stack[stack.length-1].tagName.toLowerCase()!==tag)stack.pop();if(stack.length>1)stack.pop();continue;}
  const node=new Node(tag);
  for(const a of attrs.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)){
   const key=a[1],value=decode(a[2]??a[3]??a[4]??'');
   if(key==='class')node.className=value;
   else if(key==='hidden'){node.hidden=true;node.attributes.hidden='';}
   else node.attributes[key]=value;
   if(key.startsWith('data-'))node.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
  }
  stack[stack.length-1].append(node);
  if(!selfClose&&!VOID.has(tag))stack.push(node);
 }
 return root.children;
}
const bodyOf=(html:string)=>/<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g,'');
const shell=(html:string)=>(body:Node,register:(selector:string,node:Node)=>void)=>{
 body.append(...parseFragment(bodyOf(html)));
 for(const node of walk(body))if(node.attributes.id)register('#'+node.attributes.id,node);
};
const idOf=(n:Node)=>n.attributes.id??(n as any).id;
const insideId=(node:Node,id:string)=>{for(let n:Node|null=node;n;n=n.parent)if(idOf(n)===id)return true;return false;};

// ---------- Workspace stand-in ----------
const VOICE={configured:true,persona:'forge-voice',label:'M Freeman',provider:'elevenlabs',provider_usage:'Cloud speech uses your ElevenLabs account.'};
function fakeBridge(over:{voice?:any;signedIn?:boolean;contextLength?:number|undefined}={}){
 const state:any={data:{context_length:'contextLength' in over?over.contextLength:262144,base_context_chars:22996,library:[],projects:[],personalities:[],voice:over.voice??VOICE},chat:{id:'c1',title:'T',project_id:null,messages:[],events:[]},attachments:new Set<string>(),speech:null,capture:null,micPending:false,accountEpoch:0,epoch:0,voiceBar:false};
 const voiceOptions:any={spoken:false,brief:false,autoSend:false,conversation:false,remaining:0,limitReached:false};
 const hooks:Array<(text:string)=>void>=[];
 return {state,voiceOptions,hooks,session:{authenticated:over.signedIn!==false,ownerAccess:true,user:{uid:'owner',status:'approved'}},
  api:vi.fn(async()=>({})),refresh:vi.fn(async()=>{}),updateContext:vi.fn(),stopAudio:vi.fn(),endConversation:vi.fn(),startConversation:vi.fn(async()=>{}),stopVoice:vi.fn(async()=>{}),interrupt:vi.fn(async()=>{}),
  dictate:vi.fn(async()=>{}),speakReply:vi.fn(async()=>true),setChat:vi.fn(),onStatus:vi.fn((fn:(t:string)=>void)=>{hooks.push(fn);})} as any;
}
const json=(data:unknown)=>({ok:true,status:200,json:async()=>data});
const fakeFetch=vi.fn(async(url:string)=>{
 if(url==='/api/prime/models')return json({routing:true,default:'qwen',auto:{enabled:false},providers:[{id:'qwen',label:'Qwen (FORGE, 256K)',available:true},{id:'argon',label:'Argon (Gemini 4, agy CLI)',available:true,variants:[{id:'g1',label:'Gemini one'}]}]});
 if(url==='/api/prime/personality')return json({configured:true,settings:{enabled:true,pinned:null},catalog:{entries:[{id:'forge',name:'Forge',registered:true}]}});
 return json({});
});
const ALL=['rail.js','models.js','brain.js','composer.js','voicebar.js','speech.js'];
async function railWorld(opts:{width?:number;storage?:ReturnType<typeof storage>;files?:string[];bridge?:any}={}){
 const bridge=opts.bridge??fakeBridge();
 const ws:any={ready:Promise.resolve(true),enabled:true,bridge,session:bridge.session,ownerHeaders:async()=>({}),generalMode:true,invalidate(){}};
 const w=world([],{strict:true,width:opts.width??1200,height:900,storage:opts.storage,body:shell(index),window:{EchoPrimeWorkspace:ws},globals:{fetch:fakeFetch,CustomEvent}});
 w.document.documentElement=new Node('html');
 for(const file of opts.files??ALL)w.run(file);
 for(let i=0;i<6;i++)await tick();
 w.window.EchoPrimeRail?.refresh();// the DOM stand-in has no MutationObserver, which rail.js uses in a browser to notice late-built controls
 return {...w,bridge,ws,root:w.document.documentElement as Node,rail:w.window.EchoPrimeRail};
}
const count=(w:{all:()=>Node[]},predicate:(n:Node)=>boolean)=>w.all().filter(predicate).length;
const byAttr=(name:string,value?:string)=>(n:Node)=>name in n.attributes&&(value===undefined||n.attributes[name]===value);

// ---------- served markup ----------
it('serves one Echo controls landmark with the five cards in the Mode, Model, Personality, Voice, Context order',()=>{
 expect(index.match(/<aside\b[^>]*\bid="echo-rail"/g)).toHaveLength(1);
 expect(index).toMatch(/<aside\b[^>]*\bid="echo-rail"[^>]*\baria-label="Echo controls"|<aside\b[^>]*\baria-label="Echo controls"[^>]*\bid="echo-rail"/);
 const order=[...index.matchAll(/<section\b[^>]*\bclass="rail-card"[^>]*\bdata-card="([a-z]+)"/g)].map(m=>m[1]);
 expect(order).toEqual(CARDS);
 for(const card of CARDS){
  expect(index).toMatch(new RegExp(`<button\\b[^>]*\\bid="rail-card-btn-${card}"[^>]*\\baria-expanded="true"[^>]*\\baria-controls="rail-body-${card}"|<button\\b[^>]*\\bid="rail-card-btn-${card}"[^>]*\\baria-controls="rail-body-${card}"[^>]*\\baria-expanded="true"`));
  expect(index.match(new RegExp(`\\bid="rail-body-${card}"`,'g'))).toHaveLength(1);
  expect(index.match(new RegExp(`\\bid="rail-${card}-slot"`,'g'))).toHaveLength(1);
 }
});
it('keeps the static mode chips and Connect Echo systems once, inside the Mode card, and drops the old composer toolbar',async()=>{
 const w=await railWorld({files:['rail.js']});
 const tabs=w.all().filter(n=>/\bmode-tabs\b/.test(n.className));
 expect(tabs).toHaveLength(1);expect(insideId(tabs[0],'rail-mode-slot')).toBe(true);expect(tabs[0].attributes.role).toBe('tablist');
 expect(tabs[0].children.map(c=>c.attributes['data-mode'])).toEqual(['Chat','Image','Video','Music','Sound FX','Voice']);
 const connect=w.buttons('Connect Echo systems');expect(connect).toHaveLength(1);expect(connect[0].attributes['data-open']).toBe('systems');expect(insideId(connect[0],'rail-mode-slot')).toBe(true);
 expect(count(w,n=>/\bcomposer-toolbar\b/.test(n.className))).toBe(0);
 expect(insideId(w.find('#composer')!,'echo-rail')).toBe(false);
});
it('adds an accessible rail toggle and backdrop, with no inline script or style in the markup (CSP)',()=>{
 expect(index).toMatch(/<button\b[^>]*\bid="rail-toggle"[^>]*\baria-controls="echo-rail"/);
 expect(index).toMatch(/<button\b[^>]*\bid="rail-toggle"[^>]*\baria-expanded="(?:true|false)"/);
 expect(index).toMatch(/<button\b[^>]*\bid="rail-toggle"[^>]*\baria-label="[^"]+"/);
 expect(index).toMatch(/<button\b[^>]*\bid="rail-scrim"[^>]*\baria-label="Close Echo controls"/);
 const rail=/<aside\b[^>]*\bid="echo-rail"[\s\S]*?<\/aside>/.exec(index)![0];
 expect(rail).not.toMatch(/\sstyle\s*=/);expect(rail).not.toMatch(/\son[a-z]+\s*=/i);expect(rail).not.toMatch(/<script/i);
 expect(index.match(/<script(?![^>]*\bsrc=)[^>]*>/g)||[]).toHaveLength(0);
});
it('links rail.css and a classic head script, and the Prime asset table serves both',()=>{
 expect(index).toMatch(/<link rel="stylesheet" href="rail\.css">/);
 const head=/<head>([\s\S]*?)<\/head>/.exec(index)![1];
 expect(head).toMatch(/<script src="rail\.js"><\/script>/);
 const server=readFileSync(new URL('../src/prime/server.ts',import.meta.url),'utf8');
 expect(server).toContain("'/rail.js':'rail.js'");expect(server).toContain("'/rail.css':'rail.css'");
 expect(railCss).not.toMatch(/@import|url\(\s*['"]?https?:/i);
});

// ---------- every moved control lands once, in its card ----------
it('mounts each dynamic control exactly once into its card slot and nowhere else',async()=>{
 const w=await railWorld();
 const where:Array<[string,(n:Node)=>boolean,string]>=[
  ['model select',n=>idOf(n)==='model-select','rail-model-slot'],
  ['gemini select',n=>idOf(n)==='argon-model-select','rail-model-slot'],
  ['personality select',n=>idOf(n)==='personality-select','rail-personality-slot'],
  ['personality toggle',n=>idOf(n)==='personality-toggle','rail-personality-slot'],
  ['voice pill',byAttr('data-speech-voice'),'rail-voice-slot'],
  ['mute',byAttr('data-speech-mute'),'rail-voice-slot'],
  ['conversation mode',byAttr('data-speech-conversation'),'rail-voice-slot'],
  ['device voice',byAttr('data-speech-device'),'rail-voice-slot'],
  ['spoken counter',byAttr('data-speech-count'),'rail-voice-slot'],
  ['speech status',byAttr('data-speech-status'),'rail-voice-slot'],
  ['spoken replies',byAttr('data-voice-option','spoken'),'rail-voice-slot'],
  ['brief speech',byAttr('data-voice-option','brief'),'rail-voice-slot'],
  ['send speech automatically',byAttr('data-voice-option','autoSend'),'rail-voice-slot'],
  ['voice status line',byAttr('data-voice-line'),'rail-voice-slot'],
  ['context label',byAttr('data-context-label'),'rail-context-slot'],
  ['context meter',n=>/\bcontext-meter\b/.test(n.className),'rail-context-slot'],
 ];
 for(const [name,predicate,slot] of where){
  const found=w.all().filter(predicate);
  expect(found.length,name).toBe(1);
  expect(insideId(found[0],slot),name+' in '+slot).toBe(true);
  expect(insideId(found[0],'echo-rail'),name+' in the rail').toBe(true);
 }
 for(const label of ['Interrupt & speak','Stop voice']){const found=w.buttons(label);expect(found,label).toHaveLength(1);expect(insideId(found[0],'rail-voice-slot')).toBe(true);}
 expect(count(w,byAttr('data-voice-bar'))).toBe(1);expect(count(w,byAttr('data-speech-dock'))).toBe(1);
 // The Workspace conversation strip keeps its own Personality select; it is a different control and stays put.
 expect(count(w,n=>idOf(n)==='workspace-personality')).toBe(1);
 expect(insideId(w.find('#workspace-personality')!,'echo-rail')).toBe(false);
});
it('keeps the visible values the Commander named: voice line, helper lines, meter text, footer',async()=>{
 const w=await railWorld();
 const text=(pred:(n:Node)=>boolean)=>w.all().find(pred)!.textContent;
 expect(text(byAttr('data-speech-voice'))).toBe("Echo's voice · M Freeman · ElevenLabs");
 expect(text(byAttr('data-speech-count'))).toBe('Spoken: 0');
 expect(text(byAttr('data-voice-line'))).toBe('M Freeman · ElevenLabs · Microphone off');
 expect(w.all().some(n=>n.textContent==='Personality Forge · Cloud speech uses your ElevenLabs account.')).toBe(true);
 expect(text(byAttr('data-context-label'))).toBe('5,749 / 262,144 · 2.2% · estimate');
 const model=w.all().find(n=>idOf(n)==='model-select')!;expect(model.children.map(c=>c.textContent)).toContain('Qwen (FORGE, 256K)');
 const notes=w.all().filter(n=>/\bconnection-note\b/.test(n.className)).map(n=>n.textContent);
 expect(notes).toContain('Echo conversation: Qwen (FORGE, 256K) answers through your private Workspace, with its memory and tools; each reply names the model.');
 expect(notes).toContain('Echo picks a personality per message from topic, tone and intent; the reply says which one answered.');
 const pers=w.all().find(n=>idOf(n)==='personality-select')!;expect(pers.children[0].textContent).toBe('Personality: auto (by task)');
 expect(text(n=>idOf(n)==='personality-toggle')).toBe('Personality: on');
});
it('hides the Gemini caption together with its select when Gemini is not the chosen model',async()=>{
 const w=await railWorld();
 const caption=w.all().find(n=>n.tagName==='LABEL'&&n.textContent.startsWith('Gemini model'))!;
 expect(caption).toBeTruthy();expect(w.all().find(n=>idOf(n)==='argon-model-select')!.hidden).toBe(true);expect(caption.hidden).toBe(true);
});
it('shows a card only while it has something to show',async()=>{
 const out=await railWorld({bridge:fakeBridge({signedIn:false,voice:{configured:false},contextLength:undefined})});
 const card=(w:any,id:string)=>w.find('#rail-card-'+id)!;
 expect(card(out,'voice').hidden).toBe(true);expect(card(out,'context').hidden).toBe(true);
 expect(card(out,'mode').hidden).toBe(false);expect(card(out,'model').hidden).toBe(false);
 const on=await railWorld();
 expect(card(on,'voice').hidden).toBe(false);expect(card(on,'context').hidden).toBe(false);
 // Voice turning off later hides the card on the next refresh.
 on.bridge.session.authenticated=false;on.bridge.state.data.voice={configured:false};on.emit('echo-account-changed');await tick();await tick();
 expect(card(on,'voice').hidden).toBe(true);
});

// ---------- collapse memory ----------
it('collapses and expands a card, remembers it, and still works when localStorage throws',async()=>{
 const broken=await railWorld({storage:storage({},{throws:true})});
 const header=broken.find('#rail-card-btn-model')!,card=broken.find('#rail-card-model')!;
 expect(header.attributes['aria-expanded']).toBe('true');expect(card.attributes['data-collapsed']).toBeUndefined();
 await header.click();
 expect(header.attributes['aria-expanded']).toBe('false');expect(card.attributes['data-collapsed']).toBe('true');
 expect(broken.rail.state().collapsed.model).toBe(true);
 await header.click();expect(header.attributes['aria-expanded']).toBe('true');expect(card.attributes['data-collapsed']).toBeUndefined();

 const store=storage();
 const first=await railWorld({storage:store});
 await first.find('#rail-card-btn-voice')!.click();await first.find('#rail-card-btn-mode')!.click();
 const saved=JSON.parse(store.map.get(KEY)!);
 expect(saved).toMatchObject({v:1,hidden:false,collapsed:{voice:true,mode:true}});
 const second=await railWorld({storage:store});
 expect(second.find('#rail-card-btn-voice')!.attributes['aria-expanded']).toBe('false');
 expect(second.find('#rail-card-voice')!.attributes['data-collapsed']).toBe('true');
 expect(second.find('#rail-card-btn-model')!.attributes['aria-expanded']).toBe('true');
 // Collapsed bodies leave the tab order.
 expect(second.find('#rail-body-voice')!.inert).toBe(true);expect(second.find('#rail-body-model')!.inert).toBe(false);
});
it('ignores damaged or foreign saved state',()=>{
 const R=world(['rail.js'],{strict:true,body:shell(index),window:{}}).window.EchoPrimeRail;
 const clean={v:1,hidden:false,collapsed:{}};
 for(const bad of [[],7,'x',null,undefined,{v:2,hidden:true},{v:1,hidden:'yes',collapsed:7},{hidden:true}])expect(R.normalize(bad),JSON.stringify(bad)).toEqual(clean);
 expect(R.normalize({v:1,hidden:true,collapsed:{model:true,evil:true,voice:'no'}})).toEqual({v:1,hidden:true,collapsed:{model:true}});
 expect(R.readState(storage({[KEY]:'{not json'}))).toEqual(clean);expect(R.readState(storage({},{throws:true}))).toEqual(clean);expect(R.readState(null)).toEqual(clean);
 expect(R.writeState(storage({},{throws:true}),clean)).toBe(false);expect(R.writeState(null,clean)).toBe(false);
 const out=storage();expect(R.writeState(out,{v:1,hidden:true,collapsed:{mode:true}})).toBe(true);expect(JSON.parse(out.map.get(KEY)!)).toEqual({v:1,hidden:true,collapsed:{mode:true}});
 expect(R.KEY).toBe(KEY);
});

// ---------- docked rail (>= 1100px) ----------
it('wide: the header button hides and shows the rail, mirrors aria-expanded and remembers the choice',async()=>{
 const store=storage();
 const w=await railWorld({storage:store,width:1440});
 const toggle=w.find('#rail-toggle')!,rail=w.find('#echo-rail')!;
 expect(toggle.attributes['aria-expanded']).toBe('true');expect(w.root.classList.contains('rail-hidden')).toBe(false);expect(w.root.classList.contains('rail-open')).toBe(false);
 await toggle.click();
 expect(w.root.classList.contains('rail-hidden')).toBe(true);expect(toggle.attributes['aria-expanded']).toBe('false');expect(JSON.parse(store.map.get(KEY)!).hidden).toBe(true);
 await toggle.click();
 expect(w.root.classList.contains('rail-hidden')).toBe(false);expect(toggle.attributes['aria-expanded']).toBe('true');expect(JSON.parse(store.map.get(KEY)!).hidden).toBe(false);
 expect(rail.attributes['aria-label']).toBe('Echo controls');
 // A remembered hide is applied as soon as the script runs, before the body is parsed (no layout shift).
 store.map.set(KEY,JSON.stringify({v:1,hidden:true,collapsed:{}}));
 const early=world([],{strict:true,width:1440,storage:store});early.document.documentElement=new Node('html');early.run('rail.js');
 expect(early.document.documentElement.classList.contains('rail-hidden')).toBe(true);
 const shown=await railWorld({storage:store,width:1440});
 expect(shown.root.classList.contains('rail-hidden')).toBe(true);expect(shown.find('#rail-toggle')!.attributes['aria-expanded']).toBe('false');
});

// ---------- slide-over drawer (< 1100px) ----------
it('narrow: the button opens a drawer with aria-expanded, a backdrop, focus inside, Escape and backdrop to close, focus back on the button',async()=>{
 const w=await railWorld({width:800});
 const toggle=w.find('#rail-toggle')!,close=w.find('#rail-close')!,scrim=w.find('#rail-scrim')!,main=w.find('main')!,nav=w.find('#sidebar')!;
 const toggleFocus=toggle.focus=vi.fn(),closeFocus=close.focus=vi.fn();
 expect(toggle.attributes['aria-expanded']).toBe('false');expect(w.root.classList.contains('rail-open')).toBe(false);
 await toggle.click();
 expect(w.root.classList.contains('rail-open')).toBe(true);expect(toggle.attributes['aria-expanded']).toBe('true');expect(scrim.classList.contains('visible')).toBe(true);
 expect(closeFocus).toHaveBeenCalled();expect(main.inert).toBe(true);expect(nav.inert).toBe(true);
 w.emit('keydown',{key:'Escape'});
 expect(w.root.classList.contains('rail-open')).toBe(false);expect(toggle.attributes['aria-expanded']).toBe('false');expect(scrim.classList.contains('visible')).toBe(false);
 expect(toggleFocus).toHaveBeenCalled();expect(main.inert).toBe(false);expect(nav.inert).toBe(false);
 toggleFocus.mockClear();
 await toggle.click();expect(w.root.classList.contains('rail-open')).toBe(true);
 await scrim.click();expect(w.root.classList.contains('rail-open')).toBe(false);expect(toggleFocus).toHaveBeenCalled();
 await toggle.click();await close.click();expect(w.root.classList.contains('rail-open')).toBe(false);
 w.emit('keydown',{key:'Escape'});expect(w.root.classList.contains('rail-open')).toBe(false);// Escape with the drawer shut does nothing
 // The drawer never persists: it is not the remembered docked state.
 expect(JSON.parse(w.storage.map.get(KEY)||'{"hidden":false}').hidden).toBe(false);
});
it('narrow: opening the drawer closes the navigation drawer first; crossing 1100px closes the drawer',async()=>{
 const w=await railWorld({width:700});
 const navScrim=w.find('#scrim')!,nav=w.find('#sidebar')!;
 nav.inert=true;// app.js keeps a closed phone navigation inert; the rail must hand that back untouched
 navScrim.classList.add('visible');const clicked=vi.fn();navScrim.click=async()=>{clicked();navScrim.classList.remove('visible');};
 await w.find('#rail-toggle')!.click();expect(clicked).toHaveBeenCalledTimes(1);expect(w.root.classList.contains('rail-open')).toBe(true);
 expect(nav.inert).toBe(true);expect(w.find('main')!.inert).toBe(true);
 w.window.innerWidth=1300;w.emit('resize');
 expect(w.root.classList.contains('rail-open')).toBe(false);expect(w.find('#rail-toggle')!.attributes['aria-expanded']).toBe('true');
 expect(w.find('main')!.inert).toBe(false);expect(nav.inert).toBe(true);
 w.window.innerWidth=600;w.emit('resize');expect(w.find('#rail-toggle')!.attributes['aria-expanded']).toBe('false');
});

// ---------- switches, status pill, meter ----------
it('exposes the option toggles as switches with aria-checked that follow their state',async()=>{
 const w=await railWorld();
 for(const key of ['spoken','brief','autoSend']){
  const box=w.all().find(byAttr('data-voice-option',key))!;
  expect(box.attributes.role,key).toBe('switch');
  w.bridge.voiceOptions[key]=false;w.emit('echo-workspace-context');
  expect(box.checked,key).toBe(false);expect(box.attributes['aria-checked'],key).toBe('false');
  w.bridge.voiceOptions[key]=true;w.emit('echo-workspace-context');
  expect(box.checked,key).toBe(true);expect(box.attributes['aria-checked'],key).toBe('true');
  box.checked=false;await box.fire('change');expect(box.attributes['aria-checked'],key).toBe('false');
 }
 const device=w.all().find(byAttr('data-speech-device'))!;
 expect(device.attributes.role).toBe('switch');expect(device.attributes['aria-checked']).toBe('false');
 device.checked=true;await device.fire('change');expect(device.attributes['aria-checked']).toBe('true');
 // Mute, Conversation mode and the personality toggle stay toggle buttons: their label states the action and aria-pressed carries the state.
 for(const pred of [byAttr('data-speech-mute'),byAttr('data-speech-conversation'),(n:Node)=>idOf(n)==='personality-toggle']){const b=w.all().find(pred)!;expect(b.tagName).toBe('BUTTON');expect(b.attributes['aria-pressed']).toMatch(/^(true|false)$/);}
});
it('colours the voice pill: green when Echo voice is configured, amber for device voice, red when unavailable',async()=>{
 const w=await railWorld();
 const pill=w.all().find(byAttr('data-speech-voice'))!;
 expect(pill.dataset.state).toBe('ok');
 w.bridge.state.data.voice={configured:false,reason:'Voice backend is off'};w.emit('echo-workspace-context');
 expect(pill.dataset.state).toBe('error');expect(pill.textContent).toContain('unavailable');
 const device=w.all().find(byAttr('data-speech-device'))!;device.checked=true;await device.fire('change');
 expect(pill.dataset.state).toBe('device');
 w.bridge.state.data.voice=VOICE;w.emit('echo-workspace-context');expect(pill.dataset.state).toBe('ok');
});
it('context meter: renders numbers and percentage, clamps to 0-100 and shifts level as it fills',async()=>{
 const w=await railWorld();
 const C=w.window.EchoPrimeComposer;
 const meter=(over:object)=>C.contextMeter({capacity:1000,contextChars:0,baseChars:0,draft:'',events:[],...over});
 expect(meter({contextChars:-8000}).percent).toBe(0);expect(meter({contextChars:-8000}).used).toBe(0);expect(meter({contextChars:-8000}).text).toBe('0 / 1,000 · 0.0% · estimate');
 expect(meter({contextChars:40000}).percent).toBe(100);expect(meter({contextChars:40000}).text).toBe('10,000 / 1,000 · 100.0% · estimate');
 expect(meter({contextChars:400}).percent).toBeCloseTo(10,5);
 expect([0,10,69.9,70,89.9,90,100].map(C.meterLevel)).toEqual(['ok','ok','ok','high','high','critical','critical']);
 const row=w.all().find(n=>/\bcontext-meter\b/.test(n.className))!,label=w.all().find(byAttr('data-context-label'))!;
 expect(label.textContent).toBe('5,749 / 262,144 · 2.2% · estimate');expect(row.hidden).toBe(false);expect(row.dataset.level).toBe('ok');
 w.bridge.state.data.base_context_chars=4*200000;w.emit('echo-workspace-context');expect(row.dataset.level).toBe('high');
 w.bridge.state.data.base_context_chars=4*250000;w.emit('echo-workspace-context');expect(row.dataset.level).toBe('critical');
 w.bridge.state.data.base_context_chars=4*900000;w.emit('echo-workspace-context');expect(label.textContent).toMatch(/· 100\.0% · estimate$/);
 const progress=w.all().find(n=>n.tagName==='PROGRESS')!;expect(progress.attributes['aria-label']).toBe('Context window used');
});

// ---------- stylesheet ----------
function block(selector:string){const at=railCss.indexOf(selector+'{');expect(at,selector).toBeGreaterThanOrEqual(0);return railCss.slice(at,railCss.indexOf('}',at));}
const tokens=(css:string)=>Object.fromEntries([...css.matchAll(/--rail-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m=>[m[1],m[2]]));
const lum=(hex:string)=>{const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4);return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
const ratio=(a:string,b:string)=>{const [hi,lo]=[lum(a),lum(b)].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);};
it('meets 4.5:1 text and 3:1 control contrast in the dark and the light theme',()=>{
 const themes={dark:tokens(block('#echo-rail')),light:tokens(block(':root[data-theme=light] #echo-rail'))};
 const text:Array<[string,string]>=[['text','bg'],['text','card'],['text','field'],['muted','bg'],['muted','card'],['muted','field'],['accent','card'],['ok','card'],['warn','card'],['bad','card'],['on-accent','accent-fill']];
 const control:Array<[string,string]>=[['edge','card'],['edge','field'],['accent-fill','card']];
 for(const [name,t] of Object.entries(themes)){
  for(const [a,b] of text){expect(t[a],name+' --rail-'+a).toBeTruthy();expect(t[b],name+' --rail-'+b).toBeTruthy();expect(ratio(t[a],t[b]),`${name} ${a}/${b}`).toBeGreaterThanOrEqual(4.5);}
  for(const [a,b] of control)expect(ratio(t[a],t[b]),`${name} ${a}/${b}`).toBeGreaterThanOrEqual(3);
 }
});
it('styles the rail for docked and drawer layouts, reduced motion, phones and the sidebar-right navigation',()=>{
 expect(railCss).toMatch(/@media\s*\(min-width:\s*1100px\)/);expect(railCss).toMatch(/@media\s*\(max-width:\s*1099(?:\.98)?px\)/);
 expect(railCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
 expect(railCss).toMatch(/html:not\(\.rail-hidden\)\s+main\s*\{[^}]*margin-right:\s*var\(--rail-w\)/);
 expect(railCss).toMatch(/\.sidebar-right\s+#echo-rail\s*\{[^}]*right:\s*var\(--sidebar-width/);
 expect(railCss).toMatch(/#echo-rail\s+\.quiet-button\s*\{[^}]*display:\s*inline-flex/);// styles.css hides .quiet-button on phones
 expect(railCss).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
 expect(railCss).toMatch(/\[data-speech-bar-mute\]\s*\{[^}]*display:\s*none/);// one Mute switch in the rail
 expect(railCss).toMatch(/grid-template-rows/);expect(railCss).toMatch(/:focus-visible/);
 expect(railCss).toMatch(/\.rail-card-body\s*\{[^}]*transition:[^;}]*\.1[5-9]s|\.rail-card-body\s*\{[^}]*transition:[^;}]*\.2s/);
 expect(railCss).toMatch(/\[data-level=critical\]/);
});
