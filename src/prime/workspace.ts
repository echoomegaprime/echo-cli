import type {IncomingMessage,ServerResponse} from 'node:http';
import {debuglog} from 'node:util';
import {randomUUID,timingSafeEqual} from 'node:crypto';

const debug=debuglog('echo-prime-workspace');
const ordinaryEventBytes=256*1024,terminalEventBytes=8*1024*1024;
// Canonical emit() serializes type first. Only its full saved-chat receipt
// receives a larger allowance; ordinary model/tool events remain bounded.
const terminalPrefix=/^\s*\{\s*"type"\s*:\s*"done"\s*,/;
const operationBudgets:Record<string,number>={
 '/api/chat':125000,'/api/review':610000,'/api/compact':610000,
 '/api/voice/start':455000,'/api/voice/next':305000,'/api/voice/transcribe':155000,
 '/api/sync':610000,
};
const tenantSafeActions=new Set(['memory_save','memory_forget','personality_select']);
export interface WorkspaceConfig {baseUrl:string;ownerUid?:string}
export interface WorkspaceSession {
 authenticated:boolean;user:{uid:string;name?:string;role?:string;status?:string}|null;csrf:string|null;
}
export class WorkspaceHttpError extends Error {
 constructor(public status:number,message:string){super(message);}
}
function record(category:string,operation:string,requestId:string,started:number){
 debug('%j',{schemaVersion:1,event:'prime_workspace_request',category,operation,requestId,durationMs:Date.now()-started});
}
function sessionCookie(req:IncomingMessage):string {
 const cookies=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='cookie');
 if(cookies.length>1)throw new WorkspaceHttpError(403,'Ambiguous account session');
 const raw=req.headers.cookie??'';
 if(raw.length>8192)throw new WorkspaceHttpError(431,'Account cookie header exceeds limit');
 const own=raw.split(';').map(x=>x.trim()).filter(x=>x.split('=')[0].trim()==='echo_workspace_session');
 if(own.length>1)throw new WorkspaceHttpError(403,'Ambiguous account session');
 if(!own.length)return '';
 if(!/^echo_workspace_session=[A-Za-z0-9_-]{32,128}$/.test(own[0]))throw new WorkspaceHttpError(403,'Invalid account session');
 return own[0];
}
function parseSession(value:unknown):WorkspaceSession {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkspaceHttpError(503,'Authenticated Workspace contract unavailable');
 const v=value as Record<string,unknown>;
 if(v.authenticated===false&&v.user===null&&v.csrf===null)return {authenticated:false,user:null,csrf:null};
 const user=v.user as Record<string,unknown>|null;
 if(v.authenticated!==true||!user||typeof user!=='object'||Array.isArray(user)||typeof user.uid!=='string'||!/^[A-Za-z0-9_.:@+-]{1,200}$/.test(user.uid)||typeof v.csrf!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(v.csrf)){
  throw new WorkspaceHttpError(503,'Authenticated Workspace contract unavailable');
 }
 return {authenticated:true,user:{uid:user.uid,...(typeof user.name==='string'?{name:user.name.slice(0,160)}:{}),...(typeof user.role==='string'?{role:user.role.slice(0,40)}:{}),...(typeof user.status==='string'?{status:user.status.slice(0,40)}:{})},csrf:v.csrf};
}
async function boundedBytes(response:Response,max:number):Promise<Uint8Array> {
 if(!response.body)return new Uint8Array();
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new WorkspaceHttpError(502,'Workspace response exceeds limit');chunks.push(value);}
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
async function jsonResponse(response:Response,max=65536):Promise<unknown>{
 if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new WorkspaceHttpError(503,'Authenticated Workspace contract unavailable');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(response,max)));}
 catch(error){if(error instanceof WorkspaceHttpError)throw error;throw new WorkspaceHttpError(502,'Invalid Workspace response');}
}
const reads=new Set(['/api/state','/api/diagnostics','/api/fleet','/api/health','/api/mcp','/api/plugins','/api/catalog','/api/chats','/api/auth/accounts']);
const writes=new Set(['/api/mcp','/api/chats','/api/chat/update','/api/chat','/api/compact','/api/fork','/api/projects','/api/project/update','/api/library','/api/import','/api/action','/api/sync','/api/review','/api/voice/start','/api/voice/next','/api/voice/cancel','/api/voice/transcribe']);
const publicReads=new Set(['/api/auth/session','/api/auth/config']);
const authWrites=new Set(['/api/auth/login','/api/auth/signup','/api/auth/reset','/api/auth/logout','/api/auth/refresh','/api/auth/verify','/api/auth/decide']);
function route(url:URL,method:string):string {
 const path=url.pathname.replace(/^\/api\/workspace\//,'/api/');
 const allowed=method==='GET'?(reads.has(path)||publicReads.has(path)||/^\/api\/(?:chats|journals|library|mcp\/tools|voice\/audio)\/[A-Za-z0-9_-]{1,120}$/.test(path)):
  method==='POST'&&(writes.has(path)||authWrites.has(path));
 if(!allowed)throw new WorkspaceHttpError(404,'Unknown Workspace route');
 const keys=[...url.searchParams.keys()];
 if(keys.length&&(method!=='GET'||!['/api/chats','/api/catalog'].includes(path)||keys.length!==1||keys[0]!=='q'||(url.searchParams.get('q')??'').length>500))throw new WorkspaceHttpError(400,'Invalid Workspace query');
 return path+url.search;
}
async function requestBody(req:IncomingMessage):Promise<string>{
 if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new WorkspaceHttpError(415,'JSON body required');
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>2_000_000)throw new WorkspaceHttpError(413,'Workspace request exceeds limit');chunks.push(chunk);}
 try{const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return JSON.stringify(value);}
 catch{throw new WorkspaceHttpError(400,'Expected a JSON object');}
}
function checkCsrf(req:IncomingMessage,expected:string){
 const supplied=req.headers['x-echo-csrf'];
 if(typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new WorkspaceHttpError(403,'Account session check failed');
}

/** A fixed, authenticated canonical owner boundary. Never uses an owner cookie,
 * cached user, SDK credential, caller tenant ID or arbitrary upstream URL. */
export class WorkspaceBridge {
 readonly origin:string;readonly ownerUid?:string;
 constructor(config:WorkspaceConfig,private readonly secureCookies=false){
  const url=new URL(config.baseUrl);
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Workspace requires a fixed loopback HTTP origin');
  if(config.ownerUid!==undefined&&(typeof config.ownerUid!=='string'||!/^[A-Za-z0-9_.:@+-]{1,200}$/.test(config.ownerUid)))throw new Error('Invalid configured Workspace owner identity');
  this.origin=url.origin;this.ownerUid=config.ownerUid;
 }
 private async fetch(path:string,headers:Record<string,string>,signal?:AbortSignal,body?:string):Promise<Response>{
  const action=path==='/api/action'&&body?(JSON.parse(body) as {action?:unknown}).action:undefined;
  // ESH first checks status, then dispatches once. Each connector call may
  // initialize for20s and wait90s; local preferences retain the20s budget.
  const actionBudget=typeof action==='string'&&!tenantSafeActions.has(action)?(action==='esh'?220000:115000):undefined;
  const deadline=AbortSignal.timeout(actionBudget??operationBudgets[path]??20000);
  const combined=signal?AbortSignal.any([deadline,signal]):deadline;
  try{
   const response=await fetch(this.origin+path,{method:body===undefined?'GET':'POST',headers,body,signal:combined,redirect:'manual'});
   if(response.status>=300&&response.status<400){await response.body?.cancel();throw new WorkspaceHttpError(502,'Workspace redirect refused');}
   return response;
  }catch(error){if(error instanceof WorkspaceHttpError)throw error;throw new WorkspaceHttpError(502,'Workspace transport unavailable; no automatic retry');}
 }
 async validateBackend():Promise<void>{
  try{
   const response=await this.fetch('/api/auth/session',{});
   if(response.status!==200)throw new Error();
   const session=parseSession(await jsonResponse(response));
   if(session.authenticated)throw new Error();
  }catch{throw new Error('An authenticated Workspace backend is required; owner-only installations cannot be bridged');}
 }
 async session(req:IncomingMessage,signal?:AbortSignal):Promise<WorkspaceSession>{
  const cookie=sessionCookie(req),response=await this.fetch('/api/auth/session',cookie?{cookie}:{},signal);
  if(response.status!==200){await response.body?.cancel();throw new WorkspaceHttpError(503,'Account admission unavailable');}
  return parseSession(await jsonResponse(response));
 }
 async requireOwner(req:IncomingMessage,signal?:AbortSignal):Promise<void>{
  const session=await this.session(req,signal);
  if(!session.authenticated)throw new WorkspaceHttpError(401,'Sign in required');
  if(session.user?.status!=='approved')throw new WorkspaceHttpError(403,'Account approval required');
  if(!this.ownerAccess(session))throw new WorkspaceHttpError(403,'Primary owner admission required');
  checkCsrf(req,session.csrf!);
 }
 ownerAccess(session:WorkspaceSession):boolean{return !!this.ownerUid&&session.authenticated&&session.user?.role==='owner'&&session.user.status==='approved'&&session.user.uid===this.ownerUid;}
 /** The Workspace's personality catalog (`/api/state` → `personalities`, the same list its composer shows), read with this request's own session cookie. Raw state is never returned; the caller parses the list. */
 async personalities(req:IncomingMessage,signal?:AbortSignal):Promise<unknown>{
  const cookie=sessionCookie(req);
  const response=await this.fetch('/api/state',cookie?{cookie,accept:'application/json'}:{accept:'application/json'},signal);
  if(response.status!==200){await response.body?.cancel();throw new WorkspaceHttpError(503,'Workspace personality catalog unavailable');}
  const state=await jsonResponse(response,8*1024*1024) as {personalities?:unknown};
  return Array.isArray(state?.personalities)?state.personalities:[];
 }
 async handle(req:IncomingMessage,res:ServerResponse,url:URL,signal:AbortSignal):Promise<void>{
  const started=Date.now(),requestId=randomUUID(),path=route(url,req.method??''),pathname=path.split('?')[0];
  const operation=pathname.startsWith('/api/auth/')?'account':pathname==='/api/chat'?'chat':'workspace';
  try{
   const publicRoute=publicReads.has(pathname)||['/api/auth/login','/api/auth/signup','/api/auth/reset'].includes(pathname);
   // The canonical owner supports local revocation even when the identity
   // issuer is unavailable. It still validates the issued cookie and CSRF.
   const localLogout=pathname==='/api/auth/logout';
   const session=publicRoute||localLogout?null:await this.session(req,signal);
   if(session&&!session.authenticated)throw new WorkspaceHttpError(401,'Sign in required');
   if(session&&!pathname.startsWith('/api/auth/')&&session.user?.status!=='approved')throw new WorkspaceHttpError(403,'Account approval required');
   if(['/api/fleet','/api/diagnostics','/api/catalog','/api/plugins','/api/sync','/api/auth/accounts','/api/auth/decide'].includes(pathname)&&session&&!this.ownerAccess(session))throw new WorkspaceHttpError(403,'Primary owner admission required');
   if(localLogout){if(typeof req.headers['x-echo-csrf']!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(req.headers['x-echo-csrf']))throw new WorkspaceHttpError(403,'Account session check failed');}
   else if(!publicRoute)checkCsrf(req,session!.csrf!);
   else if(req.method==='POST')checkCsrf(req,'login');
   const cookie=sessionCookie(req),headers:Record<string,string>={accept:'application/json, application/x-ndjson, audio/wav, text/plain'};
   if(cookie)headers.cookie=cookie;
   let body:string|undefined;
   if(req.method==='POST'){body=await requestBody(req);headers['content-type']='application/json';headers.origin=this.origin;headers['x-echo-csrf']=String(req.headers['x-echo-csrf']);}
   if(pathname==='/api/action'&&session&&!this.ownerAccess(session)&&!tenantSafeActions.has((JSON.parse(body!) as {action:string}).action))throw new WorkspaceHttpError(403,'Primary owner admission required');
   let admittedState:unknown;
   if(session&&!pathname.startsWith('/api/auth/')&&!this.ownerAccess(session)){
    // The canonical legacy owner application is selected by UID alone. A
    // demoted/misconfigured owner must never inherit its tools through chat.
    // Attest the actual application after current-session CSRF validation.
    const stateResponse=await this.fetch('/api/state',cookie?{cookie,accept:'application/json'}:{accept:'application/json'},signal);
    if(stateResponse.status!==200){await stateResponse.body?.cancel();throw new WorkspaceHttpError(503,'Private Workspace isolation unavailable');}
    const state=await jsonResponse(stateResponse,8*1024*1024) as {tenant_isolation?:unknown;auth_enabled?:unknown;user?:{uid?:unknown};csrf?:unknown};
    if(!state||state.tenant_isolation!==true||state.auth_enabled!==true||state.user?.uid!==session.user?.uid||state.csrf!==session.csrf)throw new WorkspaceHttpError(403,'Private Workspace isolation required');
    admittedState=state;
   }
   const response=pathname==='/api/state'&&admittedState?Response.json(admittedState):await this.fetch(path,headers,signal,body);
   const contentType=(response.headers.get('content-type')??'').toLowerCase();
   if(!/^(?:application\/(?:json|x-ndjson)|audio\/wav|text\/plain)(?:;|$)/.test(contentType)){await response.body?.cancel();throw new WorkspaceHttpError(502,'Unsupported Workspace response');}
   const cookies=response.headers.getSetCookie();
   if(cookies.length){
    if(!authWrites.has(pathname)||cookies.length!==1){await response.body?.cancel();throw new WorkspaceHttpError(502,'Unexpected account cookie');}
    const match=/^echo_workspace_session=([A-Za-z0-9_-]{32,128}|);/.exec(cookies[0]);
    if(!match||/;\s*domain=/i.test(cookies[0])){await response.body?.cancel();throw new WorkspaceHttpError(502,'Invalid account cookie');}
    res.setHeader('Set-Cookie',`echo_workspace_session=${match[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${match[1]?'28800':'0'}${this.secureCookies?'; Secure':''}`);
   }
   res.statusCode=response.status;res.setHeader('Content-Type',contentType);res.setHeader('Cache-Control','no-store');
   if(!response.body){res.end();return;}
   const reader=response.body.getReader();let size=0,lineBytes=0,prefix='';
   try{
    for(;;){
     const {done,value}=await reader.read();if(done)break;
     size+=value.byteLength;if(size>32*1024*1024)throw new WorkspaceHttpError(502,'Workspace response exceeds limit');
     if(contentType.startsWith('application/x-ndjson'))for(const byte of value){
      if(byte===10){lineBytes=0;prefix='';continue;}
      lineBytes++;if(prefix.length<128)prefix+=String.fromCharCode(byte);
      if(lineBytes>(terminalPrefix.test(prefix)?terminalEventBytes:ordinaryEventBytes))throw new WorkspaceHttpError(502,'Workspace stream event exceeds limit');
     }
     if(!res.write(value))await new Promise<void>((resolve,reject)=>{const drain=()=>{clear();resolve();};const closed=()=>{clear();reject(new WorkspaceHttpError(499,'Workspace stream disconnected'));};const clear=()=>{res.off('drain',drain);res.off('close',closed);};res.once('drain',drain);res.once('close',closed);});
    }
   }finally{await reader.cancel().catch(()=>{});}
   res.end();record('returned',operation,requestId,started);
  }catch(error){record(error instanceof WorkspaceHttpError?`http_${error.status}`:'transport',operation,requestId,started);throw error;}
 }
}
