/* eslint-disable @typescript-eslint/no-explicit-any -- focused SDK stand-ins */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {PrimeHub, type Capability, type SdkBroker} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {UploadStore, parseUploadsConfig} from '../src/prime/uploads.js';
import {DEFAULT_GATE_CALL_KINDS, MediaCollector, defaultMediaConfig, findMedia, parseMediaConfig, sniffType, type MediaConfig} from '../src/prime/media-collect.js';
import {MediaOutcomes, classifyOutcome} from '../src/prime/media-outcomes.js';
import {MediaRouter, executability} from '../src/prime/media.js';

const dirs:string[]=[],servers:Array<{close:()=>Promise<void>|void}>=[];
afterEach(async()=>{for(const s of servers.splice(0).reverse())await s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const tmp=(prefix:string)=>{const d=mkdtempSync(join(tmpdir(),prefix));dirs.push(d);return d;};
function crc32(buf:Buffer){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(c&1?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type:string,data:Buffer){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii'),crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);}
function png(w=8,h=6){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc(h*(1+w*4),120);for(let y=0;y<h;y++)raw[y*(1+w*4)]=0;return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const mp3=()=>Buffer.concat([Buffer.from('ID3'),Buffer.from([4,0,0,0,0,0,0]),Buffer.alloc(256,7)]);
const cap=(id:string,extra:Partial<Capability>={}):Capability=>({id,registered:true,health:'green',category:'image',description:'generator',...extra});
async function serve(handler:Parameters<typeof createServer>[1]){const s:Server=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',()=>r()));servers.push({close:()=>new Promise<void>(r=>s.close(()=>r()))});return 'http://127.0.0.1:'+(s.address() as {port:number}).port;}
function fakeClock(){let now=Date.parse('2026-11-06T12:00:00Z');return {now:()=>now,sleep:async(ms:number)=>{now+=ms;},advance:(ms:number)=>{now+=ms;}};}
function hubWith(invoke:(request:any,options?:any)=>Promise<unknown>,extra:{config?:Partial<MediaConfig>;catalog?:Capability[];clock?:ReturnType<typeof fakeClock>;fetch?:typeof fetch}={}){
 const root=tmp('prime-media-up-'),uploads=new UploadStore(parseUploadsConfig({root}));
 const sdk={search:vi.fn(async()=>[]),read:vi.fn(async(id:string)=>({registration_state:'registered',health_status:'green',capability:{id}})),invoke:vi.fn(invoke)} as unknown as SdkBroker&{invoke:ReturnType<typeof vi.fn>};
 const hub=new PrimeHub({capabilities:extra.catalog??[cap('echo.cartesia.tts',{category:'voice',description:'Cartesia TTS'}),cap('echo.media.image_generate',{description:'Routed on-prem text-to-image ($0).'})],sdk,uploads,uploadsOwner:'owner-1',
  mediaConfig:{...defaultMediaConfig(),...extra.config},mediaClock:extra.clock,mediaFetch:extra.fetch});
 return {hub,sdk,uploads};
}
async function run(hub:PrimeHub,name:string,args:Record<string,unknown>){const t=await hub.prepare({target:'sdk',name,arguments:args});return hub.execute(t.id,t.digest) as Promise<any>;}

describe('execution outcomes',()=>{
 it.each([
  ['blocked',"unsupported call_kind 'together_image_generation'",'unsupported'],
  ['blocked','HTTP 402: Insufficient credits. This account never purchased credits.','billing'],
  ['blocked','Claude (claude CLI) is unavailable: Failed to authenticate: OAuth session expired','auth'],
  ['blocked','Scope required: llm.invoke','auth'],
  ['blocked',"{\"error\":\"input_schema_validation_failed\",\"message\":\"'text' is a required property\"}",'schema'],
  ['blocked','SDK gate HTTP 502','transient'],
  ['uncertain','connection dropped','unknown'],
  ['returned','','ok'],
 ])('classifies %s "%s" as %s',(state,detail,category)=>expect(classifyOutcome(state,detail).category).toBe(category));
 it('learns call kinds both ways, demotes billing provider-wide until that tool succeeds, and persists bounded state',async()=>{
  const dir=tmp('prime-outcomes-'),file=join(dir,'nested','outcomes.json');let now=1_000_000;
  const o=new MediaOutcomes({file,now:()=>now,maxCaps:3});
  o.record({cap:'echo.llm.together.ByteDance-Seed-Seedream-4.0',provider:'Together AI',state:'blocked',detail:"unsupported call_kind 'together_image_generation'"});
  expect(o.callKind('together_image_generation')).toMatchObject({supported:false,cap:'echo.llm.together.ByteDance-Seed-Seedream-4.0'});
  o.record({cap:'echo.llm.openrouter.google-gemini-2.5-flash-image',provider:'OpenRouter',state:'blocked',detail:'HTTP 402: Insufficient credits'});
  expect(o.demotion('echo.llm.openrouter.google-gemini-2.5-flash-image','OpenRouter')).toMatchObject({weight:0.2,category:'billing',own:true});
  expect(o.demotion('echo.llm.openrouter.google-gemini-3-pro-image','OpenRouter')).toMatchObject({category:'billing',own:false,reason:expect.stringContaining('same account')});
  now+=1000;o.record({cap:'echo.llm.openrouter.google-gemini-3-pro-image',provider:'OpenRouter',state:'returned'});
  expect(o.demotion('echo.llm.openrouter.google-gemini-3-pro-image','OpenRouter')).toBeUndefined();
  o.record({cap:'echo.x.one',provider:'X',state:'returned',callKind:'together_image_generation'});
  expect(o.callKind('together_image_generation')).toMatchObject({supported:true});
  expect(o.snapshot().caps).toHaveLength(3);
  await o.flush();
  const stored=JSON.parse(readFileSync(file,'utf8'));expect(stored.caps).toHaveLength(3);expect(JSON.stringify(stored)).not.toContain('prompt');
  const reloaded=new MediaOutcomes({file,now:()=>now});expect(reloaded.callKind('together_image_generation')).toMatchObject({supported:true});
  now+=13*3600_000;expect(new MediaOutcomes({file,now:()=>now}).demotion('echo.llm.openrouter.google-gemini-2.5-flash-image','OpenRouter')).toMatchObject({category:'billing'});
  now+=12*3600_000;expect(new MediaOutcomes({file,now:()=>now}).demotion('echo.llm.openrouter.google-gemini-2.5-flash-image','OpenRouter')).toBeUndefined();
 });
 it('excludes call kinds the gate cannot run, and readmits one once a run of it succeeds',()=>{
  const seedream={id:'echo.llm.together.ByteDance-Seed-Seedream-4.0',description:'type=image; call_kind=together_image_generation.'};
  expect(executability(seedream,['openai_compat'])).toContain('together_image_generation is not one the SDK gate runs');
  const o=new MediaOutcomes();o.record({cap:'echo.llm.together.other',provider:'Together AI',state:'returned',callKind:'together_image_generation'});
  expect(executability(seedream,['openai_compat'],o)).toBeUndefined();
  o.record({cap:seedream.id,provider:'Together AI',state:'blocked',detail:"unsupported call_kind 'together_image_generation'"});
  expect(executability(seedream,['openai_compat','together_image_generation'],o)).toContain('answered "unsupported call_kind');
  expect(executability({id:'echo.media.image_generate',description:'on-prem'},['openai_compat'])).toBeUndefined();
 });
 it('offers the runnable on-prem image tool for the live-test fox brief, and says why the Together and OpenRouter image caps are out',async()=>{
  const snapshot=(JSON.parse(readFileSync(new URL('../ui/echo-prime/catalog.json',import.meta.url),'utf8')) as {capabilities:Capability[]}).capabilities;
  const text='A red fox standing in a snowy pine forest at dawn, photorealistic';
  const r=await new MediaRouter({catalog:()=>snapshot}).route({text,mode:'image',classifier:false,probe:false});
  expect(r.picked!.id).toBe('echo.media.image_generate');
  expect(r.picked!.request.arguments).toEqual({prompt:text,wait:false,style:'photoreal'});
  expect(r.excluded.find(x=>x.id==='echo.llm.openrouter.google-gemini-2.5-flash-image')!.reason).toContain('chat path');
  expect(r.excluded.find(x=>x.id==='echo.llm.together.ByteDance-Seed-Seedream-4.0')!.reason).toContain('together_image_generation');
  expect(r.excluded.filter(x=>x.reason.includes('together_image_generation')).length).toBeGreaterThan(10);
  // Whichever tools end up runnable: once the gate runs Together images (config, or one successful run), they rank again.
  const later=await new MediaRouter({catalog:()=>snapshot,callKinds:[...DEFAULT_GATE_CALL_KINDS,'together_image_generation']}).route({text,mode:'image',classifier:false,probe:false});
  expect([later.picked!.id,...later.alternatives.map(a=>a.id)]).toContain('echo.llm.together.ByteDance-Seed-Seedream-4.0');
  const learned=new MediaOutcomes();learned.record({cap:'echo.llm.together.black-forest-labs-FLUX.2-max',provider:'Together AI',state:'returned',callKind:'together_image_generation'});
  const viaOutcome=await new MediaRouter({catalog:()=>snapshot,outcomes:learned}).route({text,mode:'image',classifier:false,probe:false});
  expect([viaOutcome.picked!.id,...viaOutcome.alternatives.map(a=>a.id)].some(id=>id.startsWith('echo.llm.together.'))).toBe(true);
 });
 it('demotes every tool of a provider after a billing refusal and shows the reason on the alternatives',async()=>{
  const catalog=()=>[cap('echo.acme.image_alpha',{description:'text-to-image'}),cap('echo.acme.image_beta',{description:'text-to-image'}),cap('echo.zeta.image_one',{description:'text-to-image',health:'amber'})];
  const outcomes=new MediaOutcomes();
  const before=await new MediaRouter({catalog,outcomes}).route({text:'a fox',mode:'image',classifier:false,probe:false});
  expect(before.picked!.provider).toBe('acme');
  outcomes.record({cap:before.picked!.id,provider:'acme',state:'blocked',detail:'HTTP 402: Insufficient credits'});
  const after=await new MediaRouter({catalog,outcomes}).route({text:'a fox',mode:'image',classifier:false,probe:false});
  expect(after.picked!.id).toBe('echo.zeta.image_one');
  const acme=after.alternatives.filter(a=>a.provider==='acme');
  expect(acme).toHaveLength(2);
  for(const a of acme){expect(a.demoted).toMatchObject({category:'billing'});expect(a.reason).toContain('ranked lower');}
  expect(acme.map(a=>a.reason).join(' ')).toContain('same account');
 });
 it('reads argument shapes live for the pick and the alternatives and words a snapshot-only record honestly',async()=>{
  const read=vi.fn(async(id:string)=>({registration_state:'registered',health_status:'green',capability:{id,handler_kind:'http',args_mode:'json_body',params:[{name:'text',required:true}]}}));
  const r=await new MediaRouter({catalog:()=>[cap('echo.acme.narrate',{category:'voice',description:'text-to-speech'})],read,search:async()=>[]}).route({text:'say hello',mode:'voice',classifier:false});
  expect(r.picked).toMatchObject({id:'echo.acme.narrate',argumentShape:'modeled',request:{arguments:{text:'say hello'}},template:{envelope:'flat',textKey:'text',source:'registry'}});
  expect(r.picked!.reason).toContain('its registry record was read live');expect(r.picked!.reason).not.toContain('shipped snapshot record');
 });
 it('takes the Studio length control over the brief and refuses an out-of-range length',async()=>{
  const r=await new MediaRouter({catalog:()=>[cap('echo.elevenlabs.music_generation.generate',{category:'music',description:'compose music'})]}).route({text:'a 20 second synthwave intro',mode:'music',probe:false,durationSeconds:45});
  expect(r.classification.durationSeconds).toBe(45);expect(r.picked!.request.arguments).toEqual({prompt:'a 20 second synthwave intro',music_length_ms:45000});
  await expect(new MediaRouter({catalog:()=>[]}).route({text:'x',durationSeconds:0})).rejects.toMatchObject({status:400});
 });
});

describe('media collection',()=>{
 it('finds inline data first, then a local path, then a link, through nested provider bodies',()=>{
  const found=findMedia({ok:true,result:{audio_url:'/cartesia/audio/a.mp3',path:'/srv/out/a.mp3',data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAA'}]}});
  expect(found.map(f=>f.kind)).toEqual(['base64','path','url']);
  expect(findMedia({outputs:{video_url:'https://api.together.ai/shrt/x'}})[0]).toMatchObject({kind:'url',key:'video_url'});
  expect(findMedia({ok:true,model:'fal-ai/flux/schnell',image_urls:['https://v3.fal.media/files/a.png']})[0]).toMatchObject({kind:'url',key:'image_urls',url:'https://v3.fal.media/files/a.png'});
  expect(findMedia({image:'data:image/png;base64,'+png().toString('base64')})).toEqual([]);
  expect(findMedia({url:'data:image/png;base64,'+png().toString('base64')})[0]).toMatchObject({kind:'base64',type:'image/png'});
  expect(sniffType(png())).toBe('image/png');expect(sniffType(mp3())).toBe('audio/mpeg');expect(sniffType(Buffer.from('<html>'))).toBeUndefined();
 });
 it('reads a local file only under media.localRoots and refuses traversal, other types and missing roots',async()=>{
  const root=tmp('prime-media-out-'),out=join(root,'out');mkdirSync(out);writeFileSync(join(out,'image_1.png'),png());writeFileSync(join(root,'secret.png'),png());writeFileSync(join(out,'fake.png'),Buffer.from('#!/bin/sh\necho hi\n'));
  const collector=new MediaCollector({config:{...defaultMediaConfig(),localRoots:[out]}});
  await expect(collector.collect('echo.media.image_generate',{path:join(out,'image_1.png')})).resolves.toMatchObject({type:'image/png',source:'path'});
  await expect(collector.collect('echo.media.image_generate',{path:join(out,'..','secret.png')})).rejects.toThrow(/outside media.localRoots/);
  await expect(collector.collect('echo.media.image_generate',{path:join(out,'fake.png')})).rejects.toThrow(/not an image, video or audio/);
  await expect(new MediaCollector({config:defaultMediaConfig()}).collect('echo.media.image_generate',{path:join(out,'image_1.png')})).rejects.toThrow(/media.localRoots names no directory/);
 });
 it('resolves a relative link against the loopback origin mapped to the capability, and refuses unmapped, foreign and wrong-typed links',async()=>{
  const origin=await serve((req,res)=>{
   if(req.url==='/cartesia/audio/a.mp3'){res.writeHead(200,{'content-type':'audio/mpeg'});res.end(mp3());return;}
   if(req.url==='/page'){res.writeHead(200,{'content-type':'text/html'});res.end('<html></html>');return;}
   if(req.url==='/hop'){res.writeHead(302,{location:'https://evil.example.com/a.mp3'});res.end();return;}
   res.writeHead(404);res.end();
  });
  const config={...defaultMediaConfig(),origins:[{prefix:'echo.cartesia.',origin}]};
  const collector=new MediaCollector({config});
  await expect(collector.collect('echo.cartesia.tts',{ok:true,audio_url:'/cartesia/audio/a.mp3'})).resolves.toMatchObject({type:'audio/mpeg',source:'url'});
  await expect(collector.collect('echo.elevenlabs.tts',{audio_url:'/cartesia/audio/a.mp3'})).rejects.toThrow(/media.origins maps no origin/);
  await expect(collector.collect('echo.cartesia.tts',{url:origin+'/page'})).rejects.toThrow(/text\/html/);
  await expect(collector.collect('echo.cartesia.tts',{url:origin+'/hop'})).rejects.toThrow(/evil.example.com is not in media.fetchHosts/);
  await expect(collector.collect('echo.cartesia.tts',{url:'https://cdn.example.net/a.mp3'})).rejects.toThrow(/not in media.fetchHosts/);
  await expect(new MediaCollector({config,maxBytes:64}).collect('echo.cartesia.tts',{audio_url:'/cartesia/audio/a.mp3'})).rejects.toThrow(/media limit/);
 });
 it('refuses base64 whose bytes are another medium than declared',async()=>{
  await expect(new MediaCollector({config:defaultMediaConfig()}).collect('echo.x.y',{audio_base64:png().toString('base64'),content_type:'audio/mpeg'})).rejects.toThrow(/says audio\/mpeg but its bytes are image\/png/);
 });
 it('parses the media section strictly',()=>{
  expect(parseMediaConfig(undefined)).toMatchObject({inlineMs:20000,jobWallMs:900000,gateCallKinds:expect.arrayContaining(['openai_compat','vertex_generate'])});
  expect(parseMediaConfig({origins:[{prefix:'echo.voice.',origin:'http://anvil:9000'},{prefix:'echo.x.',origin:'http://100.99.78.44:9000'},{prefix:'echo.y.',origin:'http://192.168.1.49:9000'}]}).origins).toHaveLength(3);
  expect(parseMediaConfig({localRoots:['/home/forge/echo-media/out'],origins:[{prefix:'echo.cartesia.',origin:'http://127.0.0.1:8302'}],invokeTimeoutsMs:{video:600000},gateCallKinds:['openai_compat','together_image_generation']})).toMatchObject({invokeTimeoutsMs:{video:600000,image:180000},gateCallKinds:['openai_compat','together_image_generation']});
  for(const bad of [{nope:1},{origins:[{prefix:'echo.x.',origin:'http://8.8.8.8:80'}]},{origins:[{prefix:'echo.x.',origin:'http://cdn.example.com:80'}]},{origins:[{prefix:'x',origin:'http://127.0.0.1:1'}]},{localRoots:['relative/dir']},{localRoots:['/']},{inlineMs:95000},{invokeTimeoutsMs:{bogus:1000}},{fetchHosts:['http://x']}])expect(()=>parseMediaConfig(bad),JSON.stringify(bad)).toThrow();
 });
});

describe('Studio executions as server-side jobs',()=>{
 it('stores a returned audio file as an upload and a Library artifact titled with the actual prompt, with the per-kind wait',async()=>{
  const origin=await serve((req,res)=>{res.writeHead(200,{'content-type':'audio/mpeg'});res.end(mp3());});
  const {hub,sdk,uploads}=hubWith(async()=>({ok:true,file:'a.mp3',audio_url:'/cartesia/audio/a.mp3',path:'/home/forge/echo-integrations/audio/a.mp3',bytes:263}),{config:{origins:[{prefix:'echo.cartesia.',origin}]}});
  const r=await run(hub,'echo.cartesia.tts',{text:'Hello Commander, Echo Prime is online.'});
  expect(r).toMatchObject({state:'returned',kind:'voice',media:{type:'audio/mpeg',kind:'audio',url:expect.stringMatching(/^\/api\/prime\/uploads\/upl_[0-9a-f]{32}\/file$/),artifactId:expect.stringMatching(/^art_/)},job:{phase:'done',followable:true}});
  expect(sdk.invoke.mock.calls[0][1]).toEqual({timeoutMs:90000});
  const art=await uploads.getArtifact('owner-1',r.media.artifactId);
  expect(art).toMatchObject({kind:'voice',upload_id:r.media.uploadId,title:'Cartesia TTS: Hello Commander, Echo Prime is online.',provenance:{source:'studio',capability:'echo.cartesia.tts',prompt:'Hello Commander, Echo Prime is online.'}});
  expect(hub.outcomes().last('echo.cartesia.tts')).toMatchObject({category:'ok'});
 });
 it('stores ElevenLabs inline audio from the op router and keeps only the compact answer, not the base64 body',async()=>{
  const audio=Buffer.concat([mp3(),Buffer.alloc(6000,9)]);
  const {hub}=hubWith(async()=>({status:'ok',capability:'echo.elevenlabs.sound_generation.sound_generation',content_type:'audio/mpeg',bytes:audio.length,audio_base64:audio.toString('base64')}),
   {catalog:[cap('echo.elevenlabs.sound_generation.sound_generation',{category:'sound',description:'text -> sound effect'})]});
  const r=await run(hub,'echo.elevenlabs.sound_generation.sound_generation',{text:'thunder rolling across distant mountains',duration_seconds:5});
  expect(r).toMatchObject({state:'returned',kind:'sfx',media:{type:'audio/mpeg',bytes:audio.length}});
  expect(r.result.audio_base64).toMatch(/^\[\d+ characters of base64/);
  expect(JSON.stringify(hub.mediaJob({requestId:r.requestId})).length).toBeLessThan(3000);
 });
 it('follows an on-prem image job through echo.media.job_status with backoff and stores the PNG from the media out directory',async()=>{
  const out=tmp('prime-media-jobs-');writeFileSync(join(out,'image_abc.png'),png(16,12));
  const clock=fakeClock(),statuses=['queued','running','done'];
  const {hub,sdk}=hubWith(async(request:any)=>{
   if(request.capability==='echo.media.image_generate')return {ok:true,job_id:'abc123',status:'queued',node:'temper'};
   const status=statuses.shift()!;return {ok:true,job_id:'abc123',status,...(status==='done'?{path:join(out,'image_abc.png'),ext:'png',bytes:1}:{})};
  },{clock,config:{localRoots:[out]}});
  const r=await run(hub,'echo.media.image_generate',{prompt:'a red fox',wait:false});
  expect(r).toMatchObject({state:'returned',media:{type:'image/png',width:16,height:12},job:{providerJobId:'abc123',providerStatus:'done',polls:3,statusCapability:'echo.media.job_status'}});
  const polls=sdk.invoke.mock.calls.filter((c:any)=>c[0].capability==='echo.media.job_status');
  expect(polls.map((c:any)=>c[0].params)).toEqual([{job_id:'abc123'},{job_id:'abc123'},{job_id:'abc123'}]);
  expect(polls[0][0].idempotency_key).toBe(r.requestId+':status:1');
 });
 it('answers "running" after the inline window and serves the finished result by request id',async()=>{
  let finish:(v:unknown)=>void=()=>{};
  const {hub}=hubWith(()=>new Promise(resolve=>{finish=resolve;}),{config:{inlineMs:20}});
  const r=await run(hub,'echo.cartesia.tts',{text:'hi'});
  expect(r).toMatchObject({state:'running',job:{phase:'invoking'}});
  expect(hub.mediaJob({requestId:r.requestId})).toMatchObject({state:'running'});
  finish({ok:true,note:'no file'});await hub.mediaJobSettled(r.requestId);
  expect(hub.mediaJob({requestId:r.requestId})).toMatchObject({state:'returned',mediaError:expect.stringContaining('without a media file')});
  expect(()=>hub.mediaJob({requestId:'00000000-0000-4000-8000-000000000000'})).toThrow(/No Studio request/);
 });
 it('says how to check a provider job Prime has no status reader for, instead of "outcome unknown"',async()=>{
  const {hub}=hubWith(async()=>({id:'vid_9',status:'queued'}),{catalog:[cap('echo.llm.together.openai-sora-2',{category:'video',description:'type=video; call_kind=together_video_generation.'})]});
  const r=await run(hub,'echo.llm.together.openai-sora-2',{command:'call',prompt:'boat',seconds:'5'});
  expect(r).toMatchObject({state:'submitted',job:{followable:false,providerJobId:'vid_9',howToCheck:expect.stringContaining('vid_9')}});
  expect(r.job.howToCheck).toContain(r.requestId);
 });
 it('stops following a job at the wall limit and says how to read it',async()=>{
  const clock=fakeClock();
  const {hub}=hubWith(async(request:any)=>request.capability==='echo.media.video_generate'?{ok:true,job_id:'v1',status:'queued'}:{ok:true,job_id:'v1',status:'running'},{clock,config:{jobWallMs:60000},catalog:[cap('echo.media.video_generate',{category:'video'})]});
  const r=await run(hub,'echo.media.video_generate',{prompt:'waves',wait:false});
  expect(r).toMatchObject({state:'uncertain',detail:expect.stringContaining('stopped following it')});
  expect(r.detail).toContain('job_id v1');
 });
 it('records a billing refusal (blocked) and an unknown outcome (uncertain) with the reason, never retrying',async()=>{
  const {hub,sdk}=hubWith(async(request:any)=>{if(request.capability==='echo.llm.openrouter.google-gemini-2.5-flash-image')return {ok:false,error:'HTTP 402: Insufficient credits. This account never purchased credits.'};throw new Error('MCP request timed out; outcome unknown');},
   {catalog:[cap('echo.llm.openrouter.google-gemini-2.5-flash-image'),cap('echo.cartesia.tts',{category:'voice'})]});
  const blocked=await run(hub,'echo.llm.openrouter.google-gemini-2.5-flash-image',{command:'call',prompt:'fox'});
  expect(blocked).toMatchObject({state:'blocked',detail:expect.stringContaining('402')});
  expect(hub.outcomes().last('echo.llm.openrouter.google-gemini-2.5-flash-image')).toMatchObject({category:'billing',provider:'OpenRouter'});
  const unknown=await run(hub,'echo.cartesia.tts',{text:'hi'});
  expect(unknown).toMatchObject({state:'uncertain',detail:expect.stringContaining(unknown.requestId)});
  expect(sdk.invoke).toHaveBeenCalledTimes(2);
 });
 it('serves job state on POST /api/prime/media/job to the Prime session only',async()=>{
  const {hub}=hubWith(async()=>({ok:true,note:'done'}));
  const dir=tmp('prime-media-srv-');writeFileSync(join(dir,'index.html'),'Prime');
  const server=await startPrimeServer(hub,dir,0);servers.push(server);
  const cookie=(await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const r=await run(hub,'echo.cartesia.tts',{text:'hi'});
  const post=(body:unknown,auth=true)=>fetch(server.url+'/api/prime/media/job',{method:'POST',headers:{...(auth?{cookie}:{}),origin:server.url,'content-type':'application/json','x-prime-request':'1'},body:JSON.stringify(body)});
  expect((await post({requestId:r.requestId},false)).status).toBe(403);
  const ok=await post({requestId:r.requestId});expect(ok.status).toBe(200);expect(await ok.json()).toMatchObject({state:'returned',requestId:r.requestId});
  expect((await post({requestId:'nope'})).status).toBe(404);
 });
});

describe('uploads ingest',()=>{
 it('stores generated bytes through the browser upload checks and refuses mislabelled bytes',async()=>{
  const store=new UploadStore(parseUploadsConfig({root:tmp('prime-ingest-')}));
  await expect(store.ingest('o',{name:'fox.png',type:'image/png',data:png(20,10),tags:['studio']})).resolves.toMatchObject({kind:'image',type:'image/png',width:20,height:10,tags:['studio']});
  await expect(store.ingest('o',{name:'fake.png',type:'image/png',data:Buffer.from('MZ not an image at all')})).rejects.toMatchObject({status:415});
 });
});
