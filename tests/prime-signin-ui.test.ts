/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// The sign-in card is rendered by the shipped workspace.js. Google Identity Services is a stub here: the test
// drives the <script> load/error events and the GIS callback itself, so every state of the card is exercised
// without a network, a Google client id or a real credential.
let slotWidth=0;// what `clientWidth` reports for every node of the current harness
class Node {
 textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;isConnected=true;
 get clientWidth(){return slotWidth;}
 tagName:string;dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:Node[]){for(const item of items){item.parent=this;item.isConnected=true;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this.append(...items);}
 remove(){if(!this.parent)return;this.parent.children=this.parent.children.filter(c=>c!==this);this.isConnected=false;this.parent=null;}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of [...(this.events[name]||[])])await fn({preventDefault(){},target:this,...event});}
 showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}
 focus(){} before(){}
 querySelector():Node|null{return null;}
}
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
const descendants=(node:Node):Node[]=>node.children.flatMap(child=>[child,...descendants(child)]);
const text=(node:Node):string=>[node.textContent,...node.children.map(text)].join(' ').replace(/\s+/g,' ').trim();
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const anonymous=()=>({workspaceConfigured:true,authenticated:false,ownerAccess:false,csrf:null,user:null});
const owner=()=>({workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'csrf-owner',user:{uid:'owner',role:'owner',status:'approved',name:'Bobby McWilliams',email:'commander@example.test'}});
const member=()=>({workspaceConfigured:true,authenticated:true,ownerAccess:false,csrf:'csrf-member',user:{uid:'member',role:'member',status:'approved',email:'member@example.test'}});
const pending=()=>({workspaceConfigured:true,authenticated:true,ownerAccess:false,csrf:'csrf-pending',user:{uid:'pending',role:'member',status:'pending',name:'New Person'}});

interface World {session:any;config:any;configError?:boolean;loginError?:string;logoutError?:string}
const CONTROLS=['#topbar-signin','#sidebar-signin','#sidebar-signup','#topbar-account','#sidebar-signout'];// hidden in index.html until the session says otherwise
function boot(world:World,options:{theme?:string;slotWidth?:number}={}){
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},timers:({fn:()=>unknown;ms:number}|null)[]=[],head=new Node('head');
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector)!;};
 for(const selector of CONTROLS)get(selector).hidden=true;
 let identity!:(session:any)=>void;
 const request=vi.fn(async(path:string)=>{
  if(path==='/auth/logout'){if(world.logoutError)throw new Error(world.logoutError);world.session=anonymous();return {ok:true};}
  return path==='/state'?{chats:[{id:'c1',title:'PRIVATE SAVED CHAT'}],projects:[],library:[],preferences:[],personalities:[]}:path==='/auth/accounts'?{accounts:[{uid:'member',email:'member@example.test',role:'member',status:'pending'}]}:{};
 });
 const auth=vi.fn(async(operation:string,body?:any)=>{
  if(operation==='config'){if(world.configError)throw new Error('config unavailable');return world.config;}
  if(operation==='login'){if(world.loginError)throw new Error(world.loginError);world.session=owner();return {ok:true,body};}
  return {};
 });
 class Transport{
  session:any=null;canLogout=true;
  constructor(opts:any){identity=opts.onIdentityChange;}
  loadSession=async()=>{const previous=this.session;this.session=world.session;if((previous?.user?.uid??null)!==(world.session.user?.uid??null)||!!previous?.authenticated!==!!world.session.authenticated)identity(world.session);return world.session;};
  request=request;auth=auth;headers=()=>({});clear(){this.session=null;identity(null);}
 }
 const dispatched=vi.fn();
 const window:any={EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()},addEventListener:(name:string,callback:(event:any)=>unknown)=>(events[name]??=[]).push(callback),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);}};
 window.addEventListener('echo-account-changed',dispatched);
 const documentElement=new Node('html');if(options.theme)documentElement.dataset.theme=options.theme;
 const document:any={hidden:false,head,documentElement,querySelector:(selector:string)=>selector.startsWith('script[')?head.children.find(n=>n.tagName==='SCRIPT'&&n.dataset.primeGoogle==='1')??null:get(selector),querySelectorAll:()=>[],createElement:(tag:string)=>new Node(tag),createTextNode:(value:string)=>Object.assign(new Node('#text'),{textContent:value}),createElementNS:(_ns:string,tag:string)=>new Node(tag),addEventListener(){}};
 const context={window,document,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},matchMedia:()=>({matches:false,addEventListener(){}}),navigator:{userAgent:'fixture'},location:{protocol:'http:'},crypto:{randomUUID:()=>'00000000-0000-4000-8000-000000000000'},
  setTimeout:(fn:()=>unknown,ms:number)=>{timers.push({fn,ms});return timers.length;},clearTimeout:(id:number)=>{if(id)timers[id-1]=null;},AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,console:{debug:vi.fn()},fetch:vi.fn()};
 runInNewContext(source('workspace.js'),context);
 const ws=window.EchoPrimeWorkspace,content=get('#workspace-panel-content'),dialog=get('#workspace-dialog');
 const card=()=>content.children.find(n=>n.className.includes('signin-card'))!;
 const google=()=>descendants(content).find(n=>n.className==='signin-google')!;
 const slot=()=>descendants(content).find(n=>n.className==='signin-google-slot')!;
 const find=(label:string)=>descendants(content).find(n=>n.tagName==='BUTTON'&&n.children.some(c=>c.textContent===label));
 const script=()=>head.children.find(n=>n.tagName==='SCRIPT')!;
 const gis=()=>{const api={initialize:vi.fn(),renderButton:vi.fn((container:Node)=>{container.append(Object.assign(new Node('iframe'),{textContent:'GIS iframe'}));})};window.google={accounts:{id:api}};return api;};
 const fireTimer=async(ms:number)=>{for(const timer of timers)if(timer&&timer.ms===ms)await timer.fn();await flush();};
 slotWidth=options.slotWidth??0;
 return {ws,window,content,dialog,request,auth,dispatched,card,google,slot,find,script,gis,timers,fireTimer,head,get,open:async(view='account')=>{await ws.open(view);await flush();}};
}
const enabled=()=>({google_login_enabled:true,google_client_id:'client-id.apps.googleusercontent.com'});

