import {randomUUID} from 'node:crypto';
import {debuglog} from 'node:util';
import {redact} from '../workspace.js';

/** Structurally compatible with the sibling autoagents registration contract. */
export interface ToolContext {owner:boolean;prompt:string;sessionId?:string;signal?:AbortSignal}
export interface ChatTool {name:string;description:string;inputSchema:Record<string,unknown>;ownerOnly:true;run(args:unknown,ctx:ToolContext):Promise<unknown>}
export interface AutonomyEvent {type:string;tool?:string;request_id?:string;[key:string]:unknown}
export type AutonomyEvents=(event:AutonomyEvent)=>void;
export const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const debug=debuglog('echo-prime-autonomy');
export function emit(events:AutonomyEvents|undefined,event:AutonomyEvent){
 debug('%j',{schemaVersion:1,event:event.type,tool:event.tool,requestId:event.request_id,state:record(event.result).state});
 // Observers must never turn a completed write into an apparent transport failure.
 try{events?.(event);}catch{debug('%j',{schemaVersion:1,event:'autonomy_observer_failed'});}
}
export function owner(ctx:ToolContext){if(ctx?.owner!==true)throw new Error('Only the admitted owner may use autonomy tools');if(ctx.signal?.aborted)throw new Error('Interrupted');}
export function textArg(value:unknown,max:number,label:string):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||[...value].some(c=>{const n=c.charCodeAt(0);return n<32&&![9,10,13].includes(n)||n===127;}))throw new Error('Invalid '+label);
 if(redact(value)!==value)throw new Error('Secret-like '+label+' refused');return value.trim();
}
export function exactArgs(value:unknown,keys:string[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('Invalid tool arguments');return record(value);
}
export async function timed<T>(work:()=>Promise<T>,signal?:AbortSignal,ms=15000):Promise<T>{
 if(signal?.aborted)throw new Error('Interrupted');
 let timer:ReturnType<typeof setTimeout>|undefined;let abort:()=>void=()=>{};
 try{return await Promise.race([Promise.resolve().then(()=>{if(signal?.aborted)throw new Error('Interrupted');return work();}),new Promise<never>((_,reject)=>{
  abort=()=>reject(new Error('Interrupted; outcome unknown'));signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(new Error('Owner timeout; outcome unknown')),ms);
 })]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** Keep owner denials intact, including tier, needs and the original audit ID. */
export function envelope(value:unknown){
 const raw=JSON.stringify(value);if(!raw||Buffer.byteLength(raw)>1048576)throw new Error('Owner response exceeds limit');
 let v=record(JSON.parse(redact(raw))),isError=false;
 for(let i=0;i<8;i++){
  isError ||= v.isError===true;
  if(v.structuredContent){isError ||= v.ok===false;v=record(v.structuredContent);continue;}
  if(Array.isArray(v.content)){isError ||= v.ok===false;const t=v.content.find(b=>record(b).type==='text');v=record(JSON.parse(String(record(t).text)));continue;}
  return isError?{...v,isError:true,ok:false}:v;
 }
 throw new Error('Owner response nesting exceeds limit');
}
export async function toolCall(tool:string,ctx:ToolContext,events:AutonomyEvents|undefined,work:()=>Promise<Record<string,unknown>>){
 const request_id=randomUUID();emit(events,{type:'tool_started',tool,request_id});
 let result:Record<string,unknown>;
 try{owner(ctx);result=await work();}catch(error){result={untrusted:true,audit_id:null,receipt:null,state:'unavailable',message:redact(error instanceof Error?error.message:'Tool unavailable').slice(0,400)};}
 emit(events,{type:'tool_result',tool,request_id,result});return result;
}
