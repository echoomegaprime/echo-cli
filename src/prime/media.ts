import {debuglog} from 'node:util';
import {redact} from '../code/workspace.js';
import type {Capability, Json} from './hub.js';
import type {AnswerInfo, ModelRouter} from '../code/model-factory.js';
import {WorkspaceHttpError} from './workspace.js';
import type {MediaOutcomes} from './media-outcomes.js';
import {DEFAULT_GATE_CALL_KINDS} from './media-collect.js';
import {ADULT_STYLES,ROUTER_CAP_IDS,adultFields,adultPolicy,classifyAdult,isRouterCap,type AdultRefusalCode,type AdultStyle} from './adult.js';
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
/** "an orchestral soundtrack for a trailer", "sound effects for a video game", "epic trailer music": once another medium is
 * named, a video noun that only says what the thing is FOR (or modifies an audio noun) does not vote for video. */
const PICTURE_NOUN='(?:video(?:\\s+game)?|trailer|clip|footage|reels?|animation|film|movie)s?';
const FOR_PICTURE=new RegExp('\\b(?:for|to|over|behind|under)\\s+(?:(?:a|an|the|my|our|this|your|some)\\s+)?(?:[\\w-]+\\s+){0,2}?'+PICTURE_NOUN+'\\b'
 +'|\\b'+PICTURE_NOUN+'\\s+(?=(?:music|score|soundtrack|theme|song|jingle|sound effects?|sfx|sounds?|foley|voice-?over|narration)\\b)','gi');
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
 for(const [kind,rules] of Object.entries(KIND_RULES) as [MediaKind,Rule[]][])if(kind!=='video')for(const [rx,weight,signal] of rules)if(rx.test(body))add(kind,weight,signal);
 // Video scores last: when another medium was named (not just the generic scene phrase), "for a trailer" does not count.
 const named=[...scores.values()].some(row=>row.signals.some(s=>s!=='scene-phrase'));
 const videoBody=named?body.replace(FOR_PICTURE,' '):body;
 for(const [rx,weight,signal] of KIND_RULES.video)if(rx.test(videoBody))add('video',weight,signal);
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
 {match:/^echo\.media\.video_generate$/,kinds:['video'],quality:5,speed:3,cost:'free',label:'On-prem video (Wan2.2 TI2V-5B on TEMPER)',note:'$0; runs only for a model with a passing canary when the router admits it (v1 router: owner-disabled on TEMPER, RAM budget); this client never passes force_video',source:'cap description; INTEGRATIONS.md 2026-10-27'},
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
/** Capability ids that are not generation entry points at all: job polls and status reads, listings, artifact fetches,
 * transcription and translation, transforms of existing audio (stems, isolation, dubbing, voice changers, infill), music
 * fine-tune management, persona configuration, streaming/turn plumbing, batch wrappers and audio chat models. Matched
 * against the capability id only, one whole id token at a time (tokens are separated by `.`, `_` or `-`): registry
 * descriptions mention these words in passing ("poll echo.media.job_status", "system?", "MinIO upload"), so testing the
 * description would silently drop real generators. A RANKING row never names one of these ids (tests/prime-media.test.ts
 * checks that against the shipped catalog). */
export const NOT_A_GENERATOR=/(?:^|[._-])(?:job_status|status|backends|artifacts?|voices|video_retrieve|video_to_music|stems?|upload|finetunes?|dub|dubbing|dubbed|isolate|isolation|infill|voice_changer|voice_design|stt|speech_to_text|transcribe|transcription|transcripts?|translate|translation|personas|configure_persona|batch|synthesize_stream|progressive|turn_state|interrupt|compose_plan|forgeplugin|openai-gpt-audio)(?=$|[._-])/i;
/** The registry's own lifecycle markers. A generator that carries one is listed under `excluded` with the marker as its
 * reason; it is never ranked and never dropped silently. Only the registry's uppercase markers count, so prose such as
 * "replaces the deprecated alias" is not a marker. */
function lifecycleOf(c:Capability):string|undefined{
 const description=c.description||'',marker=/\b(DEPRECATED|RETIRED)\b(?:\s*->\s*(?:use\s+)?([^\]]{1,120}))?/.exec(description);
 if(marker)return 'marked '+marker[1]+' in the registry'+(marker[2]?' (use '+marker[2].trim()+' instead)':'');
 if(/\bDuplicate Test\b/.test(description))return 'a registry duplicate test entry, not a production route';
 if(/(?:^|[._-])test-debug$/i.test(c.id))return 'a registry test/debug entry, not a production route';
 return undefined;
}
/** Kind guesses for ids RANKING does not list. Each pattern is tested against the id and the description separately, so
 * the `$` anchors bind to the end of the id. */
