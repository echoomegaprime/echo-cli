/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM and bridge stand-ins mirror prime-composer-ui.test.ts */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';

// The shipped views.js runs unchanged against a small DOM stand-in and a synthetic
// Workspace bridge. Nothing here reaches a backend: this proves rendering, admission
// gating, exact request payloads, the SDK confirm step and Vault masking.
const camel=(key:string)=>key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
class Node {
 tagName:string;_text='';className='';hidden=false;disabled=false;checked=false;open=false;value='';isConnected=true;focused=false;
 dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};files:any[]=[];
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 get textContent():string{return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(value:string){this._text=String(value);this.children=[];}
 append(...items:Node[]){for(const item of items){item.parent=this;item.isConnected=true;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this._text='';this.append(...items);}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key==='value')this.value=value;if(key.startsWith('data-'))this.dataset[camel(key.slice(5))]=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},stopPropagation(){},target:this,...event});}
 dispatchEvent(event:any){void this.fire(event.type,event);return true;}
 showModal(){this.open=true;} close(){if(!this.open)return;this.open=false;void this.fire('close');} focus(){this.focused=true;} click(){return this.fire('click');}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
}
const walk=(root:Node):Node[]=>root.children.flatMap(c=>[c,...walk(c)]);
const source=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
function deferred<T=any>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const VIEW_NAMES=['projects','library','sdk','vault','review'];

const catalogResults=()=>({matches:3,results:[
 {id:'echo.fs.read',description:'Read a file',scope:'fs.read',tier:0},
 {id:'echo.node.exec',description:'Run a command',required_scope:'node.exec',danger_tier:3},
 {id:'echo.odd.cap',description:'No tier reported'},
]});
function fakeBridge(over:Record<string,any>={}){
 const state:any={
  data:{
   chats:[{id:'c1',title:'Alpha plan',project_id:'p1'},{id:'c2',title:'Alpha notes',project_id:'p1'},{id:'c3',title:'Loose chat',project_id:null}],
   projects:[{id:'p1',name:'Alpha',instructions:'Be brief.'},{id:'p2',name:'Beta'}],
   library:[{id:'f1',name:'notes.md',path:'a/notes.md',chat_id:'c1'},{id:'f2',name:'app.py',path:'src/app.py'}],
   catalog:{count:1908,coverage:'Snapshot verified 2026-11-04.'},mission_present:true,context_length:262144,
  },
  chat:{id:'c1',title:'Alpha plan',project_id:'p1',messages:[],events:[]},attachments:new Set<string>(),accountEpoch:0,epoch:0,...over.state};
 const bridge:any={state,session:{authenticated:true,ownerAccess:true,user:{uid:'owner',status:'approved'}},
  api:vi.fn(async(path:string)=>path.startsWith('/catalog')?catalogResults():path.startsWith('/library/')?{id:path.slice(9),name:'app.py',content:'print(1)',path:'src/app.py',project_id:'p1'}:path==='/review'?{id:'reviewed',messages:[]}:path==='/import'?{id:'imported'}:{}),
  refresh:vi.fn(async()=>{}),openChat:vi.fn(async()=>{}),updateContext:vi.fn(),
  normalizeImport:vi.fn((raw:string,title:string)=>({source:'authorized-import',title:title||'Imported conversation',messages:[{role:'user',content:raw}]})),...over.bridge};
 return bridge;
}
const member=(bridge:any)=>{bridge.session={authenticated:true,ownerAccess:false,user:{uid:'member',status:'approved'}};return bridge;};
const anonymous=(bridge:any)=>{bridge.session={authenticated:false,ownerAccess:false,user:null};bridge.state.data=null;return bridge;};

interface World {window:any;body:Node;get:(s:string)=>Node;nav:Record<string,Node>;logs:string[];emit:(t:string)=>void;all:()=>Node[];button:(label:string)=>Node|undefined;buttons:(label:string)=>Node[];field:(key:string)=>Node|undefined;dialog:()=>Node;status:()=>string;open:(view:string)=>Promise<Node>}
async function world(bridge:any,options:{enabled?:boolean;window?:Record<string,any>}={}):Promise<World>{
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},logs:string[]=[];
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node(selector==='#workspace-project'?'select':selector==='#prompt'?'textarea':'div'));return nodes.get(selector)!;};
 const body=new Node('body'),nav:Record<string,Node>={};
 for(const view of VIEW_NAMES){const node=new Node('button');node.setAttribute('data-prime-view',view);nav[view]=node;}
 const window:any={addEventListener:(name:string,fn:(e:any)=>unknown)=>(events[name]??=[]).push(fn),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);},
  EchoPrimeWorkspace:{ready:Promise.resolve(options.enabled??true),get enabled(){return options.enabled??true;},bridge,newChat:vi.fn(async()=>true)},
  EchoPrimePlugins:{open:vi.fn(async()=>{})},EchoPrimeLogs:{open:vi.fn()},EchoPrimeStudio:{open:vi.fn()},...options.window};
 const document:any={body,head:new Node('head'),hidden:false,querySelector:get,querySelectorAll:(selector:string)=>selector==='[data-prime-view]'?Object.values(nav):[],createElement:(tag:string)=>new Node(tag),createTextNode:(text:string)=>Object.assign(new Node('#text'),{_text:text}),addEventListener(){}};
 const record=(...args:any[])=>{logs.push(args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' '));};
 const context={window,document,Event,Blob,URL:{createObjectURL:()=>'blob:fixture',revokeObjectURL(){}},setTimeout,clearTimeout,console:{debug:record,log:record,warn:record,error:record,info:record},crypto:{randomUUID}};
 runInNewContext(source('views.js'),context);
 await tick();
 const all=()=>[body,...nodes.values(),...Object.values(nav)].flatMap(n=>[n,...walk(n)]);
 const buttons=(label:string)=>all().filter(n=>n.tagName==='BUTTON'&&n.textContent.trim()===label);
 const dialog=()=>body.children.find(n=>n.tagName==='DIALOG')!;
 const status=()=>dialog()?walk(dialog()).find(n=>n.className==='views-status')?.textContent??'':'';
 const open=async(view:string)=>{await window.EchoPrimeViews.open(view);await tick();return dialog();};
 return {window,body,get,nav,logs,emit:(type:string)=>window.dispatchEvent(new Event(type)),all,button:(label:string)=>buttons(label)[0],buttons,field:(key:string)=>all().find(n=>n.attributes['data-field']===key),dialog,status,open};
}
const calls=(bridge:any,path?:string)=>bridge.api.mock.calls.filter((c:any[])=>path===undefined||c[0]===path);
const file=(name:string,text:string,size=text.length)=>({name,size,text:async()=>text});

