/* eslint-disable @typescript-eslint/no-explicit-any -- purpose-built browser DOM stand-in */
import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {argumentTemplate, materialize, type MediaKind} from '../src/prime/media.js';

const source=readFileSync(new URL('../ui/echo-prime/integrations.js',import.meta.url),'utf8');
class Node {
 tagName:string;_text='';value='';hidden=false;disabled=false;open=false;checked=false;min='';max='';
 children:Node[]=[];parentNode:Node|null=null;attributes:Record<string,string>={};listeners:Record<string,((e:any)=>unknown)[]>={};className='';
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 get textContent():string{return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(v:string){this._text=String(v);this.children=[];}
 append(...items:any[]){for(const i of items){const n=typeof i==='string'?Object.assign(new Node('#text'),{_text:i}):i;n.parentNode=this;this.children.push(n);}}
 replaceChildren(...items:Node[]){this.children=[];this._text='';this.append(...items);}
 after(...items:Node[]){const p=this.parentNode!;const at=p.children.indexOf(this);for(const i of items)i.parentNode=p;p.children.splice(at+1,0,...items);}
 setAttribute(k:string,v:string){this.attributes[k]=String(v);}
 getAttribute(k:string){return this.attributes[k]??null;}
 addEventListener(k:string,f:(e:any)=>unknown){(this.listeners[k]??=[]).push(f);}
 async fire(k:string){for(const f of this.listeners[k]||[])await f({target:this});}
 click(){return this.fire('click');}
 showModal(){this.open=true;}close(){this.open=false;}focus(){}
}
const walk=(n:Node):Node[]=>n.children.flatMap(c=>[c,...walk(c)]);
const flush=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
const UPL='upl_'+'a'.repeat(32);
const media=(kind:'image'|'video'|'audio')=>({uploadId:UPL,artifactId:'art_'+'b'.repeat(32),url:'/api/prime/uploads/'+UPL+'/file',type:kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/mpeg',kind,bytes:900,name:'out.'+(kind==='image'?'png':kind==='video'?'mp4':'mp3')});
function world(opts:{execute?:any;executes?:any[];jobs?:any[];jobFor?:(body:any)=>any;prepareStatus?:number;catalog?:any[]}={}){
 const ids=new Map<string,Node>(),root=new Node('body');
 const make=(id:string,tag='div')=>{const n=new Node(tag);n.setAttribute('id',id);ids.set('#'+id,n);return n;};
 const label=new Node('label'),brief=make('creative-prompt','textarea');label.append(brief);
 const request=new Node('div');request.append(make('selected-tool','h3'),make('tool-details','p'),label,make('creative-inputs'),make('creative-arguments','textarea'),make('prepare-creative','button'),make('refresh-catalog','button'),make('creative-result','pre'));
 root.append(make('catalog-state'),make('creative-search','input'),make('creative-category','select'),make('model-list'),make('include-adult','input'),make('creative-tools'),request,make('request-review'),make('request-cost'),make('connection-result'),make('execute-request','button'),make('review-dialog','dialog'),make('creative-dialog','dialog'),make('refresh-connections','button'));
 const calls:any[]=[],jobs=[...(opts.jobs??[])],executes=[...(opts.executes??[])],events:any[]=[],windowEvents:Record<string,((e:any)=>unknown)[]>={};
 const ticketIds=['11111111-2222-4333-8444-555555555555','22222222-2222-4333-8444-555555555555','33333333-2222-4333-8444-555555555555'];let prepared=0;
 const json=(status:number,body:any)=>({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},json:async()=>body});
 const fetch=vi.fn(async(url:string,init:any={})=>{
  const body=init.body?JSON.parse(init.body):undefined;calls.push({url,body});
  if(url==='/api/prepare')return opts.prepareStatus?json(opts.prepareStatus,{error:'Same-origin Prime session required'}):json(200,{id:'tkt'+prepared,digest:'dig',requestId:ticketIds[Math.min(prepared++,2)],cost:'Provider charges or quota may apply. No automatic fallback.',scope:'tier:1',request:body});
  if(url==='/api/execute')return json(200,executes.length?executes.shift():opts.execute??{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',result:{ok:true},job:{label:'Tool',elapsedMs:1000}});
  if(url==='/api/prime/media/job')return json(200,jobs.length?jobs.shift():opts.jobFor?.(body));
  throw new Error('unexpected '+url);
 });
 const workspace={ownerHeaders:async()=>({'x-prime-request':'1'}),invalidate:vi.fn(),recheck:vi.fn(async()=>({authenticated:true}))};
 const register=vi.fn(async()=>({id:'art_x'}));
 const window:any={EchoPrimeCatalog:{capabilities:opts.catalog??[
  {id:'echo.media.image_generate',category:'image',description:'on-prem',health:'amber'},
  {id:'echo.llm.together.openai-sora-2',category:'video',description:'Sora',health:'green'},
  {id:'echo.cartesia.tts',category:'voice',description:'Cartesia',health:'green'},
  {id:'echo.acme.convert',category:'tools',description:'tool',health:'green'}],models:[]},
  EchoPrimeWorkspace:workspace,EchoPrimeArtifacts:{register},EchoPrimeLibrary:{refresh:vi.fn(async()=>{}),open:vi.fn()},
  addEventListener:(k:string,f:(e:any)=>unknown)=>(windowEvents[k]??=[]).push(f),dispatchEvent:(e:any)=>{events.push(e.detail);for(const f of windowEvents[e.type]||[])f(e);}};
 const document={querySelector:(s:string)=>ids.get(s)??null,createElement:(t:string)=>new Node(t),createTextNode:(t:string)=>Object.assign(new Node('#text'),{_text:t})};
 runInNewContext(source,{window,document,fetch,location:{protocol:'https:'},AbortController,AbortSignal,console:{debug(){}},CustomEvent:class{type:string;detail:any;constructor(t:string,i:any){this.type=t;this.detail=i?.detail;}},setTimeout:(f:()=>void)=>setImmediate(f),Date,JSON,Object,Array,String,Number,Math,Error,Promise,Map,Set,Boolean,Intl});
 const get=(id:string)=>ids.get(id)!;
 const output=()=>walk(request).find(n=>n.getAttribute('id')==='creative-output');
 async function runRequest(){await get('#prepare-creative').click();await flush();await get('#execute-request').click();await flush();}
 return {root,window,get,calls,fetch,workspace,register,events,output,runRequest,studio:window.EchoPrimeStudio};
}

describe('Creative Studio results',()=>{
 it('renders a stored image as <img>, says where it was saved, and never posts a JSON copy',async()=>{
  const w=world({execute:{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',capability:'echo.media.image_generate',media:media('image'),result:{ok:true,status:'done'},job:{label:'On-prem media router',elapsedMs:12000}}});
  w.studio.open('image','a red fox in the snow');await w.runRequest();
  expect(JSON.parse(JSON.stringify(w.calls.find(c=>c.url==='/api/prepare').body.arguments))).toEqual({prompt:'a red fox in the snow',wait:false});
  const img=walk(w.output()!).find(n=>n.tagName==='IMG')!;
  expect(img.attributes).toMatchObject({src:'/api/prime/uploads/'+UPL+'/file',alt:'a red fox in the snow'});
  expect(w.get('#creative-result').textContent).toBe('On-prem media router finished in 0:12. Saved to Library as out.png.');
  expect(w.register).not.toHaveBeenCalled();expect(w.window.EchoPrimeLibrary.refresh).toHaveBeenCalled();
  expect(w.events.at(-1)).toMatchObject({state:'returned',name:'echo.media.image_generate'});
 });
 it('follows a running video request by request id, shows progress, then a <video controls>',async()=>{
  const id='11111111-2222-4333-8444-555555555555',deadline=new Date(Date.now()+900000).toISOString();
  const running={state:'running',requestId:id,job:{phase:'polling',label:'On-prem video',providerStatus:'queued',polls:1,elapsedMs:3000,deadline}};
  const w=world({execute:running,jobs:[{...running,job:{...running.job,providerStatus:'running',polls:2}},{state:'returned',requestId:id,media:media('video'),job:{label:'On-prem video',elapsedMs:65000}}],
   catalog:[{id:'echo.media.video_generate',category:'video',description:'on-prem video',health:'green'}]});
  w.studio.open('video','waves at dusk');await w.runRequest();
  const polls=w.calls.filter(c=>c.url==='/api/prime/media/job');
  expect(polls.map(c=>c.body)).toEqual([{requestId:id},{requestId:id}]);
  const video=walk(w.output()!).find(n=>n.tagName==='VIDEO')!;
  expect(video.attributes).toMatchObject({src:'/api/prime/uploads/'+UPL+'/file',controls:''});
  expect(w.get('#creative-result').textContent).toContain('finished in 1:05');
 });
 it('says how to check a provider job Prime cannot follow instead of "Outcome unknown"',async()=>{
  const w=world({execute:{state:'submitted',requestId:'11111111-2222-4333-8444-555555555555',job:{followable:false,providerJobId:'vid_9',howToCheck:'Together accepted the job (vid_9) but no status capability is registered.'}}});
  w.studio.open('video','a boat');await w.runRequest();
  expect(w.get('#creative-result').textContent).toContain('vid_9');expect(w.get('#creative-result').textContent).not.toContain('Outcome unknown');
  expect(w.calls.some(c=>c.url==='/api/prime/media/job')).toBe(false);
 });
 it('renders audio with <audio controls> and the media error when Prime could not store a file',async()=>{
  const a=world({execute:{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',media:media('audio'),job:{label:'Cartesia TTS',elapsedMs:1900}}});
  a.studio.open('voice','Hello Commander');await a.runRequest();
  expect(walk(a.output()!).find(n=>n.tagName==='AUDIO')!.attributes).toMatchObject({controls:'',src:'/api/prime/uploads/'+UPL+'/file'});
  expect(JSON.parse(a.get('#creative-arguments').value)).toEqual({text:'Hello Commander'});
  const b=world({execute:{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',result:{ok:true,audio_url:'/cartesia/audio/x.mp3'},mediaError:'the result link is relative to the service that made it, and media.origins maps no origin for echo.cartesia.tts',job:{label:'Cartesia TTS'}}});
  b.studio.open('voice','Hello');await b.runRequest();
  expect(b.output()!.textContent).toContain('media.origins maps no origin');expect(b.output()!.textContent).toContain('Provider answer (untrusted)');
 });
 it('puts the length control into the request for a video tool and clamps it to the tool range',async()=>{
  const w=world();w.studio.open('video','a paper boat');
  const duration=w.get('#creative-prompt').parentNode!.parentNode!.children.find(n=>n.getAttribute('data-creative-duration')!==null)!;
  expect(duration.hidden).toBe(false);expect(duration.textContent).toContain('1 to 10 seconds');
  const input=duration.children.find(n=>n.tagName==='INPUT')!;
  input.value='5';await input.fire('input');
  expect(JSON.parse(w.get('#creative-arguments').value)).toEqual({command:'call',prompt:'a paper boat',seconds:'5'});
  input.value='30';await input.fire('input');expect(JSON.parse(w.get('#creative-arguments').value).seconds).toBe('10');
  w.studio.select('echo.cartesia.tts');expect(duration.hidden).toBe(true);
 });
 it('keeps the router pick exact through brief edits via its template and fills the length from the route',async()=>{
  const w=world();w.studio.open('video','x');
  const template=argumentTemplate('echo.llm.together.openai-sora-2','video');
  expect(w.studio.apply({id:'echo.llm.together.openai-sora-2',arguments:{command:'call',prompt:'x',seconds:'5'},template,durationSeconds:5})).toBe(true);
  w.get('#creative-prompt').value='a slow boat';await w.get('#creative-prompt').fire('input');
  expect(JSON.parse(w.get('#creative-arguments').value)).toEqual({command:'call',prompt:'a slow boat',seconds:'5'});
 });
 it('clears the previous result when another tool or medium is chosen',async()=>{
  const w=world({execute:{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',media:media('image'),job:{label:'X'}}});
  w.studio.open('image','fox');await w.runRequest();expect(w.get('#creative-result').textContent).not.toBe('');
  w.studio.select('echo.cartesia.tts');expect(w.get('#creative-result').textContent).toBe('');expect(w.output()!.children).toHaveLength(0);
  await w.runRequest();w.studio.open('video','boat');expect(w.get('#creative-result').textContent).toBe('');
 });
 it('stops painting a running request into the result area once another tool is chosen, and still follows it to Library',async()=>{
  const id='11111111-2222-4333-8444-555555555555',deadline=new Date(Date.now()+900000).toISOString();
  const running={state:'running',requestId:id,job:{phase:'polling',label:'On-prem video',providerStatus:'running',polls:1,elapsedMs:3000,deadline}};
  let done=false;
  const w=world({execute:running,jobFor:()=>done?{state:'returned',requestId:id,media:media('video'),job:{label:'On-prem video',elapsedMs:65000}}:running,
   catalog:[{id:'echo.media.video_generate',category:'video',description:'on-prem video',health:'green'},{id:'echo.cartesia.tts',category:'voice',description:'Cartesia',health:'green'}]});
  w.studio.open('video','waves at dusk');await w.runRequest();
  expect(w.get('#creative-result').textContent).toContain('On-prem video is working');
  w.studio.select('echo.cartesia.tts');await flush();
  expect(w.get('#creative-result').textContent).toBe('');expect(w.output()!.children).toHaveLength(0);
  const note=walk(w.get('#creative-result').parentNode!).find(n=>n.getAttribute('id')==='creative-background')!;
  expect(note.textContent).toContain('On-prem video is still running');expect(note.textContent).toContain(id);
  done=true;await flush();
  expect(w.get('#creative-result').textContent).toBe('');expect(w.output()!.children).toHaveLength(0);
  expect(note.textContent).toContain('On-prem video finished; saved to Library as out.mp4.');
  expect(w.window.EchoPrimeLibrary.refresh).toHaveBeenCalled();
 });
 it('lets the owner submit another request while an earlier one is still running',async()=>{
  const id='11111111-2222-4333-8444-555555555555',deadline=new Date(Date.now()+900000).toISOString();
  const running={state:'running',requestId:id,job:{phase:'polling',label:'On-prem video',providerStatus:'running',polls:1,elapsedMs:3000,deadline}};
  let polls=0;
  const w=world({executes:[running,{state:'returned',requestId:'22222222-2222-4333-8444-555555555555',media:media('audio'),job:{label:'Cartesia TTS',elapsedMs:900}}],
   jobFor:()=>++polls>150?{state:'returned',requestId:id,media:media('video'),job:{label:'On-prem video',elapsedMs:65000}}:running,
   catalog:[{id:'echo.media.video_generate',category:'video',description:'on-prem video',health:'green'},{id:'echo.cartesia.tts',category:'voice',description:'Cartesia',health:'green'}]});
  // The first Execute click is not awaited: the owner keeps working while the video is followed.
  w.studio.open('video','waves at dusk');await w.get('#prepare-creative').click();await flush();
  const first=w.get('#execute-request').click();await flush();
  expect(polls).toBeGreaterThan(0);expect(polls).toBeLessThanOrEqual(60);
  w.studio.select('echo.cartesia.tts');w.get('#creative-prompt').value='Hello Commander';await w.get('#creative-prompt').fire('input');
  await w.get('#prepare-creative').click();await flush();await w.get('#execute-request').click();await flush();
  expect(w.calls.filter(c=>c.url==='/api/execute')).toHaveLength(2);
  expect(walk(w.output()!).find(n=>n.tagName==='AUDIO')!.attributes.src).toBe('/api/prime/uploads/'+UPL+'/file');
  expect(w.get('#creative-result').textContent).toContain('Cartesia TTS finished');
  for(let i=0;i<20&&polls<=150;i++)await flush();
  await first;
  expect(w.get('#creative-result').textContent).toContain('Cartesia TTS finished');
 });
 it('counts only a missing file as a failed run; a file Prime could not read is reported as generated',async()=>{
  const id='11111111-2222-4333-8444-555555555555';
  const w=world({execute:{state:'returned',requestId:id,mediaError:'the file /x.png is outside media.localRoots',mediaErrorKind:'unreadable',result:{ok:true,path:'/x.png'},job:{label:'On-prem media router'}}});
  w.studio.open('image','fox');await w.runRequest();
  expect(w.events.at(-1)).toMatchObject({state:'returned'});
  expect(w.get('#creative-result').textContent).toContain('On-prem media router generated a file, but Prime could not read it');
  const v=world({execute:{state:'returned',requestId:id,mediaError:'On-prem media router answered without a media file',mediaErrorKind:'no_media',result:{ok:true},job:{label:'On-prem media router'}}});
  v.studio.open('image','fox');await v.runRequest();
  expect(v.events.at(-1)).toMatchObject({state:'failed'});
 });
 it('treats a 403 as a refusal: re-reads the session, never signs out, and shows the reason',async()=>{
  const w=world({prepareStatus:403});w.studio.open('image','fox');await w.get('#prepare-creative').click();await flush();
  expect(w.workspace.recheck).toHaveBeenCalledOnce();expect(w.workspace.invalidate).not.toHaveBeenCalled();
  expect(w.get('#creative-result').textContent).toBe('Same-origin Prime session required');
 });
 it('registers a non-media tool answer titled and provenanced with the actual brief',async()=>{
  const w=world({execute:{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',result:{ok:true,converted:3},job:{label:'acme.convert'}}});
  w.get('#creative-category').value='tools';w.studio.select('echo.acme.convert');w.get('#creative-prompt').value='convert these notes';await w.get('#creative-prompt').fire('input');
  await w.runRequest();
  expect(w.register).toHaveBeenCalledWith(expect.objectContaining({title:'acme.convert · convert these notes',provenance:expect.objectContaining({source:'studio',capability:'echo.acme.convert',prompt:'convert these notes'})}));
 });
 it('builds every request exactly as the server router does (shared template rules)',()=>{
  const w=world();
  const cases:[string,string,MediaKind][]=[['echo.media.image_generate','image','image'],['echo.media.video_generate','video','video'],['echo.llm.together.openai-sora-2','video','video'],['echo.llm.together.black-forest-labs-FLUX.2-max','image','image'],['echo.llm.openrouter.google-gemini-2.5-flash-image','image','image'],
   ['echo.elevenlabs.music_generation.generate','music','music'],['echo.elevenlabs.music_generation.compose_detailed','music','music'],['echo.elevenlabs.sound_generation.sound_generation','sound','sfx'],['echo.voice.speak','voice','voice'],['echo.elevenlabs.tts','voice','voice'],['echo.cartesia.tts','voice','voice'],['echo.voice.elevenlabs.music','music','music'],['echo.voice.elevenlabs.sfx','sound','sfx'],['echo.fal.generate','image','image'],['echo.deepai.image','image','image'],['echo.image.qwen.generate','image','image']];
  for(const [id,category,kind] of cases)for(const seconds of [undefined,5,45]){
   const client=w.studio.materialize(w.studio.templateFor(id,category),'brief',seconds),server=materialize(argumentTemplate(id,kind),'brief',seconds);
   expect(JSON.parse(JSON.stringify(client)),id+' '+seconds).toEqual(server);
  }
 });
});

describe('Creative Studio adult mode',()=>{
 const LINE='Adult mode: fictional adult characters only. Real people and anyone under 18 are refused.';
 const ROUTER_CAPS=[{id:'echo.media.image_generate',category:'image',description:'on-prem',health:'green'},{id:'echo.media.video_generate',category:'video',description:'on-prem video',health:'green'}];
 const CLOUD=[{id:'echo.llm.together.openai-sora-2',category:'video',description:'Sora',health:'green'},{id:'echo.llm.together.ByteDance-Seed-Seedream-4.0',category:'image',description:'Seedream',health:'green'},{id:'echo.cartesia.tts',category:'voice',description:'Cartesia',health:'green'}];
 const byId=(w:any,id:string)=>walk(w.root).find(n=>n.getAttribute('id')===id)!;
 const set=async(node:Node,checked:boolean)=>{node.checked=checked;await node.fire('change');};
 const sent=(w:any)=>w.calls.filter((c:any)=>c.url==='/api/prepare').map((c:any)=>JSON.parse(JSON.stringify(c.body.arguments)));
 const ID='11111111-2222-4333-8444-555555555555';
 it('is off by default, clearly labelled, and hides the adult copy and the attestation until it is switched on',()=>{
  const w=world();w.studio.open('image','a fox');
  const mode=byId(w,'adult-mode'),panel=byId(w,'adult-panel');
  expect(mode.getAttribute('type')).toBe('checkbox');expect(mode.checked).toBe(false);
  expect(mode.parentNode!.textContent).toContain('Adult mode');expect(mode.parentNode!.textContent).toContain('on-prem');
  expect(panel.hidden).toBe(true);expect(w.get('#prepare-creative').disabled).toBe(false);
  expect(w.studio.adult()).toEqual({on:false,fictional:false,style:'photoreal'});
 });
 it('shows the adult line and the explicit attestation, and keeps Generate disabled until it is ticked',async()=>{
  const w=world();w.studio.open('image','a fox');
  const mode=byId(w,'adult-mode'),panel=byId(w,'adult-panel'),fiction=byId(w,'adult-fictional');
  await set(mode,true);
  expect(panel.hidden).toBe(false);expect(byId(w,'adult-line').textContent).toBe(LINE);
  expect(fiction.getAttribute('type')).toBe('checkbox');expect(fiction.checked).toBe(false);expect(fiction.parentNode!.textContent).toContain('All subjects are fictional adults');
  expect(w.get('#prepare-creative').disabled).toBe(true);
  await set(fiction,true);expect(w.get('#prepare-creative').disabled).toBe(false);
  await set(fiction,false);expect(w.get('#prepare-creative').disabled).toBe(true);
  await set(fiction,true);await set(mode,false);expect(panel.hidden).toBe(true);expect(w.get('#prepare-creative').disabled).toBe(false);
  expect(w.studio.adult()).toMatchObject({on:false});
 });
 it('never sends a request while the attestation is unticked, even if Review is clicked anyway',async()=>{
  const w=world();w.studio.open('image','a fox');await set(byId(w,'adult-mode'),true);
  await w.get('#prepare-creative').click();await flush();
  expect(w.calls.some(c=>c.url==='/api/prepare')).toBe(false);expect(w.get('#creative-result').textContent).toContain('All subjects are fictional adults');
 });
 it('carries nsfw, subjects_fictional, the chosen style and TEMPER in the request, and drops them again when switched off',async()=>{
  const w=world({catalog:[...ROUTER_CAPS,...CLOUD]});w.studio.open('image','ADULT_BRIEF_MARKER a woman at the beach');
  const mode=byId(w,'adult-mode'),fiction=byId(w,'adult-fictional'),style=byId(w,'adult-style');
  await set(mode,true);await set(fiction,true);
  expect(JSON.parse(w.get('#creative-arguments').value)).toEqual({prompt:'ADULT_BRIEF_MARKER a woman at the beach',wait:false,nsfw:true,subjects_fictional:true,style:'photoreal',node:'temper'});
  style.value='anime';await style.fire('change');
  await w.get('#prepare-creative').click();await flush();
  expect(sent(w)).toEqual([{prompt:'ADULT_BRIEF_MARKER a woman at the beach',wait:false,nsfw:true,subjects_fictional:true,style:'anime',node:'temper'}]);
  await set(mode,false);
  expect(JSON.parse(w.get('#creative-arguments').value)).toEqual({prompt:'ADULT_BRIEF_MARKER a woman at the beach',wait:false});
 });
 it('adds the adult fields to the video tool without a style',async()=>{
  const w=world({catalog:[...ROUTER_CAPS,...CLOUD]});w.studio.open('video','ADULT_BRIEF_MARKER waves');
  await set(byId(w,'adult-mode'),true);await set(byId(w,'adult-fictional'),true);
  const args=JSON.parse(w.get('#creative-arguments').value);
  expect(args).toMatchObject({prompt:'ADULT_BRIEF_MARKER waves',wait:false,nsfw:true,subjects_fictional:true,node:'temper'});expect(args.style).toBeUndefined();
 });
 it('lists only the on-prem router tools while adult mode is on, and everything again when it is off',async()=>{
  const w=world({catalog:[...ROUTER_CAPS,...CLOUD]});w.studio.open('all','');
  const names=()=>w.get('#creative-tools').children.map(b=>b.children[0].textContent);
  expect(names().length).toBeGreaterThan(2);
  await set(byId(w,'adult-mode'),true);
  expect(names().sort()).toEqual(['media.image_generate','media.video_generate']);
  expect(w.get('#catalog-state').textContent).toContain('on-prem');
  await set(byId(w,'adult-mode'),false);expect(names().length).toBeGreaterThan(2);
 });
 it('moves the selection to the router tool when adult mode is switched on, and refuses any other tool locally',async()=>{
  const w=world({catalog:[...ROUTER_CAPS,...CLOUD]});w.studio.open('video','ADULT_BRIEF_MARKER waves');w.studio.select('echo.llm.together.openai-sora-2');
  expect(w.get('#selected-tool').textContent).toBe('echo.llm.together.openai-sora-2');
  await set(byId(w,'adult-mode'),true);await set(byId(w,'adult-fictional'),true);
  expect(w.get('#selected-tool').textContent).toBe('echo.media.video_generate');
  w.studio.select('echo.llm.together.ByteDance-Seed-Seedream-4.0');
  await w.get('#prepare-creative').click();await flush();
  expect(w.calls.some(c=>c.url==='/api/prepare')).toBe(false);expect(w.get('#creative-result').textContent).toContain('on-prem media router');
 });
 it('holds Review while reference uploads are attached, because adult mode takes none',async()=>{
  const w=world();w.studio.open('image','a fox');w.studio.addInput('upl_'+'a'.repeat(32));
  await set(byId(w,'adult-mode'),true);await set(byId(w,'adult-fictional'),true);
  await w.get('#prepare-creative').click();await flush();
  expect(w.calls.some(c=>c.url==='/api/prepare')).toBe(false);expect(w.get('#creative-result').textContent).toContain('reference uploads');
 });
 it('cancels a reviewed request when the attestation is withdrawn, so it cannot be run',async()=>{
  const w=world();w.studio.open('image','a fox');await set(byId(w,'adult-mode'),true);await set(byId(w,'adult-fictional'),true);
  await w.get('#prepare-creative').click();await flush();expect(w.get('#execute-request').disabled).toBe(false);
  await set(byId(w,'adult-fictional'),false);expect(w.get('#execute-request').disabled).toBe(true);
  await w.get('#execute-request').click();await flush();expect(w.calls.some(c=>c.url==='/api/execute')).toBe(false);
 });
 it('tells the rest of the page when the adult state changes',async()=>{
  const w=world();w.studio.open('image','a fox');await set(byId(w,'adult-mode'),true);await set(byId(w,'adult-fictional'),true);
  expect(w.events.at(-1)).toEqual({on:true,fictional:true,style:'photoreal'});
 });
 it('shows the model that actually ran with an on-prem (TEMPER) badge, or the real node when it is not TEMPER',async()=>{
  const used={model:'illustrious-xl-v0.1',node:'temper',backend:'comfyui'};
  const w=world({execute:{state:'returned',requestId:ID,capability:'echo.media.image_generate',media:media('image'),used,job:{label:'On-prem media router',elapsedMs:12000}}});
  w.studio.open('image','a fox');await w.runRequest();
  const badge=walk(w.output()!).find(n=>n.getAttribute('data-used')!==null)!;
  expect(badge.textContent).toContain('on-prem (TEMPER)');expect(badge.textContent).toContain('illustrious-xl-v0.1');
  const f=world({execute:{state:'returned',requestId:ID,capability:'echo.media.image_generate',media:media('image'),used:{model:'juggernaut',node:'forge',backend:'diffusers'},job:{label:'On-prem media router'}}});
  f.studio.open('image','a fox');await f.runRequest();
  const fb=walk(f.output()!).find(n=>n.getAttribute('data-used')!==null)!;
  expect(fb.textContent).toContain('on-prem (FORGE)');expect(fb.textContent).not.toContain('TEMPER');expect(fb.textContent).toContain('juggernaut');
  const none=world({execute:{state:'returned',requestId:ID,media:media('image'),job:{label:'X'}}});
  none.studio.open('image','a fox');await none.runRequest();
  expect(walk(none.output()!).some(n=>n.getAttribute('data-used')!==null)).toBe(false);
 });
 it('shows the router refusal exactly as the router said it, and does not try another tool',async()=>{
  const said="no live nsfw-capable on-prem image model for style 'anime'; available nsfw-capable styles: photoreal";
  const w=world({catalog:[...ROUTER_CAPS,...CLOUD],execute:{state:'blocked',requestId:ID,capability:'echo.media.image_generate',detail:said,job:{label:'On-prem media router'}}});
  w.studio.open('image','ADULT_BRIEF_MARKER a woman');await set(byId(w,'adult-mode'),true);await set(byId(w,'adult-fictional'),true);
  await w.runRequest();
  expect(w.get('#creative-result').textContent).toBe('On-prem media router did not complete: '+said+'.');
  expect(w.calls.filter(c=>c.url==='/api/prepare')).toHaveLength(1);expect(w.calls.filter(c=>c.url==='/api/execute')).toHaveLength(1);
  expect(w.events.at(-1)).toMatchObject({state:'blocked',detail:said});
 });
 it('keeps the listing toggle separate: it is labelled as a listing filter and does not switch adult mode on',()=>{
  const html=readFileSync(new URL('../ui/echo-prime/index.html',import.meta.url),'utf8');
  expect(html).toMatch(/id="include-adult"[^>]*> Show NSFW-capable model listings \(listing only/);
  expect(html).not.toContain('id="adult-mode"');
  const w=world();w.studio.open('image','a fox');expect(byId(w,'adult-mode').checked).toBe(false);
 });
});
