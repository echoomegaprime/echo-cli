import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { debuglog } from 'node:util';
import { redact } from '../code/workspace.js';
import {CHAT_PROMPT_MAX,type SharedChat,type SubmitContext} from './chat.js';
import {scorePersonalities,type CatalogLoader} from './personality.js';
import {disconnectedSteward,type StewardOwner} from './steward.js';
import type {ModelRouter} from '../code/model-factory.js';
import {SwarmError,type SwarmClient} from './swarm.js';
import {VoiceError,type VoiceClient} from './voice.js';
import {ADK_MAX_STEPS_CEILING,AdkError,type AdkClient} from './agents.js';
import {VideoAgentError,discoverVideoCatalog,offlineCatalog,parseVideoRequest,parseVideoRun,planVideo,resolveVideoInputs,videoAgentDefinition,videoRunPrompt,type VideoCatalog} from './videoagent.js';
import {MediaRouter,callKindOf,describeCandidate} from './media.js';
import {ADULT_NODE,adultFlagsOf,adultPolicy,isRouterCap,promptOfArguments} from './adult.js';
import {MediaCollector,defaultMediaConfig,mediaSaveDir,type InvokeKind,type MediaConfig} from './media-collect.js';
import {MediaJobs,type JobDescribe} from './media-jobs.js';
import {MediaOutcomes} from './media-outcomes.js';
import {PromptEnhancer} from './enhance.js';
import {WorkspaceHttpError} from './workspace.js';
import {BotsError,type BotsClient} from './bots.js';
import {BrowserError,type BrowserClient} from './browser.js';
import type {AutoAgents,ChatTool} from '../code/tools/autoagents.js';
import {UPLOAD_ID_RE,UploadError,validateStudioInputs,type UploadStore} from './uploads.js';
import type {ToolKit} from '../code/tools/index.js';
import {BuildError,type BuildRunner} from './build.js';
import {EshAutonomy,type AutonomyConfig} from '../code/tools/esh.js';
import {EcfTools} from '../code/tools/ecf.js';
import {ContinuityClient} from '../code/continuity.js';
import {type AutonomyEvents,envelope} from '../code/tools/autonomy.js';
const debugOwnerResponse=debuglog('echo-prime');
export type Json=Record<string,unknown>;
export interface Tool {name:string;description?:string;inputSchema:Json}
export interface McpConnection {listTools():Promise<Tool[]>;call(name:string,args:Json,options?:{timeoutMs?:number}):Promise<unknown>}
export interface Capability {id:string;registered:boolean;health:string;scope?:string;tier?:number;category:string;description:string}
export interface SdkBroker {
 search(query:string):Promise<Capability[]>;
 read(capability:string):Promise<unknown>;
 /** `timeoutMs` is how long this one call may take end to end (Prime's MCP wait and the bridge's gate wait). */
 invoke(request:{capability:string;params:Json;reason:string;idempotency_key:string},options?:{timeoutMs?:number}):Promise<unknown>;
}
export interface PrimeRequest {target:'sdk'|'esh';name:string;arguments:Json}
export interface PrimeOptions {
 capabilities:Capability[];sdk?:SdkBroker;esh?:McpConnection;chat?:SharedChat;steward?:StewardOwner;models?:ModelRouter;swarm?:SwarmClient;
 /** Opt-in loopback Echo voice gateway client. Absent = the route is off. */
 voice?:VoiceClient;
 /** Opt-in loopback `echo-adk-api` client (Agents view). Absent = the feature is off. */
 adk?:AdkClient;
 /** Auto media routing over this hub's catalog (built on demand from `capabilities`, `sdk.read` and `models` when absent). */
 media?:MediaRouter;
 /** Enhance-prompt runner over `models` (built on demand when absent; without `models` the route says enhancement is off). */
 enhancer?:PromptEnhancer;
 bots?:BotsClient;
 browser?:BrowserClient;
 /** Autonomous agent/bot creation from chat prompts (needs adk + bots + sdk). Absent = the make_* tools are not offered. */
 autoagents?:AutoAgents;
 uploads?:UploadStore;
 uploadsOwner?:string;
 /** The reviewed `media` section (call kinds the gate runs, time limits, where generated files may be read from). */
 mediaConfig?:MediaConfig;
 /** Recent real executions, used by the media router to stop offering tools that cannot run. */
 outcomes?:MediaOutcomes;
 /** Test-only seam: literal strings the adult classifier counts as an adult brief (fixtures never carry explicit text). Production supplies none. */
 adultMarkers?:readonly string[];
 /** Seams for tests: the HTTP client media files are fetched with, and the clock/sleep job polling uses. */
 mediaFetch?:typeof fetch;mediaClock?:{now:()=>number;sleep:(ms:number)=>Promise<void>};
 /** Always-on live tools for model turns (web, Wolfram, Echo knowledge/memory, skills, MCP); owner toggles per family. */
 tools?:ToolKit;
 build?:BuildRunner;
 autonomy?:AutonomyConfig;ecf?:EcfTools;autonomyEvents?:AutonomyEvents;
 /** Existing host approval, never supplied by model output or the browser. */
 approveEsh?:(request:PrimeRequest,digest:string)=>Promise<boolean>;
}
export function object(v:unknown):Json{return v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};}
class Refused extends Error {}
function limited(v:unknown,max=131072){const s=JSON.stringify(v);if(!s||Buffer.byteLength(s)>max)throw new Refused('Payload exceeds bounded limit');return s;}
function failure(v:Json):never {
 const detail=typeof v.required==='string'?'Scope required: '+v.required:typeof v.error==='string'?v.error:typeof v.reason==='string'?v.reason:'Owner refused the request';
 throw new Refused(redact(detail).slice(0,600));
}
/** Decode known envelopes. Transport success is never proof of owner success. */
export function unwrap(value:unknown):unknown {
 let v=object(value);
 for(let i=0;i<8;i++){
  if(v.isError===true)failure(v);
  if(v.structuredContent&&typeof v.structuredContent==='object'){v=object(v.structuredContent);continue;}
  if(Array.isArray(v.content)){
   const first=v.content.find(b=>object(b).type==='text');
   try{v=object(JSON.parse(String(object(first).text)));continue;}catch{throw new Refused('Unrecognized MCP response');}
  }
  if(v.ok===false||v.success===false||['denied','gated','blocked'].includes(String(v.verdict))){
   if(v.required)failure(v);
   if(v.sdk_result){v=object(v.sdk_result);continue;}
   if(typeof v.body==='string'){try{const b=object(JSON.parse(v.body));failure(object(b.detail??b));}catch(e){if(e instanceof Refused)throw e;}}
   failure(v);
  }
  if(v.sdk_result){v=object(v.sdk_result);continue;}
  if(v.status==='error'||v.status==='failed')failure(v);
  if(typeof v.status_code==='number'){
   if(v.status_code<200||v.status_code>=300)failure(v);
   let body:unknown=v.body;
   if(typeof body==='string'){
    const bytes=Buffer.byteLength(body);
    if(bytes>1048576){
     debugOwnerResponse('%j',{event:'prime_owner_body_refused',category:'size_limit',bytes});
     throw new Refused('Payload exceeds bounded limit');
    }
    try{body=JSON.parse(body);}
    catch{
     debugOwnerResponse('%j',{event:'prime_owner_body_refused',category:'malformed_json'});
     throw new Refused('Unrecognized HTTP response body');
    }
    debugOwnerResponse('%j',{event:'prime_owner_body_decoded',bytes});
   }
   if(body===null||typeof body!=='object'||Array.isArray(body)){
    debugOwnerResponse('%j',{event:'prime_owner_body_refused',category:'non_object'});
    throw new Refused('Unrecognized HTTP response body');
   }
   v=body as Json;continue;
  }
  if(v.result&&(v.run_id||v.status==='ok'||object(v.result).status_code)){v=object(v.result);continue;}
  return v;
 }
 throw new Refused('Response nesting exceeds owner contract');
}
/** The owner's decoded answer inside an MCP/SDK envelope, with no success checks: what a refusal said (the media router
 * answers a failed job as {ok:false,status:'failed',error}). Bounded like unwrap; undefined when no object is found. */
