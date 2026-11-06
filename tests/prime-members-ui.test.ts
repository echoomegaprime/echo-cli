/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// The owner's Members view (PRIME_MEMBERS_CONTRACT.md) runs in the shipped workspace.js against a small DOM. The
// Workspace transport and the Prime uploads fetch are synthetic, so every request the view makes is recorded and every
// body is exact. Members and anonymous visitors must never reach a members route at all.
class Node {
 textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;isConnected=true;
 tagName:string;dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};selected=0;
 classList={add:vi.fn(),remove:vi.fn(),toggle:vi.fn(),contains:()=>false};
 style={setProperty:vi.fn()};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:Node[]){for(const item of items){item.parent=this;item.isConnected=true;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this.append(...items);}
 remove(){if(!this.parent)return;this.parent.children=this.parent.children.filter(c=>c!==this);this.isConnected=false;this.parent=null;}
 setAttribute(key:string,value:string){this.attributes[key]=String(value);if(key==='value')this.value=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of [...(this.events[name]||[])])await fn({preventDefault(){},target:this,...event});}
 showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}
 focus(){} before(){} select(){this.selected++;}
 querySelector(selector:string):Node|null{return this.children.find(n=>n.tagName.toLowerCase()===selector)||this.children.map(n=>n.querySelector(selector)).find(Boolean)||null;}
}
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
const descendants=(node:Node):Node[]=>node.children.flatMap(child=>[child,...descendants(child)]);
const text=(node:Node):string=>[node.textContent,...node.children.map(text)].join(' ').replace(/\s+/g,' ').trim();
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));};
function deferred<T=any>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

const ownerSession=()=>({workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'csrf-owner',user:{uid:'owner',role:'owner',status:'approved',email:'commander@example.test'}});
const memberSession=()=>({workspaceConfigured:true,authenticated:true,ownerAccess:false,csrf:'csrf-member',user:{uid:'m-approved',role:'member',status:'approved',email:'approved@example.test'}});
const anonymousSession=()=>({workspaceConfigured:true,authenticated:false,ownerAccess:false,csrf:null,user:null});
const row=(uid:string,status:string,extra:Record<string,unknown>={})=>({uid,tenant:'t-'+uid,email:uid.slice(2)+'@example.test',role:'member',status,created:1730000000,updated:1730000050,active_sessions:0,last_login:null,last_seen:null,login_count:0,banned_at:null,via_invite:false,...extra});
const accounts=()=>({accounts:[row('m-pending','pending',{active_sessions:1,login_count:1,last_login:1730000100}),row('m-approved','approved',{active_sessions:2,login_count:5,last_login:1730000200,last_seen:1730000300,via_invite:true}),row('m-denied','denied'),row('m-banned','banned',{banned_at:1730000400})],counts:{pending:1,approved:1,denied:1,banned:1},truncated:false});
const usage=(uid:string,exists=true)=>({uid,generated_at:1730000500,cached:false,
 sign_in:{first_seen:1730000000,last_login:1730000200,last_seen:1730000300,login_count:5,active_sessions:2},
 workspace:exists?{exists:true,chats:3,projects:1,messages_sent:12,chars_sent:480,replies:11,reply_chars:900,imported_messages:0,library_items:2,tool_calls:{esh:4,web:1},answer_seconds:30,model_prompt_tokens:700,model_completion_tokens:200,tokens_approximate:true,last_activity:1730000250,storage_bytes:2048}
  :{exists:false,chats:0,projects:0,messages_sent:0,chars_sent:0,replies:0,reply_chars:0,imported_messages:0,library_items:0,tool_calls:{},answer_seconds:0,model_prompt_tokens:0,model_completion_tokens:0,tokens_approximate:true,last_activity:null,storage_bytes:0},
 unavailable:['voice','media','swarm','agents','bots','build','sdk','web_search','esh']});
const activeInvite={id:'inv-1',email:'old@example.test',status:'active',created:1730000000,expires:1731209600,used_at:null};
const MEMBERS_ROUTES=['/auth/accounts','/auth/usage','/auth/invites','/auth/invite','/auth/invite/revoke','/auth/decide'];

