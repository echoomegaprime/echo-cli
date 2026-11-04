/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';

// The shipped browser controllers run unchanged in a small DOM harness. The
// Workspace transport and backend responses are synthetic: this proves state
// mapping, gating, polling and stale-response handling, not a live probe.
class Node {
 tagName:string;textContent='';className='';hidden=false;disabled=false;open=false;title='';
 attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;events:Record<string,((event:any)=>unknown)[]>={};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:Node[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:Node[]){this.children=[];this.append(...items);}
 before(item:Node){item.parent=this.parent;}
 setAttribute(key:string,value:string){this.attributes[key]=value;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({target:this,...event});}
 showModal(){this.open=true;}
 close(){if(!this.open)return;this.open=false;void this.fire('close');}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
}
const text=(node:Node):string=>node.textContent+node.children.map(text).join(' ');
const all=(node:Node):Node[]=>node.children.flatMap(child=>[child,...all(child)]);
const session=(over:any={})=>({workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'csrf-token',user:{uid:'owner',role:'owner',status:'approved'},...over});
const member=()=>session({ownerAccess:false,user:{uid:'member',role:'member',status:'approved'}});
const anonymous=()=>({workspaceConfigured:true,authenticated:false,ownerAccess:false,csrf:null,user:null});
const unconfigured=()=>({workspaceConfigured:false,authenticated:false,ownerAccess:false,csrf:null,user:null});
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
function deferred<T=any>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const now=()=>new Date().toISOString();
const fleetResponse=()=>({observed_at:now(),nodes:[
 {id:'quench',connection:'connected',evidence:'Local workspace host identity',hostname:'QUENCH'},
 {id:'forge',connection:'connected',evidence:'Live SDK node probe',latency_ms:41,health:'<b>load ok</b>',role:'gate'},
 {id:'anvil',connection:'disconnected',error:'probe timed out'},
 {id:'hammer',connection:'weird-value'},
 {id:'crucible',connection:'unknown'},
]});

interface World {session:any;handlers:Record<string,(body?:any)=>any>;calls:[string,any][];sessionError:boolean;onIdentity?:(session:any)=>void}
function boot(world:World,options:{logs?:boolean}={}){
 const created:Node[]=[],queried=new Map<string,Node>(),timers:{fn:()=>unknown;ms:number}[]=[],events:Record<string,((event:any)=>unknown)[]>={},documentEvents:Record<string,((event:any)=>unknown)[]>={};
 const get=(selector:string)=>{if(!queried.has(selector))queried.set(selector,new Node());return queried.get(selector)!;};
 const document:any={hidden:false,body:new Node('body'),querySelector:get,
  createElement:(tag:string)=>{const node=new Node(tag);created.push(node);return node;},
  createTextNode:(value:string)=>Object.assign(new Node('#text'),{textContent:value}),
  addEventListener:(name:string,callback:(event:any)=>unknown)=>(documentEvents[name]??=[]).push(callback)};
 class Transport{
  session:any=null;
  constructor(options:any){world.onIdentity=options.onIdentityChange;}
  async loadSession(){
   if(world.sessionError){world.onIdentity?.(null);throw new Error('Account admission unavailable.');}
   const value=world.session,previous=this.session;
   const changed=(previous?.user?.uid??null)!==(value.user?.uid??null)||!!previous?.authenticated!==!!value.authenticated||previous?.user?.status!==value.user?.status||!!previous?.ownerAccess!==!!value.ownerAccess;
   this.session=value;if(changed)world.onIdentity?.(value);return value;
  }
  async request(path:string,body?:any){
   await this.loadSession();
   world.calls.push([path,body]);
   const handler=world.handlers[path];if(!handler)throw new Error('No handler for '+path);
   return handler(body);
  }
 }
 const window:any={EchoPrimeWorkspaceTransport:Transport,EchoPrimeWorkspace:{ready:Promise.resolve(true)},
  addEventListener:(name:string,callback:(event:any)=>unknown)=>(events[name]??=[]).push(callback),
  dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);}};
 const context={window,document,AbortController,Promise,setInterval:(fn:()=>unknown,ms:number)=>{timers.push({fn,ms});return timers.length;},clearInterval:vi.fn(),console};
 const read=(file:string)=>readFileSync(new URL('../ui/echo-prime/'+file,import.meta.url),'utf8');
 runInNewContext(read('fleet.js'),context);
 if(options.logs)runInNewContext(read('logs.js'),context);
 const byId=(id:string)=>created.find(node=>node.attributes.id===id)!;
 const nodeButton=(id:string)=>created.find(node=>node.attributes['data-node']===id)!;
 const find=(root:Node,label:string)=>all(root).find(node=>node.tagName==='BUTTON'&&text(node).trim()===label)!;
 return {window,document,created,timers,byId,nodeButton,find,calls:world.calls,
  tick:async(ms:number)=>{for(const timer of timers.filter(t=>t.ms===ms))await timer.fn();await flush();},
  emit:(type:string)=>window.dispatchEvent({type}),
  emitDocument:(type:string)=>{for(const fn of documentEvents[type]||[])fn({type});},
  leds:()=>Object.fromEntries(['quench','forge','anvil','hammer','temper','crucible'].map(id=>[id,nodeButton(id).className.replace('fleet-node ','')])),
  forgeText:()=>byId('forge-connection').textContent};
}
const world=(over:Partial<World>={}):World=>({session:session(),sessionError:false,calls:[],handlers:{
 '/fleet':()=>fleetResponse(),'/health':()=>({ok:true,model:{loaded:true},sync:{verified:4,remaining:0,mode:undefined}}),
},...over});

