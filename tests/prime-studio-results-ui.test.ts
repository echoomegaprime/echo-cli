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
function world(opts:{execute?:any;jobs?:any[];prepareStatus?:number;catalog?:any[]}={}){
 const ids=new Map<string,Node>(),root=new Node('body');
 const make=(id:string,tag='div')=>{const n=new Node(tag);n.setAttribute('id',id);ids.set('#'+id,n);return n;};
 const label=new Node('label'),brief=make('creative-prompt','textarea');label.append(brief);
 const request=new Node('div');request.append(make('selected-tool','h3'),make('tool-details','p'),label,make('creative-inputs'),make('creative-arguments','textarea'),make('prepare-creative','button'),make('refresh-catalog','button'),make('creative-result','pre'));
 root.append(make('catalog-state'),make('creative-search','input'),make('creative-category','select'),make('model-list'),make('include-adult','input'),make('creative-tools'),request,make('request-review'),make('request-cost'),make('connection-result'),make('execute-request','button'),make('review-dialog','dialog'),make('creative-dialog','dialog'),make('refresh-connections','button'));
 const calls:any[]=[],jobs=[...(opts.jobs??[])],events:any[]=[],windowEvents:Record<string,((e:any)=>unknown)[]>={};
 const json=(status:number,body:any)=>({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},json:async()=>body});
 const fetch=vi.fn(async(url:string,init:any={})=>{
  const body=init.body?JSON.parse(init.body):undefined;calls.push({url,body});
  if(url==='/api/prepare')return opts.prepareStatus?json(opts.prepareStatus,{error:'Same-origin Prime session required'}):json(200,{id:'tkt',digest:'dig',requestId:'11111111-2222-4333-8444-555555555555',cost:'Provider charges or quota may apply. No automatic fallback.',scope:'tier:1',request:body});
  if(url==='/api/execute')return json(200,opts.execute??{state:'returned',requestId:'11111111-2222-4333-8444-555555555555',result:{ok:true},job:{label:'Tool',elapsedMs:1000}});
  if(url==='/api/prime/media/job')return json(200,jobs.shift());
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
 return {window,get,calls,fetch,workspace,register,events,output,runRequest,studio:window.EchoPrimeStudio};
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
