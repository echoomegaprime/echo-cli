import {afterEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import {BuildRunner,BUILD_LIMITS,buildId,buildContract,engineCommand,parseBuildConfig,proxyPreview,redactBuild,spawnBuild,type BuildRunnerOptions,type BuildConfig} from '../src/prime/build.js';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';

const dirs:string[]=[],runners:BuildRunner[]=[],servers:Server[]=[],closers:(()=>Promise<void>)[]=[];
const ROOT=resolve('test-build-root'),ID='a'.repeat(32),BASE='/api/prime/build/'+ID+'/preview/';
afterEach(async()=>{vi.restoreAllMocks();while(closers.length)await closers.pop()!();while(runners.length)await runners.pop()!.close();while(servers.length){const s=servers.pop()!;s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});});
function directory(){const p=mkdtempSync(join(tmpdir(),'prime-build-'));dirs.push(p);return p;}
async function http(handler:Parameters<typeof createServer>[0]){const s=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));servers.push(s);return {server:s,port:(s.address() as AddressInfo).port};}
async function ports(count=1){const out:number[]=[];for(let i=0;i<count;i++){const s=await http((_q,r)=>r.end('reserved'));out.push(s.port);servers.pop();await new Promise<void>(r=>s.server.close(()=>r()));}return out;}
const app=`const http=require('node:http');http.createServer((q,r)=>{if(!q.url.startsWith(process.env.ECHO_BUILD_BASE)){r.writeHead(404);r.end('outside configured app base');return;}r.setHeader('Set-Cookie','app_cookie=fixture');r.setHeader('Content-Type','text/html');r.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>Hello Echo app <a href="/next">Next</a></body></html>');}).listen(Number(process.env.PORT),'0.0.0.0');`;
// A real subprocess writes a runnable hello app, package build gate and startup script. No paid engine or login is used.
function fixtureEngine(root:string){
 const file=join(root,'engine.cjs');
 writeFileSync(file,`const fs=require('node:fs');const mode=process.argv[2];
 if(mode==='slow'){setInterval(()=>{},1000);return;}if(mode==='fail'){process.exit(7);}
 const count=fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8')):0;fs.writeFileSync('count.txt',String(count+1));
 fs.writeFileSync('app.cjs',${JSON.stringify(app)});
 fs.writeFileSync('package.json',JSON.stringify({scripts:{build:mode==='bad-build'?'node -e "process.exit(2)"':'node --check app.cjs'}}));
 if(mode!=='no-startup')fs.writeFileSync('startup.sh','#!/bin/sh\\nset -eu\\ncd "$(dirname "$0")"\\nexec node app.cjs\\n');
 process.stdout.write('api_key=');setTimeout(()=>{console.log('fixtureSecretNeverExpose');console.error('Authorization: Bearer fixtureBearerNeverExpose');console.log('-----BEGIN PRIVATE KEY-----');console.log('fixturePemNeverExpose');console.log('-----END PRIVATE KEY-----');
 if(mode==='flood'){for(let i=0;i<1500;i++)console.log('line '+i+' '+('x'.repeat(1500)));console.log('environment_refresh_token=fixtureFloodSecretNeverExpose');}if(mode==='long-line')console.log('x'.repeat(15000));},10);`);
 return file;
}
async function runner(options:BuildRunnerOptions={},config:Partial<BuildConfig>={}){
 const dir=directory(),file=fixtureEngine(dir),configRoot=join(dir,'builds');
 const seen:{cmd:string;args:string[];env:NodeJS.ProcessEnv}[]=[];
 const launch:typeof spawnBuild=(command,cwd,env)=>{
  seen.push({cmd:command.cmd,args:command.args,env:{...env}});
  // Git Bash runs the actual generated startup.sh on Windows; the OS WSL launcher is intentionally not a substitute.
  return spawnBuild(command.cmd==='bash'&&process.platform==='win32'?{...command,cmd:'C:\\Program Files\\Git\\bin\\bash.exe'}:command,cwd,env);
 };
 const build=new BuildRunner({root:configRoot,engines:['gpt','grok','gemini','claude'],...config},{ports:await ports(3),wallMs:20000,readyMs:3000,engine:(_e,_w,_f,p)=>({cmd:process.execPath,args:[file,p]}),qa:async(b)=>{expect((await fetch('http://127.0.0.1:'+b.preview.port)).status).toBe(200);},launch,...options});runners.push(build);return {build,dir,seen};
}
async function running(options:BuildRunnerOptions={},prompt='hello',config:Partial<BuildConfig>={}){const r=await runner(options,config),b=await r.build.create({title:'Hello app',prompt});const done=await r.build.idle(b.build_id);expect(done.status,JSON.stringify(done.log.slice(-5))).toBe('running');return {...r,b:done};}
async function prime(build?:BuildRunner,workspace?:string){
 const dir=directory();for(const [name,value] of [['index.html','Prime'],['build.js','// build'],['build.css','/* build */']])writeFileSync(join(dir,name),value);
 const p=await startPrimeServer(new PrimeHub({capabilities:[],build}),dir,0,workspace?{workspace:{baseUrl:workspace,ownerUid:'owner'}}:{});closers.push(p.close);
 const cookie=(await fetch(p.url)).headers.get('set-cookie')!.split(';')[0],headers={cookie,'x-prime-request':'1','x-echo-csrf':'fixture-csrf'};
 return {...p,headers,get:(path:string)=>fetch(p.url+path,{headers}),post:(path:string,body:unknown={})=>fetch(p.url+path,{method:'POST',headers:{...headers,origin:p.url,'content-type':'application/json'},body:JSON.stringify(body)})};
}

