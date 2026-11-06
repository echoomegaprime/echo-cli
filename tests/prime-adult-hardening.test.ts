/* eslint-disable @typescript-eslint/no-explicit-any -- focused SDK stand-ins */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrimeHub, type Capability, type SdkBroker} from '../src/prime/hub.js';
import {UploadStore, parseUploadsConfig} from '../src/prime/uploads.js';
import {DEFAULT_GATE_CALL_KINDS, defaultMediaConfig} from '../src/prime/media-collect.js';
import {MediaRouter, rankCandidates} from '../src/prime/media.js';
import {PromptEnhancer} from '../src/prime/enhance.js';
import {ADULT_TERM_EXAMPLES, adultKindOf, adultPolicy, classifyAdult, isReadOnlyCapability, isRouterPolicyRefusal, textOfArguments} from '../src/prime/adult.js';

// Review-round hardening. Nothing here uses the ADULT_BRIEF_MARKER stand-in: every brief runs through the REAL classifier,
// so a keyword list that shrinks or misses a family fails these tests (the 2026-11-06 incident class). The words used are
// mild members of each family; the strong terms are covered through ADULT_TERM_EXAMPLES, which lives next to the regex.
const ROUTER='echo.media.image_generate',VIDEO='echo.media.video_generate',SEEDREAM='echo.llm.together.ByteDance-Seed-Seedream-4.0';
const snapshot=(JSON.parse(readFileSync(new URL('../ui/echo-prime/catalog.json',import.meta.url),'utf8')) as {capabilities:Capability[]}).capabilities;
const callKinds=[...DEFAULT_GATE_CALL_KINDS,'together_image_generation','together_video_generation'];
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const tmp=(prefix:string)=>{const d=mkdtempSync(join(tmpdir(),prefix));dirs.push(d);return d;};
function fakeClock(){let now=Date.parse('2026-11-06T12:00:00Z');return {now:()=>now,sleep:async(ms:number)=>{now+=ms;},advance:(ms:number)=>{now+=ms;}};}
/** A hub the way production builds it: the full shipped catalog and NO test markers. */
function realHub(invoke:(request:any)=>Promise<unknown>=async()=>({}),extra:{clock?:ReturnType<typeof fakeClock>;catalog?:Capability[]}={}){
 const uploads=new UploadStore(parseUploadsConfig({root:tmp('prime-adult-h-')}));
 const sdk={search:vi.fn(async()=>[]),read:vi.fn(async(id:string)=>({registration_state:'registered',health_status:'green',capability:{id}})),invoke:vi.fn(invoke)} as unknown as SdkBroker&{invoke:ReturnType<typeof vi.fn>;read:ReturnType<typeof vi.fn>};
 const hub=new PrimeHub({capabilities:extra.catalog??snapshot,sdk,uploads,uploadsOwner:'owner-1',mediaConfig:defaultMediaConfig(),mediaClock:extra.clock} as any);
 return {hub,sdk};
}
const prepare=(hub:PrimeHub,name:string,args:Record<string,unknown>)=>hub.prepare({target:'sdk',name,arguments:args});
async function run(hub:PrimeHub,name:string,args:Record<string,unknown>){const t=await prepare(hub,name,args);return hub.execute(t.id,t.digest) as Promise<any>;}
const ok={flagged:true,fictional:true,capability:ROUTER};

describe('classifier covers the families, inflections included (review #1)',()=>{
 it.each(['a sexually suggestive pose','sexting on a phone','a sexier outfit','sexuality in art','nudes of a marble statue','a nudist beach','an undressed figure','an unclothed mannequin','x-rated poster','rule 34 comic','busty cartoon pirate','a thong on a washing line','topless sunbather','lingerie catalogue','nsfw','a nude study','a nüde study','a night at the strip club','a playboy bunny costume'])
  ('reads "%s" as adult with no marker',text=>{expect(classifyAdult('a woman, '+text).adult).toBe(true);});
 it('recognises every documented term family and its inflections (one example each, kept next to the regex)',()=>{
  expect(ADULT_TERM_EXAMPLES.length).toBeGreaterThan(40);
  for(const term of ADULT_TERM_EXAMPLES)expect(classifyAdult('a woman, '+term).adult,term).toBe(true);
  for(const term of ADULT_TERM_EXAMPLES)expect(classifyAdult(term.toUpperCase()).adult,term+' (upper case)').toBe(true);
 });
 it.each(['the sextant on the deck','Essex and Sussex coastline','a sextet of violins','do not nudge the camera','cucumber salad on a plate','cumulus clouds over a field','a cumbersome backpack','cumin and coriander','Scunthorpe high street','a classy assistant at the assembly','Dickens reading in a study','a peacock and a cocktail','Hancock Tower at dusk','data analysis chart','an analog synthesizer','a therapist in an office','grilled chicken breasts with rice','blue tits on a branch','Moby Dick illustration','cock-a-doodle-doo rooster at sunrise','magna cum laude diploma on a desk','a grape vine'])
  ('does not read "%s" as adult',text=>{expect(classifyAdult(text).adult).toBe(false);});
});