export function ownerBody(value:unknown):Json|undefined{
 let v=object(value);
 for(let i=0;i<8;i++){
  if(v.structuredContent&&typeof v.structuredContent==='object'){v=object(v.structuredContent);continue;}
  if(Array.isArray(v.content)){const first=v.content.find(b=>object(b).type==='text');try{v=object(JSON.parse(String(object(first).text)));continue;}catch{return undefined;}}
  if(v.sdk_result&&typeof v.sdk_result==='object'){v=object(v.sdk_result);continue;}
  return Object.keys(v).length?v:undefined;
 }
 return undefined;
}
/** ElevenLabs op-router generators that answer binary audio (elevenlabs_ops.json `response: binary`, read 2026-11-06).
 * The router returns it base64 unless `_save_to` names a FORGE path, and base64 through the SDK bridge is capped at 1 MiB,
 * so Prime has the router save the file where Prime reads it. */
const ELEVENLABS_SAVES=/^echo\.elevenlabs\.(?:music_generation\.(?:generate|stream_compose)|sound_generation\.sound_generation)$/;
/** Longest ElevenLabs music Prime can receive inline: `output_format` auto is mp3_48000_192 for music v2 (24 KB/s, docs
 * elevenlabs.io api-reference/music/compose), 25 s is about 800 KB of base64, under the bridge's 1 MiB bound. */
