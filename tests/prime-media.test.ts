/* eslint-disable @typescript-eslint/no-explicit-any -- focused SDK/model stand-ins */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import cases from './fixtures/media-classifier-cases.json';
import type {ModelRouter} from '../src/code/model-factory.js';
import {PrimeHub, type Capability} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {
  buildArguments, classifyPrompt, classifyWithModel, describeCandidate, MediaError, MediaRouter,
  RANKING, rankCandidates,
} from '../src/prime/media.js';

const cap=(id:string,extra:Partial<Capability>={}):Capability=>({id,registered:true,health:'green',category:'image',description:'generator',...extra});
const imageCatalog=()=>[
  cap('echo.llm.together.black-forest-labs-FLUX.2-max'),
  cap('echo.llm.together.google-flash-image-2.5'),
  cap('echo.media.image_generate'),
  cap('echo.llm.together.stabilityai-stable-diffusion-xl-base-1.0'),
];

function modelStub(action:any={action:'final',content:JSON.stringify({kind:'video',styles:['cinematic']})}){
  const next=vi.fn(async()=>action),turn=vi.fn((_id:string)=>({model:{next},answered(){return null;},info(){return {id:'qwen',label:'Qwen',requested:'q',model:'q',reported:true,answered:true};}}));
  return {router:{turn} as unknown as ModelRouter,next,turn};
}

it.each(cases)('classifies fixture: $why',testCase=>{
  const result=classifyPrompt(testCase.text);
  expect(result.kind).toBe(testCase.kind);
  for(const style of testCase.styles)expect(result.styles).toContain(style);
  if(testCase.aspect)expect(result.aspect).toBe(testCase.aspect);
  if(testCase.durationSeconds)expect(result.durationSeconds).toBe(testCase.durationSeconds);
});

describe('rules and model classification',()=>{
  it('lets a valid hint win with full confidence',()=>expect(classifyPrompt('a cat',{hint:'music'})).toMatchObject({kind:'music',confidence:1,source:'hint'}));
  it('rejects an invalid hint',()=>expect(()=>classifyPrompt('a cat',{hint:'bogus' as any})).toThrow(expect.objectContaining({status:400} as MediaError)));
  it('removes negated music and voice signals',()=>expect(['music','voice']).not.toContain(classifyPrompt('a quiet forest photo, no music, no voice').kind));
  it('uses image and chat fallbacks at 0.3 confidence',()=>{
    expect(classifyPrompt('zzzz qqqq')).toMatchObject({kind:'image',confidence:.3});
    expect(classifyPrompt('zzzz qqqq',{fallback:'chat'})).toMatchObject({kind:'chat',confidence:.3});
  });
  it('parses seconds and minutes',()=>{
    expect(classifyPrompt('a ten second clip of waves').durationSeconds).toBe(10);
    expect(classifyPrompt('2 minutes of ambient music').durationSeconds).toBe(120);
  });
  it('raises confidence when the model agrees',async()=>{
    const s=modelStub(),rules=classifyPrompt('a ten second video clip');
    const result=await classifyWithModel(s.router,'a ten second video clip',rules);
    expect(result.confidence).toBe(Math.min(.98,rules.confidence+.15));expect(result.signals).toContain('model:video');expect(s.turn).toHaveBeenCalledWith('qwen');
  });
  it('lets the model replace weak rules with 0.8 confidence',async()=>{
    const s=modelStub(),rules=classifyPrompt('zzzz qqqq');
    expect(await classifyWithModel(s.router,'zzzz qqqq',rules)).toMatchObject({kind:'video',confidence:.8});
  });
  it('keeps strong rules when the model disagrees',async()=>{
    const s=modelStub({action:'final',content:JSON.stringify({kind:'music',styles:[]})}),rules=classifyPrompt('video clip footage trailer');
    expect(rules.confidence).toBeGreaterThanOrEqual(.75);expect((await classifyWithModel(s.router,'video clip footage trailer',rules)).kind).toBe('video');
  });
  it('keeps rules for malformed model content',async()=>{
    const s=modelStub({action:'final',content:'not json'}),rules=classifyPrompt('a photo');const result=await classifyWithModel(s.router,'a photo',rules);
    expect(result.kind).toBe(rules.kind);expect(result.modelReason).toContain('rules result kept');
  });
  it('keeps rules for a model tool action',async()=>{
    const s=modelStub({action:'list',path:'.'}),rules=classifyPrompt('a photo');const result=await classifyWithModel(s.router,'a photo',rules);
    expect(result.kind).toBe(rules.kind);expect(result.modelReason).toContain('tool action');
  });
  it('keeps rules when the model throws',async()=>{
    const s=modelStub();s.next.mockRejectedValueOnce(new Error('offline'));const rules=classifyPrompt('a photo');
    await expect(classifyWithModel(s.router,'a photo',rules)).resolves.toMatchObject({kind:rules.kind,modelReason:expect.any(String)});
  });
  it('redacts API-key-looking prompt text before model inference',async()=>{
    const secret='ghp_'+'a'.repeat(36),s=modelStub();await classifyWithModel(s.router,'video '+secret,classifyPrompt('video '+secret));
    expect(JSON.stringify(s.next.mock.calls[0][0])).not.toContain(secret);expect(s.turn).toHaveBeenCalledWith('qwen');
  });
});

