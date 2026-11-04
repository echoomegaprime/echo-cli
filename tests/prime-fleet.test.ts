import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

type Session = {workspaceConfigured:boolean; authenticated:boolean; ownerAccess:boolean; user:{uid:string; status:string}};
type Workspace = {enabled:boolean; session:Session | null; request:(path:string, body?:unknown, signal?:AbortSignal)=>Promise<unknown>};
type Snapshot = {fleet:{nodes:Array<{id:string; connection:string; stale:boolean}>}; model:{state:string}; sync:{verified:number|null; remaining:number|null}};
type Controller = {readonly admitted:boolean; readonly snapshot:Snapshot; refresh:(health?:boolean)=>Promise<void>; invalidate:()=>void; diagnostics:()=>Promise<unknown>; retrySync:()=>Promise<unknown>};
type FleetApi = {
 normalizeFleet:(value:unknown, now?:number)=>Snapshot['fleet'];
 modelState:(value:unknown)=>{state:string; label:string; context:number|null};
 syncSummary:(value:unknown)=>{verified:number|null; remaining:number|null; label:string};
 diagnosticSummary:(value:unknown)=>{mission:Record<string,unknown>; operations:Array<Record<string,unknown>>};
 createController:(options:{workspace:Workspace; now?:()=>number; onUpdate?:(value:Snapshot)=>void})=>Controller;
};
const now=Date.parse('2026-11-04T18:00:00Z');
const owner=():Session=>({workspaceConfigured:true,authenticated:true,ownerAccess:true,user:{uid:'owner-fixture',status:'approved'}});
async function fixture(){
 const window:Record<string,unknown>={};
 runInNewContext(await readFile(new URL('../ui/echo-prime/fleet.js',import.meta.url),'utf8'),{window,AbortController,console:{debug:vi.fn()},Date,queueMicrotask,setTimeout,clearTimeout});
 return window.EchoPrimeFleet as FleetApi;
}
describe('Prime live fleet evidence',()=>{
 it('always shows the six nodes and never promotes missing, stale or malformed evidence to connected',async()=>{
  const api=await fixture();
  const value=api.normalizeFleet({observed_at:'2026-11-04T17:59:50Z',nodes:[
   {id:'quench',connection:'connected',checked_at:'2026-11-04T17:59:50Z',evidence:'Local host identity'},
   {id:'forge',connection:'connected',checked_at:'2026-11-04T17:56:00Z'},
   {id:'anvil',connection:'connected'},
   {id:'hammer',connection:'green',checked_at:'2026-11-04T17:59:50Z'},
   {id:'temper',connection:'connected',checked_at:'2026-11-04T18:10:00Z'},
   {id:'not-a-fleet-node',connection:'connected',checked_at:'2026-11-04T17:59:50Z'}
  ]},now);
  expect(value.nodes.map(node=>node.id)).toEqual(['quench','forge','anvil','hammer','temper','crucible']);
  expect(value.nodes.map(node=>node.connection)).toEqual(['connected','unknown','unknown','unknown','unknown','unknown']);
  expect(value.nodes[1].stale).toBe(true);
 });
 it('requires the configured context and exclusive-model readiness rather than loaded alone',async()=>{
  const api=await fixture();
  expect(api.modelState({model:{loaded:true,ok:false,context_length:65536,configured_context_length:262144}}).state).toBe('attention');
  expect(api.modelState({model:{loaded:true,ok:true,exclusive_model:true,model:'fixture-qwen',context_length:262144,configured_context_length:262144}})).toMatchObject({state:'ready',context:262144});
  expect(api.modelState({model:{loaded:false,ok:false}}).state).toBe('needed');
  expect(api.modelState(null).state).toBe('unknown');
 });
 it('keeps exact ECF readback, pending delivery and unknown counters distinct',async()=>{
  const api=await fixture();
  expect(api.syncSummary({verified:4,remaining:2})).toMatchObject({verified:4,remaining:2,label:'Journal saved · 2 awaiting ECF'});
  expect(api.syncSummary({verified:0,remaining:0}).label).toBe('Journal & ECF receipts');
  expect(api.syncSummary({verified:-1,remaining:'0'})).toMatchObject({verified:null,remaining:null});
  expect(api.syncSummary({mode:'private_local'}).label).toBe('Private journal & memories');
 });
 it('projects diagnostics to metadata and excludes bodies, error text, tokens and mission internals',async()=>{
  const api=await fixture();
  const result=api.diagnosticSummary({mission:{ready:true,role:'builder',run_id:'fixture-run',token_hash:'sensitive-hash',error:'password=example'},operations:[{operation:'sdk_read',status:'ok',duration_ms:12,observed_at_utc:'2026-11-04T17:59:50Z',body:'private message',token:'sensitive-token',error:'secret=example'}]});
  expect(result.operations).toEqual([{operation:'sdk_read',status:'ok',duration_ms:12,observed_at_utc:'2026-11-04T17:59:50Z'}]);
  expect(JSON.stringify(result)).not.toMatch(/sensitive|private message|password|secret=/);
 });
 it.each(['anonymous','member','pending','unconfigured'])('does not request private observations for %s',async(kind)=>{
  const api=await fixture(),session=owner(),request=vi.fn();
  if(kind==='anonymous')session.authenticated=false;
  if(kind==='member')session.ownerAccess=false;
  if(kind==='pending')session.user.status='pending';
  if(kind==='unconfigured')session.workspaceConfigured=false;
  const controller=api.createController({workspace:{enabled:true,session,request},now:()=>now});
  await controller.refresh();
  expect(request).not.toHaveBeenCalled();expect(controller.admitted).toBe(false);
  await expect(controller.diagnostics()).rejects.toThrow(/owner/i);
  await expect(controller.retrySync()).rejects.toThrow(/owner/i);
 });
 it('invalidates in-flight owner evidence and aborts its request on identity change',async()=>{
  const api=await fixture();let finish!:(value:unknown)=>void,signal:AbortSignal|undefined;
  const workspace:Workspace={enabled:true,session:owner(),request:vi.fn((_path,_body,requestSignal)=>{signal=requestSignal;return new Promise(resolve=>{finish=resolve;});})};
  const controller=api.createController({workspace,now:()=>now}),pending=controller.refresh();
  workspace.session=null;controller.invalidate();
  expect(signal?.aborted).toBe(true);
  finish({nodes:[{id:'quench',connection:'connected',checked_at:'2026-11-04T17:59:50Z'}]});await pending;
  expect(controller.snapshot.fleet.nodes.every(node=>node.connection==='unknown')).toBe(true);
  expect(workspace.request).toHaveBeenCalledTimes(1);
 });
 it('replaces earlier green results with unknown when a later read fails and logs only safe categories',async()=>{
  const api=await fixture();let unavailable=false;
  const workspace:Workspace={enabled:true,session:owner(),request:vi.fn(async path=>{
   if(unavailable)throw new Error('token=sensitive-value');
   return path==='/fleet'?{nodes:[{id:'forge',connection:'connected',checked_at:'2026-11-04T17:59:50Z'}]}:{model:{loaded:true,ok:true,exclusive_model:true,context_length:262144,configured_context_length:262144},sync:{verified:1,remaining:0}};
  })};
  const controller=api.createController({workspace,now:()=>now});await controller.refresh();
  expect(controller.snapshot.fleet.nodes[1].connection).toBe('connected');
  unavailable=true;await controller.refresh();
  expect(controller.snapshot.fleet.nodes[1].connection).toBe('unknown');expect(controller.snapshot.model.state).toBe('unknown');
 });
 it('runs one explicit sync pass followed by independent health readback and never retries an ambiguous write',async()=>{
  const api=await fixture(),request=vi.fn(async(path:string)=>path==='/sync'?{submitted:3}:{sync:{verified:1,remaining:2}});
  const workspace:Workspace={enabled:true,session:owner(),request},controller=api.createController({workspace,now:()=>now});
  await controller.retrySync();
  expect(request.mock.calls.map(row=>row[0])).toEqual(['/sync','/health']);
  expect(controller.snapshot.sync).toMatchObject({verified:1,remaining:2});
  request.mockReset();request.mockRejectedValue(new Error('connection lost after dispatch'));
  await expect(controller.retrySync()).rejects.toThrow(/unconfirmed|returned/i);
  expect(request).toHaveBeenCalledTimes(1);
 });
});