describe('anonymous sign-in card',()=>{
 it('renders one centred card: mark + wordmark, title, what sign-in unlocks, roles, privacy link and the email fallback',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const card=h.card();expect(card).toBeDefined();expect(card.tagName).toBe('ARTICLE');
  const body=text(card);
  for(const expected of ['ECHO PRIME','Sign in to Echo Prime','opens your private Workspace','Members','Primary owner','SDK, Vault, ESH shell','Use email or an existing account instead','New accounts wait for owner approval','No password or token is kept in this browser'])expect(body).toContain(expected);
  const brand=descendants(card).find(n=>n.className==='signin-brand')!;expect(brand.children[0].tagName).toBe('SVG');expect(brand.children[0].children[0].attributes.href).toBe('#i-echo-mark');
  expect(descendants(card).find(n=>n.className==='wordmark-text')!.attributes['data-text']).toBe('ECHO PRIME');
  const link=descendants(card).find(n=>n.tagName==='A')!;expect(link.attributes.href).toBe('/privacy.html');expect(text(link)).toBe('Privacy');
  for(const label of ['Sign in','Create account','Forgot password?'])expect(h.find(label),label).toBeDefined();
  expect(descendants(card).filter(n=>n.attributes.type==='password')).toHaveLength(1);
  expect(h.content.children).toHaveLength(1);// nothing but the card for an anonymous visitor
 });
 it('starts in the loading state, then renders the GIS button into its container with the documented options',async()=>{
  const h=boot({session:anonymous(),config:enabled()},{slotWidth:360});await h.open();
  expect(h.google().attributes['data-state']).toBe('loading');expect(text(h.google())).toContain('Preparing Google sign-in');
  const script=h.script();expect(script.attributes.src??(script as any).src).toBe('https://accounts.google.com/gsi/client');expect(script.dataset.primeGoogle).toBe('1');
  const api=h.gis();await script.fire('load');await flush();
  expect(api.initialize).toHaveBeenCalledTimes(1);expect(api.initialize.mock.calls[0][0]).toMatchObject({client_id:'client-id.apps.googleusercontent.com',auto_select:false});expect(typeof api.initialize.mock.calls[0][0].callback).toBe('function');
  expect(api.renderButton).toHaveBeenCalledTimes(1);expect(api.renderButton.mock.calls[0][0]).toBe(h.slot());
  expect(api.renderButton.mock.calls[0][1]).toEqual({type:'standard',theme:'filled_black',size:'large',shape:'pill',text:'continue_with',logo_alignment:'left',width:360});
  expect(h.google().attributes['data-state']).toBe('ready');expect(text(h.google())).toContain('allow pop-ups');
  expect(h.slot().children[0].tagName).toBe('IFRAME');// GIS owns the button; Prime never fakes it
  expect(h.find('Retry Google sign-in')!.hidden).toBe(true);
 });
 it('clamps the GIS width to 200–400 px and falls back to 320 when the container has no layout yet',async()=>{
  for(const [measured,width] of [[0,320],[120,200],[900,400]] as const){
   const h=boot({session:anonymous(),config:enabled()},{slotWidth:measured});await h.open();const api=h.gis();await h.script().fire('load');await flush();
   expect(api.renderButton.mock.calls[0][1].width).toBe(width);
  }
 });
 it('uses the outline theme when the document declares a light theme',async()=>{
  const h=boot({session:anonymous(),config:enabled()},{theme:'light',slotWidth:300});await h.open();const api=h.gis();await h.script().fire('load');await flush();
  expect(api.renderButton.mock.calls[0][1].theme).toBe('outline');
 });
 it('shows the unavailable state without loading any Google script when the Workspace has Google disabled',async()=>{
  const h=boot({session:anonymous(),config:{google_login_enabled:false}});await h.open();
  expect(h.google().attributes['data-state']).toBe('unavailable');expect(text(h.google())).toContain('not enabled on this Workspace');
  expect(h.head.children).toHaveLength(0);expect(descendants(h.content).find(n=>n.tagName==='DETAILS')!.open).toBe(true);
  expect(h.find('Retry Google sign-in')!.hidden).toBe(true);
 });
 it('reports a blocked script explicitly, offers Retry, and retries with a fresh script element',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const first=h.script();await first.fire('error');await flush();
  expect(h.google().attributes['data-state']).toBe('blocked');expect(text(h.google())).toContain('blocked Google’s sign-in script');expect(text(h.google())).toContain('Email sign-in still works');
  expect(h.find('Retry Google sign-in')!.hidden).toBe(false);
  expect(h.window.EchoPrimeWorkspace.session.authenticated).toBe(false);
  await h.find('Retry Google sign-in')!.fire('click');await flush();
  expect(h.google().attributes['data-state']).toBe('loading');
  const second=h.script();expect(second).not.toBe(first);expect(h.head.children.filter(n=>n.tagName==='SCRIPT')).toHaveLength(1);
  const api=h.gis();await second.fire('load');await flush();
  expect(api.renderButton).toHaveBeenCalledTimes(1);expect(h.google().attributes['data-state']).toBe('ready');
 });
 it('treats a script that loaded without the identity library, or a timeout, as blocked',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  await h.script().fire('load');await flush();// no window.google
  expect(h.google().attributes['data-state']).toBe('blocked');expect(text(h.google())).toContain('identity library did not load');
  const slow=boot({session:anonymous(),config:enabled()});await slow.open();
  expect(slow.timers.some(t=>t&&t.ms===8000)).toBe(true);
  await slow.fireTimer(8000);
  expect(slow.google().attributes['data-state']).toBe('blocked');expect(text(slow.google())).toContain('8 seconds');
  const api=slow.gis();await slow.script().fire('load');await flush();// a late load still renders the real button
  expect(api.renderButton).toHaveBeenCalledTimes(1);expect(slow.google().attributes['data-state']).toBe('ready');
 });
 it('shows an error state when the Google configuration cannot be read, keeping the email route open',async()=>{
  const h=boot({session:anonymous(),config:enabled(),configError:true});await h.open();
  expect(h.google().attributes['data-state']).toBe('error');expect(text(h.google())).toContain('configuration is unavailable');
  expect(h.content.children.length).toBe(1);expect(descendants(h.content).find(n=>n.tagName==='DETAILS')!.open).toBe(true);
  expect(h.window.EchoPrimeWorkspace.session.authenticated).toBe(false);
  expect(h.find('Sign in')).toBeDefined();
 });
 it('makes no Workspace request and dispatches no account change while the visitor is anonymous',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const api=h.gis();await h.script().fire('load');await flush();
  await h.open();await h.open();// reopening the account view is still anonymous
  expect(h.request).not.toHaveBeenCalled();
  expect(h.auth.mock.calls.map(c=>c[0])).toEqual(['config','config','config']);
  expect(h.dispatched).not.toHaveBeenCalled();
  // Each open renders GIS into the card of that open only; the current slot is the last container.
  expect(api.renderButton).toHaveBeenCalledTimes(3);expect(api.renderButton.mock.calls.at(-1)![0]).toBe(h.slot());
  expect(h.head.children.filter(n=>n.tagName==='SCRIPT')).toHaveLength(1);
 });
 it('ignores a GIS load that arrives after the account view was replaced',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const script=h.script();await h.ws.open('projects');await flush();
  const api=h.gis();await script.fire('load');await flush();
  expect(api.initialize).not.toHaveBeenCalled();expect(api.renderButton).not.toHaveBeenCalled();
 });
});