describe('Build config and contract',()=>{
 it('requires explicit root and engines and defaults to one builder',()=>{expect(parseBuildConfig({root:ROOT,engines:['gpt']})).toMatchObject({maxConcurrent:1,previewBase:'http://127.0.0.1:8400'});expect(()=>parseBuildConfig({})).toThrow();});
 it.each([null,[],{root:'relative',engines:['gpt']},{root:ROOT,engines:[]},{root:ROOT,engines:['unknown']},{root:ROOT,engines:['gpt','gpt']}])('refuses malformed config %j',value=>{expect(()=>parseBuildConfig(value)).toThrow();});
 it('refuses unknown keys at every config depth',()=>{for(const extra of [{token:'fake'},{deploy:{other:true}},{deploy:{forge:{unitPrefix:'echo',enabled:true}}}])expect(()=>parseBuildConfig({root:ROOT,engines:['gpt'],...extra})).toThrow(/unknown field/);});
 it('validates concurrency and unit names',()=>{for(const n of [0,5,1.5,'1'])expect(()=>parseBuildConfig({root:ROOT,engines:['gpt'],maxConcurrent:n})).toThrow();expect(()=>parseBuildConfig({root:ROOT,engines:['gpt'],deploy:{forge:{unitPrefix:'x\nExecStart=bad'}}})).toThrow();});
 it('refuses remote, credential-bearing, path and overflowing preview origins',()=>{for(const previewBase of ['http://10.0.0.1:8400','http://user:pass@127.0.0.1:8400','http://127.0.0.1:8400/x','https://127.0.0.1:8400','http://127.0.0.1:65530'])expect(()=>parseBuildConfig({root:ROOT,engines:['gpt'],previewBase})).toThrow();});
 it('validates ids before touching filesystem or upstream',()=>{for(const id of ['../x','a'.repeat(31),'A'.repeat(32),null,'a'.repeat(33)])expect(()=>buildId(id)).toThrow(/Invalid build id/);expect(buildId(ID)).toBe(ID);});
 it('uses engine argument arrays and no provider fallback',()=>{expect(engineCommand('gpt',ROOT,'prompt','x')).toMatchObject({cmd:'codex',args:expect.arrayContaining(['exec','-C',ROOT,'workspace-write']),input:'x'});expect(engineCommand('grok',ROOT,'prompt','x').args).toContain('--prompt-file');expect(engineCommand('gemini',ROOT,'prompt','x').cmd).toBe('agy');expect(engineCommand('claude',ROOT,'prompt','x').args).toContain('acceptEdits');});
 it('redacts bearer, cookie, named secrets, key formats and private keys',()=>{const value=redactBuild('Authorization: Bearer FAKE\nCookie: abc\nrefresh_token=FAKE\napi_key=FAKE\n-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----');expect(value).not.toContain('FAKE');expect(value).toContain('REDACTED');});
 it('redacts prefixed and quoted secret keys while preserving long ordinary log words',()=>{
  const ordinary='x'.repeat(BUILD_LIMITS.lineChars),keys=['token','_TOKEN','environment_refresh_token','my_long_service_api_key','servicePASSWORD','99secret','abctoken','accessToken'];
  for(const key of keys){const line=ordinary+' {"'+key+'":"fixtureNamedSecretNeverExpose"}';expect(redactBuild(line)).toBe(ordinary+' {"'+key+'":"[REDACTED]"}');}
  expect(redactBuild(ordinary)).toBe(ordinary);
 });
 it('defines real program, data, auth, build, headless QA and restart requirements',()=>{const text=buildContract({build_id:ID,engine:'gpt',preview:{port:8402}} as never);for(const word of ['Triage','CLI','Python','SQLite','echo-auth','npm run build','startup.sh','0.0.0.0:8402','Playwright','headless','No daemonizing'])expect(text).toContain(word);});
});