interface Options {session?:()=>any;request?:(path:string,body?:any)=>any;uploads?:(body:any)=>any;globals?:Record<string,any>}
function membersHarness(options:Options={}){
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={};
 // The side-panel Members button as index.html ships it: owner-only, hidden until workspace.js's owner sweep.
 const navMembers=new Node('button');navMembers.setAttribute('data-workspace-view','members');navMembers.setAttribute('data-owner-only','');navMembers.hidden=true;
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector)!;};
 let identity!:(session:any)=>void;
 const decide=(body:any)=>({user:{...row(body.uid,body.decision==='ban'?'banned':body.decision==='unban'||body.decision==='approve'?'approved':body.decision==='deny'?'denied':'approved')},revoked:body.decision==='kick'||body.decision==='ban'?2:undefined});
 const request=vi.fn(async(path:string,body?:any)=>{
  const custom=options.request?.(path,body);if(custom!==undefined)return await custom;
  if(path==='/state')return {chats:[],projects:[],library:[],preferences:[],personalities:[]};
  if(path==='/auth/accounts')return accounts();
  if(path==='/auth/invites')return {invites:[activeInvite,{id:'inv-2',email:'used@example.test',status:'used',created:1730000000,expires:1731209600,used_at:1730000600}]};
  if(path==='/auth/usage')return usage(body.uid);
  if(path==='/auth/decide')return decide(body);
  if(path==='/auth/invite')return {invite:{id:'inv-new',email:body.email,status:'active',created:1730000700,expires:1731210300,used_at:null},existing:false};
  if(path==='/auth/invite/revoke')return {invite:{...activeInvite,status:'revoked'}};
  return {};
 });
 const fetch=vi.fn(async(url:string,init:any)=>{
  const body=JSON.parse(init.body);const value=options.uploads?await options.uploads(body):{count:2,bytes:3072};
  return {ok:true,status:200,headers:{get:(name:string)=>name.toLowerCase()==='content-type'?'application/json':null},json:async()=>value};
 });
 const session=(options.session??ownerSession)();let transport:any;
 class Transport {session:any=session;generation=0;constructor(opts:any){identity=opts.onIdentityChange;transport=this;}loadSession=async()=>this.session;request=request;chat=async(input:any)=>({id:input.chat_id,messages:[]});text=async()=>'';audio=async()=>new Blob();headers=()=>({'x-prime-request':'1',...(this.session?.csrf?{'x-echo-csrf':this.session.csrf}:{})});clear(){this.session=null;identity(null);}auth=async()=>({google_login_enabled:false});canLogout=true;}
 const window:any={EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()},addEventListener:(name:string,callback:(event:any)=>unknown)=>(events[name]??=[]).push(callback),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);}};
 const document:any={hidden:false,head:new Node('head'),documentElement:new Node('html'),querySelector:(selector:string)=>selector.startsWith('script[')?null:get(selector),querySelectorAll:(selector:string)=>['[data-owner-only]','[data-workspace-view]'].includes(selector)?[navMembers]:[],createElement:(tag:string)=>new Node(tag),createTextNode:(value:string)=>Object.assign(new Node('#text'),{textContent:value}),createElementNS:(_ns:string,tag:string)=>new Node(tag),addEventListener(){}};
 const context={window,document,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},matchMedia:()=>({matches:false,addEventListener(){}}),navigator:{userAgent:'fixture'},location:{protocol:'https:',origin:'https://echoomegaprime.com',hash:'',pathname:'/',search:''},crypto:{randomUUID},setTimeout,clearTimeout,AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,console:{debug:vi.fn()},fetch,...options.globals};
 runInNewContext(source('workspace.js'),context);
 const ws=window.EchoPrimeWorkspace,content=get('#workspace-panel-content'),status=get('#workspace-panel-status');
 const all=()=>descendants(content);
 const find=(label:string)=>all().find(n=>n.tagName==='BUTTON'&&n.children.some(c=>c.textContent===label));
 const picker=()=>all().find(n=>n.tagName==='SELECT'&&n.attributes['aria-label']==='Member')!;
 const search=()=>all().find(n=>n.tagName==='INPUT'&&n.attributes['aria-label']==='Search members')!;
 const choices=()=>picker().children.map(o=>o.attributes.value);
 const calls=(path:string)=>request.mock.calls.filter(c=>c[0]===path);
 const membersCalls=()=>request.mock.calls.filter(c=>MEMBERS_ROUTES.includes(c[0] as string));
 const choose=async(uid:string)=>{picker().value=uid;await picker().fire('change');await flush();};
 return {ws,window,content,status,request,fetch,get,find,picker,search,choices,calls,membersCalls,choose,all,navMembers,text:()=>text(content),
  open:async(view='members')=>{await ws.ready;await ws.open(view);await flush();},
  // The transport's readback now names another account (as workspace-client.js does before calling onIdentityChange).
  change:(next=memberSession)=>{transport.session=next();transport.generation++;identity(transport.session);}};
}