describe('state mapping',()=>{
 const {core}=(()=>{const w=world();return boot(w).window.EchoPrimeFleet;})();
 it('accepts only the two known connection values and never promotes anything else to connected',()=>{
  expect(core.connectionState('connected')).toBe('connected');
  expect(core.connectionState('disconnected')).toBe('disconnected');
  for(const value of ['unknown','CONNECTED','ok',true,1,null,undefined,{}])expect(core.connectionState(value)).toBe('unknown');
 });
 it('always yields the six nodes in fixed order, with absent or malformed rows unknown',()=>{
  const rows=core.normalizeFleet({nodes:[{id:'FORGE',connection:'connected'},{id:'anvil',connection:'disconnected'},null,'x',{connection:'connected'},{id:'extra',connection:'connected'}]});
  expect(rows.map((n:any)=>n.id)).toEqual(['quench','forge','anvil','hammer','temper','crucible']);
  expect(rows.map((n:any)=>n.connection)).toEqual(['unknown','connected','disconnected','unknown','unknown','unknown']);
  expect(core.normalizeFleet(null).every((n:any)=>n.connection==='unknown')).toBe(true);
  expect(core.normalizeFleet({nodes:'nope'}).every((n:any)=>n.connection==='unknown')).toBe(true);
 });
 it('does not trust a result whose probe is older than five minutes',()=>{
  const at=Date.parse('2026-11-04T12:00:00Z');
  const rows=core.normalizeFleet({observed_at:'2026-11-04T11:50:00Z',nodes:[{id:'forge',connection:'connected'},{id:'anvil',connection:'disconnected',checked_at:'2026-11-04T11:59:30Z'}]},at);
  expect(rows[1].connection).toBe('unknown');expect(rows[1].reason).toMatch(/older than five minutes/);
  expect(rows[2].connection).toBe('disconnected');
 });
 it('maps model.loaded strictly',()=>{
  expect(core.healthState({model:{loaded:true}})).toBe('loaded');
  expect(core.healthState({model:{loaded:false}})).toBe('needed');
  for(const value of [{},{model:{}},{model:{loaded:'yes'}},{model:null},null])expect(core.healthState(value)).toBe('unknown');
 });
 it('classifies admission without treating a member or anonymous visitor as owner',()=>{
  expect(core.classify(session())).toBe('owner');expect(core.classify(member())).toBe('member');
  expect(core.classify(anonymous())).toBe('signin');expect(core.classify(unconfigured())).toBe('offline');
  expect(core.classify(session({user:{uid:'owner',status:'pending'}}))).toBe('pending');expect(core.classify(null)).toBe('offline');
 });
});