describe('Google credential exchange',()=>{
 it('sends the id_token through the existing login route, clears the credential, and renders the signed-in card once',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const api=h.gis();await h.script().fire('load');await flush();
  const result={credential:'eyJ.fixture.token'};
  await api.initialize.mock.calls[0][0].callback(result);await flush();
  expect(h.auth.mock.calls.filter(c=>c[0]==='login').map(c=>c[1])).toEqual([{provider:'google',id_token:'eyJ.fixture.token'}]);
  expect(result.credential).toBe('');
  expect(h.dispatched).toHaveBeenCalledTimes(1);// anonymous -> owner is one real identity change
  const card=h.card();expect(card.className).toContain('signed-in');
  const body=text(card);
  for(const expected of ['Bobby McWilliams','Owner','commander@example.test','Your private Workspace is available.'])expect(body).toContain(expected);
  expect(text(descendants(card).find(n=>n.className==='signin-avatar')!)).toBe('BM');
  expect(h.find('Sign out')).toBeDefined();expect(h.find('Sign in')).toBeUndefined();
  // Owner-only data is fetched only now, after admission.
  expect(h.request.mock.calls.map(c=>c[0])).toContain('/auth/accounts');
  expect(h.find('Approve account')).toBeDefined();
 });
 it('keeps the card and reports the exchange error when the Workspace refuses the token',async()=>{
  const h=boot({session:anonymous(),config:enabled(),loginError:'Google account is not approved for this Workspace.'});await h.open();
  const api=h.gis();await h.script().fire('load');await flush();
  const result={credential:'eyJ.fixture.token'};
  await api.initialize.mock.calls[0][0].callback(result);await flush();
  expect(result.credential).toBe('');
  expect(h.google().attributes['data-state']).toBe('error');expect(text(h.google())).toContain('not approved');
  expect(h.window.EchoPrimeWorkspace.session.authenticated).toBe(false);expect(h.dispatched).not.toHaveBeenCalled();
  expect(h.find('Retry Google sign-in')!.hidden).toBe(false);expect(h.request).not.toHaveBeenCalled();
 });
 it('discards a credential that arrives after the dialog closed or the panel changed',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const api=h.gis();await h.script().fire('load');await flush();
  h.dialog.close();await flush();
  const result={credential:'late-token'};await api.initialize.mock.calls[0][0].callback(result);await flush();
  expect(result.credential).toBe('');expect(h.auth.mock.calls.some(c=>c[0]==='login')).toBe(false);
 });
});

