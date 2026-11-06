import {debuglog} from 'node:util';
import {redact} from '../code/workspace.js';
import {isModelId,MODEL_IDS,modelLabel,type AnswerInfo,type ModelId,type ModelRouter} from '../code/model-factory.js';
import {ProviderUnavailableError} from '../code/providers.js';
import {classifyPrompt,type MediaKind} from './media.js';
import {classifyAdult} from './adult.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * "Enhance prompt": one turn on exactly the provider the user chose (claude | gpt | grok | argon | qwen), through the
 * same ModelRouter the chat uses, with a mode-specific system prompt. The provider rewrites the prompt as a craft
 * improvement only: the user's subject and intent stay, no facts are added, and the answer names what it added.
 * No fallback: an unavailable provider is reported by name. Never auto-sends anything; the browser gets text back.
 */
export type EnhanceMode='chat'|'image'|'video'|'music'|'sfx'|'voice';
export const ENHANCE_MODES:readonly EnhanceMode[]=['chat','image','video','music','sfx','voice'];
export const ENHANCE_MAX_INPUT=4000;
export const ENHANCE_MAX_OUTPUT=6000;
export class EnhanceError extends WorkspaceHttpError {}
const debug=debuglog('echo-prime');
const PRESERVE='Preserve the user\'s intent exactly. Keep every subject, constraint, name, number and reference they gave. '
 +'Never add facts, names, brands, places, dates, statistics, quotes or claims the user did not supply; add only craft and specificity about HOW the result should look, sound or read. '
 +'Never invent durations, lengths, counts or sizes the user did not give (say "default length" instead). State assumptions explicitly instead of asking questions. '
 +'If the prompt is already complete, make only light improvements. Write in the user\'s language. Do not answer the prompt and do not generate the artifact; return an improved prompt.';
/** Mode-specific enhancement instructions. The framing line overrides the coding-agent persona the CLI wrappers add. */
export const ENHANCE_SYSTEM:Record<EnhanceMode,string>={
 chat:'PROMPT ENHANCEMENT TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
  +'You improve a prompt the user is about to send to an AI assistant. Clarify the intent in one sentence, state the constraints that are implied (audience, length, tone, what to include or exclude), and name the desired output format (for example: bullet list, table, numbered steps, code block with language). Ask nothing; if something is ambiguous, state the most reasonable assumption inside the prompt as an explicit assumption.\n'+PRESERVE,
 image:'PROMPT ENHANCEMENT TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
  +'You improve a text-to-image prompt. Cover: subject (what the user named, made concrete), composition and framing, lens or camera choice, lighting, colour and mood, style or medium, level of detail, and a short "Negative:" list of things to avoid (artifacts, text, watermarks, extra limbs). Keep it one paragraph of comma-separated phrases, under 120 words.\n'+PRESERVE,
 video:'PROMPT ENHANCEMENT TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
  +'You improve a text-to-video prompt. Cover: a short shot list or single-shot description, subject motion, camera movement (static, pan, dolly, orbit, handheld), duration in seconds if the user gave one (never invent a duration they did not give; if none, say "default length"), lighting and time of day, pacing, and style. Keep it under 120 words.\n'+PRESERVE,
 music:'PROMPT ENHANCEMENT TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
  +'You improve a music generation prompt. Cover: genre and sub-genre, tempo (BPM range) and feel, key or mode if it matters, instrumentation, structure (intro, verse, chorus, bridge, outro or loop), mood and energy arc, production style, vocals or instrumental, and length if the user gave one (never invent a length). Keep it under 120 words.\n'+PRESERVE,
 sfx:'PROMPT ENHANCEMENT TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
  +'You improve a sound-effect prompt. Cover: the sound source and material, texture and timbre, attack and decay, distance and space (dry, roomy, outdoor), layering, duration in seconds if the user gave one (never invent one), and whether it should loop. Keep it under 60 words.\n'+PRESERVE,
 voice:'PROMPT ENHANCEMENT TASK (this overrides the coding-agent framing: there is no workspace and no tools; never use list/read/search/propose).\n'
  +'You improve a text-to-speech request. Keep the words to be spoken exactly as written (fix only obvious typos); add delivery notes in square brackets before the text: pace, emotion, emphasis, pauses, pronunciation hints for unusual words. Do not change the spoken script\'s meaning or add lines.\n'+PRESERVE,
};
const OUTPUT_CONTRACT='Reply with exactly one JSON object: {"action":"final","content":"<JSON string>"} where <JSON string> is a JSON-encoded object '
 +'{"text":"<the improved prompt>","added":["<short phrase naming one thing you added>", ...]}. Nothing else.';
