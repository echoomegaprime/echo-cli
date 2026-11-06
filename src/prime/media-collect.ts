import {createReadStream,statSync,accessSync,constants as fsConstants} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {extname,isAbsolute,join,parse as parsePath,resolve,sep} from 'node:path';
import {redact} from '../code/workspace.js';
/**
 * Turns a generator's answer into a media file Prime can serve. Providers answer in four shapes: inline base64 (ElevenLabs
 * `audio_base64`, Together `b64_json`, Gemini `inlineData`, Imagen `bytesBase64Encoded`, data URLs such as OpenRouter's
 * `message.images[].image_url.url`), a path on this host (the on-prem media router's `path` under /home/forge/echo-media/out,
 * ElevenLabs `saved_to`), a URL relative to the internal service that made it (Cartesia `/cartesia/audio/<f>.mp3` on
 * 127.0.0.1:8302), or a provider URL (Together `outputs.video_url`). The browser can open none of the last three (loopback
 * only, or blocked by Prime's `img-src/media-src 'self'` policy), so Prime reads them server-side under a strict allowlist
 * (configured local roots, internal origins mapped per capability prefix, named HTTPS hosts), with a size cap and a type
 * check, and streams the bytes into the uploads store. Nothing here follows a link the allowlist does not name.
 */