describe('pure helpers',()=>{
 const core=(async()=>(await world(fakeBridge())).window.EchoPrimeViews.core)();
 it('filters the library by name and path without touching the backend',async()=>{
  const {filterLibrary}=await core,items=[{id:'1',name:'Notes.md',path:'a/notes.md'},{id:'2',name:'app.py',path:'src/app.py'},null,'x'];
  expect(filterLibrary(items,'').map((i:any)=>i.id)).toEqual(['1','2']);
  expect(filterLibrary(items,'SRC').map((i:any)=>i.id)).toEqual(['2']);
  expect(filterLibrary(items,'notes').map((i:any)=>i.id)).toEqual(['1']);
  expect(filterLibrary('nope','x')).toEqual([]);
 });
 it('lists a project’s chats client-side, the way the Workspace does, ignoring malformed rows',async()=>{
  const {projectChats}=await core,chats=[{id:'a',project_id:'p1'},{id:'b',project_id:'p2'},{project_id:'p1'},null,{id:'c',project_id:'p1'}];
  expect(projectChats(chats,'p1').map((c:any)=>c.id)).toEqual(['a','c']);
  expect(projectChats(undefined,'p1')).toEqual([]);
 });
 it('reads a tier from tier or danger_tier and treats anything else as unknown',async()=>{
  const {tierOf,needsConfirm}=await core;
  expect(tierOf({tier:0})).toBe(0);expect(tierOf({tier:'2'})).toBe(2);expect(tierOf({danger_tier:3})).toBe(3);expect(tierOf({tier:1,danger_tier:3})).toBe(1);
  for(const value of [{},{tier:''},{tier:'high'},{tier:-1},{tier:1.5},null,'x'])expect(tierOf(value)).toBeNull();
  expect(needsConfirm(0)).toBe(false);expect(needsConfirm(1)).toBe(false);expect(needsConfirm(2)).toBe(true);expect(needsConfirm(7)).toBe(true);expect(needsConfirm(null)).toBe(true);
 });
 it('refuses vault capabilities and secret-looking option keys client-side, and masks secret values deeply',async()=>{
  const {refuseSdkOptions,maskSecrets}=await core;
  expect(refuseSdkOptions('echo.vault.get',{service:'x'})).toMatch(/Vault form/);
  expect(refuseSdkOptions('echo.fs.read',{path:'a',nested:{api_key:'k'}})).toMatch(/Vault form/);
  expect(refuseSdkOptions('echo.fs.read',{items:[{token:'t'}]})).toMatch(/Vault form/);
  expect(refuseSdkOptions('echo.fs.read',{path:'a',limit:3})).toBeNull();
  const masked=maskSecrets({ok:true,secret:'s3cr3t',nested:{password:'pw',name:'n'},list:[{api_key:'k'}],token:{inner:'v'}});
  expect(JSON.stringify(masked)).not.toMatch(/s3cr3t|pw|"k"/);
  expect(masked.nested.name).toBe('n');expect(masked.ok).toBe(true);expect(masked.secret).toBe('••••••••');
 });
});

