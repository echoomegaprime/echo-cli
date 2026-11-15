import {debuglog} from 'node:util';
import {validateEndpoint} from '../code/model.js';
import {redact} from '../code/workspace.js';
import {sanitize} from './swarm.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * Client for the loopback `echo-adk-api` service (Echo ADK agent definitions and governed runs), consumed exactly the way
 * swarm.ts consumes the Maximalist worker: plain fetch with `redirect:'error'`, one reviewed loopback origin, fixed routes,
 * 5 s health / 15 s mutate / 10 s poll timeouts, a 1 MiB response cap, every string redacted before it reaches the browser.
 * Prime never forwards tokens or leases; the service holds its own broker token. Nothing here falls back to another provider.
 * Contract: docs/echo-code/ECHO_ADK_API_CONTRACT.md (v1, frozen 2026-11-04).
 */
export const ADK_PROFILE='ECHO_ADK';
export const ADK_SERVICE='echo-adk-api';
export const ADK_MAX={max_calls:120,max_cost_usd:5,max_wall_s:4800} as const;
export const ADK_MAX_PROMPT=12000;
export const ADK_MAX_RUNS=50;
export interface AdkBudget {max_calls:number;max_cost_usd:number;max_wall_s:number}
export interface AdkConfig {baseUrl:string;defaultBudget:AdkBudget}
/** Default cost is 0: the default lane is `qwen-local` and nothing paid is reached unless the owner raises the budget. */
export const DEFAULT_ADK:AdkConfig={baseUrl:'http://127.0.0.1:8378',defaultBudget:{max_calls:40,max_cost_usd:0,max_wall_s:900}};
const MIN:AdkBudget={max_calls:1,max_cost_usd:0,max_wall_s:30};
const KEYS=Object.keys(ADK_MAX) as (keyof AdkBudget)[];
const HEX_ID=/^[0-9a-f]{32}$/;
const AGENT_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Names Prime itself creates (contract `POST /agents`, 2026-11-04 20:12): lowercase slug, 2 to 63 characters. Reads keep the looser charset above. */
export const ADK_CREATE_NAME=/^[a-z0-9][a-z0-9-]{1,62}$/;
export const ADK_CAPABILITY_ID=/^echo\.[a-z0-9_.]+$/;
const ADK_SKILL=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ADK_LANE_WORD=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SHA256=/^[0-9a-f]{64}$/;
export const ADK_DEFINITION_LIMITS={capabilities:64,skills:32,instruction:12000,maxSteps:24} as const;
/** Highest `max_steps` any Prime-created definition may carry (the service's own cap is 64). Callers opt in per call, e.g. video agents at shots×3+6. */
export const ADK_MAX_STEPS_CEILING=60;
/** Per-call limits for parseAgentDefinition / createAgent / updateAgent. `maxSteps` defaults to ADK_DEFINITION_LIMITS.maxSteps and never exceeds ADK_MAX_STEPS_CEILING. */
export interface AdkDefinitionOptions {maxSteps?:number}
const RUN_STATUSES=new Set(['queued','running','gated','done','failed']);
const ERROR_CODES=new Set(['not_found','invalid','gated','budget_exceeded','unavailable']);
const debug=debuglog('echo-prime');
/** Carries an HTTP status for the Prime server plus the contract error code (and gated/unavailable detail) for callers and tests. `detail.http` keeps the service's own status (a 409 on create means the name exists). */
export class AdkError extends WorkspaceHttpError {
 constructor(status:number,message:string,public code?:string,public detail:{needs?:string[];how?:string;provider?:string;http?:number}={}){super(status,message);}
}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max:number)=>typeof v==='string'?redact(v).slice(0,max):undefined;
/** Clamps a requested budget into the service caps. Missing keys take the default; a present non-number is refused, never guessed. */
export function clampAdkBudget(input:unknown,defaults:AdkBudget=DEFAULT_ADK.defaultBudget):AdkBudget{
 if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))throw new AdkError(400,'Invalid agent budget');
 const given=(input??{}) as Record<string,unknown>;
 for(const key of Object.keys(given))if(!(KEYS as string[]).includes(key))throw new AdkError(400,'Invalid agent budget: unknown field');
 const out={} as AdkBudget;
 for(const key of KEYS){
  const value=given[key]===undefined?defaults[key]:given[key];
  if(typeof value!=='number'||!Number.isFinite(value))throw new AdkError(400,'Invalid agent budget: '+key+' must be a number');
  const clamped=Math.min(ADK_MAX[key],Math.max(MIN[key],value));
  out[key]=key==='max_cost_usd'?Math.round(clamped*100)/100:Math.floor(clamped);
 }
 return out;
}
/** Strict, like parseSwarmConfig: unknown fields and any non-loopback origin are refused. An absent `adk` section means the feature is off. */
export function parseAdkConfig(value:unknown):AdkConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid adk configuration: adk must be an object');
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(!['baseUrl','defaultBudget'].includes(key))throw new Error('Invalid adk configuration: unknown field');
 let baseUrl=DEFAULT_ADK.baseUrl;
 if(input.baseUrl!==undefined){if(typeof input.baseUrl!=='string')throw new Error('Invalid adk configuration: baseUrl');baseUrl=input.baseUrl;}
 try{validateEndpoint(baseUrl);}catch{throw new Error('Invalid adk configuration: baseUrl must be a credential-free loopback origin');}
 let defaultBudget:AdkBudget;
 try{defaultBudget=clampAdkBudget(input.defaultBudget,DEFAULT_ADK.defaultBudget);}catch{throw new Error('Invalid adk configuration: defaultBudget');}
 return {baseUrl:new URL(baseUrl).origin,defaultBudget};
}
/** Refuses anything that is not a 32-lowercase-hex id before it can reach a URL. */
export function requireHexId(value:unknown,what='run id'):string{
 if(typeof value!=='string'||!HEX_ID.test(value))throw new AdkError(400,'Invalid agent '+what);
 return value;
}
function requireAgentName(value:unknown):string{
 if(typeof value!=='string'||!AGENT_NAME.test(value))throw new AdkError(400,'Invalid agent name');
 return value;
}
export interface AdkLane {node:string;model:string;budget:AdkBudget}
export interface AdkOrigin {by:'echo'|'owner';prompt_sha256?:string;created_at:string}
/** The contract `EchoAgent` without `source` (the service assigns it): exactly what `POST /agents` and `PUT /agents/{name}` accept. */
export interface AdkAgentDefinition {name:string;role:string;skills:string[];capabilities:string[];lane:AdkLane;max_steps:number;instruction?:string;origin:AdkOrigin}
/** Default lane for anything Prime drafts: the free local lane on FORGE, cost 0. */
export const ADK_DEFAULT_LANE={node:'forge',model:'qwen-local'} as const;
function stringList(value:unknown,what:string,max:number,pattern:RegExp):string[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!pattern.test(v)))throw new AdkError(400,'Invalid agent definition: '+what);
 return [...new Set(value as string[])];
}
/** Validates a definition Prime is about to create or replace. Unknown keys, bad names, non-`echo.` capability ids and bad origins are refused;
 *  the lane budget is clamped to the service caps and `max_steps` to 1..24. Nothing is guessed on the owner's behalf except the lane defaults. */