describe('Prime is a superset of the router v2 term lists (policy_terms.json 2026-11-06.1)',()=>{
 // One sample per alternative of the router's minor_regex and sexual_regex; the mild ones are written out, the strong ones are
 // the same families ADULT_TERM_EXAMPLES walks.
 const routerSexual=['nsfw','nude','naked','nudity','sex','sexual','sexy','explicit','porn','pornography','erotic','erotica','nipple','nipples','genital','genitals','vagina','penis','cum','orgasm','topless','lingerie','fetish','hentai','bdsm','intercourse','masturbate','masturbation'];
 const routerMinor=['loli','lolicon','shota','shotacon','child','children','kid','kids','toddler','toddlers','infant','infants','preteen','pre-teen','pre-teens','underage','under-age','minor','minors','school girl','schoolgirl','school boys','teen','teens','teenager','teenagers','juvenile','17 year old','17-year-old','9 yr old','0 years old'];
 it.each(routerSexual)('the router reads "%s" as sexual and so does Prime',w=>{expect(classifyAdult('a woman, '+w).adult).toBe(true);});
 it.each(routerMinor)('the router reads "%s" as a minor term and so does Prime',w=>{expect(adultPolicy({text:'nsfw '+w,...ok}).refusal?.code,w).toBe('minor');});
});

describe('minor terms refused locally, wherever they hide (review #3)',()=>{
 it.each(['a teenage girl','a teenaged girl','an underaged girl','a tween','a fifteen year old','a sixteen-year-old','twelve years old','a 16yo','a 16 y/o girl','a girl of 15','a boy of ten','a high school student','a childlike woman','a preschooler','in kindergarten','her daughter','a stepdaughter','a 17 y.o. woman','a junior high student','an elementary school classroom','a girl aged 14','a lolita','a middle school girl','under 18','below the age of eighteen','a pubescent boy','a baby sitter','a babysitter','a 10 yr old','a 9-year-old','she looks 12','a young-looking girl','a tiny girl'])
  ('refuses "%s" in an adult request',text=>{expect(adultPolicy({text:'nsfw '+text,...ok}).refusal?.code,text).toBe('minor');});
 it.each(['a woman of 25','a 30 year old woman','an 18 year old woman','an eighteen-year-old woman','a nineteen year old','a woman in her twenties','a 118 year old tortoise','aged 25','a 40yo man','a girl of 21'])
  ('lets "%s" through the minor check',text=>{expect(adultPolicy({text:'nsfw '+text,...ok}).refusal?.code,text).not.toBe('minor');});
 it('applies the same list to the on-prem router route, before any catalog call',async()=>{
  const search=vi.fn(async()=>[]);
  const r=await new MediaRouter({catalog:()=>snapshot,callKinds,search} as any).route({text:'nsfw portrait of a teenage girl',mode:'image',adult:true,fictional:true,style:'photoreal'}) as any;
  expect(r.picked).toBeNull();expect(r.adult.refusal).toBe('minor');expect(search).not.toHaveBeenCalled();
 });
});

describe('real-person pre-route (review #4)',()=>{
 it.each(['Emma Watson naked','nude Scarlett Johansson','Taylor Swift topless','Joe Biden nude','nude Margot Robbie','nude Zendaya','a nude woman that looks like emma watson','nude my sister','a topless woman who resembles my boss','nude, the face of a famous singer','nude mom on a beach','nude brother and sister','nude emma watson','nude version of myself','a selfie of her nude','nude with a face modeled on a real person','topless elon musk','nude Rihanna','nude Elon','naked Beyoncé','nude AOC','nude Trump'])
  ('refuses "%s" as a real person',text=>{expect(adultPolicy({text,...ok}).refusal?.code,text).toBe('real_person');});
 it('keeps an invented adult character through',()=>{
  for(const text of ['a nude figure study in charcoal','an invented elven queen in a gothic cathedral, topless','nude woman on a beach at sunset, oil painting','invented adult woman, lingerie, studio photo'])
   expect(adultPolicy({text,...ok}).refusal,text).toBeUndefined();
 });
});