describe('always-visible Sign in / Request access / Sign out controls',()=>{
 const visible=(h:any)=>Object.fromEntries(CONTROLS.map(s=>[s,!h.get(s).hidden]));
 it('anonymous: Sign in (top bar + sidebar) and Request access are shown, the account menu and Sign out are not',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.ws.ready;
  expect(visible(h)).toEqual({'#topbar-signin':true,'#sidebar-signin':true,'#sidebar-signup':true,'#topbar-account':false,'#sidebar-signout':false});
  expect(h.get('.profile > span:nth-child(2)').textContent).toBe('Sign in');
  await h.get('#topbar-signin').fire('click');await flush();
  expect(h.dialog.open).toBe(true);expect(text(h.card())).toContain('Sign in to Echo Prime');expect(h.card().attributes['data-intent']).toBeUndefined();
  h.dialog.close();await h.get('#sidebar-signin').fire('click');await flush();expect(h.dialog.open).toBe(true);expect(h.card()).toBeDefined();
  expect(h.request).not.toHaveBeenCalled();expect(h.dispatched).not.toHaveBeenCalled();
 });
 it('Request access opens the sign-in card on the sign-up path: title, lead, email form open and focused',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.ws.ready;
  await h.get('#sidebar-signup').fire('click');await flush();
  const card=h.card();expect(card.attributes['data-intent']).toBe('signup');
  expect(text(card)).toContain('Request access to Echo Prime');expect(text(card)).toContain('approves each new member');
  expect(descendants(card).find(n=>n.tagName==='DETAILS')!.open).toBe(true);
  expect(h.find('Create account')).toBeDefined();expect(h.find('Sign in')).toBeDefined();// both routes stay available
  await h.open();expect(h.card().attributes['data-intent']).toBeUndefined();// the intent is consumed, not sticky
 });
 it('signed in: the avatar menu and Sign out replace the Sign in buttons, with name, email and role',async()=>{
  const h=boot({session:owner(),config:enabled()});await h.ws.ready;
  expect(visible(h)).toEqual({'#topbar-signin':false,'#sidebar-signin':false,'#sidebar-signup':false,'#topbar-account':true,'#sidebar-signout':true});
  expect(h.get('#topbar-avatar').textContent).toBe('BM');expect(h.get('#topbar-name').textContent).toBe('Bobby McWilliams');
  expect(h.get('#topbar-menu-email').textContent).toBe('commander@example.test');expect(h.get('#topbar-role').textContent).toBe('Owner');
  expect(h.get('#topbar-account').open).toBe(false);
  const m=boot({session:member(),config:enabled()});await m.ws.ready;
  expect(m.get('#topbar-role').textContent).toBe('Member');expect(m.get('#topbar-name').textContent).toBe('member@example.test');expect(m.get('#topbar-menu-email').textContent).toBe('');
  const p=boot({session:pending(),config:enabled()});await p.ws.ready;expect(p.get('#topbar-role').textContent).toBe('Pending');expect(p.get('#sidebar-signout').hidden).toBe(false);
 });
 it('one click on the top-bar Sign out revokes, clears identity state, dispatches echo-account-changed once and shows Sign in again',async()=>{
  const h=boot({session:owner(),config:enabled()});await h.ws.ready;await flush();
  expect(h.get('#history').children.map(text)).toEqual(['PRIVATE SAVED CHAT']);
  h.get('#topbar-account').open=true;
  await h.get('#topbar-signout').fire('click');await flush();
  expect(h.request.mock.calls.filter(c=>c[0]==='/auth/logout')).toHaveLength(1);// no confirmation step
  expect(h.dispatched).toHaveBeenCalledTimes(1);
  expect(h.window.EchoPrimeWorkspace.session).toMatchObject({authenticated:false});
  expect(visible(h)).toEqual({'#topbar-signin':true,'#sidebar-signin':true,'#sidebar-signup':true,'#topbar-account':false,'#sidebar-signout':false});
  expect(h.get('#topbar-account').open).toBe(false);expect(h.get('#history').children).toEqual([]);expect(h.get('.profile > span:nth-child(2)').textContent).toBe('Sign in');
  expect(h.dialog.open).toBe(false);expect(h.content.children).toEqual([]);// the closed dialog stays closed
  expect(h.get('#draft-notice').hidden).toBe(false);expect(h.get('#draft-notice').textContent).toContain('Signed out');
  await h.get('#sidebar-signin').fire('click');await flush();expect(text(h.card())).toContain('Sign in to Echo Prime');
 });
 it('Sign out from the sidebar while the account view is open swaps the card for the sign-in card',async()=>{
  const h=boot({session:owner(),config:enabled()});await h.open();
  expect(h.card().className).toContain('signed-in');
  await h.get('#sidebar-signout').fire('click');await flush();
  expect(h.dialog.open).toBe(true);expect(h.card().className).toBe('signin-card');expect(h.find('Sign in')).toBeDefined();
  expect(h.get('#workspace-panel-status').textContent).toContain('Signed out');expect(h.dispatched).toHaveBeenCalledTimes(1);
 });
 it('an unconfirmed sign-out clears the page without re-admitting, and a second click is ignored while busy',async()=>{
  const h=boot({session:owner(),config:enabled(),logoutError:'network outcome unknown'});await h.ws.ready;await flush();
  const first=h.get('#topbar-signout').fire('click');void h.get('#sidebar-signout').fire('click');await first;await flush();
  expect(h.request.mock.calls.filter(c=>c[0]==='/auth/logout')).toHaveLength(1);
  expect(h.window.EchoPrimeWorkspace.session).toBeNull();expect(h.dispatched).toHaveBeenCalledTimes(1);
  expect(h.get('#draft-notice').textContent).toContain('could not be confirmed');expect(h.get('#history').children).toEqual([]);
  expect(visible(h)['#topbar-signin']).toBe(true);
 });
 it('without a configured Workspace backend none of the controls appear',async()=>{
  const h=boot({session:{workspaceConfigured:false,authenticated:false,ownerAccess:false,csrf:null,user:null},config:enabled()});await h.ws.ready;
  expect(Object.values(visible(h)).every(v=>v===false)).toBe(true);
 });
});

