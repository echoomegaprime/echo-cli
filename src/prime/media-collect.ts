import {open,realpath,stat} from 'node:fs/promises';
import {extname,isAbsolute,parse as parsePath,resolve,sep} from 'node:path';
import {redact} from '../code/workspace.js';
/**
 * Turns a generator's answer into a media file Prime can serve. Providers answer in four shapes: inline base64 (ElevenLabs
 * `audio_base64`, Together `b64_json`, data URLs), a path on this host (the on-prem media router's `path` under
 * /home/forge/echo-media/out), a URL relative to the internal service that made it (Cartesia `/cartesia/audio/<f>.mp3` on
 * 127.0.0.1:8302), or a provider URL (Together `outputs.video_url`). The browser can open none of the last three (loopback
 * only, or blocked by Prime's `img-src/media-src 'self'` policy), so Prime reads them server-side under a strict allowlist
 * (configured local roots, loopback origins mapped per capability prefix, named HTTPS hosts), with a size cap and a type
 * check, and the caller stores the bytes in the uploads store. Nothing here follows a link the allowlist does not name.
 */
export const MEDIA_TYPES=['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/wav'] as const;
export type MediaType=(typeof MEDIA_TYPES)[number];
const TYPE_ALIAS:Record<string,MediaType>={'audio/mp3':'audio/mpeg','audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/vnd.wave':'audio/wav','image/jpg':'image/jpeg'};
const EXT_TYPE:Record<string,MediaType>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mp3':'audio/mpeg','.wav':'audio/wav'};
export const TYPE_EXT:Record<MediaType,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/mpeg':'mp3','audio/wav':'wav'};
export type InvokeKind='image'|'image-edit'|'video'|'music'|'sfx'|'voice'|'other';
export interface MediaConfig {
 /** `call_kind` values the SDK gate's LLM router executes (llm_router.py `_call_once`, read 2026-11-06). */
 gateCallKinds:string[];
 /** Where executed-tool outcomes persist. Absent = in memory only (commands.ts supplies one beside the session store). */
 outcomesFile?:string;
 /** How long an execute request waits before answering "running" and continuing in the background (the public proxy cuts a request at 100 s). */
 inlineMs:number;
 /** Longest Prime follows an async provider job (video renders, queued on-prem images). */
 jobWallMs:number;
 /** Per-kind limit for the one SDK invoke (the gate call itself). */
 invokeTimeoutsMs:Record<InvokeKind,number>;
 /** Absolute directories on this host Prime may read generated files from (the on-prem media router's out directory). */
 localRoots:string[];
 /** Capability id prefix -> internal origin (loopback, private or tailnet address, single-label host) that a relative
  * result URL is resolved against; an absolute result URL on any of these origins may also be read. */
 origins:{prefix:string;origin:string}[];
 /** HTTPS hosts a provider result URL (and each redirect) may be fetched from. */
 fetchHosts:string[];
 maxBytes:number;fetchTimeoutMs:number;
}
export const DEFAULT_GATE_CALL_KINDS=['openai_compat','dedicated_endpoint','together_audio_transcription','anthropic_api','vertex_generate','anthropic_cli','grok_cli'];
export const DEFAULT_INVOKE_TIMEOUTS_MS:Record<InvokeKind,number>={image:180000,'image-edit':180000,video:300000,music:300000,sfx:120000,voice:90000,other:20000};
export function defaultMediaConfig():MediaConfig{
 return {gateCallKinds:[...DEFAULT_GATE_CALL_KINDS],inlineMs:20000,jobWallMs:900000,invokeTimeoutsMs:{...DEFAULT_INVOKE_TIMEOUTS_MS},localRoots:[],origins:[],
  // Together's documented output links (docs.together.ai video overview: outputs.video_url on api.together.ai).
  fetchHosts:['api.together.ai','api.together.xyz'],maxBytes:200*1024*1024,fetchTimeoutMs:60000};
}
export class MediaConfigError extends Error {}
/** An internal origin: loopback, a private (RFC 1918) or tailnet (100.64/10) address, or a single-label host such as the
 * fleet's `anvil` MinIO. Never a public name: provider hosts go in fetchHosts (HTTPS only). */
