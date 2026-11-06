/* eslint-disable @typescript-eslint/no-explicit-any -- the DOM harness deliberately models untyped browser values */
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';

// nav.js runs unchanged against a small but structural DOM: real reparenting, attribute <-> dataset <-> hidden
// reflection, a selector matcher for the shapes nav.js uses, focus tracking and a capturing `close` event. The
// sidebar fixture mirrors index.html's sidebar; a separate test pins the hooks index.html must keep.
const kebab=(key:string)=>key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());
const camel=(key:string)=>key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
class FakeNode {
 nodeType=1;tagName:string;parentNode:FakeNode|null=null;childNodes:FakeNode[]=[];attrs=new Map<string,string>();
 events:Record<string,((event:any)=>unknown)[]>={};textValue='';clickCount=0;doc:any=null;
 dataset:Record<string,string>;classList:{add:(...n:string[])=>void;remove:(...n:string[])=>void;toggle:(n:string,force?:boolean)=>boolean;contains:(n:string)=>boolean};
 constructor(tag:string,doc:any){
  this.tagName=tag.toUpperCase();this.doc=doc;
  const attrs=this.attrs;
  this.dataset=new Proxy({},{get:(_t,key:string)=>attrs.get('data-'+kebab(key)),set:(_t,key:string,value)=>{attrs.set('data-'+kebab(key),String(value));return true;},has:(_t,key:string)=>attrs.has('data-'+kebab(key)),ownKeys:()=>[...attrs.keys()].filter(k=>k.startsWith('data-')).map(k=>camel(k.slice(5))),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
  const self=this;
  this.classList={add:(...names)=>{const set=new Set(self.classes());names.forEach(n=>set.add(n));self.className=[...set].join(' ');},remove:(...names)=>{self.className=self.classes().filter(c=>!names.includes(c)).join(' ');},toggle:(name,force)=>{const on=force===undefined?!self.classes().includes(name):force;if(on)self.classList.add(name);else self.classList.remove(name);return on;},contains:name=>self.classes().includes(name)};
 }
 classes(){return this.className.split(/\s+/).filter(Boolean);}
 get children(){return this.childNodes.filter(n=>n.nodeType===1);}
 get firstChild(){return this.childNodes[0]??null;}
 get id(){return this.attrs.get('id')??'';} set id(value:string){this.attrs.set('id',value);}
 get className(){return this.attrs.get('class')??'';} set className(value:string){this.attrs.set('class',value);}
 get hidden(){return this.attrs.has('hidden');} set hidden(value:boolean){if(value)this.attrs.set('hidden','');else this.attrs.delete('hidden');}
 get open(){return this.attrs.has('open');} set open(value:boolean){if(value)this.attrs.set('open','');else this.attrs.delete('open');}
 get textContent():string{return this.nodeType===3?this.textValue:this.childNodes.map(n=>n.textContent).join('');}
 set textContent(value:string){if(this.nodeType===3){this.textValue=value;return;}this.replaceChildren(this.doc.createTextNode(value));}
 get isConnected():boolean{let cursor:FakeNode|null=this;while(cursor){if(cursor===this.doc.body||cursor===this.doc.head||cursor===this.doc.documentElement)return true;cursor=cursor.parentNode;}return false;}
 getAttribute(name:string){return this.attrs.has(name)?this.attrs.get(name)!:null;}
 setAttribute(name:string,value:string){this.attrs.set(name,String(value));}
 hasAttribute(name:string){return this.attrs.has(name);}
 removeAttribute(name:string){this.attrs.delete(name);}
 remove(){if(!this.parentNode)return;const list=this.parentNode.childNodes,index=list.indexOf(this);if(index>=0)list.splice(index,1);this.parentNode=null;}
 insertBefore(node:FakeNode,ref:FakeNode|null){node.remove();node.parentNode=this;const index=ref?this.childNodes.indexOf(ref):-1;if(index<0)this.childNodes.push(node);else this.childNodes.splice(index,0,node);return node;}
 append(...nodes:FakeNode[]){for(const node of nodes)this.insertBefore(node,null);}
 prepend(...nodes:FakeNode[]){let ref=this.firstChild;for(const node of nodes){this.insertBefore(node,ref);ref=node.childNodes?this.childNodes[this.childNodes.indexOf(node)+1]??null:null;}}
 before(node:FakeNode){this.parentNode?.insertBefore(node,this);}
 after(node:FakeNode){const next=this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this)+1]??null;this.parentNode?.insertBefore(node,next);}
 replaceChildren(...nodes:FakeNode[]){for(const child of [...this.childNodes])child.remove();this.append(...nodes);}
 addEventListener(name:string,fn:(event:any)=>unknown){(this.events[name]??=[]).push(fn);}
 removeEventListener(name:string,fn:(event:any)=>unknown){this.events[name]=(this.events[name]||[]).filter(f=>f!==fn);}
 dispatch(name:string,event:any={}){const payload={type:name,target:this,preventDefault:vi.fn(),...event};for(const fn of this.doc.captures[name]||[])fn(payload);let cursor:FakeNode|null=this;while(cursor){for(const fn of cursor.events[name]||[])fn(payload);cursor=cursor.parentNode;}return payload;}
 click(){this.clickCount++;this.dispatch('click');}
 focus(){this.doc.activeElement=this;}
 showModal(){this.open=true;} close(){this.open=false;this.dispatch('close');}
 getBoundingClientRect(){return {left:0,top:0,right:100,bottom:30,width:100,height:30};}
 descendants():FakeNode[]{return this.children.flatMap(child=>[child,...child.descendants()]);}
 matches(selector:string){return selector.split(',').some(part=>matchSelector(this,part.trim()));}
 querySelectorAll(selector:string){return this.descendants().filter(node=>node.matches(selector));}
 querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
}
function matchCompound(node:FakeNode,compound:string){
 const re=/([#.]?[\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g;let m:RegExpExecArray|null;let any=false;
 while((m=re.exec(compound))){any=true;
  if(m[2]){const value=m[3]??m[4];if(!node.attrs.has(m[2]))return false;if(value!==undefined&&node.attrs.get(m[2])!==value)return false;continue;}
  const token=m[1];if(token.startsWith('#')){if(node.id!==token.slice(1))return false;}else if(token.startsWith('.')){if(!node.classes().includes(token.slice(1)))return false;}else if(node.tagName!==token.toUpperCase())return false;
 }
 return any;
}
function matchSelector(node:FakeNode,selector:string):boolean{
 const parts=selector.split(/\s*>\s*|\s+/).filter(Boolean),combinators=[...selector.matchAll(/\s*>\s*|\s+/g)].map(m=>m[0].includes('>')?'>':' ');
 if(!matchCompound(node,parts[parts.length-1]))return false;
 let cursor:FakeNode|null=node.parentNode;
 for(let i=parts.length-2;i>=0;i--){
  if(combinators[i]==='>'){if(!cursor||!matchCompound(cursor,parts[i]))return false;cursor=cursor.parentNode;continue;}
  while(cursor&&!matchCompound(cursor,parts[i]))cursor=cursor.parentNode;if(!cursor)return false;cursor=cursor.parentNode;
 }
 return true;
}
function makeDocument(){
 const doc:any={captures:{} as Record<string,((event:any)=>unknown)[]>,activeElement:null as FakeNode|null,listeners:{} as Record<string,((event:any)=>unknown)[]>};
 doc.createElement=(tag:string)=>new FakeNode(tag,doc);
 doc.createElementNS=(_ns:string,tag:string)=>new FakeNode(tag,doc);
 doc.createTextNode=(text:string)=>{const node=new FakeNode('#text',doc);node.nodeType=3;node.textValue=String(text);return node;};
 doc.documentElement=doc.createElement('html');doc.head=doc.createElement('head');doc.body=doc.createElement('body');doc.documentElement.append(doc.head,doc.body);
 doc.querySelectorAll=(selector:string)=>doc.documentElement.descendants().filter((node:FakeNode)=>node.matches(selector));
 doc.querySelector=(selector:string)=>doc.querySelectorAll(selector)[0]??null;
 doc.getElementById=(id:string)=>doc.querySelector('[id="'+id+'"]');
 doc.addEventListener=(name:string,fn:(event:any)=>unknown,capture?:boolean)=>((capture?doc.captures:doc.listeners)[name]??=[]).push(fn);
 return doc;
}
type Spec=[string,Record<string,string>?,...(Spec|string|FakeNode)[]];
function build(doc:any,spec:Spec):FakeNode{
 const [tag,attrs={},...children]=spec;const node=doc.createElement(tag);
 for(const [key,value] of Object.entries(attrs)){if(key==='hidden')node.hidden=true;else node.setAttribute(key,value);}
 for(const child of children){if(typeof child==='string')node.append(doc.createTextNode(child));else if(child instanceof FakeNode)node.append(child);else node.append(build(doc,child));}
 return node;
}
const svg=(name:string):Spec=>['svg',{},['use',{href:'#'+name}]];
function sidebarSpec(extra:{inboxExtra?:Spec[];loose?:Spec[]}={}):Spec{
 return ['aside',{class:'sidebar',id:'sidebar'},
  ['a',{class:'brand',href:'#'},svg('i-echo-mark'),['span',{class:'wordmark'},['span',{class:'wordmark-text','data-text':'ECHO PRIME'},'ECHO PRIME'],['small',{},'FORGE WORKSPACE']]],
  ['button',{class:'new-chat',id:'new-chat'},'New conversation'],
  ['nav',{id:'prime-nav','aria-label':'Workspace'},
   ['button',{class:'nav-item active','data-view':'conversation'},svg('i-chat'),'Conversation',['span',{class:'active-dot'}]],
   ['button',{class:'nav-item','data-view':'studio'},svg('i-spark'),'Creative studio'],
   ['button',{class:'nav-item','data-view':'systems'},svg('i-chip'),'Echo systems',['span',{class:'nav-count'},'12']]],
  ['button',{class:'nav-item',id:'open-steward'},svg('i-shield'),'Node Steward'],
  ['button',{class:'nav-item',id:'workspace-open-esh','data-owner-only':'',hidden:''},svg('i-code'),'ESH shell'],
  ['div',{id:'workspace-navigation',hidden:''},
   ['button',{class:'nav-item','data-workspace-view':'projects'},'Projects'],['button',{class:'nav-item','data-workspace-view':'library'},'Library'],['button',{class:'nav-item',id:'workspace-open-plugins'},'Plugins & memory'],
   ['button',{class:'nav-item','data-workspace-view':'operations','data-owner-only':''},'SDK'],['button',{class:'nav-item','data-workspace-view':'operations','data-owner-only':''},'Vault'],['button',{class:'nav-item','data-workspace-view':'library'},'Code review'],
   ['button',{class:'nav-item','data-view':'logs','data-owner-only':''},'Logs & debugging'],['button',{class:'nav-item','data-workspace-view':'voice'},'Voice & personality'],...(extra.inboxExtra||[])],
  ['button',{class:'nav-item','data-workspace-view':'account',id:'workspace-account'},'Account'],
  ['button',{class:'nav-item',id:'open-appearance','data-open':'appearance'},'Appearance'],
  ...(extra.loose||[]),
  ['label',{class:'workspace-search',id:'workspace-search-label',hidden:''},'Find a conversation'],
  ['div',{class:'history-heading'},'YOUR SPACE'],['div',{id:'history',class:'history'}],
  ['div',{class:'sidebar-bottom'},['button',{class:'workspace-card','data-open':'systems'},'Forge'],['div',{class:'profile'},['span',{class:'avatar'},'BM'],['span',{},'Commander'],['button',{class:'icon-button','data-open':'appearance'}]]],
 ];
}
interface BootOptions {storage?:Record<string,string>|'throws';workspace?:any;inboxExtra?:Spec[];loose?:Spec[];beforeBoot?:(doc:any)=>void}
function boot(options:BootOptions={}){
 const doc=makeDocument();
 const sidebar=build(doc,sidebarSpec({inboxExtra:options.inboxExtra,loose:options.loose}));
 const scrim=build(doc,['button',{class:'mobile-scrim',id:'scrim'}]);
 const dialog=build(doc,['dialog',{id:'appearance-dialog'}]),workspaceDialog=build(doc,['dialog',{id:'workspace-dialog'}]);
 doc.body.append(scrim,sidebar,dialog,workspaceDialog);
 const stored=new Map<string,string>(Object.entries(options.storage&&options.storage!=='throws'?options.storage:{}));
 const localStorage=options.storage==='throws'?{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}}:{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>{stored.set(key,value);}};
 const events:Record<string,((event:any)=>unknown)[]>={};
 const window:any={localStorage,addEventListener:(name:string,fn:(event:any)=>unknown)=>(events[name]??=[]).push(fn),dispatchEvent:(event:any)=>{for(const fn of events[event.type]||[])fn(event);}};
 if(options.workspace!==undefined)window.EchoPrimeWorkspace=options.workspace;
 options.beforeBoot?.(doc);
 const context={window,document:doc,console,Promise,queueMicrotask,RegExp,TypeError,Number,String,Object,Array,JSON,Map,Set};
 runInNewContext(readFileSync(new URL('../ui/echo-prime/nav.js',import.meta.url),'utf8'),context);
 const nav=window.EchoPrimeNav;
 const byLabel=(label:string)=>doc.querySelectorAll('.nav-item').find((node:FakeNode)=>node.childNodes.some(c=>c.nodeType===3&&c.textContent.trim()===label))!;
 const group=(id:string)=>nav.groups().find((g:any)=>g.id===id);
 const section=(id:string)=>doc.querySelector('[data-group="'+id+'"]') as FakeNode;
 const toggle=(id:string)=>section(id).querySelector('.nav-group-toggle') as FakeNode;
 const list=(id:string)=>section(id).querySelector('.nav-group-items') as FakeNode;
 const groupOf=(node:FakeNode)=>{let cursor:FakeNode|null=node;while(cursor&&!cursor.attrs.has('data-group')&&!cursor.classes().includes('nav-bottom'))cursor=cursor.parentNode;return cursor?.attrs.get('data-group')??(cursor?'bottom':null);};
 const flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
 return {doc,window,nav,stored,sidebar,scrim,dialog,workspaceDialog,byLabel,group,section,toggle,list,groupOf,flush,inbox:doc.querySelector('#workspace-navigation') as FakeNode,primeNav:doc.querySelector('#prime-nav') as FakeNode,emit:(type:string)=>window.dispatchEvent({type})};
}
const hiddenMap=(doc:any)=>Object.fromEntries(doc.querySelectorAll('.nav-item').map((n:FakeNode)=>[n.id||n.textContent.trim(),n.hidden]));

describe('grouped sidebar from NAV_GROUPS',()=>{
 it('renders the five groups in declared order plus the bottom group, from one declarative list',()=>{
  const h=boot();
  expect(h.nav.mounted).toBe(true);
  expect(h.nav.NAV_GROUPS.map((g:any)=>g.label)).toEqual(['Talk','Create','Agents','Echo','Operate','Account']);
  expect(h.primeNav.children.filter(n=>n.classes().includes('nav-group')).map(n=>n.attrs.get('data-group'))).toEqual(['talk','create','agents','echo','operate']);
  expect(h.doc.querySelector('.sidebar-bottom').children[0].classes()).toContain('nav-bottom');
 });
 it('adopts every existing button into its declared group by hook, including label-disambiguated hooks',()=>{
  const h=boot();
  const expected:[string,string][]=[['Conversation','talk'],['Projects','talk'],['Library','talk'],['Creative studio','create'],['Code review','create'],['Echo systems','echo'],['Node Steward','echo'],['ESH shell','echo'],['Plugins & memory','echo'],['Voice & personality','echo'],['SDK','operate'],['Vault','operate'],['Account','bottom'],['Appearance','bottom']];
  for(const [label,groupId] of expected)expect(h.groupOf(h.byLabel(label)),label).toBe(groupId);
  expect(h.group('talk').items.map((i:any)=>i.id)).toEqual(['conversation','projects','library']);
  expect(h.group('echo').items.map((i:any)=>i.id)).toEqual(['systems','steward','esh','plugins','voice']);
  expect(h.inbox.children).toEqual([]);// the inbox container stays as the hidden-flag source, emptied of buttons
 });
 it('moves nodes instead of cloning: listeners, hooks and direct text nodes survive adoption',()=>{
  const clicks=vi.fn();
  const h=boot({beforeBoot:doc=>doc.querySelector('[data-view="conversation"]').addEventListener('click',clicks)});
  const conversation=h.byLabel('Conversation');
  expect(conversation.attrs.get('data-view')).toBe('conversation');expect(conversation.parentNode!.classes()).toContain('nav-slot');
  conversation.click();expect(clicks).toHaveBeenCalledTimes(1);
  // plugins.js relabels via a direct text node; the icon is prepended before it, never wrapped around it.
  expect(conversation.childNodes.filter(n=>n.nodeType===3).map(n=>n.textContent)).toEqual(['Conversation']);
  const sdk=h.byLabel('SDK');expect(sdk.attrs.get('data-workspace-view')).toBe('operations');expect(sdk.hasAttribute('data-owner-only')).toBe(true);
  expect(sdk.children[0].tagName).toBe('SVG');expect(sdk.children[0].children[0].attrs.get('href')).toBe('#i-sdk');
 });
 it('keeps both Logs buttons but shows only the stronger hook (#logs-open over data-view="logs")',()=>{
  const h=boot({inboxExtra:[['button',{class:'nav-item',id:'logs-open','data-owner-only':'true'},'Logs & debugging']]});
  const items=h.group('operate').items.filter((i:any)=>i.id==='logs');
  expect(items).toHaveLength(2);expect(items.filter((i:any)=>i.duplicate)).toHaveLength(1);
  expect(h.nav.item('logs').id).toBe('logs-open');
  const legacy=h.doc.querySelector('[data-view="logs"]');expect(legacy.parentNode.hidden).toBe(true);expect(legacy.parentNode.attrs.has('data-nav-duplicate')).toBe(true);
  expect(legacy.hidden).toBe(false);// the button's own hidden still belongs to workspace.js
 });
 it('exposes no fabricated buttons for declared items that are absent; their groups stay hidden until a module registers',()=>{
  const h=boot();
  expect(h.doc.querySelectorAll('.nav-item').map((n:FakeNode)=>n.textContent.trim())).not.toContain('echoBots');
  expect(h.section('agents').hidden).toBe(true);
  const clicks=vi.fn();
  const node=h.nav.register({id:'open-echobots',label:'echoBots',onClick:clicks});
  expect(h.section('agents').hidden).toBe(false);expect(h.groupOf(node)).toBe('agents');
  expect(node.id).toBe('open-echobots');expect(node.attrs.get('type')).toBe('button');expect(node.children[0].children[0].attrs.get('href')).toBe('#i-bot');
  node.click();expect(clicks).toHaveBeenCalledTimes(1);
  expect(h.nav.register({id:'open-echobots',label:'echoBots'})).toBe(node);
  expect(h.group('agents').items.filter((i:any)=>i.id==='echobots')).toHaveLength(1);
 });
});

describe('gating: two owners of visibility that never overlap',()=>{
 it('hides Workspace items through the slot while the inbox is hidden and never writes a button’s own hidden',()=>{
  const h=boot();
  const before=hiddenMap(h.doc);
  expect(h.group('talk').items.map((i:any)=>[i.id,i.hidden,i.workspace])).toEqual([['conversation',false,false],['projects',true,true],['library',true,true]]);
  expect(h.section('operate').hidden).toBe(true);// SDK, Vault need the Workspace
  expect(h.section('talk').hidden).toBe(false);
  h.inbox.hidden=false;h.nav.sync();
  expect(h.group('talk').items.map((i:any)=>i.hidden)).toEqual([false,false,false]);
  expect(h.section('operate').hidden).toBe(false);
  expect(hiddenMap(h.doc)).toEqual(before);// not one button's `hidden` changed hands
 });
 it('respects an owner-only button hidden by workspace.js: the slot stays, the group folds when nothing is visible',()=>{
  const h=boot();h.inbox.hidden=false;
  for(const node of h.doc.querySelectorAll('[data-owner-only]'))node.hidden=true;// the workspace.js member sweep
  h.nav.sync();
  expect(h.section('operate').hidden).toBe(true);expect(h.group('operate').items.every((i:any)=>i.hidden)).toBe(true);
  expect(h.byLabel('ESH shell').hidden).toBe(true);expect(h.group('echo').items.find((i:any)=>i.id==='esh').hidden).toBe(true);
  expect(h.section('echo').hidden).toBe(false);
  h.byLabel('SDK').hidden=false;h.nav.sync();
  expect(h.section('operate').hidden).toBe(false);
 });
 it('re-syncs from the Workspace ready promise and on echo-account-changed',async()=>{
  let resolveReady!:(v:boolean)=>void;const ready=new Promise<boolean>(r=>{resolveReady=r;});
  const h=boot({workspace:{ready,enabled:true,session:null}});
  expect(h.group('talk').items[1].hidden).toBe(true);
  h.inbox.hidden=false;resolveReady(true);await h.flush();
  expect(h.group('talk').items[1].hidden).toBe(false);
  h.inbox.hidden=true;h.emit('echo-account-changed');await h.flush();
  expect(h.group('talk').items[1].hidden).toBe(true);
 });
 it('adopts a button another module appends after load (logs.js pattern) on the next sync',()=>{
  const h=boot();
  const late=build(h.doc,['button',{class:'nav-item',id:'logs-open','data-owner-only':'true'},'Logs & debugging']);late.hidden=true;
  h.inbox.append(late);
  h.nav.sync();
  expect(h.groupOf(late)).toBe('operate');expect(late.parentNode!.attrs.has('data-workspace')).toBe(true);expect(h.nav.item('logs')).toBe(late);
  const journal=build(h.doc,['button',{class:'nav-item journal-status',id:'journal-status'},'Journal & ECF receipts']);journal.hidden=true;
  h.doc.querySelector('.sidebar-bottom').before(journal);h.nav.sync();
  expect(h.groupOf(journal)).toBe('operate');expect(h.group('operate').items.filter((i:any)=>!i.duplicate).map((i:any)=>i.id)).toEqual(['sdk','vault','logs','journal']);
 });
 it('applies the current owner rule once to a late-registered owner-only button',()=>{
  const member=boot({workspace:{ready:Promise.resolve(true),enabled:true,session:{ownerAccess:false}}});
  expect(member.nav.register({id:'open-fleet',label:'Fleet nodes',ownerOnly:true}).hidden).toBe(true);
  const owner=boot({workspace:{ready:Promise.resolve(true),enabled:true,session:{ownerAccess:true}}});
  expect(owner.nav.register({id:'open-fleet',label:'Fleet nodes',ownerOnly:true}).hidden).toBe(false);
  const offline=boot({workspace:{ready:Promise.resolve(false),enabled:false,session:null}});
  const node=offline.nav.register({id:'open-fleet',label:'Fleet nodes',ownerOnly:true});
  expect(node.hidden).toBe(false);expect(node.hasAttribute('data-owner-only')).toBe(true);// the workspace.js sweep owns it from here
 });
});

describe('register() for late modules',()=>{
 it('adopts an existing DOM node by id instead of creating a second one',()=>{
  const h=boot();
  const existing=build(h.doc,['button',{class:'nav-item',id:'open-browser'},'Browser']);h.sidebar.append(existing);
  const returned=h.nav.register({id:'open-browser',label:'Browser',onClick:vi.fn()});
  expect(returned).toBe(existing);expect(h.groupOf(existing)).toBe('echo');
  expect(h.group('echo').items.map((i:any)=>i.id)).toEqual(['systems','steward','esh','plugins','voice','browser']);
  expect(h.doc.querySelectorAll('[id="open-browser"]')).toHaveLength(1);
 });
 it('puts undeclared ids in the named group or in More, after Operate',()=>{
  const h=boot();
  const inEcho=h.nav.register({id:'open-lab',label:'Lab',group:'echo',icon:'i-spark'});
  expect(h.group('echo').items.map((i:any)=>i.id).at(-1)).toBe('open-lab');expect(inEcho.children[0].children[0].attrs.get('href')).toBe('#i-spark');
  const stray=h.nav.register({id:'open-stray',label:'Stray tool'});
  expect(h.groupOf(stray)).toBe('more');
  expect(h.primeNav.children.filter(n=>n.classes().includes('nav-group')).map(n=>n.attrs.get('data-group'))).toEqual(['talk','create','agents','echo','operate','more']);
  expect(h.toggle('more').textContent).toContain('More');
 });
 it('marks a registered Workspace item with the slot gate and refuses malformed specs',()=>{
  const h=boot();
  const node=h.nav.register({id:'open-notes',label:'Notes',group:'talk',workspace:true});
  expect(node.parentNode!.hidden).toBe(true);h.inbox.hidden=false;h.nav.sync();expect(node.parentNode!.hidden).toBe(false);
  for(const bad of [undefined,null,'x',{},{id:'ok'},{id:'bad id',label:'x'},{id:'-lead',label:'x'},{label:'no id'}])expect(()=>h.nav.register(bad as any)).toThrow(TypeError);
 });
 it('closes the mobile drawer through the scrim for a registered button when the sidebar is open',async()=>{
  const h=boot();
  const node=h.nav.register({id:'open-swarm',label:'Swarm brain'});
  node.click();await h.flush();expect(h.scrim.clickCount).toBe(0);
  h.sidebar.classList.add('open');node.click();await h.flush();expect(h.scrim.clickCount).toBe(1);
 });
 it('updates and removes count badges',()=>{
  const h=boot();
  const systems=h.byLabel('Echo systems');
  expect(systems.querySelector('.nav-count')!.textContent).toBe('12');
  expect(h.nav.setCount('systems','7')).toBe(true);expect(systems.querySelector('.nav-count')!.textContent).toBe('7');
  h.nav.setCount('systems',0);expect(systems.querySelector('.nav-count')).toBeNull();
  h.nav.setCount('systems',3);expect(systems.querySelector('.nav-count')!.textContent).toBe('3');
  expect(h.nav.setCount('never-registered',1)).toBe(false);
 });
});

describe('collapse, keyboard and aria',()=>{
 it('collapses a group from its toggle and persists under its own key, tolerating a blocked storage',()=>{
  const h=boot();
  h.toggle('talk').click();
  expect(h.list('talk').hidden).toBe(true);expect(h.toggle('talk').attrs.get('aria-expanded')).toBe('false');expect(h.section('talk').classes()).toContain('collapsed');
  expect(JSON.parse(h.stored.get('echo-prime-nav-v1')!)).toEqual({collapsed:['talk']});
  expect(h.stored.has('echo-prime-interface-v1')).toBe(false);
  const again=boot({storage:{'echo-prime-nav-v1':JSON.stringify({collapsed:['talk','bogus','operate']})}});
  expect(again.list('talk').hidden).toBe(true);expect(again.list('operate').hidden).toBe(true);expect(again.list('echo').hidden).toBe(false);
  expect(again.nav.collapsed()).toEqual(['talk','operate']);
  again.nav.expand('talk');expect(again.list('talk').hidden).toBe(false);
  const blocked=boot({storage:'throws'});expect(blocked.nav.mounted).toBe(true);blocked.toggle('echo').click();expect(blocked.list('echo').hidden).toBe(true);
 });
 it('moves focus with the arrow keys over visible controls only, wraps, and jumps with Home/End',()=>{
  const h=boot();// inbox hidden: Projects/Library/… are not focusable
  const key=(node:FakeNode,k:string)=>node.dispatch('keydown',{key:k});
  const conversation=h.byLabel('Conversation'),studio=h.byLabel('Creative studio');
  key(conversation,'ArrowDown');expect(h.doc.activeElement).toBe(h.toggle('create'));
  key(h.toggle('create'),'ArrowDown');expect(h.doc.activeElement).toBe(studio);
  key(studio,'ArrowDown');expect(h.doc.activeElement).toBe(h.toggle('echo'));// Agents is empty and skipped
  key(conversation,'ArrowUp');expect(h.doc.activeElement).toBe(h.toggle('talk'));
  key(conversation,'Home');expect(h.doc.activeElement).toBe(h.toggle('talk'));
  key(conversation,'End');expect(h.doc.activeElement).toBe(h.byLabel('Appearance'));
  key(h.byLabel('Appearance'),'ArrowDown');expect(h.doc.activeElement).toBe(h.toggle('talk'));
  const event=key(h.byLabel('Account'),'ArrowUp');expect(event.preventDefault).toHaveBeenCalled();
  h.byLabel('Node Steward').dispatch('keydown',{key:'Tab'});// unrelated keys pass through
 });
 it('folds and unfolds a group with ArrowLeft/ArrowRight on its toggle, and skips folded items',()=>{
  const h=boot();
  h.toggle('talk').dispatch('keydown',{key:'ArrowLeft'});expect(h.list('talk').hidden).toBe(true);
  h.toggle('talk').dispatch('keydown',{key:'ArrowDown'});expect(h.doc.activeElement).toBe(h.toggle('create'));
  h.toggle('talk').dispatch('keydown',{key:'ArrowRight'});expect(h.list('talk').hidden).toBe(false);
  h.toggle('talk').dispatch('keydown',{key:'ArrowDown'});expect(h.doc.activeElement).toBe(h.byLabel('Conversation'));
 });
 it('exposes the structure to assistive technology',()=>{
  const h=boot();
  expect(h.primeNav.attrs.get('aria-label')).toBe('Workspace');
  for(const id of ['talk','create','agents','echo','operate']){
   const toggle=h.toggle(id),list=h.list(id);
   expect(toggle.attrs.get('aria-controls')).toBe(list.id);expect(list.attrs.get('aria-labelledby')).toBe(toggle.id);expect(list.attrs.get('role')).toBe('list');
   expect(toggle.attrs.get('type')).toBe('button');expect(list.children.every(li=>li.tagName==='LI'&&li.classes().includes('nav-slot'))).toBe(true);
  }
  expect(h.byLabel('Conversation').attrs.get('aria-current')).toBe('page');
  expect(h.doc.querySelector('.nav-bottom .nav-group-items').attrs.get('aria-label')).toBe('Account');
 });
 it('marks the item that opened a dialog as current and returns to Conversation when it closes',async()=>{
  const h=boot({beforeBoot:doc=>doc.querySelector('[data-view="studio"]').addEventListener('click',()=>doc.querySelector('#appearance-dialog').showModal())});
  const conversation=h.byLabel('Conversation'),studio=h.byLabel('Creative studio');
  studio.click();await h.flush();
  expect(studio.attrs.get('aria-current')).toBe('page');expect(studio.classes()).toContain('active');expect(conversation.attrs.has('aria-current')).toBe(false);expect(conversation.classes()).not.toContain('active');
  h.dialog.close();
  expect(conversation.attrs.get('aria-current')).toBe('page');expect(studio.attrs.has('aria-current')).toBe(false);
  h.byLabel('Node Steward').click();await h.flush();// no dialog opened: home stays current
  expect(conversation.attrs.get('aria-current')).toBe('page');
  h.nav.setActive('systems');expect(h.byLabel('Echo systems').attrs.get('aria-current')).toBe('page');
 });
});

describe('shipped markup and delivery',()=>{
 it('index.html keeps every hook nav.js adopts and loads nav.js after the other sidebar modules',()=>{
  const html=readFileSync(new URL('../ui/echo-prime/index.html',import.meta.url),'utf8');
  for(const hook of ['id="prime-nav"','id="workspace-navigation"','id="open-steward"','id="workspace-open-esh"','id="workspace-account"','id="open-appearance"','id="workspace-open-plugins"','data-view="conversation"','data-view="studio"','data-view="systems"','data-prime-view="projects"','data-prime-view="library"','data-prime-view="sdk"','data-workspace-view="voice"','data-workspace-view="account"','class="sidebar-bottom"','id="scrim"'])expect(html).toContain(hook);
  expect(html).toContain('href="nav.css"');expect(html).toContain('<script src="nav.js"></script>');
  expect(html.indexOf('src="logs.js"')).toBeLessThan(html.indexOf('src="nav.js"'));
  expect(html).toContain('id="i-echo-mark"');expect(html).toContain('class="wordmark-text" data-text="ECHO PRIME"');
  expect(html).toContain('rel="icon" type="image/svg+xml"');
  expect(html).toContain('class="echo-mark topbar-mark"');
  for(const control of ['id="topbar-signin"','id="sidebar-signin"','id="sidebar-signup"','id="topbar-account"','id="sidebar-signout"'])expect(html).toMatch(new RegExp(control+'[^>]*\\bhidden'));
  expect(html).toContain('id="topbar-signout"');// inside the hidden #topbar-account menu
  for(const symbol of ['i-folder','i-library','i-agents','i-bot','i-swarm','i-nodes','i-globe','i-sdk','i-lock','i-logs','i-user','i-chevron'])expect(html).toContain('id="'+symbol+'"');
  expect(html).not.toContain('brand-mark');
 });
 it('the Prime server serves nav.js, nav.css and /privacy.html with the right content types',async()=>{
  const server=await startPrimeServer(new PrimeHub({capabilities:[]}),fileURLToPath(new URL('../ui/echo-prime/',import.meta.url)),0);
  try{
   for(const [path,type] of [['/nav.js','javascript'],['/nav.css','css'],['/privacy.html','html'],['/privacy','html']]){
    const response=await fetch(server.url+path);expect(response.status,path).toBe(200);expect(response.headers.get('content-type')).toContain(type);
   }
   const css=await (await fetch(server.url+'/nav.css')).text();
   expect(css).toContain('@keyframes wm-shimmer');expect(css).toContain('prefers-reduced-motion');expect(css).toContain('[data-palette=emerald]');expect(css).toContain('.signin-card');
   const page=await (await fetch(server.url+'/')).text();expect(page).toContain('nav.js');
  }finally{await server.close();}
 });
});

// Live test 2026-11-06: Echo Build and Library & Artifacts fell into "More", Talk > Library duplicated Library & Artifacts,
// and the declared Swarm brain / Fleet nodes items never appeared (swarm.js and fleet.js now add real #open-swarm and
// #open-fleet buttons; their own tests live in prime-chatfix-ui.test.ts).
describe('index.html items land in their declared groups',()=>{
 const loose:Spec[]=[['button',{class:'nav-item',id:'open-library'},'Library & Artifacts'],['button',{class:'nav-item',id:'open-build','data-owner-only':''},'Echo Build'],
  ['button',{class:'nav-item',id:'open-swarm','data-owner-only':''},'Swarm brain'],['button',{class:'nav-item',id:'open-fleet','data-owner-only':''},'Fleet nodes']];
 const inboxExtra:Spec[]=[['button',{class:'nav-item','data-prime-view':'library'},'Library'],['button',{class:'nav-item',id:'open-artifacts'},'Artifact Center']];
 it('puts Library & Artifacts under Talk once, Echo Build under Create, and Swarm brain and Fleet nodes in their groups',()=>{
  const h=boot({loose,inboxExtra});
  expect(h.groupOf(h.byLabel('Library & Artifacts'))).toBe('talk');expect(h.groupOf(h.byLabel('Echo Build'))).toBe('create');
  expect(h.groupOf(h.byLabel('Swarm brain'))).toBe('agents');expect(h.groupOf(h.byLabel('Fleet nodes'))).toBe('echo');
  expect(h.group('more')).toBeUndefined();
  const visible=(id:string)=>h.group(id).items.filter((i:any)=>!i.duplicate).map((i:any)=>i.id);
  expect(visible('talk')).toEqual(['conversation','projects','library','artifacts']);
  expect(h.nav.item('library').id).toBe('open-library');
  const libraries=h.doc.querySelectorAll('.nav-item').filter((n:FakeNode)=>n.textContent.trim()==='Library');
  expect(libraries).toHaveLength(2);for(const node of libraries)expect(node.parentNode!.hidden).toBe(true);// same dialog as Library & Artifacts, so one entry
  expect(h.groupOf(h.byLabel('Artifact Center'))).toBe('talk');
  expect(h.byLabel('Library & Artifacts').parentNode!.hidden).toBe(false);// the Prime library works without the Workspace too
  expect(visible('create')).toEqual(['studio','code-review','build']);
 });
});
