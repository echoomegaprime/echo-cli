import {createServer,type IncomingMessage} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {debuglog} from 'node:util';
import {PrimeHub,object,type PrimeRequest} from './hub.js';
import {redact} from '../code/workspace.js';
import {WorkspaceBridge,WorkspaceHttpError,type WorkspaceConfig} from './workspace.js';
import {ARTIFACT_ID_RE,UPLOAD_ID_RE,UploadStore,parseUploadsConfig,type UploadsConfig} from './uploads.js';
import {BOT_WORKSPACE_OPERATIONS} from './bot-workspace.js';
import {BotsError} from './bots.js';
const assets:Record<string,string>={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/orb.js':'orb.js','/app.js':'app.js','/chat.js':'chat.js','/integrations.js':'integrations.js','/catalog.js':'catalog.js','/steward.js':'steward.js','/workspace-client.js':'workspace-client.js','/workspace.js':'workspace.js','/models.js':'models.js'};
assets['/swarm.js']='swarm.js';assets['/swarm.css']='swarm.css';
assets['/agents.js']='agents.js';assets['/agents.css']='agents.css';
assets['/bots.js']='bots.js';assets['/bots.css']='bots.css';
for(const name of ['bot-workspace.js','bots-oauth-callback.html','bots-oauth-callback.js'])assets['/'+name]=name;
assets['/browser.js']='browser.js';assets['/browser.css']='browser.css';
assets['/build.js']='build.js';assets['/build.css']='build.css';
const debug=debuglog('echo-prime-server');
assets['/privacy']='privacy.html';assets['/privacy.css']='privacy.css';
Object.assign(assets,{'/fleet.js':'fleet.js','/logs.js':'logs.js','/fleet.css':'fleet.css'});
for(const name of ['composer.js','voicebar.js','plugins.js','composer.css','speech.js','speech.css'])assets['/'+name]=name;
Object.assign(assets,{'/views.js':'views.js','/views.css':'views.css','/library.js':'library.js','/library.css':'library.css'});
for(const name of ['layout.js','esh-dock.js','chat-actions.js'])assets['/'+name]=name;
Object.assign(assets,{'/nav.js':'nav.js','/nav.css':'nav.css','/privacy.html':'privacy.html'});
Object.assign(assets,{'/autoagents.js':'autoagents.js','/autoagents.css':'autoagents.css'});
Object.assign(assets,{'/activity.js':'activity.js','/activity.css':'activity.css'});
assets['/systems.js']='systems.js';
Object.assign(assets,{'/rail.js':'rail.js','/rail.css':'rail.css'});
Object.assign(assets,{'/videoagent.js':'videoagent.js','/videoagent.css':'videoagent.css'});
// The Echo orb mark answers the browser's default /favicon.ico probe as well as the linked /favicon.svg (both the same SVG).
assets['/favicon.svg']='favicon.svg';assets['/favicon.ico']='favicon.svg';
const assetTypes:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
Object.assign(assets,{'/brain.js':'brain.js','/brain.css':'brain.css'});
assets['/autonomy.js']='autonomy.js';
Object.assign(assets,{'/media-router.js':'media-router.js','/media.css':'media.css'});
async function body(req:IncomingMessage,maxBytes=131072){
 let size=0;const chunks:Buffer[]=[];
 for await(const part of req){size+=part.length;if(size>maxBytes)throw new Error('Request exceeds size limit');chunks.push(part);}
 return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
/** `admission.waitMs`: how long a request that finds no free slot waits for one before 429 (default 3000; tests shorten it). */
export interface PrimeServerOptions {workspace?:WorkspaceConfig;publicOrigin?:string;uploads?:UploadsConfig|UploadStore|unknown;admission?:{waitMs?:number}}
// Admission (live test 2026-11-06): the process-wide cap stays 8 concurrent non-media requests, but one client may hold at
// most 6 of them and the last slot is kept for the /api/session admission read, so one page's long turns or boot burst can
// never lock another visitor out of booting. A request that finds no slot waits briefly for one (first come, first served,
// skipping a client already at its cap) before the 429. A client is its Workspace session (hashed), else its edge address.
const MAX_ACTIVE=8,PER_CLIENT=6,SESSION_RESERVE=1,MAX_WAITING=64;
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
 const uploadStore=options.uploads instanceof UploadStore?options.uploads:options.uploads!==undefined?new UploadStore(parseUploadsConfig(options.uploads)):hub.uploads;
 const workspace=options.workspace?new WorkspaceBridge(options.workspace,!!externalOrigin,uploadStore):undefined;
 if(workspace)await workspace.validateBackend();
 const token=randomBytes(32).toString('hex');let url='',active=0,mediaActive=0;
 const waitMs=Math.max(0,Math.min(10000,Number(options.admission?.waitMs??3000)||0));
 const perClient=new Map<string,number>(),waiting:{key:string;session:boolean;resolve:(ok:boolean)=>void;timer:NodeJS.Timeout}[]=[];
 const fits=(key:string,session:boolean)=>active<(session?MAX_ACTIVE:MAX_ACTIVE-SESSION_RESERVE)&&(perClient.get(key)??0)<PER_CLIENT;
 const take=(key:string)=>{active++;perClient.set(key,(perClient.get(key)??0)+1);};
 const release=(key:string)=>{
  active--;const left=(perClient.get(key)??1)-1;if(left>0)perClient.set(key,left);else perClient.delete(key);
  for(let i=0;i<waiting.length;){const next=waiting[i];if(fits(next.key,next.session)){waiting.splice(i,1);clearTimeout(next.timer);take(next.key);next.resolve(true);}else i++;}
 };
 const admit=(key:string,session:boolean)=>{
  if(fits(key,session)){take(key);return Promise.resolve(true);}
  if(!waitMs||waiting.length>=MAX_WAITING)return Promise.resolve(false);
  return new Promise<boolean>(resolve=>{const entry={key,session,resolve,timer:setTimeout(()=>{const at=waiting.indexOf(entry);if(at>=0)waiting.splice(at,1);resolve(false);},waitMs)};waiting.push(entry);});
 };
 // Opaque-origin sandbox frames cannot send owner headers or SameSite cookies. A short-lived, build-only read ticket is
 // minted by an authenticated JSON POST. Its captured session is revalidated on every resource; never sent to the app.
 const previews=new Map<string,{id:string;expires:number;headers:IncomingMessage['headers']}>();
 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  // Behind the public TLS proxy Cloudflare may inject its Web Analytics beacon; only a server with a public origin allows those two origins.
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'"+(workspace?' https://accounts.google.com/gsi/client':'')+(externalOrigin?' https://static.cloudflareinsights.com':'')+"; style-src 'self' 'unsafe-inline'"+(workspace?' https://accounts.google.com/gsi/style':'')+"; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'"+(workspace?' https://accounts.google.com':'')+(externalOrigin?' https://cloudflareinsights.com':'')+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src 'self'"+(workspace?' https://accounts.google.com':''));
  res.setHeader('Permissions-Policy','microphone=(self), camera=()');
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const expectedOrigin=externalOrigin??url;
  if(req.headers.host!==new URL(expectedOrigin).host){send(403,{error:'Unrecognized host'});return;}
  const path=new URL(req.url??'/',url).pathname;
  if(path==='/bots-oauth-callback.html')res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'");
  if(path.startsWith('/api/')){
   const started=Date.now(),requestId=randomUUID();
   const operation=path.startsWith('/api/prime/media/')?'media':path==='/api/prime/enhance'?'enhance':path.startsWith('/api/workspace/')?'workspace':path.startsWith('/api/steward/')?'steward':path.startsWith('/api/prime/swarm/')?'swarm':path.startsWith('/api/prime/voice/')?'voice':path.startsWith('/api/prime/adk/')?'adk':path.startsWith('/api/prime/bots/')?'bots':path.startsWith('/api/prime/browser/')?'browser':path.startsWith('/api/prime/build/')?'build':path.startsWith('/api/prime/video/')?'video':path==='/api/prime/uploads'||path.startsWith('/api/prime/uploads/')?'uploads':path==='/api/prime/artifacts'||path.startsWith('/api/prime/artifacts/')?'artifacts':path==='/api/session'?'session':'owner';
   const record=(outcome:string)=>debug('%j',{schemaVersion:1,event:'prime_api_request',operation,requestId,status:res.statusCode,outcome,durationMs:Date.now()-started});
   res.once('finish',()=>record('returned'));res.once('close',()=>{if(!res.writableEnded)record('disconnected');});
   const supplied=(req.headers.cookie??'').split(';').map(c=>c.trim()).find(c=>c.startsWith('echo_prime='))?.slice(11)??'';
   const allowed=/^[0-9a-f]{64}$/.test(supplied)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
   const previewRoute=/^\/api\/prime\/build\/([a-f0-9]{32})\/preview\/([a-f0-9]{48})\/(.*)$/.exec(path);
   const previewTicket=previewRoute?previews.get(previewRoute[2]):undefined;
   const previewRead=!!previewRoute&&req.method==='GET'&&previewTicket?.id===previewRoute[1]&&previewTicket.expires>Date.now()&&[undefined,'null',expectedOrigin].includes(req.headers.origin);
   const mediaFileGet=req.method==='GET'&&(/^\/api\/prime\/uploads\/upl_[0-9a-f]{32}\/file$/.test(path)||/^\/api\/prime\/artifacts\/art_[0-9a-f]{32}\/file$/.test(path));
   const fetchSite=req.headers['sec-fetch-site'];
   if(!previewRead&&(!allowed||(!mediaFileGet&&req.headers['x-prime-request']!=='1')||fetchSite==='cross-site'||(mediaFileGet&&fetchSite==='same-site')||(req.headers.origin!==undefined&&req.headers.origin!==expectedOrigin)||(req.method==='POST'&&req.headers.origin!==expectedOrigin))){send(403,{error:'Same-origin Prime session required'});return;}
   let admitted:string|null=null;
   if(mediaFileGet){if(mediaActive>=24){send(429,{error:'Too many requests'});return;}mediaActive++;}
   else{
    const workspaceSession=/(?:^|;\s*)echo_workspace_session=([A-Za-z0-9_-]{32,128})(?:;|$)/.exec(req.headers.cookie??'')?.[1],edge=req.headers['cf-connecting-ip'];
    const key=workspaceSession?'s:'+createHash('sha256').update(workspaceSession).digest('hex').slice(0,32):'a:'+(externalOrigin&&typeof edge==='string'&&edge.length<=64?edge:req.socket.remoteAddress??'local');
    if(!await admit(key,path==='/api/session'&&req.method==='GET')){res.setHeader('Retry-After','1');send(429,{error:'Too many requests'});return;}
    admitted=key;
    if(res.destroyed||res.writableEnded){release(key);return;}// the client left while it waited
   }
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
    if(path==='/api/prime/uploads'||path.startsWith('/api/prime/uploads/')||path==='/api/prime/artifacts'||path.startsWith('/api/prime/artifacts/')){
     const uid=workspace?(await workspace.requireApproved(req,abort.signal,!mediaFileGet)).uid:'local';
     if(path==='/api/prime/uploads/list'&&req.method==='GET'){
      if(!uploadStore){send(200,{configured:false,maxBytes:0,types:[],uploads:[],reason:'Uploads are not enabled: add an `uploads` section to the Prime config'});return;}
      const q=new URL(req.url??'/',url).searchParams;
      send(200,{configured:true,maxBytes:uploadStore.config.maxBytes,types:uploadStore.config.types,uploads:await uploadStore.list(uid,{kind:q.get('kind')??undefined,q:q.get('q')??undefined})});return;
     }
     if(path==='/api/prime/artifacts'&&req.method==='GET'){
      if(!uploadStore){send(200,{configured:false,artifacts:[],reason:'Artifact Center is not enabled: add an `uploads` section to the Prime config'});return;}
      const q=new URL(req.url??'/',url).searchParams;
      send(200,{configured:true,artifacts:await uploadStore.listArtifacts(uid,{kind:q.get('kind')??undefined,source:q.get('source')??undefined,q:q.get('q')??undefined})});return;
     }
     if(!uploadStore){send(503,{error:'Uploads are not enabled: add an `uploads` section to the Prime config'});return;}
     if(path==='/api/prime/uploads'&&req.method==='POST'){send(201,await uploadStore.handleUpload(req,uid));return;}
     const uploadMeta=/^\/api\/prime\/uploads\/([^/]+)$/.exec(path);
     if(uploadMeta&&req.method==='GET'&&uploadMeta[1]!=='list'){
      const id=decodeURIComponent(uploadMeta[1]);if(!UPLOAD_ID_RE.test(id)){send(400,{error:'Invalid upload id'});return;}
      send(200,await uploadStore.get(uid,id));return;
     }
     const uploadFile=/^\/api\/prime\/uploads\/([^/]+)\/file$/.exec(path);
     if(uploadFile&&req.method==='GET'){
      const id=decodeURIComponent(uploadFile[1]);if(!UPLOAD_ID_RE.test(id)){send(400,{error:'Invalid upload id'});return;}
      const q=new URL(req.url??'/',url).searchParams;
      await uploadStore.serveFile(req,res,uid,id,{thumb:q.get('thumb')==='1',download:q.get('download')==='1'});return;
     }
     const uploadAction=/^\/api\/prime\/uploads\/([^/]+)\/(delete|update)$/.exec(path);
     if(uploadAction){
      if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
      const id=decodeURIComponent(uploadAction[1]);if(!UPLOAD_ID_RE.test(id)){send(400,{error:'Invalid upload id'});return;}
      const patch=await body(req);
      send(200,uploadAction[2]==='delete'?await uploadStore.remove(uid,id):await uploadStore.update(uid,id,patch));return;
     }
     if(path==='/api/prime/artifacts'&&req.method==='POST'){
      if(!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
      send(201,await uploadStore.registerArtifact(uid,await body(req,2_200_000)));return;
     }
     const artMeta=/^\/api\/prime\/artifacts\/([^/]+)$/.exec(path);
     if(artMeta&&req.method==='GET'){
      const id=decodeURIComponent(artMeta[1]);if(!ARTIFACT_ID_RE.test(id)){send(400,{error:'Invalid artifact id'});return;}
      send(200,await uploadStore.getArtifact(uid,id));return;
     }
     const artFile=/^\/api\/prime\/artifacts\/([^/]+)\/file$/.exec(path);
     if(artFile&&req.method==='GET'){
      const id=decodeURIComponent(artFile[1]);if(!ARTIFACT_ID_RE.test(id)){send(400,{error:'Invalid artifact id'});return;}
      const q=new URL(req.url??'/',url).searchParams;
      await uploadStore.serveArtifactFile(req,res,uid,id,q.get('download')!=='0');return;
     }
     const artDelete=/^\/api\/prime\/artifacts\/([^/]+)\/delete$/.exec(path);
     if(artDelete){
      if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
      const id=decodeURIComponent(artDelete[1]);if(!ARTIFACT_ID_RE.test(id)){send(400,{error:'Invalid artifact id'});return;}
      await body(req);send(200,await uploadStore.removeArtifact(uid,id));return;
     }
     send(404,{error:'Unknown uploads or artifacts route'});return;
    }
    if(workspace)await workspace.requireOwner(req,abort.signal);
    if(path==='/api/prime/voice/status'&&req.method==='GET'){send(200,await hub.voiceStatus(abort.signal));return;}
    // Personality catalog loader bound to this owner request's Workspace cookie; the forge caches it 60 s. Absent without a Workspace (built-in catalog).
    const personalities=workspace?()=>workspace.personalities(req,abort.signal):undefined;
    if(path==='/api/status'&&req.method==='GET'){send(200,await hub.status());return;}
    if(path==='/api/prime/models'&&req.method==='GET'){send(200,await hub.models());return;}
    // Live tools (owner-only like models): GET the report, POST a per-family or global toggle.
    if(path==='/api/prime/tools'&&req.method==='GET'){send(200,hub.liveTools());return;}
    if(path==='/api/prime/personality'&&req.method==='GET'){send(200,await hub.personality(personalities));return;}
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
    // Video agent builder (owner-only, below requireOwner): status here; plan / agent / run are JSON POSTs after the method gate.
    if(path==='/api/prime/video/status'&&req.method==='GET'){send(200,hub.videoStatus());return;}
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
    // Agent definitions Prime creates: POST create / :name/update / :name/delete (JSON POST for all three so the Origin check applies, like bots).
    const adkAgentAction=/^\/api\/prime\/adk\/agents\/([^/]{1,80})\/(update|delete)$/.exec(path);
    // echoBots (owner-only like swarm): fixed routes first, then groups/:id, then :id/messages and :id. Ids are checked by the client before any URL is built.
    if(path==='/api/prime/bots/health'&&req.method==='GET'){send(200,await hub.botsHealth(abort.signal));return;}
    if(path==='/api/prime/bots/list'&&req.method==='GET'){send(200,await hub.botsList(abort.signal));return;}
    const botWorkspace=/^\/api\/prime\/bots\/workspace\/([a-z.]{1,60})$/.exec(path);
    if(botWorkspace&&req.method==='GET'){
     if(!Object.hasOwn(BOT_WORKSPACE_OPERATIONS,botWorkspace[1])||BOT_WORKSPACE_OPERATIONS[botWorkspace[1]].method!=='GET')throw new WorkspaceHttpError(405,'This workspace operation requires JSON POST');
     const query=new URL(req.url??'/',url).searchParams,params:Record<string,unknown>={};
     for(const [key,value] of query){if(Object.hasOwn(params,key))throw new WorkspaceHttpError(400,'Duplicate query parameter');params[key]=['limit','before'].includes(key)?Number(value):value;}
     send(200,await hub.botsWorkspace(botWorkspace[1],params,abort.signal));return;
    }
    const botsGroup=/^\/api\/prime\/bots\/groups\/([^/]{1,80})$/.exec(path);
    if(botsGroup&&req.method==='GET'){send(200,await hub.botsGroup(decodeURIComponent(botsGroup[1]),abort.signal));return;}
    const botsMessages=/^\/api\/prime\/bots\/([^/]{1,80})\/messages$/.exec(path);
    if(botsMessages&&req.method==='GET'){
     const query=new URL(req.url??'/',url).searchParams;
     send(200,await hub.botsMessages(decodeURIComponent(botsMessages[1]),{since:query.get('since')??undefined,limit:query.has('limit')?Number(query.get('limit')):undefined},abort.signal));return;
    }
    const botsOne=/^\/api\/prime\/bots\/([^/]{1,80})$/.exec(path);
    if(botsOne&&req.method==='GET'){send(200,await hub.botsGet(decodeURIComponent(botsOne[1]),abort.signal));return;}
    if(path==='/api/prime/browser/status'&&req.method==='GET'){send(200,await hub.browserStatus(abort.signal));return;}
    if(path==='/api/prime/browser/tabs'&&req.method==='GET'){send(200,{tabs:await hub.browserTabs(abort.signal)});return;}
    const browserSnap=/^\/api\/prime\/browser\/snapshot\/([0-9]{1,16})$/.exec(path);
    if(browserSnap&&req.method==='GET'){send(200,await hub.browserSnapshot(Number(browserSnap[1]),new URL(req.url??'/',url).searchParams.get('shot')==='1',abort.signal));return;}
    if(path==='/api/steward/status'&&req.method==='GET'){send(200,await hub.stewardStatus());return;}
    if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
    const data=await body(req,botWorkspace?1048576:131072);
    if(botWorkspace){send(200,await hub.botsWorkspace(botWorkspace[1],data,abort.signal));return;}
    if(path==='/api/prime/voice/speak'){const out=await hub.voiceSpeak(data,abort.signal);res.writeHead(200,{'Content-Type':out.contentType,'Content-Length':out.bytes,'X-Echo-Voice-Provider':out.provider,'X-Echo-Voice-Label':encodeURIComponent(out.label),'X-Echo-Voice-Model':out.model,'X-Echo-Voice-Chars':String(out.chars)});res.end(out.audio);return;}
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
    const botsAction=/^\/api\/prime\/bots\/([^/]{1,80})\/(pause|resume|stop|update|delete|message|events)$/.exec(path);
    if(path==='/api/search')send(200,{capabilities:await hub.refresh(String(data.query??''))});
    else if(path==='/api/prepare')send(200,await hub.prepare(data as unknown as PrimeRequest));
    else if(path==='/api/execute')send(200,await hub.execute(String(data.id??''),String(data.digest??'')));
    else if(path==='/api/chat')send(200,await hub.chat(data,abort.signal,personalities?{personalities}:{}));
    else if(path==='/api/prime/tools')send(200,hub.liveToolsUpdate(data));
    else if(path==='/api/chat/verify')send(200,await hub.verify(data,abort.signal));
    else if(path==='/api/prime/personality')send(200,await hub.personalitySettings(data));
    else if(path==='/api/prime/personality/select')send(200,await hub.personalitySelect(data,personalities));
    else if(path==='/api/prime/swarm/run')send(202,await hub.swarmRun(data,abort.signal));
    else if(path==='/api/prime/adk/runs')send(202,await hub.adkRun(data,abort.signal));
    else if(adkStop)send(200,await hub.adkStop(decodeURIComponent(adkStop[1]),abort.signal));
    else if(path==='/api/prime/adk/agents')send(201,await hub.adkCreateAgent(data,abort.signal));
    else if(path==='/api/prime/video/plan')send(200,await hub.videoPlan(data,abort.signal));
    else if(path==='/api/prime/video/agent'){const made=await hub.videoAgent(data,abort.signal);send(made.existing?200:201,made);}
    else if(path==='/api/prime/video/run')send(202,await hub.videoRun(data,abort.signal));
    else if(adkAgentAction&&adkAgentAction[2]==='update')send(200,await hub.adkUpdateAgent(decodeURIComponent(adkAgentAction[1]),data,abort.signal));
    else if(adkAgentAction)send(200,await hub.adkDeleteAgent(decodeURIComponent(adkAgentAction[1]),abort.signal));
    else if(path==='/api/prime/bots/create')send(201,await hub.botsCreate(data,abort.signal));
    else if(path==='/api/prime/bots/groups/create')send(202,await hub.botsGroupCreate(data,abort.signal));
    else if(botsAction&&botsAction[2]==='update')send(200,await hub.botsUpdate(decodeURIComponent(botsAction[1]),data,abort.signal));
    else if(botsAction&&botsAction[2]==='events')send(202,await hub.botsEvent(decodeURIComponent(botsAction[1]),data,abort.signal));
    else if(botsAction&&botsAction[2]==='message')send(202,await hub.botsMessage(decodeURIComponent(botsAction[1]),data,abort.signal));
    else if(botsAction)send(200,await hub.botsAction(decodeURIComponent(botsAction[1]),botsAction[2],abort.signal));
    else if(path==='/api/prime/browser/act')send(200,await hub.browserAct(data,abort.signal));
    else if(path==='/api/steward/ask')send(200,await hub.stewardAsk(data));
    // Media auto-router (spends nothing) and Enhance prompt (rate-limited per Prime session: the cookie hash, never the cookie).
    else if(path==='/api/prime/media/route')send(200,await hub.mediaRoute(data,abort.signal));
    // A Studio request's progress and result, by the request id its review ticket carried (no capability, job or URL).
    else if(path==='/api/prime/media/job')send(200,hub.mediaJob(data));
    else if(path==='/api/prime/enhance')send(200,await hub.enhance(data,createHash('sha256').update(supplied).digest('hex'),abort.signal));
    // Members view (owner-only, below requireOwner): one account's upload count and bytes, from its metadata only.
    else if(path==='/api/prime/members/uploads'){
     const keys=Object.keys(data);
     if(keys.length!==1||keys[0]!=='uid'||typeof data.uid!=='string'||!/^[A-Za-z0-9_.:@+-]{1,200}$/.test(data.uid))throw new WorkspaceHttpError(400,'Member uploads take exactly one account uid');
     send(200,uploadStore?await uploadStore.usage(data.uid):{configured:false,count:0,bytes:0});
    }
    else send(404,{error:'Unknown route'});
   }catch(e){if(res.headersSent)res.destroy();else send(e instanceof WorkspaceHttpError?e.status:400,{error:redact(e instanceof Error?e.message:'Request failed').slice(0,600),...(e instanceof BotsError?{source:'bot_service',code:e.code,outcome_unknown:e.outcomeUnknown,...(e.details?{details:e.details}:{})}:{})});}
   finally{res.removeListener('close',disconnected);if(mediaFileGet)mediaActive--;else if(admitted!==null)release(admitted);}
   return;
  }
  // HEAD mirrors GET for a static asset (status, type, length and the session cookie on the page) without a body; the
  // API above keeps its own method rules. The type follows the served file, so /favicon.ico is the SVG mark.
  const head=req.method==='HEAD';
  if((req.method!=='GET'&&!head)||!assets[path]){send(404,{error:'Not found'});return;}
  try{
   const file=assets[path],data=await readFile(join(uiDirectory,file));
   if(path==='/'||path==='/index.html')res.setHeader('Set-Cookie','echo_prime='+token+'; HttpOnly; SameSite=Strict; Path=/'+(externalOrigin?'; Secure':''));
   res.writeHead(200,{'Content-Type':assetTypes[file.slice(file.lastIndexOf('.'))]??'application/octet-stream','Content-Length':data.length});res.end(head?undefined:data);
  }catch{send(404,{error:'Asset unavailable'});}
 });
 server.requestTimeout=25000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string'){reject(new Error('Local listener unavailable'));return;}url='http://127.0.0.1:'+a.port;resolve();});});
 return {url,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