describe('admission gating',()=>{
 it('renders a sign-in notice for an anonymous visitor and never fetches, for every view',async()=>{
  const bridge=anonymous(fakeBridge()),w=await world(bridge);
  for(const view of VIEW_NAMES){const dialog=await w.open(view);expect(dialog.open).toBe(true);expect(dialog.textContent).toContain('Sign in to an approved Workspace account');}
  expect(bridge.api).not.toHaveBeenCalled();expect(bridge.refresh).not.toHaveBeenCalled();
 });
 it('keeps SDK and Vault owner-only for a member without fetching, while Projects, Library and Code review render',async()=>{
  const bridge=member(fakeBridge()),w=await world(bridge);
  for(const view of ['sdk','vault']){const dialog=await w.open(view);expect(dialog.textContent).toContain('Primary owner admission is required');}
  expect(bridge.api).not.toHaveBeenCalled();expect(bridge.refresh).not.toHaveBeenCalled();
  for(const view of ['projects','library','review']){const dialog=await w.open(view);expect(dialog.textContent).not.toContain('admission is required');}
  expect(bridge.refresh).toHaveBeenCalledTimes(3);
 });
 it('refreshes Workspace state once per open and does not bind navigation when no Workspace is configured',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('projects');
  expect(bridge.refresh).toHaveBeenCalledTimes(1);
  await w.nav.library.click();await tick();expect(w.dialog().textContent).toContain('Keep what matters.');
  const off=await world(fakeBridge(),{enabled:false});await off.nav.projects.click();await tick();
  expect(off.dialog()).toBeUndefined();
 });
 it('closes the view, clears typed values and discards late output when the account changes',async()=>{
  const slow=deferred(),bridge=fakeBridge();bridge.api=vi.fn(async(path:string)=>path.startsWith('/library/')?slow.promise:{});
  const w=await world(bridge),dialog=await w.open('library');
  const name=w.field('note-name')!;name.value='private-draft.md';
  const pending=w.button('Open')!.click();
  w.emit('echo-account-changed');
  expect(dialog.open).toBe(false);expect(name.value).toBe('');expect(dialog.children.filter(n=>n.className==='views-body').every(n=>n.children.length===0)).toBe(true);
  slow.resolve({name:'late.md',content:'LATE PRIVATE CONTENT'});await pending;await tick();
  expect(dialog.textContent).not.toContain('LATE PRIVATE CONTENT');
 });
});

describe('Projects',()=>{
 it('shows each project with its chat count and per-project chat list from the saved state, with no chat request',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('projects');
  const text=dialog.textContent;
  expect(text).toContain('Alpha');expect(text).toContain('Be brief.');expect(text).toContain('2 chats');expect(text).toContain('Alpha plan');expect(text).toContain('Alpha notes');
  expect(text).toContain('Beta');expect(text).toContain('No project instructions yet.');expect(text).toContain('0 chats');expect(text).not.toContain('Loose chat');
  expect(calls(bridge).map((c:any[])=>c[0])).toEqual([]);
 });
 it('creates a project with the exact payload, then refreshes and repaints',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('projects');
  bridge.refresh=vi.fn(async()=>{bridge.state.data.projects.push({id:'p3',name:'Gamma',instructions:'Go.'});});
  await w.button('Create project')!.click();
  expect(calls(bridge,'/projects')).toHaveLength(0);expect(w.status()).toContain('Enter a project name');
  w.field('project-name')!.value='Gamma';w.field('project-instructions')!.value='Go.';await w.button('Create project')!.click();await tick();
  expect(calls(bridge,'/projects')[0][1]).toEqual({name:'Gamma',instructions:'Go.'});
  expect(bridge.refresh).toHaveBeenCalledTimes(1);expect(w.dialog().textContent).toContain('Gamma');
 });
 it('saves a renamed project through /project/update',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('projects');
  w.field('project-rename-p1')!.value='Alpha 2';w.field('project-guide-p1')!.value='Be brief and kind.';await w.buttons('Save project')[0].click();
  expect(calls(bridge,'/project/update')[0][1]).toEqual({id:'p1',name:'Alpha 2',instructions:'Be brief and kind.'});
 });
 it('starts a chat in the project through the existing conversation surface',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('projects');
  await w.buttons('Start a chat')[1].click();
  expect(w.get('#workspace-project').value).toBe('p2');expect(dialog.open).toBe(false);expect(w.window.EchoPrimeWorkspace.newChat).toHaveBeenCalledTimes(1);
 });
 it('opens a listed chat in the chat surface and selects a project for the current conversation',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('projects');
  const changed=vi.fn();w.get('#workspace-project').addEventListener('change',changed);
  await w.button('Alpha notes')!.click();
  expect(bridge.openChat).toHaveBeenCalledWith('c2');expect(dialog.open).toBe(false);
  await w.open('projects');await w.buttons('Select project')[0].click();
  expect(w.get('#workspace-project').value).toBe('p1');expect(changed).toHaveBeenCalledTimes(1);expect(w.status()).toContain('Alpha');
 });
});