describe('candidate ranking and arguments',()=>{
  it('sorts candidates by descending score',()=>{
    const rows=rankCandidates('image',imageCatalog(),{text:'make an image'}).candidates;
    expect(rows.map(r=>r.score)).toEqual([...rows.map(r=>r.score)].sort((a,b)=>b-a));
  });
  it('uses health, cost, quality, then id for equal-score ties',()=>{
    const ids=['echo.llm.together.acme-image-b','echo.llm.together.acme-image-a'];
    const rows=rankCandidates('image',ids.map(id=>cap(id,{description:'text-to-image generator'})),{text:'image'}).candidates;
    expect(rows.map(r=>r.id)).toEqual([...ids].sort());
  });
  it('excludes red and unregistered candidates with explicit reasons',()=>{
    const result=rankCandidates('image',[cap('echo.image.generate',{health:'red'}),cap('echo.media.image_generate',{registered:false})],{text:'image'});
    expect(result.candidates).toHaveLength(0);expect(result.excluded.map(x=>x.unavailable)).toEqual(expect.arrayContaining([expect.stringContaining('health red'),'not registered']));
  });
  it('excludes Cartesia voice text over 400 characters',()=>{
    const result=rankCandidates('voice',[cap('echo.cartesia.tts',{category:'voice'})],{text:'x'.repeat(401)});
    expect(result.excluded[0].unavailable).toContain('400');
  });
  it('raises fit for a matching photoreal style',()=>{
    const result=rankCandidates('image',[cap('echo.llm.together.black-forest-labs-FLUX.2-max'),cap('echo.llm.together.stabilityai-stable-diffusion-xl-base-1.0')],{text:'fox',styles:['photoreal']});
    expect(result.candidates.find(x=>x.id.includes('FLUX.2-max'))!.fit).toBeGreaterThan(result.candidates.find(x=>x.id.includes('stable-diffusion'))!.fit);
  });
  it('filters retrieval, speech-to-text, and deprecated capabilities',()=>{
    for(const c of [cap('echo.elevenlabs.speech_to_text.stt'),cap('echo.x.video_retrieve'),cap('echo.any.image',{description:'DEPRECATED image generator'})])expect(describeCandidate(c)).toBeNull();
  });
  it('builds image dimensions and style',()=>{
    expect(buildArguments('echo.media.image_generate','image','fox',{styles:['anime'],aspect:'16:9'})).toEqual({shape:'modeled',arguments:{command:'image_generate',options:{prompt:'fox',wait:false,style:'anime',width:1024,height:576}}});
    expect(buildArguments('echo.media.image_generate','image','fox',{styles:[],aspect:'9:16'}).arguments).toMatchObject({options:{width:576,height:1024}});
  });
  it('builds music, clamped sfx, voice, and unknown shapes',()=>{
    expect(buildArguments('echo.elevenlabs.music_generation.generate','music','song',{styles:[],durationSeconds:30}).arguments).toMatchObject({options:{music_length_ms:30000}});
    expect(buildArguments('echo.elevenlabs.sound_generation.sound_generation','sfx','boom',{styles:[],durationSeconds:90}).arguments).toMatchObject({options:{duration_seconds:30}});
    expect(buildArguments('echo.voice.speak','voice','hello').arguments).toEqual({command:'speak',options:{text:'hello'}});
    expect(buildArguments('echo.unknown.generator','image','hello').shape).toBe('unmodeled');
  });
  it('never builds a prepare-forbidden argument key for at least 25 ranked ids',()=>{
    const forbidden=/"(?:force_video|grant|api_key|access_token|authorization|confirm|bypass_reason)"\s*:/i;
    const samples=[
      'echo.media.image_generate','echo.image.qwen.generate','echo.image.generate','echo.llm.together.gemini-3-pro-image','echo.llm.together.gemini-3.1-flash-image','echo.llm.together.FLUX.2-max','echo.llm.together.FLUX.2-pro','echo.llm.together.FLUX.2-flex','echo.llm.together.FLUX.1-schnell','echo.llm.together.Seedream-4.0','echo.llm.together.gpt-image-2','echo.llm.together.imagen-4.0','echo.llm.together.ideogram-4.0','echo.llm.together.Qwen-Image-2.0-Pro','echo.llm.together.stable-diffusion-xl','echo.media.video_generate','echo.llm.together.veo-3.1','echo.llm.together.sora-2-pro','echo.llm.together.kling-2.1-master','echo.llm.together.Seedance-2.0','echo.elevenlabs.music_generation.generate','echo.elevenlabs.music_generation.compose_detailed','echo.elevenlabs.sound_generation.sound_generation','echo.elevenlabs.tts','echo.voice.speak','echo.cartesia.tts','echo.aws.polly_tts','echo.azure.cognitive_speech_tts','echo.google.speech.tts',
    ];
    expect(samples).toHaveLength(29);
    for(const id of samples){const ranking=RANKING.find(r=>r.match.test(id));expect(ranking,id).toBeTruthy();for(const kind of ranking!.kinds)expect(JSON.stringify(buildArguments(id,kind,'a prompt with api_key word inside text').arguments),id).not.toMatch(forbidden);}
  });
});

