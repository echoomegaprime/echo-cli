import {createHash} from 'node:crypto';
import {debuglog} from 'node:util';
import {clampAdkBudget,type AdkBudget} from './agents.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * Video agent builder. A brief plus one prompt per shot and library/artifact ids becomes an Echo ADK
 * agent definition (role `producer`, name `video-<slug>`) and the storyboard that definition carries.
 * Capability ids come from the media router when a catalog is passed, otherwise from the explicit
 * fallbacks documented in docs/echo-code/PRIME_VIDEO_AGENTS.md. Raw bytes never enter the definition.
 */
const debug=debuglog('echo-prime');
export class VideoAgentError extends WorkspaceHttpError {
 constructor(status:number,message:string){super(status,message);}
}
export const VIDEO_PLAN_SCHEMA='echo.video.plan.v1';
export const VIDEO_MAX_SHOTS=18;
export const VIDEO_SKILLS=['storyboard','generate','narrate','stitch','qc','deliver'] as const;
/** Per-shot lane cost before the fixed overhead and the service clamp (120 calls, $5, 4800 s). */
export const VIDEO_RATES={calls:8,costUsd:0.35,wallS:300,overheadCalls:6,overheadCostUsd:0,overheadWallS:120} as const;
export const VIDEO_CAPS={
 media:'echo.media.video_generate',
 jobStatus:'echo.media.job_status',
 narration:'echo.elevenlabs.tts',
 lipSync:'echo.comfy.infinitetalk',
} as const;
export const VIDEO_VOICE='freeman';
const ASPECTS={ '16:9':{width:1280,height:720}, '9:16':{width:720,height:1280}, '1:1':{width:720,height:720}, '4:3':{width:960,height:720}, '3:4':{width:720,height:960} } as const;
export type VideoAspect=keyof typeof ASPECTS;
export type VideoInputKind='image'|'clip'|'audio'|'script'|'face'|'reference';
export type VideoGenRole='image_to_video'|'text_to_video'|'lip_sync';
const INPUT_KINDS=new Set<VideoInputKind>(['image','clip','audio','script','face','reference']);
const VISUAL=new Set<VideoInputKind>(['image','clip','reference','face']);
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAP_RE=/^echo\.[A-Za-z0-9_.-]+$/;
const SECRET_KEY=/^(bytes|base64|data|content|token|api_key|secret|password|authorization|credential|lease)$/i;
const SECRET_TEXT=/(?:^|[^A-Za-z])data:|\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;
const REQUEST_KEYS=new Set(['brief','prompts','inputs','style','duration_s','aspect']);
const I2V=/image[_-]?to[_-]?video|\bi2v\b|image->video|image→video|\bti2v\b/i;
const T2V=/text[_-]?to[_-]?video|\bt2v\b|text->video|text→video/i;
const LIP=/lipsync|lip-sync|lip_sync|infinitetalk|talking[-_ ]?head/i;
const NARR=/elevenlabs\.tts|voice\.elevenlabs\.synthesize|elevenlabs.+tts|tts.+elevenlabs/i;
const STITCH=/ffmpeg|\bstitch\b|\bconcat\b/i;
const NEGATIVE=/youtube|analytics|detector|music|dubbing|caption/i;
export interface VideoCatalogEntry {id:string;description?:string;registered?:boolean;health?:string}
export interface VideoInput {id:string;kind:VideoInputKind}
export interface VideoShot {
 id:string;scene:number;index:number;prompt:string;duration_s:number;camera:string;motion:string;inputs:string[];
 generation:{role:VideoGenRole;capability:string;selection:'router'|'explicit'};
}
export interface VideoStep {
 id:string;kind:'generate'|'narrate'|'stitch'|'qc'|'deliver'|'forge-ffmpeg-job';shot?:string;capability:string|null;
 selection?:'router'|'explicit';node?:string;voice?:string;role?:VideoGenRole;checks?:string[];
}
export interface VideoPlan {
 schema:typeof VIDEO_PLAN_SCHEMA;name:string;brief:string;style:string;aspect:VideoAspect;duration_s:number;
 resolution:{width:number;height:number};inputs:VideoInput[];unassigned:string[];
 scenes:{id:string;title:string;shots:VideoShot[]}[];steps:VideoStep[];capabilities:string[];
 budget:{max_calls:number;max_cost_usd:number;max_wall_s:number;clamped:boolean};
 estimate:{shots:number;calls:number;cost_usd:number;wall_s:number;duration_s:number};
 max_steps:number;lane:{node:'temper'|'forge';model:'qwen-local'};
 origin:{by:'echo';prompt_sha256:string};
 narration:{capability:string;voice:typeof VIDEO_VOICE;selection:'router'|'explicit'};
 stitch:{kind:'stitch'|'forge-ffmpeg-job';capability:string|null;node?:'forge';selection:'router'|'explicit'};
 qc:{duration_s:number;width:number;height:number;shots:number};durationClamped:boolean;
}
export interface VideoAgentDefinition {
 name:string;role:'producer';skills:string[];capabilities:string[];
 lane:{node:string;model:string;budget:AdkBudget};max_steps:number;instruction:string;source:string;
 origin:{by:'echo';prompt_sha256:string};inputs:VideoInput[];plan:VideoPlan;
}
const fail=(message:string):never=>{
 debug('%j',{event:'prime_video_refused',reason:message.slice(0,160)});
 throw new VideoAgentError(400,message);
};
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail('Expected an object');
/** shots×3+6, never above the ADK max_steps cap of 60. Planning still refuses more than 18 shots. */
export function videoMaxSteps(shots:number):number{return Math.min(60,shots*3+6);}
function refuseSecrets(value:unknown,depth=0):void{
 if(depth>12)fail('Video request is too deep');
 if(typeof value==='string'){if(SECRET_TEXT.test(value))fail('Refusing credentials or raw bytes');return;}
 if(Array.isArray(value)){for(const item of value)refuseSecrets(item,depth+1);return;}
 if(value&&typeof value==='object'){
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
   if(SECRET_KEY.test(key))fail('Refusing credentials or raw bytes');
   refuseSecrets(item,depth+1);
  }
 }
}
function slugify(brief:string):string{
 const folded=brief.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const slug=folded.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/g,'');
 return slug||'untitled';
}
function inferKind(id:string):VideoInputKind{
 const suffix=id.includes('.')?id.slice(id.lastIndexOf('.')).toLowerCase():'';
 if(['.png','.jpg','.jpeg','.webp','.gif'].includes(suffix))return 'image';
 if(['.mp4','.webm','.mov'].includes(suffix))return 'clip';
 if(['.mp3','.wav','.m4a','.flac'].includes(suffix))return 'audio';
 if(['.txt','.md','.srt','.vtt'].includes(suffix))return 'script';
 return 'reference';
}
function parseId(value:unknown):string{
 if(typeof value!=='string'||value.length>128||/\s/.test(value)||value.includes('..')||/data:/i.test(value)||!ID_RE.test(value))fail('Invalid library or artifact id');
 return value;
}
function parseInputs(value:unknown):VideoInput[]{
 if(value===undefined)return [];
 if(!Array.isArray(value))fail('Inputs must be a list of library or artifact ids');
 if(value.length>64)fail('At most 64 inputs');
 const out:VideoInput[]=[];const seen=new Set<string>();
 for(const item of value){
  let id:string,kind:VideoInputKind|undefined;
  if(typeof item==='string')id=parseId(item);
  else{
   const row=obj(item);const keys=Object.keys(row);
   for(const key of keys)if(key!=='id'&&key!=='kind')fail('Unknown input field');
   id=parseId(row.id);
   if(row.kind!==undefined){
    if(typeof row.kind!=='string'||!INPUT_KINDS.has(row.kind as VideoInputKind))fail('Invalid input kind');
    kind=row.kind as VideoInputKind;
   }
  }
  if(seen.has(id))fail('Duplicate input id');
  seen.add(id);
  out.push({id,kind:kind??inferKind(id)});
 }
 return out;
}
function parseBrief(value:unknown):string{
 if(typeof value!=='string')fail('Brief is required');
 const brief=value.trim();
 if(!brief||brief.length>4000)fail('Brief must be 1 to 4000 characters');
 return brief;
}
function parseStyle(value:unknown):string{
 if(value===undefined||value==='')return '';
 if(typeof value!=='string')fail('Invalid style');
 const style=value.trim();
 if(style.length>80)fail('Style must be at most 80 characters');
 return style;
}
function parseAspect(value:unknown):VideoAspect{
 if(value===undefined||value==='')return '16:9';
 if(typeof value!=='string'||!(value in ASPECTS))fail('Invalid aspect');
 return value as VideoAspect;
}
function parseDurationRequest(value:unknown):number|undefined{
 if(value===undefined)return undefined;
 if(typeof value!=='number'||!Number.isInteger(value)||value<2||value>600)fail('Duration must be an integer from 2 to 600 seconds');
 return value;
}
function parsePrompt(value:unknown):string{
 if(typeof value!=='string')fail('Each prompt must be text');
 const prompt=value.trim();
 if(!prompt)fail('Prompt is empty');
 if(prompt.length>2000)fail('Each prompt must be at most 2000 characters');
 return prompt;
}
function defaultMotion(style:string):string{return /cinematic|\bfilm\b/i.test(style)?'slow push-in':'gentle drift';}
function splitDuration(total:number|undefined,count:number):{durations:number[];clamped:boolean}{
 if(total===undefined)return {durations:Array.from({length:count},()=>6),clamped:false};
 const base=Math.floor(total/count),extra=total%count;let clamped=false;const durations:number[]=[];
 for(let i=0;i<count;i++){
  const raw=base+(i<extra?1:0),shot=Math.min(15,Math.max(2,raw));
  if(shot!==raw)clamped=true;
  durations.push(shot);
 }
 return {durations,clamped};
}
function hint(role:VideoGenRole|'narration'|'stitch',text:string):boolean{
 if(role==='image_to_video')return I2V.test(text);
 if(role==='text_to_video')return T2V.test(text);
 if(role==='lip_sync')return LIP.test(text);
 if(role==='narration')return NARR.test(text);
 return STITCH.test(text);
}
function scoreCap(cap:VideoCatalogEntry,role:VideoGenRole|'narration'|'stitch'):number{
 const description=typeof cap.description==='string'?cap.description:'';
 let score=0;
 if(hint(role,cap.id))score+=100;
 if(hint(role,description))score+=40;
 if(cap.registered===true)score+=30;
 if(cap.registered===false)score-=50;
 const health=(cap.health??'').toLowerCase();
 if(health==='green')score+=20;
 else if(health==='amber')score+=10;
 else if(health==='red'||health==='orphaned'||health==='unregistered')score-=50;
 if(health==='retired'||/retired/i.test(description))score-=50;
 if((role==='image_to_video'||role==='text_to_video')&&cap.id===VIDEO_CAPS.media)score+=80;
 if(NEGATIVE.test(cap.id+' '+description))score-=200;
 return score;
}
export interface VideoChoice {capability:string|null;selection:'router'|'explicit'}
/** Highest score wins. A tie breaks to the lexicographically smaller id. Score ≤ 0 means the explicit fallback. */
export function routeCapability(role:VideoGenRole|'narration'|'stitch',catalog:readonly VideoCatalogEntry[]|undefined,explicit:string|null):VideoChoice{
 const rows=(catalog??[]).filter(cap=>cap&&typeof cap.id==='string'&&CAP_RE.test(cap.id));
 if(!rows.length)return {capability:explicit,selection:'explicit'};
 const ranked=rows.map(cap=>({id:cap.id,score:scoreCap(cap,role)})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||(a.id<b.id?-1:a.id>b.id?1:0));
 const best=ranked[0];
 if(!best)return {capability:explicit,selection:'explicit'};
 return {capability:best.id,selection:'router'};
}
function assignVisuals(inputs:VideoInput[],count:number):{perShot:string[][];unassigned:string[]}{
 const visuals=inputs.filter(input=>VISUAL.has(input.kind));
 const perShot:string[][]=Array.from({length:count},()=>[]);
 if(visuals.length===1){for(const row of perShot){const only=visuals[0];if(only)row.push(only.id);}return {perShot,unassigned:[]};}
 const limit=Math.min(count,visuals.length);
 for(let i=0;i<limit;i++){const visual=visuals[i];if(visual)perShot[i]?.push(visual.id);}
 return {perShot,unassigned:visuals.slice(count).map(visual=>visual.id)};
}
function knownIds(inputs:VideoInput[],ids:unknown):string[]{
 if(!Array.isArray(ids))fail('Shot inputs must be a list of ids');
 const allowed=new Set(inputs.map(input=>input.id));const out:string[]=[];
 for(const id of ids){
  const parsed=parseId(id);
  if(!allowed.has(parsed))fail('Shot input is not on the plan');
  if(!out.includes(parsed))out.push(parsed);
 }
 return out;
}
interface Material {brief:string;style:string;aspect:VideoAspect;inputs:VideoInput[];prompts:string[];durations:number[];cameras:string[];motions:string[];shotInputs:string[][];durationClamped:boolean}
function materialFromRequest(data:Record<string,unknown>):Material{
 for(const key of Object.keys(data))if(!REQUEST_KEYS.has(key))fail('Unknown video plan field');
 const brief=parseBrief(data.brief),style=parseStyle(data.style),aspect=parseAspect(data.aspect),inputs=parseInputs(data.inputs);
 if(!Array.isArray(data.prompts))fail('Prompts must be a list');
 if(data.prompts.length<1)fail('At least one prompt is required');
 if(data.prompts.length>VIDEO_MAX_SHOTS)fail('At most 18 shots');
 const prompts=data.prompts.map(parsePrompt);
 const split=splitDuration(parseDurationRequest(data.duration_s),prompts.length);
 const motion=defaultMotion(style);
 const assigned=assignVisuals(inputs,prompts.length);
 return {brief,style,aspect,inputs,prompts,durations:split.durations,cameras:prompts.map(()=>'locked medium'),motions:prompts.map(()=>motion),shotInputs:assigned.perShot,durationClamped:split.clamped};
}
function materialFromPlan(data:Record<string,unknown>):Material{
 const brief=parseBrief(data.brief),style=parseStyle(data.style),aspect=parseAspect(data.aspect),inputs=parseInputs(data.inputs);
 if(!Array.isArray(data.scenes)||data.scenes.length<1)fail('At least one scene is required');
 const prompts:string[]=[],durations:number[]=[],cameras:string[]=[],motions:string[]=[],shotInputs:string[][]=[];
 const fallback=defaultMotion(style);
 for(const scene of data.scenes){
  const row=obj(scene);
  if(!Array.isArray(row.shots)||row.shots.length<1)fail('Each scene needs a shot');
  for(const shot of row.shots){
   const item=obj(shot);
   prompts.push(parsePrompt(item.prompt));
   if(typeof item.duration_s!=='number'||!Number.isInteger(item.duration_s)||item.duration_s<2||item.duration_s>15)fail('Shot duration must be an integer from 2 to 15 seconds');
   durations.push(item.duration_s);
   const camera=item.camera===undefined||item.camera===''?'locked medium':item.camera;
   const motion=item.motion===undefined||item.motion===''?fallback:item.motion;
   if(typeof camera!=='string'||!camera.trim()||camera.length>80)fail('Invalid camera');
   if(typeof motion!=='string'||!motion.trim()||motion.length>80)fail('Invalid motion');
   cameras.push(camera.trim());motions.push(motion.trim());
   shotInputs.push(item.inputs===undefined?[]:knownIds(inputs,item.inputs));
  }
 }
 if(prompts.length>VIDEO_MAX_SHOTS)fail('At most 18 shots');
 const claimed=new Set(shotInputs.flat());
 const unassignedLater=inputs.filter(input=>VISUAL.has(input.kind)&&!claimed.has(input.id)).map(input=>input.id);
 void unassignedLater;
 return {brief,style,aspect,inputs,prompts,durations,cameras,motions,shotInputs,durationClamped:data.durationClamped===true};
}
function attachScripts(inputs:VideoInput[],shotInputs:string[][],index:number):string[]{
 const ids=[...shotInputs[index]??[]];
 const byId=new Map(inputs.map(input=>[input.id,input]));
 const carriesFace=ids.some(id=>byId.get(id)?.kind==='face');
 if(!carriesFace||!inputs.some(input=>input.kind==='script'))return ids;
 for(const input of inputs)if(input.kind==='script'&&!ids.includes(input.id))ids.push(input.id);
 return ids;
}
function roleFor(inputs:VideoInput[],ids:string[]):VideoGenRole{
 const byId=new Map(inputs.map(input=>[input.id,input]));
 const kinds=ids.map(id=>byId.get(id)?.kind).filter((kind):kind is VideoInputKind=>!!kind);
 if(kinds.includes('face')&&inputs.some(input=>input.kind==='script'))return 'lip_sync';
 if(kinds.some(kind=>kind==='image'||kind==='clip'||kind==='reference'||kind==='face'))return 'image_to_video';
 return 'text_to_video';
}
function explicitFor(role:VideoGenRole):string{
 if(role==='lip_sync')return VIDEO_CAPS.lipSync;
 return VIDEO_CAPS.media;
}
function sha256(material:Material):string{
 const canonical={aspect:material.aspect,brief:material.brief,camera:material.cameras,duration_s:material.durations,inputs:material.inputs.map(input=>input.id).sort(),motion:material.motions,prompts:material.prompts,style:material.style};
 return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function budgetFor(shots:number):VideoPlan['budget']{
 const calls=shots*VIDEO_RATES.calls+VIDEO_RATES.overheadCalls;
 const cost=Math.round(shots*VIDEO_RATES.costUsd*100)/100;
 const wall=shots*VIDEO_RATES.wallS+VIDEO_RATES.overheadWallS;
 const clamped=clampAdkBudget({max_calls:calls,max_cost_usd:cost,max_wall_s:wall});
 return {...clamped,clamped:clamped.max_calls!==calls||clamped.max_cost_usd!==cost||clamped.max_wall_s!==wall};
}
function clip(text:string,max:number):string{return text.length>max?text.slice(0,max)+'…':text;}
function instructionFor(plan:VideoPlan):string{
 const lines=['You are an Echo video producer named '+plan.name+'.','Never handle credentials, tokens, leases, or raw bytes. Pass library and artifact ids only.','If a capability is unavailable, stop and name it. Do not substitute another provider.',
  'Brief: '+clip(plan.brief,500),'Style: '+(plan.style||'(none)'),'Aspect: '+plan.aspect+' ('+plan.resolution.width+'×'+plan.resolution.height+').','Voice: '+VIDEO_VOICE+' via '+plan.narration.capability+'.',
  'Inputs: '+(plan.inputs.map(input=>input.id+' ('+input.kind+')').join(', ')||'(none)')+'.','Shots:'];
 for(const scene of plan.scenes)for(const shot of scene.shots){
  lines.push(shot.id+' '+shot.duration_s+'s, camera '+shot.camera+', motion '+shot.motion+', via '+shot.generation.capability+' ('+shot.generation.role+', '+shot.generation.selection+'). Inputs: '+(shot.inputs.join(', ')||'(none)')+'. Prompt: '+clip(shot.prompt,240));
 }
 const stitch=plan.stitch.capability?plan.stitch.capability:'a FORGE ffmpeg job (no stitch capability is registered; do not invent one)';
 lines.push('Narrate with the '+VIDEO_VOICE+' voice.','Stitch the shots in order with '+stitch+'.','QC the duration, the resolution, and missing shots.','Deliver the artifact id and a preview. Full prompts are on the storyboard, not in this instruction.');
 const text=lines.join('\n');
 return text.length>12000?text.slice(0,11990)+'\n[clipped]':text;
}
/** Storyboard plus cost and time. Accepts the plan request, or a previously returned plan (scenes win) so an edited shot is revalidated and caps are recomputed. */
export function planVideo(input:unknown,catalog?:readonly VideoCatalogEntry[]):VideoPlan{
 refuseSecrets(input);
 const data=obj(input);
 const material=Array.isArray(data.scenes)?materialFromPlan(data):materialFromRequest(data);
 const count=material.prompts.length;
 const scripts=material.inputs.some(input=>input.kind==='script');
 const shotIds=material.shotInputs.map((_,index)=>attachScripts(material.inputs,material.shotInputs,index));
 const choices=shotIds.map(ids=>{
  const role=roleFor(material.inputs,ids);
  const choice=routeCapability(role,catalog,explicitFor(role));
  return {role,capability:choice.capability??explicitFor(role),selection:choice.selection};
 });
 const narration=routeCapability('narration',catalog,VIDEO_CAPS.narration);
 const narrationCap=narration.capability??VIDEO_CAPS.narration;
 const stitchChoice=routeCapability('stitch',catalog,null);
 const resolution=ASPECTS[material.aspect];
 const scenes=material.prompts.map((prompt,index)=>{
  const choice=choices[index]??{role:'text_to_video' as const,capability:VIDEO_CAPS.media,selection:'explicit' as const};
  const shot:VideoShot={id:'shot-'+(index+1),scene:index+1,index:1,prompt,duration_s:material.durations[index]??6,camera:material.cameras[index]??'locked medium',motion:material.motions[index]??'gentle drift',inputs:shotIds[index]??[],generation:choice};
  return {id:'scene-'+(index+1),title:'Scene '+(index+1),shots:[shot]};
 });
 const steps:VideoStep[]=[];
 for(const scene of scenes)for(const shot of scene.shots)steps.push({id:'generate-'+shot.id,kind:'generate',shot:shot.id,capability:shot.generation.capability,selection:shot.generation.selection,role:shot.generation.role});
 steps.push({id:'narrate',kind:'narrate',capability:narrationCap,selection:narration.selection,voice:VIDEO_VOICE});
 if(stitchChoice.capability)steps.push({id:'stitch',kind:'stitch',capability:stitchChoice.capability,selection:'router'});
 else steps.push({id:'stitch',kind:'forge-ffmpeg-job',capability:null,selection:'explicit',node:'forge'});
 steps.push({id:'qc',kind:'qc',capability:null,checks:['duration','resolution','missing-shots']});
 steps.push({id:'deliver',kind:'deliver',capability:null});
 const capabilities:string[]=[];
 for(const step of steps)if(step.capability&&!capabilities.includes(step.capability))capabilities.push(step.capability);
 if(capabilities.includes(VIDEO_CAPS.media)&&!capabilities.includes(VIDEO_CAPS.jobStatus))capabilities.splice(capabilities.indexOf(VIDEO_CAPS.media)+1,0,VIDEO_CAPS.jobStatus);
 const duration=material.durations.reduce((sum,item)=>sum+item,0);
 const claimed=new Set(shotIds.flat());
 const unassigned=material.inputs.filter(input=>VISUAL.has(input.kind)&&!claimed.has(input.id)).map(input=>input.id);
 const budget=budgetFor(count);
 const plan:VideoPlan={
  schema:VIDEO_PLAN_SCHEMA,name:'video-'+slugify(material.brief),brief:material.brief,style:material.style,aspect:material.aspect,duration_s:duration,resolution,
  inputs:material.inputs,unassigned,scenes,steps,capabilities,budget,
  estimate:{shots:count,calls:count*VIDEO_RATES.calls+VIDEO_RATES.overheadCalls,cost_usd:Math.round(count*VIDEO_RATES.costUsd*100)/100,wall_s:count*VIDEO_RATES.wallS+VIDEO_RATES.overheadWallS,duration_s:duration},
  max_steps:videoMaxSteps(count),lane:{node:capabilities.includes(VIDEO_CAPS.media)?'temper':'forge',model:'qwen-local'},
  origin:{by:'echo',prompt_sha256:sha256(material)},
  narration:{capability:narrationCap,voice:VIDEO_VOICE,selection:narration.selection},
  stitch:stitchChoice.capability?{kind:'stitch',capability:stitchChoice.capability,selection:'router'}:{kind:'forge-ffmpeg-job',capability:null,node:'forge',selection:'explicit'},
  qc:{duration_s:duration,width:resolution.width,height:resolution.height,shots:count},durationClamped:material.durationClamped,
 };
 debug('%j',{event:'prime_video_plan',name:plan.name,shots:count,capabilities:plan.capabilities,clamped:budget.clamped,max_steps:plan.max_steps,stitch:plan.stitch.kind,lipsync:choices.some(choice=>choice.role==='lip_sync'),scripts});
 return plan;
}
/** Wraps a normalized plan as an EchoAgent definition. Caps and the budget are taken from the recomputed plan, never from the caller. */
export function buildVideoAgent(input:unknown,catalog?:readonly VideoCatalogEntry[]):VideoAgentDefinition{
 const plan=planVideo(input,catalog);
 const definition:VideoAgentDefinition={
  name:plan.name,role:'producer',skills:[...VIDEO_SKILLS],capabilities:[...plan.capabilities],
  lane:{node:plan.lane.node,model:plan.lane.model,budget:{max_calls:plan.budget.max_calls,max_cost_usd:plan.budget.max_cost_usd,max_wall_s:plan.budget.max_wall_s}},
  max_steps:plan.max_steps,instruction:instructionFor(plan),source:'agents/video/'+plan.name+'.json',origin:plan.origin,inputs:plan.inputs,plan,
 };
 debug('%j',{event:'prime_video_agent',name:definition.name,shots:plan.estimate.shots,capabilities:definition.capabilities,max_steps:definition.max_steps,source:definition.source});
 return definition;
}
/** Prompt passed to an existing ADK run. The storyboard already lives on the agent; this text stays short and carries no ids beyond the agent name. */
export function videoRunPrompt(agent:string):string{
 return 'Produce the video for agent '+agent+'. Follow the storyboard on the agent. Pass library and artifact ids only. Do not include credentials, leases, or raw bytes. Narrate with the freeman voice, stitch the shots, check duration, resolution and missing shots, and deliver the artifact id and a preview.';
}
