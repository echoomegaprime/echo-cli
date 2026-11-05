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
assets['/bots.js']='bots.js';assets['/bots.css']='bots.css';
assets['/build.js']='build.js';assets['/build.css']='build.css';
const debug=debuglog('echo-prime-server');
assets['/privacy']='privacy.html';assets['/privacy.css']='privacy.css';
Object.assign(assets,{'/fleet.js':'fleet.js','/logs.js':'logs.js','/fleet.css':'fleet.css'});
for(const name of ['composer.js','voicebar.js','plugins.js','composer.css'])assets['/'+name]=name;
Object.assign(assets,{'/views.js':'views.js','/views.css':'views.css'});
for(const name of ['layout.js','esh-dock.js','chat-actions.js'])assets['/'+name]=name;
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
 // Opaque-origin sandbox frames cannot send owner headers or SameSite cookies. A short-lived, build-only read ticket is
 // minted by an authenticated JSON POST. Its captured session is revalidated on every resource; never sent to the app.
 const previews=new Map<string,{id:string;expires:number;headers:IncomingMessage['headers']}>();
 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'"+(workspace?' https://accounts.google.com/gsi/client':'')+"; style-src 'self' 'unsafe-inline'"+(workspace?' https://accounts.google.com/gsi/style':'')+"; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'"+(workspace?' https://accounts.google.com':'')+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src 'self'"+(workspace?' https://accounts.google.com':''));
  res.setHeader('Permissions-Policy','microphone=(self), camera=()');
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const expectedOrigin=externalOrigin??url;
  if(req.headers.host!==new URL(expectedOrigin).host){send(403,{error:'Unrecognized host'});return;}
  const path=new URL(req.url??'/',url).pathname;
  if(path.startsWith('/api/')){
   const started=Date.now(),requestId=randomUUID();
   const operation=path.startsWith('/api/workspace/')?'workspace':path.startsWith('/api/steward/')?'steward':path.startsWith('/api/prime/swarm/')?'swarm':path.startsWith('/api/prime/adk/')?'adk':path.startsWith('/api/prime/bots/')?'bots':path.startsWith('/api/prime/build/')?'build':path==='/api/session'?'session':'owner';
   const record=(outcome:string)=>debug('%j',{schemaVersion:1,event:'prime_api_request',operation,requestId,status:res.statusCode,outcome,durationMs:Date.now()-started});
   res.once('finish',()=>record('returned'));res.once('close',()=>{if(!res.writableEnded)record('disconnected');});
   const supplied=(req.headers.cookie??'').split(';').map(c=>c.trim()).find(c=>c.startsWith('echo_prime='))?.slice(11)??'';
   const allowed=/^[0-9a-f]{64}$/.test(supplied)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
   const previewRoute=/^\/api\/prime\/build\/([a-f0-9]{32})\/preview\/([a-f0-9]{48})\/(.*)$/.exec(path);
   const previewTicket=previewRoute?previews.get(previewRoute[2]):undefined;
   const previewRead=!!previewRoute&&req.method==='GET'&&previewTicket?.id===previewRoute[1]&&previewTicket.expires>Date.now()&&[undefined,'null',expectedOrigin].includes(req.headers.origin);
   if(!previewRead&&(!allowed||req.headers['x-prime-request']!=='1'||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin!==undefined&&req.headers.origin!==expectedOrigin)||(req.method==='POST'&&req.headers.origin!==expectedOrigin))){send(403,{error:'Same-origin Prime session required'});return;}
   if(active>=8){send(429,{error:'Too many requests'});return;}active++;
   const abort=new AbortController();const disconnected=()=>{if(!res.writableEnded)abort.abort();};res.once('close',disconnected);
   try{
    if(previewRoute){
     if(!previewRead||!previewTicket){send(403,{error:'Preview session expired; reopen the build'});return;}
     if(workspace)await workspace.requireOwner({headers:previewTicket.headers,rawHeaders:['Cookie',previewTicket.headers.cookie??'']} as IncomingMessage,abort.signal);
     const base='/api/prime/build/'+previewRoute[1]+'/preview/'+previewRoute[2]+'/';
     const proxied=await hub.buildPreview(previewRoute[1],previewRoute[3]+new URL(req.url??'/',url).search,base,abort.signal);
     // No allow-same-origin: generated scripts cannot read Prime DOM/storage, cookies, or any owner API.
     const source=expectedOrigin+base;
     res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-forms; default-src "+source+"; script-src "+source+" 'unsafe-inline'; style-src "+source+" 'unsafe-inline'; img-src "+source+" data: blob:; connect-src "+source+"; font-src "+source+" data:; base-uri "+source+"; form-action "+source+"; frame-ancestors 'self'; object-src 'none'; worker-src 'none'");
     res.setHeader('Access-Control-Allow-Origin','null');
     res.writeHead(proxied.status,{'Content-Type':proxied.type});res.end(proxied.data);return;
    }
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
    if(path==='/api/prime/build/health'&&req.method==='GET'){send(200,hub.buildHealth());return;}
    if(path==='/api/prime/build/list'&&req.method==='GET'){send(200,hub.buildList());return;}
    const buildOne=/^\/api\/prime\/build\/([^/]{1,80})$/.exec(path);
    const buildLog=/^\/api\/prime\/build\/([^/]{1,80})\/log$/.exec(path);
    const buildPlan=/^\/api\/prime\/build\/([^/]{1,80})\/deploy-plan$/.exec(path);
    const buildAction=/^\/api\/prime\/build\/([^/]{1,80})\/(turn|turns|hibernate|revive|stop|deploy|repository|preview-session)$/.exec(path);
    if(buildOne&&req.method==='GET'){send(200,hub.buildGet(decodeURIComponent(buildOne[1])));return;}
    if(buildLog&&req.method==='GET'){send(200,hub.buildLog(decodeURIComponent(buildLog[1]),new URL(req.url??'/',url).searchParams.get('since')??0));return;}
    if(buildPlan&&req.method==='GET'){send(200,hub.buildDeploymentPlan(decodeURIComponent(buildPlan[1]),new URL(req.url??'/',url).searchParams.get('target')));return;}
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
    // echoBots (owner-only like swarm): fixed routes first, then groups/:id, then :id/messages and :id. Ids are checked by the client before any URL is built.
    if(path==='/api/prime/bots/health'&&req.method==='GET'){send(200,await hub.botsHealth(abort.signal));return;}
    if(path==='/api/prime/bots/list'&&req.method==='GET'){send(200,await hub.botsList(abort.signal));return;}
    const botsGroup=/^\/api\/prime\/bots\/groups\/([^/]{1,80})$/.exec(path);
    if(botsGroup&&req.method==='GET'){send(200,await hub.botsGroup(decodeURIComponent(botsGroup[1]),abort.signal));return;}
    const botsMessages=/^\/api\/prime\/bots\/([^/]{1,80})\/messages$/.exec(path);
    if(botsMessages&&req.method==='GET'){
     const query=new URL(req.url??'/',url).searchParams;
     send(200,await hub.botsMessages(decodeURIComponent(botsMessages[1]),{since:query.get('since')??undefined,limit:query.has('limit')?Number(query.get('limit')):undefined},abort.signal));return;
    }
    const botsOne=/^\/api\/prime\/bots\/([^/]{1,80})$/.exec(path);
    if(botsOne&&req.method==='GET'){send(200,await hub.botsGet(decodeURIComponent(botsOne[1]),abort.signal));return;}
    if(path==='/api/steward/status'&&req.method==='GET'){send(200,await hub.stewardStatus());return;}
    if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
    const data=await body(req);
    if(path==='/api/prime/build/create'){send(202,await hub.buildCreate(data));return;}
    if(buildAction){
     const id=decodeURIComponent(buildAction[1]),action=buildAction[2];
     if(action==='preview-session'){
      if(Object.keys(data).length)throw new WorkspaceHttpError(400,'Preview session takes no fields');
      const b=hub.buildGet(id);if(!['running','deployed'].includes(b.status))throw new WorkspaceHttpError(409,'Build preview is not running');
      for(const [key,t] of previews)if(t.expires<=Date.now())previews.delete(key);
      // Reuse this owner's existing ticket so polling never reloads the iframe.
      let key=[...previews].find(([,t])=>t.id===id&&t.headers.cookie===req.headers.cookie)?.[0];
      if(!key){if(previews.size>=100)throw new WorkspaceHttpError(429,'Too many preview sessions');key=randomBytes(24).toString('hex');}
      previews.set(key,{id,expires:Date.now()+600000,headers:{cookie:req.headers.cookie,'x-echo-csrf':req.headers['x-echo-csrf']}});
      send(200,{url:'/api/prime/build/'+id+'/preview/'+key+'/',expiresIn:600});return;
     }
     if(['hibernate','revive','stop'].includes(action)&&Object.keys(data).length)throw new WorkspaceHttpError(400,'Build lifecycle action takes no fields');
     if(action==='turn'||action==='turns')send(202,await hub.buildTurn(id,data));
     else if(action==='hibernate')send(200,await hub.buildHibernate(id));
     else if(action==='revive')send(202,await hub.buildRevive(id));
     else if(action==='stop')send(200,await hub.buildStop(id));
     else if(action==='deploy')send(200,await hub.buildDeploy(id,data));
     else if(action==='repository')send(201,await hub.buildRepository(id,data));
     return;
    }
    // Delete is a JSON POST on purpose: the Origin check above applies to POST only, so a DELETE verb would skip it.
    const botsAction=/^\/api\/prime\/bots\/([^/]{1,80})\/(pause|resume|delete|message)$/.exec(path);
    if(path==='/api/search')send(200,{capabilities:await hub.refresh(String(data.query??''))});
    else if(path==='/api/prepare')send(200,await hub.prepare(data as unknown as PrimeRequest));
    else if(path==='/api/execute')send(200,await hub.execute(String(data.id??''),String(data.digest??'')));
    else if(path==='/api/chat')send(200,await hub.chat(data,abort.signal));
    else if(path==='/api/prime/swarm/run')send(202,await hub.swarmRun(data,abort.signal));
    else if(path==='/api/prime/adk/runs')send(202,await hub.adkRun(data,abort.signal));
    else if(adkStop)send(200,await hub.adkStop(decodeURIComponent(adkStop[1]),abort.signal));
    else if(path==='/api/prime/bots/create')send(201,await hub.botsCreate(data,abort.signal));
    else if(path==='/api/prime/bots/groups/create')send(202,await hub.botsGroupCreate(data,abort.signal));
    else if(botsAction&&botsAction[2]==='message')send(202,await hub.botsMessage(decodeURIComponent(botsAction[1]),data,abort.signal));
    else if(botsAction)send(200,await hub.botsAction(decodeURIComponent(botsAction[1]),botsAction[2],abort.signal));
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
