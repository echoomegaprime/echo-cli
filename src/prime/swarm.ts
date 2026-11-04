import {randomUUID} from 'node:crypto';
import {debuglog} from 'node:util';
import {validateEndpoint} from '../code/model.js';
import {redact} from '../code/workspace.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * Client for the 40-seat "Maximalist Swarm Fusion Brain" worker (a reconstruction; its results always say
 * profile MAXIMALIST_RECONSTRUCTED, historical_parity false). The worker is a loopback FastAPI service with no auth, so this
 * client may only ever reach three fixed routes of one reviewed loopback origin: GET /health, POST /run, GET /runs/<hex id>.
 * Subprocess-free: plain fetch with timeouts, a response size cap and redirect:'error'. Nothing here chooses a fallback model.
 */
export const SWARM_PROFILE='MAXIMALIST_RECONSTRUCTED';
export const SWARM_MAX={max_calls:120,max_cost_usd:5,max_wall_s:4800} as const;
export const SWARM_MAX_OBJECTIVE=12000;
export interface SwarmBudget {max_calls:number;max_cost_usd:number;max_wall_s:number}
export interface SwarmConfig {baseUrl:string;defaultBudget:SwarmBudget}
export const DEFAULT_SWARM:SwarmConfig={baseUrl:'http://127.0.0.1:8358',defaultBudget:{max_calls:80,max_cost_usd:1,max_wall_s:1800}};
const MIN:SwarmBudget={max_calls:1,max_cost_usd:0.01,max_wall_s:30};
const KEYS=Object.keys(SWARM_MAX) as (keyof SwarmBudget)[];
const RUN_ID=/^[0-9a-f]{32}$/;
const debug=debuglog('echo-prime');
/** Authenticated-session errors carry an HTTP status so the Prime server can answer 4xx/5xx instead of a blanket 400. */
export class SwarmError extends WorkspaceHttpError {}
/** Clamps a requested budget into the worker's limits. Missing keys take the default; a present non-number is refused, never guessed. */
export function clampBudget(input:unknown,defaults:SwarmBudget=DEFAULT_SWARM.defaultBudget):SwarmBudget{
 if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))throw new SwarmError(400,'Invalid swarm budget');
 const given=(input??{}) as Record<string,unknown>;
 for(const key of Object.keys(given))if(!(KEYS as string[]).includes(key))throw new SwarmError(400,'Invalid swarm budget: unknown field');
 const out={} as SwarmBudget;
 for(const key of KEYS){
  const value=given[key]===undefined?defaults[key]:given[key];
  if(typeof value!=='number'||!Number.isFinite(value))throw new SwarmError(400,'Invalid swarm budget: '+key+' must be a number');
  const clamped=Math.min(SWARM_MAX[key],Math.max(MIN[key],value));
  out[key]=key==='max_cost_usd'?Math.round(clamped*100)/100:Math.floor(clamped);
 }
 return out;
}
/** Strict, like parseModelsConfig: unknown fields and any non-loopback origin are refused. */
export function parseSwarmConfig(value:unknown):SwarmConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid swarm configuration: swarm must be an object');
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(!['baseUrl','defaultBudget'].includes(key))throw new Error('Invalid swarm configuration: unknown field');
 let baseUrl=DEFAULT_SWARM.baseUrl;
 if(input.baseUrl!==undefined){if(typeof input.baseUrl!=='string')throw new Error('Invalid swarm configuration: baseUrl');baseUrl=input.baseUrl;}
 try{validateEndpoint(baseUrl);}catch{throw new Error('Invalid swarm configuration: baseUrl must be a credential-free loopback origin');}
 let defaultBudget:SwarmBudget;
 try{defaultBudget=clampBudget(input.defaultBudget,DEFAULT_SWARM.defaultBudget);}catch{throw new Error('Invalid swarm configuration: defaultBudget');}
 return {baseUrl:new URL(baseUrl).origin,defaultBudget};
}
/** Recursively redacts every string and bounds depth, breadth and string length before anything reaches the browser. */
export function sanitize(value:unknown,depth=0):unknown{
 if(typeof value==='string')return redact(value.length>50000?value.slice(0,50000)+'…':value);
 if(value===null||typeof value==='number'||typeof value==='boolean')return value;
 if(depth>=12)return null;
 if(Array.isArray(value))return value.slice(0,500).map(v=>sanitize(v,depth+1));
 if(typeof value==='object'){
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(value as Record<string,unknown>).slice(0,200))if(k!=='__proto__')out[redact(k.slice(0,200))]=sanitize(v,depth+1);
  return out;
 }
 return undefined;
}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export interface SwarmRunStatus {runId:string;phase:string;done:boolean;result?:unknown;error?:string}
export class SwarmClient {
 readonly config:SwarmConfig;private origin:URL;
 constructor(config:SwarmConfig=DEFAULT_SWARM,private timeouts={health:5000,run:15000,status:10000}){
  this.origin=validateEndpoint(config.baseUrl);
  this.config={baseUrl:this.origin.origin,defaultBudget:clampBudget(config.defaultBudget,DEFAULT_SWARM.defaultBudget)};
 }
 private async request(route:string,ms:number,body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const url=new URL(route,this.origin);
  if(url.origin!==this.origin.origin)throw new SwarmError(400,'Swarm route refused');
  let response:Response;
  try{
   response=await fetch(url,{method:body===undefined?'GET':'POST',redirect:'error',headers:body===undefined?{accept:'application/json'}:{accept:'application/json','content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(ms),...(signal?[signal]:[])])});
  }catch(error){
   if(signal?.aborted)throw new SwarmError(499,'Interrupted');
   if(error instanceof Error&&error.name==='TimeoutError')throw new SwarmError(504,'Swarm worker timed out after '+Math.round(ms/1000)+' s; outcome unknown');
   throw new SwarmError(502,'Swarm worker unreachable at '+this.origin.origin);
  }
  const reader=response.body?.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try{
   if(reader)for(;;){
    const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>1048576)throw new SwarmError(502,'Swarm worker response exceeds the 1 MiB limit');
    chunks.push(value);
   }
  }catch(error){if(error instanceof SwarmError)throw error;throw new SwarmError(504,'Swarm worker response was interrupted');}
  finally{await reader?.cancel().catch(()=>undefined);}
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{parsed=undefined;}
  if(!response.ok){
   const raw=obj(parsed).detail??obj(parsed).error;
   const detail=typeof raw==='string'?': '+redact(raw).slice(0,200):'';
   throw new SwarmError(response.status===404?404:response.status<500?400:502,'Swarm worker answered HTTP '+response.status+detail);
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new SwarmError(502,'Swarm worker returned an unrecognized response');
  return parsed as Record<string,unknown>;
 }
 async health(signal?:AbortSignal){
  const h=await this.request('/health',this.timeouts.health,undefined,signal);
  if(h.ok!==true)throw new SwarmError(502,'Swarm worker reports it is not healthy');
  if(h.profile!==SWARM_PROFILE)throw new SwarmError(502,'Swarm worker reports an unexpected profile; refusing to use it');
  return sanitize({version:h.version,profile:h.profile,seatsFingerprint:h.seats_fingerprint,activeRuns:h.active_runs}) as Record<string,unknown>;
 }
 async run(input:unknown,signal?:AbortSignal){
  const data=obj(input);
  if(Object.keys(data).some(k=>!['objective','budget'].includes(k))||typeof data.objective!=='string'||!data.objective.trim())throw new SwarmError(400,'Invalid swarm request');
  if(data.objective.length>SWARM_MAX_OBJECTIVE)throw new SwarmError(400,'Objective exceeds '+SWARM_MAX_OBJECTIVE+' characters');
  const budget=clampBudget(data.budget,this.config.defaultBudget),idempotencyKey='prime-'+randomUUID();
  debug('%j',{event:'prime_swarm_run_submitting',objectiveChars:data.objective.length,budget,idempotencyKey});
  const reply=await this.request('/run',this.timeouts.run,{objective:data.objective,budget,idempotency_key:idempotencyKey},signal);
  if(typeof reply.run_id!=='string'||!RUN_ID.test(reply.run_id))throw new SwarmError(502,'Swarm worker returned an invalid run id');
  const phase=typeof reply.phase==='string'?redact(reply.phase).slice(0,80):'accepted';
  debug('%j',{event:'prime_swarm_run_accepted',runId:reply.run_id,phase,budget});
  return {runId:reply.run_id,phase,budget,idempotencyKey};
 }
 async status(runId:string,signal?:AbortSignal):Promise<SwarmRunStatus>{
  if(typeof runId!=='string'||!RUN_ID.test(runId))throw new SwarmError(400,'Invalid swarm run id');
  const reply=await this.request('/runs/'+runId,this.timeouts.status,undefined,signal);
  if(reply.run_id!==undefined&&reply.run_id!==runId)throw new SwarmError(502,'Swarm worker answered for a different run');
  const done=reply.done===true,phase=typeof reply.phase==='string'?redact(reply.phase).slice(0,80):'unknown';
  const out:SwarmRunStatus={runId,phase,done};
  if(done&&reply.result!==undefined&&reply.result!==null)out.result=sanitize(reply.result);
  if(reply.error!==undefined&&reply.error!==null)out.error=redact(typeof reply.error==='string'?reply.error:JSON.stringify(sanitize(reply.error))).slice(0,600);
  debug('%j',{event:'prime_swarm_run_status',runId,phase,done,failed:!!out.error});
  return out;
 }
}