const INLINE_MUSIC_MAX_MS=25000;
async function bounded<T>(work:()=>Promise<T>,ms=20000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owner timed out; outcome unknown')),ms);})]);}
 finally{clearTimeout(timer);}
}
const eshReads=new Set(['esh_status','esh_caps','esh_ledger','esh_session']);
type Ticket={id:string;digest:string;request:PrimeRequest;requestId:string;expiresAt:number;submitted:boolean;scope?:string;cost:string};
const digest=(request:PrimeRequest)=>createHash('sha256').update(JSON.stringify(request)).digest('hex');
export class PrimeHub {
 private catalog:Map<string,Capability>;private tickets=new Map<string,Ticket>();private tools:Tool[]=[];
 private eshAutonomy:EshAutonomy;private ecf:EcfTools;
 /** Video-related part of the live catalog, re-read at most once a minute (plan, create and re-plan reuse it). */
 private videoCatalogCache?:{at:number;catalog:VideoCatalog};
 constructor(private options:PrimeOptions){this.catalog=new Map(options.capabilities.map(c=>[c.id,{...c}]));
  this.eshAutonomy=new EshAutonomy({connection:options.esh,config:options.autonomy,events:options.autonomyEvents,prepare:r=>this.prepareTicket(r,true),execute:(id,hash)=>this.execute(id,hash)});
  this.ecf=options.ecf??new EcfTools(new ContinuityClient(),options.autonomyEvents);
 }
 /** One additive registry spread for the lead's owner tool loop. Never browser-supplied tools. */
 autonomyTools(){return [...this.eshAutonomy.tools(),...this.ecf.tools()];}
 capabilities(){return [...this.catalog.values()];}
 get uploads(){return this.options.uploads;}
 /** Additive server-side hook for producing modules to register outputs in the Artifact Center. */
 async registerArtifact(owner:string,input:unknown){
  if(!this.options.uploads)throw new UploadError(503,'Uploads and Artifact Center are not enabled: add an `uploads` section to the Prime config');
  return this.options.uploads.registerArtifact(owner,input);
 }
 async stewardStatus(){return this.options.steward?bounded(()=>this.options.steward!.status()):disconnectedSteward();}
 async stewardAsk(input:unknown){
  if(!this.options.steward)throw new Refused('Node Steward owner not connected');
  return bounded(()=>this.options.steward!.ask(input),60000);
 }
 /** Per-provider availability (cached 60 s) and the model that answered last. Never falls back or substitutes. */
 async models(){
  const router=this.options.models;
  const builds=this.options.build?await this.options.build.models():undefined;
  // The last Enhance failure per provider (an expired CLI sign-in, an unavailable provider): the Enhance chip skips them.
  const enhance={failures:(this.enhancer??this.options.enhancer)?.failures?.()??{}};
  if(!router)return {configured:false,routing:false,default:null,contextTokens:null,providers:[],enhance,...(builds?{buildProviders:builds}:{})};
  const report=await bounded(()=>router.report(),30000);
  // Echo Build runs the same CLIs under the same login: a sign-in failure the router saw on its last call makes that engine unavailable too.
  const buildProviders=builds?.map(row=>{const seen=report.providers.find(p=>p.id===row.id);return row.available&&seen&&!seen.available&&seen.lastFailure?.signedOut?{...row,available:false,reason:seen.reason}:row;});
  return {configured:true,routing:this.options.chat?.status().routing===true,...report,enhance,...(buildProviders?{buildProviders}:{})};
 }
 buildHealth(){return this.options.build?.health()??{configured:false,available:false,reason:'Echo Build is off: add a reviewed build section with root and engines to the Prime config'};}
 private buildRunner(){if(!this.options.build)throw new BuildError(503,'Echo Build is off: add a build section to the Prime config');return this.options.build;}
 buildList(){return this.buildRunner().list();}
 buildGet(id:string){return this.buildRunner().get(id);}
 buildLog(id:string,since:unknown){return this.buildRunner().log(id,since);}
 buildCreate(input:unknown){return this.buildRunner().create(input);}
 buildTurn(id:string,input:unknown){return this.buildRunner().turn(id,input);}
 buildHibernate(id:string){return this.buildRunner().hibernate(id);}
 buildRevive(id:string){return this.buildRunner().revive(id);}
 buildStop(id:string){return this.buildRunner().stop(id);}
 buildDeploy(id:string,input:unknown){return this.buildRunner().deploy(id,input);}
 buildDeploymentPlan(id:string,target:unknown){return this.buildRunner().deploymentPlan(id,target);}
 buildRepository(id:string,input:unknown){return this.buildRunner().repository(id,input);}
 buildPreview(id:string,path:string,base:string,signal?:AbortSignal){return this.buildRunner().preview(id,path,base,signal);}
 /** Opt-in 40-seat swarm worker: status never throws for an unconfigured or unreachable worker, it says why. Runs never fall back to another model. */
 async swarmHealth(signal?:AbortSignal){
  const swarm=this.options.swarm;
  if(!swarm)return {configured:false,available:false,reason:'Swarm is not enabled: the reviewed Prime configuration has no swarm section'};
  try{return {configured:true,available:true,defaultBudget:swarm.config.defaultBudget,worker:await swarm.health(signal)};}
  catch(e){return {configured:true,available:false,defaultBudget:swarm.config.defaultBudget,reason:e instanceof Error?redact(e.message).slice(0,300):'Swarm worker check failed'};}
 }
 private swarmClient(){if(!this.options.swarm)throw new SwarmError(503,'Swarm is not enabled: the reviewed Prime configuration has no swarm section');return this.options.swarm;}
 async swarmRun(input:unknown,signal?:AbortSignal){return this.swarmClient().run(input,signal);}
 async swarmStatus(runId:string,signal?:AbortSignal){return this.swarmClient().status(runId,signal);}
 async voiceStatus(signal?:AbortSignal){return this.options.voice?this.options.voice.status(signal):{configured:false,available:false,reason:"Echo's voice route is off: add a `voice` section to the Prime config"};}
 async voiceSpeak(input:unknown,signal?:AbortSignal){if(!this.options.voice)throw new VoiceError(503,"Echo's voice route is off: add a `voice` section to the Prime config");return this.options.voice.speak(input,signal);}
 /** Opt-in Echo ADK service: health never throws for an unconfigured or unreachable service, it says why. Runs never fall back to another provider. */
 async adkHealth(signal?:AbortSignal){
  const adk=this.options.adk;
  if(!adk)return {configured:false,available:false,reason:'Echo ADK is off: add an `adk` section to the Prime config'};
  try{return {configured:true,available:true,defaultBudget:adk.config.defaultBudget,service:await adk.health(signal)};}
  catch(e){return {configured:true,available:false,defaultBudget:adk.config.defaultBudget,reason:e instanceof Error?redact(e.message).slice(0,300):'Echo ADK check failed'};}
 }
 private adkClient(){if(!this.options.adk)throw new AdkError(503,'Echo ADK is off: add an `adk` section to the Prime config');return this.options.adk;}
 async adkAgents(signal?:AbortSignal){return this.adkClient().agents(signal);}
 async adkAgent(name:string,signal?:AbortSignal){return this.adkClient().agent(name,signal);}
 async adkRun(input:unknown,signal?:AbortSignal){return this.adkClient().run(input,signal);}
 async adkStatus(runId:string,signal?:AbortSignal){return this.adkClient().status(runId,signal);}
 async adkStop(runId:string,signal?:AbortSignal){return this.adkClient().stop(runId,signal);}
 async adkRuns(query:unknown,signal?:AbortSignal){return this.adkClient().runs(query,signal);}
 /** Agent definitions Prime creates, replaces or deletes (contract `POST/PUT/DELETE /agents`). Owner-only routes; the client validates before any request. */
 async adkCreateAgent(input:unknown,signal?:AbortSignal){return this.adkClient().createAgent(input,signal);}
 async adkUpdateAgent(name:string,input:unknown,signal?:AbortSignal){return this.adkClient().updateAgent(name,input,signal);}
 async adkDeleteAgent(name:string,signal?:AbortSignal){return this.adkClient().deleteAgent(name,signal);}
 /** Video agent builder: what can work on this host and why not. Never throws and requests nothing. */
 videoStatus(){
  const adk=!!this.options.adk,catalog=!!this.options.sdk,uploads=!!this.options.uploads;
  const reasons=[...(adk?[]:['Echo ADK is off (add an `adk` section to the Prime config)']),...(catalog?[]:['the live capability catalog is not connected (the Prime config has no `sdk` section, so no capability id can be verified)'])];
  return {configured:adk&&catalog,adk,catalog,uploads,...(reasons.length?{reason:'Video agents cannot be created: '+reasons.join('; ')+'. Storyboards still plan.'}:{})};
 }
 private async videoCatalog(signal?:AbortSignal):Promise<VideoCatalog>{
  const sdk=this.options.sdk;
  if(!sdk)return offlineCatalog('The live capability catalog is not connected: the Prime config has no `sdk` section, so no capability id can be verified. Nothing can be created until it is.');
  const hit=this.videoCatalogCache;
  if(hit&&Date.now()-hit.at<60000)return hit.catalog;
  if(signal?.aborted)throw new VideoAgentError(499,'Interrupted');
  const catalog=await discoverVideoCatalog({read:async id=>unwrap(await sdk.read(id)),search:query=>sdk.search(query)});
  if(catalog.live)this.videoCatalogCache={at:Date.now(),catalog};
  return catalog;
 }
 private async videoMaterial(input:unknown,signal?:AbortSignal){
  const material=parseVideoRequest(input);
  const [inputs,catalog]=await Promise.all([resolveVideoInputs(material.inputs,this.options.uploads,this.options.uploadsOwner??'local'),this.videoCatalog(signal)]);
  return {material,plan:planVideo(material,inputs,catalog)};
 }
 /** Storyboard + routed capabilities + budget for a request (`prompts`) or an edited storyboard (`shots`). Owner-only route. */
 async videoPlan(input:unknown,signal?:AbortSignal){return {plan:(await this.videoMaterial(input,signal)).plan};}
 /** Creates the `video-<slug>` producer agent from the recomputed plan. The same storyboard twice returns the existing agent; a
  *  name taken by anything else is refused (nothing is renamed or overwritten). */
 async videoAgent(input:unknown,signal?:AbortSignal){
  const adk=this.adkClient();
  const {plan}=await this.videoMaterial(input,signal);
  const definition=videoAgentDefinition(plan);
  try{
   const agent=await adk.createAgent(definition,signal,{maxSteps:ADK_MAX_STEPS_CEILING});
   return {agent,plan,existing:false};
  }catch(error){
   if(!(error instanceof AdkError)||error.detail.http!==409)throw error;
   const taken=await adk.agent(definition.name,signal).catch(()=>undefined);
   if(taken&&object(taken.origin).prompt_sha256===plan.origin.prompt_sha256)return {agent:taken,plan,existing:true};
   throw new VideoAgentError(409,'An agent named '+definition.name+' already exists and was not made from this storyboard. Give the video a different name; nothing was created or replaced.');
  }
 }
 /** Starts a run of a video agent through Echo ADK. Without a budget the agent's own lane budget is used (the service clamps it). */
 async videoRun(input:unknown,signal?:AbortSignal){
  const adk=this.adkClient(),request=parseVideoRun(input);
  const record=await adk.agent(request.agent,signal);
  if(record.role!=='producer')throw new VideoAgentError(400,request.agent+' is not a video producer agent');
  const lane=object(object(record.lane).budget);
  const budget=request.budget!==undefined?request.budget:Object.keys(lane).length?lane:undefined;
  return adk.run({agent:request.agent,prompt:videoRunPrompt(request.agent),...(budget!==undefined?{budget}:{})},signal);
 }
 /** The autonomous-creation chat tools in registration shape; an empty list when the feature is off. The tool loop spreads this into its tools. */
 autoagentTools():ChatTool[]{return this.options.autoagents?this.options.autoagents.tools():[];}
 autoagentsStatus(){return this.options.autoagents?this.options.autoagents.status():{configured:false,reason:'Autonomous agents are off: the Prime config needs adk, bots and sdk configured'};}
 /** Opt-in echoBots (loopback echo-adk-api): health never throws for an unconfigured or unreachable service, it says why. Nothing here falls back. */
 async botsHealth(signal?:AbortSignal){
  const bots=this.options.bots;
  if(!bots)return {configured:false,available:false,reason:'echoBots is not enabled: the reviewed Prime configuration has no bots section'};
  try{return {configured:true,available:true,defaultBudget:bots.config.defaultBudget,service:await bots.health(signal)};}
  catch(e){return {configured:true,available:false,defaultBudget:bots.config.defaultBudget,reason:e instanceof Error?redact(e.message).slice(0,300):'echoBots service check failed'};}
 }
 private botsClient(){if(!this.options.bots)throw new BotsError(503,'echoBots is not enabled: the reviewed Prime configuration has no bots section');return this.options.bots;}
 async botsList(signal?:AbortSignal){return this.botsClient().list(signal);}
 async botsGet(botId:string,signal?:AbortSignal){return this.botsClient().get(botId,signal);}
 async botsCreate(input:unknown,signal?:AbortSignal){return this.botsClient().create(input,signal);}
 async botsAction(botId:string,action:string,signal?:AbortSignal){
  const bots=this.botsClient();
  if(action==='pause')return bots.pause(botId,signal);
  if(action==='resume')return bots.resume(botId,signal);
  if(action==='delete')return bots.remove(botId,signal);
  throw new BotsError(404,'Unknown echoBots action');
 }
 async botsMessage(botId:string,input:unknown,signal?:AbortSignal){return this.botsClient().message(botId,input,signal);}
 async botsMessages(botId:string,options:{since?:unknown;limit?:unknown},signal?:AbortSignal){return this.botsClient().messages(botId,options,signal);}
 async botsGroupCreate(input:unknown,signal?:AbortSignal){return this.botsClient().createGroup(input,signal);}
 async botsGroup(groupId:string,signal?:AbortSignal){return this.botsClient().group(groupId,signal);}
 /** Opt-in in-chat browser (the Commander's own ShadowGlass Chrome via the loopback relay). Status never throws for an
  *  unconfigured or disconnected relay; it says why. Owner-only is enforced by the Prime server, not here. */
 async browserStatus(signal?:AbortSignal){
  const browser=this.options.browser;
  if(!browser)return {configured:false,available:false,reason:'In-chat browser is off: the reviewed Prime configuration has no browser section'};
  try{const h=await browser.health(signal);return {configured:true,available:h.extConnected===true,relayUrl:browser.config.relayUrl,...(h.extConnected?{}:{reason:'ShadowGlass side panel is not connected on the Commander\'s Chrome'})};}
  catch(e){return {configured:true,available:false,relayUrl:browser.config.relayUrl,reason:e instanceof Error?redact(e.message).slice(0,300):'Relay status check failed'};}
 }
 private browserClient(){if(!this.options.browser)throw new BrowserError(503,'In-chat browser is off: the reviewed Prime configuration has no browser section');return this.options.browser;}
 async browserTabs(signal?:AbortSignal){return this.browserClient().tabs(signal);}
 async browserSnapshot(tab:number,withShot:boolean,signal?:AbortSignal){return this.browserClient().snapshot(tab,withShot,signal);}
 /** One governed entrypoint for every mutating browser verb; the server routes `/api/prime/browser/act` here (owner-only). */
 async browserAct(input:unknown,signal?:AbortSignal){
  const b=this.browserClient(),data=object(input),verb=String(data.verb??'');
  switch(verb){
   case 'open':return b.open(data.url,signal);
   case 'close':return b.close(data.tab,signal);
   case 'navigate':return b.navigate(data.tab,data.url,signal);
   case 'back':case 'forward':case 'reload':return b.nav(data.tab,verb,signal);
   case 'scroll':return b.scroll(data.tab,data.step??data.dy,signal);
   case 'click':return b.click(data.tab,{x:data.x,y:data.y,text:data.text},signal);
   case 'type':return b.type(data.tab,data.text,signal);
   case 'fill':return b.fill(data.tab,data.selector,data.value,signal);
   case 'read':return b.read(data.tab,data.selector,signal);
   default:throw new BrowserError(400,'Unknown browser verb');
  }
 }
 async chat(input:unknown,signal?:AbortSignal,context:SubmitContext={}){
  if(!this.options.chat)throw new Refused('Shared chat host not connected; owner admission is required');
  if(!input||typeof input!=='object'||Array.isArray(input)||!('attachments' in input))return this.options.chat.submit(input,signal,context);
  // Attachments are Prime uploads (upl_…), read here and appended to the prompt. Anything else is refused by name, never
  // dropped (review 2026-11-06: Workspace library ids were deleted without a word), and so is a prompt the files push past
  // the chat limit (SharedChat would only say "Invalid chat request").
  const payload={...(input as Json)},list=payload.attachments;delete payload.attachments;
  if(!Array.isArray(list))throw new Refused('Attachments must be a list of Prime upload ids; nothing was sent');
  if(!list.length)return this.options.chat.submit(payload,signal,context);
  if(list.length>8)throw new Refused('Attach at most eight files');
  const foreign=list.findIndex(id=>typeof id!=='string'||!UPLOAD_ID_RE.test(id));
  if(foreign>=0)throw new Refused(`Attachment ${foreign+1} is not a Prime upload: files from the Workspace library are read only by the Workspace conversation. Remove it and send again; nothing was sent`);
  if(!this.options.uploads)throw new Refused('File uploads are not configured on this host. Remove the attached files and send again; nothing was sent');
  const blocks:string[]=[];
  for(const id of list as string[]){
   const extracted=await this.options.uploads.extractForChat(this.options.uploadsOwner??'local',id);
   blocks.push(`File: ${extracted.meta.name} (${extracted.meta.type})\n${extracted.extracted?extracted.text:`[${extracted.reason??'text not extracted'}]`}`);
  }
  if(typeof payload.prompt==='string'){
   const added=`\n\nAttached uploads (untrusted document content):\n\n${blocks.join('\n\n---\n\n')}`,total=payload.prompt.length+added.length,n=(value:number)=>value.toLocaleString('en-US');
   if(total>CHAT_PROMPT_MAX)throw new Refused(`With the attached files the message is ${n(total)} characters, over the ${n(CHAT_PROMPT_MAX)}-character chat limit (${n(added.length)} characters from the attached files). Remove an attachment or shorten the message; nothing was sent`);
   payload.prompt+=added;
  }
  return this.options.chat.submit(payload,signal,context);
 }
 /** "Verify" action: evidence for each claim in the last reply of a conversation. */
 async verify(input:unknown,signal?:AbortSignal){
  if(!this.options.chat)throw new Refused('Shared chat host not connected; owner admission is required');
  return this.options.chat.verify(input,signal);
 }
 private forge(){const forge=this.options.chat?.personality;if(!forge)throw new Refused('Personality Forge is not attached to this host');return forge;}
 /** Owner view of the Personality Forge: settings, the catalog (Workspace list when the loader is bound, else built-in) and the last selection. */
 async personality(loader?:CatalogLoader){
  const forge=this.options.chat?.personality;
  if(!forge)return {configured:false,settings:null,catalog:{entries:[],source:'none',reason:'Personality Forge is not attached to this host'},last:null};
  return {configured:true,settings:forge.settings(),catalog:await bounded(()=>forge.catalog(loader),30000),last:forge.last()};
 }
 /** Owner setting: {enabled?, pinned?}. Persisted by the forge. */
 async personalitySettings(input:unknown){return this.forge().update(input);}
 /** Score-only preview for the Workspace conversation path: the browser sends the message and recent turns, gets the pick, then calls the Workspace's own personality_select. */
 async personalitySelect(input:unknown,loader?:CatalogLoader){
  const forge=this.forge(),data=object(input);
  if(typeof data.text!=='string'||!data.text.trim()||data.text.length>12000)throw new Refused('Invalid personality request');
  const history=Array.isArray(data.history)?data.history.slice(-12).filter(h=>h&&typeof h==='object'&&typeof (h as {role?:unknown}).role==='string'&&typeof (h as {content?:unknown}).content==='string').map(h=>({role:String((h as {role:string}).role).slice(0,20),content:String((h as {content:string}).content).slice(0,4000)})):[];
  const settings=forge.settings();
  if(!settings.enabled)return {enabled:false,selection:null};
  const {entries,source}=await bounded(()=>forge.catalog(loader),30000);
  const names=new Map(entries.map(e=>[e.id,e.name]));
  if(settings.pinned)return {enabled:true,selection:{id:settings.pinned,name:names.get(settings.pinned)??settings.pinned,reason:'pinned by the owner',pinned:true},source};
  const {ranked,intent,tone}=scorePersonalities(data.text,history,entries),best=ranked[0];
  const reason=[intent?`${intent} intent`:'no clear intent',tone?`${tone} tone`:null,best.cues.length?`cues: ${best.cues.map(c=>`'${c}'`).join(', ')}`:(best.id==='echo'?'default':null)].filter(Boolean).join('; ');
  return {enabled:true,selection:{id:best.id,name:names.get(best.id)??best.id,reason,pinned:false},source};
 }
 /** Live tools report: families, per-tool availability (gate attached, roots configured, allow-list), budget, cache. Never throws for an unconfigured kit. */
 liveTools(){
  const kit=this.options.tools;
  if(!kit)return {configured:false,enabled:false,families:[],reason:'Live tools are off: the reviewed Prime configuration has tools.enabled=false or no model router'};
  return {configured:true,...kit.report()};
 }
 /** Owner runtime toggle: `{enabled}` for all tools or `{family,enabled}` for one family. In-memory until restart. */
 liveToolsUpdate(input:unknown){
  const kit=this.options.tools;
  if(!kit)throw new Refused('Live tools are not configured on this host');
  const data=object(input);
  if(Object.keys(data).some(k=>!['family','enabled'].includes(k))||typeof data.enabled!=='boolean')throw new Refused('Tool toggle needs {enabled} or {family, enabled}');
  if(data.family===undefined)kit.setEnabled(data.enabled);
  else{if(typeof data.family!=='string')throw new Refused('Unknown tool family');try{kit.setFamily(data.family,data.enabled);}catch(e){throw new Refused(e instanceof Error?e.message:'Unknown tool family');}}
  return {configured:true,...kit.report()};
 }
 private media?:MediaRouter;private enhancer?:PromptEnhancer;
 /** Auto media routing: classify the prompt, rank the catalog's generators, return one explicit pick plus alternatives.
  * Spends nothing: the pick is a request shape for the existing prepare -> review -> execute path. Health probes reuse the
  * same `sdk.read` that `prepare` trusts (unwrapped, bounded, cached 60 s in the router). The candidates come from the live
  * catalog: kind-scoped `sdk.search` calls through the broker (5 s each, cached 60 s per kind), overlaid on the snapshot;
  * live rows are kept in this hub's catalog like `/api/search` results (the snapshot's Studio medium is preserved, and a
  * live row without health keeps the snapshot's health instead of erasing it). */
 async mediaRoute(input:unknown,signal?:AbortSignal){
  const sdk=this.options.sdk;
  this.media??=this.options.media??new MediaRouter({catalog:()=>this.capabilities(),read:sdk?id=>bounded(()=>sdk.read(id),8000).then(unwrap):undefined,
   search:sdk?query=>sdk.search(query):undefined,
   onDiscovered:rows=>{for(const c of rows){if(!/^echo\.[A-Za-z0-9_.-]+$/.test(c.id))continue;const old=this.catalog.get(c.id);this.catalog.set(c.id,old?{...old,registered:c.registered,health:c.health==='unknown'&&old.health?old.health:c.health}:{...c});}},
   outcomes:this.outcomes(),callKinds:this.mediaConfig().gateCallKinds,denyCallKinds:this.mediaConfig().denyCallKinds,models:this.options.models,adultMarkers:this.options.adultMarkers});
  return this.media.route(input,signal);
 }
 /** Enhance prompt on exactly the chosen provider through the reviewed model router. No router = the feature is off (503). */
 async enhance(input:unknown,sessionKey:string,signal?:AbortSignal){
  if(!this.options.models&&!this.options.enhancer)throw new WorkspaceHttpError(503,'Prompt enhancement is off: the reviewed Prime configuration has no models section, so no provider can be asked');
  this.enhancer??=this.options.enhancer??new PromptEnhancer(this.options.models!,{adultMarkers:this.options.adultMarkers});
  return this.enhancer.enhance(input,sessionKey,signal);
 }
 private mediaConfig(){return this.options.mediaConfig??defaultMediaConfig();}
 private outcomeStore?:MediaOutcomes;
 /** Real execution outcomes (the configured store, or an in-memory one for this process). */
 outcomes(){return this.outcomeStore??=this.options.outcomes??new MediaOutcomes();}
 private jobs?:MediaJobs;
 /** Kind, provider, label and call kind of a capability, from this hub's catalog (live rows included). */
 private describeCapability(id:string):JobDescribe{
  const c=this.catalog.get(id)??{id,registered:true,health:'unknown',category:'tools',description:''};
  const cand=describeCandidate(c),kind=cand?.kinds[0];
  const invokeKind:InvokeKind=kind&&kind!=='chat'?kind:'other';
  return {kind:invokeKind,provider:cand?.provider??(id.split('.')[1]||'unknown'),label:cand?.label??id.replace(/^echo\./,''),...(callKindOf(c)?{callKind:callKindOf(c)}:{})};
 }
 private mediaJobs(){
  const sdk=this.options.sdk!,config=this.mediaConfig();
  return this.jobs??=new MediaJobs({config,outcomes:this.outcomes(),uploads:this.options.uploads,owner:this.options.uploadsOwner??'local',
   collector:new MediaCollector({config,fetch:this.options.mediaFetch,maxBytes:this.options.uploads?.config.maxBytes}),
   describe:id=>this.describeCapability(id),now:this.options.mediaClock?.now,sleep:this.options.mediaClock?.sleep,
   invoke:async(capability,params,key,reason,timeoutMs)=>{
    let raw:unknown;
    try{
     raw=await bounded(()=>sdk.invoke({capability,params,reason,idempotency_key:key},{timeoutMs}),timeoutMs+10000);
     const result=unwrap(raw);limited(result,1048576);
     return {ok:true,body:object(result)};
    }catch(e){
     const detail=e instanceof Error?redact(e.message).slice(0,600):'Owner call failed';
     // Prime's own MCP request budget was full: the call never left Prime, so it is neither a refusal nor an unknown outcome.
     if(/request limit reached/i.test(detail))return {ok:false,refused:true,notSent:true,detail:'Prime did not send '+capability+': '+detail+'. Nothing reached the gate or the provider; review and submit it again once a running request finishes.'};
     const body=raw===undefined?undefined:ownerBody(raw);
     // The bridge reports its own gate timeout as a failure text; that is an unknown outcome, not a refusal.
     return {ok:false,refused:e instanceof Refused&&!/outcome unknown|timed out/i.test(detail),detail,...(body?{body}:{})};
    }
   }});
 }
 /** State of a Studio request this Prime executed (by the request id from its review ticket). */
 mediaJob(input:unknown){
  const requestId=object(input).requestId;
  const view=this.jobs&&typeof requestId==='string'?this.jobs.status(requestId):undefined;
  if(!view)throw new WorkspaceHttpError(404,'No Studio request with that ID is known to this Prime (it may have restarted). Check the gate execution log before submitting again.');
  return view;
 }
 /** Test hook: resolves when a background Studio request has finished. */
 mediaJobSettled(requestId:string){return this.jobs?.settled(requestId)??Promise.resolve();}
 async refresh(query:string){
  if(!this.options.sdk)throw new Refused('SDK host not connected');
  if(typeof query!=='string'||!query.trim()||query.length>150)throw new Refused('Enter a bounded search');
  const rows=await bounded(()=>this.options.sdk!.search(query));
  if(!Array.isArray(rows)||rows.length>100)throw new Refused('Invalid SDK catalog');
  for(const c of rows)if(/^echo\.[A-Za-z0-9_.-]+$/.test(c.id))this.catalog.set(c.id,{...c});
  return rows;
 }
 async status(){
  const esh:{state:string;detail:string;version?:string;ledgerVerified?:boolean;tools?:Tool[]}={state:'disconnected',detail:'ESH host not connected'};
  if(this.options.esh){try{
   const s=object(unwrap(await bounded(()=>this.options.esh!.call('esh_status',{}))));
   if(s.ok!==true||typeof s.version!=='string')throw new Refused('ESH identity unverified');
   this.tools=await bounded(()=>this.options.esh!.listTools());
   if(!this.tools.some(t=>t.name==='esh_status'))throw new Refused('ESH tool contract missing');
   esh.state=s.killed||s.deadman_expired?'blocked':'connected';
   esh.detail='Policy: '+String(s.policy_source??'unknown')+'; mode: '+String(s.policy_mode??'unknown');
   esh.version=s.version;esh.ledgerVerified=object(s.ledger).ok===true;esh.tools=this.tools;
  }catch(e){this.tools=[];esh.state=e instanceof Refused?'blocked':'unavailable';esh.detail=e instanceof Refused?e.message:'ESH read failed; availability unknown';}}
  return {observedAt:new Date().toISOString(),esh,chat:this.options.chat?.status()??{state:'disconnected',detail:'Shared chat host not connected; owner admission is required'},sdk:{state:this.options.sdk?'attached':'disconnected',detail:this.options.sdk?'Authenticated host attached; owner authorization still applies':'Authenticated SDK host not connected'},capabilities:this.capabilities()};
 }
 /** For an ElevenLabs binary generator, has the router save the audio under Prime's first media root (keyed by the request
  * id, so the reviewed request shows the exact path and the digest covers it) with a wait just under Prime's own, and
  * refuses at review a track Prime could only receive inline when it would exceed the bridge's 1 MiB bound. */
 private elevenLabsFile(name:string,args:Json,requestId:string){
  if(!ELEVENLABS_SAVES.test(name))return;
  const config=this.mediaConfig(),dir=mediaSaveDir(config),kind=this.describeCapability(name).kind;
  if(dir){
   const format=typeof args.output_format==='string'?args.output_format:'';
   args._save_to=join(dir,requestId+'.'+(/^wav/i.test(format)?'wav':'mp3'));
   args._timeout=Math.max(30,Math.round(config.invokeTimeoutsMs[kind]/1000)-20);
   return;
  }
  if(!/music_generation\./.test(name))return;
  const ms=Number(args.music_length_ms);
  if(!Number.isFinite(ms)||ms>INLINE_MUSIC_MAX_MS)throw new Refused('This Prime has no media.localRoots directory for ElevenLabs to save the track into, so the audio would come back inline, and a track '+(Number.isFinite(ms)?'of '+Math.round(ms/1000)+' s':'whose length the model picks')+' can exceed the 1 MiB SDK bridge bound (only '+INLINE_MUSIC_MAX_MS/1000+' s fit). Set a length of '+INLINE_MUSIC_MAX_MS/1000+' s or less, or add media.localRoots to the Prime config.');
 }
 /** The server-side gate for adult briefs, whichever way the request was made (Auto pick, a manual pick, edited JSON): an adult
  * brief or an explicit adult flag is refused before any call unless it is bound for the on-prem media router, attested as
  * fictional adults, and pinned to TEMPER. The keyword classifier decides only for pictures and video; an explicit flag decides
  * for every tool. Refusals name what to change and say nothing was sent. */
 private adultGate(request:PrimeRequest){
  const args=request.arguments,{flagged,fictional}=adultFlagsOf(args),kind=this.describeCapability(request.name).kind;
  if(!flagged&&kind==='other')return;
  const policy=adultPolicy({text:promptOfArguments(args),flagged,fictional,kind,capability:request.name,markers:this.options.adultMarkers});
  if(policy.refusal)throw new Refused(policy.refusal.message);
  if(!policy.adult||!isRouterCap(request.name))return;
  if(args.inputs!==undefined&&!(Array.isArray(args.inputs)&&args.inputs.length===0))throw new Refused('Adult mode does not take reference uploads, because an uploaded picture can show a real person. Remove them and send again; nothing was sent.');
  const node=typeof args.node==='string'?args.node.trim().toLowerCase():'';
  if(args.node!==undefined&&node!==ADULT_NODE&&node!=='')throw new Refused('Adult requests run on TEMPER only (node must be '+ADULT_NODE+'); nothing was sent.');
  args.node=ADULT_NODE;
 }
 async prepare(input:PrimeRequest){return this.prepareTicket(input,false);}
 private async prepareTicket(input:PrimeRequest,autonomyReview:boolean){
  limited(input);const request=JSON.parse(JSON.stringify(input)) as PrimeRequest,requestId=randomUUID();
  if(!['sdk','esh'].includes(request.target)||typeof request.name!=='string'||!request.arguments||Array.isArray(request.arguments)||typeof request.arguments!=='object')throw new Refused('Invalid integration request');
  // _save_to/_timeout steer where the ElevenLabs router writes a file on FORGE and how long it waits: Prime sets them itself.
  if(/"(?:force_video|grant|api_key|access_token|authorization|confirm|bypass_reason|_save_to|_timeout)"\s*:/i.test(JSON.stringify(request.arguments)))throw new Refused('Owner controls and credentials cannot be overridden by this client');
  let scope:string|undefined;
  if(request.target==='sdk'){
   if(!this.options.sdk)throw new Refused('SDK host not connected');
   if(!/^echo\.[A-Za-z0-9_.-]{1,180}$/.test(request.name))throw new Refused('Invalid capability ID');
   this.adultGate(request);
   if(request.arguments.inputs!==undefined){
    let inputs;
    try{inputs=validateStudioInputs(request.arguments.inputs);}
    catch(e){throw new Refused(e instanceof Error?e.message:'Invalid Studio reference inputs');}
    if(this.options.uploads){
     const owner=this.options.uploadsOwner??'local';
     for(const item of inputs){
      try{await this.options.uploads.get(owner,item.upload_id);}
      catch{throw new Refused('Reference upload not found: '+item.upload_id);}
     }
    }
    request.arguments.inputs=inputs;
   }
   const record=object(unwrap(await bounded(()=>this.options.sdk!.read(request.name)))),c=object(record.capability);
   if(c.id!==request.name)throw new Refused('SDK capability identity mismatch');
   if(record.registration_state!=='registered'||['red','orphaned','unregistered'].includes(String(record.health_status)))throw new Refused('Capability unavailable or unregistered');
   scope=typeof c.required_scope==='string'?c.required_scope:this.catalog.get(request.name)?.scope;
   this.elevenLabsFile(request.name,request.arguments,requestId);
  }else{
   if(!this.options.esh)throw new Refused('ESH host not connected');
   const status=await this.status();
   if(status.esh.state!=='connected')throw new Refused(status.esh.detail);
   if(!this.tools.some(t=>t.name===request.name))throw new Refused('ESH tool not advertised');
   if(request.name==='esh_ledger')request.arguments.limit=Math.min(30,Math.max(1,Number(request.arguments.limit)||5));
   if(!eshReads.has(request.name)){
    if(!autonomyReview)request.arguments.session='echo-prime';
    // Autonomy's tier policy already ran; any returned ticket still requires the
    // existing same-origin owner execute route. Browser requests cannot set this flag.
    if(this.options.approveEsh?!await this.options.approveEsh(request,digest(request)):!autonomyReview)throw new Refused('ESH action requires the existing host approval boundary');
   }
  }
  for(const [id,t] of this.tickets)if(t.expiresAt<Date.now())this.tickets.delete(id);
  if(this.tickets.size>=100)throw new Refused('Too many pending requests');
  const ticket:Ticket={id:randomUUID(),requestId,digest:digest(request),request,expiresAt:Date.now()+300000,submitted:false,scope,cost:request.target==='sdk'?'Provider charges or quota may apply. No automatic fallback.':'Governed by ESH owner policy.'};
  this.tickets.set(ticket.id,ticket);return {...ticket,request:JSON.parse(JSON.stringify(request)) as PrimeRequest};
 }
 async execute(id:string,hash:string){
  const ticket=this.tickets.get(id);
  if(!ticket||ticket.expiresAt<Date.now()||ticket.digest!==hash)throw new Refused('Review the current exact request before execution');
  if(ticket.submitted)throw new Refused('Request already submitted; inspect the original receipt before any retry');
  ticket.submitted=true;
  // SDK requests run as server-side jobs: long generations keep going after this response, async provider jobs are
  // followed, and a finished media file is stored and registered (media-jobs.ts). ESH keeps its bounded receipt path.
  if(ticket.request.target==='sdk')return this.mediaJobs().execute(ticket.requestId,ticket.request.name,ticket.request.arguments) as Promise<{state:string;requestId:string;detail?:string;result?:unknown;untrusted?:boolean}>;
  try{
   const r=ticket.request;
   const raw=await bounded(()=>this.options.esh!.call(r.name,{...r.arguments,...(!eshReads.has(r.name)?{idempotency_key:ticket.requestId}:{})}));
   const result=envelope(raw);limited(result,1048576);const body=object(result);
   if(body.ok===false||body.isError===true||['denied','gated','blocked'].includes(String(body.verdict)))return {state:'blocked',requestId:ticket.requestId,result,untrusted:true,detail:String(body.reason??'ESH owner refused the request')};
   return {state:body.job_id&&!['completed','succeeded','done'].includes(String(body.status))?'submitted':'returned',requestId:ticket.requestId,result:JSON.parse(redact(JSON.stringify(result))),untrusted:true};
  }catch(e){return {state:e instanceof Refused?'blocked':'uncertain',requestId:ticket.requestId,detail:e instanceof Refused?e.message:'Connection interrupted or timed out; outcome unknown. Inspect the owner using this request ID before retrying.'};}
 }
}