describe('Library',()=>{
 it('filters files as you type and shows an honest empty state',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('library');
  const search=w.field('library-search')!;
  expect(dialog.textContent).toContain('notes.md');expect(dialog.textContent).toContain('app.py');
  search.value='src';await search.fire('input');
  expect(dialog.textContent).not.toContain('notes.md');expect(dialog.textContent).toContain('app.py');
  search.value='zzz';await search.fire('input');expect(dialog.textContent).toContain('No files match this search.');
  expect(calls(bridge)).toHaveLength(0);
 });
 it('writes a note to the library with the conversation and project, refusing credential names and empty content first',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('library');
  w.field('note-name')!.value='.env';w.field('note-content')!.value='KEY=1';await w.button('Save file')!.click();
  expect(w.status()).toContain('Credentials belong in the Vault');
  w.field('note-name')!.value='plan.md';w.field('note-content')!.value='   ';await w.button('Save file')!.click();
  expect(calls(bridge,'/library')).toHaveLength(0);
  w.field('note-content')!.value='# Plan';await w.button('Save file')!.click();
  expect(calls(bridge,'/library')[0][1]).toEqual({name:'plan.md',content:'# Plan',chat_id:'c1',project_id:'p1'});expect(bridge.refresh).toHaveBeenCalled();
 });
 it('uploads a text file under 100 KB and refuses larger or credential files without a request',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('library');
  const upload=w.field('library-upload')!;
  upload.files=[file('big.txt','x',100001)];await upload.fire('change');expect(w.status()).toContain('under 100 KB');
  upload.files=[file('id_rsa','key')];await upload.fire('change');expect(w.status()).toContain('Credential files belong in the Vault');
  expect(calls(bridge,'/library')).toHaveLength(0);
  upload.files=[file('readme.md','# hi')];await upload.fire('change');
  expect(calls(bridge,'/library')[0][1]).toMatchObject({name:'readme.md',content:'# hi',chat_id:'c1'});expect(upload.value).toBe('');
 });
 it('imports a chat from a file of up to 1.9 MB through the shared normalizer and opens the saved conversation',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('library');
  const picker=w.field('import-file')!;
  picker.files=[file('huge.json','{}',1900001)];await picker.fire('change');expect(w.status()).toContain('under 1.9 MB');expect(w.field('import-data')!.value).toBe('');
  picker.files=[file('export.json','hello from elsewhere')];await picker.fire('change');
  expect(w.field('import-data')!.value).toBe('hello from elsewhere');expect(w.field('import-title')!.value).toBe('export.json');
  w.field('import-source')!.value='claude';await w.button('Import chat')!.click();
  expect(bridge.normalizeImport).toHaveBeenCalledWith('hello from elsewhere','export.json');
  expect(calls(bridge,'/import')[0][1]).toEqual({source:'claude',title:'export.json',messages:[{role:'user',content:'hello from elsewhere'}]});
  expect(bridge.openChat).toHaveBeenCalledWith('imported');expect(dialog.open).toBe(false);
 });
 it('opens a file read from the Workspace and attaches a file to the next message',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('library');
  await w.buttons('Open')[1].click();
  expect(calls(bridge,'/library/f2')).toHaveLength(1);expect(dialog.textContent).toContain('print(1)');expect(w.button('Download')).toBeDefined();
  await w.buttons('Attach')[0].click();
  expect([...bridge.state.attachments]).toEqual(['f1']);expect(bridge.updateContext).toHaveBeenCalled();expect(dialog.open).toBe(false);expect(w.get('#prompt').focused).toBe(true);
 });
 it('hands a library file to the Code review page prefilled, and opens a linked conversation',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('library');
  await w.buttons('Review')[1].click();await tick();
  expect(w.dialog().textContent).toContain('A second look at your code.');
  expect(w.field('review-name')!.value).toBe('app.py');expect(w.field('review-source')!.value).toBe('print(1)');expect(w.field('review-project')!.value).toBe('p1');
  await w.open('library');expect(w.buttons('Open linked conversation')).toHaveLength(1);
  await w.button('Open linked conversation')!.click();expect(bridge.openChat).toHaveBeenCalledWith('c1');
 });
});