const KIND_HINT:[MediaKind,RegExp][]=[
 ['image-edit',/kontext|imagen_edit|img2img|image[- ]to[- ]image/i],
 ['video',/type=video|video_generate|-t2v|-i2v|-r2v|T2V|I2V|veo-|sora-|kling-|seedance|hailuo|vidu-|pixverse|happyhorse|video-01/i],
 ['music',/music_generation|elevenlabs\.music$|compose music/i],
 ['sfx',/sound_generation|\.sfx$|sound effect/i],
 ['voice',/\btts\b|text-to-speech|\.speak$|synthesize speech|type=audio|polly|cognitive_speech|speech\.tts|minimax-speech|orpheus|kokoro|\bsonic\b|\baura\b|\brime-/i],
 ['image',/type=image|text-to-image|text2img|image_generate|\bimagen|\bflux\b|seedream|ideogram|stable-diffusion|qwen-image|wan2\.6-image|-image(?:-preview)?$|gpt-image|gpt-5(?:\.\d)?-image|flash-image|deepai\.image|fal\.generate/i],
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
 /** Set when a recent real run (or a billing refusal on its provider) lowered its score. */
 demoted?:{category:string;reason:string};
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
 * `command` "Uniform SDK command (call)"); their ids carry model versions with dots ("…FLUX.2-max"), so the last id segment
 * is not a verb there. Other families use the id's last segment. */
function verbOf(id:string):string{return /^echo\.llm\./.test(id)?'call':id.split('.').at(-1)||'generate';}
/** How the registry says a capability takes its arguments: the live record (`echo.caps.detail` through the SDK read)
 * carries `handler_kind`, `args_mode` and the parameter list parsed from `input_schema_json` (envelope keys hidden). */
export interface CapShape {handlerKind?:string;argsMode?:string;params:{name:string;required:boolean}[]}
export function shapeOf(record:unknown):CapShape|undefined{
 const c=obj(obj(record).capability);
 const handlerKind=typeof c.handler_kind==='string'&&c.handler_kind?c.handler_kind.slice(0,40):undefined,argsMode=typeof c.args_mode==='string'&&c.args_mode?c.args_mode.slice(0,40):undefined;
 const params=Array.isArray(c.params)?c.params.slice(0,64).flatMap(p=>{const r=obj(p);return typeof r.name==='string'&&/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(r.name)?[{name:r.name,required:r.required===true}]:[];}):[];
 return handlerKind||params.length?{...(handlerKind?{handlerKind}:{}),...(argsMode?{argsMode}:{}),params}:undefined;
}
/** How a request expresses a length: seconds, milliseconds, seconds as a string (Together `seconds` "1".."10"), or the
 * on-prem video router's frame count at a frame rate (`length` 5-129 frames, `fps` 8-30). */
export interface DurationSpec {key:string;unit:'s'|'ms'|'s-string'|'frames';min:number;max:number}
/** The request shape for one capability, so the Studio can rebuild the exact request when the brief or the length changes. */
export interface ArgumentTemplate {
 /** flat: the schema's fields at the top level (http json_body caps; the ElevenLabs op router forwards its body to
  * ElevenLabs verbatim) · llm: `{command:'call',...fields}` (the LLM router reads top-level fields first) · dual: the
  * fleet's documented `{command,...fields,options:{...fields}}` for a router the table does not know. */
 envelope:'flat'|'llm'|'dual';verb:string;textKey:'prompt'|'text';fixed:Json;duration?:DurationSpec;modeled:boolean;
 source:'registry'|'family'|'default';
}
/** handler_kind=http, args_mode=json_body in arcanum_sdk.sdk_capabilities (read 2026-11-06): the gate validates the
 * top-level params against input_schema_json and strips `options` before the POST, so these take flat fields. */