export const MEDIA_TYPES=['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/wav'] as const;
export type MediaType=(typeof MEDIA_TYPES)[number];
const TYPE_ALIAS:Record<string,MediaType>={'audio/mp3':'audio/mpeg','audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/vnd.wave':'audio/wav','image/jpg':'image/jpeg'};
const EXT_TYPE:Record<string,MediaType>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mp3':'audio/mpeg','.wav':'audio/wav'};
export const TYPE_EXT:Record<MediaType,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/mpeg':'mp3','audio/wav':'wav'};
export type InvokeKind='image'|'image-edit'|'video'|'music'|'sfx'|'voice'|'other';
export interface MediaConfig {
 /** `call_kind` values the SDK gate's LLM router is known to execute (llm_router.py `_call_once`, read 2026-11-06). A media
  * call kind missing here ranks lower as untested; it is excluded only when listed in `denyCallKinds` or after the gate
  * answered "unsupported call_kind" for it. */
 gateCallKinds:string[];
 /** Call kinds never offered (an operator's explicit exclusion). */
 denyCallKinds:string[];
 /** Where executed-tool outcomes persist. Absent = in memory only (commands.ts supplies one beside the session store). */
 outcomesFile?:string;
 /** How long an execute request waits before answering "running" and continuing in the background (the public proxy cuts a request at 100 s). */
 inlineMs:number;
 /** Longest Prime follows an async provider job (video renders, queued on-prem images). */
 jobWallMs:number;
 /** Per-kind limit for the one SDK invoke (the gate call itself). */
 invokeTimeoutsMs:Record<InvokeKind,number>;
 /** Absolute directories on this host Prime may read generated files from (the on-prem media router's out directory). The
  * first one also receives ElevenLabs files (`<first>/elevenlabs/<request id>.mp3`) so long tracks never travel as base64. */
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
/** The internal services generators answer from, as the registry's target_url names them (arcanum_sdk.sdk_capabilities,
 * read 2026-11-06): echo.cartesia.tts -> http://127.0.0.1:8302/cartesia/tts (answers `audio_url` /cartesia/audio/<f>),
 * echo.elevenlabs.tts -> http://127.0.0.1:8282/tts/synthesize (/tts/audio/<f>), echo.voice.* -> http://127.0.0.1:8239
 * (answers `url` on FORGE's own LAN address, same port), echo.media.* -> http://127.0.0.1:8561. The gate's capability
 * detail does not expose target_url, so Prime ships them; a `media.origins` list in the config replaces this table. */
export const DEFAULT_MEDIA_ORIGINS:readonly {prefix:string;origin:string}[]=[
 {prefix:'echo.cartesia.',origin:'http://127.0.0.1:8302'},{prefix:'echo.elevenlabs.tts',origin:'http://127.0.0.1:8282'},
 {prefix:'echo.voice.',origin:'http://127.0.0.1:8239'},{prefix:'echo.media.',origin:'http://127.0.0.1:8561'},
];
/** Generator output directories on FORGE (the on-prem media router's out, echo-integrations' Cartesia audio, echo-comms'
 * ElevenLabs TTS out). Each becomes a default local root only when it exists and Prime can read it. */
export const DEFAULT_LOCAL_ROOTS:readonly string[]=['/home/forge/echo-media/out','/home/forge/echo-integrations/audio','/home/forge/echo-comms/tts_out'];
export function defaultMediaConfig():MediaConfig{
 return {gateCallKinds:[...DEFAULT_GATE_CALL_KINDS],denyCallKinds:[],inlineMs:20000,jobWallMs:900000,invokeTimeoutsMs:{...DEFAULT_INVOKE_TIMEOUTS_MS},localRoots:[],origins:DEFAULT_MEDIA_ORIGINS.map(o=>({...o})),
  // Together's documented output links (docs.together.ai video overview: outputs.video_url on api.together.ai).
  fetchHosts:['api.together.ai','api.together.xyz'],maxBytes:200*1024*1024,fetchTimeoutMs:60000};
}
/** Where ElevenLabs writes the files Prime asks it to save, or nothing when Prime has no local root to read them from. */
export function mediaSaveDir(config:MediaConfig):string|undefined{return config.localRoots[0]?join(config.localRoots[0],'elevenlabs'):undefined;}
const readableDirectory=(dir:string)=>{try{if(!statSync(dir).isDirectory())return false;accessSync(dir,fsConstants.R_OK|fsConstants.X_OK);return true;}catch{return false;}};
/** Host defaults applied at startup: the FORGE output directories that exist become local roots when the config's `media`
 * section names none, and every gap that leaves generated files unreadable is returned as a warning for the startup log. */
export function resolveMediaHost(config:MediaConfig,raw:unknown,readable:(dir:string)=>boolean=readableDirectory):{config:MediaConfig;warnings:string[]}{
 const section=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const next={...config,localRoots:section.localRoots===undefined?DEFAULT_LOCAL_ROOTS.filter(dir=>readable(dir)):config.localRoots};
 const warnings:string[]=[];
 if(!next.localRoots.length)warnings.push('media.localRoots names no readable directory: files a generator writes on this host (the on-prem media router, ElevenLabs saves) cannot be shown, and ElevenLabs music over 25 s is refused at review.');
 if(!next.origins.length)warnings.push('media.origins is empty: links relative to an internal service (Cartesia, ElevenLabs TTS, the voice gateway) cannot be read.');
 return {config:next,warnings};
}
export class MediaConfigError extends Error {}
/** An internal origin: loopback, a private (RFC 1918) or tailnet (100.64/10) address, or a single-label host such as the
 * fleet's `anvil` MinIO. Never a public name: provider hosts go in fetchHosts (HTTPS only). */
const INTERNAL_ORIGIN=/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|[a-z][a-z0-9-]{0,62}):(\d{1,5})$/;
/** An internal IP literal (loopback, RFC 1918, tailnet): a service naming its own address in a link. */
const INTERNAL_IP=/^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})$/;
const HOST=/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CALL_KIND=/^[a-z][a-z0-9_]{1,60}$/;
const bound=(value:unknown,name:string,min:number,max:number)=>{if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new MediaConfigError('media.'+name+' must be an integer from '+min+' to '+max);return value;};
const callKinds=(value:unknown,name:string)=>{
 if(!Array.isArray(value)||value.length>40||value.some(k=>typeof k!=='string'||!CALL_KIND.test(k)))throw new MediaConfigError('media.'+name+' must list call kinds such as openai_compat');
 return [...new Set(value as string[])];
};
/** The reviewed `media` section of the Prime config. Every field is optional; unknown fields are refused. */
export function parseMediaConfig(value:unknown):MediaConfig{
 const config=defaultMediaConfig();
 if(value===undefined)return config;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new MediaConfigError('media must be an object');
 const v=value as Record<string,unknown>;
 for(const key of Object.keys(v))if(!['gateCallKinds','denyCallKinds','outcomesFile','inlineMs','jobWallMs','invokeTimeoutsMs','localRoots','origins','fetchHosts','maxBytes','fetchTimeoutMs'].includes(key))throw new MediaConfigError('Unknown media setting: '+key);
 if(v.gateCallKinds!==undefined)config.gateCallKinds=callKinds(v.gateCallKinds,'gateCallKinds');
 if(v.denyCallKinds!==undefined)config.denyCallKinds=callKinds(v.denyCallKinds,'denyCallKinds');
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
// bytesBase64Encoded: Vertex Imagen predict (predictions[].bytesBase64Encoded + mimeType).
const B64_KEYS=['b64_json','b64','image_b64','audio_base64','audio_b64','video_b64','video_base64','base64','content_base64','bytesBase64Encoded'];
// Gemini / Vertex generateContent parts carry a Blob: inlineData {mimeType, data}. `data` alone is too generic to read.
const BLOB_KEYS=['inlineData','inline_data'];
const URL_KEYS=['video_url','audio_url','image_url','output_url','file_url','download_url','url','uri'];
const URL_LIST_KEYS=['image_urls','video_urls','audio_urls','urls'];
const PATH_KEYS=['path','saved_to','output_path','file_path','file'];
const TYPE_KEYS=['content_type','mime_type','mimeType','mime','media_type','format','ext'];
const DATA_URL=/^data:([a-z0-9.+/-]{1,80})(?:;[a-z0-9.=-]{1,60})*;base64,/i;
const normalizeType=(raw:unknown):MediaType|undefined=>{
 if(typeof raw!=='string')return undefined;
 const t=raw.split(';')[0].trim().toLowerCase();
 if((MEDIA_TYPES as readonly string[]).includes(t))return t as MediaType;
 if(TYPE_ALIAS[t])return TYPE_ALIAS[t];
 return EXT_TYPE['.'+t.replace(/^\./,'')];
};
/** The media sources in a provider answer, best first: inline bytes, a local path, then a link. Bounded walk (depth 8, the
 * first 4 items of any list; OpenRouter nests its data URL at choices[0].message.images[0].image_url.url); string values
 * only, so nothing is executed or followed here. A data URL is inline bytes of any length (the collector bounds it by the
 * media limit); a link longer than 4096 characters is ignored. */
export function findMedia(result:unknown):MediaSource[]{
 const inline:MediaSource[]=[],paths:MediaSource[]=[],links:MediaSource[]=[];
 const walk=(value:unknown,depth:number)=>{
  if(depth>8||!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value.slice(0,4))walk(item,depth+1);return;}
  const o=value as Record<string,unknown>;
  const hint=TYPE_KEYS.map(k=>normalizeType(o[k])).find(Boolean);
  for(const key of B64_KEYS){const v=o[key];if(typeof v==='string'&&v.length>=16)inline.push({kind:'base64',data:v,type:hint,key});}
  for(const key of BLOB_KEYS){
   const b=o[key];if(!b||typeof b!=='object'||Array.isArray(b))continue;
   const blob=b as Record<string,unknown>,type=normalizeType(blob.mimeType??blob.mime_type);
   if(type&&typeof blob.data==='string'&&blob.data.length>=16)inline.push({kind:'base64',data:blob.data,type,key});
  }
  for(const key of URL_KEYS){
   const v=o[key];if(typeof v!=='string'||!v)continue;
   if(v.startsWith('data:')){const m=DATA_URL.exec(v.slice(0,200));if(m)inline.push({kind:'base64',data:v.slice(m[0].length),type:normalizeType(m[1])??hint,key});continue;}
   if(v.length>4096)continue;
   if(/^https?:\/\//i.test(v)||v.startsWith('/'))links.push({kind:'url',url:v,type:hint,key});
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
/** A media file being read: its sniffed type and its bytes as chunks (at most 1 MiB each), bounded by the media limit. */
export interface MediaStream {type:MediaType;source:MediaSource['kind'];from:string;chunks:AsyncIterable<Buffer>}
export class MediaCollectError extends Error {}
const within=(root:string,full:string)=>full===root||full.startsWith(root.endsWith(sep)?root:root+sep);
const CHUNK=1024*1024;
interface Opened {declared?:MediaType;from:string;source:MediaSource['kind'];next:()=>Promise<Buffer|undefined>;close:()=>Promise<void>}
export interface CollectorOptions {config:MediaConfig;fetch?:typeof fetch;maxBytes?:number}
/** Reads the first usable media source of an answer, or says exactly why none could be read. */
export class MediaCollector {
 private fetchImpl:typeof fetch;
 constructor(private options:CollectorOptions){this.fetchImpl=options.fetch??fetch;}
 private get limit(){return Math.min(this.options.config.maxBytes,this.options.maxBytes??Infinity);}
 /** Streams the first readable source into `store` (the uploads store), so a 200 MiB video is never held in memory whole.
  * A source that fails (refused, wrong type, over the limit, or refused by the store) is reported and the next is tried. */
 async collectInto<T>(capability:string,result:unknown,store:(file:MediaStream)=>Promise<T>,signal?:AbortSignal):Promise<{value:T;type:MediaType;source:MediaSource['kind'];from:string}|null>{
  const sources=findMedia(result);
  if(!sources.length)return null;
  const refusals:string[]=[];
  for(const source of sources.slice(0,6)){
   let opened:Opened|undefined;
   try{
    opened=await this.open(capability,source,signal);
    const file=await this.typed(opened);
    return {value:await store(file),type:file.type,source:file.source,from:file.from};
   }catch(error){if(signal?.aborted)throw error;refusals.push(source.key+': '+(error instanceof Error?redact(error.message).slice(0,200):'unreadable'));}
   finally{await opened?.close().catch(()=>{});}
  }
  throw new MediaCollectError('The provider answered with media Prime could not read: '+refusals.join('; '));
 }
 /** The same, held in memory (tests and small callers). */
 async collect(capability:string,result:unknown,signal?:AbortSignal):Promise<CollectedFile|null>{
  const got=await this.collectInto(capability,result,async file=>{const parts:Buffer[]=[];for await(const c of file.chunks)parts.push(c);return Buffer.concat(parts);},signal);
  return got?{data:got.value,type:got.type,source:got.source,from:got.from}:null;
 }
 /** Sniffs the first bytes, refuses a type that is not media or contradicts the declared one, then hands the rest on as
  * chunks, refusing as soon as the running size passes the limit. */
 private async typed(opened:Opened):Promise<MediaStream>{
  const limit=this.limit;let head=Buffer.alloc(0),size=0,ended=false;
  const pending:Buffer[]=[];
  while(head.length<64){const c=await opened.next();if(!c){ended=true;break;}size+=c.length;if(size>limit)throw new MediaCollectError('the file is larger than the '+Math.round(limit/1048576)+' MiB media limit');pending.push(c);head=Buffer.concat([head,c.subarray(0,64)]);}
  if(!size)throw new MediaCollectError('the file is empty');
  const sniffed=sniffType(head.subarray(0,64));
  if(!sniffed)throw new MediaCollectError('the bytes are not an image, video or audio type Prime stores');
  // The bytes decide; a declared type that names another medium is refused rather than relabelled.
  if(opened.declared&&opened.declared.split('/')[0]!==sniffed.split('/')[0])throw new MediaCollectError('the file says '+opened.declared+' but its bytes are '+sniffed);
  async function* chunks(){
   for(const c of pending)for(let off=0;off<c.length;off+=CHUNK)yield c.subarray(off,off+CHUNK);
   if(ended)return;
   for(;;){
    const c=await opened.next();if(!c)return;
    size+=c.length;if(size>limit)throw new MediaCollectError('the file is larger than the '+Math.round(limit/1048576)+' MiB media limit');
    for(let off=0;off<c.length;off+=CHUNK)yield c.subarray(off,off+CHUNK);
   }
  }
  return {type:sniffed,source:opened.source,from:opened.from,chunks:chunks()};
 }
 private async open(capability:string,source:MediaSource,signal?:AbortSignal):Promise<Opened>{
  if(source.kind==='base64'){
   const clean=source.data.replace(/\s+/g,'');
   if(!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean))throw new MediaCollectError('inline data is not base64');
   if(clean.length*0.75>this.limit)throw new MediaCollectError('inline data is larger than the media limit');
   let data:Buffer|undefined=Buffer.from(clean,'base64');
   return {declared:normalizeType(source.type),from:source.key,source:'base64',next:async()=>{const d=data;data=undefined;return d;},close:async()=>{data=undefined;}};
  }
  if(source.kind==='path')return this.openLocal(source);
  return this.openUrl(capability,source,signal);
 }
 private async openLocal(source:Extract<MediaSource,{kind:'path'}>):Promise<Opened>{
  const roots=this.options.config.localRoots;
  if(!roots.length)throw new MediaCollectError('the result is a file on this host ('+source.path.slice(0,160)+') and media.localRoots names no directory Prime may read');
  let full:string;
  try{full=await realpath(source.path);}catch{throw new MediaCollectError('the file '+source.path.slice(0,160)+' does not exist on this host');}
  const realRoots=await Promise.all(roots.map(r=>realpath(r).catch(()=>r)));
  if(!realRoots.some(root=>within(root,full)))throw new MediaCollectError('the file '+source.path.slice(0,160)+' is outside media.localRoots');
  const info=await stat(full);
  if(!info.isFile())throw new MediaCollectError('the path is not a regular file');
  if(info.size>this.limit)throw new MediaCollectError('the file is larger than the media limit');
  const stream=createReadStream(full,{highWaterMark:CHUNK}),it=stream[Symbol.asyncIterator]();
  return {declared:normalizeType(source.type),from:source.key,source:'path',next:async()=>{const r=await it.next();return r.done?undefined:r.value as Buffer;},close:async()=>{stream.destroy();}};
 }
 /** Allowed: a relative URL resolved against the internal origin mapped to the capability prefix, a URL on such an origin, a
  * URL on another internal address with the mapped origin's scheme and port (a service naming its own LAN address; it is read
  * from the mapped origin, never from the named host), or HTTPS on a named host. Redirects are followed by hand (at most
  * 3), each hop checked the same way. */
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
  if(mapped&&url.port){
   const home=new URL(mapped.origin);
   if(url.protocol===home.protocol&&url.port===home.port&&INTERNAL_IP.test(url.hostname))return new URL(url.pathname+url.search,mapped.origin);
  }
  if(url.protocol==='http:')throw new MediaCollectError('the result link '+url.origin+' is not an internal origin named in media.origins');
  if(url.protocol!=='https:')throw new MediaCollectError('the result link scheme '+url.protocol+' is refused');
  const host=url.hostname.toLowerCase();
  if(!config.fetchHosts.some(h=>h.startsWith('*.')?host.endsWith(h.slice(1)):host===h))throw new MediaCollectError('the result host '+host+' is not in media.fetchHosts');
  return url;
 }
 private async openUrl(capability:string,source:Extract<MediaSource,{kind:'url'}>,signal?:AbortSignal):Promise<Opened>{
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
   if(!declared&&rawType&&rawType!=='application/octet-stream'&&rawType!=='binary/octet-stream'){await response.body?.cancel().catch(()=>{});throw new MediaCollectError('the result link answered '+rawType.slice(0,60)+', not an image, video or audio file');}
   const length=Number(response.headers.get('content-length'));
   if(Number.isFinite(length)&&length>this.limit){await response.body?.cancel().catch(()=>{});throw new MediaCollectError('the result file is larger than the media limit');}
   const reader=response.body?.getReader();if(!reader)throw new MediaCollectError('the result link answered no body');
   return {declared:declared??normalizeType(source.type)??EXT_TYPE[extname(url.pathname).toLowerCase()],from:url.origin+url.pathname.slice(0,80),source:'url',
    next:async()=>{const {done,value}=await reader.read();return done?undefined:Buffer.from(value.buffer,value.byteOffset,value.byteLength);},close:async()=>{await reader.cancel().catch(()=>{});}};
  }
 }
}
