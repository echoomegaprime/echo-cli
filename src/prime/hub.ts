import { createHash, randomUUID } from 'node:crypto';
import { debuglog } from 'node:util';
import { redact } from '../code/workspace.js';
import type {SharedChat} from './chat.js';
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
 capabilities:Capability[];sdk?:SdkBroker;esh?:McpConnection;chat?:SharedChat;
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
 async chat(input:unknown,signal?:AbortSignal){
  if(!this.options.chat)throw new Refused('Shared chat host not connected; owner admission is required');
  return this.options.chat.submit(input,signal);
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