describe('audio kinds are not exempt (review #5)',()=>{
 it.each(['voice','music','sfx'])('refuses an adult %s brief with the plain "no on-prem tool" reason',kind=>{
  const d=adultPolicy({text:'a narrator reads an nsfw story',kind,capability:'echo.voice.elevenlabs.tts'});
  expect(d.refusal?.code).toBe('no_on_prem_tool');
  expect(d.refusal!.message).toMatch(/no on-prem/i);expect(d.refusal!.message).toMatch(/nothing was sent/i);
 });
 it('still lets a read-only or non-generative request through, whatever words it contains',()=>{
  expect(adultPolicy({text:'SELECT sex FROM patients',kind:'other',capability:'echo.psql.query'}).adult).toBe(false);
  expect(adultPolicy({text:'a red fox',kind:'voice',capability:'echo.voice.tts'}).adult).toBe(false);
 });
});

describe('argument scanning and capability kinds (review #2)',()=>{
 it('joins every string leaf, at any depth, and skips a negative prompt (it names what to avoid)',()=>{
  const deep=(n:number,leaf:unknown):unknown=>n===0?leaf:{x:[deep(n-1,leaf)]};
  const text=textOfArguments({command:'call',prompt:'a red fox',input:{prompt:'inner brief',list:['one','two']},negative_prompt:'nsfw, nude',options:{negativePrompt:'nsfw'},deep:deep(60,'bottom brief'),n:7,flag:true});
  for(const piece of ['call','a red fox','inner brief','one','two','bottom brief'])expect(text).toContain(piece);
  expect(text).not.toContain('nsfw');expect(text).not.toMatch(/\b7\b/);
  expect(textOfArguments(null)).toBe('');expect(textOfArguments(undefined)).toBe('');expect(textOfArguments({n:1,b:true})).toBe('');
 });
 it('is bounded in size and leaf count',()=>{
  const big={a:Array.from({length:5000},(_,i)=>'leaf'+i),b:'x'.repeat(200000)};
  expect(textOfArguments(big).length).toBeLessThanOrEqual(50000);
 });
 it.each([
  ['echo.ai.sdk.together.image','other','image','image'],['echo.ai.sdk.together.video_create','other','video','video'],['echo.voice.elevenlabs.tts','voice','voice','voice'],
  ['echo.elevenlabs.sound_generation.sound_generation','sfx','sound','sfx'],['echo.newvendor.sora.create','other',undefined,'video'],['echo.newvendor.image.create','other',undefined,'image'],
  ['echo.newvendor.voice.say','other',undefined,'voice'],['echo.media.job_status','other','tools','other'],['echo.acme.search','other','tools','other'],['echo.cartesia.voices','other','tools','other'],
  ['echo.ai.sdk.together.video_retrieve','other','video','other'],['echo.psql.query','other','tools','unlisted'],['echo.llm.openrouter.chat','other',undefined,'unlisted'],
 ] as const)('maps %s (%s, %s) to %s',(id,described,category,want)=>{expect(adultKindOf(id,described,category)).toBe(want);});
 it('treats an unlisted, non-read-only capability as one the classifier decides for',()=>{
  expect(adultPolicy({text:'an nsfw story',kind:'unlisted',capability:'echo.llm.openrouter.chat'}).refusal?.code).toBe('not_on_prem');
  expect(adultPolicy({text:'an nsfw story',kind:'other',capability:'echo.acme.search'}).adult).toBe(false);
 });
});

