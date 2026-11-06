import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRouter,DEFAULT_MODELS} from '../src/code/model-factory.js';
import {type Runner,type RunResult} from '../src/code/providers.js';
import {probeCommand} from '../src/prime/build.js';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore} from '../src/code/sessions.js';
import {runTurn} from '../src/code/agent.js';

// Live test 2026-11-06: Claude was listed available while every call failed with "OAuth session expired" (the probe only
// ran `claude --version`), Grok and Argon said "not installed" with no way forward, a provider failure was labelled as
// model text, and the process-wide 8-request cap answered 429 to /api/session while other people's turns were running.
const ok=(stdout=''):RunResult=>({code:0,stdout,stderr:'',timedOut:false});
const exit=(code:number):RunResult=>({code,stdout:'{"loggedIn":false}',stderr:'',timedOut:false});
const final=(content='done')=>JSON.stringify({action:'final',content});
const spawnFailed=()=>Object.assign(new Error('ENOENT'),{spawnFailed:true});
const messages=[{role:'system' as const,content:'sys'},{role:'user' as const,content:'hello'}];
function runner(handler:(cmd:string,args:string[])=>RunResult|Error){
 const calls:{cmd:string;args:string[]}[]=[];
 const run:Runner=async(cmd,args)=>{calls.push({cmd,args});const r=handler(cmd,args);if(r instanceof Error)throw r;return r;};
 return {calls,run};
}
const offlineQwen={...DEFAULT_MODELS,endpoint:'http://127.0.0.1:9'};

describe('provider availability checks sign-in, not just installation',()=>{
 it('asks claude for its auth status and reports a signed-out CLI as unavailable with the way to sign in',async()=>{
  const r=runner((cmd,args)=>cmd==='claude'&&args[0]==='auth'?exit(1):cmd==='codex'?ok():spawnFailed());
  const report=await new ModelRouter(offlineQwen,{runner:r.run}).report();
  const claude=report.providers.find(p=>p.id==='claude')!;
  expect(r.calls.find(c=>c.cmd==='claude')!.args).toEqual(['auth','status']);
  expect(claude).toMatchObject({available:false,check:'signed-in'});
  expect(claude.reason).toMatch(/not signed in/);expect(claude.reason).toContain('claude auth login');
  expect(JSON.stringify(report)).not.toContain('loggedIn');// status output is never returned
  const signedIn=await new ModelRouter(offlineQwen,{runner:runner(()=>ok()).run}).report();
  expect(signedIn.providers.find(p=>p.id==='claude')).toMatchObject({available:true,check:'signed-in'});
 });
 it('keeps Grok and Argon honestly unavailable with the documented install and sign-in steps',async()=>{
  const report=await new ModelRouter(offlineQwen,{runner:runner(cmd=>cmd==='grok'||cmd==='agy'?spawnFailed():ok()).run}).report();
  const grok=report.providers.find(p=>p.id==='grok')!,argon=report.providers.find(p=>p.id==='argon')!;
  expect(grok.available).toBe(false);expect(grok.reason).toContain('curl -fsSL https://x.ai/cli/install.sh | bash');expect(grok.reason).toContain('grok login');
  expect(argon.available).toBe(false);expect(argon.reason).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
 });
 it('marks a provider unavailable from its last outcome when the CLI says it is signed in but the call fails to authenticate',async()=>{
  let now=Date.parse('2026-11-06T10:00:00Z');
  let failing=true;
  const r=runner((cmd,args)=>{
   if(args[0]==='auth'||args[0]==='login'||args[0]==='--version'||args[0]==='models')return ok();
   return failing&&cmd==='claude'?ok(JSON.stringify({is_error:true,result:'Failed to authenticate: OAuth session expired and could not be refreshed'})):ok(JSON.stringify({is_error:false,result:final('fine'),modelUsage:{'claude-opus-5-5':{outputTokens:3}}}));
  });
  const router=new ModelRouter({...offlineQwen,auto:{enabled:true,classifier:'rules',research:'grok',declineTo:'qwen'}},{runner:r.run,now:()=>now});
  expect((await router.available('claude')).available).toBe(true);
  await expect(router.turn('claude').model.next(messages)).rejects.toThrow(/OAuth session expired/);
  const after=(await router.report()).providers.find(p=>p.id==='claude')!;
  expect(after.available).toBe(false);expect(after.reason).toContain('OAuth session expired');expect(after.reason).toContain('claude auth login');
  expect(after.lastFailure).toMatchObject({at:'2026-11-06T10:00:00.000Z'});
  expect((await router.available('claude')).available).toBe(false);
  const route=await router.route('Fix the TypeScript error in src/app.ts: function foo() { return x }').catch(error=>error as Error);
  expect(route instanceof Error?route.message:route.id).not.toBe('claude');// auto routing skips the signed-out provider
  failing=false;
  const turn=router.turn('claude');await turn.model.next(messages);turn.answered();
  expect((await router.report()).providers.find(p=>p.id==='claude')!.available).toBe(true);// a later success clears it
  failing=true;await router.turn('claude').model.next(messages).catch(()=>{});
  now+=11*60*1000;// the marker expires, so a re-authorised CLI is offered again even if no call succeeded since
  expect((await router.report()).providers.find(p=>p.id==='claude')!.available).toBe(true);
 });
 it('does not mark a provider unavailable for an ordinary failure that is not about sign-in',async()=>{
  const r=runner((cmd,args)=>args[0]==='auth'||args[0]==='login'||args[0]==='--version'||args[0]==='models'?ok():ok('not json'));
  const router=new ModelRouter(offlineQwen,{runner:r.run});
  await expect(router.turn('claude').model.next(messages)).rejects.toThrow(/unreadable output/);
  const claude=(await router.report()).providers.find(p=>p.id==='claude')!;
  expect(claude.available).toBe(true);expect(claude.lastFailure?.reason).toMatch(/unreadable output/);
 });
 it('Echo Build checks sign-in with the same commands and inherits a sign-in failure from the model router',async()=>{
  expect(probeCommand('claude')).toEqual({cmd:'claude',args:['auth','status'],check:'signed-in'});
  expect(probeCommand('gpt')).toEqual({cmd:'codex',args:['login','status'],check:'signed-in'});
  expect(probeCommand('grok')).toEqual({cmd:'grok',args:['--version'],check:'installed'});
  expect(probeCommand('gemini')).toEqual({cmd:'agy',args:['--version'],check:'installed'});
  const r=runner((_cmd,args)=>args[0]==='auth'||args[0]==='login'||args[0]==='--version'||args[0]==='models'?ok():ok(JSON.stringify({is_error:true,result:'Failed to authenticate: OAuth session expired'})));
  const router=new ModelRouter(offlineQwen,{runner:r.run});
  await router.turn('claude').model.next(messages).catch(()=>{});
  const build={models:async()=>[{id:'claude',engine:'claude',available:true,check:'signed-in',checkedAt:'x'},{id:'gpt',engine:'gpt',available:true,check:'signed-in',checkedAt:'x'}]};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stand-in BuildRunner with only the probe the report reads
  const report=await new PrimeHub({capabilities:[],models:router,build:build as any}).models() as {buildProviders:{id:string;available:boolean;reason?:string}[]};
  expect(report.buildProviders.find(p=>p.id==='claude')).toMatchObject({available:false});expect(report.buildProviders.find(p=>p.id==='claude')!.reason).toContain('OAuth session expired');
  expect(report.buildProviders.find(p=>p.id==='gpt')).toMatchObject({available:true});
 });
});

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
describe('a provider failure is host text, not model text',()=>{
 it('labels a failed turn application_generated',async()=>{
  const root=mkdtempSync(join(tmpdir(),'echo-chatfix-'));roots.push(root);
  const store=new SessionStore(join(root,'state')),workspace=new Workspace(root,[store.directory]);writeFileSync(join(root,'a.ts'),'export {};\n');
  const session=store.create(workspace.root,'fixture');
  const result=await runTurn({workspace,store,sessionId:session.id,prompt:'hello',model:{next:async()=>{throw new Error('Claude (claude CLI) is unavailable: Failed to authenticate; no fallback was used');}}});
  expect(result.status).toBe('failed');expect(result.answerVerification).toBe('application_generated');
 });
});