describe('signed-in card',()=>{
 it('shows a member with initials from the email, a Member badge, and requests no owner-only data',async()=>{
  const h=boot({session:member(),config:enabled()});await h.open();
  const card=h.card();expect(card.className).toContain('signed-in');
  expect(text(descendants(card).find(n=>n.className==='signin-avatar')!)).toBe('ME');
  expect(text(descendants(card).find(n=>n.className==='signin-role-badge')!)).toBe('Member');
  expect(text(card)).toContain('member@example.test');expect(text(card)).toContain('Your private Workspace is available.');
  expect(h.request.mock.calls.map(c=>c[0])).not.toContain('/auth/accounts');
  expect(h.auth).not.toHaveBeenCalled();// no Google configuration read for a signed-in account
  expect(h.find('Sign out')).toBeDefined();expect(h.head.children).toHaveLength(0);
 });
 it('explains a pending account honestly',async()=>{
  const h=boot({session:pending(),config:enabled()});await h.open();
  const body=text(h.card());
  expect(body).toContain('Account status: pending');expect(body).toContain('approves new accounts');expect(text(descendants(h.card()).find(n=>n.className==='signin-role-badge')!)).toBe('Pending');
  expect(text(descendants(h.card()).find(n=>n.className==='signin-avatar')!)).toBe('NP');
 });
});

