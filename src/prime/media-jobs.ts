import {debuglog} from 'node:util';
import {redact} from '../code/workspace.js';
import type {Json} from './hub.js';
import {MediaCollector,TYPE_EXT,findMedia,type InvokeKind,type MediaConfig} from './media-collect.js';
import type {MediaOutcomes} from './media-outcomes.js';
import type {ArtifactKind,UploadStore} from './uploads.js';
/**
 * One reviewed Studio execution, followed to the end on the server. The execute request answers within `inlineMs`
 * (the public proxy cuts a request at 100 s); a call still running continues here, bounded by the per-kind invoke limit,
 * and the browser reads its state by request id. An async provider job (`job_id` + a pending status) is polled through
 * the gate's status capability with backoff up to `jobWallMs`. A finished answer's media file is read server-side
 * (media-collect.ts), stored as an upload and registered as a Library artifact that points at the file, not the JSON.
 *
 * The browser never names a capability, job id or URL here: it only sends the request id Prime minted at review time.
 * Nothing is resubmitted: a failed or timed-out call ends the job with that state and its reason.
 */
const debug=debuglog('echo-prime');
export type JobState='running'|'submitted'|'returned'|'blocked'|'uncertain';
export type InvokeOutcome={ok:true;body:Json}|{ok:false;refused:boolean;detail:string};
export interface JobDescribe {kind:InvokeKind;provider:string;label:string;callKind?:string}
export interface MediaJobDeps {
 invoke(capability:string,params:Json,idempotencyKey:string,reason:string,timeoutMs:number):Promise<InvokeOutcome>;
 describe(capability:string):JobDescribe;
 config:MediaConfig;collector:MediaCollector;outcomes?:MediaOutcomes;uploads?:UploadStore;owner:string;
 now?:()=>number;sleep?:(ms:number)=>Promise<void>;
}
export interface JobMedia {uploadId:string;artifactId?:string;url:string;type:string;kind:string;bytes:number;name:string;width?:number;height?:number;duration?:number}
interface Job {
 requestId:string;capability:string;describe:JobDescribe;arguments:Json;prompt:string;state:JobState;phase:'invoking'|'polling'|'collecting'|'done';
 startedAt:number;deadline:number;updatedAt:number;polls:number;detail?:string;result?:Json;providerJobId?:string;providerStatus?:string;
 followable:boolean;statusCapability?:string;howToCheck?:string;media?:JobMedia;mediaError?:string;noMedia?:boolean;done:Promise<void>;
}
/** Status capabilities for async generators: the job id goes in, a status (queued|running|done|failed) comes out. */
const STATUS_READERS:{match:RegExp;capability:string;params:(jobId:string)=>Json}[]=[
 // echo-media-router /job/status (registry: http json_body, required job_id). Its prober marks it orphaned (POST {} -> 404),
 // which Prime's review would refuse, so the poll goes to the gate directly; the gate does not refuse on registry health.
 {match:/^echo\.media\.(?:image|video)_generate$/,capability:'echo.media.job_status',params:jobId=>({job_id:jobId})},
];
const PENDING=new Set(['queued','pending','running','in_progress','processing','submitted','starting','started']);
const DONE=new Set(['done','completed','succeeded','success','finished','ok']);
const FAILED=new Set(['failed','error','cancelled','canceled','expired','rejected']);
const MEDIA_KINDS=new Set<InvokeKind>(['image','image-edit','video','music','sfx','voice']);
const ARTIFACT_KIND:Record<InvokeKind,ArtifactKind>={image:'image','image-edit':'image',video:'video',music:'music',sfx:'sound',voice:'voice',other:'other'};
const REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
function promptOf(args:Json):string{
 const options=obj(args.options);
 for(const v of [args.prompt,args.text,options.prompt,options.text])if(typeof v==='string'&&v.trim())return v.trim();
 return '';
}
function providerJobOf(body:Json):string|undefined{
 const status=String(body.status??'').toLowerCase();
 const id=typeof body.job_id==='string'?body.job_id:typeof body.id==='string'&&PENDING.has(status)?body.id:undefined;
 if(!id||!/^[A-Za-z0-9_.:-]{1,200}$/.test(id))return undefined;
 return DONE.has(status)||FAILED.has(status)?undefined:id;
}
/** The provider answer as the browser sees it: long base64 values replaced by their length (the file is in the store). */
function compact(value:unknown,depth=0):unknown{
 if(typeof value==='string')return value.length>2048&&/^(?:data:[^,]{1,80},)?[A-Za-z0-9+/_=\s-]+$/.test(value.slice(0,4096))?'['+value.length+' characters of base64; the file itself is stored when Prime could read it]':value;
 if(depth>8||!value||typeof value!=='object')return value;
 if(Array.isArray(value))return value.slice(0,50).map(v=>compact(v,depth+1));
 return Object.fromEntries(Object.entries(value as Json).slice(0,200).map(([k,v])=>[k,compact(v,depth+1)]));
}
const seconds=(ms:number)=>Math.round(ms/1000);
export class MediaJobs {
 private jobs=new Map<string,Job>();private now:()=>number;private sleep:(ms:number)=>Promise<void>;
 constructor(private deps:MediaJobDeps){this.now=deps.now??Date.now;this.sleep=deps.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));}
 /** Starts the reviewed request and answers after it finishes or after `inlineMs`, whichever comes first. */
 async execute(requestId:string,capability:string,args:Json):Promise<Json>{
  const describe=this.deps.describe(capability),started=this.now();
  const job:Job={requestId,capability,describe,arguments:args,prompt:promptOf(args),state:'running',phase:'invoking',startedAt:started,deadline:started+this.deps.config.invokeTimeoutsMs[describe.kind],updatedAt:started,polls:0,followable:true,done:Promise.resolve()};
  this.remember(job);
  job.done=this.run(job).catch(error=>{this.finish(job,'uncertain','Prime lost track of this request ('+(error instanceof Error?redact(error.message).slice(0,200):'internal error')+'); the outcome is unknown. Check request ID '+requestId+' before retrying.');});
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([job.done,new Promise<void>(resolve=>{timer=setTimeout(resolve,this.deps.config.inlineMs);})]);
  clearTimeout(timer);
  return this.view(job);
 }
 /** The current state of a request this Prime started; unknown ids answer undefined (the route says 404). */
 status(requestId:string):Json|undefined{
  if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))return undefined;
  const job=this.jobs.get(requestId);return job?this.view(job):undefined;
 }
 /** Test and shutdown hook: resolves when the job has reached its final state. */
 settled(requestId:string){return this.jobs.get(requestId)?.done??Promise.resolve();}
 private remember(job:Job){
  this.jobs.set(job.requestId,job);
  if(this.jobs.size<=200)return;
  for(const [id,j] of this.jobs){if(this.jobs.size<=200)break;if(j.state!=='running')this.jobs.delete(id);}
 }
 private finish(job:Job,state:JobState,detail?:string){
  job.state=state;job.phase='done';job.updatedAt=this.now();if(detail)job.detail=detail;
  // The file (if any) is stored by now: keep only the compact answer, so 200 remembered jobs never hold base64 bodies.
  if(job.result)job.result=compact(job.result) as Json;
  const failedBody=state==='returned'&&typeof job.result?.error==='string'&&!job.media;
  // A media tool that answered with no file, inline data or link did not deliver; a file Prime itself could not read
  // (allowlist, uploads off) is Prime's configuration, not the tool's failure.
  const noFile=state==='returned'&&job.noMedia===true;
  this.deps.outcomes?.record({cap:job.capability,provider:job.describe.provider,state:failedBody||noFile?'blocked':state,detail:failedBody?String(job.result!.error):noFile?job.mediaError??'answered without a media file':job.detail??'',callKind:job.describe.callKind});
  debug('%j',{event:'prime_media_job_finished',requestId:job.requestId,capability:job.capability,state,polls:job.polls,media:!!job.media,mediaError:!!job.mediaError,durationMs:this.now()-job.startedAt});
 }
 private async run(job:Job){
  const {label}=job.describe,limit=this.deps.config.invokeTimeoutsMs[job.describe.kind];
  const out=await this.deps.invoke(job.capability,job.arguments,job.requestId,'Explicitly reviewed ECHO Prime request',limit);
  if(!out.ok){
   if(out.refused)this.finish(job,'blocked',out.detail);
   else this.finish(job,'uncertain',label+' did not answer within '+seconds(limit)+' s or the connection dropped ('+out.detail+'). The outcome is unknown and nothing was retried: check request ID '+job.requestId+' in the gate execution log before submitting again.');
   return;
  }
  job.result=out.body;job.updatedAt=this.now();
  const providerJob=providerJobOf(out.body);
  if(providerJob){
   job.providerJobId=providerJob;job.providerStatus=String(out.body.status??'submitted').toLowerCase();
   const reader=STATUS_READERS.find(r=>r.match.test(job.capability));
   if(!reader){
    job.followable=false;
    job.howToCheck=label+' accepted the job ('+providerJob+') but no status capability is registered for '+job.capability+', so Prime cannot follow it. Check it with the provider (job '+providerJob+') or in the gate execution log (request ID '+job.requestId+') before submitting again; provider charges may already apply.';
    this.finish(job,'submitted',job.howToCheck);return;
   }
   job.statusCapability=reader.capability;job.phase='polling';job.deadline=job.startedAt+this.deps.config.jobWallMs;
   await this.poll(job,reader);return;
  }
  await this.collect(job,out.body);
  this.finish(job,'returned');
 }
 private async poll(job:Job,reader:(typeof STATUS_READERS)[number]){
  let wait=2000,misses=0;
  while(this.now()<job.deadline){
   await this.sleep(Math.min(wait,Math.max(0,job.deadline-this.now())));wait=Math.min(20000,Math.round(wait*1.6));
   job.polls++;
   const st=await this.deps.invoke(reader.capability,reader.params(job.providerJobId!),job.requestId+':status:'+job.polls,'Status read for the reviewed ECHO Prime request '+job.requestId,30000);
   job.updatedAt=this.now();
   if(!st.ok){
    misses++;job.providerStatus='status read failed: '+st.detail.slice(0,160);
    if(misses>=5){this.finish(job,'uncertain','Five status reads in a row failed ('+st.detail.slice(0,200)+'). The job may still be running: read '+reader.capability+' with job_id '+job.providerJobId+' (request ID '+job.requestId+') before submitting again.');return;}
    continue;
   }
   misses=0;
   const status=String(st.body.status??'').toLowerCase();job.providerStatus=status||'unknown';job.result=st.body;
   if(DONE.has(status)){await this.collect(job,st.body);this.finish(job,'returned');return;}
   if(FAILED.has(status)){this.finish(job,'blocked',job.describe.label+' reported the job '+status+(typeof st.body.error==='string'?': '+redact(st.body.error).slice(0,300):'')+'. Nothing was retried.');return;}
  }
  this.finish(job,'uncertain',job.describe.label+' was still '+(job.providerStatus||'running')+' after '+Math.round(this.deps.config.jobWallMs/60000)+' min, so Prime stopped following it. It may still finish: read '+reader.capability+' with job_id '+job.providerJobId+' (request ID '+job.requestId+') before submitting again.');
 }
 private async collect(job:Job,body:Json){
  job.phase='collecting';
  const media=MEDIA_KINDS.has(job.describe.kind);
  if(!this.deps.uploads){if(findMedia(body).length)job.mediaError='The provider answered with a file, but uploads are off on this Prime (add an `uploads` section to the config), so it cannot be stored or shown.';return;}
  try{
   const file=await this.deps.collector.collect(job.capability,body);
   if(!file){if(media){job.noMedia=true;job.mediaError=job.describe.label+' answered without a media file, inline data or link Prime recognises; its answer is shown below.';}return;}
   const short=job.capability.replace(/^echo\./,'').replace(/[^A-Za-z0-9.-]+/g,'-').slice(0,60);
   const meta=await this.deps.uploads.ingest(this.deps.owner,{name:short+'-'+job.requestId.slice(0,8)+'.'+TYPE_EXT[file.type],type:file.type,data:file.data,tags:['studio',job.describe.kind]});
   job.media={uploadId:meta.id,url:'/api/prime/uploads/'+meta.id+'/file',type:meta.type,kind:meta.kind,bytes:meta.bytes,name:meta.name,...(meta.width?{width:meta.width}:{}),...(meta.height?{height:meta.height}:{}),...(meta.duration?{duration:meta.duration}:{})};
   const title=(job.describe.label+': '+(job.prompt||'generation')).slice(0,200);
   const model=typeof body.model==='string'?body.model:typeof obj(job.arguments).model==='string'?String(obj(job.arguments).model):undefined;
   const artifact=await this.deps.uploads.registerArtifact(this.deps.owner,{title,kind:ARTIFACT_KIND[job.describe.kind],upload_id:meta.id,summary:'Made with '+job.describe.label+' ('+job.capability+') from the Creative Studio.',tags:['studio',job.describe.kind],
    provenance:{source:'studio',capability:job.capability,...(job.prompt?{prompt:job.prompt}:{}),...(model?{model}:{}),run_id:job.providerJobId??job.requestId}});
   job.media.artifactId=artifact.id;
  }catch(error){job.mediaError=error instanceof Error?redact(error.message).slice(0,400):'The media file could not be stored.';}
 }
 private view(job:Job):Json{
  const now=this.now();
  return {state:job.state,requestId:job.requestId,capability:job.capability,kind:job.describe.kind,untrusted:true,
   ...(job.detail?{detail:job.detail}:{}),
   ...(job.result?{result:JSON.parse(redact(JSON.stringify(compact(job.result))))}:{}),
   job:{phase:job.phase,label:job.describe.label,provider:job.describe.provider,startedAt:new Date(job.startedAt).toISOString(),deadline:new Date(job.deadline).toISOString(),elapsedMs:(job.phase==='done'?job.updatedAt:now)-job.startedAt,followable:job.followable,polls:job.polls,
    ...(job.providerJobId?{providerJobId:job.providerJobId}:{}),...(job.providerStatus?{providerStatus:job.providerStatus}:{}),...(job.statusCapability?{statusCapability:job.statusCapability}:{}),...(job.howToCheck?{howToCheck:job.howToCheck}:{})},
   ...(job.media?{media:{...job.media}}:{}),...(job.mediaError?{mediaError:job.mediaError}:{})};
 }
}
