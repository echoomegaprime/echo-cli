import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type Json, type Tool, object, type McpConnection } from './hub.js';
export interface StdioConfig {command:string;args:string[];cwd?:string;env?:Record<string,string>}
function cancelled(sent:boolean){return new DOMException(sent?'MCP request interrupted; outcome unknown (remote work may continue)':'MCP request interrupted; the request was not sent','AbortError');}
export class StdioMcp implements McpConnection {
 private next=0;private buffer='';private closed=false;
 private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;cleanup:()=>void;long:boolean}>();
 /** Calls that carry their own longer wait (a generation that runs for minutes, a job status read) hold a slot for that
  * long, so they get their own budget and can never starve the short catalog reads, reviews and chat tools (16). */
 private static readonly SHORT_LIMIT=16;private static readonly LONG_LIMIT=8;
 private constructor(private child:ChildProcessWithoutNullStreams,private timeout:number){
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
   this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>2097152){this.close(new Error('MCP output exceeds limit'));return;}
   let index:number;while((index=this.buffer.indexOf('\n'))>=0){
    const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
    try{
     const msg=object(JSON.parse(line));if(msg.jsonrpc!=='2.0')throw new Error();
     const p=this.takePending(Number(msg.id));if(!p)continue;
     if(msg.error)p.reject(new Error('MCP owner rejected request'));else p.resolve(msg.result);
    }catch{this.close(new Error('Malformed MCP response'));return;}
   }
  });
  child.stderr.resume();child.on('error',()=>this.close(new Error('MCP process unavailable')));
  child.on('exit',()=>this.close(new Error('MCP process exited')));
  child.stdin.on('error',()=>this.close(new Error('MCP input closed')));
 }
 private takePending(id:number){
  const pending=this.pending.get(id);
  if(pending){this.pending.delete(id);pending.cleanup();}
  return pending;
 }
 static async connect(config:StdioConfig,timeout=20000){
  if(typeof config.command!=='string'||!config.command||!Array.isArray(config.args)||config.args.some(a=>typeof a!=='string'))throw new Error('Invalid local MCP configuration');
  const env:NodeJS.ProcessEnv={};
  for(const k of ['PATH','Path','PATHEXT','SystemRoot','WINDIR','ProgramData','ALLUSERSPROFILE','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','USERNAME','USERDOMAIN','HOME','APPDATA','LOCALAPPDATA','COMSPEC'])if(process.env[k])env[k]=process.env[k];
  Object.assign(env,config.env??{});
  const child=spawn(config.command,config.args,{cwd:config.cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const client=new StdioMcp(child,Math.min(60000,Math.max(100,timeout)));
  try{
   const init=object(await client.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'echo-prime',version:'0.1.0'}}));
   if(init.protocolVersion!=='2024-11-05'||!object(init.capabilities).tools)throw new Error('Unsupported MCP owner contract');
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return client;
  }catch(e){client.close();throw e;}
 }
 /** `timeoutMs` overrides the connection default for one call (a long generation), bounded to 15 minutes. A call refused
  * here for a full budget was never written to the owner, and its error says so ("not sent"). */
 private rpc(method:string,params:Json,timeoutMs?:number,signal?:AbortSignal):Promise<unknown>{
  if(signal?.aborted)return Promise.reject(cancelled(false));
  if(this.closed)return Promise.reject(new Error('MCP connection closed'));
  const limit=typeof timeoutMs==='number'&&Number.isFinite(timeoutMs)?Math.min(900000,Math.max(100,timeoutMs)):this.timeout,long=limit>this.timeout;
  let inLane=0;for(const p of this.pending.values())if(p.long===long)inLane++;
  if(inLane>=(long?StdioMcp.LONG_LIMIT:StdioMcp.SHORT_LIMIT))return Promise.reject(new Error(long?'MCP long-request limit reached; the request was not sent':'MCP request limit reached; the request was not sent'));
  const id=++this.next,line=JSON.stringify({jsonrpc:'2.0',id,method,params});
  if(Buffer.byteLength(line)>131072)return Promise.reject(new Error('MCP request too large'));
  return new Promise((resolve,reject)=>{
   let sent=false;
   const onAbort=()=>this.takePending(id)?.reject(cancelled(sent));
   const timer=setTimeout(()=>this.takePending(id)?.reject(new Error('MCP request timed out; outcome unknown')),limit);
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);};
   this.pending.set(id,{resolve,reject,cleanup,long});
   signal?.addEventListener('abort',onAbort,{once:true});
   // Serialization or listener registration may observe cancellation before the write.
   if(signal?.aborted){onAbort();return;}
   try{sent=true;this.child.stdin.write(line+'\n');}
   catch{this.close(new Error('MCP input closed; outcome unknown'));}
  });
 }
 async listTools(signal?:AbortSignal):Promise<Tool[]>{
  const tools:Tool[]=[];let cursor:string|undefined;const seen=new Set<string>();
  do{
   const result=object(await this.rpc('tools/list',cursor?{cursor}:{},undefined,signal));
   if(signal?.aborted)throw cancelled(true);
   if(!Array.isArray(result.tools))throw new Error('MCP tools missing');
   for(const t of result.tools){const tool=object(t);if(typeof tool.name==='string'&&tool.inputSchema)tools.push(tool as unknown as Tool);}
   if(tools.length>2000)throw new Error('MCP tool inventory exceeds limit');
   cursor=typeof result.nextCursor==='string'?result.nextCursor:undefined;
   if(cursor){if(seen.has(cursor))throw new Error('Repeated MCP cursor');seen.add(cursor);}
  }while(cursor);return tools;
 }
 call(name:string,args:Json,options?:{timeoutMs?:number;signal?:AbortSignal}){return this.rpc('tools/call',{name,arguments:args},options?.timeoutMs,options?.signal);}
 close(reason=new Error('MCP connection closed')){
  if(this.closed)return;this.closed=true;
  for(const id of this.pending.keys())this.takePending(id)?.reject(reason);
  this.child.stdin.end();this.child.kill();
 }
}