describe('live node bar',()=>{
 it('shows each LED from the live /fleet response and the FORGE model line from /health',async()=>{
  const w=world(),h=boot(w);await flush();
  expect(h.leds()).toEqual({quench:'connected',forge:'connected',anvil:'disconnected',hammer:'unknown',temper:'unknown',crucible:'unknown'});
  expect(h.forgeText()).toBe('FORGE · Model loaded');expect(h.byId('forge-connection').className).toContain('online');
  expect(h.nodeButton('anvil').attributes['aria-label']).toContain('disconnected');
 });
 it('says Connection needed when the model is not loaded and Status unknown on a bad health reply',async()=>{
  const w=world();w.handlers['/health']=()=>({model:{loaded:false}});const h=boot(w);await flush();
  expect(h.forgeText()).toBe('FORGE · Connection needed');expect(h.byId('forge-connection').className).not.toContain('online');
  w.handlers['/health']=()=>{throw new Error('boom');};await h.tick(60000);
  expect(h.forgeText()).toBe('FORGE · Status unknown');
 });
 it('polls fleet every 15 s and health every 60 s, and not while the tab is hidden',async()=>{
  const w=world(),h=boot(w);await flush();
  expect(h.timers.map(t=>t.ms).sort()).toEqual([15000,60000]);
  const count=(path:string)=>h.calls.filter(([p])=>p===path).length;
  const fleet0=count('/fleet'),health0=count('/health');
  await h.tick(15000);expect(count('/fleet')).toBe(fleet0+1);expect(count('/health')).toBe(health0);
  await h.tick(60000);expect(count('/health')).toBe(health0+1);
  h.document.hidden=true;await h.tick(15000);await h.tick(60000);
  expect(count('/fleet')).toBe(fleet0+1);expect(count('/health')).toBe(health0+1);
  h.document.hidden=false;h.emitDocument('visibilitychange');await flush();
  expect(count('/fleet')).toBe(fleet0+2);
 });
 it('never fabricates green without a backend: all unknown, FORGE not connected, no requests',async()=>{
  const w=world({session:unconfigured()}),h=boot(w);await flush();
  expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);
  expect(h.forgeText()).toBe('FORGE · Not connected');
  expect(h.calls).toEqual([]);
  expect(h.nodeButton('forge').title).toContain('unknown');
 });
 it('shows the same honest state while signed out and while approval is pending',async()=>{
  for(const s of [anonymous(),session({user:{uid:'u',status:'pending'}})]){
   const w=world({session:s}),h=boot(w);await flush();
   expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);expect(h.forgeText()).toBe('FORGE · Not connected');expect(h.calls).toEqual([]);
  }
 });
 it('treats an unreachable session as not connected without a request storm',async()=>{
  const w=world({sessionError:true}),h=boot(w);await flush();await h.tick(15000);await h.tick(60000);
  expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);expect(h.forgeText()).toBe('FORGE · Not connected');
  expect(h.calls).toEqual([]);
 });
 it('gates /fleet to the owner: a member sees unknown with the reason and still gets the FORGE line',async()=>{
  const w=world({session:member()}),h=boot(w);await flush();await h.tick(15000);
  expect(h.calls.some(([p])=>p==='/fleet')).toBe(false);
  expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);
  expect(h.forgeText()).toBe('FORGE · Model loaded');
  await h.nodeButton('forge').fire('click');
  expect(text(h.created.find(n=>n.tagName==='DIALOG')!)).toContain('primary owner only');
 });
 it('marks nodes unknown, not disconnected, when the fleet request itself fails',async()=>{
  const w=world();w.handlers['/fleet']=()=>{throw new Error('Primary owner admission required.');};const h=boot(w);await flush();
  expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);
  await h.nodeButton('quench').fire('click');
  expect(text(h.created.find(n=>n.tagName==='DIALOG')!)).toContain('Fleet status is unavailable: Primary owner admission required.');
 });
 it('opens an evidence view with readable fields and renders probe text as inert text',async()=>{
  const w=world(),h=boot(w);await flush();
  await h.nodeButton('forge').fire('click');
  const dialog=h.created.find(n=>n.tagName==='DIALOG')!,body=text(dialog);
  expect(dialog.open).toBe(true);
  for(const expected of ['FORGE','Connected','Live SDK node probe','41 ms','gate','<b>load ok</b>'])expect(body).toContain(expected);
  expect(h.created.some(n=>n.tagName==='B')).toBe(false);
  await h.nodeButton('anvil').fire('click');expect(text(dialog)).toContain('probe timed out');expect(text(dialog)).toContain('Disconnected');
 });
 it('resets to unknown on an account change, closes evidence and discards a late old-account response',async()=>{
  const slow=deferred(),w=world(),h=boot(w);await flush();
  await h.nodeButton('forge').fire('click');const dialog=h.created.find(n=>n.tagName==='DIALOG')!;expect(dialog.open).toBe(true);
  w.handlers['/fleet']=()=>slow.promise;w.handlers['/health']=()=>new Promise(()=>{});
  const pending=h.tick(15000);await flush();
  w.session=member();h.emit('echo-account-changed');
  expect(dialog.open).toBe(false);expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);
  slow.resolve(fleetResponse());await pending;await flush();
  expect(Object.values(h.leds()).every(v=>v==='unknown')).toBe(true);
 });
 it('does not restart polling when the transport reports an unchanged identity',async()=>{
  const w=world(),h=boot(w);await flush();const before=h.calls.length;
  for(let i=0;i<5;i++)w.onIdentity?.(session());
  await flush();expect(h.calls.length).toBe(before);
  w.session=member();w.onIdentity?.(member());await flush();
  expect(h.calls.length).toBeGreaterThan(before);expect(h.calls.filter(([p])=>p==='/fleet').length).toBe(1);
 });
});

