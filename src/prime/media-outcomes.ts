import {mkdirSync,readFileSync} from 'node:fs';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {debuglog} from 'node:util';
import {redact} from '../code/workspace.js';
/**
 * What happened the last time Prime really ran a generator, kept per capability so the media router stops ranking a tool
 * that cannot run: a billing refusal (HTTP 402, no credits), an auth refusal (401/403, expired sign-in, missing scope) or a
 * gate that cannot execute the tool's call kind ("unsupported call_kind 'together_image_generation'"). Registry health
 * says none of this: those tools stay `green` there because the registry only probes reachability.
 *
 * Bounded (300 capabilities, 50 call kinds), persisted as one JSON file written atomically, never holding a prompt or a
 * provider body: only the category, a redacted reason of at most 200 characters, the time and counts.
 */
const debug=debuglog('echo-prime');
export type OutcomeCategory='ok'|'billing'|'auth'|'unsupported'|'schema'|'transient'|'refused'|'unknown';
export const OUTCOME_LABEL:Record<OutcomeCategory,string>={ok:'succeeded',billing:'billing refusal',auth:'sign-in or permission refusal',unsupported:'the gate cannot run it',schema:'the gate refused the request shape',transient:'provider or gate error',refused:'refused',unknown:'outcome unknown'};
/** Reads a failure text into a category. Order matters: a 402 inside an auth-looking sentence is still billing. */
export function classifyOutcome(state:string,detail:string):{category:OutcomeCategory;callKind?:string}{
 if(state==='returned'||state==='submitted'||state==='ok')return {category:'ok'};
 const text=String(detail||'');
 const kind=/unsupported call_kind '([a-z][a-z0-9_]{1,60})'/i.exec(text);
 if(kind)return {category:'unsupported',callKind:kind[1].toLowerCase()};
 if(/\bHTTP 402\b|\b402\b.*(?:credit|payment)|insufficient (?:credits|funds|balance)|never purchased credits|payment required|exceeded your current quota|out of credits|billing (?:is )?(?:not enabled|disabled|required)|quota exhausted/i.test(text))return {category:'billing'};
 if(/\bHTTP 40[13]\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|api key (?:is )?(?:invalid|missing|revoked)|failed to authenticate|oauth|not signed in|sign-?in (?:expired|required)|token (?:expired|revoked)|scope required|scope_forbidden|permission denied|elevenlabs_key_unavailable/i.test(text))return {category:'auth'};
 if(/unsupported|not implemented|\bHTTP 501\b|no handler for/i.test(text))return {category:'unsupported'};
 if(/input_schema_validation_failed|is a required property|additional properties are not allowed/i.test(text))return {category:'schema'};
 if(state==='uncertain')return {category:'unknown'};
 if(/\bHTTP 5\d\d\b|SDK gate HTTP|timed out|timeout|unreachable|unavailable|temporarily|busy|overloaded|rate limit|\b429\b|connection/i.test(text))return {category:'transient'};
 return {category:'refused'};
}
export interface OutcomeEntry {cap:string;provider:string;category:OutcomeCategory;reason:string;at:number;callKind?:string;ok:number;failed:number}
export interface CallKindEntry {kind:string;supported:boolean;at:number;cap:string;reason:string}
export interface Demotion {weight:number;category:OutcomeCategory;reason:string;own:boolean}
export interface MediaOutcomesOptions {file?:string;now?:()=>number;maxCaps?:number;
 /** A billing/auth/other failure demotes for this long unless a later run of the tool succeeds (default 24 h). */
 failureTtlMs?:number;
 /** An "unsupported call_kind" answer excludes that kind for this long, then the kind is tried again (default 12 h). */
 callKindTtlMs?:number}