const INTERNAL_ORIGIN=/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|[a-z][a-z0-9-]{0,62}):(\d{1,5})$/;
const HOST=/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const bound=(value:unknown,name:string,min:number,max:number)=>{if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new MediaConfigError('media.'+name+' must be an integer from '+min+' to '+max);return value;};
/** The reviewed `media` section of the Prime config. Every field is optional; unknown fields are refused. */
export function parseMediaConfig(value:unknown):MediaConfig{
 const config=defaultMediaConfig();
 if(value===undefined)return config;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new MediaConfigError('media must be an object');
 const v=value as Record<string,unknown>;
 for(const key of Object.keys(v))if(!['gateCallKinds','outcomesFile','inlineMs','jobWallMs','invokeTimeoutsMs','localRoots','origins','fetchHosts','maxBytes','fetchTimeoutMs'].includes(key))throw new MediaConfigError('Unknown media setting: '+key);
 if(v.gateCallKinds!==undefined){
  if(!Array.isArray(v.gateCallKinds)||v.gateCallKinds.length>40||v.gateCallKinds.some(k=>typeof k!=='string'||!/^[a-z][a-z0-9_]{1,60}$/.test(k)))throw new MediaConfigError('media.gateCallKinds must list call kinds such as openai_compat');
  config.gateCallKinds=[...new Set(v.gateCallKinds as string[])];
 }
 if(v.outcomesFile!==undefined){if(typeof v.outcomesFile!=='string'||!isAbsolute(v.outcomesFile)||[...v.outcomesFile].some(c=>c.charCodeAt(0)<32))throw new MediaConfigError('media.outcomesFile must be an absolute path');config.outcomesFile=v.outcomesFile;}
 if(v.inlineMs!==undefined)config.inlineMs=bound(v.inlineMs,'inlineMs',1000,90000);
 if(v.jobWallMs!==undefined)config.jobWallMs=bound(v.jobWallMs,'jobWallMs',10000,7200000);
 if(v.maxBytes!==undefined)config.maxBytes=bound(v.maxBytes,'maxBytes',1024,2*1024*1024*1024);
 if(v.fetchTimeoutMs!==undefined)config.fetchTimeoutMs=bound(v.fetchTimeoutMs,'fetchTimeoutMs',1000,600000);
 if(v.invokeTimeoutsMs!==undefined){
  if(!v.invokeTimeoutsMs||typeof v.invokeTimeoutsMs!=='object'||Array.isArray(v.invokeTimeoutsMs))throw new MediaConfigError('media.invokeTimeoutsMs must be an object');
  for(const [kind,ms] of Object.entries(v.invokeTimeoutsMs as Record<string,unknown>)){
   if(!(kind in DEFAULT_INVOKE_TIMEOUTS_MS))throw new MediaConfigError('Unknown media.invokeTimeoutsMs kind: '+kind);
   config.invokeTimeoutsMs[kind as InvokeKind]=bound(ms,'invokeTimeoutsMs.'+kind,1000,900000);
  }
 }
 if(v.localRoots!==undefined){
  if(!Array.isArray(v.localRoots)||v.localRoots.length>8)throw new MediaConfigError('media.localRoots must list at most 8 directories');
  config.localRoots=(v.localRoots as unknown[]).map(root=>{
   if(typeof root!=='string'||!isAbsolute(root)||[...root].some(c=>c.charCodeAt(0)<32))throw new MediaConfigError('media.localRoots entries must be absolute directories');
   const full=resolve(root);if(full===parsePath(full).root)throw new MediaConfigError('media.localRoots cannot be a filesystem root');
   return full;
  });
 }
 if(v.origins!==undefined){
  if(!Array.isArray(v.origins)||v.origins.length>32)throw new MediaConfigError('media.origins must list at most 32 entries');
  config.origins=(v.origins as unknown[]).map(row=>{
   const r=row&&typeof row==='object'&&!Array.isArray(row)?row as Record<string,unknown>:{};
   if(typeof r.prefix!=='string'||!/^echo\.[A-Za-z0-9_.-]{1,120}$/.test(r.prefix))throw new MediaConfigError('media.origins[].prefix must be a capability id prefix such as echo.cartesia.');
   if(typeof r.origin!=='string'||!INTERNAL_ORIGIN.test(r.origin)||Number(INTERNAL_ORIGIN.exec(r.origin)![1])>65535)throw new MediaConfigError('media.origins[].origin must be an internal origin with a port, such as http://127.0.0.1:8302 or http://anvil:9000');
   return {prefix:r.prefix,origin:r.origin};
  });
 }
 if(v.fetchHosts!==undefined){
  if(!Array.isArray(v.fetchHosts)||v.fetchHosts.length>32||v.fetchHosts.some(h=>typeof h!=='string'||!HOST.test(h.toLowerCase())))throw new MediaConfigError('media.fetchHosts must list host names such as api.together.ai');
  config.fetchHosts=(v.fetchHosts as string[]).map(h=>h.toLowerCase());
 }
 return config;
}
export type MediaSource={kind:'base64';data:string;type?:string;key:string}|{kind:'path';path:string;type?:string;key:string}|{kind:'url';url:string;type?:string;key:string};
const B64_KEYS=['b64_json','b64','image_b64','audio_base64','audio_b64','video_b64','video_base64','base64','content_base64'];
const URL_KEYS=['video_url','audio_url','image_url','output_url','file_url','download_url','url','uri'];
const URL_LIST_KEYS=['image_urls','video_urls','audio_urls','urls'];
const PATH_KEYS=['path','saved_to','output_path','file_path','file'];
const TYPE_KEYS=['content_type','mime_type','mime','media_type','format','ext'];
const normalizeType=(raw:unknown):MediaType|undefined=>{
 if(typeof raw!=='string')return undefined;
 const t=raw.split(';')[0].trim().toLowerCase();
 if((MEDIA_TYPES as readonly string[]).includes(t))return t as MediaType;
 if(TYPE_ALIAS[t])return TYPE_ALIAS[t];
 return EXT_TYPE['.'+t.replace(/^\./,'')];
};
/** The media sources in a provider answer, best first: inline bytes, a local path, then a link. Bounded walk (depth 5,
 * the first 4 items of any list); string values only, so nothing is executed or followed here. */