describe('SDK',()=>{
 const sdkWorld=async(bridge=fakeBridge())=>{const w=await world(bridge);const dialog=await w.open('sdk');return {w,dialog,bridge};};
 it('searches the catalog with an encoded query and shows each capability with its scope and tier',async()=>{
  const {w,dialog,bridge}=await sdkWorld();
  expect(dialog.textContent).toContain('Catalog snapshot: 1,908 capabilities.');expect(dialog.textContent).toContain('A mission is present.');
  w.field('sdk-query')!.value='node exec & more';await w.button('Search')!.click();
  expect(calls(bridge)[0][0]).toBe('/catalog?q=node%20exec%20%26%20more');
  const text=dialog.textContent;
  expect(text).toContain('3 matches · showing up to 100');expect(text).toContain('echo.fs.read');expect(text).toContain('Scope: fs.read · tier 0');expect(text).toContain('Scope: node.exec · tier 3');expect(text).toContain('Scope: check live schema · tier ?');
 });
 it('fills the capability and command from a result and shows the tier line',async()=>{
  const {w,dialog}=await sdkWorld();await w.button('Search')!.click();
  const result=walk(dialog).find(n=>n.className==='sdk-result'&&n.textContent.includes('echo.node.exec'))!;await result.click();
  expect(w.field('sdk-capability')!.value).toBe('echo.node.exec');expect(w.field('sdk-command')!.value).toBe('exec');
  expect(walk(dialog).find(n=>n.className.includes('sdk-tier'))!.textContent).toBe('Tier 3 · confirmation required before invoking');
 });
 it('reads the live schema with sdk_detail and adopts a tier the detail reports',async()=>{
  const bridge=fakeBridge();bridge.api=vi.fn(async(path:string,body:any)=>body?.action==='sdk_detail'?{capability:{id:body.capability,tier:1},schema:{}}:{});
  const {w,dialog}=await sdkWorld(bridge);
  w.field('sdk-capability')!.value='echo.fs.list';await w.field('sdk-capability')!.fire('input');
  expect(walk(dialog).find(n=>n.className.includes('sdk-tier'))!.textContent).toContain('Tier unknown');
  await w.button('Read live schema')!.click();
  expect(calls(bridge,'/action')[0][1]).toEqual({action:'sdk_detail',capability:'echo.fs.list'});
  expect(walk(dialog).find(n=>n.className.includes('sdk-tier'))!.textContent).toBe('Tier 1');
 });
 it('invokes a tier-0 capability on click with the exact payload and masks secret-looking values in the receipt',async()=>{
  const bridge=fakeBridge();bridge.api=vi.fn(async(path:string,body:any)=>path.startsWith('/catalog')?catalogResults():body?.action==='sdk'?{ok:true,data:{name:'x',api_key:'LEAKED-KEY'}}:{});
  const {w,dialog}=await sdkWorld(bridge);await w.button('Search')!.click();
  await walk(dialog).find(n=>n.className==='sdk-result'&&n.textContent.includes('echo.fs.read'))!.click();
  w.field('sdk-options')!.value='{"path":"/tmp/a"}';await w.button('Invoke capability')!.click();
  expect(calls(bridge,'/action')[0][1]).toEqual({action:'sdk',capability:'echo.fs.read',command:'read',options:{path:'/tmp/a'},chat_id:'c1'});
  expect(dialog.textContent).toContain('"name": "x"');expect(dialog.textContent).not.toContain('LEAKED-KEY');expect(dialog.textContent).toContain('••••••••');
  expect(w.button('Confirm and invoke')).toBeUndefined();
 });
 it('requires an inline confirm for tier 2 and above: nothing is sent until Confirm, and Cancel sends nothing',async()=>{
  const {w,dialog,bridge}=await sdkWorld();await w.button('Search')!.click();
  await walk(dialog).find(n=>n.className==='sdk-result'&&n.textContent.includes('echo.node.exec'))!.click();bridge.api.mockClear();
  w.field('sdk-options')!.value='{"options":{"command":"hostname"}}';await w.button('Invoke capability')!.click();
  expect(calls(bridge,'/action')).toHaveLength(0);expect(dialog.textContent).toContain('echo.node.exec is tier 3. Confirm to invoke it');expect(w.button('Confirm and invoke')).toBeDefined();
  await w.button('Cancel')!.click();expect(calls(bridge,'/action')).toHaveLength(0);expect(w.button('Confirm and invoke')).toBeUndefined();expect(w.status()).toContain('Nothing was sent');
  await w.button('Invoke capability')!.click();await w.button('Confirm and invoke')!.click();
  expect(calls(bridge,'/action')).toHaveLength(1);expect(calls(bridge,'/action')[0][1]).toEqual({action:'sdk',capability:'echo.node.exec',command:'exec',options:{options:{command:'hostname'}},chat_id:'c1'});
 });
 it('treats a manually typed capability as unknown tier and clears a pending confirm when the request changes',async()=>{
  const {w,dialog,bridge}=await sdkWorld();
  w.field('sdk-capability')!.value='echo.custom.thing';await w.field('sdk-capability')!.fire('input');w.field('sdk-command')!.value='thing';
  await w.button('Invoke capability')!.click();
  expect(calls(bridge,'/action')).toHaveLength(0);expect(dialog.textContent).toContain('has no tier in the catalog snapshot, so it is treated as privileged');
  w.field('sdk-command')!.value='other';await w.field('sdk-command')!.fire('input');
  expect(w.button('Confirm and invoke')).toBeUndefined();expect(calls(bridge,'/action')).toHaveLength(0);
 });
 it('refuses invalid options, vault capabilities and secret-looking option keys before any request',async()=>{
  const {w,bridge}=await sdkWorld();
  const run=async(capability:string,options:string)=>{w.field('sdk-capability')!.value=capability;await w.field('sdk-capability')!.fire('input');w.field('sdk-command')!.value='run';w.field('sdk-options')!.value=options;await w.button('Invoke capability')!.click();return w.status();};
  expect(await run('echo.fs.read','not json')).toContain('Options must be a JSON object.');
  expect(await run('echo.fs.read','[1,2]')).toContain('Options must be a JSON object.');
  expect(await run('echo.vault.get','{"service":"x"}')).toContain('Vault form');
  expect(await run('echo.fs.read','{"token":"abc"}')).toContain('Vault form');
  expect(calls(bridge,'/action')).toHaveLength(0);expect(w.button('Confirm and invoke')).toBeUndefined();
 });
 it('revalidates owner admission at click time instead of trusting the rendered page',async()=>{
  const {w,bridge}=await sdkWorld();bridge.api.mockClear();
  member(bridge);
  await w.button('Search')!.click();w.field('sdk-capability')!.value='echo.fs.read';w.field('sdk-command')!.value='read';await w.button('Read live schema')!.click();await w.button('Invoke capability')!.click();
  expect(bridge.api).not.toHaveBeenCalled();expect(w.status()).toContain('Primary owner admission required.');
 });
});

