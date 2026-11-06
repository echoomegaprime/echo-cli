import {createServer,request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {afterEach, describe, expect, it,vi} from 'vitest';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';


type BrowserClient={
 readonly canLogout:boolean;headers:()=>Record<string,string>;
 loadSession:(signal?:AbortSignal)=>Promise<unknown>;clear:()=>void;
 auth:(operation:string,body?:unknown,signal?:AbortSignal)=>Promise<unknown>;
 request:(path:string,body?:unknown,signal?:AbortSignal)=>Promise<unknown>;
 chat:(input:{chat_id:string},event:(value:{type:string;text?:string})=>void,signal?:AbortSignal)=>Promise<unknown>;
};
type TransportClass=(new(options:{fetch:typeof fetch;onIdentityChange?:(session:unknown)=>void})=>BrowserClient)&{now:()=>number;SESSION_MEMO_MS:number};
async function transportFixture(stream:()=>Response,session=()=>Response.json({
 workspaceConfigured:true,authenticated:true,user:{uid:'owner',role:'owner',status:'approved'},csrf:'csrf-owner',ownerAccess:true
}),now?:()=>number){
 const window:Record<string,unknown>={};
 runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array,Blob});
 const Transport=window.EchoPrimeWorkspaceTransport as TransportClass;
 if(now)Transport.now=now;
 return new Transport({fetch:async path=>path==='/api/session'?session():stream()});
}
const doneEvent=JSON.stringify({type:'done',chat:{id:'chat-owner',messages:[]}});
describe('browser transport adversarial streams and admission',()=>{
 it('re-reads the session after one refused request without the memo, and signs out only on a signed-out readback',async()=>{
  let signedIn=true,fail=false,reads=0;const changes:unknown[]=[];
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  const Transport=window.EchoPrimeWorkspaceTransport as TransportClass;Transport.now=()=>1_000_000;
  const client=new Transport({fetch:async path=>{expect(path).toBe('/api/session');reads++;if(fail)throw new Error('issuer offline');return Response.json(signedIn?{workspaceConfigured:true,authenticated:true,user:{uid:'owner',status:'approved'},csrf:'csrf-owner',ownerAccess:true}:{workspaceConfigured:true,authenticated:false,user:null,csrf:null,ownerAccess:false});},onIdentityChange:s=>changes.push(s)}) as BrowserClient&{refresh:()=>Promise<unknown>};
  await client.loadSession();expect(changes).toHaveLength(1);
  // Same account: a fresh read (the 10 s memo is bypassed) and no identity change.
  await client.refresh();expect(reads).toBe(2);expect(changes).toHaveLength(1);
  // A failed read changes nothing: the page stays signed in.
  fail=true;await expect(client.refresh()).rejects.toThrow('issuer offline');expect(changes).toHaveLength(1);expect(client.headers()['x-echo-csrf']).toBe('csrf-owner');
  // Signed out on the server: the readback says so and only then the page changes.
  fail=false;signedIn=false;await client.refresh();expect(changes).toHaveLength(2);expect(changes[1]).toMatchObject({authenticated:false});
 });
 it('uses the newly issued login cleanup proof after an account switch and issuer outage',async()=>{
  let unavailable=false;
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  const Transport=window.EchoPrimeWorkspaceTransport as new(options:{fetch:typeof fetch})=>BrowserClient;
  const client=new Transport({fetch:async(path,init)=>{
   if(path==='/api/session'){if(unavailable)throw new Error('issuer offline');return Response.json({workspaceConfigured:true,authenticated:true,user:{uid:'old',status:'approved'},csrf:'csrf-old'});}
   if(path==='/api/workspace/auth/login')return Response.json({user:{uid:'new'},csrf:'csrf-new'});
   expect(path).toBe('/api/workspace/auth/logout');expect(new Headers(init?.headers).get('x-echo-csrf')).toBe('csrf-new');return Response.json({ok:true});
  }});
  await client.loadSession();await client.auth('login',{email:'fixture@example.test'});unavailable=true;
  await expect(client.loadSession()).rejects.toThrow();await expect(client.request('/auth/logout',{})).resolves.toMatchObject({ok:true});
 });
 it('retains cleanup-only proof after issuer outage, never admits private requests with it, and erases it after local revocation',async()=>{
  let unavailable=false,logoutCalls=0,clock=1_000_000;
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  const Transport=window.EchoPrimeWorkspaceTransport as TransportClass;Transport.now=()=>clock;
  const client=new Transport({fetch:async(path,init)=>{
   if(path==='/api/session'){if(unavailable)throw new Error('issuer offline');return Response.json({workspaceConfigured:true,authenticated:true,user:{uid:'member',status:'approved'},csrf:'csrf-member'});}
   expect(path).toBe('/api/workspace/auth/logout');expect(new Headers(init?.headers).get('x-echo-csrf')).toBe('csrf-member');logoutCalls++;return Response.json({ok:true});
  }});
  await client.loadSession();unavailable=true;clock+=11000;// past the 10 s session memo: the outage is observed on the next read
  await expect(client.loadSession()).rejects.toThrow();
  expect(client.canLogout).toBe(true);expect(client.headers()['x-echo-csrf']).toBeUndefined();
  await expect(client.request('/state')).rejects.toThrow();expect(logoutCalls).toBe(0);
  await expect(client.request('/auth/logout',{})).resolves.toMatchObject({ok:true});expect(client.canLogout).toBe(false);
  await expect(client.request('/auth/logout',{})).rejects.toThrow();expect(logoutCalls).toBe(1);
 });
 it.each(['anonymous','clear','rejected'])('erases revocation-only proof on %s without reusing it',async(kind)=>{
  let anonymous=false,clock=1_000_000;
  const client=await transportFixture(()=>new Response(JSON.stringify({error:'Denied'}),{status:403,headers:{'content-type':'application/json'}}),()=>Response.json({workspaceConfigured:true,authenticated:!anonymous,user:anonymous?null:{uid:'owner',status:'approved'},csrf:anonymous?null:'csrf-owner'}),()=>clock);
  await client.loadSession();expect(client.canLogout).toBe(true);
  if(kind==='clear')client.clear();else if(kind==='anonymous'){anonymous=true;clock+=11000;await client.loadSession();}else await expect(client.request('/auth/logout',{})).rejects.toThrow();
  expect(client.canLogout).toBe(false);
 });
 it('refuses a terminal chat beyond its separate8MiB bound without a retry',async()=>{
  let requests=0;const body=JSON.stringify({type:'done',chat:{id:'chat-owner',messages:[{role:'assistant',content:'a'.repeat(8*1024*1024)}]}})+'\n';
  const client=await transportFixture(()=>{requests++;return new Response(body,{headers:{'content-type':'application/x-ndjson'}});});
  await expect(client.chat({chat_id:'chat-owner'},()=>{})).rejects.toThrow(/exceeds limit/i);expect(requests).toBe(1);
 });
 it('discards a late sign-in/configuration body after identity invalidation',async()=>{
  let finish!:(text:string)=>void,started!:()=>void;
  const body=new Promise<string>(resolve=>{finish=resolve;}),waiting=new Promise<void>(resolve=>{started=resolve;});
  const client=await transportFixture(()=>{started();return new Response(new ReadableStream({async start(controller){controller.enqueue(new TextEncoder().encode(await body));controller.close();}}),{headers:{'content-type':'application/json'}});});
  const result=client.auth('config');await waiting;client.clear();finish(JSON.stringify({google_login_enabled:true}));
  await expect(result).rejects.toThrow(/account|session/i);
 });
 it.each([
  ['malformed JSON','{invalid}\n'],
  ['invalid event shape','[]\n'],
  ['truncation',JSON.stringify({type:'token',text:'partial'})+'\n'],
  ['duplicate terminal',doneEvent+'\n'+doneEvent+'\n'],
  ['token after terminal',doneEvent+'\n'+JSON.stringify({type:'token',text:'late'})+'\n'],
  ['unknown event after terminal',doneEvent+'\n'+JSON.stringify({type:'future_event'})+'\n'],
  ['wrong conversation',JSON.stringify({type:'done',chat:{id:'someone-else',messages:[]}})+'\n'],
  ['reported error',JSON.stringify({type:'error',error:'upstream failed'})+'\n'],
  ['oversized event',JSON.stringify({type:'token',text:'a'.repeat(256*1024)})+'\n']
 ])('rejects %s without retrying',async(_name,body)=>{
  let requests=0;
  const client=await transportFixture(()=>{requests++;return new Response(body,{headers:{'content-type':'application/x-ndjson'}});});
  await expect(client.chat({chat_id:'chat-owner'},()=>{})).rejects.toThrow();
  expect(requests).toBe(1);
 });
 it('decodes multibyte UTF-8 split across individual bytes and CRLF event lines',async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({type:'token',text:'Ω 😀'})+'\r\n'+doneEvent+'\r\n');
  const client=await transportFixture(()=>new Response(new ReadableStream({
   start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}
  }),{headers:{'content-type':'application/x-ndjson'}}));
  const tokens:string[]=[];
  await client.chat({chat_id:'chat-owner'},event=>{if(event.type==='token')tokens.push(event.text!);});
  expect(tokens).toEqual(['Ω 😀']);
 });
 it('refuses invalid UTF-8 and cancels the unread response',async()=>{
  let cancelled=false;
  const client=await transportFixture(()=>new Response(new ReadableStream({
   start(controller){controller.enqueue(new Uint8Array([0xff]));},
   cancel(){cancelled=true;}
  }),{headers:{'content-type':'application/x-ndjson'}}));
  await expect(client.chat({chat_id:'chat-owner'},()=>{})).rejects.toThrow();
  expect(cancelled).toBe(true);
 });
 it.each(['identity','abort'])('rejects completion if %s changes while EOF is pending',async(kind)=>{
  let finish!:()=>void,terminalSeen!:()=>void;
  const seen=new Promise<void>(resolve=>{terminalSeen=resolve;});
  const client=await transportFixture(()=>new Response(new ReadableStream({
   start(controller){controller.enqueue(new TextEncoder().encode(doneEvent+'\n'));finish=()=>controller.close();}
  }),{headers:{'content-type':'application/x-ndjson'}}));
  const controller=new AbortController();
  const result=client.chat({chat_id:'chat-owner'},()=>terminalSeen(),controller.signal);
  await seen;if(kind==='identity')client.clear();else controller.abort();finish();
  await expect(result).rejects.toThrow(/account|session|interrupted/i);
 });
 it('clears previously admitted identity when canonical session verification becomes unavailable',async()=>{
  let unavailable=false,clock=1_000_000;
  const client=await transportFixture(()=>Response.json({}),()=>unavailable?new Response('unavailable',{status:503}):Response.json({
   workspaceConfigured:true,authenticated:true,user:{uid:'owner',status:'approved'},csrf:'csrf-owner',ownerAccess:true
  }),()=>clock);
  await client.loadSession();unavailable=true;clock+=11000;
  await expect(client.loadSession()).rejects.toThrow();
  expect((client as unknown as {session:unknown}).session).toBeNull();
 });
 it('shares one /api/session read across transports, reuses it for 10 s, and forgets it on clear(), a login or a failed read',async()=>{
  let clock=1_000_000,calls=0,hold=true,fail=false;const pending:Array<()=>void>=[];
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  const Transport=window.EchoPrimeWorkspaceTransport as TransportClass;Transport.now=()=>clock;
  expect(Transport.SESSION_MEMO_MS).toBe(10000);
  const session={workspaceConfigured:true,authenticated:true,user:{uid:'owner',role:'owner',status:'approved'},csrf:'csrf-owner',ownerAccess:true};
  const fetchImpl=(async(path:string)=>{
   if(path==='/api/workspace/auth/login')return Response.json({user:{uid:'owner'},csrf:'csrf-owner'});
   expect(path).toBe('/api/session');calls++;
   if(hold)await new Promise<void>(resolve=>{pending.push(resolve);});
   if(fail)throw new Error('issuer offline');
   return Response.json(session);
  }) as typeof fetch;
  const changesA:unknown[]=[],changesB:unknown[]=[],changesC:unknown[]=[];
  const a=new Transport({fetch:fetchImpl,onIdentityChange:s=>changesA.push(s)}),b=new Transport({fetch:fetchImpl,onIdentityChange:s=>changesB.push(s)}),c=new Transport({fetch:fetchImpl,onIdentityChange:s=>changesC.push(s)});
  // Three transports (workspace.js, fleet.js and a third) read at once and share one request; the joiner that aborts neither
  // cancels it for the others nor loses the identity it holds.
  const controller=new AbortController();
  const settled=Promise.allSettled([a.loadSession(),b.loadSession(),c.loadSession(controller.signal)]);
  await vi.waitFor(()=>expect(pending).toHaveLength(1));controller.abort();pending.splice(0).forEach(release=>release());
  const [first,second,third]=await settled;
  expect(first).toMatchObject({status:'fulfilled',value:{authenticated:true}});expect(second).toMatchObject({status:'fulfilled',value:{authenticated:true}});
  expect(third).toMatchObject({status:'rejected',reason:expect.objectContaining({message:'Session read interrupted.'})});
  expect(calls).toBe(1);expect(changesA).toHaveLength(1);expect(changesB).toHaveLength(1);expect(changesC).toHaveLength(0);
  expect((a as unknown as {session:unknown}).session).toMatchObject({authenticated:true});expect((c as unknown as {session:unknown}).session).toBeNull();
  hold=false;
  clock+=9999;await a.loadSession();await b.loadSession();expect(calls).toBe(1);// memo hits within 10 s: no request, no change event
  expect(changesA).toHaveLength(1);expect(changesB).toHaveLength(1);
  clock+=1;await a.loadSession();expect(calls).toBe(2);// the memo is good for 10 s, not longer
  a.clear();expect(changesA).toHaveLength(2);await b.loadSession();expect(calls).toBe(3);// clear() on any transport forgets the shared readback
  await a.auth('login',{email:'fixture@example.test'});await a.loadSession();expect(calls).toBe(4);// a login forgets it too
  expect(changesA).toHaveLength(3);await b.loadSession();expect(calls).toBe(4);
  clock+=11000;fail=true;await expect(a.loadSession()).rejects.toThrow();expect(calls).toBe(5);
  fail=false;await b.loadSession();expect(calls).toBe(6);// a failed read is never memoized
 });
 it('preserves local logout when an account is pending and current issuer verification is unavailable',async()=>{
  let unavailable=false,logoutCalls=0;
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  const Transport=window.EchoPrimeWorkspaceTransport as new(options:{fetch:typeof fetch})=>BrowserClient;
  const client=new Transport({fetch:async(path,init)=>{
   if(path==='/api/session'){
    if(unavailable)throw new Error('issuer offline');
    return Response.json({workspaceConfigured:true,authenticated:true,user:{uid:'member',status:'pending'},csrf:'csrf-pending'});
   }
   expect(path).toBe('/api/workspace/auth/logout');
   expect(new Headers(init?.headers).get('x-echo-csrf')).toBe('csrf-pending');logoutCalls++;return Response.json({ok:true});
  }});
  await client.loadSession();unavailable=true;
  await expect(client.request('/auth/logout',{})).resolves.toMatchObject({ok:true});
  expect(logoutCalls).toBe(1);
 });
});