export function findMedia(result:unknown):MediaSource[]{
 const inline:MediaSource[]=[],paths:MediaSource[]=[],links:MediaSource[]=[];
 const walk=(value:unknown,depth:number)=>{
  if(depth>5||!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value.slice(0,4))walk(item,depth+1);return;}
  const o=value as Record<string,unknown>;
  const hint=TYPE_KEYS.map(k=>normalizeType(o[k])).find(Boolean);
  for(const key of B64_KEYS){const v=o[key];if(typeof v==='string'&&v.length>=16)inline.push({kind:'base64',data:v,type:hint,key});}
  for(const key of URL_KEYS){
   const v=o[key];if(typeof v!=='string'||!v||v.length>4096)continue;
   const data=/^data:([a-z0-9.+/-]+);base64,(.+)$/is.exec(v);
   if(data)inline.push({kind:'base64',data:data[2],type:normalizeType(data[1])??hint,key});
   else if(/^https?:\/\//i.test(v)||v.startsWith('/'))links.push({kind:'url',url:v,type:hint,key});
  }
  for(const key of URL_LIST_KEYS){const v=o[key];if(Array.isArray(v))for(const u of v.slice(0,4))if(typeof u==='string'&&u.length<=4096&&(/^https?:\/\//i.test(u)||u.startsWith('/')))links.push({kind:'url',url:u,type:hint,key});}
  for(const key of PATH_KEYS){const v=o[key];if(typeof v==='string'&&isAbsolute(v)&&!v.startsWith('//')&&v.length<=1024&&EXT_TYPE[extname(v).toLowerCase()])paths.push({kind:'path',path:v,type:hint??EXT_TYPE[extname(v).toLowerCase()],key});}
  for(const [key,v] of Object.entries(o))if(v&&typeof v==='object'&&!TYPE_KEYS.includes(key))walk(v,depth+1);
 };
 walk(result,0);
 return [...inline,...paths,...links];
}
/** Sniffs the media type from the first bytes. */
export function sniffType(head:Buffer):MediaType|undefined{
 if(head.length>=8&&head.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
 if(head.length>=3&&head[0]===0xff&&head[1]===0xd8&&head[2]===0xff)return 'image/jpeg';
 if(head.length>=12&&head.subarray(0,4).toString('latin1')==='RIFF'&&head.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
 if(head.length>=12&&head.subarray(0,4).toString('latin1')==='RIFF'&&head.subarray(8,12).toString('latin1')==='WAVE')return 'audio/wav';
 if(head.length>=6&&/^GIF8[79]a$/.test(head.subarray(0,6).toString('latin1')))return 'image/gif';
 if(head.length>=12&&head.subarray(4,8).toString('latin1')==='ftyp')return head.subarray(8,10).toString('latin1')==='qt'?'video/quicktime':'video/mp4';
 if(head.length>=4&&head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'video/webm';
 if(head.length>=3&&(head.subarray(0,3).toString('latin1')==='ID3'||(head[0]===0xff&&(head[1]&0xe0)===0xe0)))return 'audio/mpeg';
 return undefined;
}
export interface CollectedFile {data:Buffer;type:MediaType;source:MediaSource['kind'];from:string}
export class MediaCollectError extends Error {}
const within=(root:string,full:string)=>full===root||full.startsWith(root.endsWith(sep)?root:root+sep);
export interface CollectorOptions {config:MediaConfig;fetch?:typeof fetch;maxBytes?:number}
/** Reads the first usable media source of an answer, or says exactly why none could be read. */
export class MediaCollector {
 private fetchImpl:typeof fetch;
 constructor(private options:CollectorOptions){this.fetchImpl=options.fetch??fetch;}
 private get limit(){return Math.min(this.options.config.maxBytes,this.options.maxBytes??Infinity);}
 async collect(capability:string,result:unknown,signal?:AbortSignal):Promise<CollectedFile|null>{
  const sources=findMedia(result);
  if(!sources.length)return null;
  const refusals:string[]=[];
  for(const source of sources.slice(0,6)){
   try{return await this.read(capability,source,signal);}
   catch(error){if(signal?.aborted)throw error;refusals.push(source.key+': '+(error instanceof Error?redact(error.message).slice(0,200):'unreadable'));}
  }
  throw new MediaCollectError('The provider answered with media Prime could not read: '+refusals.join('; '));
 }
 private typed(data:Buffer,declared:MediaType|undefined,from:string,source:MediaSource['kind']):CollectedFile{
  if(!data.length)throw new MediaCollectError('the file is empty');
  if(data.length>this.limit)throw new MediaCollectError('the file is larger than the '+Math.round(this.limit/1048576)+' MiB media limit');
  const sniffed=sniffType(data.subarray(0,64));
  if(!sniffed)throw new MediaCollectError('the bytes are not an image, video or audio type Prime stores');
  // The bytes decide; a declared type that names another medium is refused rather than relabelled.
  if(declared&&declared.split('/')[0]!==sniffed.split('/')[0])throw new MediaCollectError('the file says '+declared+' but its bytes are '+sniffed);
  return {data,type:sniffed,source,from};
 }
 private async read(capability:string,source:MediaSource,signal?:AbortSignal):Promise<CollectedFile>{
  if(source.kind==='base64'){
   const clean=source.data.replace(/\s+/g,'');
   if(!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean))throw new MediaCollectError('inline data is not base64');
   if(clean.length*0.75>this.limit)throw new MediaCollectError('inline data is larger than the media limit');
   return this.typed(Buffer.from(clean,'base64'),normalizeType(source.type),source.key,'base64');
  }
  if(source.kind==='path')return this.readLocal(source);
  return this.readUrl(capability,source,signal);
 }
 private async readLocal(source:Extract<MediaSource,{kind:'path'}>):Promise<CollectedFile>{
  const roots=this.options.config.localRoots;
  if(!roots.length)throw new MediaCollectError('the result is a file on this host ('+source.path.slice(0,160)+') and media.localRoots names no directory Prime may read');
  let full:string;
  try{full=await realpath(source.path);}catch{throw new MediaCollectError('the file '+source.path.slice(0,160)+' does not exist on this host');}
  const realRoots=await Promise.all(roots.map(r=>realpath(r).catch(()=>r)));
  if(!realRoots.some(root=>within(root,full)))throw new MediaCollectError('the file '+source.path.slice(0,160)+' is outside media.localRoots');
  const info=await stat(full);
  if(!info.isFile())throw new MediaCollectError('the path is not a regular file');
  if(info.size>this.limit)throw new MediaCollectError('the file is larger than the media limit');
  const handle=await open(full,'r');
  try{const data=Buffer.alloc(info.size);let off=0;while(off<info.size){const {bytesRead}=await handle.read(data,off,info.size-off,off);if(!bytesRead)break;off+=bytesRead;}return this.typed(data.subarray(0,off),normalizeType(source.type),source.key,'path');}
  finally{await handle.close();}
 }
 /** Allowed: a relative URL resolved against the loopback origin mapped to the capability prefix, a URL on such an
  * origin, or HTTPS on a named host. Redirects are followed by hand (at most 3), each hop checked the same way. */
 private allowed(capability:string,raw:string):URL{
  const config=this.options.config,mapped=config.origins.filter(o=>capability.startsWith(o.prefix)).sort((a,b)=>b.prefix.length-a.prefix.length)[0];
  if(raw.startsWith('/')&&!raw.startsWith('//')){
   if(!mapped)throw new MediaCollectError('the result link '+raw.slice(0,120)+' is relative to the service that made it, and media.origins maps no origin for '+capability);
   const resolved=new URL(raw,mapped.origin);
   if(resolved.origin!==mapped.origin)throw new MediaCollectError('the result link leaves its mapped origin');
   return resolved;
  }
  let url:URL;try{url=new URL(raw);}catch{throw new MediaCollectError('the result link is not a URL');}
  if(url.username||url.password)throw new MediaCollectError('the result link carries credentials');
  if(config.origins.some(o=>o.origin===url.origin))return url;
  if(url.protocol==='http:')throw new MediaCollectError('the result link '+url.origin+' is not an internal origin named in media.origins');
  if(url.protocol!=='https:')throw new MediaCollectError('the result link scheme '+url.protocol+' is refused');
  const host=url.hostname.toLowerCase();
  if(!config.fetchHosts.some(h=>h.startsWith('*.')?host.endsWith(h.slice(1)):host===h))throw new MediaCollectError('the result host '+host+' is not in media.fetchHosts');
  return url;
 }
 private async readUrl(capability:string,source:Extract<MediaSource,{kind:'url'}>,signal?:AbortSignal):Promise<CollectedFile>{
  let url=this.allowed(capability,source.url);
  const timeout=AbortSignal.timeout(this.options.config.fetchTimeoutMs),both=signal?AbortSignal.any([signal,timeout]):timeout;
  for(let hop=0;;hop++){
   const response=await this.fetchImpl(url,{redirect:'manual',signal:both,headers:{accept:'image/*,video/*,audio/*'}});
   if(response.status>=300&&response.status<400){
    const next=response.headers.get('location');await response.body?.cancel().catch(()=>{});
    if(!next||hop>=3)throw new MediaCollectError('the result link redirects too often');
    url=this.allowed(capability,new URL(next,url).toString());continue;
   }
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw new MediaCollectError('the result link answered HTTP '+response.status);}
   const declared=normalizeType(response.headers.get('content-type'));
   const rawType=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
   if(!declared&&rawType&&rawType!=='application/octet-stream'&&rawType!=='binary/octet-stream')throw new MediaCollectError('the result link answered '+rawType.slice(0,60)+', not an image, video or audio file');
   const length=Number(response.headers.get('content-length'));
   if(Number.isFinite(length)&&length>this.limit){await response.body?.cancel().catch(()=>{});throw new MediaCollectError('the result file is larger than the media limit');}
   const reader=response.body?.getReader();if(!reader)throw new MediaCollectError('the result link answered no body');
   const parts:Buffer[]=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>this.limit)throw new MediaCollectError('the result file is larger than the media limit');parts.push(Buffer.from(value));}}
   finally{await reader.cancel().catch(()=>{});}
   return this.typed(Buffer.concat(parts),declared??normalizeType(source.type)??EXT_TYPE[extname(url.pathname).toLowerCase()],url.origin+url.pathname.slice(0,80),'url');
  }
 }
}
