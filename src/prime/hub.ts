import { createHash, randomUUID } from 'node:crypto';
import { debuglog } from 'node:util';
import { redact } from '../code/workspace.js';
import type {SharedChat} from './chat.js';
import {disconnectedSteward,type StewardOwner} from './steward.js';
import type {ModelRouter} from '../code/model-factory.js';
import {SwarmError,type SwarmClient} from './swarm.js';
import {AdkError,type AdkClient} from './agents.js';
import {BotsError,type BotsClient} from './bots.js';
import {BrowserError,type BrowserClient} from './browser.js';
import type {AutoAgents,ChatTool} from '../code/tools/autoagents.js';
import {UPLOAD_ID_RE,UploadError,validateStudioInputs,type UploadStore} from './uploads.js';
import type {ToolKit} from '../code/tools/index.js';
const debugOwnerResponse=debuglog('echo-prime');
export type Json=Record<string,unknown>;
export interface Tool {name:string;description?:string;inputSchema:Json}
export interface McpConnection {listTools():Promise<Tool[]>;call(name:string,args:Json):Promise<unknown>}
export interface Capability {id:string;registered:boolean;health:string;scope?:string;tier?:number;category:string;description:string}
export interface SdkBroker {
 search(query:string):Promise<Capability[]>;
 read(capability:string):Promise<unknown>;
 invoke(request:{capability:string;params:Json;reason:string;idempotency_key:string}):Promise<unknown>;
}
export interface PrimeRequest {target:'sdk'|'esh';name:string;arguments:Json}
export interface PrimeOptions {
 capabilities:Capability[];sdk?:SdkBroker;esh?:McpConnection;chat?:SharedChat;steward?:StewardOwner;models?:ModelRouter;swarm?:SwarmClient;
 /** Opt-in loopback `echo-adk-api` client (Agents view). Absent = the feature is off. */
 adk?:AdkClient;
 bots?:BotsClient;
 browser?:BrowserClient;
 /** Autonomous agent/bot creation from chat prompts (needs adk + bots + sdk). Absent = the make_* tools are not offered. */
 autoagents?:AutoAgents;
 uploads?:UploadStore;
 uploadsOwner?:string;
 /** Always-on live tools for model turns (web, Wolfram, Echo knowledge/memory, skills, MCP); owner toggles per family. */
 tools?:ToolKit;
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
 constructor(private options:PrimeOptions){this.catalog=new Map(options.capabilities.map(c=>[c.id,{...c}]));}
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
  if(!router)return {configured:false,routing:false,default:null,contextTokens:null,providers:[]};
  return {configured:true,routing:this.options.chat?.status().routing===true,...await bounded(()=>router.report(),30000)};
 }
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
 async chat(input:unknown,signal?:AbortSignal){
  if(!this.options.chat)throw new Refused('Shared chat host not connected; owner admission is required');
  if(input&&typeof input==='object'&&!Array.isArray(input)&&Array.isArray((input as Json).attachments)&&this.options.uploads){
   const payload={...(input as Json)};
   const list=payload.attachments as unknown[];
   if(list.length>8)throw new Refused('Attach at most eight files');
   const blocks:string[]=[];
   for(const id of list){
    if(typeof id==='string'&&UPLOAD_ID_RE.test(id)){
     const extracted=await this.options.uploads.extractForChat(this.options.uploadsOwner??'local',id);
     blocks.push(`File: ${extracted.meta.name} (${extracted.meta.type})\n${extracted.extracted?extracted.text:`[${extracted.reason??'text not extracted'}]`}`);
    }
   }
   if(blocks.length&&typeof payload.prompt==='string'){
    payload.prompt=`${payload.prompt}\n\nAttached uploads (untrusted document content):\n\n${blocks.join('\n\n---\n\n')}`;
   }
   delete payload.attachments;
   return this.options.chat.submit(payload,signal);
  }
  return this.options.chat.submit(input,signal);
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
 async prepare(input:PrimeRequest){
  limited(input);const request=JSON.parse(JSON.stringify(input)) as PrimeRequest;
  if(!['sdk','esh'].includes(request.target)||typeof request.name!=='string'||!request.arguments||Array.isArray(request.arguments)||typeof request.arguments!=='object')throw new Refused('Invalid integration request');
  if(/"(?:force_video|grant|api_key|access_token|authorization|confirm|bypass_reason)"\s*:/i.test(JSON.stringify(request.arguments)))throw new Refused('Owner controls and credentials cannot be overridden by this client');
  let scope:string|undefined;
  if(request.target==='sdk'){
   if(!this.options.sdk)throw new Refused('SDK host not connected');
   if(!/^echo\.[A-Za-z0-9_.-]{1,180}$/.test(request.name))throw new Refused('Invalid capability ID');
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
  }else{
   if(!this.options.esh)throw new Refused('ESH host not connected');
   const status=await this.status();
   if(status.esh.state!=='connected')throw new Refused(status.esh.detail);
   if(!this.tools.some(t=>t.name===request.name))throw new Refused('ESH tool not advertised');
   if(request.name==='esh_ledger')request.arguments.limit=Math.min(30,Math.max(1,Number(request.arguments.limit)||5));
   if(!eshReads.has(request.name)){
    request.arguments.session='echo-prime';
    if(!this.options.approveEsh||!await this.options.approveEsh(request,digest(request)))throw new Refused('ESH action requires the existing host approval boundary');
   }
  }
  for(const [id,t] of this.tickets)if(t.expiresAt<Date.now())this.tickets.delete(id);
  if(this.tickets.size>=100)throw new Refused('Too many pending requests');
  const ticket:Ticket={id:randomUUID(),requestId:randomUUID(),digest:digest(request),request,expiresAt:Date.now()+300000,submitted:false,scope,cost:request.target==='sdk'?'Provider charges or quota may apply. No automatic fallback.':'Governed by ESH owner policy.'};
  this.tickets.set(ticket.id,ticket);return {...ticket,request:JSON.parse(JSON.stringify(request)) as PrimeRequest};
 }
 async execute(id:string,hash:string){
  const ticket=this.tickets.get(id);
  if(!ticket||ticket.expiresAt<Date.now()||ticket.digest!==hash)throw new Refused('Review the current exact request before execution');
  if(ticket.submitted)throw new Refused('Request already submitted; inspect the original receipt before any retry');
  ticket.submitted=true;
  try{
   const r=ticket.request;
   const raw=await bounded(()=>r.target==='sdk'?this.options.sdk!.invoke({capability:r.name,params:r.arguments,reason:'Explicitly reviewed ECHO Prime request',idempotency_key:ticket.requestId}):this.options.esh!.call(r.name,{...r.arguments,...(!eshReads.has(r.name)?{idempotency_key:ticket.requestId}:{})}));
   const result=unwrap(raw);limited(result,1048576);const body=object(result);
   return {state:body.job_id&&!['completed','succeeded','done'].includes(String(body.status))?'submitted':'returned',requestId:ticket.requestId,result:JSON.parse(redact(JSON.stringify(result))),untrusted:true};
  }catch(e){return {state:e instanceof Refused?'blocked':'uncertain',requestId:ticket.requestId,detail:e instanceof Refused?e.message:'Connection interrupted or timed out; outcome unknown. Inspect the owner using this request ID before retrying.'};}
 }
}