describe('Members view (primary owner)',()=>{
 it('opens with one accounts read and no Workspace state read: counts bar, a member drop-down, search and status chips',async()=>{
  const h=membersHarness();await h.ws.ready;
  expect(h.calls('/state')).toHaveLength(1);// the approved owner's page reads its own state once at startup
  await h.open();
  expect(h.get('#workspace-panel-title').textContent).toBe('Members');
  expect(h.calls('/state')).toHaveLength(1);expect(h.calls('/auth/accounts')).toHaveLength(1);expect(h.calls('/auth/invites')).toHaveLength(1);expect(h.calls('/auth/usage')).toHaveLength(0);expect(h.fetch).not.toHaveBeenCalled();
  const counts=h.all().find(n=>n.className==='members-counts')!;
  expect(text(counts)).toBe('Pending 1 Approved 1 Denied 1 Banned 1');
  expect(h.choices()).toEqual(['','m-pending','m-approved','m-denied','m-banned']);
  expect(text(h.picker())).toContain('approved@example.test · Approved');
  h.search().value='APPR';await h.search().fire('input');
  expect(h.choices()).toEqual(['','m-approved']);
  h.search().value='';await h.search().fire('input');
  await h.find('Banned')!.fire('click');
  expect(h.choices()).toEqual(['','m-banned']);
  expect(h.find('Banned')!.attributes['aria-pressed']).toBe('true');expect(h.find('All')!.attributes['aria-pressed']).toBe('false');
  await h.find('All')!.fire('click');expect(h.choices()).toHaveLength(5);
  expect(h.text()).toContain('Choose a member above');
  expect(h.calls('/auth/accounts')).toHaveLength(1);// filtering is client-side
 });
 it('selecting a member shows the detail card and loads usage and uploads for that member only',async()=>{
  const h=membersHarness();await h.open();await h.choose('m-approved');
  await vi.waitFor(()=>expect(h.text()).toContain('Model tokens (approx.)'));
  expect(h.calls('/auth/usage')).toEqual([['/auth/usage',{uid:'m-approved'},expect.anything()]]);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  const [url,init]=h.fetch.mock.calls[0] as any[];
  expect(url).toBe('/api/prime/members/uploads');expect(init.method).toBe('POST');expect(JSON.parse(init.body)).toEqual({uid:'m-approved'});
  expect(init.headers).toMatchObject({'x-prime-request':'1','x-echo-csrf':'csrf-owner','content-type':'application/json'});expect(init.credentials).toBe('same-origin');
  const body=h.text();
  for(const expected of ['approved@example.test','Approved','Role member','Active sessions 2','Sign-ins 5','Invited Yes','Chats 3','Messages sent 12','Replies 11','Characters sent 480','Projects 1','Library items 2','Top tools esh 4 · web 1','Model tokens (approx.) 900','Storage 2.0 KB','Uploads 2 files · 3.0 KB','Not available for members: voice, media, swarm, agents, bots, build, SDK, web search, ESH'])expect(body,expected).toContain(expected);
  for(const label of ['Kick','Ban'])expect(h.find(label),label).toBeDefined();
  for(const label of ['Approve','Deny','Unban'])expect(h.find(label),label).toBeUndefined();
  expect(JSON.stringify(h.request.mock.calls)).not.toContain('m-pending');// never one request per member
  await h.choose('m-pending');await vi.waitFor(()=>expect(h.calls('/auth/usage')).toHaveLength(2));
  expect(h.calls('/auth/usage')[1][1]).toEqual({uid:'m-pending'});
  for(const label of ['Approve','Deny','Kick','Ban'])expect(h.find(label),label).toBeDefined();expect(h.find('Unban')).toBeUndefined();
  await h.choose('m-banned');expect(h.find('Unban')).toBeDefined();for(const label of ['Approve','Kick','Ban'])expect(h.find(label),label).toBeUndefined();
  expect(h.calls('/auth/accounts')).toHaveLength(1);
 });
 it('renders a member who never opened the Workspace (exists:false) without inventing counts',async()=>{
  const h=membersHarness({request:(path,body)=>path==='/auth/usage'?usage(body.uid,false):undefined,uploads:()=>({count:0,bytes:0})});
  await h.open();await h.choose('m-denied');
  await vi.waitFor(()=>expect(h.text()).toContain('has not opened their private Workspace yet'));
  const body=h.text();
  expect(body).not.toContain('Chats');expect(body).not.toContain('Model tokens');
  expect(body).toContain('Storage 0 B');expect(body).toContain('Uploads 0 files · 0 B');expect(body).toContain('Not available for members: voice');
 });
 it('says why usage or uploads are unavailable instead of hiding the detail card',async()=>{
  const h=membersHarness({request:path=>path==='/auth/usage'?Promise.reject(new Error('Account not found.')):undefined,uploads:()=>({configured:false,count:0,bytes:0})});
  await h.open();await h.choose('m-approved');
  await vi.waitFor(()=>expect(h.text()).toContain('Usage is unavailable: Account not found.'));
  expect(h.text()).toContain('Uploads Not enabled on this host');expect(h.text()).toContain('approved@example.test');expect(h.find('Kick')).toBeDefined();
 });
 it.each([
  ['kick','m-approved','Kick','Signs them out everywhere now. They can sign in again.','Signed out 2 sessions.'],
  ['ban','m-approved','Ban','Signs them out and blocks this account and email from signing in.','Banned approved@example.test. Signed out 2 sessions.'],
  ['unban','m-banned','Unban','Restores access as an approved member.','Unbanned banned@example.test.'],
  ['approve','m-pending','Approve','Approves the account.','Account decision returned: approved.'],
  ['deny','m-pending','Deny','Refuses the application.','Account decision returned: denied.'],
 ])('%s: a confirm card names the email and consequence, nothing is sent before Confirm, the body is exact and the member stays selected',async(decision,uid,label,consequence,result)=>{
  const h=membersHarness();await h.open();await h.choose(uid);await flush();
  const email=uid.slice(2)+'@example.test';
  await h.find(label)!.fire('click');
  expect(h.calls('/auth/decide')).toHaveLength(0);
  expect(h.text()).toContain(email);expect(h.text()).toContain(consequence);
  expect(h.find('Cancel')).toBeDefined();
  await h.find('Confirm')!.fire('click');await flush();
  expect(h.calls('/auth/decide').map(c=>c[1])).toEqual([{uid,decision}]);
  expect(h.calls('/auth/accounts')).toHaveLength(2);// the list reloads
  expect(h.picker().value).toBe(uid);expect(h.text()).toContain(email);
  expect(h.text()).toContain(result);
 });
 it('Cancel returns to the member without sending an action',async()=>{
  const h=membersHarness();await h.open();await h.choose('m-approved');
  await h.find('Ban')!.fire('click');await h.find('Cancel')!.fire('click');await flush();
  expect(h.calls('/auth/decide')).toHaveLength(0);expect(h.picker().value).toBe('m-approved');expect(h.find('Ban')).toBeDefined();
 });
 it('shows a refused action on the confirm card and changes nothing (a 409 is not an identity change)',async()=>{
  const h=membersHarness({request:path=>path==='/auth/decide'?Promise.reject(new Error('This account is already banned.')):undefined});
  await h.open();await h.choose('m-approved');await h.find('Ban')!.fire('click');await h.find('Confirm')!.fire('click');await flush();
  expect(h.status.textContent).toBe('This account is already banned.');expect(h.calls('/auth/accounts')).toHaveLength(1);expect(h.find('Confirm')).toBeDefined();
 });
 it('discards a late usage response after an identity change and renders nothing from it',async()=>{
  const late=deferred(),uploads=deferred();
  const h=membersHarness({request:path=>path==='/auth/usage'?late.promise:undefined,uploads:()=>uploads.promise});
  await h.open();await h.choose('m-approved');
  await vi.waitFor(()=>expect(h.calls('/auth/usage')).toHaveLength(1));
  h.change();
  late.resolve(usage('m-approved'));uploads.resolve({count:9,bytes:9});await flush();
  expect(h.content.children).toHaveLength(0);
  expect(h.text()).not.toContain('Chats');
  expect(h.calls('/auth/usage')).toHaveLength(1);expect(h.calls('/auth/accounts')).toHaveLength(1);
 });
 it('refuses Members after the account changes to a member and forgets the selection for the next owner session',async()=>{
  const h=membersHarness();await h.open();await h.choose('m-approved');
  const before=h.request.mock.calls.length;
  h.change();await h.ws.open('members');await flush();
  expect(h.status.textContent).toBe('Primary owner admission required.');expect(h.request.mock.calls.length).toBe(before);
  h.change(ownerSession);await h.ws.open('members');await flush();
  expect(h.picker().value).toBe('');expect(h.text()).toContain('Choose a member above');expect(h.calls('/auth/usage')).toHaveLength(1);
 });
});

