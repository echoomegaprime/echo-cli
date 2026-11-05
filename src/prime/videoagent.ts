import {createHash} from 'node:crypto';
import {debuglog} from 'node:util';
import {redact} from '../code/workspace.js';
import {ADK_CREATE_NAME,ADK_DEFAULT_LANE,ADK_DEFINITION_LIMITS,clampAdkBudget,type AdkAgentDefinition} from './agents.js';
import {ARTIFACT_ID_RE,UPLOAD_ID_RE,type UploadStore} from './uploads.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * Video agent builder (Commander order 2026-11-04: "Add agent building for making videos. Multiple prompts and inputs can be used").
 * A brief plus one prompt per shot and input ids (uploads `upl_…`, Artifact Center `art_…`, Workspace library ids; never bytes)
 * becomes an editable storyboard, then an Echo ADK definition of role `producer` named `video-<slug>`.
 *
 * Capability ids are only ever chosen from the live catalog through the SDK broker (exact ids, read-verified as registered and not
 * red/orphaned/retired, and in the ADK id grammar). Without the broker the storyboard still plans, but it is `ready:false` and agent
 * creation is refused with the reason; a role the catalog cannot fill is listed in `missing`. Nothing falls back to a hardcoded id.
 * Budget: the lane is `qwen-local` (ADK counts lane-model cost only, which is 0); calls and wall time scale with the shots and are
 * clamped to the service caps; `max_steps` = shots×3+6 (≤ 60). Contract and limits: docs/echo-code/PRIME_VIDEO_AGENTS.md.
 */