export interface EnhanceResult {
 mode:EnhanceMode;text:string;added:string[];addedSource:'model'|'derived';provider:ModelId;providerLabel:string;model:AnswerInfo;
 /** Set when `mode: "auto"` was requested: the rules classifier decided the mode. */
 classified?:{kind:MediaKind;confidence:number};
 inputChars:number;outputChars:number;durationMs:number;
}
export interface EnhancerOptions {limit?:number;windowMs?:number;timeoutMs?:number;now?:()=>number;
 /** Test-only seam: literal strings the adult classifier counts as an adult brief. Production supplies none. */
 adultMarkers?:readonly string[]}
function extractJson(text:string):string{
 const fenced=/```(?:json)?\s*([\s\S]*?)```/i.exec(text),body=fenced?fenced[1]:text;
 const start=body.indexOf('{'),end=body.lastIndexOf('}');
 if(start<0||end<=start)throw new Error('no JSON');
 return body.slice(start,end+1);
}
const normalise=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
/** Phrases of the enhanced text that do not appear in the original: the honest "what I added" list when the model gives none. */
export function derivedAdditions(original:string,enhanced:string):string[]{
 const base=normalise(original),out:string[]=[];
 for(const part of enhanced.split(/[,;.\n]+|\s[-–—]\s|\[|\]/)){
  const phrase=part.trim();if(phrase.length<3)continue;
  const key=normalise(phrase);if(!key||base.includes(key))continue;
  if(!out.some(o=>normalise(o)===key))out.push(phrase.slice(0,120));
  if(out.length>=12)break;
 }
 return out;
}
export function parseEnhancement(content:string,original:string):{text:string;added:string[];addedSource:'model'|'derived'}{
 let text=content.trim(),added:string[]=[],addedSource:'model'|'derived'='derived';
 try{
  const value=JSON.parse(extractJson(content)) as Record<string,unknown>;
  if(value&&typeof value==='object'&&typeof value.text==='string'&&value.text.trim()){
   text=value.text.trim();
   if(Array.isArray(value.added)){added=value.added.filter((a):a is string=>typeof a==='string'&&a.trim().length>0).map(a=>a.trim().slice(0,120)).slice(0,20);if(added.length)addedSource='model';}
  }
 }catch{/* plain text answer: the whole content is the prompt */}
 if(!text)throw new EnhanceError(502,'The provider returned an empty enhancement; no retry and no other provider was used');
 if(addedSource==='derived')added=derivedAdditions(original,text);
 return {text,added,addedSource};
}
/** A provider failure that means its sign-in or key does not work (claude CLI "OAuth session expired", codex "not signed in"). */
const AUTH_FAILURE=/failed to authenticate|oauth|not signed in|not logged in|log ?in (?:required|again)|sign-?in|unauthori[sz]ed|\b401\b|\b403\b|invalid (?:api )?key|credential|token (?:expired|revoked)|session expired/i;
export interface EnhanceFailure {category:'auth'|'unavailable'|'timeout'|'error';reason:string;at:string}
export class PromptEnhancer {
 private hits=new Map<string,number[]>();
 private limit:number;private windowMs:number;private timeoutMs:number;private now:()=>number;private adultMarkers?:readonly string[];
 /** The last failure per provider until that provider answers again: the Enhance chip skips an `auth` or `unavailable`
  * provider when it picks the default, so an expired CLI sign-in is not every owner's first click. */
 private failed=new Map<ModelId,EnhanceFailure>();
 failures():Partial<Record<ModelId,EnhanceFailure>>{return Object.fromEntries(this.failed) as Partial<Record<ModelId,EnhanceFailure>>;}
 constructor(private router:ModelRouter,options:EnhancerOptions={}){
  this.limit=options.limit??10;this.windowMs=options.windowMs??60000;this.timeoutMs=options.timeoutMs??120000;this.now=options.now??Date.now;this.adultMarkers=options.adultMarkers;
 }
 /** Sliding window per session key (the Prime session cookie hash). Refused requests count nothing. */
 private admit(key:string){
  const now=this.now(),recent=(this.hits.get(key)??[]).filter(t=>now-t<this.windowMs);
  if(recent.length>=this.limit){this.hits.set(key,recent);throw new EnhanceError(429,'Enhance limit reached: '+this.limit+' per '+Math.round(this.windowMs/1000)+' s for this session. Nothing was sent to a model.');}
  recent.push(now);this.hits.set(key,recent);
  if(this.hits.size>500)for(const [k,v] of this.hits)if(!v.some(t=>now-t<this.windowMs))this.hits.delete(k);
 }
 async enhance(input:unknown,sessionKey:string,signal?:AbortSignal):Promise<EnhanceResult>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new EnhanceError(400,'Invalid enhance request');
  const data=input as Record<string,unknown>;
  if(Object.keys(data).some(k=>!['mode','text','provider'].includes(k)))throw new EnhanceError(400,'Invalid enhance request');
  if(typeof data.text!=='string'||!data.text.trim())throw new EnhanceError(400,'Enter a prompt to enhance');
  if(data.text.length>ENHANCE_MAX_INPUT)throw new EnhanceError(400,'Prompt exceeds '+ENHANCE_MAX_INPUT+' characters');
  if(data.mode!=='auto'&&!ENHANCE_MODES.includes(data.mode as EnhanceMode))throw new EnhanceError(400,'Invalid enhance mode; use chat, image, video, music, sfx, voice or auto');
  if(data.provider!==undefined&&!isModelId(data.provider))throw new EnhanceError(400,'Unknown provider; use one of '+MODEL_IDS.join(', '));
  if(typeof sessionKey!=='string'||!sessionKey)throw new EnhanceError(400,'Invalid enhance session');
  // Enhance sends the text to a cloud model (Claude, GPT, Gemini, Grok). An adult picture or video brief must never go there,
  // so it is refused before the rate limiter or any model turn. A chat prompt and a voice, music or sound script are not pictures.
  if((data.mode==='image'||data.mode==='video'||data.mode==='auto')&&classifyAdult(data.text,{markers:this.adultMarkers}).adult)
   throw new EnhanceError(400,'Enhance sends the text to a cloud model, so it is off for adult briefs. Nothing was sent; write the brief yourself.');
  this.admit(sessionKey);
  const text=redact(data.text).trim(),provider=(data.provider as ModelId|undefined)??this.router.defaultId;
  let mode:EnhanceMode,classified:EnhanceResult['classified'];
  if(data.mode==='auto'){const c=classifyPrompt(text,{fallback:'chat'});mode=c.kind==='image-edit'?'image':c.kind;classified={kind:c.kind,confidence:c.confidence};}
  else mode=data.mode as EnhanceMode;
  const started=this.now(),turn=this.router.turn(provider),label=modelLabel(provider,this.router.config);
  debug('%j',{event:'prime_enhance_started',mode,provider,inputChars:text.length});
  const timeout=AbortSignal.timeout(this.timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let action;
  try{action=await turn.model.next([{role:'system',content:ENHANCE_SYSTEM[mode]+'\n'+OUTPUT_CONTRACT},{role:'user',content:'PROMPT TO ENHANCE:\n'+text}],combined);}
  catch(error){
   const reason=error instanceof Error?redact(error.message).slice(0,300):'provider failed';
   debug('%j',{event:'prime_enhance_refused',mode,provider,reason,durationMs:this.now()-started});
   if(signal?.aborted)throw new EnhanceError(499,'Interrupted');
   this.failed.set(provider,{category:AUTH_FAILURE.test(reason)?'auth':error instanceof ProviderUnavailableError?'unavailable':timeout.aborted?'timeout':'error',reason:reason.slice(0,200),at:new Date(this.now()).toISOString()});
   if(error instanceof ProviderUnavailableError)throw new EnhanceError(503,reason);
   if(timeout.aborted)throw new EnhanceError(504,label+' did not answer within '+Math.round(this.timeoutMs/1000)+' s; no other provider was used');
   throw new EnhanceError(502,label+' failed: '+reason+'; no other provider was used');
  }
  turn.answered();this.failed.delete(provider);
  if(action.action!=='final'){
   debug('%j',{event:'prime_enhance_refused',mode,provider,reason:'non_final_action',durationMs:this.now()-started});
   throw new EnhanceError(502,label+' returned a tool action instead of an enhanced prompt; no retry and no other provider was used');
  }
  const parsed=parseEnhancement(redact(action.content),text);
  if(parsed.text.length>ENHANCE_MAX_OUTPUT)throw new EnhanceError(502,label+' returned '+parsed.text.length+' characters, over the '+ENHANCE_MAX_OUTPUT+' limit; nothing was applied');
  const result:EnhanceResult={mode,text:parsed.text,added:parsed.added.map(a=>redact(a)),addedSource:parsed.addedSource,provider,providerLabel:label,model:turn.info(),...(classified?{classified}:{}),inputChars:text.length,outputChars:parsed.text.length,durationMs:this.now()-started};
  debug('%j',{event:'prime_enhance_finished',mode,provider,model:result.model.model,reported:result.model.reported,added:result.added.length,addedSource:result.addedSource,inputChars:result.inputChars,outputChars:result.outputChars,durationMs:result.durationMs});
  return result;
 }
}