describe('Members is owner-only end to end',()=>{
 it.each([['member',memberSession],['anonymous',anonymousSession]] as const)('%s: opening Members sends no request and the Account view offers no members entry',async(_name,session)=>{
  const h=membersHarness({session});await h.ws.ready;
  const before=h.request.mock.calls.length;// a signed-in member's page reads its own /state at startup, nothing else
  expect(h.request.mock.calls.every(c=>c[0]==='/state')).toBe(true);
  await h.ws.open('members');await flush();
  expect(h.request.mock.calls.length).toBe(before);expect(h.fetch).not.toHaveBeenCalled();
  expect(h.status.textContent).toBe('Primary owner admission required.');expect(h.content.children).toHaveLength(0);
  await h.open('account');
  expect(h.membersCalls()).toEqual([]);expect(h.fetch).not.toHaveBeenCalled();expect(h.find('Manage members')).toBeUndefined();
 });
});

describe('Members side-panel item (the shipped workspace.js owner sweep)',()=>{
 it('is shown only to the primary owner, opens Members, and hides again when the account changes',async()=>{
  const owner=membersHarness();await owner.ws.ready;
  expect(owner.navMembers.hidden).toBe(false);
  await owner.navMembers.fire('click');await flush();
  expect(owner.get('#workspace-panel-title').textContent).toBe('Members');expect(owner.calls('/auth/accounts')).toHaveLength(1);
  owner.change();// the same page now belongs to a member
  expect(owner.navMembers.hidden).toBe(true);expect(owner.content.children).toHaveLength(0);
  for(const session of [memberSession,anonymousSession]){
   const h=membersHarness({session});await h.ws.ready;
   expect(h.navMembers.hidden).toBe(true);
   await h.navMembers.fire('click');await flush();// even a forced click reaches no members route
   expect(h.membersCalls()).toEqual([]);expect(h.fetch).not.toHaveBeenCalled();expect(h.status.textContent).toBe('Primary owner admission required.');
  }
 });
});