describe('MediaRouter',()=>{
  it('passes conversation prompts to chat',async()=>{
    const r=await new MediaRouter({catalog:imageCatalog}).route({text:'What is the capital of Portugal?',classifier:false});
    expect(r.picked).toBeNull();expect(r.reason).toMatch(/conversation/i);expect(r.alternatives).toEqual([]);
  });
  it('returns one image pick and no duplicate alternatives',async()=>{
    const r=await new MediaRouter({catalog:imageCatalog}).route({text:'a fox photo',classifier:false,probe:false});
    expect(r.picked).toMatchObject({cap:expect.any(String),provider:expect.any(String),reason:expect.stringMatching(/^Picked /),request:{target:'sdk',name:expect.any(String),arguments:expect.any(Object)}});
    expect(r.alternatives.map(x=>x.id)).not.toContain(r.picked!.id);expect(r.alternatives.length).toBeLessThanOrEqual(6);
  });
  it('refuses to auto-prepare an image edit',async()=>{
    const r=await new MediaRouter({catalog:imageCatalog}).route({text:'remove the background from my photo',classifier:false,probe:false});expect(r.picked).toBeNull();expect(r.reason).toMatch(/attach/i);
  });
  it('reports when no healthy generator exists',async()=>{
    const r=await new MediaRouter({catalog:()=>[cap('echo.image.generate',{health:'red'})]}).route({text:'a fox image',classifier:false,probe:false});expect(r.picked).toBeNull();expect(r.reason).toMatch(/No healthy/i);
  });
  it.each([{text:'x',extra:1},{text:''},{text:'x'.repeat(12001)},{text:'x',mode:'bad'},{text:'x',fallback:'bad'},{text:'x',probe:'yes'}])('rejects invalid route input %#',async input=>{
    await expect(new MediaRouter({catalog:imageCatalog}).route(input)).rejects.toMatchObject({status:400});
  });
  it('probes, caches for 60 seconds, and refreshes after 61 seconds',async()=>{
    let now=0;const read=vi.fn(async(id:string)=>({registration_state:'registered',health_status:id.includes('FLUX.2-max')?'red':'green'}));const router=new MediaRouter({catalog:imageCatalog,read,now:()=>now,probeCount:2});
    const first=await router.route({text:'photoreal fox image',classifier:false});expect(first.picked!.id).not.toContain('FLUX.2-max');expect(first.probe.source).toBe('live');expect(first.probe.probed).toHaveLength(2);
    const calls=read.mock.calls.length;now=59000;expect((await router.route({text:'photoreal fox image',classifier:false})).probe.source).toBe('cached');expect(read).toHaveBeenCalledTimes(calls);
    now=61000;expect((await router.route({text:'photoreal fox image',classifier:false})).probe.source).toBe('live');expect(read.mock.calls.length).toBeGreaterThan(calls);
  });
  it('treats a rejected probe as unknown without throwing',async()=>{
    const r=await new MediaRouter({catalog:()=>[cap('echo.media.image_generate')],read:vi.fn(async()=>{throw new Error('down');}),probeCount:1}).route({text:'fox image',classifier:false});expect(r.picked).toBeTruthy();expect(r.picked!.health).toBe('unknown');
  });
  it('consults models only for weak unhinted rules',async()=>{
    const s=modelStub();await new MediaRouter({catalog:imageCatalog,models:s.router}).route({text:'zzzz qqqq',fallback:'image',classifier:false});expect(s.next).not.toHaveBeenCalled();
    await new MediaRouter({catalog:imageCatalog,models:s.router}).route({text:'zzzz qqqq',fallback:'image',probe:false});expect(s.next).toHaveBeenCalledTimes(1);
    s.next.mockClear();await new MediaRouter({catalog:imageCatalog,models:s.router}).route({text:'a fox',mode:'video',probe:false});expect(s.next).not.toHaveBeenCalled();
  });
});

