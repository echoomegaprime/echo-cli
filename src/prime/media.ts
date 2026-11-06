import {debuglog} from 'node:util';
import {redact} from '../code/workspace.js';
import type {Capability, Json} from './hub.js';
import type {AnswerInfo, ModelRouter} from '../code/model-factory.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * Auto media routing: the user types a prompt, Prime classifies it (image / video / music / sfx / voice / image-edit,
 * or chat when nothing creative is asked), asks the live SDK catalog (kind-scoped searches through the SDK broker) which
 * generators exist for that kind, overlays them on the shipped snapshot, ranks them by capability fit x health x cost x
 * quality, and returns one explicit pick plus the ordered alternatives. The result always says which catalog it ranked
 * (`catalog.source`: live, partial or snapshot) and why, so a snapshot-only ranking is never presented as live.
 *
 * Nothing here spends anything: the pick is a prepared request shape the Creative Studio feeds into the existing
 * review-then-execute path. Nothing here switches providers either: when a pick fails the caller shows the failure and
 * offers the next alternative as an explicit choice. Rankings live in RANKING below and are documented with their
 * sources in docs/echo-code/PRIME_MEDIA_ROUTER.md.
 */
export type MediaKind='image'|'video'|'music'|'sfx'|'voice'|'image-edit'|'chat';
export const MEDIA_KINDS:readonly MediaKind[]=['image','video','music','sfx','voice','image-edit','chat'];
export type StyleCue='photoreal'|'illustration'|'product'|'portrait'|'logo'|'anime'|'cinematic'|'3d'|'pixel'|'watercolor'|'sketch'|'typography';
export type Aspect='1:1'|'16:9'|'9:16'|'4:3'|'3:4'|'21:9';
export interface Classification {
 kind:MediaKind;confidence:number;styles:StyleCue[];aspect?:Aspect;durationSeconds?:number;
 /** Which rule or hint decided (never the prompt text itself). */
 signals:string[];
 source:'hint'|'rules'|'rules+model';
 /** Present when a classification model was consulted: what answered, or why it did not. */
 model?:AnswerInfo|null;modelReason?:string;
}
export interface ClassifyOptions {hint?:MediaKind|'auto';fallback?:'image'|'chat'}
const debug=debuglog('echo-prime');
export class MediaError extends WorkspaceHttpError {}
export const MEDIA_MAX_TEXT=12000;