const HTTP_FLAT=/^echo\.(?:media\.(?:image|video)_generate|image\.generate|fal\.generate|elevenlabs\.tts|cartesia\.tts|voice\.(?:speak|cartesia\.tts|elevenlabs\.(?:tts|sfx|music))|aws\.polly_tts)$/;
/** handler_kind=router, target /sdk/elevenlabs/op/<group>/<op>: elevenlabs_full.py sends the body it receives to ElevenLabs as is. */
const ELEVENLABS_OP=/^echo\.elevenlabs\.[a-z_]+\.[a-z_]+$/;
function envelopeFor(id:string,shape?:CapShape):Pick<ArgumentTemplate,'envelope'|'modeled'|'source'>{
 if(/^echo\.llm\./.test(id))return {envelope:'llm',modeled:true,source:'family'};
 const kind=shape?.handlerKind;
 if(kind==='http')return {envelope:'flat',modeled:HTTP_FLAT.test(id)||shape!.params.length>0,source:'registry'};
 if(ELEVENLABS_OP.test(id)&&(!kind||kind==='router'))return {envelope:'flat',modeled:true,source:'family'};
 if(!kind&&HTTP_FLAT.test(id))return {envelope:'flat',modeled:true,source:'family'};
 return {envelope:'dual',modeled:false,source:kind?'registry':'default'};
}
function textKeyFor(id:string,kind:MediaKind,shape?:CapShape):'prompt'|'text'{
 const names=new Set(shape?.params.map(p=>p.name));
 if(names.has('text')&&!names.has('prompt'))return 'text';
 if(names.has('prompt')&&!names.has('text'))return 'prompt';
 if(/sound_generation|(?:^|\.)tts$|\.speak$|polly|speech|\.sfx$/.test(id))return 'text';
 return kind==='voice'||kind==='sfx'?'text':'prompt';
}
function durationFor(id:string,kind:MediaKind):DurationSpec|undefined{
 if(id==='echo.media.video_generate')return {key:'length',unit:'frames',min:1,max:16};
 // Together video: `seconds`, passed as a string "1".."10" (docs.together.ai/docs/inference/videos/parameters).
 if(/^echo\.llm\.together\./.test(id)&&kind==='video')return {key:'seconds',unit:'s-string',min:1,max:10};
 // ElevenLabs Music: music_length_ms 3000-600000 (elevenlabs.io/docs/api-reference/music/compose).
 if(/music_generation\.(?:generate|compose_detailed|stream_compose)$|^echo\.voice\.elevenlabs\.music$/.test(id))return {key:'music_length_ms',unit:'ms',min:3,max:600};
 // ElevenLabs sound effects: duration_seconds 0.5-30 (elevenlabs.io/docs/api-reference/text-to-sound-effects/convert).
 if(/sound_generation\.sound_generation$|^echo\.voice\.elevenlabs\.sfx$/.test(id))return {key:'duration_seconds',unit:'s',min:0.5,max:30};
 return undefined;
}
/** The request fields one length becomes, clamped to the tool's range. */
export function durationFields(spec:DurationSpec,seconds:number):Json{
 const s=Math.min(spec.max,Math.max(spec.min,seconds));
 if(spec.unit==='ms')return {[spec.key]:Math.round(s*1000)};
 if(spec.unit==='s-string')return {[spec.key]:String(Math.max(1,Math.round(s)))};
 if(spec.unit==='frames'){const fps=Math.max(8,Math.min(24,Math.floor(128/s)));return {fps,length:Math.min(129,Math.round(s*fps)+1)};}
 return {[spec.key]:Math.round(s*10)/10};
}
/** `adult`: the request is an attested adult request, so the on-prem router gets the fields it needs (nsfw, subjects_fictional,
 * the user's chosen style on images, pinned to TEMPER). It only ever applies to the router capabilities. */
export function argumentTemplate(id:string,kind:MediaKind,classification?:Pick<Classification,'styles'|'aspect'>,shape?:CapShape,adult?:{style:AdultStyle}):ArgumentTemplate{
 const envelope=envelopeFor(id,shape),fixed:Json={};
 if(id==='echo.media.image_generate'){
  fixed.wait=false;
  if(classification?.styles.includes('anime'))fixed.style='anime';else if(classification?.styles.includes('photoreal'))fixed.style='photoreal';
  if(classification?.aspect==='16:9'){fixed.width=1024;fixed.height=576;}else if(classification?.aspect==='9:16'){fixed.width=576;fixed.height=1024;}else if(classification?.aspect==='21:9'){fixed.width=1344;fixed.height=576;}
 }
 if(id==='echo.media.video_generate')fixed.wait=false;
 if(adult&&isRouterCap(id))Object.assign(fixed,adultFields(id==='echo.media.image_generate'?adult.style:undefined));
 const duration=durationFor(id,kind);
 return {...envelope,verb:verbOf(id),textKey:textKeyFor(id,kind,shape),fixed,...(duration?{duration}:{})};
}
/** The exact request for a template, brief and optional length. The browser Studio rebuilds requests with the same rules. */
export function materialize(template:ArgumentTemplate,text:string,seconds?:number):Json{
 const fields:Json={[template.textKey]:text,...template.fixed};
 if(template.duration&&typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>0)Object.assign(fields,durationFields(template.duration,seconds));
 if(template.envelope==='flat')return fields;
 if(template.envelope==='llm')return {command:'call',...fields};
 return {command:template.verb,...fields,options:{...fields}};
}
/** Builds the exact Studio request for a pick from the capability's registry shape (live record when the router read it,
 * otherwise the verified family table above). A shape the table does not know is flagged `unmodeled` for review. */
export function buildArguments(id:string,kind:MediaKind,text:string,classification?:Pick<Classification,'styles'|'aspect'|'durationSeconds'>,shape?:CapShape,adult?:{style:AdultStyle}):{arguments:Json;shape:'modeled'|'unmodeled';template:ArgumentTemplate}{
 const template=argumentTemplate(id,kind,classification,shape,adult);
 return {arguments:materialize(template,text.trim(),classification?.durationSeconds),shape:template.modeled?'modeled':'unmodeled',template};
}
/** Reads a capability record (snapshot or live) into a ranked candidate, or null when it is not a generator for any kind:
 * an id NOT_A_GENERATOR names, or an id neither RANKING nor KIND_HINT recognises. Every other generator becomes a
 * candidate; one that cannot be used now carries `unavailable` and is listed under `excluded` with that reason. */
/** Why Auto does not pick the router's video tool for an ordinary brief. The wording holds for both routers: v1 is owner-disabled
 * on TEMPER (RAM budget), v2 routes video only for a model with a passing canary and when its admission gate allows it. */
