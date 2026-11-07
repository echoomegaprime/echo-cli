import {debuglog} from 'node:util';
import {validateEndpoint} from '../code/model.js';
import {redact} from '../code/workspace.js';
import {WorkspaceHttpError} from './workspace.js';
import {sanitize} from './swarm.js';
/**
 * Client for echoBots: always-on governed agents served by the loopback `echo-adk-api` service (contract
 * docs/echo-code/ECHO_ADK_API_CONTRACT.md, frozen 2026-11-04). Consumed exactly the way swarm.ts consumes the
 * Maximalist worker: plain fetch with timeouts, redirect:'error', a 1 MiB response cap, every string redacted, one
 * reviewed loopback origin and nothing else. Prime never forwards a token or credential; the service holds its own.
 * Every id must be 32 lowercase hex characters before a URL is built. There is no fallback of any kind.
 */
export const BOTS_PROFILE='ECHO_ADK';
export const BOTS_MAX={max_calls:120,max_cost_usd:5,max_wall_s:4800} as const;
export const BOTS_LIMITS={name:64,text:12000,everyS:60,maxEveryS:604800,dailyCapUsd:5,groupMin:2,groupMax:6,messages:200,plugins:32,scopes:64,agent:120} as const;
export interface BotsBudget {max_calls:number;max_cost_usd:number;max_wall_s:number}
export interface BotsConfig {baseUrl:string;defaultBudget:BotsBudget}
/** Default cost 0: bots run on the free local lane until the owner raises a bot's daily cap explicitly. */
export const DEFAULT_BOTS:BotsConfig={baseUrl:'http://127.0.0.1:8378',defaultBudget:{max_calls:80,max_cost_usd:0,max_wall_s:1800}};
const MIN:BotsBudget={max_calls:1,max_cost_usd:0,max_wall_s:30};
const KEYS=Object.keys(BOTS_MAX) as (keyof BotsBudget)[];
const HEX=/^[0-9a-f]{32}$/;
const AGENT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const PLUGIN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CAPABILITY=/^echo\.[A-Za-z0-9_.-]{1,180}$/;
const MODES=['personal','team'] as const;
const debug=debuglog('echo-prime');
/** Carries an HTTP status so the Prime server answers 4xx/5xx instead of a blanket 400, plus the contract error code when the service named one. */
export class BotsError extends WorkspaceHttpError {constructor(status:number,message:string,public code?:string){super(status,message);}}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function record(value:unknown,what:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new BotsError(400,'Invalid '+what);
 return value as Record<string,unknown>;
}
function onlyKeys(data:Record<string,unknown>,allowed:readonly string[],what:string){
 for(const key of Object.keys(data))if(!allowed.includes(key))throw new BotsError(400,'Invalid '+what+': unknown field');
}
function hexId(value:unknown,what:string):string{
 if(typeof value!=='string'||!HEX.test(value))throw new BotsError(400,'Invalid '+what+' id');
 return value;
}
function optionalText(value:unknown,what:string,max:number):string|undefined{
 if(value===undefined)return undefined;
 if(typeof value!=='string')throw new BotsError(400,'Invalid '+what);
 if(value.length>max)throw new BotsError(400,what[0].toUpperCase()+what.slice(1)+' exceeds '+max+' characters');
 return value;
}
function requiredText(value:unknown,what:string,max:number):string{
 const text=optionalText(value,what,max);
 if(text===undefined||!text.trim())throw new BotsError(400,'Invalid '+what);
 return text;
}
function positiveInteger(value:unknown,what:string):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new BotsError(400,'Invalid '+what+': must be a positive integer');
 return value;
}
/** Clamps a requested budget into the service limits. Missing keys take the default; a present non-number is refused, never guessed. */
export function clampBotsBudget(input:unknown,defaults:BotsBudget=DEFAULT_BOTS.defaultBudget):BotsBudget{
 if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))throw new BotsError(400,'Invalid bots budget');
 const given=(input??{}) as Record<string,unknown>;
 for(const key of Object.keys(given))if(!(KEYS as string[]).includes(key))throw new BotsError(400,'Invalid bots budget: unknown field');
 const out={} as BotsBudget;
 for(const key of KEYS){
  const value=given[key]===undefined?defaults[key]:given[key];
  if(typeof value!=='number'||!Number.isFinite(value))throw new BotsError(400,'Invalid bots budget: '+key+' must be a number');
  const clamped=Math.min(BOTS_MAX[key],Math.max(MIN[key],value));
  out[key]=key==='max_cost_usd'?Math.round(clamped*100)/100:Math.floor(clamped);
 }
 return out;
}
/** Strict, like parseSwarmConfig: unknown fields and any non-loopback origin are refused. Section absent = feature off (decided by the caller). */
export function parseBotsConfig(value:unknown):BotsConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid bots configuration: bots must be an object');
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(!['baseUrl','defaultBudget'].includes(key))throw new Error('Invalid bots configuration: unknown field');
 let baseUrl=DEFAULT_BOTS.baseUrl;
 if(input.baseUrl!==undefined){if(typeof input.baseUrl!=='string')throw new Error('Invalid bots configuration: baseUrl');baseUrl=input.baseUrl;}
 try{validateEndpoint(baseUrl);}catch{throw new Error('Invalid bots configuration: baseUrl must be a credential-free loopback origin');}
 let defaultBudget:BotsBudget;
 try{defaultBudget=clampBotsBudget(input.defaultBudget,DEFAULT_BOTS.defaultBudget);}catch{throw new Error('Invalid bots configuration: defaultBudget');}
 return {baseUrl:new URL(baseUrl).origin,defaultBudget};
}
export interface BotLease {scopes:string[];ttl_s:number;max_uses:number}
export type BotSchedule={every_s:number;missed?:'skip'|'once'}|{at:string;tz:string;weekdays:number[];missed:'skip'|'once'};
export interface BotCreateBody {name:string;agent:string;mode?:'personal'|'team';schedule?:BotSchedule|null;instruction?:string;plugins?:string[];lease?:BotLease;daily_cost_cap_usd:number}
/** Validates a create request from the browser into the exact contract body. Limits are refused, not clamped: nothing is guessed on the owner's behalf. */
export function parseBotCreate(input:unknown,defaultCapUsd:number):BotCreateBody{
 const data=record(input,'bot request');
 onlyKeys(data,['name','agent','mode','schedule','instruction','plugins','lease','daily_cost_cap_usd'],'bot request');
 const name=requiredText(data.name,'bot name',BOTS_LIMITS.name).trim();
 if(typeof data.agent!=='string'||!AGENT.test(data.agent))throw new BotsError(400,'Invalid agent name');
 const body:BotCreateBody={name,agent:data.agent,daily_cost_cap_usd:defaultCapUsd};
 if(data.mode!==undefined){if(!(MODES as readonly unknown[]).includes(data.mode))throw new BotsError(400,'Invalid bot mode');body.mode=data.mode as 'personal'|'team';}
 if(data.schedule===null)body.schedule=null;
 else if(data.schedule!==undefined){
  const schedule=record(data.schedule,'bot schedule');
  if(schedule.missed!==undefined&&schedule.missed!=='skip'&&schedule.missed!=='once')throw new BotsError(400,'Invalid bot schedule: missed must be skip or once');
  if('every_s' in schedule){
   onlyKeys(schedule,['every_s','missed'],'bot schedule');
   if(typeof schedule.every_s!=='number'||!Number.isSafeInteger(schedule.every_s)||schedule.every_s<BOTS_LIMITS.everyS||schedule.every_s>BOTS_LIMITS.maxEveryS)throw new BotsError(400,'Invalid bot schedule: every_s must be an integer of at least '+BOTS_LIMITS.everyS+' and at most '+BOTS_LIMITS.maxEveryS);
   body.schedule={every_s:schedule.every_s,...(schedule.missed===undefined?{}:{missed:schedule.missed as 'skip'|'once'})};
  }else{
   onlyKeys(schedule,['at','tz','weekdays','missed'],'bot schedule');
   if(typeof schedule.at!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.at))throw new BotsError(400,'Invalid bot schedule: at must be HH:mm');
   if(typeof schedule.tz!=='string'||!schedule.tz||schedule.tz.length>100)throw new BotsError(400,'Invalid bot schedule: timezone required');
   try{new Intl.DateTimeFormat('en',{timeZone:schedule.tz}).format();}catch{throw new BotsError(400,'Invalid bot schedule: unknown timezone');}
   if(!Array.isArray(schedule.weekdays)||!schedule.weekdays.length||schedule.weekdays.length>7||schedule.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(schedule.weekdays).size!==schedule.weekdays.length)throw new BotsError(400,'Invalid bot schedule: weekdays must be distinct ISO days 1 to 7');
   const missed=schedule.missed===undefined?'skip':schedule.missed as 'skip'|'once';
   body.schedule={at:schedule.at,tz:schedule.tz,weekdays:schedule.weekdays as number[],missed};
  }
 }
 const instruction=optionalText(data.instruction,'instruction',BOTS_LIMITS.text);if(instruction!==undefined)body.instruction=instruction;
 if(data.plugins!==undefined){
  if(!Array.isArray(data.plugins)||data.plugins.length>BOTS_LIMITS.plugins||data.plugins.some(p=>typeof p!=='string'||!PLUGIN.test(p)))throw new BotsError(400,'Invalid bot plugins');
  body.plugins=[...new Set(data.plugins as string[])];
 }
 if(data.lease!==undefined){
  const lease=record(data.lease,'bot lease');onlyKeys(lease,['scopes','ttl_s','max_uses'],'bot lease');
  if(!Array.isArray(lease.scopes)||!lease.scopes.length||lease.scopes.length>BOTS_LIMITS.scopes||lease.scopes.some(s=>typeof s!=='string'||!CAPABILITY.test(s)))throw new BotsError(400,'Invalid bot lease: scopes must be exact capability ids');
  body.lease={scopes:[...new Set(lease.scopes as string[])],ttl_s:positiveInteger(lease.ttl_s,'bot lease ttl_s'),max_uses:positiveInteger(lease.max_uses,'bot lease max_uses')};
 }
 if(data.daily_cost_cap_usd!==undefined){
  const cap=data.daily_cost_cap_usd;
  if(typeof cap!=='number'||!Number.isFinite(cap)||cap<0)throw new BotsError(400,'Invalid daily cost cap');
  if(cap>BOTS_LIMITS.dailyCapUsd)throw new BotsError(400,'Daily cost cap exceeds '+BOTS_LIMITS.dailyCapUsd+' USD');
  body.daily_cost_cap_usd=Math.round(cap*100)/100;
 }
 return body;
}
export interface BotGroupBody {name:string;bots:string[];prompt:string}
export function parseGroupCreate(input:unknown):BotGroupBody{
 const data=record(input,'group request');
 onlyKeys(data,['name','bots','prompt'],'group request');
 const name=requiredText(data.name,'group name',BOTS_LIMITS.name).trim();
 if(!Array.isArray(data.bots)||data.bots.length<BOTS_LIMITS.groupMin||data.bots.length>BOTS_LIMITS.groupMax)throw new BotsError(400,'A group needs '+BOTS_LIMITS.groupMin+' to '+BOTS_LIMITS.groupMax+' bots');
 const bots=data.bots.map(b=>hexId(b,'bot'));
 if(new Set(bots).size!==bots.length)throw new BotsError(400,'A group cannot list the same bot twice');
 return {name,bots,prompt:requiredText(data.prompt,'group prompt',BOTS_LIMITS.text)};
}
interface RequestInit {method?:'GET'|'POST'|'DELETE';body?:unknown;query?:Record<string,string|undefined>}
export class BotsClient {
 readonly config:BotsConfig;private origin:URL;
 constructor(config:BotsConfig=DEFAULT_BOTS,private timeouts={health:5000,mutate:15000,poll:10000}){
  this.origin=validateEndpoint(config.baseUrl);
  this.config={baseUrl:this.origin.origin,defaultBudget:clampBotsBudget(config.defaultBudget,DEFAULT_BOTS.defaultBudget)};
 }
 private async request(route:string,ms:number,init:RequestInit={},signal?:AbortSignal):Promise<Record<string,unknown>>{
  const url=new URL(route,this.origin);
  if(url.origin!==this.origin.origin||url.pathname!==route)throw new BotsError(400,'echoBots route refused');
  for(const [key,value] of Object.entries(init.query??{}))if(value!==undefined)url.searchParams.set(key,value);
  const method=init.method??(init.body===undefined?'GET':'POST');
  let response:Response;
  try{
   response=await fetch(url,{method,redirect:'error',headers:init.body===undefined?{accept:'application/json'}:{accept:'application/json','content-type':'application/json'},
    body:init.body===undefined?undefined:JSON.stringify(init.body),signal:AbortSignal.any([AbortSignal.timeout(ms),...(signal?[signal]:[])])});
  }catch(error){
   if(signal?.aborted)throw new BotsError(499,'Interrupted');
   if(error instanceof Error&&error.name==='TimeoutError')throw new BotsError(504,'echoBots service timed out after '+Math.round(ms/1000)+' s; outcome unknown');
   throw new BotsError(502,'echoBots service unreachable at '+this.origin.origin);
  }
  const reader=response.body?.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try{
   if(reader)for(;;){
    const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>1048576)throw new BotsError(502,'echoBots service response exceeds the 1 MiB limit');
    chunks.push(value);
   }
  }catch(error){if(error instanceof BotsError)throw error;throw new BotsError(504,'echoBots service response was interrupted');}
  finally{await reader?.cancel().catch(()=>undefined);}
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{parsed=undefined;}
  if(!response.ok){
   // Contract errors are {error:<code>, message:<redacted text>}; a gated step also names what it needs and how to grant it.
   const body=obj(parsed),code=typeof body.error==='string'?redact(body.error).slice(0,40):undefined;
   let detail=typeof body.message==='string'?': '+redact(body.message).slice(0,300):'';
   if(code==='gated'){
    const needs=Array.isArray(body.needs)?body.needs.filter(n=>typeof n==='string').slice(0,20).map(n=>redact(n as string).slice(0,120)).join(', '):'';
    if(needs)detail+=' (needs: '+needs+')';
    if(typeof body.how==='string')detail+=' (how: '+redact(body.how).slice(0,200)+')';
   }
   throw new BotsError(response.status===404?404:response.status<500?400:502,'echoBots service answered HTTP '+response.status+(code?': '+code:'')+detail,code);
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new BotsError(502,'echoBots service returned an unrecognized response');
  return parsed as Record<string,unknown>;
 }
 /** Service identity: refuses anything that is not healthy or does not report profile ECHO_ADK (same rule as the swarm profile check). */
 async health(signal?:AbortSignal){
  let h:Record<string,unknown>;
  try{h=await this.request('/v2/health',this.timeouts.health,{},signal);}
  catch(error){if(error instanceof BotsError&&error.status===404)throw new BotsError(502,'echoBots automation API v2 is unavailable; upgrade the echo-adk service to use these controls','unsupported_contract');throw error;}
  if(h.ok!==true)throw new BotsError(502,'echoBots service reports it is not healthy');
  if(h.profile!==BOTS_PROFILE)throw new BotsError(502,'echoBots service reports an unexpected profile; refusing to use it');
  if(h.contract_version!==2)throw new BotsError(502,'echoBots automation API v2 is required; the service did not confirm its contract','unsupported_contract');
  debug('%j',{event:'prime_bots_health',profile:h.profile,bots:h.bots,runsActive:h.runs_active});
  return sanitize({service:h.service,version:h.version,profile:h.profile,agents:h.agents,bots:h.bots,runsActive:h.runs_active,contract_version:h.contract_version,features:h.features,budgets:h.budgets,connections:h.connections}) as Record<string,unknown>;
 }
 /** A Bot from the service: the id is verified before anything is kept; every string is redacted. */
 private bot(raw:Record<string,unknown>,expected?:string):Record<string,unknown>{
  if(typeof raw.bot_id!=='string'||!HEX.test(raw.bot_id))throw new BotsError(502,'echoBots service returned an invalid bot id');
  if(expected!==undefined&&raw.bot_id!==expected)throw new BotsError(502,'echoBots service answered for a different bot');
  return sanitize(raw) as Record<string,unknown>;
 }
 async list(signal?:AbortSignal){
  const reply=await this.request('/v2/bots',this.timeouts.poll,{},signal);
  if(!Array.isArray(reply.bots))throw new BotsError(502,'echoBots service returned an unrecognized bot list');
  return {bots:reply.bots.slice(0,500).map(b=>this.bot(obj(b)))};
 }
 async get(botId:string,signal?:AbortSignal){
  const id=hexId(botId,'bot');
  return this.bot(await this.request('/v2/bots/'+id,this.timeouts.poll,{},signal),id);
 }
 async create(input:unknown,signal?:AbortSignal){
  const body=parseBotCreate(input,this.config.defaultBudget.max_cost_usd);
  debug('%j',{event:'prime_bots_create_submitting',agent:body.agent,mode:body.mode??'personal',scheduled:!!body.schedule,plugins:body.plugins?.length??0,dailyCapUsd:body.daily_cost_cap_usd});
  const bot=this.bot(await this.request('/v2/bots',this.timeouts.mutate,{method:'POST',body},signal));
  debug('%j',{event:'prime_bots_create_accepted',botId:bot.bot_id,status:bot.status});
  return bot;
 }
 private async transition(botId:string,action:'pause'|'resume',signal?:AbortSignal){
  const id=hexId(botId,'bot');
  const bot=this.bot(await this.request('/v2/bots/'+id+'/'+action,this.timeouts.mutate,{method:'POST'},signal),id);
  debug('%j',{event:'prime_bots_action',action,botId:id,status:bot.status});
  return bot;
 }
 pause(botId:string,signal?:AbortSignal){return this.transition(botId,'pause',signal);}
 resume(botId:string,signal?:AbortSignal){return this.transition(botId,'resume',signal);}
 async remove(botId:string,signal?:AbortSignal){
  const id=hexId(botId,'bot');
  const reply=await this.request('/bots/'+id,this.timeouts.mutate,{method:'DELETE'},signal);
  if(reply.bot_id!==id||reply.deleted!==true)throw new BotsError(502,'echoBots service did not confirm the deletion');
  debug('%j',{event:'prime_bots_action',action:'delete',botId:id});
  return {botId:id,deleted:true};
 }
 /** Queues one bot turn. A paused bot still accepts the message and answers when resumed; the answer arrives through its run. */
 async message(botId:string,input:unknown,signal?:AbortSignal){
  const id=hexId(botId,'bot'),data=record(input,'bot message');
  onlyKeys(data,['text'],'bot message');
  const text=requiredText(data.text,'message text',BOTS_LIMITS.text);
  const reply=await this.request('/bots/'+id+'/message',this.timeouts.mutate,{method:'POST',body:{text}},signal);
  if(typeof reply.message_id!=='string'||!HEX.test(reply.message_id)||typeof reply.run_id!=='string'||!HEX.test(reply.run_id))throw new BotsError(502,'echoBots service returned an invalid message or run id');
  debug('%j',{event:'prime_bots_message_accepted',botId:id,messageId:reply.message_id,runId:reply.run_id,textChars:text.length});
  return {botId:id,messageId:reply.message_id,runId:reply.run_id};
 }
 /** Delivers an idempotent external event without changing the bot's status or permissions. */
 async event(botId:string,input:unknown,signal?:AbortSignal){
  const id=hexId(botId,'bot'),data=record(input,'bot event');
  onlyKeys(data,['event_id','source','text'],'bot event');
  const eventId=requiredText(data.event_id,'event id',128),source=requiredText(data.source,'event source',64),text=requiredText(data.text,'event text',10000);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(eventId)||!/^[a-z0-9][a-z0-9_.-]*$/.test(source))throw new BotsError(400,'Invalid bot event id or source');
  const reply=await this.request('/v2/bots/'+id+'/events',this.timeouts.mutate,{method:'POST',body:{event_id:eventId,source,text}},signal);
  const statusValid=reply.duplicate===true?typeof reply.status==='string'&&['queued','running','gated','done','failed','unavailable'].includes(reply.status):reply.status==='queued';
  if(reply.event_id!==eventId||typeof reply.message_id!=='string'||!HEX.test(reply.message_id)||typeof reply.run_id!=='string'||!HEX.test(reply.run_id)||typeof reply.duplicate!=='boolean'||!statusValid)throw new BotsError(502,'echoBots service returned an invalid event receipt');
  return {botId:id,messageId:reply.message_id,runId:reply.run_id,eventId,duplicate:reply.duplicate,status:reply.status};
 }
 async messages(botId:string,options:{since?:unknown;limit?:unknown}={},signal?:AbortSignal){
  const id=hexId(botId,'bot'),query:Record<string,string|undefined>={};
  if(options.since!==undefined)query.since=hexId(options.since,'message');
  if(options.limit!==undefined){
   if(typeof options.limit!=='number'||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>BOTS_LIMITS.messages)throw new BotsError(400,'Invalid message limit: 1 to '+BOTS_LIMITS.messages);
   query.limit=String(options.limit);
  }
  const reply=await this.request('/bots/'+id+'/messages',this.timeouts.poll,{query},signal);
  if(!Array.isArray(reply.messages))throw new BotsError(502,'echoBots service returned an unrecognized transcript');
  const messages=reply.messages.slice(0,BOTS_LIMITS.messages).map(m=>{
   const row=obj(m);
   if(typeof row.message_id!=='string'||!HEX.test(row.message_id))throw new BotsError(502,'echoBots service returned an invalid message id');
   if(row.run_id!==undefined&&row.run_id!==null&&(typeof row.run_id!=='string'||!HEX.test(row.run_id)))throw new BotsError(502,'echoBots service returned an invalid run id');
   return sanitize(row) as Record<string,unknown>;
  });
  return {botId:id,messages};
 }
 /** Group chat of 2 to 6 bots. Each bot answers through its own governed run. */
 async createGroup(input:unknown,signal?:AbortSignal){
  const body=parseGroupCreate(input);
  debug('%j',{event:'prime_bots_group_submitting',bots:body.bots.length,promptChars:body.prompt.length});
  const reply=await this.request('/groups',this.timeouts.mutate,{method:'POST',body},signal);
  if(typeof reply.group_id!=='string'||!HEX.test(reply.group_id))throw new BotsError(502,'echoBots service returned an invalid group id');
  const runIds=Array.isArray(reply.run_ids)?reply.run_ids:[];
  if(runIds.some(r=>typeof r!=='string'||!HEX.test(r)))throw new BotsError(502,'echoBots service returned an invalid run id');
  debug('%j',{event:'prime_bots_group_accepted',groupId:reply.group_id,runs:runIds.length});
  return {groupId:reply.group_id,runIds:runIds as string[],name:body.name,bots:body.bots};
 }
 async group(groupId:string,signal?:AbortSignal){
  const id=hexId(groupId,'group');
  const reply=await this.request('/groups/'+id,this.timeouts.poll,{},signal);
  if(reply.group_id!==id)throw new BotsError(502,'echoBots service answered for a different group');
  const out=sanitize(reply) as Record<string,unknown>;
  if(out.messages!==undefined&&!Array.isArray(out.messages))throw new BotsError(502,'echoBots service returned an unrecognized group transcript');
  return out;
 }
}