export function parseAgentDefinition(input:unknown,defaults:AdkBudget=DEFAULT_ADK.defaultBudget,options:AdkDefinitionOptions={}):AdkAgentDefinition{
 const data=obj(input);
 const stepCeiling=Math.min(ADK_MAX_STEPS_CEILING,Math.max(1,Math.floor(typeof options.maxSteps==='number'&&Number.isFinite(options.maxSteps)?options.maxSteps:ADK_DEFINITION_LIMITS.maxSteps)));
 if(!input||typeof input!=='object'||Array.isArray(input))throw new AdkError(400,'Invalid agent definition');
 for(const key of Object.keys(data))if(!['name','role','skills','capabilities','lane','max_steps','instruction','origin'].includes(key))throw new AdkError(400,'Invalid agent definition: unknown field '+redact(key).slice(0,40));
 if(typeof data.name!=='string'||!ADK_CREATE_NAME.test(data.name))throw new AdkError(400,'Invalid agent name: use 2 to 63 lowercase letters, digits or hyphens');
 if(typeof data.role!=='string'||!data.role.trim()||data.role.length>80)throw new AdkError(400,'Invalid agent definition: role');
 const capabilities=stringList(data.capabilities,'capabilities must be exact echo.* ids',ADK_DEFINITION_LIMITS.capabilities,ADK_CAPABILITY_ID);
 if(!capabilities.length)throw new AdkError(400,'Invalid agent definition: at least one capability id is required');
 const skills=stringList(data.skills,'skills',ADK_DEFINITION_LIMITS.skills,ADK_SKILL);
 const lane=obj(data.lane);
 if(data.lane!==undefined&&(!data.lane||typeof data.lane!=='object'||Array.isArray(data.lane)))throw new AdkError(400,'Invalid agent definition: lane');
 for(const key of Object.keys(lane))if(!['node','model','budget'].includes(key))throw new AdkError(400,'Invalid agent definition: lane has an unknown field');
 const node=lane.node===undefined?ADK_DEFAULT_LANE.node:lane.node,model=lane.model===undefined?ADK_DEFAULT_LANE.model:lane.model;
 if(typeof node!=='string'||!ADK_LANE_WORD.test(node)||typeof model!=='string'||!ADK_LANE_WORD.test(model))throw new AdkError(400,'Invalid agent definition: lane node or model');
 let budget:AdkBudget;
 try{budget=clampAdkBudget(lane.budget,defaults);}catch{throw new AdkError(400,'Invalid agent definition: lane budget');}
 let maxSteps=ADK_DEFINITION_LIMITS.maxSteps/2;
 if(data.max_steps!==undefined){
  if(typeof data.max_steps!=='number'||!Number.isFinite(data.max_steps))throw new AdkError(400,'Invalid agent definition: max_steps must be a number');
  maxSteps=Math.min(stepCeiling,Math.max(1,Math.floor(data.max_steps)));
 }
 const out:AdkAgentDefinition={name:data.name,role:data.role.trim(),skills,capabilities,lane:{node,model,budget},max_steps:maxSteps,origin:{by:'owner',created_at:new Date().toISOString()}};
 if(data.instruction!==undefined){
  if(typeof data.instruction!=='string')throw new AdkError(400,'Invalid agent definition: instruction');
  if(data.instruction.length>ADK_DEFINITION_LIMITS.instruction)throw new AdkError(400,'Instruction exceeds '+ADK_DEFINITION_LIMITS.instruction+' characters');
  if(data.instruction.trim())out.instruction=data.instruction;
 }
 if(data.origin!==undefined){
  const origin=obj(data.origin);
  if(!data.origin||typeof data.origin!=='object'||Array.isArray(data.origin))throw new AdkError(400,'Invalid agent definition: origin');
  for(const key of Object.keys(origin))if(!['by','prompt_sha256','created_at'].includes(key))throw new AdkError(400,'Invalid agent definition: origin has an unknown field');
  if(origin.by!=='echo'&&origin.by!=='owner')throw new AdkError(400,'Invalid agent definition: origin.by must be echo or owner');
  out.origin.by=origin.by;
  if(origin.prompt_sha256!==undefined){if(typeof origin.prompt_sha256!=='string'||!SHA256.test(origin.prompt_sha256))throw new AdkError(400,'Invalid agent definition: origin.prompt_sha256');out.origin.prompt_sha256=origin.prompt_sha256;}
  if(origin.created_at!==undefined){if(typeof origin.created_at!=='string'||Number.isNaN(Date.parse(origin.created_at)))throw new AdkError(400,'Invalid agent definition: origin.created_at');out.origin.created_at=origin.created_at;}
 }
 return out;
}
/** The body actually sent to `POST /agents` / `PUT /agents/{name}`: the service stamps `created_at` itself and refuses an origin carrying
 *  anything but `by` and `prompt_sha256` (verified against echo-adk 0.1.0 on 2026-11-05: `400 origin accepts by and prompt_sha256 only`). */