const ui=fileURLToPath(new URL('../ui/echo-prime/',import.meta.url));
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function ownerFixture(authEnabled=true){
 const tokens={owner:randomBytes(32).toString('hex'),member:randomBytes(32).toString('hex'),admin:randomBytes(32).toString('hex')};
 const calls:Array<{path:string;cookie:string;origin:string|undefined;authorization:string|undefined}>=[];
 const revoked=new Set<string>();
 const bodies:Array<{path:string;body:string}>=[];
 const pending=new Set<string>();
 const roles=new Map<string,string>();
 const behavior={delayMs:0,actionDelayMs:0,historyText:'',tokenText:'Hello Ω',legacyOwnerUid:'owner',stateUid:'',stateCsrf:'',resendLimitedHeader:''};
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/','http://localhost'),cookie=req.headers.cookie??'';
  const account=(Object.keys(tokens) as Array<keyof typeof tokens>).find(k=>cookie===`echo_workspace_session=${tokens[k]}`&&!revoked.has(k));
  calls.push({path:url.pathname,cookie,origin:req.headers.origin,authorization:req.headers.authorization});
  const json=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(url.pathname==='/api/auth/session'){
   if(!authEnabled){json(404,{error:'Not found'});return;}
   json(200,{authenticated:!!account,user:account?{uid:account,role:roles.get(account)??(account==='member'?'member':'owner'),status:pending.has(account)?'pending':'approved',name:account}:null,csrf:account?`csrf-${account}`:null});return;
  }
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){
   let text='';for await(const chunk of req)text+=chunk;
   const input=JSON.parse(text) as {account:keyof typeof tokens};
   if(req.headers['x-echo-csrf']!=='login'||!tokens[input.account]){json(403,{error:'Denied'});return;}
   res.setHeader('set-cookie',`echo_workspace_session=${tokens[input.account]}; HttpOnly; Path=/; SameSite=Lax`);
   json(200,{user:{uid:input.account,role:input.account==='member'?'member':'owner'},csrf:`csrf-${input.account}`});return;
  }
  if(!account){json(401,{error:'Sign in required'});return;}
  if(req.method==='POST'&&req.headers['x-echo-csrf']!==`csrf-${account}`){json(403,{error:'Wrong CSRF'});return;}
  if(url.pathname==='/api/auth/logout'){revoked.add(account);res.setHeader('set-cookie','echo_workspace_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');json(200,{ok:true});return;}
  if(url.pathname==='/api/auth/accounts'){json(200,{accounts:[{uid:'owner',role:'owner',status:'approved'}]});return;}
  if(url.pathname==='/api/auth/decide'){json(200,{ok:true});return;}
  if(url.pathname==='/api/auth/invites'){json(200,{invites:[]});return;}
  if(['/api/auth/usage','/api/auth/invite','/api/auth/invite/resend','/api/auth/invite/revoke'].includes(url.pathname)){
   let text='';for await(const chunk of req)text+=chunk;bodies.push({path:url.pathname,body:text});
   // A rate-limited resend names the wait in the body and in Retry-After (what the Workspace answers).
   if(url.pathname==='/api/auth/invite/resend'&&behavior.resendLimitedHeader){res.writeHead(429,{'content-type':'application/json','retry-after':behavior.resendLimitedHeader});res.end(JSON.stringify({error:'Too many attempts.',retry_after:600}));return;}
   if(url.pathname==='/api/auth/invite'||url.pathname==='/api/auth/invite/resend'){json(200,{invite:{id:'invite-id',email:'new@example.test',status:'active'},email:{sent:true,message_id:'msg-1'}});return;}
   json(200,{ok:true});return;
  }
  if(url.pathname==='/api/state'){if(behavior.delayMs)await new Promise(resolve=>setTimeout(resolve,behavior.delayMs));json(200,{auth_enabled:true,tenant_isolation:account!==behavior.legacyOwnerUid,user:{uid:behavior.stateUid||account},csrf:behavior.stateCsrf||`csrf-${account}`,chats:[{id:`chat-${account}`,title:`Private ${account}`}],projects:[],library:[]});return;}
  if(['/api/action','/api/sync','/api/plugins'].includes(url.pathname)){if(behavior.actionDelayMs)await new Promise(resolve=>setTimeout(resolve,behavior.actionDelayMs));json(200,{ok:true});return;}
  if(['/api/voice/start','/api/voice/next','/api/voice/transcribe','/api/review','/api/compact'].includes(url.pathname)){
   if(behavior.delayMs)await new Promise(resolve=>setTimeout(resolve,behavior.delayMs));json(200,{ok:true});return;
  }
  if(url.pathname==='/api/chats'){json(200,[{id:`chat-${account}`,title:`Private ${account}`}]);return;}
  if(url.pathname.startsWith('/api/chats/')){json(url.pathname===`/api/chats/chat-${account}`?200:404,url.pathname===`/api/chats/chat-${account}`?{id:`chat-${account}`,messages:[]}:{error:'Not found'});return;}
  if(url.pathname==='/api/chat'){
   let text='';for await(const chunk of req)text+=chunk;
   const input=JSON.parse(text) as {chat_id:string};
   if(input.chat_id!==`chat-${account}`){json(404,{error:'Not found'});return;}
   res.writeHead(200,{'content-type':'application/x-ndjson'});
   res.write(JSON.stringify({type:'status',status:'working'})+'\n');
   res.write(JSON.stringify({type:'token',text:behavior.tokenText})+'\n');
   res.end(JSON.stringify({type:'done',chat:{id:input.chat_id,messages:[...(behavior.historyText?[{role:'user',content:behavior.historyText}]:[]),{role:'assistant',content:'Hello Ω'}]}})+'\n');return;
  }
  json(404,{error:'Not found'});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 cleanup.push(()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture missing address');
 return {baseUrl:`http://127.0.0.1:${address.port}`,calls,bodies,revoked,pending,roles,behavior};
}
async function prime(baseUrl:string,ownerUid='owner'){
 // Reflect permits the RED test against the existing three-argument host.
 const server=await Reflect.apply(startPrimeServer,undefined,[new PrimeHub({capabilities:[]}),ui,0,{workspace:{baseUrl,ownerUid}}]) as Awaited<ReturnType<typeof startPrimeServer>>;
 cleanup.push(server.close);
 const root=await fetch(server.url),cookie=(root.headers.get('set-cookie')??'').split(';')[0];
 return {url:server.url,cookie};
}
function headers(p:{url:string;cookie:string;csrf?:string},csrf=p.csrf){return {'x-prime-request':'1',cookie:p.cookie,origin:p.url,'content-type':'application/json',...(csrf?{'x-echo-csrf':csrf}:{})};}
async function login(p:{url:string;cookie:string},account:string){
 const response=await fetch(p.url+'/api/workspace/auth/login',{method:'POST',headers:headers(p,'login'),body:JSON.stringify({account})});
 expect(response.status).toBe(200);
 const data=await response.json() as {csrf:string};
 return {...p,csrf:data.csrf,cookie:p.cookie+'; '+(response.headers.get('set-cookie')??'').split(';')[0]};
}
describe('canonical Workspace boundary in the existing Prime host',()=>{
 it.each(['http://echoomegaprime.com','https://127.0.0.1','https://localhost','https://user@example.test','https://echoomegaprime.com/path','https://echoomegaprime.com?x=1','https://echoomegaprime.com#fragment','https://echoomegaprime.com:444'])('refuses unsafe public origin %s',async publicOrigin=>{
  const upstream=await ownerFixture();
  await expect(startPrimeServer(new PrimeHub({capabilities:[]}),ui,0,{workspace:{baseUrl:upstream.baseUrl,ownerUid:'owner'},publicOrigin})).rejects.toThrow(/origin/i);
 });
 it('refuses public mode without a configured authenticated backend and pinned primary owner',async()=>{
  await expect(startPrimeServer(new PrimeHub({capabilities:[]}),ui,0,{publicOrigin:'https://echoomegaprime.com'})).rejects.toThrow(/authenticated|owner/i);
  const upstream=await ownerFixture();
  await expect(startPrimeServer(new PrimeHub({capabilities:[]}),ui,0,{workspace:{baseUrl:upstream.baseUrl},publicOrigin:'https://echoomegaprime.com'})).rejects.toThrow(/owner/i);
 });
 it('binds public Host and Origin explicitly, secures both cookies, and retains current tenant/owner admission behind the TLS proxy',async()=>{
  const upstream=await ownerFixture(),publicOrigin='https://echoomegaprime.com';
  const server=await startPrimeServer(new PrimeHub({capabilities:[]}),ui,0,{workspace:{baseUrl:upstream.baseUrl,ownerUid:'owner'},publicOrigin});cleanup.push(server.close);
  const request=(path:string,extra:Record<string,string>={},body?:unknown)=>new Promise<{status:number;cookie:string;body:string;csp:string}>((resolve,reject)=>{
   const req=httpRequest(server.url+path,{method:body===undefined?'GET':'POST',headers:{host:'echoomegaprime.com','x-prime-request':'1',...(body===undefined?{}:{'content-type':'application/json'}),...extra}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode!,cookie:res.headers['set-cookie']?.[0]??'',body:text,csp:String(res.headers['content-security-policy']??'')}));
   });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const root=await request('/');expect(root.status).toBe(200);expect(root.cookie).toMatch(/; Secure(?:;|$)/);expect(root.cookie).toContain('HttpOnly');
  // Behind the TLS proxy Cloudflare may inject its Web Analytics beacon; only the public-origin server admits its two origins.
  expect(root.csp).toContain("script-src 'self' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com;");
  expect(root.csp).toContain("connect-src 'self' https://accounts.google.com https://cloudflareinsights.com;");
  const primeCookie=root.cookie.split(';')[0];
  expect((await request('/api/session',{cookie:primeCookie})).status).toBe(200);
  expect((await request('/api/session',{cookie:primeCookie,host:'www.echoomegaprime.com'})).status).toBe(403);
  expect((await fetch(server.url)).status).toBe(403);
  for(const origin of ['http://echoomegaprime.com','https://attacker.example',server.url])expect((await request('/api/workspace/auth/login',{cookie:primeCookie,origin,'x-echo-csrf':'login'},{account:'member'})).status).toBe(403);
  const signedIn=await request('/api/workspace/auth/login',{cookie:primeCookie,origin:publicOrigin,'x-echo-csrf':'login'},{account:'member'});
  expect(signedIn.status).toBe(200);expect(signedIn.cookie).toMatch(/; Secure(?:;|$)/);expect(signedIn.cookie).toContain('HttpOnly');
  const cookie=primeCookie+'; '+signedIn.cookie.split(';')[0],csrf=(JSON.parse(signedIn.body) as {csrf:string}).csrf;
  expect((await request('/api/workspace/state',{cookie,'x-echo-csrf':csrf})).status).toBe(200);
  expect((await request('/api/workspace/state',{cookie,'x-echo-csrf':'csrf-owner'})).status).toBe(403);
  expect((await request('/api/status',{cookie,'x-echo-csrf':csrf})).status).toBe(403);
  const logout=await request('/api/workspace/auth/logout',{cookie,origin:publicOrigin,'x-echo-csrf':csrf},{});expect(logout.status).toBe(200);expect(logout.cookie).toContain('Max-Age=0');expect(logout.cookie).toMatch(/; Secure(?:;|$)/);
  expect(JSON.parse((await request('/api/session',{cookie})).body)).toMatchObject({authenticated:false,user:null,csrf:null});
  expect(upstream.calls.every(c=>!c.cookie.includes('echo_prime=')&&!c.authorization)).toBe(true);
 });
 it('keeps the Cloudflare beacon origins out of a loopback CSP and serves the shipped Echo orb favicon the page links',async()=>{
  const upstream=await ownerFixture(),p=await prime(upstream.baseUrl);
  const page=await fetch(p.url);expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self' https://accounts.google.com/gsi/client;");
  expect(page.headers.get('content-security-policy')).not.toContain('cloudflareinsights');
  expect(await page.text()).toContain('<link rel="icon" type="image/svg+xml" href="favicon.svg">');
  for(const path of ['/favicon.svg','/favicon.ico']){
   const icon=await fetch(p.url+path);expect(icon.status,path).toBe(200);expect(icon.headers.get('content-type')).toBe('image/svg+xml');
   const svg=await icon.text();expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org\/)/);// the mark carries no external asset (only the SVG namespace)
   const head=await fetch(p.url+path,{method:'HEAD'});expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(svg)));expect(await head.text()).toBe('');
  }
  const head=await fetch(p.url,{method:'HEAD'});expect(head.status).toBe(200);expect(head.headers.get('set-cookie')).toMatch(/^echo_prime=/);expect(await head.text()).toBe('');
 });
 it.each(['demoted owner','configured UID mismatch'])('refuses unisolated legacy-owner data and model tools for %s',async(kind)=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl,kind==='configured UID mismatch'?'admin':'owner'),'owner');
  if(kind==='demoted owner')upstream.roles.set('owner','member');
  for(const path of ['state','chats','chat']){
   const response=await fetch(p.url+'/api/workspace/'+path,{headers:headers(p),...(path==='chat'?{method:'POST',body:JSON.stringify({chat_id:'chat-owner',content:'test'})}:{})});
   expect(response.status,path).toBe(403);expect(await response.text()).not.toContain('Private owner');
  }
  expect(upstream.calls.filter(c=>['/api/chat','/api/chats'].includes(c.path))).toHaveLength(0);
 });
 it.each(['stateUid','stateCsrf'])('requires tenant attestation to match the current %s',async(key)=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'member');upstream.behavior[key]='foreign';
  expect((await fetch(p.url+'/api/workspace/chats',{headers:headers(p)})).status).toBe(403);
  expect(upstream.calls.filter(c=>c.path==='/api/chats')).toHaveLength(0);
 });
 it('keeps engineering actions, plugin configuration and global sync primary-owner-only while allowing exact tenant-safe actions',async()=>{
  const upstream=await ownerFixture(),root=await prime(upstream.baseUrl),member=await login(root,'member'),admin=await login(root,'admin'),owner=await login(root,'owner');
  for(const p of [member,admin]){
   for(const action of ['esh','sdk','vault','memory_search','memory_save_extra'])expect((await fetch(p.url+'/api/workspace/action',{method:'POST',headers:headers(p),body:JSON.stringify({action})})).status).toBe(403);
   expect((await fetch(p.url+'/api/workspace/plugins',{headers:headers(p)})).status).toBe(403);
   expect((await fetch(p.url+'/api/workspace/sync',{method:'POST',headers:headers(p),body:'{}'})).status).toBe(403);
   for(const action of ['memory_save','memory_forget','personality_select'])expect((await fetch(p.url+'/api/workspace/action',{method:'POST',headers:headers(p),body:JSON.stringify({action})})).status).toBe(200);
  }
  expect(upstream.calls.filter(c=>c.path==='/api/action')).toHaveLength(6);
  expect((await fetch(owner.url+'/api/workspace/action',{method:'POST',headers:headers(owner),body:JSON.stringify({action:'esh'})})).status).toBe(200);
 });
 it('gives a single owner ESH action a finite connector budget while ordinary local actions remain bounded',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');upstream.behavior.actionDelayMs=450;
  const timeout=AbortSignal.timeout.bind(AbortSignal),spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>timeout(Math.max(1,Math.floor(ms/100))));
  try{
   expect((await fetch(p.url+'/api/workspace/action',{method:'POST',headers:headers(p),body:JSON.stringify({action:'esh'})})).status).toBe(200);
   expect((await fetch(p.url+'/api/workspace/action',{method:'POST',headers:headers(p),body:JSON.stringify({action:'personality_select'})})).status).toBe(502);
   expect(upstream.calls.filter(c=>c.path==='/api/action')).toHaveLength(2);
  }finally{spy.mockRestore();}
 });
 it('allows canonical provider operations to outlive the normal metadata deadline while preserving a finite ordinary deadline',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');upstream.behavior.delayMs=450;
  const timeout=AbortSignal.timeout.bind(AbortSignal);
  // Compress real deadlines for this real-HTTP regression:20s becomes200ms,
  // while each canonical provider operation retains its longer finite budget.
  const spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>timeout(Math.max(1,Math.floor(ms/100))));
  try{
   for(const path of ['voice/start','voice/next','voice/transcribe','review','compact']){
    const response=await fetch(p.url+'/api/workspace/'+path,{method:'POST',headers:headers(p),body:'{}'});
    expect(response.status,path).toBe(200);expect(await response.json()).toMatchObject({ok:true});
   }
   expect((await fetch(p.url+'/api/workspace/state',{headers:headers(p)})).status).toBe(502);
   expect(upstream.calls.filter(c=>c.path==='/api/review')).toHaveLength(1);
  }finally{spy.mockRestore();}
 });
 it('delivers a large canonical terminal history through both actual HTTP and browser parsing without relaxing token limits',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'member');upstream.behavior.historyText='prior '.repeat(90000);
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  const Transport=window.EchoPrimeWorkspaceTransport as new(options:{fetch:typeof fetch})=>BrowserClient;
  const client=new Transport({fetch:(path,init)=>fetch(p.url+String(path),{...init,headers:{...init?.headers,cookie:p.cookie,origin:p.url}})});
  const result=await client.chat({chat_id:'chat-member'},()=>{}) as {messages:Array<{content:string}>};
  expect(result.messages[0].content).toBe(upstream.behavior.historyText);
  upstream.behavior.tokenText='token '.repeat(50000);
  await expect(client.chat({chat_id:'chat-member'},()=>{})).rejects.toThrow();
  expect(upstream.calls.filter(c=>c.path==='/api/chat')).toHaveLength(2);
 });
 it('serves the adapted canonical privacy notice and stylesheet before account sign-in',async()=>{
  const upstream=await ownerFixture(),p=await prime(upstream.baseUrl);
  const response=await fetch(p.url+'/privacy');expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  const text=await response.text();expect(text).toContain('does not grant access to a Workspace account');
  expect(text).toContain('href="/privacy.css"');expect(text).not.toContain('href="/login"');
  expect((await fetch(p.url+'/privacy.css')).headers.get('content-type')).toContain('text/css');
  expect(upstream.calls.every(c=>c.path==='/api/auth/session')).toBe(true);
 });
 it('denies a configured primary UID after its canonical owner role is removed',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');
  upstream.roles.set('owner','member');
  expect((await fetch(p.url+'/api/status',{headers:headers(p)})).status).toBe(403);
  const session=await fetch(p.url+'/api/session',{headers:headers(p)});
  expect(await session.json()).toMatchObject({ownerAccess:false});
 });
 it('offers an anonymous session view and denies private data before contacting owner data routes',async()=>{
  const upstream=await ownerFixture(),p=await prime(upstream.baseUrl);
  const session=await fetch(p.url+'/api/session',{headers:headers(p)});
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({workspaceConfigured:true,authenticated:false});
  const state=await fetch(p.url+'/api/workspace/state',{headers:headers(p)});
  expect(state.status).toBe(401);
  const steward=await fetch(p.url+'/api/steward/status',{headers:headers(p)});
  expect(steward.status).toBe(401);
  expect(upstream.calls.filter(c=>c.path==='/api/state')).toHaveLength(0);
 });
 it('keeps member, secondary admin and primary owner access separate using current upstream identity',async()=>{
  const upstream=await ownerFixture(),p=await prime(upstream.baseUrl);
  const member=await login(p,'member'),owner=await login(p,'owner'),admin=await login(p,'admin');
  const memberState=await fetch(p.url+'/api/workspace/state',{headers:headers(member)});
  expect(await memberState.json()).toMatchObject({user:{uid:'member'},chats:[{id:'chat-member'}]});
  expect((await fetch(p.url+'/api/workspace/chats/chat-owner',{headers:headers(member)})).status).toBe(404);
  expect((await fetch(p.url+'/api/status',{headers:headers(member)})).status).toBe(403);
  expect((await fetch(p.url+'/api/status',{headers:headers(admin)})).status).toBe(403);
  expect((await fetch(p.url+'/api/status',{headers:headers(owner)})).status).toBe(200);
  upstream.revoked.add('owner');
  expect((await fetch(p.url+'/api/status',{headers:headers(owner)})).status).toBe(401);
  expect(upstream.calls.every(c=>!c.cookie.includes('echo_prime=')&&!c.authorization)).toBe(true);
 });
 it('keeps general NDJSON chat distinct from the existing bounded coding route',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'member');
  const response=await fetch(p.url+'/api/workspace/chat',{method:'POST',headers:headers(p,'csrf-member'),body:JSON.stringify({chat_id:'chat-member',content:'Hello',request_id:crypto.randomUUID(),attachments:[]})});
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  expect(events.map(e=>e.type)).toEqual(['status','token','done']);
  expect(events[1].text).toBe('Hello Ω');
  expect((await fetch(p.url+'/api/chat',{method:'POST',headers:headers(p,'csrf-member'),body:JSON.stringify({prompt:'Hello'})})).status).toBe(403);
 });
 it('refuses an authentication-disabled owner backend',async()=>{
  const upstream=await ownerFixture(false);
  const result=await prime(upstream.baseUrl).then(()=>({started:true,error:''}),error=>({started:false,error:error instanceof Error?error.message:'Unknown error'}));
  expect(result).toMatchObject({started:false,error:expect.stringMatching(/authenticated Workspace/i)});
  expect(upstream.calls.every(c=>c.path==='/api/auth/session')).toBe(true);
 });
 it('does not turn a pending primary owner login into approved operational admission',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');
  upstream.pending.add('owner');
  expect((await fetch(p.url+'/api/status',{headers:headers(p)})).status).toBe(403);
  expect((await fetch(p.url+'/api/workspace/state',{headers:headers(p)})).status).toBe(403);
  expect(upstream.calls.filter(c=>c.path==='/api/state')).toHaveLength(0);
 });
 it('does not expose engineering observations through the member Workspace namespace',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'member');
  for(const path of ['fleet','diagnostics','catalog'])expect((await fetch(p.url+'/api/workspace/'+path,{headers:headers(p)})).status).toBe(403);
  expect(upstream.calls.filter(c=>['/api/fleet','/api/diagnostics','/api/catalog'].includes(c.path))).toHaveLength(0);
 });
 it('restricts canonical account administration to the currently approved primary owner',async()=>{
  const upstream=await ownerFixture(),root=await prime(upstream.baseUrl);
  const owner=await login(root,'owner'),member=await login(root,'member'),admin=await login(root,'admin');
  for(const p of [member,admin]){
   expect((await fetch(p.url+'/api/workspace/auth/accounts',{headers:headers(p)})).status).toBe(403);
   expect((await fetch(p.url+'/api/workspace/auth/decide',{method:'POST',headers:headers(p),body:JSON.stringify({uid:'member',decision:'approve'})})).status).toBe(403);
  }
  expect((await fetch(owner.url+'/api/workspace/auth/accounts',{headers:headers(owner)})).status).toBe(200);
  expect((await fetch(owner.url+'/api/workspace/auth/decide',{method:'POST',headers:headers(owner),body:JSON.stringify({uid:'member',decision:'approve'})})).status).toBe(200);
  expect(upstream.calls.filter(c=>c.path==='/api/auth/accounts')).toHaveLength(1);
  expect(upstream.calls.filter(c=>c.path==='/api/auth/decide')).toHaveLength(1);
 });
 it('restricts the member-management routes (usage, invites, invite, resend, revoke) to the currently approved primary owner',async()=>{
  const upstream=await ownerFixture(),root=await prime(upstream.baseUrl);
  const owner=await login(root,'owner'),member=await login(root,'member'),admin=await login(root,'admin');
  const routes:Array<[string,string,unknown]>=[['GET','invites',undefined],['POST','usage',{uid:'member'}],['POST','invite',{email:'new@example.test'}],['POST','invite/resend',{invite_id:'invite-id'}],['POST','invite/revoke',{id:'invite-id'}]];
  const call=(p:typeof owner,[method,path,body]:[string,string,unknown])=>fetch(p.url+'/api/workspace/auth/'+path,{method,headers:headers(p),...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(const p of [member,admin])for(const route of routes)expect((await call(p,route)).status,route[1]).toBe(403);
  for(const path of ['/api/auth/invites','/api/auth/usage','/api/auth/invite','/api/auth/invite/resend','/api/auth/invite/revoke'])expect(upstream.calls.filter(c=>c.path===path)).toHaveLength(0);
  for(const route of routes)expect((await call(owner,route)).status,route[1]).toBe(200);
  for(const path of ['/api/auth/invites','/api/auth/usage','/api/auth/invite','/api/auth/invite/resend','/api/auth/invite/revoke'])expect(upstream.calls.filter(c=>c.path===path),path).toHaveLength(1);
  // Owner writes still need the current session CSRF, and the invite list takes no query.
  expect((await fetch(owner.url+'/api/workspace/auth/usage',{method:'POST',headers:headers(owner,'csrf-member'),body:JSON.stringify({uid:'member'})})).status).toBe(403);
  expect((await fetch(owner.url+'/api/workspace/auth/invites?x=1',{headers:headers(owner)})).status).toBe(400);
  expect(upstream.calls.filter(c=>['/api/auth/usage','/api/auth/invites'].includes(c.path))).toHaveLength(2);
 });
 // Emailed invitations (PRIME_MEMBERS_CONTRACT.md): Prime passes the request and the Workspace's `email` result through
 // untouched, adds nothing of its own, and relays a rate limit's wait to the browser as Retry-After.
 it('passes send_email, invite_id and the email result through the owner invite and resend routes untouched',async()=>{
  const upstream=await ownerFixture(),owner=await login(await prime(upstream.baseUrl),'owner');
  const post=(path:string,body:unknown)=>fetch(owner.url+'/api/workspace/auth/'+path,{method:'POST',headers:headers(owner),body:JSON.stringify(body)});
  const created=await post('invite',{email:'new@example.test',send_email:true});
  expect(created.status).toBe(200);expect(await created.json()).toEqual({invite:{id:'invite-id',email:'new@example.test',status:'active'},email:{sent:true,message_id:'msg-1'}});
  const resent=await post('invite/resend',{invite_id:'invite-id'});
  expect(resent.status).toBe(200);expect(await resent.json()).toMatchObject({email:{sent:true,message_id:'msg-1'}});
  expect(upstream.bodies.map(b=>[b.path,JSON.parse(b.body)])).toEqual([['/api/auth/invite',{email:'new@example.test',send_email:true}],['/api/auth/invite/resend',{invite_id:'invite-id'}]]);
 });
 it('relays the wait of a rate-limited resend as Retry-After, and only when it is a number of seconds',async()=>{
  const upstream=await ownerFixture(),owner=await login(await prime(upstream.baseUrl),'owner');
  const resend=()=>fetch(owner.url+'/api/workspace/auth/invite/resend',{method:'POST',headers:headers(owner),body:JSON.stringify({invite_id:'invite-id'})});
  upstream.behavior.resendLimitedHeader='600';
  const limited=await resend();
  expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).toBe('600');expect(await limited.json()).toEqual({error:'Too many attempts.',retry_after:600});
  upstream.behavior.resendLimitedHeader='Wed, 21 Oct 2026 07:28:00 GMT';
  const dated=await resend();
  expect(dated.status).toBe(429);expect(dated.headers.get('retry-after')).toBeNull();expect(await dated.json()).toEqual({error:'Too many attempts.',retry_after:600});
 });
 it('rejects invalid UTF-8 request bytes before any upstream write',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');
  const count=upstream.calls.filter(c=>c.path==='/api/chats').length;
  const response=await fetch(p.url+'/api/workspace/chats',{method:'POST',headers:headers(p),body:new Uint8Array([123,34,120,34,58,34,255,34,125])});
  expect(response.status).toBe(400);
  expect(upstream.calls.filter(c=>c.path==='/api/chats')).toHaveLength(count);
 });
 it('refuses foreign origins, ambiguous account cookies and caller-selected destinations',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');
  const count=upstream.calls.length;
  expect((await fetch(p.url+'/api/workspace/chats',{headers:{...headers(p),origin:'https://untrusted.invalid'}})).status).toBe(403);
  expect((await fetch(p.url+'/api/workspace/chats',{headers:{...headers(p),cookie:p.cookie+'; echo_workspace_session='+randomBytes(32).toString('hex')}})).status).toBe(403);
  expect((await fetch(p.url+'/api/workspace/chats?tenant=owner',{headers:headers(p)})).status).toBe(400);
  expect((await fetch(p.url+'/api/workspace/proxy?url=http://127.0.0.1:1',{headers:headers(p)})).status).toBe(404);
  expect(upstream.calls).toHaveLength(count);
 });
 it('requires the current canonical session CSRF on owner writes',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'owner');
  expect((await fetch(p.url+'/api/prepare',{method:'POST',headers:headers(p,''),body:'{}'})).status).toBe(403);
  expect((await fetch(p.url+'/api/workspace/chat',{method:'POST',headers:headers(p,'csrf-member'),body:'{}'})).status).toBe(403);
  expect(upstream.calls.filter(c=>c.path==='/api/chat')).toHaveLength(0);
 });
 it('binds data reads to the displayed account session during a cookie change in another tab',async()=>{
  const upstream=await ownerFixture(),root=await prime(upstream.baseUrl);
  const owner=await login(root,'owner'),member=await login(root,'member');
  const before=upstream.calls.length;
  expect((await fetch(root.url+'/api/workspace/state',{headers:headers(member,owner.csrf)})).status).toBe(403);
  expect(upstream.calls.slice(before).every(c=>c.path==='/api/auth/session')).toBe(true);
 });
 it('serves a browser transport that consumes real general-chat events and current tenant admission',async()=>{
  const upstream=await ownerFixture(),p=await login(await prime(upstream.baseUrl),'member');
  const script=await fetch(p.url+'/workspace-client.js');
  expect(script.status).toBe(200);
  const window:Record<string,unknown>={};
  runInNewContext(await script.text(),{window,TextDecoder,TextEncoder,AbortController,Uint8Array,fetch});
  type Transport={loadSession:()=>Promise<unknown>;chat:(input:unknown,event:(value:{type:string})=>void,signal?:AbortSignal)=>Promise<{id:string}>};
  const Transport=window.EchoPrimeWorkspaceTransport as new(options:{fetch:typeof fetch})=>Transport;
  const request:typeof fetch=(path,init)=>fetch(p.url+String(path),{...init,headers:{...init?.headers,cookie:p.cookie,origin:p.url}});
  const client=new Transport({fetch:request});
  expect(await client.loadSession()).toMatchObject({workspaceConfigured:true,user:{uid:'member'}});
  const events:string[]=[];
  const result=await client.chat({chat_id:'chat-member',content:'Hi',request_id:crypto.randomUUID(),attachments:[]},value=>events.push(value.type));
  expect(result.id).toBe('chat-member');
  expect(events).toEqual(['status','token','done']);
 });
 it('discards a pending private response when the browser account is cleared',async()=>{
  const window:Record<string,unknown>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window,TextDecoder,TextEncoder,Uint8Array});
  type Client={loadSession:()=>Promise<unknown>;clear:()=>void;request:(path:string)=>Promise<unknown>};
  const Transport=window.EchoPrimeWorkspaceTransport as new(options:{fetch:typeof fetch})=>Client;
  let finish!:(value:string)=>void,started!:()=>void;
  const body=new Promise<string>(resolve=>{finish=resolve;}),waiting=new Promise<void>(resolve=>{started=resolve;});
  const request:typeof fetch=async path=>{
   if(path==='/api/session')return Response.json({workspaceConfigured:true,authenticated:true,user:{uid:'member',status:'approved'},csrf:'csrf-member'});
   started();return new Response(new ReadableStream({async start(controller){controller.enqueue(new TextEncoder().encode(await body));controller.close();}}),{headers:{'content-type':'application/json'}});
  };
  const client=new Transport({fetch:request});await client.loadSession();
  const pending=client.request('/state');await waiting;client.clear();finish(JSON.stringify({private:'previous-account'}));
  await expect(pending).rejects.toThrow(/account|session|interrupted/i);
 });
});
