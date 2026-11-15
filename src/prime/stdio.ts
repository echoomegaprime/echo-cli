import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type Json, type Tool, object, type McpConnection } from './hub.js';
export interface StdioConfig {command:string;args:string[];cwd?:string;env?:Record<string,string>}
export class StdioMcp implements McpConnection {
 private next=0;private buffer='';private closed=false;
 private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private constructor(private child:ChildProcessWithoutNullStreams,private timeout:number){
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
   this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>2097152){this.close(new Error('MCP output exceeds limit'));return;}
   let index:number;while((index=this.buffer.indexOf('\n'))>=0){
    const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
    try{
     const msg=object(JSON.parse(line));if(msg.jsonrpc!=='2.0')throw new Error();
     const p=this.pending.get(Number(msg.id));if(!p)continue;
     this.pending.delete(Number(msg.id));clearTimeout(p.timer);
     if(msg.error)p.reject(new Error('MCP owner rejected request'));else p.resolve(msg.result);
    }catch{this.close(new Error('Malformed MCP response'));return;}
   }
  });
  child.stderr.resume();child.on('error',()=>this.close(new Error('MCP process unavailable')));
  child.on('exit',()=>this.close(new Error('MCP process exited')));
  child.stdin.on('error',()=>this.close(new Error('MCP input closed')));
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
 private rpc(method:string,params:Json):Promise<unknown>{
  if(this.closed)return Promise.reject(new Error('MCP connection closed'));
  if(this.pending.size>=16)return Promise.reject(new Error('MCP request limit reached'));
  const id=++this.next,line=JSON.stringify({jsonrpc:'2.0',id,method,params});
  if(Buffer.byteLength(line)>131072)return Promise.reject(new Error('MCP request too large'));
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('MCP request timed out; outcome unknown'));},this.timeout);
   this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(line+'\n');
  });
 }
 async listTools():Promise<Tool[]>{
  const tools:Tool[]=[];let cursor:string|undefined;const seen=new Set<string>();
  do{
   const result=object(await this.rpc('tools/list',cursor?{cursor}:{}));
   if(!Array.isArray(result.tools))throw new Error('MCP tools missing');
   for(const t of result.tools){const tool=object(t);if(typeof tool.name==='string'&&tool.inputSchema)tools.push(tool as unknown as Tool);}
   if(tools.length>2000)throw new Error('MCP tool inventory exceeds limit');
   cursor=typeof result.nextCursor==='string'?result.nextCursor:undefined;
   if(cursor){if(seen.has(cursor))throw new Error('Repeated MCP cursor');seen.add(cursor);}
  }while(cursor);return tools;
 }
 call(name:string,args:Json){return this.rpc('tools/call',{name,arguments:args});}
 close(reason=new Error('MCP connection closed')){
  if(this.closed)return;this.closed=true;
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(reason);}this.pending.clear();
  this.child.stdin.end();this.child.kill();
 }
}