export function agentWireBody(definition:AdkAgentDefinition){
 const {created_at:_stamped,...origin}=definition.origin;void _stamped;
 return {...definition,origin};
}
export interface AdkRunSummary {runId:string;agent:string;status:string;startedAt?:string}
export interface AdkRunStatus {
 runId:string;agent?:string;status:string;done:boolean;startedAt?:string;finishedAt?:string;steps:unknown[];proof?:unknown;
 error?:{code?:string;message?:string;provider?:string};budget?:unknown;spent?:unknown;
}
export class AdkClient {
 readonly config:AdkConfig;private origin:URL;
 constructor(config:AdkConfig=DEFAULT_ADK,private timeouts={health:5000,mutate:15000,read:10000}){
  this.origin=validateEndpoint(config.baseUrl);
  this.config={baseUrl:this.origin.origin,defaultBudget:clampAdkBudget(config.defaultBudget,DEFAULT_ADK.defaultBudget)};
 }
 private async request(method:'GET'|'POST'|'PUT'|'DELETE',route:string,ms:number,body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const url=new URL(route,this.origin);
  if(url.origin!==this.origin.origin)throw new AdkError(400,'Echo ADK route refused');
  let response:Response;
  try{
   response=await fetch(url,{method,redirect:'error',headers:body===undefined?{accept:'application/json'}:{accept:'application/json','content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(ms),...(signal?[signal]:[])])});
  }catch(error){
   if(signal?.aborted)throw new AdkError(499,'Interrupted');
   if(error instanceof Error&&error.name==='TimeoutError')throw new AdkError(504,'Echo ADK timed out after '+Math.round(ms/1000)+' s; outcome unknown');
   throw new AdkError(502,'Echo ADK unreachable at '+this.origin.origin);
  }
  const reader=response.body?.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try{
   if(reader)for(;;){
    const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>1048576)throw new AdkError(502,'Echo ADK response exceeds the 1 MiB limit');
    chunks.push(value);
   }
  }catch(error){if(error instanceof AdkError)throw error;throw new AdkError(504,'Echo ADK response was interrupted');}
  finally{await reader?.cancel().catch(()=>undefined);}
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{parsed=undefined;}
  if(!response.ok)throw this.failure(response.status,obj(parsed));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new AdkError(502,'Echo ADK returned an unrecognized response');
  return parsed as Record<string,unknown>;
 }
 /** Contract errors are `{error:"<code>", message}`; gated adds `needs`/`how`, unavailable adds `provider`. Everything is redacted and folded into the message. */
 private failure(status:number,body:Record<string,unknown>):AdkError{
  const code=typeof body.error==='string'&&ERROR_CODES.has(body.error)?body.error:undefined;
  const message=text(body.message,300)??(code===undefined?text(body.error,200)??text(body.detail,200):undefined);
  const needs=Array.isArray(body.needs)?body.needs.filter((n):n is string=>typeof n==='string').slice(0,20).map(n=>redact(n).slice(0,120)):undefined;
  const how=text(body.how,300),provider=text(body.provider,80);
  let detail='Echo ADK answered HTTP '+status+(code?' ('+code+')':'')+(message?': '+message:'');
  if(code==='gated')detail+=(needs?.length?'. Needs: '+needs.join(', '):'')+(how?'. How: '+how:'');
  if(code==='unavailable')detail+='. Provider '+(provider??'(not named)')+' is unavailable; no fallback was used';
  const mapped=status===404||code==='not_found'?404:status<500&&code!=='unavailable'?400:502;
  debug('%j',{event:'prime_adk_refused',status,code:code??null});
  return new AdkError(mapped,detail,code,{...(needs?{needs}:{}),...(how?{how}:{}),...(provider?{provider}:{}),http:status});
 }
 async health(signal?:AbortSignal){
  const h=await this.request('GET','/health',this.timeouts.health,undefined,signal);
  if(h.ok!==true)throw new AdkError(502,'Echo ADK reports it is not healthy');
  if(h.profile!==ADK_PROFILE)throw new AdkError(502,'Echo ADK reports an unexpected profile; refusing to use it');
  debug('%j',{event:'prime_adk_health',version:typeof h.version==='string'?h.version.slice(0,40):null});
  return sanitize({service:h.service,profile:h.profile,version:h.version,agents:h.agents,bots:h.bots,runsActive:h.runs_active}) as Record<string,unknown>;
 }
 /** Agent definitions (name, role, skills, capabilities, lane, max_steps, source). Rows without a valid name are refused. */
 async agents(signal?:AbortSignal){
  const reply=await this.request('GET','/agents',this.timeouts.read,undefined,signal);
  if(!Array.isArray(reply.agents))throw new AdkError(502,'Echo ADK returned an invalid agent list');
  if(reply.agents.length>200)throw new AdkError(502,'Echo ADK returned too many agents');
  for(const row of reply.agents)if(!AGENT_NAME.test(String(obj(row).name)))throw new AdkError(502,'Echo ADK returned an invalid agent name');
  return {agents:(sanitize(reply.agents) as unknown[])};
 }
 async agent(name:unknown,signal?:AbortSignal){
  const agent=requireAgentName(name);
  const reply=await this.request('GET','/agents/'+encodeURIComponent(agent),this.timeouts.read,undefined,signal);
  if(reply.name!==agent)throw new AdkError(502,'Echo ADK answered for a different agent');
  return sanitize(reply) as Record<string,unknown>;
 }
 /** `POST /agents` (contract 2026-11-04 20:12): the validated definition only; the service assigns `source` and stamps `origin.created_at`.
  *  A 409 means the name exists (`detail.http`). `options.maxSteps` raises the step ceiling for this call only (never above ADK_MAX_STEPS_CEILING). */
 async createAgent(input:unknown,signal?:AbortSignal,options:AdkDefinitionOptions={}){
  const definition=parseAgentDefinition(input,this.config.defaultBudget,options);
  debug('%j',{event:'prime_adk_agent_creating',name:definition.name,role:definition.role,capabilities:definition.capabilities.length,by:definition.origin.by,maxSteps:definition.max_steps});
  const reply=await this.request('POST','/agents',this.timeouts.mutate,agentWireBody(definition),signal);
  if(reply.name!==definition.name)throw new AdkError(502,'Echo ADK answered for a different agent');
  debug('%j',{event:'prime_adk_agent_created',name:definition.name});
  return sanitize(reply) as Record<string,unknown>;
 }
 /** `PUT /agents/{name}`: replaces the definition. The body name must be the path name; the service answers the full definition. */
 async updateAgent(name:unknown,input:unknown,signal?:AbortSignal,options:AdkDefinitionOptions={}){
  const agent=requireAgentName(name),definition=parseAgentDefinition(input,this.config.defaultBudget,options);
  if(definition.name!==agent)throw new AdkError(400,'Invalid agent definition: the name must match the agent being replaced');
  const reply=await this.request('PUT','/agents/'+encodeURIComponent(agent),this.timeouts.mutate,agentWireBody(definition),signal);
  if(reply.name!==agent)throw new AdkError(502,'Echo ADK answered for a different agent');
  debug('%j',{event:'prime_adk_agent_updated',name:agent});
  return sanitize(reply) as Record<string,unknown>;
 }
 /** `DELETE /agents/{name}`: refused by the service with 409 while a bot references the agent; Prime passes that refusal through unchanged. */
 async deleteAgent(name:unknown,signal?:AbortSignal){
  const agent=requireAgentName(name);
  const reply=await this.request('DELETE','/agents/'+encodeURIComponent(agent),this.timeouts.mutate,undefined,signal);
  if(reply.name!==agent||reply.deleted!==true)throw new AdkError(502,'Echo ADK did not confirm the deletion');
  debug('%j',{event:'prime_adk_agent_deleted',name:agent});
  return {name:agent,deleted:true};
 }
 /** Starts a run. Only `agent`, `prompt` and `budget` are accepted from the browser: Prime never crafts leases or forwards tokens. */
 async run(input:unknown,signal?:AbortSignal){
  const data=obj(input);
  if(Object.keys(data).some(k=>!['agent','prompt','budget'].includes(k)))throw new AdkError(400,'Invalid agent run request');
  const agent=requireAgentName(data.agent);
  if(typeof data.prompt!=='string'||!data.prompt.trim())throw new AdkError(400,'Invalid agent run request: prompt required');
  if(data.prompt.length>ADK_MAX_PROMPT)throw new AdkError(400,'Prompt exceeds '+ADK_MAX_PROMPT+' characters');
  const budget=clampAdkBudget(data.budget,this.config.defaultBudget);
  debug('%j',{event:'prime_adk_run_submitting',agent,promptChars:data.prompt.length,budget});
  const reply=await this.request('POST','/runs',this.timeouts.mutate,{agent,prompt:data.prompt,budget},signal);
  const runId=typeof reply.run_id==='string'&&HEX_ID.test(reply.run_id)?reply.run_id:undefined;
  if(!runId)throw new AdkError(502,'Echo ADK returned an invalid run id');
  const status=text(reply.status,40)??'queued';
  debug('%j',{event:'prime_adk_run_accepted',runId,agent,status,budget});
  return {runId,agent,status,budget};
 }
 async status(runId:unknown,signal?:AbortSignal):Promise<AdkRunStatus>{
  const id=requireHexId(runId);
  const reply=await this.request('GET','/runs/'+id,this.timeouts.read,undefined,signal);
  if(reply.run_id!==undefined&&reply.run_id!==id)throw new AdkError(502,'Echo ADK answered for a different run');
  const clean=sanitize(reply) as Record<string,unknown>;
  const status=typeof clean.status==='string'&&RUN_STATUSES.has(clean.status)?clean.status:'unknown';
  const out:AdkRunStatus={runId:id,status,done:status==='done'||status==='failed',steps:Array.isArray(clean.steps)?clean.steps:[]};
  if(typeof clean.agent==='string')out.agent=clean.agent.slice(0,64);
  if(typeof clean.started_at==='string')out.startedAt=clean.started_at.slice(0,40);
  if(typeof clean.finished_at==='string')out.finishedAt=clean.finished_at.slice(0,40);
  if(clean.proof&&typeof clean.proof==='object')out.proof=clean.proof;
  if(clean.budget&&typeof clean.budget==='object')out.budget=clean.budget;
  if(clean.spent&&typeof clean.spent==='object')out.spent=clean.spent;
  if(clean.error!==undefined&&clean.error!==null){
   const e=obj(clean.error);
   out.error=typeof clean.error==='string'?{message:clean.error.slice(0,600)}:{...(typeof e.code==='string'?{code:e.code.slice(0,40)}:{}),...(typeof e.message==='string'?{message:e.message.slice(0,600)}:{}),...(typeof e.provider==='string'?{provider:e.provider.slice(0,80)}:{})};
  }
  debug('%j',{event:'prime_adk_run_status',runId:id,status,done:out.done,steps:out.steps.length,failed:!!out.error});
  return out;
 }
 /** Asks the service to stop after the current step. A provider call already in flight is not interrupted; the UI says so. */
 async stop(runId:unknown,signal?:AbortSignal){
  const id=requireHexId(runId);
  const reply=await this.request('POST','/runs/'+id+'/stop',this.timeouts.mutate,{},signal);
  if(reply.run_id!==undefined&&reply.run_id!==id)throw new AdkError(502,'Echo ADK answered for a different run');
  const status=text(reply.status,40)??'unknown';
  debug('%j',{event:'prime_adk_stop',runId:id,status});
  return {runId:id,status};
 }
 async runs(input:unknown={},signal?:AbortSignal){
  const data=obj(input);
  if(Object.keys(data).some(k=>!['agent','limit'].includes(k)))throw new AdkError(400,'Invalid agent run query');
  const params=new URLSearchParams();
  if(data.agent!==undefined&&data.agent!=='')params.set('agent',requireAgentName(data.agent));
  let limit=20;
  if(data.limit!==undefined&&data.limit!==''){
   const n=typeof data.limit==='number'?data.limit:typeof data.limit==='string'&&/^\d{1,3}$/.test(data.limit)?Number(data.limit):NaN;
   if(!Number.isInteger(n))throw new AdkError(400,'Invalid agent run query: limit must be an integer');
   limit=Math.min(ADK_MAX_RUNS,Math.max(1,n));
  }
  params.set('limit',String(limit));
  const reply=await this.request('GET','/runs?'+params.toString(),this.timeouts.read,undefined,signal);
  if(!Array.isArray(reply.runs)||reply.runs.length>ADK_MAX_RUNS)throw new AdkError(502,'Echo ADK returned an invalid run list');
  const runs:AdkRunSummary[]=[];
  for(const raw of reply.runs){
   const row=obj(raw);
   if(typeof row.run_id!=='string'||!HEX_ID.test(row.run_id))throw new AdkError(502,'Echo ADK returned an invalid run id');
   const status=typeof row.status==='string'&&RUN_STATUSES.has(row.status)?row.status:'unknown';
   runs.push({runId:row.run_id,agent:text(row.agent,64)??'',status,...(typeof row.started_at==='string'?{startedAt:row.started_at.slice(0,40)}:{})});
  }
  return {runs};
 }
}