// Live test 2026-11-06: a friend of the owner could not create an account on a phone. The panel status line sits above
// the fold, so every result was invisible. Each action now answers next to its own button (role=status, aria-live) and
// scrolls that answer into view; the sign-up intent renders Google's own "Sign up with Google" text (GIS `signup_with`).
describe('sign-up intent and inline action results',()=>{
 const field=(h:ReturnType<typeof boot>,name:string)=>descendants(h.content).find(n=>n.tagName==='INPUT'&&n.dataset.signinField===name)!;
 const labels=(h:ReturnType<typeof boot>)=>descendants(h.content).filter(n=>n.className==='workspace-field').map(n=>text(n.children[0]));
 const resultOf=(h:ReturnType<typeof boot>,label:string)=>{const button=h.find(label)!,siblings=button.parent!.children,index=siblings.indexOf(button);return siblings[index+1];};
 const withScroll=()=>{const scrolled:Node[]=[];(Node.prototype as any).scrollIntoView=function(this:Node,options:any){scrolled.push(this);(this as any).scrolledWith=options;};return {scrolled,restore:()=>{delete (Node.prototype as any).scrollIntoView;}};};
 it('renders the official GIS sign-up text on the sign-up intent and keeps continue_with for sign-in',async()=>{
  const h=boot({session:anonymous(),config:enabled()},{slotWidth:320});
  await h.get('#sidebar-signup').fire('click');await flush();
  const api=h.gis();await h.script().fire('load');await flush();
  expect(api.renderButton.mock.calls[0][1]).toEqual({type:'standard',theme:'filled_black',size:'large',shape:'pill',text:'signup_with',logo_alignment:'left',width:320});
  const signin=boot({session:anonymous(),config:enabled()},{slotWidth:320});await signin.open();
  const other=signin.gis();await signin.script().fire('load');await flush();
  expect(other.renderButton.mock.calls[0][1].text).toBe('continue_with');
 });
 it('labels the address field Email on the sign-up intent and keeps Email / user ID for sign-in',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.get('#sidebar-signup').fire('click');await flush();
  expect(labels(h)).toContain('Email');expect(labels(h)).not.toContain('Email / user ID');
  expect(field(h,'email').attributes.type).toBe('email');
  const signin=boot({session:anonymous(),config:enabled()});await signin.open();
  expect(labels(signin)).toContain('Email / user ID');
 });
 it('refuses an address without @ before sending and says so next to Create account',async()=>{
  const view=withScroll();
  try{
   const h=boot({session:anonymous(),config:enabled()});await h.get('#sidebar-signup').fire('click');await flush();
   field(h,'email').value='friend.example.com';field(h,'password').value='a long password';
   await h.find('Create account')!.fire('click');await flush();
   expect(h.auth.mock.calls.map(c=>c[0])).not.toContain('signup');
   const result=resultOf(h,'Create account');
   expect(result.attributes.role).toBe('status');expect(result.attributes['aria-live']).toBe('polite');
   expect(result.textContent).toMatch(/email address/i);expect(result.dataset.state).toBe('error');
   expect(view.scrolled).toContain(result);expect(field(h,'password').value).toBe('a long password');// nothing was sent, so nothing to retype
  }finally{view.restore();}
 });
 it('shows the server sign-up message verbatim next to Create account and scrolls it into view',async()=>{
  const view=withScroll();
  try{
   const h=boot({session:anonymous(),config:enabled()});await h.get('#sidebar-signup').fire('click');await flush();
   h.auth.mockImplementation(async(operation:string)=>operation==='config'?enabled():operation==='signup'?{message:'Account created. Verify friend@example.test, then wait for the owner to approve it.'}:{});
   field(h,'email').value=' friend@example.test ';field(h,'password').value='a long password';field(h,'name').value='Friend';
   await h.find('Create account')!.fire('click');await flush();
   expect(h.auth.mock.calls.find(c=>c[0]==='signup')![1]).toMatchObject({email:'friend@example.test',display_name:'Friend'});// the password is cleared from the sent body afterwards
   const result=resultOf(h,'Create account');
   expect(result.textContent).toBe('Account created. Verify friend@example.test, then wait for the owner to approve it.');expect(result.dataset.state).toBe('ok');
   expect(view.scrolled).toContain(result);expect(field(h,'password').value).toBe('');
  }finally{view.restore();}
 });
 it('shows a server sign-up refusal verbatim inline, not only in the status line above the fold',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.get('#sidebar-signup').fire('click');await flush();
  h.auth.mockImplementation(async(operation:string)=>{if(operation==='signup')throw new Error('An account already exists for this email. Sign in, or use Forgot password.');return enabled();});
  field(h,'email').value='friend@example.test';field(h,'password').value='a long password';
  await h.find('Create account')!.fire('click');await flush();
  const result=resultOf(h,'Create account');
  expect(result.textContent).toBe('An account already exists for this email. Sign in, or use Forgot password.');expect(result.dataset.state).toBe('error');
 });
 it('answers Sign in and Forgot password next to their own buttons',async()=>{
  const h=boot({session:anonymous(),config:enabled(),loginError:'Email or password is incorrect.'});await h.open();
  field(h,'email').value='friend@example.test';field(h,'password').value='wrong';
  await h.find('Sign in')!.fire('click');await flush();
  expect(resultOf(h,'Sign in').textContent).toBe('Email or password is incorrect.');
  await h.find('Forgot password?')!.fire('click');await flush();
  expect(resultOf(h,'Forgot password?').textContent).toMatch(/Recovery request returned|reset/i);
  field(h,'email').value='no-at-sign';await h.find('Forgot password?')!.fire('click');await flush();
  expect(resultOf(h,'Forgot password?').textContent).toBe('Enter your email address first.');
 });
});