describe('Vault',()=>{
 const vaultWorld=async(bridge=fakeBridge())=>{const w=await world(bridge);const dialog=await w.open('vault');return {w,dialog,bridge};};
 it('sends locate, get and list with the exact reference payload and never a secret key',async()=>{
  const {w,bridge}=await vaultWorld();
  w.field('vault-service')!.value=' github ';w.field('vault-username')!.value='echo';
  for(const [label,operation] of [['Locate reference','locate'],['Retrieve through Vault','get'],['List metadata','list']])await w.button(label)!.click();
  const bodies=calls(bridge,'/action').map((c:any[])=>c[1]);
  expect(bodies.map(b=>b.operation)).toEqual(['locate','get','list']);
  for(const body of bodies){expect(body).toMatchObject({action:'vault',service:'github',username:'echo',chat_id:'c1'});expect(body).not.toHaveProperty('secret');}
 });
 it('stores a credential only through the isolated field, clears it afterwards and never logs or displays it',async()=>{
  const bridge=fakeBridge(),sent:any[]=[];bridge.api=vi.fn(async(_path:string,body:any)=>{sent.push({...body});return {ok:true,stored:true,operation:'put'};});
  const {w}=await vaultWorld(bridge);
  w.field('vault-service')!.value='github';await w.button('Store in Vault')!.click();
  expect(sent).toHaveLength(0);expect(w.status()).toContain('Enter a credential value');
  const secret=w.field('vault-secret')!;secret.value='hunter2-PRIVATE';await w.button('Store in Vault')!.click();
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({action:'vault',operation:'put',service:'github',secret:'hunter2-PRIVATE',chat_id:'c1'});
  expect(calls(bridge,'/action')[0][1]).not.toHaveProperty('secret');// the payload object is scrubbed once the request returns
  expect(secret.value).toBe('');expect(w.status()).toContain('No credential value is displayed');
  expect(w.logs.join('\n')).not.toContain('hunter2-PRIVATE');expect(w.dialog().textContent).not.toContain('hunter2-PRIVATE');
 });
 it('masks secret-looking values in a result by default and reveals one only on its own toggle',async()=>{
  const bridge=fakeBridge();bridge.api=vi.fn(async()=>({operation:'get',service:'github',username:'echo',secret:'SHOULD-BE-MASKED',note:'Scoped retrieval returned.'}));
  const {w,dialog}=await vaultWorld(bridge);
  w.field('vault-service')!.value='github';await w.button('Retrieve through Vault')!.click();
  expect(dialog.textContent).toContain('github');expect(dialog.textContent).toContain('Scoped retrieval returned.');
  expect(dialog.textContent).not.toContain('SHOULD-BE-MASKED');expect(dialog.textContent).toContain('••••••••');
  const reveal=w.button('Reveal')!;await reveal.click();
  expect(dialog.textContent).toContain('SHOULD-BE-MASKED');expect(reveal.textContent).toBe('Hide');
  await reveal.click();expect(dialog.textContent).not.toContain('SHOULD-BE-MASKED');
  expect(w.logs.join('\n')).not.toContain('SHOULD-BE-MASKED');
 });
 it('renders list metadata as a table of entries',async()=>{
  const bridge=fakeBridge();bridge.api=vi.fn(async()=>({entries:[{service:'github',username:'echo',version:2,updated_at:'2026-11-04T00:00:00Z',status:'active'},{service:'stripe',username:'ops'}],count:2}));
  const {w,dialog}=await vaultWorld(bridge);await w.button('List metadata')!.click();
  expect(dialog.textContent).toContain('2 entries · metadata only');expect(walk(dialog).filter(n=>n.tagName==='TR')).toHaveLength(3);expect(dialog.textContent).toContain('stripe');
 });
 it('toggles the credential field between hidden and shown without logging',async()=>{
  const {w}=await vaultWorld();const secret=w.field('vault-secret')!,toggle=w.button('Show')!;
  expect(secret.getAttribute('type')).toBe('password');expect(secret.getAttribute('autocomplete')).toBe('new-password');
  await toggle.click();expect(secret.getAttribute('type')).toBe('text');expect(toggle.textContent).toBe('Hide');
  await toggle.click();expect(secret.getAttribute('type')).toBe('password');expect(w.logs).toEqual([]);
 });
 it('shows the mission callout and refuses a reference lookup without a service name',async()=>{
  const bridge=fakeBridge();bridge.state.data.mission_present=false;const {w,dialog}=await vaultWorld(bridge);
  expect(dialog.textContent).toContain('Access pending');
  await w.button('Locate reference')!.click();expect(calls(bridge,'/action')).toHaveLength(0);expect(w.status()).toContain('exact service name');
 });
});

