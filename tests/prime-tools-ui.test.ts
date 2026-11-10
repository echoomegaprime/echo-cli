/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM and bridge stand-ins mirror prime-views-ui.test.ts */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// The shipped plugins.js runs unchanged against a small DOM stand-in. This proves the "Live tools · always on" card:
// the report is read from Prime's owner-only route, families render with their tools' live state, a toggle POSTs the
// exact `{family, enabled}` body and re-paints, members get the static note, and nothing is fetched while anonymous.
const camel=(key:string)=>key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
class Node {
 tagName:string;_text='';className='';hidden=false;disabled=false;checked=false;open=false;value='';isConnected=true;
 dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;events:Record<string,((event:any)=>unknown)[]>={};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 get textContent():string{return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(value:string){this._text=String(value);this.children=[];}
 append(...items:Node[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:Node[]){this.children=[];this._text='';this.append(...items);}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key.startsWith('data-'))this.dataset[camel(key.slice(5))]=value;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string){for(const fn of this.events[name]||[])await fn({preventDefault(){},target:this});}
 showModal(){this.open=true;} close(){if(!this.open)return;this.open=false;void this.fire('close');}
}
const walk=(root:Node):Node[]=>root.children.flatMap(c=>[c,...walk(c)]);
const source=readFileSync(new URL('../ui/echo-prime/plugins.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
const report=(over:Record<string,unknown>={})=>({configured:true,enabled:true,budget:{calls:12,wallMs:60000,resultChars:6000},cache:{entries:3},memberFamilies:['web','wolfram','knowledge'],
 families:[{id:'web',enabled:true,tools:[{name:'web_search',available:true},{name:'web_fetch',available:true}]},{id:'wolfram',enabled:true,tools:[{name:'wolfram',available:false,reason:'SDK gate not attached'}]},{id:'skills',enabled:true,tools:[{name:'skills',available:false,reason:'No skill roots configured (tools.skills.roots)'}]}],note:'',...over});
async function world(session:any,fetch:ReturnType<typeof vi.fn>){
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},body=new Node('body');
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node('button'));return nodes.get(selector)!;};
 const bridge:any={session,state:{accountEpoch:0,data:{preferences:[],sync:null}},api:vi.fn(async(path:string)=>path==='/mcp'?{connections:[]}:{}),refresh:vi.fn(async()=>{})};
 const window:any={addEventListener:(name:string,fn:(e:any)=>unknown)=>(events[name]??=[]).push(fn),EchoPrimeWorkspace:{ready:Promise.resolve(true),enabled:true,bridge,ownerHeaders:vi.fn(async()=>({'x-echo-csrf':'csrf-fixture'}))}};
 const document:any={body,querySelector:get,createElement:(tag:string)=>new Node(tag),createTextNode:(text:string)=>Object.assign(new Node('#text'),{_text:text})};
 runInNewContext(source,{window,document,fetch,setTimeout,clearTimeout,console:{debug(){}}});
 await tick();
 await window.EchoPrimePlugins.open();await tick();
 const dialog=body.children.find(n=>n.tagName==='DIALOG')!;
 return {window,dialog,all:()=>walk(dialog),fetch};
}
const owner={authenticated:true,ownerAccess:true,user:{uid:'owner',status:'approved'}};
describe('Plugins & memory · Live tools card',()=>{
 it('toolRows and budgetText describe the report honestly',()=>{
  const window:any={addEventListener(){}};
  runInNewContext(source,{window,document:{querySelector:()=>null,createElement:()=>new Node(),body:new Node('body')},setTimeout,clearTimeout,console:{debug(){}}});
  const rows=window.EchoPrimePlugins.toolRows(report());
  expect(rows.map((r:any)=>r.id)).toEqual(['web','wolfram','skills']);
  expect(rows[0].label).toContain('Live internet');expect(rows[0].tools.map((t:any)=>t.detail)).toEqual(['Live','Live']);
  expect(rows[1].tools[0]).toMatchObject({name:'wolfram',available:false,detail:'SDK gate not attached'});
  expect(window.EchoPrimePlugins.budgetText(report())).toBe('12 calls or 60 s per turn · results compacted to 6000 characters · 3 cached results');
  expect(window.EchoPrimePlugins.budgetText(null)).toBe('Budget not reported.');
  expect(window.EchoPrimePlugins.toolRows({families:'nope'})).toEqual([]);
 });
 it('renders the owner card from /api/prime/tools and POSTs an exact family toggle',async()=>{
  const fetch=vi.fn(async(_path:string,init:any)=>({ok:true,json:async()=>init?.method==='POST'?report({families:[{id:'web',enabled:false,tools:[]}]}):report()}));
  const w=await world(owner,fetch);
  const card=w.all().find(n=>n.tagName==='ARTICLE'&&n.children[0]?.textContent==='Live tools · always on')!;
  expect(card).toBeDefined();
  expect(fetch.mock.calls[0][0]).toBe('/api/prime/tools');
  expect(fetch.mock.calls[0][1]).toMatchObject({method:'GET',credentials:'same-origin',headers:{'x-prime-request':'1','x-echo-csrf':'csrf-fixture'}});
  const text=card.textContent;
  expect(text).toContain('12 calls or 60 s per turn');expect(text).toContain('web_search');expect(text).toContain('SDK gate not attached');expect(text).toContain('No skill roots configured');
  const boxes=walk(card).filter(n=>n.tagName==='INPUT'&&n.attributes.type==='checkbox');
  expect(boxes.length).toBe(4);// all tools + three families
  boxes[1].checked=false;await boxes[1].fire('change');await tick();
  const post=fetch.mock.calls.find(c=>c[1]?.method==='POST')!;
  expect(post[0]).toBe('/api/prime/tools');expect(JSON.parse(post[1].body)).toEqual({family:'web',enabled:false});
  // Re-painted from the POST reply: web now reads Disabled and the other families (with their reasons) are gone.
  expect(card.textContent).toContain('Disabled');expect(card.textContent).not.toContain('SDK gate not attached');
 });
 it('shows the unconfigured reason and never invents a toggle',async()=>{
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({configured:false,enabled:false,families:[],reason:'Live tools are off: the reviewed Prime configuration has tools.enabled=false or no model router'})}));
  const w=await world(owner,fetch);
  const card=w.all().find(n=>n.tagName==='ARTICLE'&&n.children[0]?.textContent==='Live tools · always on')!;
  expect(card.textContent).toContain('tools.enabled=false');
  expect(walk(card).filter(n=>n.tagName==='INPUT').length).toBe(0);
 });
 it('gives a member the static note without reading the owner-only route',async()=>{
  const fetch=vi.fn();
  const w=await world({authenticated:true,ownerAccess:false,user:{uid:'member',status:'approved'}},fetch);
  const card=w.all().find(n=>n.tagName==='ARTICLE'&&n.children[0]?.textContent==='Live tools · always on')!;
  expect(card.textContent).toContain('Agent Skills and MCP plugins are owner-only');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('reports a failed status read in the card instead of retrying',async()=>{
  const fetch=vi.fn(async()=>({ok:false,json:async()=>({error:'Primary owner admission required'})}));
  const w=await world(owner,fetch);
  const card=w.all().find(n=>n.tagName==='ARTICLE'&&n.children[0]?.textContent==='Live tools · always on')!;
  expect(card.textContent).toContain('Primary owner admission required');
  expect(fetch).toHaveBeenCalledTimes(1);
 });
});
