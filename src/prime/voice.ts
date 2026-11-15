import {debuglog} from 'node:util';
import {validateEndpoint} from '../code/model.js';
import {redact} from '../code/workspace.js';
import {WorkspaceHttpError} from './workspace.js';
export class VoiceError extends WorkspaceHttpError {}
export const VOICE_MAX_AUDIO_BYTES=5*1024*1024;
export const VOICE_TEXT_LIMITS={mp3:4000,wav:1500} as const;
export interface VoiceConfig {gatewayUrl:string;persona:string;label:string;model:'eleven_v4'|'eleven_v4_turbo';format:'mp3'|'wav';timeoutMs:number}
export const DEFAULT_VOICE:VoiceConfig={gatewayUrl:'http://127.0.0.1:8239',persona:'freeman',label:'Echo',model:'eleven_v4',format:'mp3',timeoutMs:60000};
const debug=debuglog('echo-prime'),ARTIFACT=/^[a-f0-9]{32}\.(mp3|wav)$/;
const control=(char:string)=>{const code=char.codePointAt(0)??0;return code<32||(code>=127&&code<=159);};
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function parseVoiceConfig(value:unknown):VoiceConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid voice configuration: voice must be an object');
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(!['gatewayUrl','persona','label','model','format','timeoutMs','provider'].includes(key))throw new Error('Invalid voice configuration: unknown field');
 const gatewayUrl=input.gatewayUrl===undefined?DEFAULT_VOICE.gatewayUrl:input.gatewayUrl;
 if(typeof gatewayUrl!=='string')throw new Error('Invalid voice configuration: gatewayUrl must be a credential-free loopback origin');
 try{validateEndpoint(gatewayUrl);}catch{throw new Error('Invalid voice configuration: gatewayUrl must be a credential-free loopback origin');}
 const persona=input.persona===undefined?DEFAULT_VOICE.persona:input.persona,label=input.label===undefined?DEFAULT_VOICE.label:input.label,model=input.model===undefined?DEFAULT_VOICE.model:input.model,format=input.format===undefined?DEFAULT_VOICE.format:input.format,timeoutMs=input.timeoutMs===undefined?DEFAULT_VOICE.timeoutMs:input.timeoutMs;
 if(typeof persona!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(persona))throw new Error('Invalid voice configuration: persona');
 if(typeof label!=='string'||!label.length||label.length>60||[...label].some(control))throw new Error('Invalid voice configuration: label');
 if(model!=='eleven_v4'&&model!=='eleven_v4_turbo')throw new Error('Invalid voice configuration: model');
 if(format!=='mp3'&&format!=='wav')throw new Error('Invalid voice configuration: format');
 if(!Number.isInteger(timeoutMs)||Number(timeoutMs)<5000||Number(timeoutMs)>120000)throw new Error('Invalid voice configuration: timeoutMs');
 if(input.provider!==undefined&&input.provider!=='elevenlabs')throw new Error('Invalid voice configuration: provider');
 return {gatewayUrl:new URL(gatewayUrl).origin,persona,label,model,format,timeoutMs:Number(timeoutMs)};
}
export function normalizeSpeechText(input:unknown,limit:number):string{
 if(typeof input!=='string')throw new VoiceError(400,'Send text to speak');
 const text=[...redact(input)].map(char=>{const code=char.codePointAt(0)??0;if(code===8203||code===8204||code===8205||code===65279)return '';if((control(char)&&char!=='\n'&&char!=='\t')||code===8232||code===8233)return ' ';return char;}).join('').replace(/\s+/gu,' ').trim();
 if(!text)throw new VoiceError(400,'Nothing to speak after normalisation');
 if(text.length>limit)throw new VoiceError(400,'Text exceeds '+limit+' characters per call; send shorter sections');
 return text;
}
type VoiceStatus={configured:true;available:boolean;persona:string;label:string;provider:'elevenlabs';model:string;format:string;maxChars:number;maxAudioBytes:number;reason?:string};
export class VoiceClient {
 readonly config:VoiceConfig;private origin:URL;private inFlight=0;private health?:{until:number;value:VoiceStatus};
 constructor(config:VoiceConfig=DEFAULT_VOICE,private limits={maxInFlight:3,healthTtlMs:60000,healthTimeoutMs:5000}){this.origin=validateEndpoint(config.gatewayUrl);this.config={...config,gatewayUrl:this.origin.origin};}
 private base():Omit<VoiceStatus,'available'>{return {configured:true,persona:this.config.persona,label:this.config.label,provider:'elevenlabs',model:this.config.model,format:this.config.format,maxChars:VOICE_TEXT_LIMITS[this.config.format],maxAudioBytes:VOICE_MAX_AUDIO_BYTES};}
 async status(signal?:AbortSignal):Promise<VoiceStatus>{
  if(this.health&&this.health.until>Date.now())return this.health.value;
  let value:VoiceStatus;
  try{const response=await fetch(new URL('/health',this.origin),{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(this.limits.healthTimeoutMs),...(signal?[signal]:[])])}),parsed=await this.json(response);
   value=response.ok&&obj(obj(parsed).providers).elevenlabs&&obj(obj(obj(parsed).providers).elevenlabs).up===true?{...this.base(),available:true}:{...this.base(),available:false,reason:'Voice gateway reports ElevenLabs is not available'};
  }catch(e){const timed=e instanceof Error&&e.name==='TimeoutError';value={...this.base(),available:false,reason:timed?'Voice gateway health check timed out':'Voice gateway unreachable at '+this.origin.origin};}
  // A request the browser abandoned says nothing about the gateway: answer it, but never cache that verdict.
  if(!signal?.aborted)this.health={until:Date.now()+this.limits.healthTtlMs,value};return value;
 }
 private async json(response:Response):Promise<unknown>{
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw new VoiceError(502,'Voice gateway response exceeds the 1 MiB limit');chunks.push(value);}}finally{await reader?.cancel().catch(()=>undefined);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return undefined;}
 }
 private mapped(error:unknown,signal:AbortSignal|undefined,ms:number):VoiceError{if(error instanceof VoiceError)return error;if(signal?.aborted)return new VoiceError(499,'Interrupted');if(error instanceof Error&&error.name==='TimeoutError')return new VoiceError(504,'Voice gateway timed out after '+Math.round(ms/1000)+' s; outcome unknown');return new VoiceError(502,'Voice gateway unreachable at '+this.origin.origin);}
 private async synthesis(text:string,signal?:AbortSignal){
  let response:Response;try{response=await fetch(new URL('/speak',this.origin),{method:'POST',redirect:'error',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({text,persona:this.config.persona,provider:'elevenlabs',format:this.config.format,model:this.config.model,provider_opts:{allow_fallback:false,voice_settings:{stability:0.5,similarity_boost:0.75,style:0.6,use_speaker_boost:true}}}),signal:AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs),...(signal?[signal]:[])])});}catch(e){throw this.mapped(e,signal,this.config.timeoutMs);}
  let parsed:unknown;try{parsed=await this.json(response);}catch(e){throw this.mapped(e,signal,this.config.timeoutMs);}const body=obj(parsed);
  if(!response.ok){if(response.status===429)throw new VoiceError(429,'ElevenLabs quota or rate limit reached (voice gateway HTTP 429)');const detail=typeof body.error==='string'?': '+redact(body.error).slice(0,120):'';throw new VoiceError(502,'Voice gateway answered HTTP '+response.status+detail);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new VoiceError(502,'Voice gateway returned an unrecognized response');
  if(body.provider!=='elevenlabs')throw new VoiceError(502,'Voice gateway answered with provider '+String(body.provider).slice(0,40)+', not ElevenLabs; refusing a substitute voice');
  if(body.format!==this.config.format)throw new VoiceError(502,'Voice gateway answered with format '+String(body.format).slice(0,20)+', not '+this.config.format);
  const id=body.local_artifact_id;if(typeof id!=='string'||!ARTIFACT.test(id)||!id.endsWith('.'+this.config.format))throw new VoiceError(502,'Voice gateway returned no loopback audio artifact');
  return {id,durationS:typeof body.duration_s==='number'?body.duration_s:undefined};
 }
 private async audio(id:string,signal?:AbortSignal):Promise<Buffer>{
  const url=new URL('/public/audio/'+id,this.origin);if(url.origin!==this.origin.origin)throw new VoiceError(502,'Voice gateway returned no loopback audio artifact');
  const ms=Math.min(this.config.timeoutMs,30000);let response:Response;try{response=await fetch(url,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(ms),...(signal?[signal]:[])])});}catch(e){throw this.mapped(e,signal,ms);}
  if(!response.ok)throw new VoiceError(502,'Voice gateway audio artifact HTTP '+response.status);
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>VOICE_MAX_AUDIO_BYTES)throw new VoiceError(502,'Speech audio exceeds the 5 MiB limit');
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>VOICE_MAX_AUDIO_BYTES)throw new VoiceError(502,'Speech audio exceeds the 5 MiB limit');chunks.push(value);}}catch(e){if(e instanceof VoiceError)throw e;throw this.mapped(e,signal,ms);}finally{await reader?.cancel().catch(()=>undefined);}
  return Buffer.concat(chunks);
 }
 async speak(input:unknown,signal?:AbortSignal):Promise<{audio:Buffer;contentType:'audio/mpeg'|'audio/wav';bytes:number;provider:'elevenlabs';persona:string;label:string;model:string;format:string;chars:number;durationS?:number}>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['text','persona'].includes(k)))throw new VoiceError(400,'Invalid voice request');
  const data=input as Record<string,unknown>;if(data.persona!==undefined&&data.persona!==this.config.persona)throw new VoiceError(400,'Only the configured Echo voice can speak here');
  const text=normalizeSpeechText(data.text,VOICE_TEXT_LIMITS[this.config.format]);if(this.inFlight>=this.limits.maxInFlight)throw new VoiceError(429,"Echo's voice is busy; try again in a moment");
  this.inFlight++;const started=Date.now(),chars=text.length;
  debug('%j',{schemaVersion:1,event:'prime_voice_speak_requested',chars,persona:this.config.persona,model:this.config.model,format:this.config.format});
  try{const meta=await this.synthesis(text,signal),audio=await this.audio(meta.id,signal),valid=this.config.format==='mp3'?(audio.subarray(0,3).toString()==='ID3'||(audio[0]===0xff&&(audio[1]&0xe0)===0xe0)):(audio.subarray(0,4).toString()==='RIFF'&&audio.subarray(8,12).toString()==='WAVE');if(!audio.length||!valid)throw new VoiceError(502,'Voice gateway audio is not valid '+this.config.format);
   const contentType=this.config.format==='mp3'?'audio/mpeg' as const:'audio/wav' as const,out={audio,contentType,bytes:audio.length,provider:'elevenlabs' as const,persona:this.config.persona,label:this.config.label,model:this.config.model,format:this.config.format,chars,...(meta.durationS===undefined?{}:{durationS:meta.durationS})};debug('%j',{schemaVersion:1,event:'prime_voice_speak_returned',chars,bytes:audio.length,contentType,durationMs:Date.now()-started});return out;
  }catch(e){const error=e instanceof VoiceError?e:new VoiceError(502,'Voice gateway request failed');debug('%j',{schemaVersion:1,event:'prime_voice_speak_failed',status:error.status,category:error.status===499?'interrupted':error.status===504?'timeout':error.status===429?'limited':'gateway',durationMs:Date.now()-started});throw error;}finally{this.inFlight--;}
 }
}