describe('Code review',()=>{
 it('posts the file, content and project to /review and opens the saved review conversation',async()=>{
  const bridge=fakeBridge(),w=await world(bridge),dialog=await w.open('review');
  expect(w.field('review-name')!.value).toBe('changes.diff');expect(w.field('review-project')!.value).toBe('p1');
  w.field('review-name')!.value='fix.diff';w.field('review-source')!.value='--- a\n+++ b\n+x';w.field('review-project')!.value='';
  await w.button('Review with FORGE')!.click();
  expect(calls(bridge,'/review')[0][1]).toEqual({name:'fix.diff',content:'--- a\n+++ b\n+x',project_id:null});
  expect(bridge.refresh).toHaveBeenCalled();expect(bridge.openChat).toHaveBeenCalledWith('reviewed');expect(dialog.open).toBe(false);
 });
 it('refuses empty or oversized sources and a missing file name without a request',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('review');
  await w.button('Review with FORGE')!.click();expect(w.status()).toContain('nonempty');
  w.field('review-source')!.value='x'.repeat(40001);await w.button('Review with FORGE')!.click();expect(w.status()).toContain('40,000');
  w.field('review-source')!.value='ok';w.field('review-name')!.value='';await w.button('Review with FORGE')!.click();expect(w.status()).toContain('file name');
  expect(calls(bridge,'/review')).toHaveLength(0);
 });
 it('loads a file or diff under 40 KB into the form and refuses larger ones',async()=>{
  const bridge=fakeBridge(),w=await world(bridge);await w.open('review');
  const picker=w.field('review-file')!;
  picker.files=[file('big.py','x',40001)];await picker.fire('change');expect(w.status()).toContain('under 40 KB');expect(w.field('review-source')!.value).toBe('');
  picker.files=[file('main.py','print(2)')];await picker.fire('change');
  expect(w.field('review-source')!.value).toBe('print(2)');expect(w.field('review-name')!.value).toBe('main.py');expect(picker.value).toBe('');
 });
 it('reports a review that returned without a saved conversation instead of opening anything',async()=>{
  const bridge=fakeBridge();bridge.api=vi.fn(async()=>({error:'nothing'}));const w=await world(bridge);await w.open('review');
  w.field('review-source')!.value='code';await w.button('Review with FORGE')!.click();
  expect(bridge.openChat).not.toHaveBeenCalled();expect(w.status()).toContain('Review returned without a saved conversation');expect(w.button('Review with FORGE')!.textContent).toBe('Review with FORGE');
 });
});

describe('ui_action navigation',()=>{
 it('ignores unknown views and returns to the chat surface for "chats"',async()=>{
  const w=await world(fakeBridge());const views=w.window.EchoPrimeViews;
  expect(await views.navigate('admin')).toBe(false);expect(await views.navigate(42)).toBe(false);expect(w.dialog()).toBeUndefined();
  const dialog=await w.open('projects');expect(dialog.open).toBe(true);
  expect(await views.navigate('chats')).toBe(true);expect(dialog.open).toBe(false);expect(w.get('#prompt').focused).toBe(true);
 });
 it('routes plugins, diagnostics and media to their own modules with admission respected',async()=>{
  const w=await world(fakeBridge());const views=w.window.EchoPrimeViews;
  expect(await views.navigate('plugins')).toBe(true);expect(w.window.EchoPrimePlugins.open).toHaveBeenCalledTimes(1);
  expect(await views.navigate('diagnostics')).toBe(true);expect(w.window.EchoPrimeLogs.open).toHaveBeenCalledTimes(1);
  expect(await views.navigate('media')).toBe(true);expect(w.window.EchoPrimeStudio.open).toHaveBeenCalledWith('all');
  const m=await world(member(fakeBridge()));
  expect(await m.window.EchoPrimeViews.navigate('diagnostics')).toBe(false);expect(m.window.EchoPrimeLogs.open).not.toHaveBeenCalled();expect(m.get('#draft-notice').textContent).toContain('Primary owner admission');
  const a=await world(anonymous(fakeBridge()));
  expect(await a.window.EchoPrimeViews.navigate('plugins')).toBe(false);expect(a.window.EchoPrimePlugins.open).not.toHaveBeenCalled();
 });
 it('never lands a member on SDK or Vault and opens them for the owner',async()=>{
  const bridge=member(fakeBridge()),w=await world(bridge);
  for(const view of ['sdk','vault']){expect(await w.window.EchoPrimeViews.navigate(view)).toBe(false);}
  expect(w.dialog()).toBeUndefined();expect(bridge.api).not.toHaveBeenCalled();expect(w.get('#draft-notice').textContent).toContain('Primary owner admission');
  const o=await world(fakeBridge());expect(await o.window.EchoPrimeViews.navigate('vault')).toBe(true);await tick();expect(o.dialog().textContent).toContain('Use credentials without putting them in chat.');
 });
});