// Review 2026-11-06: "Sign up with Google" calls the same Google login route (Google's credential is the same for sign-in
// and sign-up; echo-auth decides). Until echo-auth creates accounts from Google sign-in, the Workspace answers a Google
// address with no account with a bare "Sign-in failed." (401). On the sign-up intent that refusal now says, next to the
// button, what to do next; any other answer is shown verbatim and alone.
describe('Google sign-up refusal on the sign-up intent',()=>{
 const withScroll=()=>{const scrolled:Node[]=[];(Node.prototype as any).scrollIntoView=function(this:Node){scrolled.push(this);};return {scrolled,restore:()=>{delete (Node.prototype as any).scrollIntoView;}};};
 const googleStatus=(h:ReturnType<typeof boot>)=>descendants(h.google()).find(n=>n.className==='signin-google-status')!;
 const details=(h:ReturnType<typeof boot>)=>descendants(h.content).find(n=>n.tagName==='DETAILS')!;
 async function signupCallback(error:Error){
  const h=boot({session:anonymous(),config:enabled()});await h.get('#sidebar-signup').fire('click');await flush();
  const api=h.gis();await h.script().fire('load');await flush();
  h.auth.mockImplementation(async(operation:string)=>{if(operation==='login')throw error;return enabled();});
  details(h).open=false;
  const result={credential:'eyJ.fixture.token'};
  await api.initialize.mock.calls[0][0].callback(result);await flush();
  return {h,result};
 }
 it('keeps the Workspace message verbatim and says how to get an account, next to the button and in view',async()=>{
  const view=withScroll();
  try{
   const {h,result}=await signupCallback(Object.assign(new Error('Sign-in failed.'),{status:401}));
   expect(h.auth.mock.calls.filter(c=>c[0]==='login').map(c=>c[1])).toEqual([{provider:'google',id_token:'eyJ.fixture.token'}]);
   expect(h.auth.mock.calls.some(c=>c[0]==='signup')).toBe(false);// sign-up with Google is the Google login route, never the password sign-up
   expect(result.credential).toBe('');
   const status=googleStatus(h);
   expect(status.textContent.startsWith('Sign-in failed. ')).toBe(true);
   expect(status.textContent).toMatch(/no Echo account uses this Google address yet/i);
   expect(status.textContent).toMatch(/create an account below with the same email address/i);
   expect(h.google().attributes['data-state']).toBe('error');expect(details(h).open).toBe(true);
   expect(view.scrolled).toContain(status);
  }finally{view.restore();}
 });
 it('shows any other answer verbatim and alone',async()=>{
  const view=withScroll();
  try{
   const {h}=await signupCallback(Object.assign(new Error('Identity service is unavailable.'),{status:503}));
   expect(googleStatus(h).textContent).toBe('Identity service is unavailable.');
   expect(view.scrolled).toContain(googleStatus(h));
   const precise=await signupCallback(Object.assign(new Error('Google cannot confirm this address is still yours.'),{status:403}));
   expect(googleStatus(precise.h).textContent).toBe('Google cannot confirm this address is still yours.');
  }finally{view.restore();}
 });
 it('adds no sign-up guidance to a refused Google sign-in',async()=>{
  const h=boot({session:anonymous(),config:enabled()});await h.open();
  const api=h.gis();await h.script().fire('load');await flush();
  h.auth.mockImplementation(async(operation:string)=>{if(operation==='login')throw Object.assign(new Error('Sign-in failed.'),{status:401});return enabled();});
  await api.initialize.mock.calls[0][0].callback({credential:'eyJ.fixture.token'});await flush();
  expect(googleStatus(h).textContent).toBe('Sign-in failed.');
 });
});