describe('POST /api/prime/media/route',()=>{
  const cleanups:string[]=[],servers:Array<{close:()=>Promise<void>}>=[];
  afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>s.close()));for(const dir of cleanups.splice(0))rmSync(dir,{recursive:true,force:true});});
  async function fixture(){const dir=mkdtempSync(join(tmpdir(),'prime-media-route-'));cleanups.push(dir);writeFileSync(join(dir,'index.html'),'Prime');const server=await startPrimeServer(new PrimeHub({capabilities:imageCatalog()}),dir,0);servers.push(server);const page=await fetch(server.url);const cookie=page.headers.get('set-cookie')!.split(';')[0];return {post:(body:unknown,auth=true)=>fetch(server.url+'/api/prime/media/route',{method:'POST',headers:{...(auth?{cookie}:{}),origin:server.url,'content-type':'application/json','x-prime-request':'1'},body:JSON.stringify(body)})};}
  it('requires the Prime cookie',async()=>expect((await (await fixture()).post({text:'a fox image'},false)).status).toBe(403));
  it('returns a routed pick to an authenticated owner session',async()=>{const response=await (await fixture()).post({text:'a fox image',classifier:false,probe:false});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({picked:{cap:expect.any(String)}});});
  it('returns a 400 error string for invalid input',async()=>{const response=await (await fixture()).post({text:''});expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:expect.any(String)});});
});