describe('BuildRunner real subprocess lifecycle',()=>{
 it('creates, builds and serves an actual app with the allowed child environment',async()=>{
  const secret='fixtureEnvNeverForward';process.env.ECHO_TEST_TOKEN=secret;
  try{const {build,b,seen}=await running();expect(b.build_id).toMatch(/^[a-f0-9]{32}$/);expect(b.workspace).toBe(join(build.config.root,b.build_id));expect(await (await fetch('http://127.0.0.1:'+b.preview.port)).text()).toContain('Hello Echo app');expect(existsSync(join(b.workspace,'.git'))).toBe(true);expect(seen.some(c=>c.cmd==='npm'&&c.args.join(' ')==='run build')).toBe(true);expect(JSON.stringify(seen.map(c=>c.env))).not.toContain(secret);expect(seen.every(c=>c.env.BROWSER==='none')).toBe(true);expect(b.log.map(e=>e.event)).toEqual(expect.arrayContaining(['prime_build_scaffolding','prime_build_building','prime_build_qa','prime_build_running']));}finally{delete process.env.ECHO_TEST_TOKEN;}
 },30000);
 it('redacts split chunks, stderr and multiline private key output before persisting',async()=>{const {build,b}=await running();const logs=JSON.stringify(build.log(b.build_id));expect(logs).not.toMatch(/fixture(Secret|Bearer|Pem)NeverExpose/);expect(logs).toContain('REDACTED');await build.hibernate(b.build_id);expect(readFileSync(join(build.config.root,'.echo-build-state',b.build_id+'.json'),'utf8')).not.toContain('fixtureSecretNeverExpose');},30000);
 it('caps streamed logs and provides monotonic cursors with truncation',async()=>{
  const {build,b}=await running({},'flood'),logs=build.log(b.build_id),state=join(build.config.root,'.echo-build-state',b.build_id+'.json');
  expect(logs.truncated).toBe(true);expect(logs.events.length).toBeLessThanOrEqual(1000);expect(Buffer.byteLength(JSON.stringify(logs.events))).toBeLessThan(BUILD_LIMITS.logBytes+10000);
  expect(logs.events.every((row,index)=>index===0||row.seq>logs.events[index-1].seq)).toBe(true);expect(logs.next).toBe(logs.events.at(-1)!.seq);
  expect(logs.events.some(row=>row.message.startsWith('line 1499 '))).toBe(true);expect(logs.events.some(row=>row.message==='environment_refresh_token=[REDACTED]')).toBe(true);
  expect(JSON.stringify(logs)).not.toContain('fixtureFloodSecretNeverExpose');expect(JSON.parse(readFileSync(state,'utf8'))).toMatchObject({status:'running',log:logs.events});
  expect(build.log(b.build_id,logs.next).events).toEqual([]);expect(()=>build.log(b.build_id,'-1')).toThrow();
  await build.hibernate(b.build_id);const stopped=build.log(b.build_id,logs.next);
  expect(stopped.next).toBeGreaterThan(logs.next);expect(stopped.events.every(row=>row.seq>logs.next)).toBe(true);expect(stopped.events.at(-1)?.event).toBe('prime_build_hibernated');
  expect(JSON.parse(readFileSync(state,'utf8'))).toMatchObject({status:'hibernated',log:build.log(b.build_id).events});
 },30000);
 it('drops oversized single lines instead of leaking a split secret',async()=>{const {b}=await running({},'long-line');expect(b.log.some(e=>e.message.includes('oversized log line omitted'))).toBe(true);},30000);
 it('hibernates the process, retains files, and revives by executing startup.sh',async()=>{const {build,b,seen}=await running();await build.hibernate(b.build_id);await expect(fetch('http://127.0.0.1:'+b.preview.port,{signal:AbortSignal.timeout(500)})).rejects.toThrow();expect(readFileSync(join(b.workspace,'count.txt'),'utf8')).toBe('1');await build.revive(b.build_id);expect((await build.idle(b.build_id)).status).toBe('running');expect(seen.filter(c=>c.cmd==='bash')).toHaveLength(2);expect(readFileSync(join(b.workspace,'count.txt'),'utf8')).toBe('1');},30000);
 it('applies follow-ups in the same workspace, preserving unrelated app files',async()=>{const {build,b}=await running();writeFileSync(join(b.workspace,'notes.txt'),'keep');await build.turn(b.build_id,{prompt:'followup'});expect((await build.idle(b.build_id)).status).toBe('running');expect(readFileSync(join(b.workspace,'count.txt'),'utf8')).toBe('2');expect(readFileSync(join(b.workspace,'notes.txt'),'utf8')).toBe('keep');},30000);
 it('restores metadata after a clean host restart without claiming the app is running',async()=>{const {build,b}=await running();await build.close();runners.splice(runners.indexOf(build),1);const restored=new BuildRunner(build.config);runners.push(restored);expect(restored.get(b.build_id).status).toBe('hibernated');expect(restored.list().builds).toHaveLength(1);},30000);
 it('enforces one runner per root',async()=>{const {build}=await runner();build.health();const other=new BuildRunner(build.config);expect(()=>other.health()).toThrow(/Another build runner/);await other.close();});
 it('queues above maxConcurrent and permits stopping a queued build',async()=>{const {build}=await runner({wallMs:1500});const a=await build.create({title:'slow',prompt:'slow'}),b=await build.create({title:'queued',prompt:'hello'});expect(build.get(b.build_id).status).toBe('queued');await build.stop(b.build_id);await build.stop(a.build_id);expect(build.get(b.build_id).status).toBe('hibernated');expect(build.health().active).toBe(0);},15000);
 it('enforces the wall budget and records failure instead of running',async()=>{const {build}=await runner({wallMs:400});const b=await build.create({title:'budget',prompt:'slow'});const result=await build.idle(b.build_id);expect(result.status).toBe('failed');expect(JSON.stringify(result.log)).toMatch(/wall budget|interrupted/);},15000);
 it.each(['fail','bad-build','no-startup'])('fails %s without claiming a running preview',async prompt=>{const {build}=await runner();const b=await build.create({title:'broken',prompt});expect((await build.idle(b.build_id)).status).toBe('failed');},30000);
 it('does not mark running when browser QA fails',async()=>{const {build}=await runner({qa:async()=>{throw new Error('Browser QA failed');}});const b=await build.create({title:'qa',prompt:'hello'});const done=await build.idle(b.build_id);expect(done.status).toBe('failed');expect(done.log.at(-1)?.message).toContain('Browser QA');},30000);
 it('allocates distinct ports, refuses exhaustion, and reuses a hibernated port',async()=>{const pool=await ports(1),{build}=await runner({ports:pool});const a=await build.create({title:'one',prompt:'hello'});expect((await build.idle(a.build_id)).status).toBe('running');const b=await build.create({title:'two',prompt:'hello'});expect((await build.idle(b.build_id)).status).toBe('failed');await build.hibernate(a.build_id);await build.turn(b.build_id,{prompt:'hello'});expect((await build.idle(b.build_id)).preview.port).toBe(pool[0]);},30000);
 it('skips occupied ports without stopping their owners',async()=>{const external=await http((_q,r)=>r.end('protected')),{b}=await running({ports:[external.port,...await ports(1)]});expect(b.preview.port).not.toBe(external.port);expect(await (await fetch('http://127.0.0.1:'+external.port)).text()).toBe('protected');},30000);
 it('validates request fields and refuses secrets or unconfigured engines',async()=>{const {build}=await runner({}, {engines:['gpt']});for(const input of [{title:'x',prompt:''},{title:'x',prompt:'hi',engine:'grok'},{title:'x',prompt:'api_key=fixture'},{title:'x',prompt:'x'.repeat(12001)},{title:'x',prompt:'hi',command:'shell'}])await expect(build.create(input)).rejects.toThrow();expect(build.list().builds).toHaveLength(0);});
 it('rejects concurrent follow-ups and malformed lifecycle requests',async()=>{const {build}=await runner({wallMs:1000});const b=await build.create({title:'slow',prompt:'slow'});await expect(build.turn(b.build_id,{prompt:'edit'})).rejects.toThrow(/already active/);await expect(build.revive(b.build_id)).rejects.toThrow();await build.stop(b.build_id);},15000);
 it('returns a Forge unit artifact without invoking systemctl or marking deployed',async()=>{const {build,b,seen}=await running({},'hello',{deploy:{forge:{unitPrefix:'echo-app'}}});await expect(build.deploy(b.build_id,{target:'forge'})).rejects.toThrow(/Confirm/);const result=await build.deploy(b.build_id,{target:'forge',confirm:true}) as {unit:string;status:string;command:string};expect(result.status).toBe('prepared');expect(result.unit).toContain('ExecStart=/bin/bash %h/echo-build/'+b.build_id+'/startup.sh');expect(result.command).toContain('systemctl --user');expect(seen.some(c=>c.cmd==='systemctl')).toBe(false);expect(build.get(b.build_id).status).toBe('running');},30000);
 it('refuses disabled deploy and unconfirmed repository actions',async()=>{const {build,b}=await running();await expect(build.deploy(b.build_id,{target:'vercel',confirm:true})).rejects.toThrow(/not enabled/);await expect(build.repository(b.build_id,{})).rejects.toThrow(/Confirm/);},30000);
 it('pins the reviewed Vercel target, checks login and records only a returned URL',async()=>{
  const calls:{args:string[];env:NodeJS.ProcessEnv}[]=[];
  const {build,b}=await running({launch:(c,cwd,env)=>{if(c.cmd==='vercel'){calls.push({args:c.args,env});return spawnBuild({cmd:process.execPath,args:['-e',c.args[0]==='whoami'?'console.log("fixture-account")':'console.log("https://fixture.vercel.app")']},cwd,env);}return spawnBuild(c,cwd,env);}},'hello',{deploy:{vercel:true}});
  expect(()=>build.deploymentPlan(b.build_id,'vercel')).toThrow(/vercel link/);
  mkdirSync(join(b.workspace,'.vercel'));writeFileSync(join(b.workspace,'.vercel/project.json'),JSON.stringify({orgId:'team_fixture',projectId:'prj_fixture'}));
  const plan=build.deploymentPlan(b.build_id,'vercel');
  await expect(build.deploy(b.build_id,{target:'vercel',confirm:true,targetRef:'other'})).rejects.toThrow(/exact Vercel/);
  expect(await build.deploy(b.build_id,{target:'vercel',confirm:true,targetRef:plan.targetRef})).toEqual({target:'vercel',status:'deployed',url:'https://fixture.vercel.app'});
  expect(calls.map(c=>c.args)).toEqual([['whoami'],['deploy','--yes']]);expect(calls[1].env).toMatchObject({VERCEL_ORG_ID:'team_fixture',VERCEL_PROJECT_ID:'prj_fixture'});expect(calls[1].env).not.toHaveProperty('VERCEL_TOKEN');expect(build.get(b.build_id).status).toBe('deployed');
 },30000);
 it('never deploys after a failed CLI login check',async()=>{
  const calls:string[][]=[];const {build,b}=await running({launch:(c,cwd,env)=>{if(c.cmd==='vercel'){calls.push(c.args);return spawnBuild({cmd:process.execPath,args:['-e','process.exit(1)']},cwd,env);}return spawnBuild(c,cwd,env);}},'hello',{deploy:{vercel:true}});
  mkdirSync(join(b.workspace,'.vercel'));writeFileSync(join(b.workspace,'.vercel/project.json'),JSON.stringify({orgId:'team_fixture',projectId:'prj_fixture'}));
  await expect(build.deploy(b.build_id,{target:'vercel',confirm:true,targetRef:build.deploymentPlan(b.build_id,'vercel').targetRef})).rejects.toThrow(/exited with code 1/);
  expect(calls).toEqual([['whoami']]);expect(build.get(b.build_id).status).toBe('running');
 },30000);
 it('refuses a changed project link after confirmation',async()=>{
  const calls:string[][]=[];const {build,b}=await running({launch:(c,cwd,env)=>{if(c.cmd==='vercel'){calls.push(c.args);writeFileSync(join(cwd,'.vercel/project.json'),JSON.stringify({orgId:'team_other',projectId:'prj_other'}));return spawnBuild({cmd:process.execPath,args:['-e','console.log("fixture")']},cwd,env);}return spawnBuild(c,cwd,env);}},'hello',{deploy:{vercel:true}});
  mkdirSync(join(b.workspace,'.vercel'));writeFileSync(join(b.workspace,'.vercel/project.json'),JSON.stringify({orgId:'team_fixture',projectId:'prj_fixture'}));
  await expect(build.deploy(b.build_id,{target:'vercel',confirm:true,targetRef:build.deploymentPlan(b.build_id,'vercel').targetRef})).rejects.toThrow(/changed after review/);expect(calls).toEqual([['whoami']]);
 },30000);
 it('refuses repository creation for a different GitHub identity',async()=>{
  const calls:string[][]=[];const {build,b}=await running({launch:(c,cwd,env)=>{if(c.cmd==='gh'){calls.push(c.args);return spawnBuild({cmd:process.execPath,args:['-e','console.log("another-account")']},cwd,env);}return spawnBuild(c,cwd,env);}});
  await expect(build.repository(b.build_id,{confirm:true})).rejects.toThrow(/echoomegaprime/);expect(calls).toEqual([['api','user','--jq','.login']]);expect(build.get(b.build_id).repo).toBeUndefined();
 },30000);
 it('refuses a junction as the build root',async()=>{const dir=directory(),target=join(dir,'target'),link=join(dir,'link');mkdirSync(target);symlinkSync(target,link,process.platform==='win32'?'junction':'dir');const b=new BuildRunner({root:link,engines:['gpt']});expect(()=>b.health()).toThrow(/link/);await b.close();});
});