describe('router policy refusals are told apart from real failures (review #10)',()=>{
 it.each(["no live nsfw-capable on-prem image model for style 'anime'; available nsfw-capable styles: photoreal",'busy, try again in ~30s: creative lease held','refused: an adult request must declare its subjects are fictional (set subjects_fictional=true)','model x on temper is \'present\'; it is not auto-routed.','requested 1024x1024 is larger than its canary','no available image backend for model=x node=temper style=anime'])
  ('"%s" is a policy refusal',t=>{expect(isRouterPolicyRefusal(t)).toBe(true);});
 it.each(['ComfyUI ran out of memory','execution_error: CUDA out of memory','ComfyUI node KSampler failed','connection reset by peer','Internal Server Error'])
  ('"%s" is a real failure',t=>{expect(isRouterPolicyRefusal(t)).toBe(false);});
 const ADULT={prompt:'an invented adult woman, lingerie',nsfw:true,subjects_fictional:true,style:'photoreal',wait:false};
 it('records a real router failure of an adult job against the tool, at submit and mid-job',async()=>{
  const a=realHub(async()=>({ok:false,error:'ComfyUI ran out of memory'}));
  expect((await run(a.hub,ROUTER,ADULT)).state).toBe('blocked');
  expect(a.hub.outcomes().last(ROUTER)).toBeDefined();
  const clock=fakeClock();
  const b=realHub(async(request:any)=>request.capability===ROUTER?{ok:true,job_id:'j1',status:'queued'}:{ok:false,job_id:'j1',status:'failed',error:'execution_error: CUDA out of memory'},{clock});
  const r=await run(b.hub,ROUTER,ADULT);
  expect(r.state).toBe('blocked');expect(r.detail).toContain('CUDA out of memory');
  expect(b.hub.outcomes().last(ROUTER)).toBeDefined();
 });
 it('still never records a policy refusal or a busy answer',async()=>{
  for(const said of ["no live nsfw-capable on-prem image model for style 'anime'; available nsfw-capable styles: photoreal",'busy, try again in ~30s: creative lease held']){
   const h=realHub(async()=>({ok:false,error:said}));
   const r=await run(h.hub,ROUTER,ADULT);
   expect(r.detail).toContain(said);expect(h.hub.outcomes().last(ROUTER)).toBeUndefined();
  }
 });
});