// ---- rules classifier -------------------------------------------------------------------------------------------------
type Rule=[RegExp,number,string];
const KIND_RULES:Record<Exclude<MediaKind,'chat'>,Rule[]>={
 // An edit needs an existing image: edit verbs on "this/my photo", or a reference to the user's own picture, outweigh the bare image noun.
 // The image verbs skip noun uses ("this rough sketch", "a paint"), so a reference to the user's own sketch is not also counted as a request to draw one.
 'image-edit':[[/\b(?:edit|retouch|inpaint|outpaint|remove the background|replace the (?:sky|background)|change the (?:colou?r|background) of (?:this|the|my) (?:image|photo|picture)|(?:this|my) (?:image|photo|picture|screenshot|scan)\b.*\b(?:make it|turn it|change|remove|replace|add|crop|sharper|cleaner)|upscale (?:this|the|my) (?:image|photo|picture)|img2img|image[- ]to[- ]image)\b/i,1.5,'edit-verb'],[/\b(?:this|my) (?:rough |old |existing )?(?:sketch|drawing|photo|image|picture|screenshot|scan|render)\b/i,1.2,'own-image']],
 video:[[/\b(?:video|clip|footage|b-roll|reels?|trailer|animate|animation|animated|timelapse|time-lapse|slow[- ]motion|camera (?:pans?|tracks?|dolly|orbits?|rises?|pushes?|pulls?)|dolly|drone shot|fps|frames?|text[- ]to[- ]video|t2v|i2v)\b/i,1,'video-noun'],[/\b(?:shot|sequence|loop)\b.*\b(?:rising|moving|flying|panning|tracking|zooming|orbiting|following|drifting|rolling|falling|gathering)\b|\b(?:seamless|cinematic|video) loop\b/i,0.9,'motion-shot'],[/\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|sixty)[- ]?(?:s|sec|secs|second|seconds)\b/i,0.6,'duration']],
 music:[[/\b(?:song|track|beat|melody|chorus|verse|bpm|instrumental|soundtrack|jingle|score|riff|bassline|synthwave|lo-?fi|hip[- ]?hop|techno|house music|jazz|orchestral|symphony|ballad|anthem|theme music|background music|compose (?:a|some|me)?\s*(?:music|song|track))\b/i,1,'music-noun'],[/\bmusic\b/i,0.8,'music']],
 sfx:[[/\b(?:sound effects?|sfx|foley|whoosh|swoosh|impact sound|explosion sound|ambien(?:ce|t)(?: (?:sound|noise|loop|bed))?|footsteps|door (?:creak|slam)|creak|rain sounds?|thunder sound|ui sound|notification sound|click sound|chimes?|the sound of)\b/i,1,'sfx-noun'],[/\b(?:sound|noise)\b(?!track)/i,0.5,'sound']],
 voice:[[/\b(?:say|read (?:this|it|the following|aloud)|read aloud|narrat(?:e|ion|or)|voice[- ]?over|text[- ]to[- ]speech|tts|speak|spoken|announce|in (?:a|the) (?:calm |warm |deep |soft )?voice|voice line)\b/i,1,'voice-verb'],[/\bvoice\b/i,0.6,'voice']],
 image:[[/\b(?:image|picture|photo(?:graph)?|illustration|poster|logo|portrait|render(?:ing)?|wallpaper|icon|painting|sketch|drawing|artwork|concept art|thumbnail|banner|mockup|packshot|product shot|headshot|avatar|emblem|infographic|comic panel|pixel art|watercolou?r|oil painting|digital art|still)\b/i,1,'image-noun'],[/(?<!\b(?:this|my|the|a|an|your|our|rough|old|existing|pencil|quick)\s)\b(?:draw|paint|sketch|illustrate|depict|visuali[sz]e|design a logo|generate art)\b/i,0.8,'image-verb'],[/\b(?:4k|8k|dslr|35mm|50mm|85mm|bokeh|f\/\d|golden hour|studio lighting|rim light|wide[- ]angle|macro shot)\b/i,0.6,'photo-craft'],[/^(?:a|an|the|two|three|some)\s+\w+/i,0.45,'scene-phrase']],
};
const CHAT_RULES:Rule[]=[[/\b(?:explain|what is|what are|what's|who is|where is|when did|how do|how does|how to|how can|why (?:is|does|do|did)|summari[sz]e|compare|list the|tell me|write (?:a|an|the|me)?\s*(?:\w+\s){0,2}(?:function|code|script|email|essay|poem|story|summary|plan|regex|query|test)|debug|fix (?:this|the) (?:bug|error|code)|translate (?:this|the following)|calculate|define|does this|is this|can you (?:check|explain|review))\b/i,1,'chat-verb'],[/\?\s*$/,0.6,'question-mark']];
/** Negated media words ("no music", "without vocals", "no titles") must not vote for the thing they exclude. */
const NEGATED=/\b(?:no|without|not|never)\s+(?:any\s+)?(?:a\s+)?(?:music|vocals?|titles?|text|people|sound|video|voice|narration|watermarks?|captions?|logos?)\b/gi;
const STYLE_RULES:[StyleCue,RegExp][]=[
 ['photoreal',/\b(?:photo(?:graph|realistic|real)?|realistic|hyper-?realistic|dslr|35mm|50mm|85mm|raw photo|shot on|bokeh|f\/\d|lifelike)\b/i],
 ['illustration',/\b(?:illustration|illustrated|drawing|cartoon|vector|flat (?:design|style)|storybook|clip ?art)\b/i],
 ['product',/\b(?:product (?:shot|photo|render|image)|packshot|e-?commerce|on (?:a )?white background|catalog(?:ue)? shot|mockup)\b/i],
 ['portrait',/\b(?:portrait|headshot|close-?up of (?:a|the|her|his|their) face|profile picture|avatar)\b/i],
 ['logo',/\b(?:logo|wordmark|emblem|brand mark|monogram|icon set|app icon)\b/i],
 ['typography',/\b(?:typography|lettering|text that says|with the (?:words|text)|poster text|headline reads)\b/i],
 ['anime',/\b(?:anime|manga|chibi|waifu|shonen|ghibli)\b/i],
 ['cinematic',/\b(?:cinematic|film still|movie (?:still|scene)|anamorphic|teal and orange|35mm film)\b/i],
 ['3d',/\b(?:3d render|octane|blender|unreal engine|c4d|isometric 3d|claymation)\b/i],
 ['pixel',/\b(?:pixel art|8-?bit|16-?bit|sprite)\b/i],
 ['watercolor',/\bwater ?colou?r\b/i],
 ['sketch',/\b(?:pencil sketch|line art|charcoal|ink drawing|sketch)\b/i],
];
const ASPECT_RULES:[Aspect,RegExp][]=[
 ['21:9',/\b(?:21:9|ultra-?wide|cinemascope|banner)\b/i],['16:9',/\b(?:16:9|landscape orientation|widescreen|youtube thumbnail|desktop wallpaper|horizontal)\b/i],
 ['9:16',/\b(?:9:16|vertical|portrait orientation|phone wallpaper|story format|reels?|tiktok|youtube shorts|\bshorts)\b/i],['4:3',/\b4:3\b/],['3:4',/\b3:4\b/],['1:1',/\b(?:1:1|square)\b/i],
];
const NUMBER_WORDS:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,fifteen:15,twenty:20,thirty:30,forty:40,'forty-five':45,fifty:50,sixty:60,ninety:90};
function duration(text:string):number|undefined{
 const m=/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety)[- ]?(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i.exec(text);
 if(!m)return undefined;
 const n=/^\d/.test(m[1])?Number(m[1]):NUMBER_WORDS[m[1].toLowerCase()],unit=m[2].toLowerCase(),seconds=unit.startsWith('m')?n*60:n;
 return seconds>=1&&seconds<=600?seconds:undefined;
}
/** Rules-only classification. Deterministic, no network. `hint` (a mode tab the user chose) wins outright. */
export function classifyPrompt(text:string,options:ClassifyOptions={}):Classification{
 if(typeof text!=='string')throw new MediaError(400,'Invalid media request');
 const raw=text.slice(0,MEDIA_MAX_TEXT),body=raw.replace(NEGATED,' '),styles=STYLE_RULES.filter(([,rx])=>rx.test(body)).map(([cue])=>cue);
 const aspect=ASPECT_RULES.find(([,rx])=>rx.test(body))?.[0],durationSeconds=duration(raw);
 const base={styles,...(aspect?{aspect}:{}),...(durationSeconds!==undefined?{durationSeconds}:{})};
 if(options.hint&&options.hint!=='auto'){
  if(!MEDIA_KINDS.includes(options.hint))throw new MediaError(400,'Invalid media mode');
  return {kind:options.hint,confidence:1,signals:['hint:'+options.hint],source:'hint',...base};
 }
 const scores=new Map<MediaKind,{score:number;signals:string[]}>();
 const add=(kind:MediaKind,weight:number,signal:string)=>{const row=scores.get(kind)??{score:0,signals:[]};row.score+=weight;row.signals.push(signal);scores.set(kind,row);};
 for(const [kind,rules] of Object.entries(KIND_RULES) as [MediaKind,Rule[]][])for(const [rx,weight,signal] of rules)if(rx.test(body))add(kind,weight,signal);
 for(const [rx,weight,signal] of CHAT_RULES)if(rx.test(body))add('chat',weight,signal);
 // Style cues count for image when no medium noun was named ("a photoreal fox at golden hour").
 if(styles.length&&!scores.has('image'))add('image',0.5,'style-cue');
 const ranked=[...scores.entries()].sort((a,b)=>b[1].score-a[1].score||MEDIA_KINDS.indexOf(a[0])-MEDIA_KINDS.indexOf(b[0]));
 const fallback:MediaKind=options.fallback==='chat'?'chat':'image';
 if(!ranked.length)return {kind:fallback,confidence:0.3,signals:['fallback:'+fallback],source:'rules',...base};
 const [kind,top]=ranked[0],second=ranked[1]?.[1].score??0;
 // image-edit needs a source image; a bare image noun with edit verbs still means edit, but edit verbs without any image noun do not.
 const confidence=Math.max(0.35,Math.min(0.98,0.55+0.25*Math.min(top.score,1.5)-0.2*second));
 return {kind,confidence:Math.round(confidence*100)/100,signals:top.signals,source:'rules',...base};
}

const CLASSIFY_SYSTEM='CLASSIFICATION TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
 +'Decide what kind of thing the user wants generated from their prompt. kinds: image | video | music | sfx | voice | image-edit | chat. '
 +'image-edit means they refer to an existing image to change. chat means a question, instruction or conversation, not a media request. '
 +'styles (zero or more): photoreal, illustration, product, portrait, logo, anime, cinematic, 3d, pixel, watercolor, sketch, typography.\n'
 +'Reply with exactly one JSON object: {"action":"final","content":"<JSON string>"} where <JSON string> encodes {"kind":"<kind>","styles":["<style>",...]}. Never add anything else.';
const STYLE_SET=new Set<string>(STYLE_RULES.map(([cue])=>cue));
function parseModelClassification(content:string):{kind:MediaKind;styles:StyleCue[]}|null{
 let value:unknown;
 try{value=JSON.parse(content);}catch{
  const start=content.indexOf('{'),end=content.lastIndexOf('}');
  if(start<0||end<=start)return null;
  try{value=JSON.parse(content.slice(start,end+1));}catch{return null;}
 }
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(typeof v.kind!=='string'||!MEDIA_KINDS.includes(v.kind as MediaKind))return null;
 const styles=Array.isArray(v.styles)?v.styles.filter((s):s is StyleCue=>typeof s==='string'&&STYLE_SET.has(s)).slice(0,6):[];
 return {kind:v.kind as MediaKind,styles};
}
/** One short classification turn on the configured default (Qwen) through the ModelRouter. Only sharpens a weak rules
 * result; a failed or malformed answer leaves the rules result and says why. The prompt text never leaves this process
 * unredacted. */
export async function classifyWithModel(router:ModelRouter,text:string,rules:Classification,options:{timeoutMs?:number;signal?:AbortSignal;provider?:'qwen'}={}):Promise<Classification>{
 const turn=router.turn(options.provider??'qwen'),timeout=AbortSignal.timeout(options.timeoutMs??15000);
 const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
 try{
  const action=await turn.model.next([{role:'system',content:CLASSIFY_SYSTEM},{role:'user',content:redact(text).slice(0,MEDIA_MAX_TEXT)}],signal);
  turn.answered();
  if(action.action!=='final')return {...rules,source:'rules+model',model:turn.info(),modelReason:'classifier returned a tool action instead of a classification; rules result kept'};
  const parsed=parseModelClassification(action.content);
  if(!parsed)return {...rules,source:'rules+model',model:turn.info(),modelReason:'classifier answer was not a recognised classification; rules result kept'};
  const styles=[...new Set([...rules.styles,...parsed.styles])];
  if(rules.source==='hint')return {...rules,styles,source:'rules+model',model:turn.info()};
  const agree=parsed.kind===rules.kind;
  const kind=agree||rules.confidence<0.75?parsed.kind:rules.kind;
  const confidence=agree?Math.min(0.98,rules.confidence+0.15):kind===parsed.kind?0.8:rules.confidence;
  return {...rules,kind,styles,confidence:Math.round(confidence*100)/100,signals:[...rules.signals,'model:'+parsed.kind],source:'rules+model',model:turn.info()};
 }catch(error){
  const reason=error instanceof Error?redact(error.message).slice(0,200):'classifier failed';
  debug('%j',{event:'prime_media_classifier_failed',reason});
  return {...rules,source:'rules+model',model:turn.info(),modelReason:reason+'; rules result kept'};
 }
}

// ---- capability fit ---------------------------------------------------------------------------------------------------
export type CostTier='free'|'quota'|'paid-low'|'paid-mid'|'paid-high';
export const COST_WEIGHT:Record<CostTier,number>={free:1,quota:0.9,'paid-low':0.8,'paid-mid':0.7,'paid-high':0.6};
export const HEALTH_WEIGHT:Record<string,number>={green:1,amber:0.8,unknown:0.6,'unprobed-mutate':0.5,red:0,orphaned:0,unregistered:0};
interface Ranking {match:RegExp;kinds:MediaKind[];quality:number;speed:number;styles?:StyleCue[];cost?:CostTier;label:string;note:string;source:string}
/** Operator-assigned ranking table. `quality` and `speed` are 1-10 defaults, not benchmarks; the `source` column says
 * where each claim comes from (vendor tier naming, the capability's own description, or fleet memory). Full table with
 * sources: docs/echo-code/PRIME_MEDIA_ROUTER.md. First match wins, so specific entries come before family entries. */
export const RANKING:readonly Ranking[]=[
 // image: on-prem first (free), then hosted tiers
 {match:/^echo\.media\.image_generate$/,kinds:['image'],quality:6.5,speed:6,styles:['anime','photoreal'],cost:'free',label:'On-prem media router (TEMPER ComfyUI / FORGE diffusers)',note:'$0; picks RealVisXL (photoreal), Illustrious/NoobAI (anime), Juggernaut/SDXL on FORGE; async job',source:'cap description (echo.media.image_generate)'},
 {match:/^echo\.image\.qwen\.generate$/,kinds:['image'],quality:7,speed:5,styles:['typography'],cost:'free',label:'Qwen Image on TEMPER',note:'$0 on-prem exact-weight Qwen Image; needs scope image.qwen.generate (403 observed 2026-10-27)',source:'cap description; INTEGRATIONS.md observed boundaries'},
 {match:/^echo\.image\.generate$/,kinds:['image'],quality:5.5,speed:6,styles:['photoreal'],cost:'free',label:'FORGE diffusers (SDXL-class)',note:'$0 on-prem SDXL-class checkpoints, text-to-image only',source:'cap description (echo.image.generate)'},
 {match:/gemini-3-pro-image/i,kinds:['image','image-edit'],quality:9,speed:6,styles:['typography','product','illustration'],label:'Gemini 3 Pro Image (Nano Banana Pro)',note:'Google\'s top image tier; strong text rendering and editing',source:'vendor tier naming (Pro > Flash > Flash-Lite)'},
 {match:/gemini-3\.1-flash-lite-image|flash-image-3\.1-lite/i,kinds:['image','image-edit'],quality:7.5,speed:9,label:'Gemini 3.1 Flash-Lite Image (Nano Banana 2 Lite)',note:'fastest, lowest Gemini tier',source:'vendor tier naming'},
 {match:/gemini-3\.1-flash-image|flash-image-3\.1/i,kinds:['image','image-edit'],quality:8.5,speed:8,styles:['photoreal','product','illustration'],label:'Gemini 3.1 Flash Image (Nano Banana 2)',note:'fast Gemini image tier',source:'vendor tier naming'},
 {match:/gemini-2\.5-flash-image|flash-image-2\.5/i,kinds:['image','image-edit'],quality:8,speed:8,styles:['photoreal','product','illustration'],label:'Gemini 2.5 Flash Image (Nano Banana)',note:'verified working on the fleet Google project (2026-10, Vertex path); fast',source:'fleet memory google-gemini-image-gen-path; vendor tier naming'},
 {match:/FLUX\.2-max/i,kinds:['image'],quality:9,speed:5,styles:['photoreal','cinematic','product'],cost:'paid-high',label:'FLUX.2 [max] (Together)',note:'BFL top tier',source:'vendor tier naming (max > pro > flex > dev > schnell)'},
 {match:/FLUX\.2-pro/i,kinds:['image'],quality:8.5,speed:6,styles:['photoreal','cinematic','product'],cost:'paid-mid',label:'FLUX.2 [pro] (Together)',note:'BFL pro tier',source:'vendor tier naming'},
 {match:/FLUX\.2-flex/i,kinds:['image'],quality:7.5,speed:7,styles:['typography'],label:'FLUX.2 [flex] (Together)',note:'BFL flex tier (adjustable steps/guidance)',source:'vendor tier naming'},
 {match:/FLUX\.2-dev/i,kinds:['image'],quality:7,speed:7,label:'FLUX.2 [dev] (Together)',note:'BFL open dev tier',source:'vendor tier naming'},
 {match:/FLUX\.1\.1-pro/i,kinds:['image'],quality:8,speed:7,styles:['photoreal'],cost:'paid-mid',label:'FLUX 1.1 [pro] (Together)',note:'previous BFL pro tier',source:'vendor tier naming'},
 {match:/FLUX\.1-kontext-max/i,kinds:['image-edit'],quality:9,speed:5,cost:'paid-high',label:'FLUX.1 Kontext [max] (Together)',note:'editing model; needs a source image',source:'vendor product line (Kontext = in-context editing)'},
 {match:/FLUX\.1-kontext-pro/i,kinds:['image-edit'],quality:8.5,speed:6,cost:'paid-mid',label:'FLUX.1 Kontext [pro] (Together)',note:'editing model; needs a source image',source:'vendor product line'},
 {match:/FLUX\.1-schnell|flux-1-schnell/i,kinds:['image'],quality:6,speed:10,label:'FLUX.1 [schnell]',note:'BFL fast/distilled tier',source:'vendor tier naming'},
 {match:/Juggernaut-Lightning-Flux/i,kinds:['image'],quality:7,speed:9,styles:['photoreal','portrait'],label:'Juggernaut Lightning Flux (Together)',note:'RunDiffusion photoreal, lightning (few-step)',source:'vendor model naming'},
 {match:/Juggernaut-pro-flux/i,kinds:['image'],quality:7.5,speed:6,styles:['photoreal','portrait'],label:'Juggernaut Pro Flux (Together)',note:'RunDiffusion photoreal pro',source:'vendor model naming'},
 {match:/Seedream-4\.0/i,kinds:['image','image-edit'],quality:8.5,speed:7,styles:['photoreal','product','typography'],label:'Seedream 4.0 (Together)',note:'ByteDance current image tier',source:'vendor version ordering'},
 {match:/Seedream-5\.0-lite/i,kinds:['image'],quality:8,speed:8,label:'Seedream 5.0 Lite (Together)',note:'ByteDance lite tier',source:'vendor tier naming'},
 {match:/Seedream-3\.0/i,kinds:['image'],quality:7,speed:7,label:'Seedream 3.0 (Together)',note:'previous ByteDance tier',source:'vendor version ordering'},
 {match:/gpt-image-2|gpt-5\.4-image-2/i,kinds:['image','image-edit'],quality:8.5,speed:5,styles:['typography','illustration','product'],cost:'paid-mid',label:'GPT Image 2',note:'OpenAI current image model; strong instruction following and text',source:'vendor version ordering'},
 {match:/gpt-image-1\.5|gpt-5-image(?!-mini)/i,kinds:['image','image-edit'],quality:8,speed:5,styles:['typography','illustration'],cost:'paid-mid',label:'GPT Image 1.5',note:'OpenAI previous image tier',source:'vendor version ordering'},
 {match:/gpt-5-image-mini/i,kinds:['image'],quality:7,speed:7,label:'GPT-5 Image Mini',note:'OpenAI small image tier',source:'vendor tier naming'},
 {match:/imagen-4\.0-ultra/i,kinds:['image'],quality:8.5,speed:5,styles:['photoreal'],cost:'paid-mid',label:'Imagen 4 Ultra (Together)',note:'Google Imagen top tier',source:'vendor tier naming (Ultra > standard > Fast)'},
 {match:/imagen-4\.0-fast/i,kinds:['image'],quality:7.5,speed:9,label:'Imagen 4 Fast (Together)',note:'Google Imagen fast tier',source:'vendor tier naming'},
 {match:/imagen-4\.0/i,kinds:['image'],quality:8,speed:7,styles:['photoreal'],label:'Imagen 4 (Together)',note:'Google Imagen standard tier',source:'vendor tier naming'},
 {match:/ideogram-4\.0/i,kinds:['image'],quality:8,speed:7,styles:['logo','typography','illustration'],label:'Ideogram 4.0 (Together)',note:'typography/logo specialist, current version',source:'vendor positioning (text rendering); version ordering'},
 {match:/ideogram-3\.0/i,kinds:['image'],quality:7.5,speed:7,styles:['logo','typography','illustration'],label:'Ideogram 3.0 (Together)',note:'typography/logo specialist, previous version',source:'vendor positioning'},
 {match:/Qwen-Image-2\.0-Pro/i,kinds:['image'],quality:8,speed:6,styles:['typography'],label:'Qwen Image 2.0 Pro (Together)',note:'Alibaba pro tier; strong text rendering',source:'vendor tier naming'},
 {match:/Qwen-Image-2\.0/i,kinds:['image'],quality:7.5,speed:7,styles:['typography'],label:'Qwen Image 2.0 (Together)',note:'Alibaba current tier',source:'vendor version ordering'},
 {match:/Qwen-Qwen-Image$/i,kinds:['image'],quality:7,speed:7,label:'Qwen Image (Together)',note:'Alibaba first image model',source:'vendor version ordering'},
 {match:/Wan2\.6-image/i,kinds:['image'],quality:7,speed:7,label:'Wan 2.6 Image (Together)',note:'Alibaba Wan image variant',source:'vendor model naming'},
 {match:/stable-diffusion-xl/i,kinds:['image'],quality:5,speed:8,label:'SDXL (Together)',note:'2023 open model',source:'vendor version ordering'},
 {match:/^echo\.fal\.generate$/,kinds:['image'],quality:6,speed:9,cost:'paid-low',label:'fal.ai (FLUX schnell default)',note:'bounded $; default fal-ai/flux/schnell',source:'cap description (echo.fal.generate)'},
 {match:/^echo\.deepai\.image$/,kinds:['image'],quality:4,speed:7,cost:'paid-low',label:'DeepAI text2img',note:'COSTS $, generic',source:'cap description (echo.deepai.image)'},
 {match:/imagen_edit/i,kinds:['image-edit'],quality:7.5,speed:6,label:'Vertex Imagen edit',note:'needs base image',source:'cap description'},
 {match:/imagen_generate/i,kinds:['image'],quality:7.5,speed:6,styles:['photoreal'],label:'Vertex Imagen 3',note:'Vertex Imagen 3 predict',source:'cap description'},
 // video
 {match:/^echo\.media\.video_generate$/,kinds:['video'],quality:5,speed:3,cost:'free',label:'On-prem video (Wan2.2 TI2V-5B on TEMPER)',note:'$0 but owner-disabled on TEMPER (RAM budget); this client never passes force_video',source:'cap description; INTEGRATIONS.md 2026-10-27'},
 {match:/veo-3\.1-lite/i,kinds:['video'],quality:8,speed:7,label:'Veo 3.1 Lite (Together)',note:'Google current video, lite tier',source:'vendor tier naming'},
 {match:/veo-3\.1$/i,kinds:['video'],quality:9,speed:5,styles:['cinematic','photoreal'],cost:'paid-high',label:'Veo 3.1 (Together)',note:'Google current video tier',source:'vendor version ordering'},
 {match:/veo-3\.0-fast-audio/i,kinds:['video'],quality:8,speed:8,label:'Veo 3.0 Fast + Audio (Together)',note:'fast tier with audio',source:'vendor tier naming'},
 {match:/veo-3\.0-fast/i,kinds:['video'],quality:8,speed:8,label:'Veo 3.0 Fast (Together)',note:'fast tier',source:'vendor tier naming'},
 {match:/veo-3\.0-audio/i,kinds:['video'],quality:8.5,speed:5,styles:['cinematic'],cost:'paid-high',label:'Veo 3.0 + Audio (Together)',note:'standard tier with audio',source:'vendor tier naming'},
 {match:/veo-2\.0/i,kinds:['video'],quality:7,speed:6,label:'Veo 2.0 (Together)',note:'previous Google video tier',source:'vendor version ordering'},
 {match:/sora-2-pro/i,kinds:['video'],quality:9,speed:4,styles:['cinematic','photoreal'],cost:'paid-high',label:'Sora 2 Pro (Together)',note:'OpenAI pro video tier',source:'vendor tier naming'},
 {match:/sora-2$/i,kinds:['video'],quality:8.5,speed:5,styles:['cinematic'],cost:'paid-mid',label:'Sora 2 (Together)',note:'OpenAI standard video tier',source:'vendor tier naming'},
 {match:/kling-2\.1-master/i,kinds:['video'],quality:8.5,speed:4,styles:['cinematic'],cost:'paid-high',label:'Kling 2.1 Master (Together)',note:'Kuaishou top tier',source:'vendor tier naming (master > pro > standard)'},
 {match:/kling-2\.1-pro/i,kinds:['video'],quality:8,speed:5,cost:'paid-mid',label:'Kling 2.1 Pro (Together)',note:'Kuaishou pro tier',source:'vendor tier naming'},
 {match:/kling-2\.1-standard/i,kinds:['video'],quality:7,speed:6,label:'Kling 2.1 Standard (Together)',note:'Kuaishou standard tier',source:'vendor tier naming'},
 {match:/kling-1\.6/i,kinds:['video'],quality:6.5,speed:6,label:'Kling 1.6 Standard (Together)',note:'previous Kuaishou version',source:'vendor version ordering'},
 {match:/Seedance-2\.0/i,kinds:['video'],quality:8.5,speed:5,label:'Seedance 2.0 (Together)',note:'ByteDance current video tier',source:'vendor version ordering'},
 {match:/Seedance-1\.0-pro/i,kinds:['video'],quality:8,speed:5,cost:'paid-mid',label:'Seedance 1.0 Pro (Together)',note:'ByteDance pro tier',source:'vendor tier naming'},
 {match:/Seedance-1\.0-lite/i,kinds:['video'],quality:7,speed:7,label:'Seedance 1.0 Lite (Together)',note:'ByteDance lite tier',source:'vendor tier naming'},
 {match:/hailuo-02/i,kinds:['video'],quality:7.5,speed:6,label:'MiniMax Hailuo 02 (Together)',note:'MiniMax current video',source:'vendor version ordering'},
 {match:/video-01-director/i,kinds:['video'],quality:6.5,speed:6,label:'MiniMax 01 Director (Together)',note:'camera-direction variant, previous generation',source:'vendor model naming'},
 {match:/wan2\.7-t2v/i,kinds:['video'],quality:7.5,speed:6,label:'Wan 2.7 T2V (Together)',note:'Alibaba current text-to-video',source:'vendor version ordering'},
 {match:/wan2\.7-(?:i2v|r2v)/i,kinds:['video'],quality:7.5,speed:6,label:'Wan 2.7 I2V/R2V (Together)',note:'needs a source image/reference; not a text-only path',source:'vendor model naming (I2V = image-to-video)'},
 {match:/Wan2\.2-T2V/i,kinds:['video'],quality:7,speed:6,label:'Wan 2.2 T2V (Together)',note:'Alibaba previous text-to-video',source:'vendor version ordering'},
 {match:/Wan2\.2-I2V/i,kinds:['video'],quality:7,speed:6,label:'Wan 2.2 I2V (Together)',note:'needs a source image',source:'vendor model naming'},
 {match:/vidu-q3-turbo/i,kinds:['video'],quality:7,speed:8,label:'Vidu Q3 Turbo (Together)',note:'fast tier',source:'vendor tier naming'},
 {match:/vidu-q3/i,kinds:['video'],quality:7.5,speed:6,label:'Vidu Q3 (Together)',note:'Vidu current tier',source:'vendor version ordering'},
 {match:/vidu-q1/i,kinds:['video'],quality:6.5,speed:6,label:'Vidu Q1 (Together)',note:'previous Vidu tier',source:'vendor version ordering'},
 {match:/vidu-2\.0/i,kinds:['video'],quality:6,speed:6,label:'Vidu 2.0 (Together)',note:'older Vidu tier',source:'vendor version ordering'},
 {match:/pixverse-v6/i,kinds:['video'],quality:7.5,speed:6,label:'PixVerse v6 (Together)',note:'PixVerse current',source:'vendor version ordering'},
 {match:/pixverse-v5\.6/i,kinds:['video'],quality:7,speed:6,label:'PixVerse v5.6 (Together)',note:'PixVerse previous',source:'vendor version ordering'},
 {match:/pixverse-v5$/i,kinds:['video'],quality:6.5,speed:6,label:'PixVerse v5 (Together)',note:'PixVerse older',source:'vendor version ordering'},
 {match:/happyhorse-1\.1-t2v/i,kinds:['video'],quality:7,speed:6,label:'HappyHorse 1.1 T2V (Together)',note:'Alibaba HappyHorse current text-to-video',source:'vendor version ordering'},
 {match:/happyhorse-1\.[01]-(?:i2v|r2v)/i,kinds:['video'],quality:6.5,speed:6,label:'HappyHorse I2V/R2V (Together)',note:'needs a source image/reference',source:'vendor model naming'},
 {match:/happyhorse-1\.0-t2v/i,kinds:['video'],quality:6.5,speed:6,label:'HappyHorse 1.0 T2V (Together)',note:'previous HappyHorse',source:'vendor version ordering'},
 // music / sfx
 {match:/music_generation\.compose_detailed$/,kinds:['music'],quality:8,speed:5,cost:'quota',label:'ElevenLabs Music (detailed)',note:'compose with a detailed response (metadata + audio)',source:'cap description ([POST /v1/music/detailed])'},
 {match:/music_generation\.generate$/,kinds:['music'],quality:8,speed:5,cost:'quota',label:'ElevenLabs Music',note:'compose music from a prompt',source:'cap description ([POST /v1/music])'},
 {match:/music_generation\.stream_compose$/,kinds:['music'],quality:7,speed:6,cost:'quota',label:'ElevenLabs Music (stream)',note:'streaming variant; less useful for a saved artifact',source:'cap description'},
 {match:/^echo\.voice\.elevenlabs\.music$/,kinds:['music'],quality:7.5,speed:5,cost:'quota',label:'ElevenLabs Music (voice gateway)',note:'prompt -> music in MinIO; access-gated on some tiers',source:'cap description'},
 {match:/sound_generation\.sound_generation$/,kinds:['sfx'],quality:8,speed:8,cost:'quota',label:'ElevenLabs Sound Effects',note:'text -> sound effect',source:'cap description ([POST /v1/sound-generation])'},
 {match:/^echo\.voice\.elevenlabs\.sfx$/,kinds:['sfx'],quality:7.5,speed:8,cost:'quota',label:'ElevenLabs SFX (voice gateway)',note:'text -> sound effect audio in MinIO',source:'cap description'},
 // voice
 {match:/^echo\.elevenlabs\.tts$/,kinds:['voice'],quality:9,speed:8,cost:'quota',label:'ElevenLabs TTS (premium)',note:'premium speech; the fleet default voice is freeman (M Freeman, eleven_v4)',source:'cap description; fleet memory echo-tts-default-voice-freeman'},
 {match:/^echo\.voice\.speak$/,kinds:['voice'],quality:7.5,speed:8,cost:'free',label:'Echo Voice (unified TTS; chatterbox $0 default)',note:'chatterbox on-prem by default, ElevenLabs opt-in',source:'cap description (echo.voice.speak)'},
 {match:/^echo\.cartesia\.tts$/,kinds:['voice'],quality:8,speed:9,cost:'quota',label:'Cartesia TTS',note:'bounded speech <= 400 chars',source:'cap description (echo.cartesia.tts)'},
 {match:/^echo\.voice\.cartesia\.tts$/,kinds:['voice'],quality:8,speed:9,cost:'quota',label:'Cartesia TTS (voice gateway)',note:'sonic-2 / sonic-turbo',source:'cap description'},
 {match:/cartesia-sonic-3\.5/i,kinds:['voice'],quality:8,speed:9,label:'Cartesia Sonic 3.5 (Together)',note:'current Sonic tier',source:'vendor version ordering'},
 {match:/cartesia-sonic-3$/i,kinds:['voice'],quality:7.5,speed:9,label:'Cartesia Sonic 3 (Together)',note:'previous Sonic tier',source:'vendor version ordering'},
 {match:/cartesia-sonic(?:-2)?$/i,kinds:['voice'],quality:7,speed:9,label:'Cartesia Sonic 2 (Together)',note:'older Sonic tier',source:'vendor version ordering'},
 {match:/minimax-speech-2\.8/i,kinds:['voice'],quality:7.5,speed:8,label:'MiniMax Speech 2.8 Turbo (Together)',note:'current MiniMax speech',source:'vendor version ordering'},
 {match:/minimax-speech-2\.6/i,kinds:['voice'],quality:7,speed:8,label:'MiniMax Speech 2.6 Turbo (Together)',note:'previous MiniMax speech',source:'vendor version ordering'},
 {match:/rime-arcana-v3-turbo/i,kinds:['voice'],quality:7,speed:9,label:'Rime Arcana v3 Turbo (Together)',note:'fast tier',source:'vendor tier naming'},
 {match:/rime-arcana-v3/i,kinds:['voice'],quality:7.5,speed:7,label:'Rime Arcana v3 (Together)',note:'current Rime tier',source:'vendor version ordering'},
 {match:/rime-arcana-v2|rime-mist/i,kinds:['voice'],quality:6.5,speed:8,label:'Rime (Together)',note:'previous Rime tiers',source:'vendor version ordering'},
 {match:/deepgram-aura-2/i,kinds:['voice'],quality:7,speed:9,label:'Deepgram Aura 2 (Together)',note:'low-latency TTS',source:'vendor positioning'},
 {match:/orpheus-3b/i,kinds:['voice'],quality:6.5,speed:7,label:'Orpheus 3B (Together)',note:'open TTS model',source:'vendor model naming'},
 {match:/Kokoro-82M/i,kinds:['voice'],quality:6,speed:10,label:'Kokoro 82M (Together)',note:'tiny open TTS, fastest',source:'vendor model naming'},
 {match:/^echo\.aws\.polly_tts$/,kinds:['voice'],quality:6.5,speed:9,cost:'paid-low',label:'Amazon Polly',note:'base64 audio',source:'cap description'},
 {match:/^echo\.azure\.cognitive_speech_tts$/,kinds:['voice'],quality:7,speed:9,cost:'paid-low',label:'Azure Speech TTS',note:'SSML, base64 audio',source:'cap description'},
 {match:/^echo\.google\.speech\.tts$/,kinds:['voice'],quality:7,speed:9,cost:'paid-low',label:'Google Cloud TTS',note:'Cloud TTS synthesize',source:'cap description'},
 {match:/^echo\.voice\.openai\.tts$/,kinds:['voice'],quality:7.5,speed:8,cost:'paid-low',label:'OpenAI TTS',note:'tts-1 / gpt-4o-mini-tts',source:'cap description'},
 {match:/^echo\.voice\.deepgram\.tts$/,kinds:['voice'],quality:7,speed:9,cost:'paid-low',label:'Deepgram Aura (voice gateway)',note:'needs a vaulted key (503 noted in description)',source:'cap description'},
 {match:/^echo\.echo_talk\.speak$/,kinds:['voice'],quality:6,speed:6,cost:'free',label:'ECHO_TALK pipeline',note:'full ARCS -> TTS pipeline, not a plain synthesizer',source:'cap description'},
 {match:/^echo\.personality\.speak$/,kinds:['voice'],quality:7,speed:7,label:'Personality Forge voice',note:'persona-configured TTS',source:'cap description'},
];
const EXCLUDE=/\b(?:DEPRECATED|RETIRED)\b|test-debug|Duplicate Test|video_retrieve|video_to_music|stem|upload|finetune|dubbing|\.dub$|isolat|infill|voice_changer|voice_design|\.stt$|transcri|translate|personas|configure_persona|\.batch$|synthesize_stream|progressive|turn_state|interrupt|\.voices$|job_status|\.backends$|\.artifact$|\.status$|compose_plan|forgeplugin|\.synthesize$|\.tts\.named$|\.tts\.batch$|openrouter\.openai-gpt-audio|^echo\.llm\.(?!together\.|openrouter\.|fireworks\.)/i;
const KIND_HINT:[MediaKind,RegExp][]=[
 ['image-edit',/kontext|imagen_edit|img2img|image[- ]to[- ]image/i],
 ['video',/type=video|video_generate|-t2v|-i2v|-r2v|T2V|I2V|veo-|sora-|kling-|seedance|hailuo|vidu-|pixverse|happyhorse|video-01/i],
 ['music',/music_generation|elevenlabs\.music$|compose music/i],
 ['sfx',/sound_generation|\.sfx$|sound effect/i],
 ['voice',/\btts\b|text-to-speech|\.speak$|synthesize speech|type=audio|polly|cognitive_speech|speech\.tts|minimax-speech|orpheus|kokoro|sonic|aura|rime-/i],
 ['image',/type=image|text-to-image|text2img|image_generate|imagen|flux|seedream|ideogram|stable-diffusion|qwen-image|wan2\.6-image|-image(?:-preview)?$|gpt-image|gpt-5(?:\.\d)?-image|flash-image|deepai\.image|fal\.generate/i],
];
export interface Candidate {
 id:string;label:string;provider:string;kinds:MediaKind[];styles:StyleCue[];quality:number;speed:number;cost:CostTier;costNote:string;
 /** Where the health came from: the shipped snapshot, the live catalog search, a live read of this one id, or nowhere. */
 health:string;healthSource:'snapshot'|'catalog'|'probe'|'none';fit:number;score:number;reasons:string[];node?:string;
 /** Whether the live catalog listed this id for this route ('live') or only the shipped snapshot did ('snapshot'). */
 catalogSource:'live'|'snapshot';
 argumentShape:'modeled'|'unmodeled';rankingSource:string;note:string;
 /** A reason this candidate cannot be used right now; such candidates are listed under `excluded`, never picked. */
 unavailable?:string;
}
function providerOf(id:string):string{
 if(/^echo\.media\./.test(id))return 'On-prem media router';
 if(/^echo\.image\.qwen\./.test(id))return 'TEMPER Qwen Image';
 if(/^echo\.image\./.test(id))return 'FORGE diffusers';
 if(/^echo\.llm\.together\./.test(id))return 'Together AI';
 if(/^echo\.llm\.openrouter\./.test(id))return 'OpenRouter';
 if(/^echo\.llm\.fireworks\./.test(id))return 'Fireworks';
 if(/^echo\.fal\./.test(id))return 'fal.ai';
 if(/^echo\.deepai\./.test(id))return 'DeepAI';
 if(/elevenlabs/.test(id))return 'ElevenLabs';
 if(/cartesia/.test(id))return 'Cartesia';
 if(/^echo\.voice\.speak$/.test(id))return 'Echo Voice';
 if(/^echo\.aws\./.test(id))return 'Amazon';
 if(/^echo\.azure\./.test(id))return 'Azure';
 if(/^echo\.google\./.test(id))return 'Google Cloud';
 if(/^echo\.voice\.openai\./.test(id))return 'OpenAI';
 if(/^echo\.voice\.deepgram\./.test(id))return 'Deepgram';
 return id.split('.').slice(1,2)[0]??'unknown';
}
function costOf(c:Capability,ranking:Ranking|undefined):{cost:CostTier;note:string}{
 const d=c.description||'';
 if(ranking?.cost)return {cost:ranking.cost,note:ranking.cost==='free'?'$0 on-prem':ranking.cost==='quota'?'uses provider quota':'provider charges apply'};
 if(/\$0|on-prem|free/i.test(d))return {cost:'free',note:'$0 on-prem'};
 if(/COSTS QUOTA|quota/i.test(d))return {cost:'quota',note:'uses provider quota'};
 if(/COSTS \$/i.test(d))return {cost:'paid-low',note:'provider charges apply'};
 if(/\b(?:max|ultra|master|pro)\b/i.test(c.id))return {cost:'paid-mid',note:'premium tier; provider charges apply'};
 return {cost:'paid-low',note:'provider charges apply'};
}
/** The SDK command for a capability. The `echo.llm.*` model caps share one uniform command, `call` (registry schemas:
 * `command` "Uniform SDK command (call)"; the LLM router accepts {command:"call",options:{...}}); their ids carry model
 * versions with dots ("…FLUX.2-max"), so the last id segment is not a verb there. Other families use the id's last segment. */
function verbOf(id:string):string{return /^echo\.llm\./.test(id)?'call':id.split('.').at(-1)||'generate';}
/** Builds the exact Studio request for a pick. Shapes follow the registry's own examples ({command:<verb>,options:{...}});
 * families whose extra fields are known get them, everything else is flagged `unmodeled` so the Studio review shows it. */
export function buildArguments(id:string,kind:MediaKind,text:string,classification?:Pick<Classification,'styles'|'aspect'|'durationSeconds'>):{arguments:Json;shape:'modeled'|'unmodeled'}{
 const verb=verbOf(id),prompt=text.trim();
 const options:Json={};
 if(id==='echo.media.image_generate'){
  options.prompt=prompt;options.wait=false;
  if(classification?.styles.includes('anime'))options.style='anime';else if(classification?.styles.includes('photoreal'))options.style='photoreal';
  if(classification?.aspect==='16:9'){options.width=1024;options.height=576;}else if(classification?.aspect==='9:16'){options.width=576;options.height=1024;}else if(classification?.aspect==='21:9'){options.width=1344;options.height=576;}
  return {arguments:{command:verb,options},shape:'modeled'};
 }
 if(id==='echo.media.video_generate')return {arguments:{command:verb,options:{prompt,wait:false}},shape:'modeled'};
 if(/^echo\.(?:image\.generate|image\.qwen\.generate|fal\.generate|deepai\.image)$/.test(id))return {arguments:{command:verb,options:{prompt}},shape:'modeled'};
 if(/^echo\.llm\.(?:together|openrouter|fireworks)\./.test(id)&&(kind==='image'||kind==='video'))return {arguments:{command:verb,options:{prompt}},shape:'modeled'};
 if(/music_generation\.(?:generate|compose_detailed)$/.test(id))return {arguments:{command:verb,options:{prompt,...(classification?.durationSeconds?{music_length_ms:classification.durationSeconds*1000}:{})}},shape:'modeled'};
 if(/sound_generation\.sound_generation$/.test(id))return {arguments:{command:verb,options:{text:prompt,...(classification?.durationSeconds?{duration_seconds:Math.min(30,classification.durationSeconds)}:{})}},shape:'modeled'};
 if(/^echo\.(?:voice\.speak|elevenlabs\.tts|cartesia\.tts|voice\.cartesia\.tts|voice\.elevenlabs\.tts|aws\.polly_tts|azure\.cognitive_speech_tts|voice\.elevenlabs\.sfx|voice\.elevenlabs\.music)$/.test(id))return {arguments:{command:verb,options:{text:prompt}},shape:'modeled'};
 return {arguments:{command:verb,options:kind==='voice'||kind==='sfx'?{text:prompt}:{prompt}},shape:'unmodeled'};
}
/** Reads a capability record (snapshot or live) into a ranked candidate, or null when it is not a generator for any kind. */
export function describeCandidate(c:Capability):Candidate|null{
 const haystack=c.id+' '+(c.description||'');
 if(EXCLUDE.test(haystack))return null;
 const ranking=RANKING.find(r=>r.match.test(c.id));
 let kinds:MediaKind[]=ranking?[...ranking.kinds]:[];
 if(!kinds.length){const hit=KIND_HINT.find(([,rx])=>rx.test(haystack));if(!hit)return null;kinds=[hit[0]];}
 const {cost,note:costNote}=costOf(c,ranking),health=String(c.health||'unknown').toLowerCase();
 const candidate:Candidate={
  id:c.id,label:ranking?.label??c.id.replace(/^echo\./,''),provider:providerOf(c.id),kinds,styles:ranking?.styles??[],quality:ranking?.quality??5,speed:ranking?.speed??5,
  cost,costNote,health,healthSource:c.health?'snapshot':'none',fit:0,score:0,reasons:[],node:(c as {node?:string}).node,catalogSource:'snapshot',
  argumentShape:'unmodeled',rankingSource:ranking?.source??'unranked default (quality 5, speed 5)',note:ranking?.note??'',
 };
 if(c.registered===false)candidate.unavailable='not registered';
 else if((HEALTH_WEIGHT[health]??0.6)===0)candidate.unavailable='health '+health+' (the Studio refuses it at review)';
 else if(c.id==='echo.media.video_generate')candidate.unavailable='owner-disabled on TEMPER (RAM budget); this client never force-enables video';
 else if(/-(?:i2v|r2v)\b|I2V|kontext|imagen_edit/i.test(c.id))candidate.unavailable='needs a source image the capability reads itself; Auto never prepares it from a text-only brief (attach a reference in the Studio and pick it yourself)';
 return candidate;
}
export interface RankOptions {text:string;styles?:StyleCue[];aspect?:Aspect;durationSeconds?:number;
 /** Ids the live catalog listed for this route: their record (health, registration) is the live one, not the snapshot's. */
 live?:ReadonlySet<string>}
export interface RankResult {candidates:Candidate[];excluded:Candidate[]}
/** Deterministic ranking: fit x health x cost x quality (x a light speed factor). Ties: health, cost, quality, id. */
export function rankCandidates(kind:MediaKind,catalog:Capability[],options:RankOptions):RankResult{
 const styles=options.styles??[],candidates:Candidate[]=[],excluded:Candidate[]=[];
 for(const c of catalog){
  const cand=describeCandidate(c);if(!cand||!cand.kinds.includes(kind))continue;
  if(options.live?.has(cand.id)){cand.catalogSource='live';cand.healthSource='catalog';}
  const matched=cand.styles.filter(s=>styles.includes(s));
  cand.fit=1+Math.min(0.3,0.15*matched.length);
  if(cand.id==='echo.cartesia.tts'&&options.text.length>400)cand.unavailable='text longer than the 400-character Cartesia bound';
  const healthWeight=HEALTH_WEIGHT[cand.health]??0.6;
  cand.score=Math.round(cand.fit*healthWeight*COST_WEIGHT[cand.cost]*(cand.quality/10)*(0.85+0.015*cand.speed)*1000)/1000;
  cand.reasons=[kind+(matched.length?' + '+matched.join(', '):''),'health '+cand.health+(cand.healthSource==='probe'?' (probed now)':cand.healthSource==='catalog'?' (live catalog)':cand.healthSource==='snapshot'?' (snapshot)':' (unknown)'),cand.costNote,'quality '+cand.quality+'/10, speed '+cand.speed+'/10'];
  if(cand.catalogSource==='snapshot')cand.reasons.push('listed only in the shipped snapshot');
  const built=buildArguments(cand.id,kind,options.text,{styles,aspect:options.aspect,durationSeconds:options.durationSeconds});cand.argumentShape=built.shape;
  if(cand.argumentShape==='unmodeled')cand.reasons.push('argument shape not modeled; review the request details');
  (cand.unavailable?excluded:candidates).push(cand);
 }
 const order=(a:Candidate,b:Candidate)=>b.score-a.score||(HEALTH_WEIGHT[b.health]??0.6)-(HEALTH_WEIGHT[a.health]??0.6)||COST_WEIGHT[b.cost]-COST_WEIGHT[a.cost]||b.quality-a.quality||a.id.localeCompare(b.id);
 candidates.sort(order);excluded.sort(order);
 return {candidates,excluded};
}

// ---- live catalog ----------------------------------------------------------------------------------------------------
export type GenerationKind=Exclude<MediaKind,'chat'>;
/** Kind-scoped searches of the live SDK catalog (through the SDK broker). Distinctive tokens keep each answer under the
 * broker's 100-row bound; a truncated or failed answer is reported in `catalog.failed`, never dropped silently. */
export const MEDIA_SEARCHES:Readonly<Record<GenerationKind,readonly string[]>>={
 image:['image_generate','text-to-image','flux','imagen'],
 'image-edit':['kontext','imagen_edit','image edit'],
 video:['video_generate','text-to-video','veo','sora'],
 music:['music_generation','compose music'],
 sfx:['sound_generation','sound effect'],
 voice:['text to speech','elevenlabs tts','cartesia'],
};
/** The Studio medium a discovered id is filed under when the snapshot does not already list it. */
export const CATEGORY_OF_KIND:Readonly<Record<GenerationKind,string>>={image:'image','image-edit':'image',video:'video',music:'music',sfx:'sound',voice:'voice'};
export const CAPABILITY_ID=/^echo\.[A-Za-z0-9_.-]{1,180}$/;
const CATALOG_CACHE_MS=60000,CATALOG_MAX_ROWS=100;
export interface CatalogReport {
 /** live: every search answered · partial: some failed · snapshot: no live catalog (not configured or every search failed) · none: nothing was ranked (chat). */
 source:'live'|'partial'|'snapshot'|'none';
 queries:string[];
 /** Distinct capability ids the live searches listed for this kind. */
 listed:number;
 failed:{query:string;reason:string}[];
 /** The live answer is reused for 60 s per kind. */
 cached:boolean;
 reason?:string;
}
/** A capability row as the browser Studio needs it to select a live-only pick (no secrets: the catalog's own public fields). */
export interface CatalogRecord {id:string;registered:boolean;health:string;category:string;description:string;scope?:string;tier?:number}
function liveRow(row:unknown,kind:GenerationKind):Capability|null{
 const r=obj(row);
 if(typeof r.id!=='string'||!CAPABILITY_ID.test(r.id))return null;
 const health=String(r.health??'unknown').toLowerCase().slice(0,32)||'unknown';
 return {id:r.id,registered:r.registered!==false,health,category:CATEGORY_OF_KIND[kind],description:typeof r.description==='string'?r.description.slice(0,600):'',
  ...(typeof r.scope==='string'&&r.scope?{scope:r.scope.slice(0,120)}:{}),...(typeof r.tier==='number'&&Number.isFinite(r.tier)?{tier:r.tier}:{})};
}
/** Overlays live rows on the snapshot: the live record's registration, health, description and scope win; the snapshot's
 * Studio medium (category) and node are kept so the Studio filters still find the tool. */
export function mergeCatalog(snapshot:Capability[],live:Capability[]):Capability[]{
 const byId=new Map(snapshot.map(c=>[c.id,c] as const));
 for(const row of live){
  const old=byId.get(row.id);
  byId.set(row.id,old?{...old,registered:row.registered,health:row.health,description:row.description||old.description,...(row.scope?{scope:row.scope}:{}),...(row.tier!==undefined?{tier:row.tier}:{})}:row);
 }
 return [...byId.values()];
}
const catalogRecord=(c:Capability):CatalogRecord=>({id:c.id,registered:c.registered,health:c.health,category:c.category,description:c.description,...(c.scope?{scope:c.scope}:{}),...(c.tier!==undefined?{tier:c.tier}:{})});

// ---- router ----------------------------------------------------------------------------------------------------------
export interface MediaPick {id:string;
 /** The SDK capability id (same as `id`; the contract name the UI and docs use). */
 cap:string;label:string;provider:string;reason:string;health:string;healthSource:Candidate['healthSource'];catalogSource:Candidate['catalogSource'];cost:CostTier;costNote:string;quality:number;speed:number;score:number;argumentShape:Candidate['argumentShape'];note:string;request:{target:'sdk';name:string;arguments:Json}}
export interface RouteResult {
 classification:Classification;picked:MediaPick|null;alternatives:MediaPick[];excluded:{id:string;label:string;reason:string}[];
 /** Why nothing was picked (chat, image-edit without a source, or no healthy generator for the kind). */
 reason?:string;probe:{probed:string[];source:'none'|'cached'|'live'|'mixed'};
 /** Which catalog the ranking used: the live SDK catalog, part of it, or only the shipped snapshot (and why). */
 catalog:CatalogReport;
 /** Catalog rows for the pick and the alternatives, so the Studio can select a tool only the live catalog lists. */
 records:CatalogRecord[];
}
export interface MediaRouterOptions {
 catalog:()=>Capability[];
 /** The same read `PrimeHub.prepare` uses: the live record carries `health_status` and `registration_state`. */
 read?:(id:string)=>Promise<unknown>;
 /** The live SDK catalog search (the broker's `sdk.search`). Absent = no live catalog: the route says it ranked the snapshot. */
 search?:(query:string)=>Promise<unknown>;
 /** Told about live rows once a search answers (the hub keeps them in its catalog, like `/api/search`). */
 onDiscovered?:(rows:Capability[])=>void;
 models?:ModelRouter;now?:()=>number;probeTimeoutMs?:number;probeCount?:number;classifierTimeoutMs?:number;searchTimeoutMs?:number;
}
const PROBE_CACHE_MS=60000;
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
async function within<T>(work:Promise<T>,ms:number,label:string,signal?:AbortSignal):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
 try{
  return await Promise.race([work,new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(new Error(label+' timed out after '+Math.round(ms/1000)+' s')),ms);
   if(signal){onAbort=()=>reject(new Error('Interrupted'));if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});}
  })]);
 }finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
}
export class MediaRouter {
 private probes=new Map<string,{at:number;health:string}>();
 private discovered=new Map<GenerationKind,{at:number;rows:Capability[];failed:{query:string;reason:string}[]}>();
 private now:()=>number;
 constructor(private options:MediaRouterOptions){this.now=options.now??Date.now;}
 private report(queries:string[],rows:Capability[],failed:{query:string;reason:string}[],cached:boolean):CatalogReport{
  const base={queries,listed:rows.length,failed,cached};
  if(!failed.length)return {source:'live',...base};
  if(failed.length<queries.length)return {source:'partial',...base,reason:failed.length+' of '+queries.length+' live catalog searches failed ('+failed.map(f=>'"'+f.query+'"').join(', ')+'); tools only those searches would list are ranked from the shipped snapshot.'};
  return {source:'snapshot',...base,reason:'Every live catalog search failed (first: '+failed[0].reason+'); ranked from the shipped catalog snapshot, whose health may be stale. Review re-checks the tool live before anything runs.'};
 }
 /** Bounded, kind-scoped live catalog discovery: the kind's searches in parallel, each with its own timeout, cached 60 s
  * per kind once at least one answered. Never throws for a failed search; the report names every failure. */
 private async discover(kind:GenerationKind,signal?:AbortSignal):Promise<{rows:Capability[];report:CatalogReport}>{
  const queries=[...MEDIA_SEARCHES[kind]];
  if(!this.options.search)return {rows:[],report:{source:'snapshot',queries:[],listed:0,failed:[],cached:false,reason:'The live capability catalog is not connected (the Prime config has no `sdk` section); ranked from the shipped catalog snapshot, whose health may be stale.'}};
  const hit=this.discovered.get(kind);
  if(hit&&this.now()-hit.at<CATALOG_CACHE_MS)return {rows:hit.rows,report:this.report(queries,hit.rows,hit.failed,true)};
  const failures=new Map<string,string>(),byId=new Map<string,Capability>();
  await Promise.all(queries.map(async query=>{
   try{
    const rows=await within(this.options.search!(query),this.options.searchTimeoutMs??5000,'Catalog search',signal);
    if(!Array.isArray(rows))throw new Error('the catalog answer was not a list');
    if(rows.length>CATALOG_MAX_ROWS)throw new Error('the catalog answered '+rows.length+' rows, over the '+CATALOG_MAX_ROWS+'-row bound');
    for(const row of rows){const c=liveRow(row,kind);if(c&&!byId.has(c.id))byId.set(c.id,c);}
   }catch(error){failures.set(query,error instanceof Error?redact(error.message).slice(0,160):'search failed');}
  }));
  if(signal?.aborted)throw new MediaError(499,'Interrupted');
  const rows=[...byId.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),failed=queries.filter(q=>failures.has(q)).map(query=>({query,reason:failures.get(query)!}));
  debug('%j',{event:'prime_media_catalog',kind,queries:queries.length,listed:rows.length,failed:failed.length});
  if(failed.length<queries.length){this.discovered.set(kind,{at:this.now(),rows,failed});this.options.onDiscovered?.(rows);}
  return {rows,report:this.report(queries,rows,failed,false)};
 }
 /** Live health for one capability: the hub's read (unwrapped by the caller), cached 60 s. Never throws: an unreadable record is `unknown`. */
 private async probe(id:string,signal?:AbortSignal):Promise<{health:string;source:'cached'|'live'}>{
  const cached=this.probes.get(id);
  if(cached&&this.now()-cached.at<PROBE_CACHE_MS)return {health:cached.health,source:'cached'};
  let health='unknown';
  try{
   const record=obj(await Promise.race([this.options.read!(id),new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error('probe timed out')),this.options.probeTimeoutMs??5000);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('Interrupted'));},{once:true});})]));
   const state=String(record.registration_state??''),status=String(record.health_status??'').toLowerCase();
   health=state&&state!=='registered'?'unregistered':status||'unknown';
  }catch(error){debug('%j',{event:'prime_media_probe_failed',id,reason:error instanceof Error?redact(error.message).slice(0,120):'failed'});}
  this.probes.set(id,{at:this.now(),health});
  return {health,source:'live'};
 }
 private toPick(c:Candidate,kind:MediaKind,text:string,classification:Classification):MediaPick{
  const built=buildArguments(c.id,kind,text,classification);
  return {id:c.id,cap:c.id,label:c.label,provider:c.provider,reason:'Picked '+c.label+' because '+c.reasons.join(' · '),health:c.health,healthSource:c.healthSource,catalogSource:c.catalogSource,cost:c.cost,costNote:c.costNote,quality:c.quality,speed:c.speed,score:c.score,argumentShape:c.argumentShape,note:c.note,request:{target:'sdk',name:c.id,arguments:built.arguments}};
 }
 /** The one entry point. `mode` is a Studio/composer tab ('auto' or a kind); `fallback` says what an unclassifiable prompt means (Studio: image, composer: chat). */
 async route(input:unknown,signal?:AbortSignal):Promise<RouteResult>{
  const data=obj(input);
  if(Object.keys(data).some(k=>!['text','mode','fallback','probe','classifier'].includes(k)))throw new MediaError(400,'Invalid media request');
  if(typeof data.text!=='string'||!data.text.trim())throw new MediaError(400,'Enter a prompt to route');
  if(data.text.length>MEDIA_MAX_TEXT)throw new MediaError(400,'Prompt exceeds '+MEDIA_MAX_TEXT+' characters');
  if(data.mode!==undefined&&data.mode!=='auto'&&!MEDIA_KINDS.includes(data.mode as MediaKind))throw new MediaError(400,'Invalid media mode');
  if(data.fallback!==undefined&&data.fallback!=='image'&&data.fallback!=='chat')throw new MediaError(400,'Invalid media fallback');
  if(data.probe!==undefined&&typeof data.probe!=='boolean')throw new MediaError(400,'Invalid media request');
  if(data.classifier!==undefined&&typeof data.classifier!=='boolean')throw new MediaError(400,'Invalid media request');
  const text=data.text,started=this.now();
  let classification=classifyPrompt(text,{hint:(data.mode as MediaKind|'auto'|undefined)??'auto',fallback:(data.fallback as 'image'|'chat'|undefined)??'image'});
  // One short Qwen call sharpens a rules result that is not already near-certain; a chosen mode tab (source 'hint') is never second-guessed.
  if(this.options.models&&data.classifier!==false&&classification.source==='rules'&&classification.confidence<0.9){
   classification=await classifyWithModel(this.options.models,text,classification,{timeoutMs:this.options.classifierTimeoutMs,signal});
  }
  const probe:RouteResult['probe']={probed:[],source:'none'};
  const kind=classification.kind;
  if(kind==='chat'){
   debug('%j',{event:'prime_media_routed',kind,picked:null,durationMs:this.now()-started});
   return {classification,picked:null,alternatives:[],excluded:[],reason:'This reads as a conversation, not a media request; it goes to chat unless you pick a creation mode.',probe,catalog:{source:'none',queries:[],listed:0,failed:[],cached:false},records:[]};
  }
  // Classify first, then ask the live catalog about that one kind only.
  const discovery=await this.discover(kind,signal);
  const base=mergeCatalog(this.options.catalog(),discovery.rows),listed=new Set(discovery.rows.map(c=>c.id));
  const rankWith=(catalog:Capability[])=>rankCandidates(kind,catalog,{text,styles:classification.styles,aspect:classification.aspect,durationSeconds:classification.durationSeconds,live:listed});
  let ranked=rankWith(base);
  if(this.options.read&&data.probe!==false&&ranked.candidates.length){
   const top=ranked.candidates.slice(0,this.options.probeCount??3),results=await Promise.all(top.map(c=>this.probe(c.id,signal)));
   const live=new Map(top.map((c,i)=>[c.id,results[i]] as const));
   probe.probed=top.map(c=>c.id);
   const sources=new Set(results.map(r=>r.source));probe.source=sources.size>1?'mixed':sources.has('live')?'live':'cached';
   ranked=rankWith(base.map(c=>{const r=live.get(c.id);return r?{...c,health:r.health}:c;}));
   for(const c of [...ranked.candidates,...ranked.excluded])if(live.has(c.id)){c.healthSource='probe';c.reasons=c.reasons.map(r=>r.startsWith('health ')?'health '+c.health+' (probed now)':r);}
  }
  const picks=ranked.candidates.map(c=>this.toPick(c,kind,text,classification));
  const excluded=ranked.excluded.slice(0,8).map(c=>({id:c.id,label:c.label,reason:c.unavailable!}));
  let reason:string|undefined;
  if(kind==='image-edit')reason='This asks to edit an existing image. Auto does not prepare edits: attach the source image in the Studio (Library → Use in Studio) and pick one of the editing-capable tools listed below yourself. Nothing was prepared.';
  else if(!picks.length)reason='No healthy '+kind+' generator is listed in the catalog right now; nothing was prepared and no other kind was substituted.';
  const picked=kind==='image-edit'?null:picks[0]??null;
  const alternatives=(kind==='image-edit'?picks:picks.slice(1)).slice(0,6);
  const byId=new Map(base.map(c=>[c.id,c] as const));
  // The record carries the health the pick was ranked with (a probe result when one ran).
  const records=[...(picked?[picked]:[]),...alternatives].flatMap(p=>{const c=byId.get(p.id);return c?[{...catalogRecord(c),health:p.health}]:[];});
  debug('%j',{event:'prime_media_routed',kind,confidence:classification.confidence,source:classification.source,picked:picked?.id??null,alternatives:alternatives.length,excluded:excluded.length,probed:probe.probed.length,catalog:discovery.report.source,listed:discovery.report.listed,durationMs:this.now()-started});
  return {classification,picked,alternatives,excluded,...(reason?{reason}:{}),probe,catalog:discovery.report,records};
 }
}