// ---- workspace.js applies ui_action after a saved, read-back reply ---------------
class WNode {
 textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;inert=false;isConnected=true;
 tagName:string;dataset:Record<string,string>={};attributes:Record<string,string>={};children:WNode[]=[];parent:WNode|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};files:any[]=[];
 classList={add:vi.fn(),remove:vi.fn(),toggle:vi.fn(),contains:()=>false};style={setProperty:vi.fn()};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:WNode[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:WNode[]){for(const child of this.children)child.isConnected=false;this.children=[];this.append(...items);}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key==='value')this.value=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},target:this,...event});}
 showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}focus(){}before(){}click(){return this.fire('click');}
 querySelector(selector:string):WNode|null{return this.children.find(n=>n.tagName.toLowerCase()===selector)||this.children.map(n=>n.querySelector(selector)).find(Boolean)||null;}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
}
function workspaceHarness(uiAction:any){
 const timeline:string[]=[];
 const request=vi.fn(async(path:string)=>{timeline.push(path);
  if(path==='/state')return {chats:[{id:'c1',title:'Current'},{id:'target',title:'Target chat'}],projects:[],library:[],preferences:[],personalities:[]};
  if(path==='/chats')return {id:'c1',title:'Current',messages:[]};
  if(path==='/chats/c1')return {id:'c1',title:'Current',messages:[{id:'reply',role:'assistant',content:'done'}]};
  if(path==='/chats/target')return {id:'target',title:'Target chat',messages:[{id:'m',role:'assistant',content:'earlier'}]};
  return {};});
 const session={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
 class Transport {session=session;constructor(_options:any){}loadSession=async()=>this.session;request=request;headers=()=>({});clear(){}auth=async()=>({});text=async()=>'';audio=async()=>new Blob();
  chat=async(input:any,onEvent:(event:any)=>void)=>{onEvent({type:'tool_result',tool:'workspace',request_id:'r1',result:{ok:true,ui_action:uiAction}});return {id:input.chat_id,messages:[{id:'reply',role:'assistant',content:'done'}]};};}
 const nodes=new Map<string,WNode>(),events:Record<string,((event:any)=>unknown)[]>={};
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new WNode());return nodes.get(selector)!;};
 const navigate=vi.fn(async(view:string)=>{timeline.push('navigate:'+view);return true;});
 const window:any={addEventListener:(name:string,callback:(event:any)=>unknown)=>(events[name]??=[]).push(callback),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);},
  EchoPrimeChat:{reset:vi.fn()},EchoPrimeWorkspaceTransport:Transport,EchoPrimeViews:{navigate}};
 const document:any={hidden:false,head:new WNode(),querySelector:get,querySelectorAll:()=>[],createElement:(tag:string)=>new WNode(tag),createTextNode:(text:string)=>Object.assign(new WNode('text'),{textContent:text}),addEventListener(){}};
 const context={window,document,navigator:{userAgent:'fixture'},crypto:{randomUUID},setTimeout,clearTimeout,AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,console:{debug:vi.fn()}};
 runInNewContext(source('workspace.js'),context);
 get('#workspace-chat-kind').value='workspace';
 return {window,get,request,navigate,timeline};
}
describe('workspace.js ui_action after reply',()=>{
 it('opens the named chat only after the reply was saved and read back',async()=>{
  const h=workspaceHarness({action:'open_chat',id:'target'});await h.window.EchoPrimeWorkspace.ready;
  const result=await h.window.EchoPrimeWorkspace.send('open the target chat');
  expect(result).toMatchObject({handled:true,sent:true,verified:true});
  expect(h.timeline.indexOf('/chats/target')).toBeGreaterThan(h.timeline.indexOf('/chats/c1'));
  expect(h.get('#conversation-title').textContent).toBe('Target chat');expect(h.navigate).not.toHaveBeenCalled();
 });
 it('asks the view module to navigate after the readback, and only for a known view',async()=>{
  const h=workspaceHarness({action:'navigate',view:'projects'});await h.window.EchoPrimeWorkspace.ready;
  await h.window.EchoPrimeWorkspace.send('show my projects');
  expect(h.navigate).toHaveBeenCalledWith('projects');expect(h.timeline.indexOf('navigate:projects')).toBeGreaterThan(h.timeline.indexOf('/chats/c1'));
  const bad=workspaceHarness({action:'navigate',view:'admin'});await bad.window.EchoPrimeWorkspace.ready;await bad.window.EchoPrimeWorkspace.send('x');
  expect(bad.navigate).not.toHaveBeenCalled();
 });
 it('ignores malformed actions and never opens a chat whose id is not a plain identifier',async()=>{
  for(const action of [{action:'open_chat',id:'../evil'},{action:'open_chat',id:42},'open_chat',['navigate'],{action:'delete_all'}]){
   const h=workspaceHarness(action);await h.window.EchoPrimeWorkspace.ready;
   const result=await h.window.EchoPrimeWorkspace.send('try');
   expect(result).toMatchObject({sent:true,verified:true});
   expect(h.timeline.filter(p=>p.startsWith('/chats/')&&p!=='/chats/c1')).toEqual([]);expect(h.navigate).not.toHaveBeenCalled();
  }
 });
});

describe('static delivery',()=>{
 it('serves views.js and views.css and the page routes the five nav entries to the new views',async()=>{
  const server=await startPrimeServer(new PrimeHub({capabilities:[]}),fileURLToPath(new URL('../ui/echo-prime/',import.meta.url)),0);
  try{
   for(const [path,type] of [['/views.js','javascript'],['/views.css','css']]){const response=await fetch(server.url+path);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain(type);}
   const page=await (await fetch(server.url+'/')).text();
   expect(page).toContain('views.js');expect(page).toContain('views.css');
   for(const view of VIEW_NAMES)expect(page).toContain('data-prime-view="'+view+'"');
   expect(page).toMatch(/data-prime-view="sdk" data-owner-only>SDK</);expect(page).toMatch(/data-prime-view="vault" data-owner-only>Vault</);
   expect(page).not.toContain('data-workspace-view="operations"');expect(page).toContain('data-workspace-view="voice"');
  }finally{await server.close();}
 });
});