export const VIDEO_NOT_AUTO='owner-disabled on TEMPER for its RAM budget (v1 router), or no model with a passing canary and an admission gate that allows it (v2 router): not auto-routed; this client never forces video';
export function describeCandidate(c:Capability):Candidate|null{
 if(NOT_A_GENERATOR.test(c.id))return null;
 const description=c.description||'',ranking=RANKING.find(r=>r.match.test(c.id));
 let kinds:MediaKind[]=ranking?[...ranking.kinds]:[];
 if(!kinds.length){const hit=KIND_HINT.find(([,rx])=>rx.test(c.id)||rx.test(description));if(!hit)return null;kinds=[hit[0]];}
 const {cost,note:costNote}=costOf(c,ranking),health=String(c.health||'unknown').toLowerCase(),lifecycle=lifecycleOf(c);
 const candidate:Candidate={
  id:c.id,label:ranking?.label??c.id.replace(/^echo\./,''),provider:providerOf(c.id),kinds,styles:ranking?.styles??[],quality:ranking?.quality??5,speed:ranking?.speed??5,
  cost,costNote,health,healthSource:health!=='unknown'?'snapshot':'none',fit:0,score:0,reasons:[],node:(c as {node?:string}).node,catalogSource:'snapshot',
  argumentShape:'unmodeled',rankingSource:ranking?.source??'unranked default (quality 5, speed 5)',note:ranking?.note??'',
 };
 if(c.registered===false)candidate.unavailable='not registered';
 else if(lifecycle)candidate.unavailable=lifecycle;
 else if((HEALTH_WEIGHT[health]??0.6)===0)candidate.unavailable='health '+health+' (the Studio refuses it at review)';
 else if(c.id==='echo.media.video_generate')candidate.unavailable=VIDEO_NOT_AUTO;
 else if(/-(?:i2v|r2v)\b|I2V|kontext|imagen_edit/i.test(c.id))candidate.unavailable='needs a source image the capability reads itself; Auto never prepares it from a text-only brief (attach a reference in the Studio and pick it yourself)';
 // ElevenLabs answers /v1/music/detailed as multipart/mixed (JSON metadata + audio, elevenlabs.io api-reference/music/compose-detailed);
 // the gate's ElevenLabs router (elevenlabs_full.py) passes on only audio/video/octet-stream bodies as files, so this answer arrives as text.
 else if(/^echo\.elevenlabs\.music_generation\.compose_detailed(?:_stream)?$/.test(c.id))candidate.unavailable='answers multipart/mixed (metadata plus audio), which the gate\'s ElevenLabs router passes on as text, not an audio file; use music_generation.generate';
 return candidate;
}
export interface RankOptions {text:string;styles?:StyleCue[];aspect?:Aspect;durationSeconds?:number;
 /** Ids the live catalog listed for this route: their record (health, registration) is the live one, not the snapshot's. */
 live?:ReadonlySet<string>;
 /** Of those, the ids whose live row carried a health value. A live row without one keeps the snapshot's health
  * (mergeCatalog) and is labelled as such; absent, every live-listed id counts as carrying live health. */
 liveHealth?:ReadonlySet<string>;
 /** Recent real executions: a tool whose last run failed for billing/auth ranks far lower, with the reason shown. */
 outcomes?:MediaOutcomes;
 /** `call_kind` values the SDK gate is known to execute. A media tool whose description names another kind ranks lower
  * as untested (the reason is shown); it is excluded only by `denyCallKinds` or a learned "unsupported call_kind" answer. */
 callKinds?:readonly string[];
 /** Call kinds never offered (Prime config `media.denyCallKinds`). */
 denyCallKinds?:readonly string[];
 /** Live registry shapes read for these ids (argument envelope and field names). */
 shapes?:ReadonlyMap<string,CapShape>;
 /** An attested adult brief: only the on-prem router capabilities may be candidates; every other tool is listed under
  * `excluded` with the adult reason. `adultStyle` is the user's chosen style (photoreal by default). */
 adult?:boolean;adultStyle?:AdultStyle}
export interface RankResult {candidates:Candidate[];excluded:Candidate[]}
export const ADULT_EXCLUDED='adult brief: only the on-prem media router (TEMPER) is used; cloud and other providers are never sent an adult brief';
/** The `call_kind=` the registry description names (the LLM router dispatches on it). */
export function callKindOf(c:{description?:string}):string|undefined{return /\bcall_kind=([a-z][a-z0-9_]{1,60})/.exec(c.description||'')?.[1];}
/** LLM-router call kinds that return a media file (Together's images, videos and speech endpoints). Every other kind the
 * router runs (openai_compat, dedicated_endpoint, anthropic_*, grok_cli, vertex_generate) is a chat completion: the gate's
 * llm_router.py has no image, video or audio output path (no images/b64/modalities handling, read 2026-11-06). */
const MEDIA_CALL_KIND=/_(?:image|video)_generation$|_audio_speech$/;
/** Why the gate cannot run this tool now, or nothing: an `echo.llm.*` generator must name a media call kind (the chat kinds
 * return text); a kind the operator denies (`media.denyCallKinds`) or the gate answered "unsupported" for recently is out.
 * A kind that is merely untested here is not excluded: see untestedCallKind. */