describe('real keywords through the route and the gate, no markers (review #1, #2, #9)',()=>{
 const briefs=['a sexually suggestive pose, invented adult woman, photo','an undressed invented adult woman, photo','a busty invented adult woman in a thong, photo','nudes of an invented adult woman, photo','an invented adult woman, x-rated, photo'];
 it('the incident precondition holds: for a plain brief an unrestricted ranking puts Seedream first and the router later',()=>{
  const ids=rankCandidates('image',snapshot,{text:'a woman on a bed, photo',callKinds}).candidates.map(c=>c.id);
  expect(ids).toContain(SEEDREAM);expect(ids).toContain(ROUTER);
  expect(ids.indexOf(SEEDREAM)).toBeLessThan(ids.indexOf(ROUTER));
 });
 it.each(briefs)('MediaRouter sends "%s" nowhere without Adult mode, and only to the router with it',async text=>{
  const router=new MediaRouter({catalog:()=>snapshot,callKinds} as any);
  const off=await router.route({text,mode:'image',classifier:false,probe:false}) as any;
  expect(off.picked).toBeNull();expect(off.alternatives).toEqual([]);expect(off.adult).toMatchObject({detected:true,refusal:'needs_adult_mode'});
  const on=await router.route({text,mode:'image',classifier:false,probe:false,adult:true,fictional:true,style:'photoreal'}) as any;
  expect(on.picked.id).toBe(ROUTER);expect([on.picked,...on.alternatives].map((p:any)=>p.id)).toEqual([ROUTER]);
  expect(on.excluded.map((x:any)=>x.id)).toContain(SEEDREAM);
 });
 it('the candidate filter asserts what it claims: every cloud generator of the snapshot is excluded for an adult brief',()=>{
  const ids=['echo.fal.generate','echo.deepai.image','echo.image.generate','echo.image.qwen.generate','echo.google.vertex.imagen_generate',SEEDREAM];
  for(const id of ids)expect(snapshot.some(c=>c.id===id),id+' is in the snapshot').toBe(true);
  const adult=rankCandidates('image',snapshot,{text:'x',callKinds,adult:true} as any);
  for(const id of ids)expect(adult.excluded.map(c=>c.id),id).toContain(id);
  expect(adult.candidates.map(c=>c.id)).toEqual([ROUTER]);
 });
 const adultText='nsfw portrait of an invented adult woman';
 it.each([
  ['echo.ai.sdk.together.image',{prompt:adultText}],['echo.ai.sdk.together.video_create',{prompt:adultText}],
  ['echo.fal.generate',{command:'call',input:{prompt:adultText}}],[SEEDREAM,{command:'call',prompt:'a red fox',input:{prompt:adultText}}],[SEEDREAM,{command:'call',prompt:'a red fox',input:{text:adultText}}],
  ['echo.newvendor.image.create',{prompt:adultText}],['echo.newvendor.sora.create',{brief:adultText}],
 ])('prepare refuses %s with the brief in %j, before any call',async(id,args)=>{
  const {hub,sdk}=realHub();
  await expect(prepare(hub,id,args as any)).rejects.toThrow(/on-prem media router/);
  expect(sdk.read).not.toHaveBeenCalled();expect(sdk.invoke).not.toHaveBeenCalled();
 });
 it.each([
  ['echo.voice.elevenlabs.tts',{text:adultText}],['echo.forgeplugin.personality.synthesize',{text:adultText}],['echo.voice.speak.batch',{items:[{text:adultText}]}],['echo.elevenlabs.music_generation.generate',{prompt:adultText}],
 ])('prepare refuses %s: there is no on-prem audio tool',async(id,args)=>{
  const {hub,sdk}=realHub();
  await expect(prepare(hub,id,args as any)).rejects.toThrow(/no on-prem/i);
  expect(sdk.read).not.toHaveBeenCalled();
 });
 it('no capability of the shipped snapshot slips past the gate: only read-only tools take an adult brief unchecked',async()=>{
  const {hub}=realHub();
  const passed:string[]=[],refused:string[]=[];
  for(const c of snapshot){
   try{await prepare(hub,c.id,{prompt:adultText,text:adultText});passed.push(c.id);}catch{refused.push(c.id);}
  }
  expect(refused.length).toBeGreaterThan(150);expect(passed.length).toBeGreaterThan(5);
  expect(passed.filter(id=>!isReadOnlyCapability(id))).toEqual([]);
  for(const c of snapshot.filter(x=>['image','video','voice','music','sound'].includes(String(x.category))&&!isReadOnlyCapability(x.id)))expect(refused,c.id).toContain(c.id);
 });
 it('prepare still passes ordinary work: read-only tools, plain briefs, and a negative prompt that only lists what to avoid',async()=>{
  const {hub}=realHub();
  expect((await prepare(hub,'echo.media.job_status',{job_id:'abc nsfw'})).request.arguments).toEqual({job_id:'abc nsfw'});
  expect((await prepare(hub,'echo.cartesia.voices',{})).request.arguments).toEqual({});
  const plain=await prepare(hub,SEEDREAM,{command:'call',prompt:'a red fox in the snow',negative_prompt:'nsfw, nude, lowres'});
  expect(plain.request.arguments).toEqual({command:'call',prompt:'a red fox in the snow',negative_prompt:'nsfw, nude, lowres'});
  expect((await prepare(hub,'echo.cartesia.tts',{text:'Good morning, here is the weather.'})).request.arguments).toEqual({text:'Good morning, here is the weather.'});
 });
 it('prepare issues the ticket for an attested adult request on the router with a real keyword and no marker',async()=>{
  const {hub}=realHub();
  const t=await prepare(hub,ROUTER,{prompt:'a sexually suggestive pose, invented adult woman',nsfw:true,subjects_fictional:true,style:'photoreal',wait:false});
  expect(t.request.arguments).toMatchObject({nsfw:true,subjects_fictional:true,node:'temper'});
  await expect(prepare(hub,ROUTER,{prompt:'a sexually suggestive pose, invented adult woman',wait:false})).rejects.toThrow(/Adult mode must be switched on/);
 });
});

describe('adult video is left to the router (review #8)',()=>{
 it('an adult video brief ranks the router video tool; an ordinary one still lists it as not auto-routed, with a reason that fits either router',()=>{
  const adult=rankCandidates('video',snapshot,{text:'x',callKinds,adult:true} as any);
  expect(adult.candidates.map(c=>c.id)).toEqual([VIDEO]);
  const plain=rankCandidates('video',snapshot,{text:'a fox running',callKinds});
  const why=plain.excluded.find(c=>c.id===VIDEO)!.unavailable!;
  expect(why).toContain('owner-disabled');expect(why).toMatch(/canary/i);expect(why).not.toMatch(/never force-enables/);
 });
 it('the route picks the router video tool for an attested adult brief, with no style and pinned to TEMPER',async()=>{
  const r=await new MediaRouter({catalog:()=>snapshot,callKinds} as any).route({text:'an undressed invented adult woman walking, 5 seconds',mode:'video',classifier:false,probe:false,adult:true,fictional:true}) as any;
  expect(r.picked.id).toBe(VIDEO);
  expect(r.picked.request.arguments).toMatchObject({nsfw:true,subjects_fictional:true,node:'temper',wait:false});
  expect(r.picked.request.arguments.style).toBeUndefined();
 });
});