describe('bounded preview proxy',()=>{
 it('strips all upstream headers including Set-Cookie, rebases links, CSS and script URLs',async()=>{const s=await http((_q,r)=>{r.writeHead(200,{'content-type':'text/html','set-cookie':'credential=fixture'});r.end('<a href="/next">Next</a><script>fetch("/api/data")</script><style>body{background:url(/x.png)}</style>');});const result=await proxyPreview(s.port,'',BASE);expect(result).not.toHaveProperty('headers');expect(result.data.toString()).toContain('href="'+BASE+'next"');expect(result.data.toString()).toContain('fetch("'+BASE+'api/data")');expect(result.data.toString()).toContain('url('+BASE+'x.png)');});
 it('never forwards a caller cookie, authorization or redirect',async()=>{let seen:unknown;const s=await http((q,r)=>{seen=q.headers;r.writeHead(302,{location:'http://example.invalid'});r.end();});await expect(proxyPreview(s.port,'',BASE)).rejects.toThrow(/redirect refused/);expect(seen).not.toHaveProperty('cookie');expect(seen).not.toHaveProperty('authorization');});
 it('caps chunked responses at 5 MiB',async()=>{const s=await http((_q,r)=>{r.writeHead(200,{'content-type':'application/octet-stream'});r.write(Buffer.alloc(BUILD_LIMITS.previewBytes));r.end(Buffer.alloc(1));});await expect(proxyPreview(s.port,'big',BASE)).rejects.toThrow(/5 MiB/);});
 it('caps declared content length before reading',async()=>{const s=await http((_q,r)=>{r.writeHead(200,{'content-length':String(BUILD_LIMITS.previewBytes+1)});r.end('x');});await expect(proxyPreview(s.port,'big',BASE)).rejects.toThrow(/5 MiB/);});
 it('rejects traversal, absolute targets and encoded backslashes',async()=>{for(const path of ['../x','%2e%2e/x','//evil.invalid','%5cfoo','%00','%'])await expect(proxyPreview(8400,path,BASE)).rejects.toThrow(/path/);});
 it('passes bounded binary assets without text rewriting',async()=>{const image=Buffer.from([0,1,2,255]),s=await http((_q,r)=>{r.setHeader('content-type','image/png');r.end(image);});expect((await proxyPreview(s.port,'image.png',BASE)).data).toEqual(image);});
});