describe('Logs & debugging and Journal & ECF receipts',()=>{
 const diagnostics=()=>({mission:{configured:true,ready:true,role:'builder',run_id:'run-1',error:null},
  sync:{verified:3,remaining:2,pending:1,retry:1,last_issue:'ECF scope missing'},
  operations:[{operation:'chat',status:'returned',observed_at_utc:'2026-11-04T01:02:03+00:00',duration_ms:120.4,http_status:200,capability:'echo.chat'},{operation:'ecf_sync',status:'blocked',observed_at_utc:'2026-11-04T01:05:00+00:00',error_category:'PermissionError'}],busy_chats:['c1']});
 const logsWorld=(over:any={})=>{const w=world(over);w.handlers['/diagnostics']=diagnostics;return w;};

 it('maps the sidebar label like the reference Workspace',async()=>{
  const logs=boot(logsWorld(),{logs:true}).window.EchoPrimeLogs;
  expect(logs.syncLabel({mode:'private_local',remaining:0})).toBe('Private journal & memories');
  expect(logs.syncLabel({verified:2,remaining:5})).toBe('Journal saved · 5 awaiting ECF');
  expect(logs.syncLabel({verified:2,remaining:0})).toBe('Journal & ECF receipts');
  for(const value of [null,undefined,'x',{remaining:-1},{remaining:'3'}])expect(logs.syncLabel(value)).toBe('Journal & ECF receipts');
  expect(logs.operationTone('blocked')).toBe('bad');expect(logs.operationTone('returned')).toBe('good');expect(logs.operationTone('???')).toBe('neutral');
 });
 it('hides both entries when not connected or signed out, and Logs from a member',async()=>{
  for(const s of [unconfigured(),anonymous()]){
   const h=boot(logsWorld({session:s}),{logs:true});await flush();
   expect(h.byId('journal-status').hidden).toBe(true);expect(h.byId('logs-open').hidden).toBe(true);
  }
  const h=boot(logsWorld({session:member()}),{logs:true});await flush();
  expect(h.byId('journal-status').hidden).toBe(false);expect(h.byId('logs-open').hidden).toBe(true);
  await h.byId('logs-open').fire('click');
  expect(h.calls.some(([p])=>p==='/diagnostics')).toBe(false);
 });
 it('auto-loads diagnostics on open and renders readable cards, newest operation first',async()=>{
  const w=logsWorld(),h=boot(w,{logs:true});await flush();
  expect(h.byId('logs-open').hidden).toBe(false);
  await h.byId('logs-open').fire('click');await flush();
  const dialog=h.byId('logs-dialog');
  expect(dialog.open).toBe(true);expect(h.calls.filter(([p])=>p==='/diagnostics')).toHaveLength(1);
  const body=text(dialog);
  for(const expected of ['Logs & debugging','Mission & memory sync','Run','run-1','Recent operations','2026-11-04 01:02:03 UTC','HTTP 200','120 ms','echo.chat','PermissionError','1 conversation is generating now.','ECF scope missing'])expect(body).toContain(expected);
  expect(body).not.toContain('{');
  expect(body.indexOf('ecf_sync')).toBeLessThan(body.indexOf('chat'));
  const cards=all(dialog).filter(n=>n.className.includes('logs-operation ')||n.className.endsWith('logs-operation'));
  expect(cards.map(c=>c.className.split(' ').pop())).toEqual(['bad','good']);
  await h.find(dialog,'Refresh').fire('click');await flush();
  expect(h.calls.filter(([p])=>p==='/diagnostics')).toHaveLength(2);
 });
 it('shows honest empty and error states',async()=>{
  const w=logsWorld();w.handlers['/diagnostics']=()=>({mission:{configured:false},sync:{mode:'private_local'},operations:[]});
  const h=boot(w,{logs:true});await flush();
  await h.byId('logs-open').fire('click');await flush();
  const dialog=h.byId('logs-dialog');
  expect(text(dialog)).toContain('No operations have been recorded yet.');expect(text(dialog)).toContain('Mission linked');
  w.handlers['/diagnostics']=()=>{throw new Error('Primary owner admission required.');};
  await h.find(dialog,'Refresh').fire('click');await flush();
  expect(text(dialog)).toContain('Diagnostics unavailable');expect(text(dialog)).toContain('Primary owner admission required.');expect(text(dialog)).toContain('No automatic retry was made.');
  expect(text(dialog)).not.toContain('No operations have been recorded yet.');
 });
 it('discards a late diagnostics response after the account changes and clears the page',async()=>{
  const slow=deferred(),w=logsWorld();const h=boot(w,{logs:true});await flush();
  w.handlers['/diagnostics']=()=>slow.promise;
  await h.byId('logs-open').fire('click');await flush();
  const dialog=h.byId('logs-dialog');
  w.session=member();h.emit('echo-account-changed');
  slow.resolve(diagnostics());await flush();
  expect(dialog.open).toBe(false);expect(text(dialog)).not.toContain('Recent operations');
 });
 it('shows delivery counts to the owner and retries by posting /sync then reading health back',async()=>{
  const w=logsWorld();let health:any={model:{loaded:true},sync:{verified:4,remaining:2,pending:1,retry:1,last_issue:'ECF scope missing'}};
  w.handlers['/health']=()=>health;w.handlers['/sync']=()=>{health={model:{loaded:true},sync:{verified:6,remaining:0}};return {verified:6,remaining:0};};
  const h=boot(w,{logs:true});await flush();
  expect(h.byId('journal-status').textContent).toBe('Journal saved · 2 awaiting ECF');
  await h.byId('journal-status').fire('click');await flush();
  const dialog=h.byId('sync-dialog'),body=text(dialog);
  expect(dialog.open).toBe(true);
  for(const expected of ['Journal & ECF delivery','4 records have exact ECF readback; 2 are awaiting confirmation.','Verified with exact ECF readback','Pending','Retry','Latest issue','ECF scope missing'])expect(body).toContain(expected);
  const before=h.calls.length;
  await h.find(dialog,'Retry pending records').fire('click');await flush();
  const after=h.calls.slice(before).map(([p,b])=>p+(p==='/sync'?JSON.stringify(b):''));
  expect(after[0]).toBe('/sync{}');expect(after).toContain('/health');
  expect(text(dialog)).toContain('6 records have exact ECF readback; 0 are awaiting confirmation.');
  expect(text(dialog)).toContain('read back from the Workspace');
  expect(h.byId('journal-status').textContent).toBe('Journal & ECF receipts');
 });
 it('reports a failed retry without claiming delivery and does not auto-retry',async()=>{
  const w=logsWorld();w.handlers['/health']=()=>({model:{loaded:true},sync:{verified:1,remaining:3}});
  w.handlers['/sync']=()=>{throw new Error('ECF unavailable');};
  const h=boot(w,{logs:true});await flush();await h.byId('journal-status').fire('click');await flush();
  const dialog=h.byId('sync-dialog');
  await h.find(dialog,'Retry pending records').fire('click');await flush();
  expect(text(dialog)).toContain('Delivery check failed: ECF unavailable No automatic retry was made.');
  expect(text(dialog)).toContain('3 are awaiting confirmation.');
  expect(h.calls.filter(([p])=>p==='/sync')).toHaveLength(1);
 });
 it('gives a member only the private-memory explanation, with no retry and no /sync request',async()=>{
  const w=logsWorld({session:member()});w.handlers['/health']=()=>({model:{loaded:true},sync:{remaining:0,mode:'private_local'}});
  const h=boot(w,{logs:true});await flush();
  expect(h.byId('journal-status').textContent).toBe('Private journal & memories');
  await h.byId('journal-status').fire('click');await flush();
  const dialog=h.byId('sync-dialog');
  expect(text(dialog)).toContain('Your private memories');expect(text(dialog)).toContain('does not send or retrieve memories through the owner’s shared ECF');
  expect(all(dialog).some(n=>text(n).includes('Retry pending records'))).toBe(false);
  expect(h.calls.some(([p])=>p==='/sync')).toBe(false);
 });
 it('does not invent receipts when health reported no sync status',async()=>{
  const w=logsWorld();w.handlers['/health']=()=>({model:{loaded:true}});
  const h=boot(w,{logs:true});await flush();await h.byId('journal-status').fire('click');await flush();
  expect(text(h.byId('sync-dialog'))).toContain('has not been read from the Workspace yet');
  expect(h.byId('journal-status').textContent).toBe('Journal & ECF receipts');
 });
});

describe('static delivery',()=>{
 it('serves the new scripts and stylesheet and no longer ships the hardcoded scene nodes',async()=>{
  const server=await startPrimeServer(new PrimeHub({capabilities:[]}),fileURLToPath(new URL('../ui/echo-prime/',import.meta.url)),0);
  try{
   for(const [path,type] of [['/fleet.js','javascript'],['/logs.js','javascript'],['/fleet.css','css']]){
    const response=await fetch(server.url+path);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain(type);
   }
   const page=await (await fetch(server.url+'/')).text();
   expect(page).toContain('fleet.js');expect(page).toContain('logs.js');expect(page).toContain('fleet.css');
   for(const name of ['node-forge','node-swarm','node-memory','node-creative','node-ecf','node-agents'])expect(page).not.toContain(name);
   expect(page).toContain('id="echo-orb"');expect(page).toContain('id="open-steward"');
  }finally{await server.close();}
 });
});
