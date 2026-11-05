import {createServer,type IncomingMessage} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {debuglog} from 'node:util';
import {PrimeHub,object,type PrimeRequest} from './hub.js';
import {redact} from '../code/workspace.js';
import {WorkspaceBridge,WorkspaceHttpError,type WorkspaceConfig} from './workspace.js';
const assets:Record<string,string>={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/orb.js':'orb.js','/app.js':'app.js','/chat.js':'chat.js','/integrations.js':'integrations.js','/catalog.js':'catalog.js','/steward.js':'steward.js','/workspace-client.js':'workspace-client.js','/workspace.js':'workspace.js','/models.js':'models.js'};
assets['/swarm.js']='swarm.js';assets['/swarm.css']='swarm.css';
assets['/agents.js']='agents.js';assets['/agents.css']='agents.css';
const debug=debuglog('echo-prime-server');
assets['/privacy']='privacy.html';assets['/privacy.css']='privacy.css';
Object.assign(assets,{'/fleet.js':'fleet.js','/logs.js':'logs.js','/fleet.css':'fleet.css'});
for(const name of ['composer.js','voicebar.js','plugins.js','composer.css'])assets['/'+name]=name;
Object.assign(assets,{'/views.js':'views.js','/views.css':'views.css'});
async function body(req:IncomingMessage){
 let size=0;const chunks:Buffer[]=[];
 for await(const part of req){size+=part.length;if(size>131072)throw new Error('Request exceeds 128 KiB');chunks.push(part);}
 return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export interface PrimeServerOptions {workspace?:WorkspaceConfig;publicOrigin?:string}
function publicOrigin(value:string|undefined):string|undefined{
 if(value===undefined)return undefined;
 let origin:URL;try{origin=new URL(value);}catch{throw new Error('Invalid public HTTPS origin');}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.pathname!=='/'||origin.search||origin.hash||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(origin.hostname)||origin.hostname.endsWith('.localhost'))throw new Error('Invalid public HTTPS origin');
 return origin.origin;
}
export async function startPrimeServer(hub:PrimeHub,uiDirectory:string,port=8767,options:PrimeServerOptions={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
 const externalOrigin=publicOrigin(options.publicOrigin);
 if(externalOrigin&&(!options.workspace||!options.workspace.ownerUid))throw new Error('Public origin requires an authenticated Workspace and pinned primary owner');
 const workspace=options.workspace?new WorkspaceBridge(options.workspace,!!externalOrigin):undefined;
 if(workspace)await workspace.validateBackend();
 const token=randomBytes(32).toString('hex');let url='',active=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'"+(workspace?' https://accounts.google.com/gsi/client':'')+"; style-src 'self' 'unsafe-inline'"+(workspace?' https://accounts.google.com/gsi/style':'')+"; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'"+(workspace?' https://accounts.google.com':'')+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"+(workspace?'; frame-src https://accounts.google.com':''));
  res.setHeader('Permissions-Policy','microphone=(self), camera=()');
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const expectedOrigin=externalOrigin??url;
  if(req.headers.host!==new URL(expectedOrigin).host){send(403,{error:'Unrecognized host'});return;}
  const path=new URL(req.url??'/',url).pathname;
  if(path.startsWith('/api/')){
   const started=Date.now(),requestId=randomUUID();
   const operation=path.startsWith('/api/workspace/')?'workspace':path.startsWith('/api/steward/')?'steward':path.startsWith('/api/prime/swarm/')?'swarm':path.startsWith('/api/prime/adk/')?'adk':path==='/api/session'?'session':'owner';
   const record=(outcome:string)=>debug('%j',{schemaVersion:1,event:'prime_api_request',operation,requestId,status:res.statusCode,outcome,durationMs:Date.now()-started});
   res.once('finish',()=>record('returned'));res.once('close',()=>{if(!res.writableEnded)record('disconnected');});
   const supplied=(req.headers.cookie??'').split(';').map(c=>c.trim()).find(c=>c.startsWith('echo_prime='))?.slice(11)??'';
   const allowed=/^[0-9a-f]{64}$/.test(supplied)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
   if(!allowed||req.headers['x-prime-request']!=='1'||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin!==undefined&&req.headers.origin!==expectedOrigin)||(req.method==='POST'&&req.headers.origin!==expectedOrigin)){send(403,{error:'Same-origin Prime session required'});return;}
   if(active>=8){send(429,{error:'Too many requests'});return;}active++;
   const abort=new AbortController();const disconnected=()=>{if(!res.writableEnded)abort.abort();};res.once('close',disconnected);
   try{
    if(path==='/api/session'&&req.method==='GET'){
     const session=workspace?await workspace.session(req,abort.signal):{authenticated:false,user:null,csrf:null};
     send(200,{workspaceConfigured:!!workspace,...session,ownerAccess:workspace?.ownerAccess(session)??false});return;
    }
    if(path.startsWith('/api/workspace/')){
     if(!workspace){send(503,{error:'Authenticated Workspace is not configured'});return;}
     await workspace.handle(req,res,new URL(req.url??'/',url),abort.signal);return;
    }
    if(workspace)await workspace.requireOwner(req,abort.signal);
    if(path==='/api/status'&&req.method==='GET'){send(200,await hub.status());return;}
    if(path==='/api/prime/models'&&req.method==='GET'){send(200,await hub.models());return;}
    if(path==='/api/prime/swarm/health'&&req.method==='GET'){send(200,await hub.swarmHealth(abort.signal));return;}
    const swarmRun=/^\/api\/prime\/swarm\/runs\/([^/]{1,80})$/.exec(path);
    if(swarmRun&&req.method==='GET'){send(200,await hub.swarmStatus(decodeURIComponent(swarmRun[1]),abort.signal));return;}
    // Agents (Echo ADK): owner-only like every other /api/prime route. GET list/status before the JSON POST gate; POST run/stop below it.
    if(path==='/api/prime/adk/health'&&req.method==='GET'){send(200,await hub.adkHealth(abort.signal));return;}
    if(path==='/api/prime/adk/agents'&&req.method==='GET'){send(200,await hub.adkAgents(abort.signal));return;}
    const adkAgent=/^\/api\/prime\/adk\/agents\/([^/]{1,80})$/.exec(path);
    if(adkAgent&&req.method==='GET'){send(200,await hub.adkAgent(decodeURIComponent(adkAgent[1]),abort.signal));return;}
    if(path==='/api/prime/adk/runs'&&req.method==='GET'){
     const query=new URL(req.url??'/',url).searchParams,agent=query.get('agent'),limit=query.get('limit');
     send(200,await hub.adkRuns({...(agent!==null?{agent}:{}),...(limit!==null?{limit}:{})},abort.signal));return;
    }
    const adkRun=/^\/api\/prime\/adk\/runs\/([^/]{1,80})$/.exec(path);
    if(adkRun&&req.method==='GET'){send(200,await hub.adkStatus(decodeURIComponent(adkRun[1]),abort.signal));return;}
    const adkStop=/^\/api\/prime\/adk\/runs\/([^/]{1,80})\/stop$/.exec(path);
    if(path==='/api/steward/status'&&req.method==='GET'){send(200,await hub.stewardStatus());return;}
    if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
    const data=await body(req);
    if(path==='/api/search')send(200,{capabilities:await hub.refresh(String(data.query??''))});
    else if(path==='/api/prepare')send(200,await hub.prepare(data as unknown as PrimeRequest));
    else if(path==='/api/execute')send(200,await hub.execute(String(data.id??''),String(data.digest??'')));
    else if(path==='/api/chat')send(200,await hub.chat(data,abort.signal));
    else if(path==='/api/prime/swarm/run')send(202,await hub.swarmRun(data,abort.signal));
    else if(path==='/api/prime/adk/runs')send(202,await hub.adkRun(data,abort.signal));
    else if(adkStop)send(200,await hub.adkStop(decodeURIComponent(adkStop[1]),abort.signal));
    else if(path==='/api/steward/ask')send(200,await hub.stewardAsk(data));
    else send(404,{error:'Unknown route'});
   }catch(e){if(res.headersSent)res.destroy();else send(e instanceof WorkspaceHttpError?e.status:400,{error:redact(e instanceof Error?e.message:'Request failed').slice(0,600)});}
   finally{res.removeListener('close',disconnected);active--;}
   return;
  }
  if(req.method!=='GET'||!assets[path]){send(404,{error:'Not found'});return;}
  try{
   const data=await readFile(join(uiDirectory,assets[path]));
   if(path==='/'||path==='/index.html')res.setHeader('Set-Cookie','echo_prime='+token+'; HttpOnly; SameSite=Strict; Path=/'+(externalOrigin?'; Secure':''));
   res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(data);
  }catch{send(404,{error:'Asset unavailable'});}
 });
 server.requestTimeout=25000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string'){reject(new Error('Local listener unavailable'));return;}url='http://127.0.0.1:'+a.port;resolve();});});
 return {url,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
