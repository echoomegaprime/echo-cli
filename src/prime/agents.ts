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
const RUN_STATUSES=new Set(['queued','running','gated','done','failed']);
const ERROR_CODES=new Set(['not_found','invalid','gated','budget_exceeded','unavailable']);
const debug=debuglog('echo-prime');
/** Carries an HTTP status for the Prime server plus the contract error code (and gated/unavailable detail) for callers and tests. */
export class AdkError extends WorkspaceHttpError {
 constructor(status:number,message:string,public code?:string,public detail:{needs?:string[];how?:string;provider?:string}={}){super(status,message);}
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
 private async request(method:'GET'|'POST',route:string,ms:number,body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
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
  return new AdkError(mapped,detail,code,{...(needs?{needs}:{}),...(how?{how}:{}),...(provider?{provider}:{})});
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