const debug=debuglog('echo-prime');
export class VideoAgentError extends WorkspaceHttpError {constructor(status:number,message:string){super(status,message);}}
export const VIDEO_PLAN_SCHEMA='echo.video.plan.v1';
export const VIDEO_MAX_SHOTS=18;
export const VIDEO_MAX_INPUTS=64;
export const VIDEO_FPS=24;
export const VIDEO_VOICE='freeman';
export const VIDEO_SKILLS=['storyboard','generate','narrate','stitch','qc','deliver'] as const;
/** Per-shot lane spend before the fixed overhead and the service clamp (120 calls, 4800 s). Cost stays 0: the qwen-local lane is free. */
export const VIDEO_RATES={calls:8,wallS:300,overheadCalls:6,overheadWallS:120} as const;
export const VIDEO_LIMITS={brief:4000,prompt:2000,voiceover:800,style:80,camera:80,motion:80,name:40,shotMin:2,shotMax:15,totalMin:2,totalMax:600,defaultShot:6,instruction:ADK_DEFINITION_LIMITS.instruction} as const;
/** Exact ids read from the live catalog on every discovery; anything else must be found by a catalog search and then read. */
export const VIDEO_CANDIDATES=['echo.media.video_generate','echo.media.job_status','echo.voice.speak','echo.elevenlabs.tts'] as const;
export const VIDEO_SEARCHES=['video_generate','job_status','text to speech','ffmpeg','stitch','concat'] as const;
/** The service's own capability grammar (echo_adk.core.types.CAP_ID); stricter than ADK_CAPABILITY_ID (no empty segments). */
export const VIDEO_CAP_ID=/^echo\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;
export const VIDEO_AGENT_NAME=/^video-[a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?$/;
const VIDEO_MAX_STEPS=60;
/** Width/height are multiples of 32 (echo.media.video_generate requires it). */
export const VIDEO_ASPECTS={'16:9':{width:1024,height:576},'9:16':{width:576,height:1024},'1:1':{width:704,height:704},'4:3':{width:768,height:576},'3:4':{width:576,height:768}} as const;
export type VideoAspect=keyof typeof VIDEO_ASPECTS;
export type VideoInputKind='image'|'clip'|'audio'|'script'|'reference';
export type VideoMode='text_to_video'|'image_to_video'|'clip';
type Role='video'|'job'|'narration'|'stitch';
const INPUT_KINDS:readonly VideoInputKind[]=['image','clip','audio','script','reference'];
const LIBRARY_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_KEY=/^(bytes|base64|b64|data|content|token|access_token|api_key|apikey|secret|password|authorization|credential|credentials|lease|cookie)$/i;
const SECRET_TEXT=/data:[a-z]+\/[a-z0-9.+-]+;base64,|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
/** A run of 400+ base64-alphabet characters is treated as raw bytes when it mixes character classes (real base64 and hex always do);
 *  one repeated character is just an over-long field and gets its own length message. */
const BYTES_RUN=/[A-Za-z0-9+/]{400,}={0,2}/g;
function looksLikeBytes(value:string):boolean{
 for(const match of value.matchAll(BYTES_RUN)){
  const run=match[0],classes=[/[A-Z]/,/[a-z]/,/[0-9]/,/[+/]/].filter(re=>re.test(run)).length;
  if(classes>=2)return true;
 }
 return false;
}
const REQUEST_KEYS=new Set(['brief','prompts','inputs','style','aspect','duration_s','name']);
const STORYBOARD_KEYS=new Set(['brief','inputs','style','aspect','name','shots']);
/** Plan output fields a client may echo back inside a shot or an input; accepted and ignored (the server recomputes them). */
const SHOT_KEYS=new Set(['prompt','duration_s','camera','motion','voiceover','inputs']),SHOT_ECHO=new Set(['id','index','frames','generation']);
const INPUT_ECHO=new Set(['source','name','animatable','job_id']);
const HINT:Record<Role,RegExp>={
 video:/video[_ ]?generat|text[_ -]?to[_ -]?video|image[_ -]?to[_ -]?video|text->video|image->video|\bt2v\b|\bi2v\b|\bti2v\b/i,
 job:/job[_ ]?status|poll .*job|job_id/i,
 narration:/voice\.speak|elevenlabs\.tts|\btts\b|text[_ -]?to[_ -]?speech|synthesi[sz]e speech/i,
 stitch:/ffmpeg|\bstitch|\bconcat|join (?:the )?(?:clips|shots|videos)/i,
};
const NEGATIVE=/youtube|analytics|detector|dubbing|video_to_music|webcam|caption|music|\bretired\b|\[retired/i;
const BAD_HEALTH=new Set(['red','orphaned','unregistered','retired']);
/** Live catalog row after an exact read: registered, healthy enough, inside the ADK id grammar. */
export interface VideoCatalogEntry {id:string;description:string;health:string;tier:number|null}
export interface VideoCatalog {live:boolean;reason?:string;entries:VideoCatalogEntry[];warnings:string[]}
/** What the hub hands discovery: the broker's exact read (already unwrapped to the gate record) and its catalog search. */
export interface VideoCatalogSource {read(id:string):Promise<unknown>;search(query:string):Promise<{id:string;description?:string;registered?:boolean;health?:string}[]>}
export interface VideoInputRequest {id:string;kind?:VideoInputKind}
export interface VideoInput {id:string;kind:VideoInputKind;source:'upload'|'artifact'|'library';name?:string;animatable?:boolean;job_id?:string}
export interface VideoShotRequest {prompt:string;duration_s?:number;camera?:string;motion?:string;voiceover?:string;inputs?:string[]}
/** Everything the owner chose, validated; inputs are still ids only (resolved against the stores by the hub). */
export interface VideoMaterial {form:'request'|'storyboard';brief:string;style:string;aspect:VideoAspect;name?:string;inputs:VideoInputRequest[];shots:VideoShotRequest[];durationClamped:boolean}
export interface VideoShot {id:string;index:number;prompt:string;duration_s:number;frames:number;camera:string;motion:string;voiceover:string;inputs:string[];generation:{mode:VideoMode;capability:string|null;image_job_id?:string;clip?:string}}
export interface VideoStep {id:string;kind:'generate'|'use'|'poll'|'narrate'|'stitch'|'qc'|'deliver';shot?:string;capability:string|null}
export interface VideoPlan {
 schema:typeof VIDEO_PLAN_SCHEMA;name:string;brief:string;style:string;aspect:VideoAspect;resolution:{width:number;height:number};duration_s:number;fps:number;
 inputs:VideoInput[];unassigned:string[];shots:VideoShot[];steps:VideoStep[];capabilities:string[];
 budget:{max_calls:number;max_cost_usd:number;max_wall_s:number;clamped:boolean};estimate:{shots:number;calls:number;wall_s:number;duration_s:number;status_checks:number};
 max_steps:number;lane:{node:string;model:string};origin:{by:'echo';prompt_sha256:string};
 narration:{capability:string|null;voice:typeof VIDEO_VOICE;lines:number};stitch:{capability:string|null;available:boolean;note:string};
 catalog:{live:boolean;reason?:string;ids:string[];warnings:string[]};ready:boolean;missing:string[];warnings:string[];durationClamped:boolean;
}
const fail=(message:string,status=400):never=>{
 debug('%j',{event:'prime_video_refused',status,reason:message.slice(0,160)});
 throw new VideoAgentError(status,message);
};
const isObj=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const obj=(v:unknown,what:string):Record<string,unknown>=>isObj(v)?v:fail(what+' must be an object');
const text=(v:unknown,max:number)=>typeof v==='string'?redact(v).slice(0,max):'';
/** shots×3+6 (generate, poll and narrate per shot plus the fixed tail), never above 60; planning refuses more than 18 shots. */
export function videoMaxSteps(shots:number):number{return Math.min(VIDEO_MAX_STEPS,Math.max(1,Math.floor(shots))*3+6);}
/** Frames for the routed video capability: 4n+1 at 24 fps. */
export function videoFrames(seconds:number):number{return Math.max(1,Math.round(seconds*VIDEO_FPS/4))*4+1;}
function refuseSecrets(value:unknown,depth=0):void{
 if(depth>8)fail('Video request is nested too deeply');
 if(typeof value==='string'){if(SECRET_TEXT.test(value)||looksLikeBytes(value))fail('Refusing credentials or raw bytes: pass library, upload or artifact ids only');return;}
 if(Array.isArray(value)){for(const item of value)refuseSecrets(item,depth+1);return;}
 if(isObj(value))for(const [key,item] of Object.entries(value)){
  if(SECRET_KEY.test(key))fail('Refusing credentials or raw bytes: pass library, upload or artifact ids only');
  refuseSecrets(item,depth+1);
 }
}
export function videoSlug(value:string):string{
 const slug=value.normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,VIDEO_LIMITS.name).replace(/-+$/g,'');
 return slug||'untitled';
}
function parseText(value:unknown,what:string,max:number,required:boolean):string{
 if(value===undefined||value===null||value===''){if(required)fail(what+' is required');return '';}
 if(typeof value!=='string')fail(what+' must be text');
 const out=(value as string).trim();
 if(required&&!out)fail(what+' is required');
 if(out.length>max)fail(what+' must be at most '+max+' characters');
 return out;
}
function parseAspect(value:unknown):VideoAspect{
 if(value===undefined||value==='')return '16:9';
 if(typeof value!=='string'||!Object.hasOwn(VIDEO_ASPECTS,value))fail('Aspect must be one of '+Object.keys(VIDEO_ASPECTS).join(', '));
 return value as VideoAspect;
}
function parseWhole(value:unknown,what:string,min:number,max:number):number{
 if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(what+' must be a whole number from '+min+' to '+max);
 return value as number;
}
export function parseInputId(value:unknown):string{
 if(typeof value!=='string'||!(UPLOAD_ID_RE.test(value)||ARTIFACT_ID_RE.test(value)||(LIBRARY_ID.test(value)&&!value.includes('..')&&!/^data:/i.test(value))))fail('Invalid input id: use an upload, library or artifact id');
 return value as string;
}
function parseInputs(value:unknown):VideoInputRequest[]{
 if(value===undefined)return [];
 if(!Array.isArray(value))fail('Inputs must be a list of upload, library or artifact ids');
 const list=value as unknown[];
 if(list.length>VIDEO_MAX_INPUTS)fail('At most '+VIDEO_MAX_INPUTS+' inputs');
 const out:VideoInputRequest[]=[],seen=new Set<string>();
 for(const item of list){
  let id:string,kind:VideoInputKind|undefined;
  if(typeof item==='string')id=parseInputId(item);
  else{
   const row=obj(item,'Each input');
   for(const key of Object.keys(row))if(key!=='id'&&key!=='kind'&&!INPUT_ECHO.has(key))fail('Unknown input field '+text(key,40));
   id=parseInputId(row.id);
   if(row.kind!==undefined){if(typeof row.kind!=='string'||!(INPUT_KINDS as readonly string[]).includes(row.kind))fail('Input kind must be one of '+INPUT_KINDS.join(', '));kind=row.kind as VideoInputKind;}
  }
  if(seen.has(id))fail('Duplicate input id '+id);
  seen.add(id);out.push(kind?{id,kind}:{id});
 }
 return out;
}
function splitDuration(total:number|undefined,count:number):{durations:number[];clamped:boolean}{
 if(total===undefined)return {durations:Array.from({length:count},()=>VIDEO_LIMITS.defaultShot),clamped:false};
 const base=Math.floor(total/count),extra=total%count,durations:number[]=[];let clamped=false;
 for(let i=0;i<count;i++){const raw=base+(i<extra?1:0),shot=Math.min(VIDEO_LIMITS.shotMax,Math.max(VIDEO_LIMITS.shotMin,raw));if(shot!==raw)clamped=true;durations.push(shot);}
 return {durations,clamped};
}
/** Validates a plan request (`prompts`) or an edited storyboard (`shots`). Unknown fields, credentials and raw bytes are refused. */
export function parseVideoRequest(input:unknown):VideoMaterial{
 refuseSecrets(input);
 const data=obj(input,'Video request');
 const storyboard=data.shots!==undefined;
 for(const key of Object.keys(data))if(!(storyboard?STORYBOARD_KEYS:REQUEST_KEYS).has(key))fail('Unknown video '+(storyboard?'storyboard':'plan')+' field '+text(key,40));
 const brief=parseText(data.brief,'Brief',VIDEO_LIMITS.brief,true),style=parseText(data.style,'Style',VIDEO_LIMITS.style,false),aspect=parseAspect(data.aspect),inputs=parseInputs(data.inputs);
 const nameText=parseText(data.name,'Name',80,false);
 const name=nameText?videoSlug(nameText):undefined;
 const list=storyboard?data.shots:data.prompts;
 if(!Array.isArray(list))fail(storyboard?'Shots must be a list':'Prompts must be a list');
 const rows=list as unknown[];
 if(rows.length<1)fail('At least one prompt is required');
 if(rows.length>VIDEO_MAX_SHOTS)fail('At most '+VIDEO_MAX_SHOTS+' shots');
 const known=new Set(inputs.map(i=>i.id));
 const shots:VideoShotRequest[]=[];let durationClamped=false;
 if(storyboard){
  for(const raw of rows){
   const row=obj(raw,'Each shot');
   for(const key of Object.keys(row))if(!SHOT_KEYS.has(key)&&!SHOT_ECHO.has(key))fail('Unknown shot field '+text(key,40));
   const shot:VideoShotRequest={prompt:parseText(row.prompt,'Each prompt',VIDEO_LIMITS.prompt,true),duration_s:parseWhole(row.duration_s,'Shot duration',VIDEO_LIMITS.shotMin,VIDEO_LIMITS.shotMax),
    camera:parseText(row.camera,'Camera',VIDEO_LIMITS.camera,false),motion:parseText(row.motion,'Motion',VIDEO_LIMITS.motion,false),voiceover:parseText(row.voiceover,'Voice-over',VIDEO_LIMITS.voiceover,false)};
   if(row.inputs!==undefined){
    if(!Array.isArray(row.inputs))fail('Shot inputs must be a list of ids');
    const ids:string[]=[];
    for(const id of row.inputs as unknown[]){const parsed=parseInputId(id);if(!known.has(parsed))fail('Shot input '+parsed+' is not one of the storyboard inputs');if(!ids.includes(parsed))ids.push(parsed);}
    shot.inputs=ids;
   }else shot.inputs=[];
   shots.push(shot);
  }
 }else{
  const total=data.duration_s===undefined?undefined:parseWhole(data.duration_s,'Duration',VIDEO_LIMITS.totalMin,VIDEO_LIMITS.totalMax);
  const split=splitDuration(total,rows.length);durationClamped=split.clamped;
  rows.forEach((raw,i)=>{
   if(typeof raw==='string'||raw===undefined||raw===null){shots.push({prompt:parseText(raw,'Each prompt',VIDEO_LIMITS.prompt,true),duration_s:split.durations[i]});return;}
   const row=obj(raw,'Each prompt');
   for(const key of Object.keys(row))if(key!=='prompt'&&key!=='voiceover')fail('Unknown prompt field '+text(key,40));
   shots.push({prompt:parseText(row.prompt,'Each prompt',VIDEO_LIMITS.prompt,true),voiceover:parseText(row.voiceover,'Voice-over',VIDEO_LIMITS.voiceover,false),duration_s:split.durations[i]});
  });
 }
 return {form:storyboard?'storyboard':'request',brief,style,aspect,...(name?{name}:{}),inputs,shots,durationClamped};
}
function uploadKind(kind:unknown):VideoInputKind{return kind==='image'?'image':kind==='video'?'clip':kind==='audio'?'audio':kind==='document'?'script':'reference';}
function artifactKind(kind:unknown):VideoInputKind{return kind==='image'?'image':kind==='video'?'clip':['voice','music','sound'].includes(String(kind))?'audio':['document','code','chat'].includes(String(kind))?'script':'reference';}
/** A Studio image artifact made by echo.media.image_generate carries the router job id in its stored result; only those can be animated. */
function routerJobId(record:Record<string,unknown>):string|undefined{
 if(String(object(record.provenance).capability)!=='echo.media.image_generate'||typeof record.content!=='string'||record.content.length>1048576)return undefined;
 let content:unknown;try{content=JSON.parse(record.content);}catch{return undefined;}
 const c=object(content),result=object(c.result);
 for(const v of [result.job_id,c.job_id])if(typeof v==='string'&&JOB_ID.test(v))return v;
 return undefined;
}
function object(v:unknown):Record<string,unknown>{return isObj(v)?v:{};}
/** Resolves input ids against the owner's stores. Kinds come from the stored metadata, never from the browser (library ids excepted:
 *  Workspace files are not visible here, so their client kind is kept and they default to `script`). A missing id is refused. */
export async function resolveVideoInputs(requested:readonly VideoInputRequest[],store:UploadStore|undefined,owner:string):Promise<VideoInput[]>{
 const out:VideoInput[]=[];
 for(const item of requested){
  if(UPLOAD_ID_RE.test(item.id)||ARTIFACT_ID_RE.test(item.id)){
   if(!store)fail('Uploads and the Artifact Center are not enabled: add an `uploads` section to the Prime config to use '+item.id,503);
   const isUpload=UPLOAD_ID_RE.test(item.id);
   let record:Record<string,unknown>;
   try{record=object(isUpload?await store!.get(owner,item.id):await store!.getArtifact(owner,item.id));}
   catch{fail('Input not found: '+item.id);}
   const name=text(isUpload?record!.name:record!.title,120);
   if(isUpload){out.push({id:item.id,kind:uploadKind(record!.kind),source:'upload',...(name?{name}:{})});continue;}
   const kind=artifactKind(record!.kind),job=kind==='image'?routerJobId(record!):undefined;
   out.push({id:item.id,kind,source:'artifact',...(name?{name}:{}),...(kind==='image'?{animatable:!!job}:{}),...(job?{job_id:job}:{})});
  }else out.push({id:item.id,kind:item.kind??'script',source:'library'});
 }
 return out;
}
function healthBad(health:string,description:string){return BAD_HEALTH.has(health.toLowerCase())||/\[retired|\bretired\b/i.test(description);}
function tierOf(...sources:Record<string,unknown>[]):number|null{
 for(const s of sources)for(const key of ['tier','danger_tier'])if(typeof s[key]==='number'&&Number.isFinite(s[key]))return s[key] as number;
 return null;
}
async function within<T>(work:Promise<T>,ms:number,label:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out after '+Math.round(ms/1000)+' s')),ms);})]);}
 finally{clearTimeout(timer);}
}
/** Discovers the video-related part of the live catalog: a few bounded searches, then an exact read of every candidate (the fixed
 *  candidates plus relevant search hits, at most 12). Only read-verified, registered, non-red, non-retired ids in the ADK grammar
 *  are returned. When every request fails the catalog is reported as not live, with the first reason. */
export async function discoverVideoCatalog(source:VideoCatalogSource,options:{timeoutMs?:number;maxReads?:number}={}):Promise<VideoCatalog>{
 const ms=options.timeoutMs??8000,maxReads=options.maxReads??12,warnings:string[]=[];
 const found=new Set<string>();let answered=0;
 await Promise.all(VIDEO_SEARCHES.map(async query=>{
  try{
   const rows=await within(source.search(query),ms,'Catalog search');answered++;
   for(const row of Array.isArray(rows)?rows:[]){
    const id=typeof row?.id==='string'?row.id:'',description=typeof row.description==='string'?row.description:'';
    if(!VIDEO_CAP_ID.test(id)||id.length>128||row.registered===false||healthBad(String(row.health??''),description)||NEGATIVE.test(id+' '+description))continue;
    if(Object.values(HINT).some(re=>re.test(id)||re.test(description)))found.add(id);
   }
  }catch(error){warnings.push('Catalog search "'+query+'" failed: '+text(error instanceof Error?error.message:'request failed',160));}
 }));
 const ids=[...new Set<string>([...VIDEO_CANDIDATES,...[...found].sort()])].slice(0,maxReads);
 const entries:VideoCatalogEntry[]=[];
 await Promise.all(ids.map(async id=>{
  try{
   const record=object(await within(source.read(id),ms,'Catalog read'));answered++;
   const cap=object(record.capability);
   if(cap.id!==id||record.registration_state!=='registered')return;
   const description=text(cap.description??record.description,400),health=String(record.health_status??cap.health_status??'unknown').toLowerCase();
   if(healthBad(health,description))return;
   entries.push({id,description,health,tier:tierOf(cap,object(cap.metadata),record,object(record.metadata))});
  }catch(error){warnings.push('Catalog read '+id+' failed: '+text(error instanceof Error?error.message:'request failed',160));}
 }));
 entries.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 debug('%j',{event:'prime_video_catalog',searched:VIDEO_SEARCHES.length,read:ids.length,verified:entries.map(e=>e.id),warnings:warnings.length});
 if(!answered)return {live:false,reason:'The live capability catalog did not answer'+(warnings[0]?': '+warnings[0]:''),entries:[],warnings};
 return {live:true,entries,warnings};
}
export function offlineCatalog(reason:string):VideoCatalog{return {live:false,reason,entries:[],warnings:[]};}
function score(entry:VideoCatalogEntry,role:Role):number{
 if(NEGATIVE.test(entry.id+' '+entry.description))return 0;
 let s=0;
 if(HINT[role].test(entry.id))s+=100;
 if(HINT[role].test(entry.description))s+=40;
 if(s===0)return 0;
 if(entry.health==='green')s+=20;else if(entry.health==='amber')s+=10;
 // Exact preferences among equally matching rows: the routed on-prem generator, its own poller, and the unified TTS that resolves the
 // Personality Forge voice name ("freeman"); echo.elevenlabs.tts needs a provider voice id the agent does not hold.
 if(role==='video'&&entry.id==='echo.media.video_generate')s+=80;
 if(role==='job'&&entry.id==='echo.media.job_status')s+=80;
 if(role==='narration'&&entry.id==='echo.voice.speak')s+=30;
 if(role==='job'&&/generat/i.test(entry.id))s-=150;
 if(role==='video'&&/job[_ ]?status/i.test(entry.id))s-=150;
 return s;
}
/** Highest score wins; a tie breaks to the smaller id. Nothing matching (score ≤ 0) means no capability: never a hardcoded fallback. */
export function routeCapability(role:Role,catalog:readonly VideoCatalogEntry[]):string|null{
 let best:{id:string;score:number}|undefined;
 for(const entry of catalog){
  if(!VIDEO_CAP_ID.test(entry.id))continue;
  const s=score(entry,role);
  if(s>0&&(!best||s>best.score||(s===best.score&&entry.id<best.id)))best={id:entry.id,score:s};
 }
 return best?.id??null;
}
function defaultMotion(style:string){return /cinematic|\bfilm\b/i.test(style)?'slow push-in':'gentle drift';}
function digest(material:VideoMaterial,shots:VideoShot[],name:string):string{
 const canonical={aspect:material.aspect,brief:material.brief,inputs:material.inputs.map(i=>i.id),name,shots:shots.map(s=>({camera:s.camera,duration_s:s.duration_s,inputs:s.inputs,motion:s.motion,prompt:s.prompt,voiceover:s.voiceover})),style:material.style};
 return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
/** Storyboard, routed capabilities, budget and steps. Pure: the catalog and the resolved inputs are passed in. */
export function planVideo(material:VideoMaterial,inputs:readonly VideoInput[],catalog:VideoCatalog):VideoPlan{
 const byId=new Map(inputs.map(i=>[i.id,i]));
 for(const req of material.inputs)if(!byId.has(req.id))fail('Input '+req.id+' was not resolved');
 const ordered=material.inputs.map(req=>byId.get(req.id)!);
 const visuals=ordered.filter(i=>i.kind==='image'||i.kind==='clip');
 const count=material.shots.length,warnings:string[]=[],missing:string[]=[];
 // Request form: one visual goes on every shot; several are dealt to the shots in order; extras stay unassigned. Storyboard form: as edited.
 const assigned:string[][]=material.form==='storyboard'?material.shots.map(s=>[...(s.inputs??[])]):material.shots.map((_,i)=>visuals.length===1?[visuals[0]!.id]:visuals[i]?[visuals[i]!.id]:[]);
 const entries=catalog.live?catalog.entries:[];
 const video=routeCapability('video',entries),job=routeCapability('job',entries),narrator=routeCapability('narration',entries),stitcher=routeCapability('stitch',entries);
 const motion=defaultMotion(material.style),resolution=VIDEO_ASPECTS[material.aspect];
 let referenceWarned=false;
 const shots:VideoShot[]=material.shots.map((req,i)=>{
  const ids=assigned[i]??[],rows=ids.map(id=>byId.get(id)!).filter(Boolean);
  const clip=rows.find(r=>r.kind==='clip'),still=rows.find(r=>r.kind==='image'&&r.animatable&&r.job_id);
  let generation:VideoShot['generation'];
  if(clip)generation={mode:'clip',capability:null,clip:clip.id};
  else if(still)generation={mode:'image_to_video',capability:video,image_job_id:still.job_id!};
  else generation={mode:'text_to_video',capability:video};
  if(!clip&&!still&&rows.some(r=>r.kind==='image')&&!referenceWarned){referenceWarned=true;warnings.push('Uploaded images are references only: the routed video capability animates images made by echo.media.image_generate (choose a Studio image artifact to animate it). Shots with an uploaded image are generated from their prompt.');}
  const duration=req.duration_s??VIDEO_LIMITS.defaultShot;
  return {id:'shot-'+(i+1),index:i+1,prompt:req.prompt,duration_s:duration,frames:videoFrames(duration),camera:req.camera||'locked medium',motion:req.motion||motion,voiceover:req.voiceover??'',inputs:ids,generation};
 });
 const generated=shots.filter(s=>s.generation.mode!=='clip'),lines=shots.filter(s=>s.voiceover).length;
 if(!catalog.live)missing.push(catalog.reason??'The live capability catalog is not connected');
 else{
  if(generated.length&&!video)missing.push('video generation: no text-to-video or image-to-video capability is registered in the live catalog');
  if(generated.length&&video&&/^echo\.media\./.test(video)&&!job)missing.push('job polling: '+video+' answers with a job id, but no job status capability (echo.media.job_status) is registered in the live catalog');
  if(lines&&!narrator)missing.push('narration: '+lines+' shot'+(lines===1?' has':'s have')+' a voice-over line, but no text-to-speech capability (echo.voice.speak or echo.elevenlabs.tts) is registered in the live catalog');
 }
 const steps:VideoStep[]=[];
 for(const shot of shots){
  if(shot.generation.mode==='clip'){steps.push({id:'use-'+shot.id,kind:'use',shot:shot.id,capability:null});continue;}
  steps.push({id:'generate-'+shot.id,kind:'generate',shot:shot.id,capability:shot.generation.capability});
  if(shot.generation.capability&&/^echo\.media\./.test(shot.generation.capability))steps.push({id:'poll-'+shot.id,kind:'poll',shot:shot.id,capability:job});
 }
 for(const shot of shots)if(shot.voiceover)steps.push({id:'narrate-'+shot.id,kind:'narrate',shot:shot.id,capability:narrator});
 if(stitcher)steps.push({id:'stitch',kind:'stitch',capability:stitcher});
 steps.push({id:'qc',kind:'qc',capability:null},{id:'deliver',kind:'deliver',capability:null});
 const capabilities:string[]=[];
 for(const step of steps)if(step.capability&&!capabilities.includes(step.capability))capabilities.push(step.capability);
 if(catalog.live&&!missing.length&&!capabilities.length)missing.push('nothing to produce: every shot reuses an existing clip and no shot has a voice-over line');
 // Every step is one model turn with at most one capability call. Generation is asynchronous (wait false), so the step budget left
 // after the submissions, the narrations, a stitch and the final answer is what the agent has for job status checks.
 const maxSteps=videoMaxSteps(count),polled=steps.filter(s=>s.kind==='poll').length;
 const statusChecks=polled?Math.max(0,maxSteps-steps.filter(s=>s.kind==='generate'||s.kind==='narrate'||s.kind==='stitch').length-1):0;
 if(polled&&statusChecks<polled*2)warnings.push('Step budget: '+maxSteps+' steps leave '+statusChecks+' job status checks for '+polled+' rendering shot'+(polled===1?'':'s')+' (fewer than two each). A shot still rendering when the checks run out is delivered with its job id; it keeps rendering and can be checked later with '+(job??'the job status capability')+'. Split a long storyboard into two agents to give each shot more checks.');
 const claimed=new Set(shots.flatMap(s=>s.inputs)),unassigned=visuals.filter(v=>!claimed.has(v.id)).map(v=>v.id);
 if(unassigned.length)warnings.push('Not on any shot: '+unassigned.join(', ')+'. Add a prompt per input or tick it on a shot.');
 if(material.durationClamped)warnings.push('Each shot runs '+VIDEO_LIMITS.shotMin+' to '+VIDEO_LIMITS.shotMax+' s, so the total duration was adjusted.');
 const name='video-'+(material.name??videoSlug(material.brief));
 if(!VIDEO_AGENT_NAME.test(name)||!ADK_CREATE_NAME.test(name))fail('The agent name '+name+' is not a valid Echo ADK name');
 const calls=count*VIDEO_RATES.calls+VIDEO_RATES.overheadCalls,wall=count*VIDEO_RATES.wallS+VIDEO_RATES.overheadWallS;
 const clamped=clampAdkBudget({max_calls:calls,max_cost_usd:0,max_wall_s:wall});
 const duration=shots.reduce((sum,s)=>sum+s.duration_s,0);
 const stitchNote=stitcher?'Shots are joined in order with '+stitcher+'.':'No stitch or concat capability is registered in the live catalog'+(catalog.live?'':' (not checked: the catalog is offline)')+'. The agent delivers every shot in order (job ids and output paths) and each narration clip; it does not join them into one file.';
 const plan:VideoPlan={
  schema:VIDEO_PLAN_SCHEMA,name,brief:material.brief,style:material.style,aspect:material.aspect,resolution:{...resolution},duration_s:duration,fps:VIDEO_FPS,
  inputs:ordered.map(i=>({...i})),unassigned,shots,steps,capabilities,
  budget:{...clamped,clamped:clamped.max_calls!==calls||clamped.max_wall_s!==wall},estimate:{shots:count,calls,wall_s:wall,duration_s:duration,status_checks:statusChecks},
  max_steps:maxSteps,lane:{node:ADK_DEFAULT_LANE.node,model:ADK_DEFAULT_LANE.model},origin:{by:'echo',prompt_sha256:digest(material,shots,name)},
  narration:{capability:lines?narrator:null,voice:VIDEO_VOICE,lines},stitch:{capability:stitcher,available:!!stitcher,note:stitchNote},
  catalog:{live:catalog.live,...(catalog.reason?{reason:catalog.reason}:{}),ids:entries.map(e=>e.id),warnings:[...catalog.warnings]},
  ready:catalog.live&&!missing.length,missing,warnings,durationClamped:material.durationClamped,
 };
 debug('%j',{event:'prime_video_plan',name,shots:count,generated:generated.length,lines,capabilities,ready:plan.ready,missing:missing.length,clamped:plan.budget.clamped,max_steps:plan.max_steps,live:catalog.live});
 return plan;
}
function paramsFor(shot:VideoShot,plan:VideoPlan):string{
 const p=['prompt','width '+plan.resolution.width,'height '+plan.resolution.height,'length '+shot.frames,'fps '+plan.fps,'wait false'];
 if(shot.generation.image_job_id)p.push('image_job_id '+shot.generation.image_job_id);
 return p.join(', ');
}
/** The agent instruction carries the whole storyboard. When the prompts do not fit the 12000-character limit each is shortened evenly
 *  and the plan says which shots were shortened; nothing else is cut. */
export function videoInstruction(plan:VideoPlan):{instruction:string;shortened:string[]}{
 const head=['You are '+plan.name+', an Echo video producer. Produce the storyboard below, shot by shot, in order.',
  'Rules: pass library, upload and artifact ids only. Never request or handle credentials, tokens, leases, raw bytes or base64 (never set return_b64 or force_video). If a capability is unavailable or refuses, stop that step, name the capability and its reason, and continue with the next shot. Never substitute another provider or capability.',
  'Brief: '+plan.brief.replace(/\s+/g,' ').slice(0,1500),'Style: '+(plan.style||'(none)')+'. Aspect '+plan.aspect+' at '+plan.resolution.width+'x'+plan.resolution.height+', '+plan.fps+' fps.',
  'Inputs: '+(plan.inputs.map(i=>i.id+' ('+i.kind+(i.name?', '+i.name.replace(/\s+/g,' ').slice(0,60):'')+')').join('; ')||'(none)')+'.'];
 const tail:string[]=[];
 const poller=plan.steps.find(s=>s.kind==='poll'&&s.capability)?.capability??null;
 if(poller)tail.push('Order of work (at most '+plan.max_steps+' steps in total, one capability call per step; keep the last step for the final answer): 1) submit every generated shot in shot order with wait false and note its job_id; 2) narrate the voice-over lines; 3) check each job once with '+poller+' in shot order, then re-check only the jobs still running while checks remain ('+plan.estimate.status_checks+' checks in total); '+(plan.stitch.capability?'4) stitch once every shot is done (skip the stitch if any shot is still rendering or failed); 5) deliver.':'4) deliver.')+' Never wait in a loop and never resubmit a shot: a shot still rendering when the checks run out is delivered as "still rendering" with its job_id.');
 else tail.push('Order of work (at most '+plan.max_steps+' steps in total, one capability call per step; keep the last step for the final answer): produce the shots in shot order, then narrate the voice-over lines, then deliver.');
 if(plan.narration.capability)tail.push('Narration: for each voice-over line call '+plan.narration.capability+' with the line as text'+(plan.narration.capability==='echo.voice.speak'?', persona "'+VIDEO_VOICE+'" (the Personality Forge voice) and format mp3':' and the voice that matches "'+VIDEO_VOICE+'" when the capability resolves voice names')+'; report the audio reference and the provider that answered (an answer from chatterbox is a fallback voice, not '+VIDEO_VOICE+': say so).');
 tail.push(plan.stitch.capability?'Stitch: join the shots in order with '+plan.stitch.capability+'.':'Stitch: no stitch capability is granted. Do not join files and do not claim a joined video.');
 tail.push('QC: check every shot produced output, the duration ('+plan.duration_s+' s total) and the resolution; list anything missing.',
  'Deliver: a final answer listing, in shot order, each shot id with its state (done, still rendering or failed), its job id and output path (or the clip id used as-is), each narration audio reference, and every failed step with its capability and reason.');
 const lines=(budget:number|null)=>plan.shots.map(s=>{
  const prompt=s.prompt.replace(/\s+/g,' '),cut=budget!==null&&prompt.length>budget?prompt.slice(0,Math.max(40,budget))+'…':prompt;
  const how=s.generation.mode==='clip'?'use clip '+s.generation.clip+' as-is (no generation)':(s.generation.capability??'(no capability)')+' ('+s.generation.mode+'; '+paramsFor(s,plan)+')';
  return s.id+' ('+s.duration_s+' s, '+s.frames+' frames, camera '+s.camera+', motion '+s.motion+'): '+how+'. Inputs: '+(s.inputs.join(', ')||'(none)')+'. Prompt: '+cut+(s.voiceover?' Voice-over: '+s.voiceover.replace(/\s+/g,' '):'');
 });
 const fixed=[...head,'Shots:',...tail].join('\n').length+plan.shots.length+16;
 let shotLines=lines(null),shortened:string[]=[];
 if(fixed+shotLines.join('\n').length>VIDEO_LIMITS.instruction){
  const overhead=lines(0).join('\n').length,room=VIDEO_LIMITS.instruction-fixed-overhead,per=Math.floor(room/Math.max(1,plan.shots.length));
  shotLines=lines(per);shortened=plan.shots.filter(s=>s.prompt.replace(/\s+/g,' ').length>per).map(s=>s.id);
 }
 let instruction=[...head,'Shots:',...shotLines,...tail].join('\n');
 if(instruction.length>VIDEO_LIMITS.instruction)instruction=instruction.slice(0,VIDEO_LIMITS.instruction-10)+'\n[clipped]';
 return {instruction,shortened};
}
/** The exact Echo ADK definition for a ready plan (no `source`, origin without created_at once on the wire). Refuses a plan that is not ready. */
export function videoAgentDefinition(plan:VideoPlan):AdkAgentDefinition&{origin:{by:'echo';prompt_sha256:string;created_at:string}}{
 if(!plan.catalog.live)fail(plan.catalog.reason??'The live capability catalog is not connected; no capability id can be verified. Nothing was created.',503);
 if(!plan.ready)fail('This storyboard is not ready for an agent: '+plan.missing.join('; ')+'. Nothing was created.');
 const {instruction,shortened}=videoInstruction(plan);
 if(shortened.length)plan.warnings.push('Shortened in the agent instruction (12000-character limit): '+shortened.join(', ')+'. The full prompts stay on this storyboard.');
 return {name:plan.name,role:'producer',skills:[...VIDEO_SKILLS],capabilities:[...plan.capabilities],
  lane:{node:plan.lane.node,model:plan.lane.model,budget:{max_calls:plan.budget.max_calls,max_cost_usd:plan.budget.max_cost_usd,max_wall_s:plan.budget.max_wall_s}},
  max_steps:plan.max_steps,instruction,origin:{by:'echo',prompt_sha256:plan.origin.prompt_sha256,created_at:new Date().toISOString()}};
}
/** Prompt for one run of an existing video agent; the storyboard lives in the agent's instruction. */
export function videoRunPrompt(agent:string):string{
 return 'Produce the video for '+agent+' now. Follow the storyboard in your instruction shot by shot. Pass ids only; never request credentials, leases, raw bytes or base64. Stop a failed step and name its capability instead of substituting another. Submit every shot before checking any job, never wait in a loop, and report a shot still rendering with its job id. Finish with the delivery list: every shot with its state, job id and output path, every narration audio reference, and every failed step.';
}
/** Validates the run request: `{agent, budget?}` for an agent named video-*. */
export function parseVideoRun(input:unknown):{agent:string;budget?:unknown}{
 const data=obj(input,'Video run request');
 for(const key of Object.keys(data))if(key!=='agent'&&key!=='budget')fail('Unknown video run field '+text(key,40));
 if(typeof data.agent!=='string'||!VIDEO_AGENT_NAME.test(data.agent))fail('Run a video agent: the name must start with video-');
 return {agent:data.agent as string,...(data.budget!==undefined?{budget:data.budget}:{})};
}