describe('shipped Members code and styles',()=>{
 it('renders text only and stacks the view at phone width',()=>{
  expect(source('workspace.js')).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  const css=source('styles.css'),phone=/@media\(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf('.members-counts')))?.[1]??'';
  for(const rule of ['.members-toolbar','.members-actions','.members-copy','.members-invite','.members-facts'])expect(phone,rule).toContain(rule);
  expect(phone).toContain('flex-direction:column');expect(phone).toContain('width:100%');expect(phone).toContain('grid-template-columns:1fr');
  expect(source('nav.css')).toContain('.signin-invited{');
 });
});

describe('Account view',()=>{
 it('keeps the approvals section and adds Manage members, which opens Members',async()=>{
  const h=membersHarness();await h.open('account');
  expect(h.find('Approve account')).toBeDefined();expect(h.find('Deny account')).toBeDefined();
  expect(h.text()).toContain('pending@example.test');expect(h.text()).not.toContain('banned@example.test');// a banned account is managed in Members
  await h.find('Approve account')!.fire('click');expect(h.calls('/auth/decide')).toHaveLength(0);
  await h.find('Confirm this account decision')!.fire('click');expect(h.calls('/auth/decide')[0][1]).toEqual({uid:'m-pending',decision:'approve'});
  await h.open('account');await h.find('Manage members')!.fire('click');await flush();
  expect(h.get('#workspace-panel-title').textContent).toBe('Members');expect(h.picker()).toBeDefined();
 });
});