describe('Prime owner-only Build routes',()=>{
 it('reports off state without launching anything and serves assets',async()=>{const p=await prime();expect(await (await p.get('/api/prime/build/health')).json()).toMatchObject({configured:false,available:false});expect((await p.get('/api/prime/build/list')).status).toBe(503);expect((await p.post('/api/prime/build/create',{title:'hi',prompt:'hi'})).status).toBe(503);for(const file of ['build.js','build.css'])expect((await fetch(p.url+'/'+file)).status).toBe(200);});
 it('requires the Prime cookie, custom header and exact Origin for mutations',async()=>{const p=await prime();for(const path of ['health','list',ID,ID+'/log',ID+'/preview/'])expect((await fetch(p.url+'/api/prime/build/'+path)).status).toBe(403);for(const action of ['create',ID+'/turn',ID+'/hibernate',ID+'/revive',ID+'/stop',ID+'/deploy',ID+'/preview-session'])expect((await fetch(p.url+'/api/prime/build/'+action,{method:'POST',headers:{...p.headers,origin:'https://evil.invalid','content-type':'application/json'},body:'{}'})).status).toBe(403);});
 it('implements create, list, get, log, follow-up alias, stop and revive routes',async()=>{const {build}=await runner(),p=await prime(build);const created=await p.post('/api/prime/build/create',{title:'routed',prompt:'hello'});expect(created.status).toBe(202);const b=await created.json();await build.idle(b.build_id);expect((await (await p.get('/api/prime/build/list')).json()).builds).toHaveLength(1);expect((await (await p.get('/api/prime/build/'+b.build_id)).json()).status).toBe('running');expect((await (await p.get('/api/prime/build/'+b.build_id+'/log?since=0')).json()).events.length).toBeGreaterThan(0);expect((await p.post('/api/prime/build/'+b.build_id+'/turns',{prompt:'edit'})).status).toBe(202);await build.idle(b.build_id);expect((await p.post('/api/prime/build/'+b.build_id+'/stop')).status).toBe(200);expect((await p.post('/api/prime/build/'+b.build_id+'/revive')).status).toBe(202);await build.idle(b.build_id);},30000);
 it('creates scoped preview sessions that work without owner headers but cannot call other APIs',async()=>{const {build,b}=await running(),p=await prime(build);const session=await (await p.post('/api/prime/build/'+b.build_id+'/preview-session')).json();const response=await fetch(p.url+session.url,{headers:{origin:'null'}});expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toBeNull();expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-forms;');expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');expect(await response.text()).toContain('Hello Echo app');expect((await fetch(p.url+'/api/prime/build/list',{headers:{origin:'null'}})).status).toBe(403);expect((await fetch(p.url+session.url,{method:'POST',headers:{origin:'null'}})).status).toBe(403);},30000);
 it('revalidates the primary owner on every iframe resource and refuses revoked owners',async()=>{
  let role='owner';const seen:string[]=[];
  const backend=await http((q,r)=>{seen.push(q.headers.cookie??'');r.setHeader('content-type','application/json');r.end(JSON.stringify(q.headers.cookie?{authenticated:true,user:{uid:'owner',role,status:'approved'},csrf:'fixture-csrf'}:{authenticated:false,user:null,csrf:null}));});
  const {build,b}=await running(),p=await prime(build,'http://127.0.0.1:'+backend.port);
  expect((await p.get('/api/prime/build/health')).status).toBe(401);
  p.headers.cookie+='; echo_workspace_session='+'x'.repeat(32);
  const session=await (await p.post('/api/prime/build/'+b.build_id+'/preview-session')).json();
  expect((await fetch(p.url+session.url)).status).toBe(200);expect(seen.at(-1)).toBe('echo_workspace_session='+'x'.repeat(32));
  role='member';expect((await fetch(p.url+session.url)).status).toBe(403);expect((await p.get('/api/prime/build/health')).status).toBe(403);
 },30000);
 it('rejects malformed ids, invalid log cursors, lifecycle fields and non-JSON posts',async()=>{const {build,b}=await running(),p=await prime(build);expect((await p.get('/api/prime/build/..%2Fescape')).status).toBe(400);expect((await p.get('/api/prime/build/'+b.build_id+'/log?since=no')).status).toBe(400);expect((await p.post('/api/prime/build/'+b.build_id+'/stop',{force:true})).status).toBe(400);expect((await fetch(p.url+'/api/prime/build/create',{method:'POST',headers:{...p.headers,origin:p.url},body:'{}'})).status).toBe(405);},30000);
});