describe('the request limit is fair per client and keeps a slot for the admission read',()=>{
 async function server(waitMs:number){
  const dir=mkdtempSync(join(tmpdir(),'prime-fair-'));roots.push(dir);writeFileSync(join(dir,'index.html'),'Prime');
  const gates:(()=>void)[]=[];let submits=0;
  const chat={status:()=>({state:'attached',busy:false,routing:false}),submit:()=>{submits++;return new Promise(resolve=>gates.push(()=>resolve({status:'completed',answer:'ok'})));}};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stand-in chat host that holds its slot until released
  const s=await startPrimeServer(new PrimeHub({capabilities:[],chat:chat as any}),dir,0,{admission:{waitMs}});
  const cookie=(await fetch(s.url)).headers.get('set-cookie')!.split(';')[0];
  const as=(client:string)=>({cookie:cookie+'; echo_workspace_session='+client.repeat(40),'x-prime-request':'1'});
  // Each held request is observed at once, so a server closed by a failing assertion never leaves an unhandled rejection.
  const slow=(client:string)=>{const pending=fetch(s.url+'/api/chat',{method:'POST',headers:{...as(client),origin:s.url,'content-type':'application/json'},body:JSON.stringify({prompt:'hold'})});pending.catch(()=>{});return pending;};
  const until=async(n:number)=>{for(let i=0;i<200&&submits<n;i++)await new Promise(r=>setTimeout(r,10));expect(submits).toBe(n);};
  return {s,as,slow,until,release:()=>gates.shift()?.(),releaseAll:()=>{while(gates.length)gates.shift()!();}};
 }
 it('caps one client at six concurrent requests while another client is still served',async()=>{
  const h=await server(150);
  try{
   const held=Array.from({length:6},()=>h.slow('a'));await h.until(6);
   const refused=await fetch(h.s.url+'/api/status',{headers:h.as('a')});
   expect(refused.status).toBe(429);expect(refused.headers.get('retry-after')).toBe('1');
   expect((await fetch(h.s.url+'/api/status',{headers:h.as('b')})).status).toBe(200);
   const bHeld=h.slow('b');await h.until(7);
   expect((await fetch(h.s.url+'/api/status',{headers:h.as('c')})).status).toBe(429);// seven general slots in use
   expect((await fetch(h.s.url+'/api/session',{headers:h.as('c')})).status).toBe(200);// the eighth is kept for the admission read
   h.releaseAll();for(const r of [...held,bHeld])expect((await r).status).toBe(200);
  }finally{h.releaseAll();await h.s.close();}
 });
 it('lets a short burst wait for a free slot instead of failing at once',async()=>{
  const h=await server(3000);
  try{
   const held=Array.from({length:6},()=>h.slow('a'));await h.until(6);
   const waiting=fetch(h.s.url+'/api/status',{headers:h.as('a')});
   await new Promise(r=>setTimeout(r,50));h.release();
   expect((await waiting).status).toBe(200);
   h.releaseAll();await Promise.all(held);
  }finally{h.releaseAll();await h.s.close();}
 });
});