describe('Invites',()=>{
 it('creates an invite with an exact body and shows the link, a Copy button and the ready-to-copy message',async()=>{
  const writeText=vi.fn(async()=>{});
  const h=membersHarness({globals:{navigator:{userAgent:'fixture',clipboard:{writeText}}}});await h.open();
  expect(h.calls('/auth/invites')).toHaveLength(1);
  expect(h.text()).toContain('old@example.test');expect(h.text()).toContain('used@example.test');
  expect(h.find('Revoke')).toBeDefined();expect(h.all().filter(n=>n.tagName==='BUTTON'&&text(n)==='Revoke')).toHaveLength(1);// active invites only
  const email=h.all().find(n=>n.tagName==='INPUT'&&n.attributes.type==='email')!;email.value=' new@example.test ';
  await h.find('Create invite')!.fire('click');await flush();
  expect(h.calls('/auth/invite').map(c=>c[1])).toEqual([{email:'new@example.test'}]);
  const link=h.all().find(n=>n.tagName==='INPUT'&&n.attributes['aria-label']==='Invite link')!;
  expect(link.value).toBe('https://echoomegaprime.com/#invite');
  const message=h.all().find(n=>n.tagName==='TEXTAREA'&&n.attributes['aria-label']==='Invite message')!;
  expect(message.value).toBe("You're invited to Echo Prime. Create an account at https://echoomegaprime.com/#invite with new@example.test, then confirm the verification email. Google sign-in works only if you already have an Echo account.");
  await h.find('Copy link')!.fire('click');expect(writeText).toHaveBeenLastCalledWith('https://echoomegaprime.com/#invite');
  await h.find('Copy message')!.fire('click');expect(writeText).toHaveBeenLastCalledWith(message.value);
  expect(h.calls('/auth/invites')).toHaveLength(2);// the invite list reloads
  expect(h.text()).toContain('Invite created for new@example.test');
 });
 it('returns the existing active invite for the same email',async()=>{
  const h=membersHarness({request:(path,body)=>path==='/auth/invite'?{invite:{...activeInvite,email:body.email},existing:true}:undefined});await h.open();
  const email=h.all().find(n=>n.tagName==='INPUT'&&n.attributes.type==='email')!;email.value='old@example.test';
  await h.find('Create invite')!.fire('click');await flush();
  expect(h.text()).toContain('An active invite for old@example.test already exists');
  expect(h.all().find(n=>n.attributes['aria-label']==='Invite link')!.value).toBe('https://echoomegaprime.com/#invite');
 });
 it('offers Open member for an email that already has an account, and opens it',async()=>{
  const h=membersHarness({request:path=>path==='/auth/invite'?Promise.reject(new Error('That email already has an account (approved).')):undefined});await h.open();
  const email=h.all().find(n=>n.tagName==='INPUT'&&n.attributes.type==='email')!;email.value='Approved@Example.test';
  await h.find('Create invite')!.fire('click');await flush();
  expect(h.text()).toContain('That email already has an account (approved).');
  await h.find('Open member')!.fire('click');await flush();
  expect(h.picker().value).toBe('m-approved');
  await vi.waitFor(()=>expect(h.calls('/auth/usage').map(c=>c[1])).toEqual([{uid:'m-approved'}]));
 });
 it('refuses an invalid email locally and shows a banned-email refusal without an Open member button',async()=>{
  const h=membersHarness({request:path=>path==='/auth/invite'?Promise.reject(new Error('That email is banned. Unban the account first.')):undefined});await h.open();
  const email=h.all().find(n=>n.tagName==='INPUT'&&n.attributes.type==='email')!;email.value='not-an-email';
  await h.find('Create invite')!.fire('click');
  expect(h.calls('/auth/invite')).toHaveLength(0);expect(h.status.textContent).toBe('Enter a valid email address.');
  email.value='someone@example.test';await h.find('Create invite')!.fire('click');await flush();
  expect(h.status.textContent).toBe('That email is banned. Unban the account first.');expect(h.find('Open member')).toBeUndefined();
 });
 it('revokes an active invite only after a confirm card that names its email',async()=>{
  const h=membersHarness();await h.open();
  await h.find('Revoke')!.fire('click');
  expect(h.calls('/auth/invite/revoke')).toHaveLength(0);expect(h.text()).toContain('old@example.test');expect(h.text()).toContain('stops pre-approving');
  await h.find('Confirm')!.fire('click');await flush();
  expect(h.calls('/auth/invite/revoke').map(c=>c[1])).toEqual([{id:'inv-1'}]);
  expect(h.text()).toContain('Invite for old@example.test revoked.');expect(h.calls('/auth/accounts')).toHaveLength(2);
 });
});

