import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {createServer,createConnection} from 'node:net';
import {delimiter, isAbsolute, join, resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {debuglog} from 'node:util';
import {childEnv} from '../code/providers.js';
import {redact} from '../code/workspace.js';
import {validateEndpoint} from '../code/model.js';
import {WorkspaceHttpError} from './workspace.js';

export const BUILD_ENGINES = ['gpt', 'grok', 'gemini', 'claude'] as const;
export type BuildEngine = typeof BUILD_ENGINES[number];
export type BuildStatus = 'queued'|'scaffolding'|'building'|'qa'|'running'|'deployed'|'hibernated'|'failed';
export interface BuildConfig {
 root: string; engines: BuildEngine[]; previewBase?: string; maxConcurrent?: number;
 deploy?: {forge?: {unitPrefix: string}; vercel?: boolean};
}
export interface BuildEvent {seq: number; at: string; event: string; message: string}
export interface Build {
 build_id: string; title: string; prompt: string; engine: BuildEngine; status: BuildStatus; workspace: string;
 preview: {port: number; url: string}; repo?: {url: string; branch: string}; log: BuildEvent[];
 created_at: string; updated_at: string;
}
export const BUILD_LIMITS = {wallMs: 1_800_000, readyMs: 30_000, logBytes: 1_048_576, logEvents: 1000, lineChars: 8000, previewBytes: 5*1024*1024, builds: 100, promptChars: 12000, poolSize: 20} as const;
export class BuildError extends WorkspaceHttpError {}
const debug = debuglog('echo-prime');
const stamp = () => new Date().toISOString();
const trace = (event: string, detail: Record<string, unknown> = {}) => debug('%j', {schemaVersion: 1, event: 'prime_build_'+event, ...detail});
const BIN: Record<BuildEngine,string> = {gpt:'codex', grok:'grok', gemini:'agy', claude:'claude'};
const STATUSES = new Set<BuildStatus>(['queued','scaffolding','building','qa','running','deployed','hibernated','failed']);
function object(value: unknown, keys: string[], what: string): Record<string,unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BuildError(400, what+' must be an object');
 const data = value as Record<string,unknown>;
 if (Object.keys(data).some(k => !keys.includes(k))) throw new BuildError(400, what+': unknown field');
 return data;
}
export function buildId(id: unknown): string {
 if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new BuildError(400,'Invalid build id');
 return id;
}
export function parseBuildConfig(value: unknown): BuildConfig {
 const v = object(value,['root','engines','previewBase','maxConcurrent','deploy'],'build configuration');
 if (typeof v.root !== 'string' || !isAbsolute(v.root) || [...v.root].some(c=>c.charCodeAt(0)<32) || resolve(v.root) === resolve(v.root,'..')) throw new BuildError(400,'build root must be an absolute, dedicated directory');
 if(process.platform==='win32'&&/[&|<>^%!"]/.test(v.root))throw new BuildError(400,'build root contains characters unsafe for Windows CLI shims');
 if (!Array.isArray(v.engines) || !v.engines.length || v.engines.some(e => !BUILD_ENGINES.includes(e)) || new Set(v.engines).size !== v.engines.length) throw new BuildError(400,'build engines must be distinct gpt, grok, gemini or claude');
 const maxConcurrent = v.maxConcurrent ?? 1;
 if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new BuildError(400,'build maxConcurrent must be 1..4');
 let previewBase = 'http://127.0.0.1:8400';
 if (v.previewBase !== undefined) {
  try { if(typeof v.previewBase !== 'string')throw new Error(); previewBase=validateEndpoint(v.previewBase).origin; }
  catch { throw new BuildError(400,'build previewBase must be a credential-free loopback origin'); }
 }
 const url = new URL(previewBase), port = Number(url.port);
 if (url.protocol !== 'http:' || !port || port < 1024 || port + BUILD_LIMITS.poolSize > 65536) throw new BuildError(400,'build previewBase must be HTTP with a port in 1024..65516');
 let deploy: BuildConfig['deploy'];
 if (v.deploy !== undefined) {
  const d = object(v.deploy,['forge','vercel'],'build deploy'); deploy={};
  if (d.vercel !== undefined) { if(typeof d.vercel !== 'boolean')throw new BuildError(400,'build vercel must be boolean'); deploy.vercel=d.vercel; }
  if (d.forge !== undefined) {
   const f=object(d.forge,['unitPrefix'],'build forge');
   if(typeof f.unitPrefix !== 'string'||!/^[a-z][a-z0-9-]{0,39}$/.test(f.unitPrefix))throw new BuildError(400,'Invalid Forge unitPrefix');
   deploy.forge={unitPrefix:f.unitPrefix};
  }
 }
 return {root:resolve(v.root), engines:[...v.engines] as BuildEngine[], previewBase, maxConcurrent, ...(deploy?{deploy}:{})};
}
/** Includes bearer/cookie forms the shared code redactor does not cover. Never log raw CLI chunks. */
export function redactBuild(text: string): string {
 return redact(text.replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[=:][^\r\n]*/gi,'[REDACTED HEADER]')
  .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
  .replace(/((?:[a-z0-9_]*token|[a-z0-9_]*secret|[a-z0-9_]*password|[a-z0-9_]*api_key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,'$1[REDACTED]')
  .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi,'https://[REDACTED]@'));
}
function inputText(value: unknown, max: number, name: string): string {
 if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))throw new BuildError(400, name+' must contain 1..'+max+' characters');
 if (redactBuild(value)!==value || /-----BEGIN .*PRIVATE KEY-----/.test(value))throw new BuildError(400,'Do not include credentials in '+name);
 return value.trim();
}
/** A contract for the engine, not a claim of OS-level isolation. No reference-export code is executed or copied. */
export function buildContract(build: Build): string {
 return `# Echo Build workspace contract\n\nBuild ${build.build_id}; engine ${build.engine}. Work only in this workspace.\n\n`+
 `1. Triage the request before scaffolding. A greeting, empty request or question is not an app: explain and exit without fabricating success. For a build request choose a real web app (Vite/React or TanStack Start), Node/Python API or program, CLI, or static site according to the requested product. Follow-up turns edit the existing app; preserve user data.\n`+
 `2. Implement actual routes, behavior, error handling and tests. No mock features, placeholder screens or invented integrations. Use SQLite or Postgres with migrations only when durable data is requested. Sign-in is off unless needed; when needed use Echo echo-auth, verified server-side identities and per-user authorization. Discover its documented interface; if unavailable, report that dependency instead of inventing auth or reading credentials.\n`+
 `3. Never read, write or print credentials. Do not open home credential stores, parent directories, other workspaces or repository metadata outside this build. No secrets in source, logs, client code or env files. Engines use their own existing login. No provider fallback, deployment, remote repositories, system services or global installs.\n`+
 `4. Supply package.json with a real npm run build gate, including for a Python program or CLI (it must validate/package that program). Dependencies may be installed locally. Write startup.sh with LF endings, set -eu, cd to its own directory and exec the foreground server. It must use PORT (default ${build.preview.port}), HOST=0.0.0.0 and ECHO_BUILD_BASE=/; the local app serves at /. In browser code resolve computed fetch/asset URLs with new URL(relativePath, document.baseURI), and derive the client router base from document.baseURI. The proxy supplies a different document base; never hard-code Prime paths or preview tickets. No daemonizing, nohup, detached children or background '&'. The runner owns the process and re-runs this file on revive. Python/CLI builds also need a small HTTP entry point showing real program output/usage and health, alongside the actual program.\n`+
 `5. npm run build must pass. Start the app through startup.sh on 0.0.0.0:${build.preview.port}, test it, then stop your own temporary preview before exiting. The runner will launch startup.sh and leave that supervised server up. No other ports or listeners. Never kill an existing port owner.\n`+
 `6. Install Playwright locally and run headless browser QA against http://127.0.0.1:${build.preview.port}/: desktop and mobile visible content, clean console/assets, and the main interaction. Save screenshots under screenshots/. Never open a browser window. Verify built output as well as dev behavior. The runner independently repeats the build and headless smoke gate; missing browser dependencies fail, never bypass QA.\n`+
 `7. Preview is a sandboxed GET-only proxy: no WebSockets/HMR, cookies, service workers, cross-origin resources, authenticated app sessions or mutating API calls in the embedded preview. Bundle assets locally. Use full-page refresh after edits. Apps remain full programs in this workspace; test data writes and echo-auth through their direct app test harness, and document embedded-preview limits.\n`+
 `8. Emit useful progress and structured debug logs without secrets. Report actual results and remaining dependencies. Never claim a deploy or repository push.\n`;
}
export interface BuildCommand {cmd: string; args: string[]; input?: string; projectEnv?: {VERCEL_ORG_ID:string;VERCEL_PROJECT_ID:string}}
export function engineCommand(engine: BuildEngine, workspace: string, promptFile: string, prompt: string): BuildCommand {
 switch(engine) {
  case 'gpt': return {cmd:'codex',args:['exec','-C',workspace,'-s','workspace-write','--skip-git-repo-check','-'],input:prompt};
  case 'grok': return {cmd:'grok',args:['--cwd',workspace,'--always-approve','--prompt-file',promptFile]};
  case 'gemini': return {cmd:'agy',args:['--mode','auto','--dangerously-skip-permissions','--add-dir',workspace,'-p=Read AGENTS.md and '+promptFile+' and implement the requested build.']};
  case 'claude': return {cmd:'claude',args:['-p','--permission-mode','acceptEdits','--output-format','text','--setting-sources','project','--strict-mcp-config'],input:prompt};
 }
}
/** Resolve Windows npm shims without shell:true or interpolated command strings. PowerShell receives only encoded literal argv. */
export function spawnBuild(command: BuildCommand, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
 let {cmd,args}=command;
 if(process.platform==='win32'&&cmd==='bash') {
  const paths=(env.Path??env.PATH??'').split(delimiter);
  const candidates=[...paths.filter(dir=>existsSync(join(dir,'git.exe'))).map(dir=>resolve(dir,'../bin/bash.exe')),join(process.env.ProgramFiles??'C:\\Program Files','Git','bin','bash.exe')];
  const bash=candidates.find(p=>existsSync(p));
  if(!bash)throw new BuildError(503,'Git Bash is required for startup.sh on Windows; WSL is not used');cmd=bash;
 }
 if(process.platform==='win32' && !/\.exe$/i.test(cmd)) {
  const found=(env.Path??env.PATH??'').split(delimiter).flatMap(dir=>['.exe','.cmd','.bat'].map(ext=>join(dir,cmd+ext))).find(p=>existsSync(p)&&lstatSync(p).isFile());
  if(found && /\.(cmd|bat)$/i.test(found)) {
   const literal=(v:string)=>"'"+v.replace(/'/g,"''")+"'";
   const script='& '+literal(found)+' '+args.map(literal).join(' ')+'\nexit $LASTEXITCODE';
   cmd=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
   args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  } else if(found)cmd=found;
 }
 return spawn(cmd,args,{cwd,env,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
}
async function killTree(child: ChildProcess): Promise<void> {
 if(!child.pid)return;
 if(process.platform==='win32') {
  if(child.exitCode!==null || child.signalCode!==null)return;
  await new Promise<void>((done,reject)=>{
   const killer=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore',env:childEnv()});
   const timer=setTimeout(()=>{killer.kill();reject(new BuildError(503,'Process tree stop timed out'));},10000);
   killer.once('error',()=>{clearTimeout(timer);reject(new BuildError(503,'Process tree stop unavailable'));});
   killer.once('exit',()=>{clearTimeout(timer);done();});
  });
 } else { try{process.kill(-child.pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;} }
}
async function portFree(port: number): Promise<boolean> {
 // On Windows, a wildcard bind may coexist with an existing specific-address listener. Check both before reserving.
 const listening=await new Promise<boolean>(resolve=>{
  const socket=createConnection({host:'127.0.0.1',port});let settled=false;
  const finish=(value:boolean)=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
  socket.setTimeout(500,()=>finish(true));socket.once('connect',()=>finish(true));socket.once('error',(e:NodeJS.ErrnoException)=>finish(e.code!=='ECONNREFUSED'));
 });
 if(listening)return false;
 return new Promise(resolve=>{const s=createServer();s.once('error',()=>resolve(false));s.listen({port,host:'0.0.0.0',exclusive:true},()=>s.close(()=>resolve(true)));});
}
const delay=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 const abort=()=>{clearTimeout(t);reject(new BuildError(409,'Build interrupted'));};
 const t=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
});
interface ProcessResult {code: number|null; output: string}
interface Entry {build: Build; seq: number; bytes: number; children: Set<ChildProcess>; controller?: AbortController; task?: Promise<void>; mode: 'build'|'revive'; nextPrompt: string; dirty?: ReturnType<typeof setTimeout>; transient?: boolean; stopping?: boolean; heldPort?: boolean; recovered?: boolean}
export interface BuildRunnerOptions {
 /** Host/test injection only; never configurable by HTTP or JSON. */
 engine?: (engine:BuildEngine,workspace:string,file:string,prompt:string)=>BuildCommand;
 launch?: typeof spawnBuild; ports?: number[]; wallMs?: number; readyMs?: number;
 qa?: (build:Build,signal:AbortSignal)=>Promise<void>;
}
const QA_SCRIPT = `import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({headless:true});
try {await mkdir('screenshots',{recursive:true});for(const [name,width,height] of [['desktop',1280,800],['mobile',390,844]]) {
 const page=await browser.newPage({viewport:{width,height}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('response',r=>{if(r.status()>=400)errors.push('HTTP '+r.status());});
 const r=await page.goto('http://127.0.0.1:'+process.env.PORT+'/',{waitUntil:'networkidle',timeout:15000});
 if(!r?.ok())throw Error('Preview HTTP failure');
 const visible=await page.locator('body').evaluate(e=>e.getBoundingClientRect().height>0&&(e.innerText.trim().length>0||!!e.querySelector('canvas,img,svg')));
 if(!visible||errors.length)throw Error('Browser QA failed: visible='+visible+' errors='+errors.length);
 await page.screenshot({path:'screenshots/echo-build-'+name+'.png',fullPage:true});await page.close();
}console.log(JSON.stringify({event:'prime_build_browser_qa',ok:true,viewports:2}));}finally{await browser.close();}`;

export class BuildRunner {
 readonly config: BuildConfig;
 private entries=new Map<string,Entry>(); private active=0; private closed=false; private initialized=false;
 private ports:number[]; private reserved=new Set<number>(); private state=''; private root='';
 private probeCache?: {at:number; value:Promise<ReturnType<BuildRunner['probeOne']> extends Promise<infer T>?T[]:never>};
 constructor(config:BuildConfig,private options:BuildRunnerOptions={}) {
  this.config=parseBuildConfig(config);const first=Number(new URL(this.config.previewBase!).port);
  this.ports=options.ports??Array.from({length:BUILD_LIMITS.poolSize},(_,i)=>first+i);
  if(!this.ports.length||this.ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||new Set(this.ports).size!==this.ports.length)throw new BuildError(400,'Invalid build port pool');
 }
 private init() {
  if(this.closed)throw new BuildError(503,'Echo Build is closed');if(this.initialized)return;
  mkdirSync(this.config.root,{recursive:true,mode:0o700});
  if(lstatSync(this.config.root).isSymbolicLink())throw new BuildError(400,'Build root must not be a link');
  this.root=realpathSync(this.config.root);this.state=join(this.root,'.echo-build-state');
  mkdirSync(this.state,{recursive:true,mode:0o700});this.safe(this.state,true);
  const lock=join(this.state,'runner.lock');
  if(existsSync(lock)) {
   this.safe(lock);const pid=Number(readFileSync(lock,'utf8'));
   if(!Number.isSafeInteger(pid)||pid<=0)throw new BuildError(409,'Invalid build runner lock; inspect it before recovery');
   let alive=true;try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
   if(alive)throw new BuildError(409,'Another build runner owns this root');unlinkSync(lock);
  }
  writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});this.initialized=true;
  try {
   for(const file of readdirSync(this.state).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).slice(0,BUILD_LIMITS.builds)) {
    const path=join(this.state,file);this.safe(path);
    if(lstatSync(path).size>BUILD_LIMITS.logBytes+100000)throw new Error('oversized record');
    const b=JSON.parse(readFileSync(path,'utf8')) as Build;
    if(buildId(b.build_id)+'.json'!==file || !BUILD_ENGINES.includes(b.engine) || !STATUSES.has(b.status) || !Array.isArray(b.log) || typeof b.title!=='string' || typeof b.prompt!=='string')throw new Error('invalid record');
    b.workspace=join(this.root,b.build_id);this.safe(b.workspace,true);
    b.preview={port:Number.isInteger(b.preview?.port)&&b.preview.port>=1024&&b.preview.port<=65535?b.preview.port:0,url:'/api/prime/build/'+b.build_id+'/preview/'};
    b.log=b.log.filter(e=>Number.isSafeInteger(e.seq)&&typeof e.message==='string'&&typeof e.event==='string'&&typeof e.at==='string').slice(-BUILD_LIMITS.logEvents).map(e=>({...e,message:redactBuild(e.message).slice(0,BUILD_LIMITS.lineChars)}));
    b.title=redactBuild(b.title).slice(0,120);b.prompt=redactBuild(b.prompt).slice(0,BUILD_LIMITS.promptChars);
    if(b.repo && !/^https:\/\/github\.com\/echoomegaprime\/echo-build-[a-z0-9-]+$/.test(b.repo.url))delete b.repo;
    const entry:Entry={build:b,seq:b.log.at(-1)?.seq??0,bytes:Buffer.byteLength(JSON.stringify(b.log)),children:new Set(),mode:'revive',nextPrompt:b.prompt,recovered:!['failed','hibernated'].includes(b.status)};
    this.entries.set(b.build_id,entry);
    if(b.status!=='failed'&&b.status!=='hibernated'){b.status='hibernated';this.event(entry,'recovered','Host restarted; process ownership is unknown. Revive checks the port before launch.');}
   }
  }catch{this.closed=true;this.initialized=false;for(const e of this.entries.values())clearTimeout(e.dirty);unlinkSync(lock);throw new BuildError(503,'Build state is invalid; inspect the private state directory before recovery');}
  trace('initialized',{builds:this.entries.size,maxConcurrent:this.config.maxConcurrent});
 }
 /** Refuse links/junctions on owned control paths, including engine-written startup and manifest files. */
 private safe(path:string,directory=false) {
  const stat=lstatSync(path);
  if(stat.isSymbolicLink() || (directory?!stat.isDirectory():!stat.isFile()) || realpathSync(path)!==resolve(path))throw new BuildError(400,'Build control path is not a regular '+(directory?'directory':'file'));
 }
 private write(path:string,text:string) {if(existsSync(path))this.safe(path);writeFileSync(path,text,{mode:0o600});}
 private save(entry:Entry) {
  this.safe(this.state,true);const target=join(this.state,entry.build.build_id+'.json'),temp=target+'.tmp';
  if(existsSync(target))this.safe(target);this.write(temp,JSON.stringify(entry.build));renameSync(temp,target);
 }
 private event(entry:Entry,event:string,message:string) {
  const row={seq:++entry.seq,at:stamp(),event:'prime_build_'+event,message:redactBuild(message).slice(0,BUILD_LIMITS.lineChars)};
  entry.build.log.push(row);entry.bytes+=Buffer.byteLength(JSON.stringify(row));entry.build.updated_at=row.at;
  while(entry.bytes>BUILD_LIMITS.logBytes||entry.build.log.length>BUILD_LIMITS.logEvents){entry.bytes-=Buffer.byteLength(JSON.stringify(entry.build.log.shift()!));}
  trace(event,{buildId:entry.build.build_id,status:entry.build.status,seq:row.seq});
  if(!entry.transient&&!entry.dirty)entry.dirty=setTimeout(()=>{entry.dirty=undefined;try{this.save(entry);}catch{trace('persist_failed',{buildId:entry.build.build_id});}},500);
 }
 private status(entry:Entry,status:BuildStatus,message:string) {entry.build.status=status;this.event(entry,status,message);this.save(entry);}
 private entry(id:unknown):Entry {this.init();const e=this.entries.get(buildId(id));if(!e)throw new BuildError(404,'Unknown build');this.safe(e.build.workspace,true);return e;}
 get(id:unknown):Build {return structuredClone(this.entry(id).build);}
 list() {this.init();return {builds:[...this.entries.values()].map(e=>structuredClone({...e.build,log:undefined,log_count:e.seq})).reverse()};}
 log(id:unknown,since:unknown=0) {
  const e=this.entry(id);if(typeof since==='string'&&!/^\d{1,15}$/.test(since))throw new BuildError(400,'Invalid log cursor');
  const cursor=Number(since);if(!Number.isSafeInteger(cursor)||cursor<0)throw new BuildError(400,'Invalid log cursor');
  return {events:structuredClone(e.build.log.filter(r=>r.seq>cursor)),next:e.seq,truncated:cursor<(e.build.log[0]?.seq??1)-1,status:e.build.status};
 }
 health() {this.init();return {configured:true,available:true,profile:'ECHO_BUILD',engines:this.config.engines,maxConcurrent:this.config.maxConcurrent,active:this.active,portPool:this.ports.length,wallMs:this.options.wallMs??BUILD_LIMITS.wallMs,deploy:this.config.deploy??{}};}
 async create(input:unknown) {
  this.init();const d=object(input,['title','prompt','engine'],'build request');
  const title=inputText(d.title,120,'title'),prompt=inputText(d.prompt,BUILD_LIMITS.promptChars,'prompt'),engine=d.engine??this.config.engines[0];
  if(!this.config.engines.includes(engine as BuildEngine))throw new BuildError(400,'Build engine is not enabled');
  if(this.entries.size>=BUILD_LIMITS.builds)throw new BuildError(429,'Build record limit reached; archive this root before creating more builds');
  const id=randomBytes(16).toString('hex'),now=stamp(),workspace=join(this.root,id);mkdirSync(workspace,{mode:0o700});
  const build:Build={build_id:id,title,prompt,engine:engine as BuildEngine,status:'queued',workspace,preview:{port:0,url:'/api/prime/build/'+id+'/preview/'},log:[],created_at:now,updated_at:now};
  const e:Entry={build,seq:0,bytes:0,children:new Set(),mode:'build',nextPrompt:prompt};this.entries.set(id,e);
  this.event(e,'queued','Build queued for '+engine);this.save(e);this.pump();return this.get(id);
 }
 private pump() {
  if(this.closed)return;
  for(const e of this.entries.values()) {
   if(this.active>=this.config.maxConcurrent!)break;
   if(e.build.status!=='queued'||e.task||e.stopping)continue;
   this.active++;e.controller=new AbortController();
   e.task=this.execute(e,e.controller.signal).catch(async(error)=>{
    try{await this.clean(e);}catch{this.event(e,'cleanup_failed','An owned process could not be stopped; port remains reserved');}
    try{this.status(e,'failed',error instanceof Error?error.message:'Build failed');}catch{trace('persist_failed',{buildId:e.build.build_id});}
   }).finally(()=>{e.task=undefined;e.controller=undefined;this.active--;this.pump();});
  }
 }
 private async allocate(e:Entry) {
  if(e.recovered&&e.build.preview.port&&!await portFree(e.build.preview.port))throw new BuildError(409,'Recovered preview port is still occupied; verify the old process owner before revive');
  e.recovered=false;
  for(const port of this.ports)if(!this.reserved.has(port)){
   this.reserved.add(port);if(await portFree(port)){e.build.preview.port=port;e.heldPort=true;return;}
   this.reserved.delete(port);
  }
  throw new BuildError(503,'No free build preview ports; hibernate a running build');
 }
 private env(e:Entry):NodeJS.ProcessEnv {
  // Git Bash otherwise converts this URL path to C:/Program Files/Git/ when launching native Node/Python.
  return {...childEnv(),PORT:String(e.build.preview.port),HOST:'0.0.0.0',ECHO_BUILD_BASE:'/',CI:'1',BROWSER:'none',...(process.platform==='win32'?{MSYS2_ENV_CONV_EXCL:'ECHO_BUILD_BASE'}:{})};
 }
 private start(e:Entry,command:BuildCommand,signal?:AbortSignal):{child:ChildProcess;done:Promise<ProcessResult>} {
  if(signal?.aborted)throw new BuildError(409,'Build interrupted');this.safe(e.build.workspace,true);
  const child=(this.options.launch??spawnBuild)(command,e.build.workspace,{...this.env(e),...command.projectEnv});e.children.add(child);
  let output='';
  const stream=(name:string,stream:NodeJS.ReadableStream|null)=>{
   let pending='',discard=false,privateKey=false;const decoder=new StringDecoder('utf8');
   const emit=(line:string)=>{
    if(/-----BEGIN .*PRIVATE KEY-----/.test(line))privateKey=true;
    const hidden=privateKey;if(/-----END .*PRIVATE KEY-----/.test(line))privateKey=false;
    const clean=hidden?'[REDACTED PRIVATE KEY]':line.length>BUILD_LIMITS.lineChars?'[oversized log line omitted]':redactBuild(line);
    if(output.length<64000)output+=(clean+'\n').slice(0,64000-output.length);
    this.event(e,name,clean);
   };
   stream?.on('data',(chunk:Buffer)=>{
    pending+=decoder.write(chunk);let newline:number;
    while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!discard)emit(line);discard=false;}
    if(pending.length>BUILD_LIMITS.lineChars){if(/-----BEGIN .*PRIVATE KEY-----/.test(pending))privateKey=true;pending='';discard=true;}
   });
   stream?.on('end',()=>{pending+=decoder.end();if(discard)emit('[oversized log line omitted]');else if(pending)emit(pending);});
  };
  stream('stdout',child.stdout);stream('stderr',child.stderr);
  const done=new Promise<ProcessResult>((resolve,reject)=>{
   const abort=()=>{void killTree(child).catch(()=>trace('kill_failed',{buildId:e.build.build_id}));reject(new BuildError(409,'Build interrupted or wall budget exceeded'));};
   if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
   child.once('error',()=>{signal?.removeEventListener('abort',abort);reject(new BuildError(503,'Could not launch '+command.cmd+'; check installed CLI and login'));});
   // Wait for stdout/stderr to drain before interpreting CLI results or closing a log cursor.
   child.once('close',code=>{signal?.removeEventListener('abort',abort);resolve({code,output});});
  });
  child.stdin?.on('error',()=>{});child.stdin?.end(command.input??'');
  trace('spawn',{buildId:e.build.build_id,command:command.cmd,engine:e.build.engine});
  return {child,done};
 }
 private async command(e:Entry,command:BuildCommand,signal:AbortSignal):Promise<string> {
  const run=this.start(e,command,signal),result=await run.done;
  if(result.code!==0)throw new BuildError(502,command.cmd+' exited with code '+result.code+'; inspect the redacted build log');
  return result.output;
 }
 private async ready(e:Entry,signal:AbortSignal) {
  const until=Date.now()+(this.options.readyMs??BUILD_LIMITS.readyMs);
  while(Date.now()<until){
   if(signal.aborted)throw new BuildError(409,'Build interrupted or wall budget exceeded');
   try{const r=await fetch('http://127.0.0.1:'+e.build.preview.port+'/',{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(1500)])});await r.body?.cancel();if(r.ok)return;}catch{ /* The supervised server may still be starting. */ }
   await delay(100,signal);
  }
  throw new BuildError(502,'App did not answer successfully on its assigned port');
 }
 private async execute(e:Entry,external:AbortSignal) {
  const signal=AbortSignal.any([external,AbortSignal.timeout(this.options.wallMs??BUILD_LIMITS.wallMs)]);
  await this.allocate(e);this.safe(e.build.workspace,true);
  if(e.mode==='build') {
   this.status(e,'scaffolding','Preparing the Echo sandbox contract');
   this.write(join(e.build.workspace,'AGENTS.md'),buildContract(e.build));
   const promptFile=join(e.build.workspace,'.echo-build-prompt.txt');this.write(promptFile,e.nextPrompt);
   const ignore=join(e.build.workspace,'.gitignore');if(existsSync(ignore))this.safe(ignore);
   this.write(ignore,(existsSync(ignore)?readFileSync(ignore,'utf8')+'\n':'')+'.env\n.env.*\nnode_modules/\n.venv/\n__pycache__/\nscreenshots/\n.echo-build-prompt.txt\n');
   if(existsSync(join(e.build.workspace,'.git')))this.safe(join(e.build.workspace,'.git'),true);
   await this.command(e,{cmd:'git',args:['init','--initial-branch=main']},signal);
   this.status(e,'building','Running '+e.build.engine+' in the build workspace');
   await this.command(e,(this.options.engine??engineCommand)(e.build.engine,e.build.workspace,promptFile,e.nextPrompt),signal);
   this.safe(join(e.build.workspace,'package.json'));
   await this.command(e,{cmd:'npm',args:['run','build']},signal);
  }
  this.safe(join(e.build.workspace,'startup.sh'));
  // An engine may have left a preview behind. Stop only our process groups; never kill an arbitrary port owner.
  await this.clean(e,false);
  if(!await portFree(e.build.preview.port))throw new BuildError(409,'Assigned port is still occupied; startup refused to avoid adopting an unowned app');
  this.status(e,'qa','Starting the app and verifying HTTP plus headless browser rendering');
  const server=this.start(e,{cmd:'bash',args:['startup.sh']});
  let exited=false;void server.done.then(()=>{exited=true;if(!this.closed&&!e.stopping&&(e.build.status==='running'||e.build.status==='deployed'))this.status(e,'failed','Preview server exited');},()=>{exited=true;});
  await this.ready(e,signal);
  if(this.options.qa)await this.options.qa(structuredClone(e.build),signal);
  else await this.command(e,{cmd:process.execPath,args:['--input-type=module','-e',QA_SCRIPT]},signal);
  if(exited||signal.aborted)throw new BuildError(502,'Preview process exited or wall budget exceeded during QA');
  this.status(e,'running','Build and headless browser QA passed; supervised preview is running');
 }
 private async clean(e:Entry,release=true) {
  for(const child of e.children)await killTree(child);e.children.clear();
  if(release&&e.heldPort&&e.build.preview.port){
   // Socket teardown may lag process exit. Do not return an occupied port to the pool.
   for(let i=0;i<20;i++){if(await portFree(e.build.preview.port)){this.reserved.delete(e.build.preview.port);e.heldPort=false;return;}await delay(50);}
   throw new BuildError(503,'Preview port is still occupied; workspace retained and port quarantined');
  }
 }
 async hibernate(id:unknown) {
  const e=this.entry(id);if(e.stopping)throw new BuildError(409,'A build stop is already active');e.stopping=true;
  try{e.controller?.abort();if(e.build.status==='queued')e.build.status='hibernated';
   await e.task?.catch(()=>{});await this.clean(e);this.status(e,'hibernated','Processes stopped; workspace retained');return this.get(id);
  }finally{e.stopping=false;}
 }
 async stop(id:unknown) {const b=await this.hibernate(id);this.event(this.entry(id),'stopped','Stopped by owner');return b;}
 async revive(id:unknown) {
  const e=this.entry(id);if(e.task||e.stopping||!['hibernated','failed'].includes(e.build.status))throw new BuildError(409,'Hibernate or stop this build before revive');
  e.stopping=true;try{await this.clean(e);e.mode='revive';this.status(e,'queued','Revive queued from startup.sh');}finally{e.stopping=false;}
  this.pump();return this.get(id);
 }
 async turn(id:unknown,input:unknown) {
  const e=this.entry(id),d=object(input,['prompt'],'build turn'),prompt=inputText(d.prompt,BUILD_LIMITS.promptChars,'prompt');
  if(e.task||e.stopping||e.build.status==='queued')throw new BuildError(409,'A build operation is already active');
  await this.hibernate(id);e.mode='build';e.nextPrompt=prompt;this.status(e,'queued','Follow-up queued in the same workspace');this.pump();return this.get(id);
 }
 async idle(id:unknown) {const e=this.entry(id);while(e.task||e.build.status==='queued'){await e.task;await delay(5);}return this.get(id);}
 async close() {
  if(!this.initialized){this.closed=true;return;}this.closed=true;
  for(const e of this.entries.values())e.controller?.abort();
  for(const e of this.entries.values()){await e.task?.catch(()=>{});await this.clean(e);if(e.build.status!=='failed')this.status(e,'hibernated','Host closed; workspace retained');clearTimeout(e.dirty);e.dirty=undefined;this.save(e);}
  unlinkSync(join(this.state,'runner.lock'));
  this.initialized=false;
 }
 private async probeOne(engine:BuildEngine) {
  const check=engine==='gpt'?'signed-in':'installed',checkedAt=stamp();
  // A CLI version check proves installation only. No provider inference, credential inspection or automatic login.
  const temporary:Entry={build:{workspace:this.root,build_id:'0'.repeat(32),engine,preview:{port:0,url:''},status:'hibernated',log:[],created_at:checkedAt,updated_at:checkedAt,title:'probe',prompt:''},seq:0,bytes:0,children:new Set(),mode:'revive',nextPrompt:'',transient:true};
  try {const r=this.start(temporary,{cmd:BIN[engine],args:engine==='gpt'?['login','status']:['--version']},AbortSignal.timeout(8000));const result=await r.done;return {id:engine==='gemini'?'argon':engine,engine,available:result.code===0,check,checkedAt,reason:result.code===0?undefined:'CLI check failed; no fallback'};}
  catch{return {id:engine==='gemini'?'argon':engine,engine,available:false,check,checkedAt,reason:'CLI unavailable or check timed out; no fallback'};}
  finally{clearTimeout(temporary.dirty);for(const child of temporary.children)await killTree(child);}
 }
 async models() {
  this.init();if(this.probeCache&&Date.now()-this.probeCache.at<60000)return this.probeCache.value;
  const value=(async()=>{const rows=[];for(const engine of this.config.engines)rows.push(await this.probeOne(engine));return rows;})();this.probeCache={at:Date.now(),value};return value;
 }
 deploymentPlan(id:unknown,target:unknown) {
  const e=this.entry(id);
  if(target==='forge'&&this.config.deploy?.forge)return {target:'forge',targetRef:'forge:'+this.config.deploy.forge.unitPrefix+':'+e.build.build_id,description:'FORGE user unit '+this.config.deploy.forge.unitPrefix+'-'+e.build.build_id+'.service at %h/echo-build/'+e.build.build_id+' (prepare only)'};
  if(target!=='vercel'||!this.config.deploy?.vercel)throw new BuildError(400,'Deployment target is not enabled');
  const directory=join(e.build.workspace,'.vercel'),file=join(directory,'project.json');
  if(!existsSync(file))throw new BuildError(409,'Link this workspace to the intended Vercel project with vercel link before deployment');
  this.safe(directory,true);this.safe(file);if(lstatSync(file).size>65536)throw new BuildError(400,'Invalid Vercel project link');
  let link:Record<string,unknown>;try{link=JSON.parse(readFileSync(file,'utf8'));}catch{throw new BuildError(400,'Invalid Vercel project link');}
  if(typeof link?.orgId!=='string'||typeof link.projectId!=='string'||!/^team_[a-zA-Z0-9]{1,100}$|^[a-zA-Z0-9]{1,100}$/.test(link.orgId)||!/^prj_[a-zA-Z0-9]{1,100}$/.test(link.projectId))throw new BuildError(400,'Invalid Vercel project identity');
  return {target:'vercel',targetRef:'vercel:'+link.orgId+':'+link.projectId,description:'Vercel preview deployment · organization '+link.orgId+' · project '+link.projectId,orgId:link.orgId,projectId:link.projectId};
 }
 async deploy(id:unknown,input:unknown) {
  const e=this.entry(id),d=object(input,['target','confirm','targetRef'],'build deploy');
  if(d.confirm!==true)throw new BuildError(400,'Confirm the exact deployment target');
  if(e.task||!['running','deployed'].includes(e.build.status))throw new BuildError(409,'A verified running build is required');
  if(d.target==='forge' && this.config.deploy?.forge) {
   const name=this.config.deploy.forge.unitPrefix+'-'+e.build.build_id+'.service';
   // Artifacts target FORGE Linux; the workspace must be copied to this explicit path before activation.
   const directory='%h/echo-build/'+e.build.build_id;
   const unit=`[Unit]\nDescription=Echo Build ${e.build.build_id}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${directory}\nEnvironment=PORT=${e.build.preview.port}\nEnvironment=HOST=0.0.0.0\nEnvironment=ECHO_BUILD_BASE=/\nExecStart=/bin/bash ${directory}/startup.sh\nRestart=on-failure\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
   this.write(join(e.build.workspace,name),unit);this.event(e,'deploy_prepared','Forge unit prepared; not installed or enabled');
   return {target:'forge',status:'prepared',unit,name,directory,command:'systemctl --user daemon-reload && systemctl --user enable --now '+name};
  }
  if(d.target!=='vercel'||!this.config.deploy?.vercel)throw new BuildError(400,'Deployment target is not enabled');
  const plan=this.deploymentPlan(id,'vercel');if(d.targetRef!==plan.targetRef)throw new BuildError(409,'Review and confirm the current exact Vercel organization and project');
  const controller=new AbortController();e.controller=controller;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]);
  let result:unknown;
  e.task=(async()=>{
   await this.command(e,{cmd:'vercel',args:['whoami']},signal);
   if(this.deploymentPlan(id,'vercel').targetRef!==plan.targetRef)throw new BuildError(409,'Vercel project changed after review');
   const output=await this.command(e,{cmd:'vercel',args:['deploy','--yes'],projectEnv:{VERCEL_ORG_ID:plan.orgId!,VERCEL_PROJECT_ID:plan.projectId!}},signal);
   const url=output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app\b/i)?.[0];
   if(!url)throw new BuildError(502,'Vercel exited successfully but returned no deployment URL; inspect CLI history before retrying');
   this.status(e,'deployed','Vercel returned '+url+'; production health has not been asserted');result={target:'vercel',status:'deployed',url};
  })();
  try{await e.task;return result;}catch(error){this.event(e,'deploy_failed','Vercel did not complete with a verified URL; inspect CLI history before retrying');throw error;}finally{e.task=undefined;e.controller=undefined;}
 }
 /** Optional, explicit owner call. No auto-push during create, turn or deployment. */
 async repository(id:unknown,input:unknown) {
  const e=this.entry(id),d=object(input,['confirm'],'build repository');
  if(d.confirm!==true)throw new BuildError(400,'Confirm private repository creation');
  if(e.task||e.stopping||!['running','hibernated'].includes(e.build.status))throw new BuildError(409,'An idle build is required');
  if(e.build.repo)return structuredClone(e.build.repo);
  const controller=new AbortController();e.controller=controller;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
  e.task=(async()=>{
   const login=(await this.command(e,{cmd:'gh',args:['api','user','--jq','.login']},signal)).trim();
   if(login!=='echoomegaprime')throw new BuildError(403,'gh must be logged in as echoomegaprime');
   this.safe(join(e.build.workspace,'.git'),true);
   const slug=e.build.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'app',name='echo-build-'+slug+'-'+e.build.build_id.slice(0,8),full='echoomegaprime/'+name;
   // New files must be explicitly reviewed/staged by the owner; never blindly add generated files.
   const staged=await this.command(e,{cmd:'git',args:['diff','--cached','--name-only']},signal);
   if(!staged.trim())throw new BuildError(409,'Review and stage explicit app paths in this workspace before creating its repository');
   if(staged.split(/\r?\n/).some(p=>/(^|\/)(\.env[^/]*|credentials?[^/]*|secrets?[^/]*|id_rsa[^/]*|\.echo-build-prompt.txt)$|\.(pem|key|pfx|p12)$/i.test(p)))throw new BuildError(400,'Protected files are staged; repository creation refused');
   const branch=(await this.command(e,{cmd:'git',args:['branch','--show-current']},signal)).trim();
   if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch))throw new BuildError(400,'Invalid repository branch');
   await this.command(e,{cmd:'git',args:['-c','user.name=ECHO OMEGA PRIME','-c','user.email=bobbymcwilliams@echo-op.com','commit','-m','Initial Echo Build']},signal);
   const sha=(await this.command(e,{cmd:'git',args:['rev-parse','HEAD']},signal)).trim();
   await this.command(e,{cmd:'gh',args:['repo','create',full,'--private','--source','.','--push']},signal);
   const visibility=(await this.command(e,{cmd:'gh',args:['api','repos/'+full,'--jq','.private']},signal)).trim();
   const remote=(await this.command(e,{cmd:'gh',args:['api','repos/'+full+'/commits/'+encodeURIComponent(branch),'--jq','.sha']},signal)).trim();
   if(visibility!=='true'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)||remote!==sha)throw new BuildError(502,'Repository creation returned but private visibility or pushed SHA could not be verified; inspect GitHub before retrying');
   e.build.repo={url:'https://github.com/'+full,branch};this.event(e,'repository','Private repository and pushed SHA verified');this.save(e);
  })();
  try{await e.task;return structuredClone(e.build.repo!);}catch(error){this.event(e,'repository_failed','Repository operation did not complete; inspect GitHub before retrying');throw error;}finally{e.task=undefined;e.controller=undefined;}
 }
 async preview(id:unknown,path:string,base:string,signal?:AbortSignal) {
  const e=this.entry(id);if(!['running','deployed'].includes(e.build.status))throw new BuildError(409,'Build preview is not running');
  return proxyPreview(e.build.preview.port,path,base,signal);
 }
}

/** Fixed loopback destination, GET only, no request credentials, redirects or upstream cookies. */
export async function proxyPreview(port:number,path:string,base:string,signal?:AbortSignal) {
 if(!Number.isInteger(port)||port<1024||port>65535)throw new BuildError(400,'Invalid preview port');
 if(!/^\/api\/prime\/build\/[a-f0-9]{32}\/preview\/(?:[a-f0-9]{48}\/)?$/.test(base))throw new BuildError(400,'Invalid preview base');
 let decoded:string;try{decoded=decodeURIComponent(path);}catch{throw new BuildError(400,'Invalid preview path');}
 if(decoded.includes('\\')||[...decoded].some(c=>c.charCodeAt(0)<32)||decoded.startsWith('/')||decoded.split(/[/?#]/).includes('..'))throw new BuildError(400,'Invalid preview path');
 const origin='http://127.0.0.1:'+port,url=new URL('/'+path,origin);
 if(url.origin!==origin)throw new BuildError(400,'Preview origin refused');
 let r:Response;
 try{r=await fetch(url,{redirect:'error',headers:{accept:'*/*','accept-encoding':'identity'},signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});}
 catch{throw new BuildError(502,'Preview unavailable or redirect refused');}
 const reader=r.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 try {
  if(Number(r.headers.get('content-length'))>BUILD_LIMITS.previewBytes)throw new BuildError(502,'Preview exceeds 5 MiB');
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>BUILD_LIMITS.previewBytes)throw new BuildError(502,'Preview exceeds 5 MiB');chunks.push(value);}
 }catch(error){if(error instanceof BuildError)throw error;throw new BuildError(504,'Preview response interrupted');}
 finally{await reader?.cancel().catch(()=>{});}
 let data:Buffer=Buffer.concat(chunks);const type=(r.headers.get('content-type')??'application/octet-stream').split(';')[0].toLowerCase();
 if(['text/html','text/css','text/javascript','application/javascript','image/svg+xml'].includes(type)) {
  let text=data.toString('utf8');
  const rewrite=(value:string)=>value.startsWith(base)?value:base+value.replace(/^\//,'');
  text=text.replace(/(["'`])\/(?!\/)([^"'`\s<>]*)\1/g,(_all,q,tail)=>q+rewrite('/'+tail)+q)
   .replace(/url\(\s*\/(?!\/)([^)\s]*)\s*\)/g,(_all,tail)=>'url('+rewrite('/'+tail)+')')
   .replace(new RegExp('http://(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0):'+port+'/', 'g'),base);
  if(type==='text/html') {
   text=text.replace(/<base\b[^>]*>/gi,'').replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b[^>]*>/gi,'');
   // A base fixes relative document links; absolute app paths in scripts/styles are rebased above.
   text='<base href="'+base+'">'+text;
  }
  data=Buffer.from(text);if(data.length>BUILD_LIMITS.previewBytes)throw new BuildError(502,'Rewritten preview exceeds 5 MiB');
 }
 trace('preview',{port,status:r.status,bytes:data.length});
 return {status:r.status,data,type};
}