export function executability(c:{id:string;description?:string},callKinds:readonly string[],outcomes?:MediaOutcomes,mediaKind?:MediaKind,deny:readonly string[]=[]):string|undefined{
 const kind=callKindOf(c);
 if(/^echo\.llm\./.test(c.id)&&mediaKind&&mediaKind!=='chat'&&(!kind||!MEDIA_CALL_KIND.test(kind)))return 'it runs through the SDK gate\'s chat path ('+(kind??'openai_compat; no media call kind in the registry')+'), which returns text, not a media file';
 if(!kind)return undefined;
 if(deny.includes(kind))return 'its call kind '+kind+' is listed in media.denyCallKinds';
 const learned=outcomes?.callKind(kind);
 if(learned&&!learned.supported)return 'the SDK gate answered "unsupported call_kind \''+kind+'\'" for '+learned.cap.replace(/^echo\./,'')+' at '+new Date(learned.at).toISOString().slice(0,16).replace('T',' ')+' UTC; tools of that kind are not offered until the gate runs it';
 return undefined;
}
/** Why a tool ranks lower because Prime has no evidence the gate runs its call kind: the kind is not in the gate's known
 * list and no run of that kind has succeeded here. Once the gate supports it, the first successful run clears this. */
export function untestedCallKind(c:{id:string;description?:string},callKinds:readonly string[],outcomes?:MediaOutcomes):string|undefined{
 const kind=callKindOf(c);
 if(!kind||callKinds.includes(kind)||outcomes?.callKind(kind)?.supported)return undefined;
 return 'its call kind '+kind+' is untested on this SDK gate (not in media.gateCallKinds and no successful run yet); the gate may refuse it';
}
const UNTESTED_WEIGHT=0.4;
/** Deterministic ranking: fit x health x cost x quality (x a light speed factor x a demotion for a recent failed run).
 * Ties: health, cost, quality, id. */