// Exercise the shipped DOM controller without a browser process or network.
class FleetNode {
 tagName:string; private content=''; className=''; hidden=false; disabled=false; open=false;
 attributes:Record<string,string>={}; children:FleetNode[]=[]; parent:FleetNode|null=null;
 events:Record<string,Array<(event:Record<string,unknown>)=>unknown>>={};
 constructor(tag='div'){this.tagName=tag;}
 // Native textContent assignment replaces descendant text nodes. Retaining the
 // old child made the journal's initial label append to every updated label.
 get textContent():string{return this.content+this.children.map(child=>child.textContent).join('');}
 set textContent(value:string){this.content=value;this.children=[];}
 append(...children:FleetNode[]){for(const child of children){child.parent=this;this.children.push(child);}}
 replaceChildren(...children:FleetNode[]){this.content='';this.children=[];this.append(...children);}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key==='hidden')this.hidden=true;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(type:string,listener:(event:Record<string,unknown>)=>unknown){(this.events[type]??=[]).push(listener);}
 async fire(type:string,event:Record<string,unknown>={}){for(const listener of this.events[type]||[])await listener(event);}
 showModal(){this.open=true;}
 close(){this.open=false;void this.fire('close');}
 after(node:FleetNode){node.parent=this.parent;if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this)+1,0,node);}
 querySelector(selector:string):FleetNode|null{return this.all().find(node=>selector.startsWith('#')?node.attributes.id===selector.slice(1):selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tagName===selector)||null;}
 all():FleetNode[]{return this.children.flatMap(child=>[child,...child.all()]);}
}
const nodeText=(node:FleetNode):string=>node.textContent;
type PageOptions={id:string;title:string;subtitle:string;ownerOnly:boolean};
type PageHandle={body:FleetNode;status:FleetNode;isCurrent:()=>boolean;setStatus:(value:string)=>void;close:()=>void;id:string};
async function browserFixture(){
 const body=new FleetNode('body'),topbar=new FleetNode('header'),nav=new FleetNode('nav');
 topbar.className='topbar';nav.setAttribute('id','workspace-navigation');body.append(topbar,nav);
 const listeners:Record<string,Array<(event:Record<string,unknown>)=>unknown>>={};
 const events:Record<string,Array<(event:Record<string,unknown>)=>unknown>>={};
 let finishReady!:(value:boolean)=>void;
 const request=vi.fn<Workspace['request']>(async(path:string)=>path==='/fleet'?{nodes:[{id:'forge',connection:'connected',checked_at:new Date().toISOString(),evidence:'Synthetic live probe'}]}:path==='/health'?{model:{loaded:true,ok:true,exclusive_model:true,context_length:262144,configured_context_length:262144},sync:{verified:3,remaining:2}}:path==='/diagnostics'?{mission:{ready:true,role:'builder'},sync:{verified:3,remaining:2},operations:[{operation:'fixture_read',status:'ok',body:'PRIVATE BODY',token:'PRIVATE TOKEN'}]}:{submitted:1});
 const pageBody=new FleetNode('section'),pageStatus=new FleetNode('p');pageBody.setAttribute('id','fixture-main-body');body.append(pageStatus,pageBody);let pageEpoch=0;
 const presentView=vi.fn<(options:PageOptions)=>Promise<PageHandle>>(async options=>{
  if(!workspace.session?.ownerAccess||!workspace.session.authenticated||workspace.session.user.status!=='approved')throw new Error('Owner admission required.');
  const epoch=++pageEpoch;pageBody.replaceChildren();pageStatus.textContent='';
  return {body:pageBody,status:pageStatus,isCurrent:()=>epoch===pageEpoch&&!!workspace.session?.ownerAccess,setStatus:(value:string)=>{if(epoch===pageEpoch)pageStatus.textContent=value;},close:()=>{if(epoch===pageEpoch){pageEpoch++;pageBody.replaceChildren();pageStatus.textContent='';}},id:options.id};
 });
 const workspace:Workspace&{ready:Promise<boolean>;presentView:typeof presentView}={enabled:true,session:owner(),request,presentView,ready:new Promise(resolve=>{finishReady=resolve;})};
 const window={EchoPrimeWorkspace:workspace,setInterval:vi.fn(()=>1),clearInterval:vi.fn(),addEventListener:(type:string,listener:(event:Record<string,unknown>)=>unknown)=>{(events[type]??=[]).push(listener);}};
 const document={body,hidden:false,querySelector:(selector:string)=>body.querySelector(selector),createElement:(tag:string)=>new FleetNode(tag),createTextNode:(value:string)=>Object.assign(new FleetNode('text'),{textContent:value}),addEventListener:(type:string,listener:(event:Record<string,unknown>)=>unknown)=>{(listeners[type]??=[]).push(listener);}};
 runInNewContext(await readFile(new URL('../ui/echo-prime/fleet.js',import.meta.url),'utf8'),{window,document,AbortController,console:{debug:vi.fn()},Date,queueMicrotask,setTimeout,clearTimeout});
 const emit=async(type:string,event:Record<string,unknown>={})=>{if(type==='echo-account-changed'){pageEpoch++;pageBody.replaceChildren();pageStatus.textContent='';}for(const listener of events[type]||[])await listener(event);};
 const find=(label:string)=>body.all().find(node=>node.tagName==='button'&&nodeText(node)===label)!;
 const navigate=()=>{pageEpoch++;pageBody.textContent='Next page content';pageStatus.textContent='Next page status';};
 return {body,nav,workspace,request,window,document,emit,find,finishReady,presentView,pageBody,pageStatus,navigate};
}
describe('Prime fleet browser lifecycle',()=>{
 it('waits for shared Workspace readiness, mounts all six nodes, and immediately clears private views on identity loss',async()=>{
  const h=await browserFixture(),bar=h.body.querySelector('#prime-fleet-bar')!;
  expect(bar.hidden).toBe(true);expect(h.request).not.toHaveBeenCalled();h.finishReady(true);
  await vi.waitFor(()=>expect(h.request).toHaveBeenCalledTimes(2));
  expect(bar.hidden).toBe(false);expect(bar.all().filter(node=>node.className.startsWith('prime-fleet-node '))).toHaveLength(6);
  await h.find('Logs & debugging').fire('click');
  await vi.waitFor(()=>expect(nodeText(h.pageBody)).toContain('fixture_read'));
  expect(h.presentView).toHaveBeenCalledWith({id:'logs',title:'Logs & debugging',subtitle:expect.any(String),ownerOnly:true});
  expect(h.body.querySelector('#prime-observations-dialog')!.open).toBe(false);
  expect(nodeText(h.body)).not.toMatch(/PRIVATE BODY|PRIVATE TOKEN/);
  h.workspace.session=null;await h.emit('echo-account-changed');
  expect(bar.hidden).toBe(true);expect(h.body.querySelector('#prime-observations-dialog')!.open).toBe(false);
  expect(nodeText(h.body)).not.toContain('fixture_read');
 });
 it('keeps Journal delivery writes explicit and executes only one pass followed by a separate readback',async()=>{
  const h=await browserFixture();h.finishReady(true);await vi.waitFor(()=>expect(h.request).toHaveBeenCalledTimes(2));
  await vi.waitFor(()=>expect(h.find('Journal saved · 2 awaiting ECF')).toBeDefined());
  await h.find('Journal saved · 2 awaiting ECF').fire('click');
  expect(h.presentView).toHaveBeenCalledWith({id:'journal',title:'Journal & ECF receipts',subtitle:expect.any(String),ownerOnly:true});
  expect(h.body.querySelector('#prime-observations-dialog')!.open).toBe(false);
  expect(h.request.mock.calls.some(call=>call[0]==='/sync')).toBe(false);
  const start=h.request.mock.calls.length;await h.find('Retry pending records · one pass').fire('click');
  expect(h.request.mock.calls.slice(start).map(call=>call[0])).toEqual(['/sync','/health']);
  expect(nodeText(h.body)).toContain('3 records have exact ECF readback. 2 are awaiting confirmation.');
 });
 it('discards a late diagnostics response after navigation instead of replacing the next page',async()=>{
  const h=await browserFixture();h.finishReady(true);await vi.waitFor(()=>expect(h.request).toHaveBeenCalledTimes(2));
  let finish!:(value:unknown)=>void;
  const prior=h.request.getMockImplementation()!;
  h.request.mockImplementation(path=>path==='/diagnostics'?new Promise(resolve=>{finish=resolve;}):prior(path));
  const pending=h.find('Logs & debugging').fire('click');
  await vi.waitFor(()=>expect(h.request.mock.calls.some(call=>call[0]==='/diagnostics')).toBe(true));
  h.navigate();finish({mission:{ready:true},operations:[{operation:'OLD PAGE RECEIPT',status:'ok'}]});await pending;
  expect(h.pageBody.textContent).toBe('Next page content');expect(h.pageStatus.textContent).toBe('Next page status');
 });
 it('does not overwrite a new page when an explicit synchronization finishes after navigation',async()=>{
  const h=await browserFixture();h.finishReady(true);await vi.waitFor(()=>expect(h.request).toHaveBeenCalledTimes(2));
  await vi.waitFor(()=>expect(h.find('Journal saved · 2 awaiting ECF')).toBeDefined());await h.find('Journal saved · 2 awaiting ECF').fire('click');
  let finish!:(value:unknown)=>void;const prior=h.request.getMockImplementation()!;
  h.request.mockImplementation(path=>path==='/sync'?new Promise(resolve=>{finish=resolve;}):prior(path));
  const pending=h.find('Retry pending records · one pass').fire('click');await vi.waitFor(()=>expect(h.request.mock.calls.some(call=>call[0]==='/sync')).toBe(true));
  h.navigate();finish({submitted:1});await pending;
  expect(h.pageBody.textContent).toBe('Next page content');expect(h.pageStatus.textContent).toBe('Next page status');
  expect(h.request.mock.calls.filter(call=>call[0]==='/sync')).toHaveLength(1);
 });
 it('restarts observation polling on BFCache restore and does not poll for a member account',async()=>{
  const h=await browserFixture();h.workspace.session!.ownerAccess=false;h.finishReady(true);await Promise.resolve();await Promise.resolve();
  expect(h.request).not.toHaveBeenCalled();expect(h.window.setInterval).toHaveBeenCalledTimes(1);
  await h.emit('pagehide');expect(h.window.clearInterval).toHaveBeenCalledTimes(1);
  await h.emit('pageshow',{persisted:true});expect(h.window.setInterval).toHaveBeenCalledTimes(2);
  expect(h.request).not.toHaveBeenCalled();
 });
});