const WEIGHT:Partial<Record<OutcomeCategory,number>>={billing:0.2,auth:0.2,unsupported:0.1,schema:0.5,transient:0.7,refused:0.7,unknown:0.85};
const ID=/^echo\.[A-Za-z0-9_.-]{1,180}$/;
const when=(at:number)=>new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC';
export class MediaOutcomes {
 private caps=new Map<string,OutcomeEntry>();private kinds=new Map<string,CallKindEntry>();
 private now:()=>number;private writing:Promise<void>=Promise.resolve();
 constructor(private options:MediaOutcomesOptions={}){
  this.now=options.now??Date.now;
  if(options.file)this.load(options.file);
 }
 private get ttl(){return this.options.failureTtlMs??86400000;}
 private get kindTtl(){return this.options.callKindTtlMs??43200000;}
 private load(file:string){
  let raw:string;
  try{raw=readFileSync(file,'utf8');}catch{return;}
  try{
   const data=JSON.parse(raw) as {caps?:unknown;kinds?:unknown};
   for(const row of Array.isArray(data.caps)?data.caps.slice(-(this.options.maxCaps??300)):[]){
    const r=row as Partial<OutcomeEntry>;
    if(typeof r.cap!=='string'||!ID.test(r.cap)||typeof r.at!=='number'||typeof r.category!=='string'||!(r.category in OUTCOME_LABEL))continue;
    this.caps.set(r.cap,{cap:r.cap,provider:String(r.provider??'unknown').slice(0,60),category:r.category as OutcomeCategory,reason:String(r.reason??'').slice(0,200),at:r.at,...(typeof r.callKind==='string'?{callKind:r.callKind.slice(0,60)}:{}),ok:Number(r.ok)||0,failed:Number(r.failed)||0});
   }
   for(const row of Array.isArray(data.kinds)?data.kinds.slice(-50):[]){
    const k=row as Partial<CallKindEntry>;
    if(typeof k.kind!=='string'||!/^[a-z][a-z0-9_]{1,60}$/.test(k.kind)||typeof k.at!=='number'||typeof k.supported!=='boolean')continue;
    this.kinds.set(k.kind,{kind:k.kind,supported:k.supported,at:k.at,cap:String(k.cap??'').slice(0,180),reason:String(k.reason??'').slice(0,200)});
   }
  }catch{debug('%j',{event:'prime_media_outcomes_unreadable'});}
 }
 /** Records one real execution. `detail` is the gate/provider failure text (redacted and cut here). */
 record(input:{cap:string;provider:string;state:string;detail?:string;callKind?:string}):OutcomeEntry|undefined{
  if(!ID.test(input.cap))return undefined;
  const {category,callKind}=classifyOutcome(input.state,input.detail??'');
  const at=this.now(),old=this.caps.get(input.cap),kind=callKind??input.callKind;
  const entry:OutcomeEntry={cap:input.cap,provider:input.provider.slice(0,60),category,reason:category==='ok'?'':redact(String(input.detail??'')).replace(/\s+/g,' ').trim().slice(0,200),at,...(kind?{callKind:kind}:{}),ok:(old?.ok??0)+(category==='ok'?1:0),failed:(old?.failed??0)+(category==='ok'?0:1)};
  this.caps.delete(input.cap);this.caps.set(input.cap,entry);
  while(this.caps.size>(this.options.maxCaps??300))this.caps.delete(this.caps.keys().next().value!);
  // A call kind is learned both ways: the gate saying it cannot run it, and any successful run of a tool of that kind.
  if(kind&&(category==='ok'||callKind)){
   this.kinds.delete(kind);this.kinds.set(kind,{kind,supported:category==='ok',at,cap:input.cap,reason:category==='ok'?'':entry.reason});
   while(this.kinds.size>50)this.kinds.delete(this.kinds.keys().next().value!);
  }
  debug('%j',{event:'prime_media_outcome',cap:input.cap,category,callKind:kind??null});
  this.persist();
  return entry;
 }
 last(cap:string){return this.caps.get(cap);}
 /** The learned state of a call kind, while it is fresh: an unsupported answer expires so a fixed gate is tried again. */
 callKind(kind:string):CallKindEntry|undefined{
  const k=this.kinds.get(kind);if(!k)return undefined;
  if(!k.supported&&this.now()-k.at>this.kindTtl)return undefined;
  return k;
 }
 /** Why this tool should rank lower right now, or nothing. Its own last failure counts until a later success; a billing
  * refusal counts for every tool of the same provider (one account pays for all of them) unless that tool ran fine since. */
 demotion(cap:string,provider:string):Demotion|undefined{
  const now=this.now(),own=this.caps.get(cap);
  if(own&&own.category!=='ok'&&now-own.at<this.ttl)return {weight:WEIGHT[own.category]??0.7,category:own.category,own:true,reason:'its last run ('+when(own.at)+') failed: '+OUTCOME_LABEL[own.category]+(own.reason?' ('+own.reason.slice(0,140)+')':'')};
  let worst:OutcomeEntry|undefined;
  for(const e of this.caps.values())if(e.cap!==cap&&e.provider===provider&&e.category==='billing'&&now-e.at<this.ttl&&(!own||own.at<e.at)&&(!worst||e.at>worst.at))worst=e;
  if(worst)return {weight:WEIGHT.billing!,category:'billing',own:false,reason:provider+' refused '+worst.cap.replace(/^echo\./,'')+' for billing ('+when(worst.at)+'), and the same account pays for this tool'+(worst.reason?' ('+worst.reason.slice(0,120)+')':'')};
  return undefined;
 }
 snapshot(){return {caps:[...this.caps.values()],kinds:[...this.kinds.values()]};}
 private persist(){
  const file=this.options.file;if(!file)return;
  const body=JSON.stringify({schemaVersion:1,...this.snapshot()});
  this.writing=this.writing.then(async()=>{
   const tmp=file+'.'+randomUUID()+'.tmp';
   await mkdir(dirname(file),{recursive:true,mode:0o700});
   await writeFile(tmp,body,{mode:0o600});await rename(tmp,file);
  }).catch(error=>{debug('%j',{event:'prime_media_outcomes_write_failed',reason:error instanceof Error?redact(error.message).slice(0,120):'write failed'});});
 }
 /** Resolves when every queued write has landed (tests and shutdown). */
 flush(){return this.writing;}
}
/** Ensures a configured outcomes directory exists before the first write (startup check, never throws). */
export function prepareOutcomesFile(file:string){try{mkdirSync(dirname(file),{recursive:true,mode:0o700});}catch{debug('%j',{event:'prime_media_outcomes_dir_unavailable'});}}