export function rankCandidates(kind:MediaKind,catalog:Capability[],options:RankOptions):RankResult{
 const styles=options.styles??[],candidates:Candidate[]=[],excluded:Candidate[]=[],callKinds=options.callKinds??DEFAULT_GATE_CALL_KINDS;
 for(const c of catalog){
  const cand=describeCandidate(c);if(!cand||!cand.kinds.includes(kind))continue;
  if(options.live?.has(cand.id)){
   cand.catalogSource='live';
   cand.healthSource=!options.liveHealth||options.liveHealth.has(cand.id)?'catalog':cand.health==='unknown'?'none':'snapshot';
  }
  if(options.adult&&!isRouterCap(cand.id))cand.unavailable=ADULT_EXCLUDED;
  // For an attested adult brief the router decides whether it has a live video model; Prime does not second-guess it (its own
  // answer, a canary or admission refusal, comes back verbatim). The ordinary-brief exclusion above stays as it was.
  else if(options.adult&&cand.unavailable===VIDEO_NOT_AUTO)cand.unavailable=undefined;
  const matched=cand.styles.filter(s=>styles.includes(s));
  cand.fit=1+Math.min(0.3,0.15*matched.length);
  if(!cand.unavailable&&cand.id==='echo.cartesia.tts'&&options.text.length>400)cand.unavailable='text longer than the 400-character Cartesia bound';
  if(!cand.unavailable){const why=executability(c,callKinds,options.outcomes,kind,options.denyCallKinds);if(why)cand.unavailable=why;}
  const demotion=options.outcomes?.demotion(cand.id,cand.provider),untested=untestedCallKind(c,callKinds,options.outcomes);
  const healthWeight=HEALTH_WEIGHT[cand.health]??0.6;
  cand.score=Math.round(cand.fit*healthWeight*COST_WEIGHT[cand.cost]*(cand.quality/10)*(0.85+0.015*cand.speed)*(demotion?.weight??1)*(untested?UNTESTED_WEIGHT:1)*1000)/1000;
  const healthNote=cand.healthSource==='probe'?' (probed now)':cand.healthSource==='catalog'?' (live catalog)':cand.healthSource==='snapshot'?(cand.catalogSource==='live'?' (snapshot; the live catalog row carries no health)':' (snapshot)'):' (not reported)';
  cand.reasons=[kind+(matched.length?' + '+matched.join(', '):''),'health '+cand.health+healthNote,cand.costNote,'quality '+cand.quality+'/10, speed '+cand.speed+'/10'];
  if(demotion){cand.demoted={category:demotion.category,reason:demotion.reason};cand.reasons.push('ranked lower: '+demotion.reason);}
  else{const last=options.outcomes?.last(cand.id);if(last?.category==='ok')cand.reasons.push('last run succeeded '+new Date(last.at).toISOString().slice(0,16).replace('T',' ')+' UTC');}
  if(untested){cand.demoted??={category:'untested',reason:untested};cand.reasons.push('ranked lower: '+untested);}
  if(cand.catalogSource==='snapshot')cand.reasons.push(SNAPSHOT_ONLY);
  const built=buildArguments(cand.id,kind,options.text,{styles,aspect:options.aspect,durationSeconds:options.durationSeconds},options.shapes?.get(cand.id),options.adult?{style:options.adultStyle??'photoreal'}:undefined);cand.argumentShape=built.shape;
  if(cand.argumentShape==='unmodeled')cand.reasons.push('argument shape not modeled; review the request details');
  (cand.unavailable?excluded:candidates).push(cand);
 }
 const order=(a:Candidate,b:Candidate)=>b.score-a.score||(HEALTH_WEIGHT[b.health]??0.6)-(HEALTH_WEIGHT[a.health]??0.6)||COST_WEIGHT[b.cost]-COST_WEIGHT[a.cost]||b.quality-a.quality||a.id.localeCompare(b.id);
 candidates.sort(order);excluded.sort(order);
 return {candidates,excluded};
}
/** Said of a tool the live searches for this kind did not return (route-level `catalog.source` can still be live). */
export const SNAPSHOT_ONLY='not returned by the live catalog searches for this kind (shipped snapshot record)';
const SNAPSHOT_READ='not returned by the live catalog searches for this kind; its registry record was read live';

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
 * Studio medium (category) and node are kept so the Studio filters still find the tool. A live row that carries no health
 * (`unknown`, what the SDK bridge emits when the gate's search row has none) keeps the snapshot's health rather than
 * erasing it; rankCandidates then labels that health as the snapshot's. */
export function mergeCatalog(snapshot:Capability[],live:Capability[]):Capability[]{
 const byId=new Map(snapshot.map(c=>[c.id,c] as const));
 for(const row of live){
  const old=byId.get(row.id);
  byId.set(row.id,old?{...old,registered:row.registered,health:row.health==='unknown'&&old.health?old.health:row.health,description:row.description||old.description,...(row.scope?{scope:row.scope}:{}),...(row.tier!==undefined?{tier:row.tier}:{})}:row);
 }
 return [...byId.values()];
}
const catalogRecord=(c:Capability):CatalogRecord=>({id:c.id,registered:c.registered,health:c.health,category:c.category,description:c.description,...(c.scope?{scope:c.scope}:{}),...(c.tier!==undefined?{tier:c.tier}:{})});

// ---- router ----------------------------------------------------------------------------------------------------------
export interface MediaPick {id:string;
 /** The SDK capability id (same as `id`; the contract name the UI and docs use). */
 cap:string;label:string;provider:string;reason:string;health:string;healthSource:Candidate['healthSource'];catalogSource:Candidate['catalogSource'];cost:CostTier;costNote:string;quality:number;speed:number;score:number;argumentShape:Candidate['argumentShape'];note:string;request:{target:'sdk';name:string;arguments:Json};
 /** How to rebuild `request.arguments` for another brief or length (the Studio's duration control and brief edits). */
 template:ArgumentTemplate;
 /** Set when a recent real run of this tool (or a billing refusal on its provider) ranked it lower. */
 demoted?:{category:string;reason:string}}
/** Present only for an adult brief: whether Adult mode is on, whether the classifier read the brief as adult, why nothing was
 * sent (`refusal`), the chosen style and the only capabilities considered. */
export interface AdultRoute {active:boolean;detected:boolean;refusal?:AdultRefusalCode;style?:AdultStyle;restrictedTo?:readonly string[]}
export interface RouteResult {
 classification:Classification;picked:MediaPick|null;alternatives:MediaPick[];excluded:{id:string;label:string;reason:string}[];adult?:AdultRoute;
 /** Why nothing was picked (chat, image-edit without a source, or no healthy generator for the kind). */
 reason?:string;probe:{probed:string[];source:'none'|'cached'|'live'|'mixed'};
 /** Which catalog the ranking used: the live SDK catalog, part of it, or only the shipped snapshot (and why). */
 catalog:CatalogReport;
 /** Catalog rows for the pick and the alternatives, so the Studio can select a tool only the live catalog lists. */
 records:CatalogRecord[];
}
export interface MediaRouterOptions {
 catalog:()=>Capability[];
 /** The same read `PrimeHub.prepare` uses: the live record carries `health_status`, `registration_state` and the
  * capability's handler kind, args mode and parameter list. */
 read?:(id:string)=>Promise<unknown>;
 /** The live SDK catalog search (the broker's `sdk.search`). Absent = no live catalog: the route says it ranked the snapshot. */
 search?:(query:string)=>Promise<unknown>;
 /** Told about live rows once a search answers (the hub keeps them in its catalog, like `/api/search`). */
 onDiscovered?:(rows:Capability[])=>void;
 /** Recent real executions (the hub records every Studio execute here). */
 outcomes?:MediaOutcomes;
 /** `call_kind` values the SDK gate runs (Prime config `media.gateCallKinds`). */
 callKinds?:readonly string[];
 /** Call kinds never offered (Prime config `media.denyCallKinds`). */
 denyCallKinds?:readonly string[];
 /** Test-only seam: literal strings the adult classifier counts as an adult brief. Production supplies none. */
 adultMarkers?:readonly string[];
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
 private probes=new Map<string,{at:number;health:string;shape?:CapShape}>();
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
 /** Live health and argument shape for one capability: the hub's read (unwrapped by the caller), cached 60 s. Never
  * throws: an unreadable record is `unknown` with no shape. */
 private async probe(id:string,signal?:AbortSignal):Promise<{health:string;shape?:CapShape;source:'cached'|'live'}>{
  const cached=this.probes.get(id);
  if(cached&&this.now()-cached.at<PROBE_CACHE_MS)return {health:cached.health,shape:cached.shape,source:'cached'};
  let health='unknown',shape:CapShape|undefined;
  try{
   // within() clears its timer and removes its abort listener whichever way the read settles.
   const record=obj(await within(this.options.read!(id),this.options.probeTimeoutMs??5000,'Health probe',signal));
   const state=String(record.registration_state??''),status=String(record.health_status??'').toLowerCase();
   health=state&&state!=='registered'?'unregistered':status||'unknown';
   shape=shapeOf(record);
  }catch(error){debug('%j',{event:'prime_media_probe_failed',id,reason:error instanceof Error?redact(error.message).slice(0,120):'failed'});}
  this.probes.set(id,{at:this.now(),health,shape});
  return {health,shape,source:'live'};
 }
 private toPick(c:Candidate,kind:MediaKind,text:string,classification:Classification,shape?:CapShape,adult?:{style:AdultStyle}):MediaPick{
  const built=buildArguments(c.id,kind,text,classification,shape,adult);
  return {id:c.id,cap:c.id,label:c.label,provider:c.provider,reason:'Picked '+c.label+' because '+c.reasons.join(' · '),health:c.health,healthSource:c.healthSource,catalogSource:c.catalogSource,cost:c.cost,costNote:c.costNote,quality:c.quality,speed:c.speed,score:c.score,argumentShape:built.shape,note:c.note,request:{target:'sdk',name:c.id,arguments:built.arguments},template:built.template,...(c.demoted?{demoted:c.demoted}:{})};
 }
 /** The one entry point. `mode` is a Studio/composer tab ('auto' or a kind); `fallback` says what an unclassifiable prompt
  * means (Studio: image, composer: chat); `durationSeconds` is the Studio's length control and wins over the brief's. */
 async route(input:unknown,signal?:AbortSignal):Promise<RouteResult>{
  const data=obj(input);
  if(Object.keys(data).some(k=>!['text','mode','fallback','probe','classifier','durationSeconds','adult','fictional','style'].includes(k)))throw new MediaError(400,'Invalid media request');
  if(typeof data.text!=='string'||!data.text.trim())throw new MediaError(400,'Enter a prompt to route');
  if(data.text.length>MEDIA_MAX_TEXT)throw new MediaError(400,'Prompt exceeds '+MEDIA_MAX_TEXT+' characters');
  if(data.mode!==undefined&&data.mode!=='auto'&&!MEDIA_KINDS.includes(data.mode as MediaKind))throw new MediaError(400,'Invalid media mode');
  if(data.fallback!==undefined&&data.fallback!=='image'&&data.fallback!=='chat')throw new MediaError(400,'Invalid media fallback');
  if(data.probe!==undefined&&typeof data.probe!=='boolean')throw new MediaError(400,'Invalid media request');
  if(data.classifier!==undefined&&typeof data.classifier!=='boolean')throw new MediaError(400,'Invalid media request');
  if((data.adult!==undefined&&typeof data.adult!=='boolean')||(data.fictional!==undefined&&typeof data.fictional!=='boolean'))throw new MediaError(400,'Invalid media request');
  if(data.style!==undefined&&!ADULT_STYLES.includes(data.style as AdultStyle))throw new MediaError(400,'Invalid adult style; use '+ADULT_STYLES.join(' or '));
  if(data.durationSeconds!==undefined&&(typeof data.durationSeconds!=='number'||!Number.isFinite(data.durationSeconds)||data.durationSeconds<0.5||data.durationSeconds>600))throw new MediaError(400,'Length must be 0.5 to 600 seconds');
  const text=data.text,started=this.now();
  let classification=classifyPrompt(text,{hint:(data.mode as MediaKind|'auto'|undefined)??'auto',fallback:(data.fallback as 'image'|'chat'|undefined)??'image'});
  // An adult brief (Adult mode on, or the classifier read the text as one) is decided before anything leaves this process:
  // no classifier model sees the text, no catalog search runs for a refusal, and a refusal names exactly what to switch on.
  const adultStyle=(data.style as AdultStyle|undefined)??'photoreal',adultText=data.adult===true||classifyAdult(text,{markers:this.options.adultMarkers}).adult;
  // One short Qwen call sharpens a rules result that is not already near-certain; a chosen mode tab (source 'hint') is never second-guessed.
  if(!adultText&&this.options.models&&data.classifier!==false&&classification.source==='rules'&&classification.confidence<0.9){
   classification=await classifyWithModel(this.options.models,text,classification,{timeoutMs:this.options.classifierTimeoutMs,signal});
  }
  if(typeof data.durationSeconds==='number')classification={...classification,durationSeconds:data.durationSeconds};
  const policy=adultPolicy({text,flagged:data.adult===true,fictional:data.fictional===true,kind:classification.kind,markers:this.options.adultMarkers});
  const adult=policy.adult&&classification.kind!=='chat'?policy:undefined;
  const probe:RouteResult['probe']={probed:[],source:'none'};
  const kind=classification.kind;
  if(kind==='chat'){
   debug('%j',{event:'prime_media_routed',kind,picked:null,durationMs:this.now()-started});
   return {classification,picked:null,alternatives:[],excluded:[],reason:'This reads as a conversation, not a media request; it goes to chat unless you pick a creation mode.',probe,catalog:{source:'none',queries:[],listed:0,failed:[],cached:false},records:[]};
  }
  if(adult?.refusal){
   debug('%j',{event:'prime_media_adult_refused',code:adult.refusal.code,kind,durationMs:this.now()-started});
   return {classification,picked:null,alternatives:[],excluded:[],reason:adult.refusal.message,probe,catalog:{source:'none',queries:[],listed:0,failed:[],cached:false},records:[],adult:{active:adult.flagged,detected:adult.detected,refusal:adult.refusal.code}};
  }
  // Classify first, then ask the live catalog about that one kind only.
  const discovery=await this.discover(kind,signal);
  const base=mergeCatalog(this.options.catalog(),discovery.rows),listed=new Set(discovery.rows.map(c=>c.id));
  const liveHealth=new Set(discovery.rows.filter(c=>c.health!=='unknown').map(c=>c.id));
  const shapes=new Map<string,CapShape>();
  const rankWith=(catalog:Capability[])=>rankCandidates(kind,catalog,{text,styles:classification.styles,aspect:classification.aspect,durationSeconds:classification.durationSeconds,live:listed,liveHealth,outcomes:this.options.outcomes,callKinds:this.options.callKinds,denyCallKinds:this.options.denyCallKinds,shapes,...(adult?{adult:true,adultStyle}:{})});
  let ranked=rankWith(base);
  if(this.options.read&&data.probe!==false&&ranked.candidates.length){
   // The pick and the alternatives the Studio shows (seven) are read live: health, registration and argument shape.
   const top=ranked.candidates.slice(0,this.options.probeCount??7),results=await Promise.all(top.map(c=>this.probe(c.id,signal)));
   const live=new Map(top.map((c,i)=>[c.id,results[i]] as const));
   for(const [id,r] of live)if(r.shape)shapes.set(id,r.shape);
   probe.probed=top.map(c=>c.id);
   const sources=new Set(results.map(r=>r.source));probe.source=sources.size>1?'mixed':sources.has('live')?'live':'cached';
   ranked=rankWith(base.map(c=>{const r=live.get(c.id);return r?{...c,health:r.health}:c;}));
   for(const c of [...ranked.candidates,...ranked.excluded])if(live.has(c.id)){c.healthSource='probe';c.reasons=c.reasons.map(r=>r.startsWith('health ')?'health '+c.health+' (probed now)':r===SNAPSHOT_ONLY&&c.health!=='unknown'?SNAPSHOT_READ:r);}
  }
  const picks=ranked.candidates.map(c=>this.toPick(c,kind,text,classification,shapes.get(c.id),adult?{style:adultStyle}:undefined));
  // Every excluded generator is listed with its reason (no cap): nothing the catalog offers for this kind disappears.
  const excluded=ranked.excluded.map(c=>({id:c.id,label:c.label,reason:c.unavailable!}));
  let reason:string|undefined;
  if(adult){
   if(!picks.length){
    const router=ranked.excluded.filter(c=>isRouterCap(c.id)&&c.kinds.includes(kind));
    reason='Adult mode runs only on the on-prem media router (TEMPER), which makes images and video. '+(router.length?'Its '+kind+' tool is not usable right now ('+router.map(c=>c.label+': '+c.unavailable).join('; ')+').':'No '+kind+' tool of the router is listed in the catalog, so there is no on-prem '+kind+' tool for this brief.')+' Nothing was sent and no other provider was used.';
   }
  }
  else if(kind==='image-edit')reason='This asks to edit an existing image. Auto does not prepare edits: attach the source image in the Studio (Library → Use in Studio) and pick one of the editing-capable tools listed below yourself. Nothing was prepared.';
  else if(!picks.length)reason='No healthy, runnable '+kind+' generator is listed in the catalog right now (see "Not used for this brief" for why each one is out); nothing was prepared and no other kind was substituted.';
  const picked=kind==='image-edit'?null:picks[0]??null;
  const alternatives=(kind==='image-edit'?picks:picks.slice(1)).slice(0,6);
  const byId=new Map(base.map(c=>[c.id,c] as const));
  // The record carries the health the pick was ranked with (a probe result when one ran).
  const records=[...(picked?[picked]:[]),...alternatives].flatMap(p=>{const c=byId.get(p.id);return c?[{...catalogRecord(c),health:p.health}]:[];});
  debug('%j',{event:'prime_media_routed',kind,confidence:classification.confidence,source:classification.source,picked:picked?.id??null,alternatives:alternatives.length,excluded:excluded.length,probed:probe.probed.length,catalog:discovery.report.source,listed:discovery.report.listed,durationMs:this.now()-started});
  return {classification,picked,alternatives,excluded,...(reason?{reason}:{}),probe,catalog:discovery.report,records,...(adult?{adult:{active:true,detected:adult.detected,style:adultStyle,restrictedTo:ROUTER_CAP_IDS}}:{})};
 }
}