describe('Enhance (review #7)',()=>{
 const make=()=>{const turn=vi.fn(()=>{throw new Error('SENTINEL: reached the model');});return {turn,enhancer:new PromptEnhancer({turn,defaultId:'claude',config:{}} as any)};};
 it('does not block ordinary chat text that happens to contain a keyword',async()=>{
  const {turn,enhancer}=make();
  await expect(enhancer.enhance({mode:'auto',text:'summarize our sexual harassment policy for new staff',provider:'claude'},'s1')).rejects.toThrow(/SENTINEL/);
  await expect(enhancer.enhance({mode:'chat',text:'draft a sexual harassment policy',provider:'claude'},'s1')).rejects.toThrow(/SENTINEL/);
  expect(turn).toHaveBeenCalledTimes(2);
 });
 it('still refuses a picture or video brief with a keyword, in image, video and auto modes, before any model turn',async()=>{
  const {turn,enhancer}=make();
  for(const mode of ['image','video'])await expect(enhancer.enhance({mode,text:'an undressed invented adult woman, photo',provider:'claude'},'s1'),mode).rejects.toMatchObject({status:400});
  await expect(enhancer.enhance({mode:'auto',text:'draw an undressed invented adult woman, photo',provider:'claude'},'s1')).rejects.toMatchObject({status:400});
  expect(turn).not.toHaveBeenCalled();
 });
 it('refuses on the Studio adult flag alone, so a mild adult brief with no keyword never reaches a cloud model',async()=>{
  const {turn,enhancer}=make();
  for(const mode of ['image','video','auto','music'])await expect(enhancer.enhance({mode,text:'a lady in a garden',provider:'claude',adult:true},'s1'),mode).rejects.toMatchObject({status:400,message:expect.stringContaining('cloud')});
  expect(turn).not.toHaveBeenCalled();
  await expect(enhancer.enhance({mode:'chat',text:'hello there',provider:'claude',adult:true},'s1')).rejects.toThrow(/SENTINEL/);
  await expect(enhancer.enhance({mode:'image',text:'a lady',provider:'claude',adult:'yes'},'s1')).rejects.toMatchObject({status:400});
  await expect(enhancer.enhance({mode:'image',text:'a red fox',provider:'claude',adult:false},'s1')).rejects.toThrow(/SENTINEL/);
 });
 it('refuses before the rate limiter: a refused adult request counts nothing',async()=>{
  const turn=vi.fn(()=>{throw new Error('SENTINEL');});
  const enhancer=new PromptEnhancer({turn,defaultId:'claude',config:{}} as any,{limit:1});
  for(let i=0;i<3;i++)await expect(enhancer.enhance({mode:'image',text:'a lady',provider:'claude',adult:true},'s1')).rejects.toMatchObject({status:400});
  await expect(enhancer.enhance({mode:'image',text:'a red fox',provider:'claude'},'s1')).rejects.toThrow(/SENTINEL/);
 });
});

describe('video agent (review #6)',()=>{
 const hub=()=>new PrimeHub({capabilities:[],adk:{} as any} as any);
 const adultBrief='an undressed invented adult woman walking on a beach';
 it('refuses an adult brief, shot prompt, camera, motion or voice-over before planning anything',async()=>{
  const h=hub();
  await expect(h.videoPlan({brief:adultBrief,prompts:['a calm beach']})).rejects.toMatchObject({status:400,message:expect.stringMatching(/cloud/)});
  await expect(h.videoPlan({brief:'a day at the sea',prompts:[adultBrief]})).rejects.toMatchObject({status:400});
  await expect(h.videoPlan({brief:'a day at the sea',prompts:[{prompt:'a calm beach',voiceover:'the nsfw story begins'}]})).rejects.toMatchObject({status:400});
  await expect(h.videoPlan({brief:'a day at the sea',shots:[{prompt:'a calm beach',duration_s:4,camera:'static',motion:'slow',voiceover:'topless sunbathers'}]})).rejects.toMatchObject({status:400});
  await expect(h.videoAgent({brief:adultBrief,prompts:['a calm beach']})).rejects.toMatchObject({status:400});
 });
 it('still plans an ordinary storyboard',async()=>{
  const plan=await hub().videoPlan({brief:'a day at the sea',prompts:['a calm beach at dawn','gulls over the harbour']});
  expect(plan.plan.shots.length).toBe(2);
 });
});
