import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Run the shipped UI unchanged. These controlled owner responses test UI
// behavior and uncertainty handling; they do not claim a live ECF capture.
const source=readFileSync(new URL('../ui/echo-prime/bot-workspace.js',import.meta.url),'utf8');
const BOT='a'.repeat(32),CAPTURE='b'.repeat(32),KEY='note-test-1';
type Handler=()=>unknown;
class Node {
 tagName:string;textContent='';className='';value='';disabled=false;dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];events:Record<string,Handler[]>={};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...nodes:Node[]){this.children.push(...nodes);}
 replaceChildren(...nodes:Node[]){this.children=nodes;}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 addEventListener(name:string,fn:Handler){(this.events[name]??=[]).push(fn);}
 querySelectorAll(selector:string):Node[]{return all(this).filter(node=>selector==='button'&&node.tagName==='BUTTON');}
 async fire(name:string){if(name==='click'&&this.disabled)return;for(const fn of this.events[name]??[])await fn();}
}
const all=(root:Node):Node[]=>root.children.flatMap(node=>[node,...all(node)]);
const text=(root:Node):string=>[root.textContent,...root.children.map(text)].join(' ');
const receipt=(verified=false)=>({bot_id:BOT,capture_id:CAPTURE,request_ref:KEY,title:'Review note',state:verified?'verified':'uncertain',saved:verified,verified,reason:null,untrusted:true,shared_remote_ledger:true});
async function boot(options:{configured?:boolean;permitted?:boolean;lostResponse?:boolean;captureError?:Record<string,unknown>;existing?:Record<string,unknown>[]}={}){
 const root=new Node(),calls:{operation:string;params:Record<string,unknown>}[]=[];
 let captures=options.existing??[];
 const api=vi.fn(async(operation:string,params:Record<string,unknown>)=>{
  calls.push({operation,params});
  if(operation==='workspace/browser.status')return {available:false,reason:'Not needed for this test'};
  if(operation==='workspace/continuity.status')return {bot_id:BOT,configured:options.configured!==false,lease_permits_capture:options.permitted!==false,remote_authorization_verified:false,captures,shared_remote_ledger:true,untrusted:true};
  if(operation==='workspace/continuity.capture'){
   if(options.captureError)throw Object.assign(new Error('Capture refused'),options.captureError);
   captures=[receipt()];
   if(options.lostResponse)throw new Error('Response interrupted; outcome unknown');
   return captures[0];
  }
  if(operation==='workspace/continuity.reconcile'){captures=[receipt(true)];return captures[0];}
  throw new Error('Unexpected operation '+operation);
 });
 const win:{crypto:{randomUUID:()=>string};EchoPrimeBotWorkspace?:{mount:(root:Node,options:unknown)=>{destroy:()=>void}}}={crypto:{randomUUID:()=>KEY}};
 runInNewContext(source,{window:win,document:{createElement:(tag:string)=>new Node(tag)},AbortController,URL,Blob,setTimeout,clearTimeout});
 const mounted=win.EchoPrimeBotWorkspace!.mount(root,{bot:{bot_id:BOT,name:'Review bot'},api,refresh:async()=>undefined});
 const find=(label:string)=>all(root).find(node=>node.tagName==='BUTTON'&&node.textContent===label)!;
 await vi.waitFor(()=>expect(find('Continuity')).toBeDefined());
 await find('Continuity').fire('click');
 const field=(label:string)=>all(root).find(node=>node.attributes['aria-label']===label)!;
 return {root,calls,find,field,mounted,fill:async()=>{field('Capture title').value='Review note';await field('Capture title').fire('input');field('Continuity note').value='Explicit note only';await field('Continuity note').fire('input');}};
}