describe('#invite sign-up link',()=>{
 it('opens the sign-up card with the invited note and removes the fragment from the address bar',async()=>{
  const replaceState=vi.fn();
  const h=membersHarness({session:anonymousSession,globals:{location:{protocol:'https:',origin:'https://echoomegaprime.com',hash:'#invite',pathname:'/',search:''},history:{replaceState}}});
  await h.ws.ready;await flush();
  expect(replaceState).toHaveBeenCalledTimes(1);expect(replaceState).toHaveBeenCalledWith(null,'','/');
  expect(h.get('#workspace-dialog').open).toBe(true);
  const signin=h.content.children.find(n=>n.className.includes('signin-card'))!;
  expect(signin.attributes['data-intent']).toBe('signup');
  expect(text(signin)).toContain("You've been invited");expect(text(signin)).toContain('Request access to Echo Prime');
  expect(h.content.children).toHaveLength(1);// the note is inside the card
  expect(h.request).not.toHaveBeenCalled();
 });
 it('only strips the fragment for a signed-in account and leaves the page alone',async()=>{
  const replaceState=vi.fn();
  const h=membersHarness({session:memberSession,globals:{location:{protocol:'https:',origin:'https://echoomegaprime.com',hash:'#invite',pathname:'/',search:'?x'},history:{replaceState}}});
  await h.ws.ready;await flush();
  expect(replaceState).toHaveBeenCalledWith(null,'','/?x');expect(h.get('#workspace-dialog').open).toBe(false);
 });
 it('ignores any other fragment',async()=>{
  const replaceState=vi.fn();
  const h=membersHarness({session:anonymousSession,globals:{location:{protocol:'https:',origin:'https://echoomegaprime.com',hash:'#invite=abc',pathname:'/',search:''},history:{replaceState}}});
  await h.ws.ready;await flush();
  expect(replaceState).not.toHaveBeenCalled();expect(h.get('#workspace-dialog').open).toBe(false);
 });
});
