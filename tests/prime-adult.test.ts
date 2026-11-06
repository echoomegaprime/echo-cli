/* eslint-disable @typescript-eslint/no-explicit-any -- focused SDK stand-ins */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {PrimeHub, type Capability, type SdkBroker} from '../src/prime/hub.js';
import {UploadStore, parseUploadsConfig} from '../src/prime/uploads.js';
import {DEFAULT_GATE_CALL_KINDS, defaultMediaConfig, type MediaConfig} from '../src/prime/media-collect.js';
import {MediaRouter, rankCandidates} from '../src/prime/media.js';
import {PromptEnhancer} from '../src/prime/enhance.js';

// Adult-routing contract. No fixture here carries explicit text: ADULT_BRIEF_MARKER is the stand-in adult brief, enabled
// through the test-only adultMarkers option; "nsfw" is the one real keyword used.
const MARKER='ADULT_BRIEF_MARKER',markers=[MARKER];
const ROUTER='echo.media.image_generate',SEEDREAM='echo.llm.together.ByteDance-Seed-Seedream-4.0';
const snapshot=(JSON.parse(readFileSync(new URL('../ui/echo-prime/catalog.json',import.meta.url),'utf8')) as {capabilities:Capability[]}).capabilities;
const callKinds=[...DEFAULT_GATE_CALL_KINDS,'together_image_generation','together_video_generation'];
const cap=(id:string,extra:Partial<Capability>={}):Capability=>({id,registered:true,health:'green',category:'image',description:'generator',...extra});

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const tmp=(prefix:string)=>{const d=mkdtempSync(join(tmpdir(),prefix));dirs.push(d);return d;};
function crc32(buf:Buffer){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(c&1?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type:string,data:Buffer){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii'),crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);}
function png(w=8,h=6){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc(h*(1+w*4),120);for(let y=0;y<h;y++)raw[y*(1+w*4)]=0;return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
function fakeClock(){let now=Date.parse('2026-11-06T12:00:00Z');return {now:()=>now,sleep:async(ms:number)=>{now+=ms;},advance:(ms:number)=>{now+=ms;}};}
function hubWith(invoke:(request:any,options?:any)=>Promise<unknown>,extra:{config?:Partial<MediaConfig>;catalog?:Capability[];clock?:ReturnType<typeof fakeClock>;health?:(id:string)=>string}={}){
 const root=tmp('prime-adult-up-'),uploads=new UploadStore(parseUploadsConfig({root}));
 const sdk={search:vi.fn(async()=>[]),read:vi.fn(async(id:string)=>({registration_state:'registered',health_status:extra.health?.(id)??'green',capability:{id}})),invoke:vi.fn(invoke)} as unknown as SdkBroker&{invoke:ReturnType<typeof vi.fn>;read:ReturnType<typeof vi.fn>};
 const hub=new PrimeHub({capabilities:extra.catalog??[cap(ROUTER,{description:'Routed on-prem text-to-image ($0).'}),cap(SEEDREAM,{description:'type=image; call_kind=together_image_generation.'}),cap('echo.cartesia.tts',{category:'voice',description:'Cartesia TTS'})],sdk,uploads,uploadsOwner:'owner-1',
  mediaConfig:{...defaultMediaConfig(),...extra.config},mediaClock:extra.clock,adultMarkers:markers} as any);
 return {hub,sdk,uploads};
}
const prepare=(hub:PrimeHub,name:string,args:Record<string,unknown>)=>hub.prepare({target:'sdk',name,arguments:args});
async function run(hub:PrimeHub,name:string,args:Record<string,unknown>){const t=await prepare(hub,name,args);return hub.execute(t.id,t.digest) as Promise<any>;}
const adultArgs=(extra:Record<string,unknown>={})=>({prompt:MARKER+' a woman at the beach',nsfw:true,subjects_fictional:true,style:'photoreal',wait:false,...extra});
const routeOpts=(over:Record<string,unknown>={})=>({catalog:()=>snapshot,callKinds,adultMarkers:markers,...over}) as any;

describe('candidate filtering',()=>{
 it('keeps cloud providers in the ranking for an ordinary brief and excludes every one of them for an adult brief',()=>{
  const text='a red fox in the snow',sfw=rankCandidates('image',snapshot,{text,callKinds});
  expect(sfw.candidates.some(c=>c.id.startsWith('echo.llm.together.'))).toBe(true);
  expect(sfw.candidates.map(c=>c.id)).toContain(ROUTER);
  const adult=rankCandidates('image',snapshot,{text,callKinds,adult:true} as any);
  expect(adult.candidates.map(c=>c.id)).toEqual([ROUTER]);
  const together=adult.excluded.find(c=>c.id===SEEDREAM)!;
  expect(together.unavailable).toMatch(/adult/i);expect(together.unavailable).toMatch(/on-prem/i);
  for(const id of ['echo.fal.generate','echo.deepai.image','echo.image.generate','echo.image.qwen.generate','echo.google.vertex.imagen_generate'])
   if(snapshot.some(c=>c.id===id))expect(adult.excluded.map(c=>c.id),id).toContain(id);
  expect(adult.candidates.some(c=>/^echo\.(?:llm|fal|deepai|google|openai|replicate|cloudflare|xai|vertex)\./.test(c.id))).toBe(false);
 });
 it('excludes the other on-prem tools too: adult runs only on the router capabilities',()=>{
  const r=rankCandidates('image',snapshot,{text:'x',callKinds,adult:true} as any);
  expect(r.candidates.map(c=>c.id)).toEqual([ROUTER]);
  expect(r.excluded.find(c=>c.id==='echo.image.generate')?.unavailable).toMatch(/media router/);
 });
 it('leaves every other kind with no candidate in adult mode (the router has no audio capability)',()=>{
  for(const kind of ['music','sfx','voice'] as const)expect(rankCandidates(kind,snapshot,{text:'x',callKinds,adult:true} as any).candidates,kind).toEqual([]);
 });
});

describe('adult route',()=>{
 const text=MARKER+' a woman at the beach';
 it('picks only the on-prem router and shapes the request with nsfw, subjects_fictional, the chosen style and TEMPER',async()=>{
  const r=await new MediaRouter(routeOpts()).route({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked.id).toBe(ROUTER);
  expect(r.picked.request.arguments).toEqual({prompt:text,wait:false,style:'photoreal',nsfw:true,subjects_fictional:true,node:'temper'});
  expect(r.alternatives).toEqual([]);
  expect([r.picked,...r.alternatives].some((p:any)=>p.id.startsWith('echo.llm.'))).toBe(false);
  expect(r.excluded.find((x:any)=>x.id===SEEDREAM).reason).toMatch(/adult/i);
  expect(r.adult).toMatchObject({active:true,style:'photoreal',restrictedTo:['echo.media.image_generate','echo.media.video_generate']});
 });
 it('carries the anime style the user chose, over what the brief hints at',async()=>{
  const r=await new MediaRouter(routeOpts()).route({text:text+', photorealistic',mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'anime'}) as any;
  expect(r.picked.request.arguments.style).toBe('anime');
 });
 it('rebuilds the same fields when the template is materialised for another brief',async()=>{
  const {materialize}=await import('../src/prime/media.js');
  const r=await new MediaRouter(routeOpts()).route({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'anime'}) as any;
  expect(materialize(r.picked.template,'another '+MARKER+' brief')).toEqual({prompt:'another '+MARKER+' brief',wait:false,style:'anime',nsfw:true,subjects_fictional:true,node:'temper'});
 });
 it('sends nothing anywhere when the classifier fires and adult mode is off: no catalog search, no classifier model, no pick',async()=>{
  const search=vi.fn(async()=>[]),turn=vi.fn(),models={turn} as any;
  const r=await new MediaRouter(routeOpts({search,models})).route({text,mode:'auto'}) as any;
  expect(r.picked).toBeNull();expect(r.alternatives).toEqual([]);
  expect(r.reason).toContain('Adult mode must be switched on');expect(r.reason).toContain('All subjects are fictional adults');
  expect(r.adult).toMatchObject({active:false,detected:true,refusal:'needs_adult_mode'});
  expect(search).not.toHaveBeenCalled();expect(turn).not.toHaveBeenCalled();
 });
 it('asks for the attestation when adult mode is on without it, and still sends nothing',async()=>{
  const search=vi.fn(async()=>[]);
  const r=await new MediaRouter(routeOpts({search})).route({text,mode:'image',adult:true,style:'photoreal'}) as any;
  expect(r.picked).toBeNull();expect(r.reason).toContain('All subjects are fictional adults');expect(r.adult.refusal).toBe('not_fictional');expect(search).not.toHaveBeenCalled();
 });
 it('never lets the model classifier see an adult brief',async()=>{
  const turn=vi.fn(()=>{throw new Error('the classifier model must not run for an adult brief');}),models={turn} as any;
  const r=await new MediaRouter(routeOpts({models})).route({text:'a pink flower '+MARKER,mode:'auto',adult:true,fictional:true,style:'photoreal',probe:false}) as any;
  expect(turn).not.toHaveBeenCalled();expect(r.picked.id).toBe(ROUTER);
 });
 it('refuses a minors-indicating brief locally with a clear message and no catalog call',async()=>{
  const search=vi.fn(async()=>[]);
  const r=await new MediaRouter(routeOpts({search})).route({text:MARKER+' a child at the beach',mode:'image',adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked).toBeNull();expect(r.adult.refusal).toBe('minor');expect(r.reason).toMatch(/under 18|minor/i);expect(search).not.toHaveBeenCalled();
 });
 it('refuses an obvious real-person brief locally',async()=>{
  const r=await new MediaRouter(routeOpts()).route({text:MARKER+' a photo of my ex',mode:'image',adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked).toBeNull();expect(r.adult.refusal).toBe('real_person');expect(r.reason).toMatch(/real people|real person/i);
 });
 it('does not touch an ordinary brief: same pick, same request, nothing excluded for adult reasons',async()=>{
  const r=await new MediaRouter(routeOpts({callKinds:undefined})).route({text:'a red fox in a snowy pine forest at dawn, photorealistic',mode:'image',classifier:false,probe:false}) as any;
  expect(r.adult).toBeUndefined();
  expect(r.picked.request.arguments).toEqual({prompt:'a red fox in a snowy pine forest at dawn, photorealistic',wait:false,style:'photoreal'});
  expect(r.alternatives.length).toBeGreaterThan(0);
  expect(JSON.stringify(r.excluded)).not.toMatch(/adult/i);
 });
 it('validates the new fields',async()=>{
  const router=new MediaRouter(routeOpts());
  for(const bad of [{adult:'yes'},{fictional:1},{style:'general'},{style:7}])await expect(router.route({text:'x',...bad}),JSON.stringify(bad)).rejects.toMatchObject({status:400});
 });
 it('says plainly that adult mode has no on-prem audio or edit tool, rather than ranking a cloud one',async()=>{
  const r=await new MediaRouter(routeOpts()).route({text:MARKER+' a slow song',mode:'music',adult:true,fictional:true,style:'photoreal',probe:false}) as any;
  expect(r.picked).toBeNull();expect(r.reason).toMatch(/on-prem/);expect(r.reason).toMatch(/music/);
 });
});

describe('regression: 2026-11-06 adult brief ranked onto Seedream',()=>{
 const text=MARKER+' an invented woman posing on a bed';
 it('with Together runnable, the adult brief still picks the on-prem router and Seedream is listed as excluded',async()=>{
  // The incident precondition: unrestricted, Seedream outranks the on-prem router for this brief.
  const ids=rankCandidates('image',snapshot,{text:'a woman on a bed',callKinds}).candidates.map(c=>c.id);
  expect(ids.indexOf(SEEDREAM)).toBeGreaterThanOrEqual(0);expect(ids.indexOf(SEEDREAM)).toBeLessThan(ids.indexOf(ROUTER));
  const r=await new MediaRouter(routeOpts()).route({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked.id).toBe(ROUTER);
  expect(r.excluded.map((x:any)=>x.id)).toContain(SEEDREAM);
  expect([r.picked,...r.alternatives].map((p:any)=>p.id)).toEqual([ROUTER]);
 });
 it('when the on-prem tool is not usable (orphaned, as the registry prober marks it), nothing else is picked and the reason says so',async()=>{
  const down=snapshot.map(c=>c.id===ROUTER?{...c,health:'orphaned'}:c);
  const r=await new MediaRouter(routeOpts({catalog:()=>down})).route({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked).toBeNull();expect(r.alternatives).toEqual([]);
  expect(r.reason).toMatch(/adult/i);expect(r.reason).toMatch(/on-prem/i);
  expect(r.excluded.find((x:any)=>x.id===ROUTER).reason).toMatch(/orphaned/);
  expect(r.excluded.find((x:any)=>x.id===SEEDREAM).reason).toMatch(/adult/i);
 });
 it('with the on-prem tool missing from the catalog altogether the answer is the same',async()=>{
  const gone=snapshot.filter(c=>c.id!==ROUTER);
  const r=await new MediaRouter(routeOpts({catalog:()=>gone})).route({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked).toBeNull();expect(r.alternatives).toEqual([]);expect(r.reason).toMatch(/on-prem/i);
 });
 it('the hub routes the same way end to end (markers reach the router it builds)',async()=>{
  const {hub}=hubWith(async()=>({}),{catalog:snapshot});
  const r=await hub.mediaRoute({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked?.id).toBe(ROUTER);
  const off=await hub.mediaRoute({text,mode:'image',classifier:false,probe:false}) as any;
  expect(off.picked).toBeNull();expect(off.reason).toContain('Adult mode must be switched on');
 });
});

describe('prepare is the server-side gate for every path (Auto, manual pick, edited JSON)',()=>{
 it('refuses an adult brief on a cloud capability, before any call to the gate',async()=>{
  const {hub,sdk}=hubWith(async()=>({}));
  await expect(prepare(hub,SEEDREAM,{command:'call',prompt:MARKER+' a woman at the beach'})).rejects.toThrow(/on-prem media router/);
  await expect(prepare(hub,SEEDREAM,{command:'call',options:{prompt:MARKER+' a woman'}})).rejects.toThrow(/on-prem media router/);
  expect(sdk.read).not.toHaveBeenCalled();expect(sdk.invoke).not.toHaveBeenCalled();
 });
 it('refuses an explicit adult flag on any non-router capability, even with an ordinary brief',async()=>{
  const {hub,sdk}=hubWith(async()=>({}));
  for(const flag of [{nsfw:true},{adult:true},{content_class:'adult_explicit'},{options:{nsfw:true}}])
   await expect(prepare(hub,SEEDREAM,{command:'call',prompt:'a red fox',...flag}),JSON.stringify(flag)).rejects.toThrow(/on-prem media router/);
  expect(sdk.read).not.toHaveBeenCalled();
 });
 it('refuses the router itself when adult mode or the attestation is missing',async()=>{
  const {hub,sdk}=hubWith(async()=>({}));
  await expect(prepare(hub,ROUTER,{prompt:MARKER+' a woman',wait:false})).rejects.toThrow(/Adult mode must be switched on/);
  await expect(prepare(hub,ROUTER,{prompt:MARKER+' a woman',nsfw:true,wait:false})).rejects.toThrow(/All subjects are fictional adults/);
  await expect(prepare(hub,ROUTER,{prompt:'a quiet beach',adult:true,wait:false})).rejects.toThrow(/All subjects are fictional adults/);
  expect(sdk.read).not.toHaveBeenCalled();
 });
 it('refuses a minors-indicating or real-person adult request before any call',async()=>{
  const {hub,sdk}=hubWith(async()=>({}));
  await expect(prepare(hub,ROUTER,adultArgs({prompt:MARKER+' a teenager'}))).rejects.toThrow(/under 18/);
  await expect(prepare(hub,ROUTER,adultArgs({prompt:MARKER+' a deepfake'}))).rejects.toThrow(/real people|real person/i);
  expect(sdk.read).not.toHaveBeenCalled();
 });
 it('takes no reference uploads in adult mode: an uploaded picture can show a real person',async()=>{
  const {hub,sdk}=hubWith(async()=>({}));
  await expect(prepare(hub,ROUTER,adultArgs({inputs:[{upload_id:'upl_'+'a'.repeat(32),role:'reference'}]}))).rejects.toThrow(/reference uploads/);
  expect(sdk.read).not.toHaveBeenCalled();
  expect((await prepare(hub,ROUTER,adultArgs({inputs:[]}))).request.arguments.nsfw).toBe(true);
 });
 it('tells the user how to get an adult brief onto the router when a manual pick is not on it',async()=>{
  const {hub}=hubWith(async()=>({}));
  await expect(prepare(hub,SEEDREAM,{command:'call',prompt:MARKER+' a woman'})).rejects.toThrow(/Adult mode/);
 });
 it('issues the ticket for an attested adult request and pins it to TEMPER in the reviewed request',async()=>{
  const {hub}=hubWith(async()=>({}));
  const t=await prepare(hub,ROUTER,adultArgs());
  expect(t.request.arguments).toMatchObject({nsfw:true,subjects_fictional:true,style:'photoreal',node:'temper'});
  await expect(prepare(hub,ROUTER,adultArgs({node:'forge'}))).rejects.toThrow(/TEMPER/);
  expect((await prepare(hub,ROUTER,adultArgs({node:'temper'}))).request.arguments.node).toBe('temper');
 });
 it('leaves an ordinary request on any capability exactly as before',async()=>{
  const {hub}=hubWith(async()=>({}));
  const cloud=await prepare(hub,SEEDREAM,{command:'call',prompt:'a red fox in the snow'});
  expect(cloud.request.arguments).toEqual({command:'call',prompt:'a red fox in the snow'});
  const onprem=await prepare(hub,ROUTER,{prompt:'a red fox',wait:false});
  expect(onprem.request.arguments).toEqual({prompt:'a red fox',wait:false});
  const tool=await prepare(hub,'echo.cartesia.tts',{text:'read this nsfw policy aloud'});
  expect(tool.request.arguments).toEqual({text:'read this nsfw policy aloud'});
 });
 it('does not gate a tool that is not a generator (a search for the word, for instance)',async()=>{
  const {hub}=hubWith(async()=>({}),{catalog:[cap('echo.acme.search',{category:'tools',description:'web search'})]});
  const t=await prepare(hub,'echo.acme.search',{query:'nsfw filter policy'});
  expect(t.request.arguments).toEqual({query:'nsfw filter policy'});
 });
});

describe('honest results',()=>{
 const img=png(16,12);
 it('follows an attested adult job queued -> running -> done, stores the PNG, and reports the model that really ran and where',async()=>{
  const out=tmp('prime-adult-out-');writeFileSync(join(out,'image_abc.png'),img);
  const clock=fakeClock(),statuses=['queued','running','done'];
  const {hub,sdk,uploads}=hubWith(async(request:any)=>{
   if(request.capability===ROUTER)return {ok:true,job_id:'abc123',status:'queued',node:'temper',model:'illustrious-xl-v0.1',backend:'comfyui',nsfw_capable:true,adult:true};
   const status=statuses.shift()!;
   return {ok:true,job_id:'abc123',status,node:'temper',model:'illustrious-xl-v0.1',backend:'comfyui',...(status==='done'?{path:join(out,'image_abc.png'),ext:'png',bytes:img.length}:{})};
  },{clock,config:{localRoots:[out]}});
  const r=await run(hub,ROUTER,adultArgs());
  expect(r).toMatchObject({state:'returned',media:{type:'image/png',width:16,height:12},job:{providerJobId:'abc123',polls:3,statusCapability:'echo.media.job_status'},
   used:{model:'illustrious-xl-v0.1',node:'temper',backend:'comfyui'}});
  expect(sdk.invoke.mock.calls.map((c:any)=>c[0].capability)).toEqual([ROUTER,'echo.media.job_status','echo.media.job_status','echo.media.job_status']);
  expect(sdk.invoke.mock.calls[0][0].params).toEqual(adultArgs({node:'temper'}));
  expect(await uploads.get('owner-1',r.media.uploadId)).toMatchObject({type:'image/png'});
 });
 it('keeps the model the router named at submit even when its status answers omit it (an older router)',async()=>{
  const out=tmp('prime-adult-out3-');writeFileSync(join(out,'image_x.png'),img);
  const clock=fakeClock(),statuses=['running','done'];
  const {hub}=hubWith(async(request:any)=>{
   if(request.capability===ROUTER)return {ok:true,job_id:'x1',status:'queued',node:'temper',model:'illustrious-xl-v0.1',backend:'comfyui'};
   const status=statuses.shift()!;return {ok:true,job_id:'x1',status,...(status==='done'?{path:join(out,'image_x.png')}:{})};
  },{clock,config:{localRoots:[out]}});
  const r=await run(hub,ROUTER,adultArgs());
  expect(r.state).toBe('returned');expect(r.used).toEqual({model:'illustrious-xl-v0.1',node:'temper',backend:'comfyui'});
 });
 it('passes a router explanation about missing adult-capable models through verbatim and tries nothing else',async()=>{
  const said="no live nsfw-capable on-prem image model for style 'anime'; available nsfw-capable styles: photoreal";
  const {hub,sdk}=hubWith(async()=>({ok:false,error:said}));
  const r=await run(hub,ROUTER,adultArgs({style:'anime'}));
  expect(r.state).toBe('blocked');expect(r.detail).toContain(said);
  expect(sdk.invoke).toHaveBeenCalledTimes(1);
 });
 it('passes the router busy answer through verbatim, with its retry time, and does not retry',async()=>{
  const said='busy, try again in ~30s: creative lease held (job abc); 1 job(s) waiting';
  const {hub,sdk}=hubWith(async()=>({ok:false,error:said}));
  const r=await run(hub,ROUTER,adultArgs());
  expect(r.state).toBe('blocked');expect(r.detail).toContain(said);expect(sdk.invoke).toHaveBeenCalledTimes(1);
 });
 it('passes a refusal the router raises mid-job through verbatim',async()=>{
  const said='refused: an adult request must declare its subjects are fictional (set subjects_fictional=true); real identifiable people are never generated';
  const clock=fakeClock();
  const {hub,sdk}=hubWith(async(request:any)=>request.capability===ROUTER?{ok:true,job_id:'j1',status:'queued'}:{ok:false,job_id:'j1',status:'failed',error:said,busy:false},{clock});
  const r=await run(hub,ROUTER,adultArgs());
  expect(r.state).toBe('blocked');expect(r.detail).toContain(said);
  expect(sdk.invoke.mock.calls.every((c:any)=>['echo.media.image_generate','echo.media.job_status'].includes(c[0].capability))).toBe(true);
 });
 it('never records an adult-policy refusal against the on-prem tool, so ordinary briefs are not demoted for it',async()=>{
  const {hub}=hubWith(async()=>({ok:false,error:"no live nsfw-capable on-prem image model for style 'anime'; available nsfw-capable styles: photoreal"}));
  await run(hub,ROUTER,adultArgs({style:'anime'}));
  expect(hub.outcomes().last(ROUTER)).toBeUndefined();
  const {hub:plain}=hubWith(async()=>({ok:false,error:'ComfyUI ran out of memory'}));
  await run(plain,ROUTER,{prompt:'a fox',wait:false});
  expect(plain.outcomes().last(ROUTER)).toBeDefined();
 });
 it('says which model ran even for an ordinary request, and names an unknown node as it is',async()=>{
  const out=tmp('prime-adult-out2-');writeFileSync(join(out,'a.png'),img);
  const {hub}=hubWith(async()=>({ok:true,status:'done',node:'forge',model:'juggernaut',backend:'diffusers',path:join(out,'a.png')}),{config:{localRoots:[out]}});
  const r=await run(hub,ROUTER,{prompt:'a fox',wait:false});
  expect(r.used).toEqual({model:'juggernaut',node:'forge',backend:'diffusers'});
  const {hub:h2}=hubWith(async()=>({ok:true,note:'nothing'}),{catalog:[cap('echo.cartesia.tts',{category:'voice'})]});
  expect((await run(h2,'echo.cartesia.tts',{text:'hi'})).used).toBeUndefined();
 });
});

describe('enhance never sends an adult brief to a cloud model',()=>{
 it('refuses before any model turn, and lets an ordinary prompt reach the model',async()=>{
  const turn=vi.fn(()=>{throw new Error('SENTINEL: reached the model');});
  const enhancer=new PromptEnhancer({turn,defaultId:'claude',config:{}} as any,{adultMarkers:markers} as any);
  await expect(enhancer.enhance({mode:'image',text:MARKER+' a woman at the beach',provider:'claude'},'s1')).rejects.toMatchObject({status:400,message:expect.stringContaining('cloud')});
  await expect(enhancer.enhance({mode:'auto',text:MARKER+' a woman at the beach',provider:'claude'},'s1')).rejects.toMatchObject({status:400});
  expect(turn).not.toHaveBeenCalled();
  await expect(enhancer.enhance({mode:'image',text:'a red fox at dawn',provider:'claude'},'s1')).rejects.toThrow(/SENTINEL/);
  expect(turn).toHaveBeenCalledTimes(1);
 });
});