describe('per-bot continuity controls',()=>{
 it.each([{configured:false},{permitted:false}])('keeps capture disabled without configuration or lease permission: %j',async options=>{
  const ui=await boot(options);await ui.fill();expect(ui.find('Capture note').disabled).toBe(true);await ui.find('Capture note').fire('click');
  expect(ui.calls.every(call=>!call.operation.endsWith('.capture'))).toBe(true);expect(text(ui.root)).not.toContain('Saved and verified');ui.mounted.destroy();
 });
 it('preserves the original request identity after an unconfirmed response and only reconciles the acknowledged capture',async()=>{
  const ui=await boot({lostResponse:true});await ui.fill();await ui.find('Capture note').fire('click');
  expect(ui.calls.filter(call=>call.operation==='workspace/continuity.capture')).toEqual([{operation:'workspace/continuity.capture',params:{bot_id:BOT,request_ref:KEY,title:'Review note',detail:'Explicit note only'}}]);
  expect(ui.find('Capture note').disabled).toBe(true);expect(text(ui.root)).toContain('outcome unknown');
  await ui.find('Capture note').fire('click');await ui.find('Refresh').fire('click');
  expect(ui.field('Continuity note').value).toBe('Explicit note only');expect(ui.find('Capture note').disabled).toBe(true);
  expect(text(ui.root)).toContain('Outcome unconfirmed');expect(text(ui.root)).not.toContain('Saved and verified');
  await ui.find('Reconcile capture').fire('click');
  expect(ui.calls.filter(call=>call.operation==='workspace/continuity.reconcile')).toEqual([{operation:'workspace/continuity.reconcile',params:{bot_id:BOT,capture_id:CAPTURE}}]);
  expect(ui.calls.filter(call=>call.operation==='workspace/continuity.capture')).toHaveLength(1);expect(text(ui.root)).toContain('Saved and verified');
  await ui.find('Start a separate note').fire('click');expect(ui.field('Continuity note').value).toBe('');expect(ui.find('Capture note').disabled).toBe(false);ui.mounted.destroy();
 });
 it('does not equate an acknowledged uncertain capture or local configuration with verified persistence',async()=>{
  const ui=await boot();await ui.fill();await ui.find('Capture note').fire('click');
  expect(text(ui.root)).toContain('Each capture still requires service authorization and verification');expect(text(ui.root)).toContain('Outcome unconfirmed');expect(text(ui.root)).not.toContain('Saved and verified');
  await ui.find('Memory').fire('click');await ui.find('Continuity').fire('click');
  expect(ui.find('Capture note').disabled).toBe(true);expect(ui.calls.filter(call=>call.operation==='workspace/continuity.capture')).toHaveLength(1);ui.mounted.destroy();
 });
 it.each([
  {source:'bot_service',status:400,code:'invalid',outcomeUnknown:false,editable:true},
  {source:'bot_service',status:400,code:'invalid',outcomeUnknown:true,editable:false},
  {source:'bot_service',status:400,code:'invalid',editable:false},
  {status:400,code:'invalid',outcomeUnknown:false,editable:false},
 ])('allows an explicit edit only after confirmed pre-dispatch validation refusal: %j',async({editable,...captureError})=>{
  const ui=await boot({captureError});await ui.fill();await ui.find('Capture note').fire('click');
  expect(ui.find('Capture note').disabled).toBe(!editable);expect(ui.field('Continuity note').disabled).toBe(!editable);
  expect(ui.field('Continuity note').value).toBe('Explicit note only');expect(ui.calls.filter(call=>call.operation==='workspace/continuity.capture')).toHaveLength(1);ui.mounted.destroy();
 });
 it('renders untrusted capture titles as text and never offers another bot’s receipt for reconciliation',async()=>{
  const title='<img src=x onerror=alert(1)>',ui=await boot({existing:[{...receipt(),title},{...receipt(),capture_id:'c'.repeat(32),bot_id:'d'.repeat(32),title:'Another bot'}]});
  expect(all(ui.root).some(node=>node.tagName==='H4'&&node.textContent===title)).toBe(true);expect(all(ui.root).some(node=>node.tagName==='IMG')).toBe(false);
  expect(text(ui.root)).not.toContain('Another bot');expect(all(ui.root).filter(node=>node.tagName==='BUTTON'&&node.textContent==='Reconcile capture')).toHaveLength(1);ui.mounted.destroy();
 });
});
