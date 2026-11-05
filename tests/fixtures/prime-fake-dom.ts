/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM stand-in shared by the Prime UI tests */
import {vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// A small DOM stand-in with real parent/child insertion (append, prepend, before, after, remove),
// a working classList, dataset, inline style properties and attribute/class/id/tag selectors.
// It executes the shipped ui/echo-prime controllers in a vm context; nothing talks to a network.
export class Node {
 tagName:string;_text='';className='';hidden=false;disabled=false;checked=false;open=false;value='';max=0;isConnected=true;inert=false;scrollTop=0;scrollHeight=0;
 dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];inserted:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};styles:Record<string,string>={};files:any[]=[];
 style={setProperty:(key:string,value:string)=>{this.styles[key]=value;},removeProperty:(key:string)=>{delete this.styles[key];}};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 get textContent():string{return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(value:string){this._text=String(value);this.children=[];}
 get placeholder(){return this.attributes.placeholder??'';}
 set placeholder(value:string){this.attributes.placeholder=value;}
 get classList(){const tokens=()=>this.className.split(/\s+/).filter(Boolean),set=(list:string[])=>{this.className=list.join(' ');};const api={add:(c:string)=>{if(!tokens().includes(c))set([...tokens(),c]);},remove:(c:string)=>{set(tokens().filter(x=>x!==c));},toggle:(c:string,on?:boolean)=>{if(on===undefined?!tokens().includes(c):on)api.add(c);else api.remove(c);return tokens().includes(c);},contains:(c:string)=>tokens().includes(c)};return api;}
 detach(child:Node){this.children=this.children.filter(c=>c!==child);}
 append(...items:Node[]){for(const item of items){item.parent?.detach(item);item.parent=this;item.isConnected=true;this.children.push(item);}}
 prepend(...items:Node[]){for(const item of [...items].reverse()){item.parent?.detach(item);item.parent=this;item.isConnected=true;this.children.unshift(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children){child.isConnected=false;child.parent=null;}this.children=[];this._text='';this.append(...items);}
 after(...items:Node[]){if(!this.parent){this.inserted.push(...items);return;}const parent=this.parent;items.forEach((item,k)=>{item.parent?.detach(item);item.parent=parent;item.isConnected=true;parent.children.splice(parent.children.indexOf(this)+1+k,0,item);});}
 before(...items:Node[]){if(!this.parent){this.inserted.push(...items);return;}const parent=this.parent;items.forEach((item,k)=>{item.parent?.detach(item);item.parent=parent;item.isConnected=true;parent.children.splice(parent.children.indexOf(this)+k,0,item);});}
 remove(){this.parent?.detach(this);this.parent=null;this.isConnected=false;}
 setAttribute(key:string,value:string){this.attributes[key]=String(value);if(key==='value')this.value=String(value);}
 getAttribute(key:string){return this.attributes[key]??null;}
 removeAttribute(key:string){delete this.attributes[key];}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 removeEventListener(name:string,callback:(event:any)=>unknown){this.events[name]=(this.events[name]||[]).filter(fn=>fn!==callback);}
 async fire(name:string,event:any={}){for(const fn of [...(this.events[name]||[])])await fn({preventDefault(){},stopPropagation(){},target:this,...event});}
 showModal(){this.open=true;} close(){this.open=false;void this.fire('close');} focus(){} click(){return this.fire('click');}
 setPointerCapture(){} hasPointerCapture(){return false;} releasePointerCapture(){}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100,x:0,y:0,width:100,height:100};}
 querySelector(selector:string):Node|null{return walk(this).find(n=>matches(n,selector))||null;}
 querySelectorAll(selector:string):Node[]{return walk(this).filter(n=>matches(n,selector));}
}
export function matches(n:Node,selector:string):boolean{
 const part=selector.trim().split(/\s+/).pop()!;
 const m=/^([a-z0-9-]*)(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(part);
 if(!m)return false;
 const [,tag,id,classes,attrs]=m;
 if(tag&&n.tagName!==tag.toUpperCase())return false;
 if(id&&n.attributes.id!==id.slice(1))return false;
 for(const cls of classes.split('.').filter(Boolean))if(!n.className.split(/\s+/).includes(cls))return false;
 for(const attr of attrs.match(/\[[^\]]+\]/g)||[]){
  const a=/^\[([\w-]+)(?:=("?)([^\]"]*)\2)?\]$/.exec(attr);if(!a)return false;
  const key=a[1],value=a[3];if(!(key in n.attributes))return false;if(value!==undefined&&n.attributes[key]!==value)return false;
 }
 return true;
}
export function walk(root:Node):Node[]{return [...root.children,...root.inserted].flatMap(c=>[c,...walk(c)]);}
export const source=(name:string)=>readFileSync(new URL('../../ui/echo-prime/'+name,import.meta.url),'utf8');
export const tick=()=>new Promise(r=>setTimeout(r,0));

export interface Storage {map:Map<string,string>;reads:number;writes:string[];getItem:(k:string)=>string|null;setItem:(k:string,v:string)=>void;removeItem:(k:string)=>void}
export function storage(initial:Record<string,string>={},options:{throws?:boolean}={}):Storage{
 const map=new Map(Object.entries(initial)),s:Storage={map,reads:0,writes:[],
  getItem(k){s.reads++;if(options.throws)throw new Error('storage unavailable');return map.get(k)??null;},
  setItem(k,v){if(options.throws)throw new Error('storage unavailable');s.writes.push(v);map.set(k,String(v));},
  removeItem(k){if(options.throws)throw new Error('storage unavailable');map.delete(k);}};
 return s;
}

export interface World {
 nodes:Map<string,Node>;window:any;document:any;body:Node;storage:Storage;debug:ReturnType<typeof vi.fn>;
 get:(selector:string)=>Node;all:()=>Node[];button:(label:string)=>Node|undefined;buttons:(label:string)=>Node[];find:(selector:string)=>Node|undefined;
 emit:(type:string,detail?:any)=>void;emitDocument:(type:string)=>void;run:(file:string)=>void;
}
export interface WorldOptions {window?:Record<string,any>;globals?:Record<string,any>;storage?:Storage;width?:number;height?:number;strict?:boolean;body?:(body:Node,register:(selector:string,node:Node)=>void)=>void}
export function world(files:string[],options:WorldOptions={}):World{
 const nodes=new Map<string,Node>(),events:Record<string,((event:any)=>unknown)[]>={},documentEvents:Record<string,((event:any)=>unknown)[]>={};
 const body=new Node('body'),head=new Node('head'),store=options.storage||storage(),debug=vi.fn();
 const register=(selector:string,node:Node)=>{nodes.set(selector,node);};
 options.body?.(body,register);
 const get=(selector:string)=>{if(nodes.has(selector))return nodes.get(selector)!;const found=walk(body).find(n=>matches(n,selector));if(found){nodes.set(selector,found);return found;}const node=new Node();if(/^#[\w-]+$/.test(selector))node.attributes.id=selector.slice(1);nodes.set(selector,node);return node;};
 const window:any={innerWidth:options.width??1200,innerHeight:options.height??800,localStorage:store,
  addEventListener:(name:string,fn:(e:any)=>unknown)=>(events[name]??=[]).push(fn),removeEventListener:(name:string,fn:(e:any)=>unknown)=>{events[name]=(events[name]||[]).filter(x=>x!==fn);},
  dispatchEvent:(event:any)=>{for(const fn of [...(events[event.type]||[])])fn(event);return true;},...options.window};
 // strict: unknown selectors resolve to null like a real document instead of a fresh placeholder node.
 const document:any={body,head,hidden:false,querySelector:options.strict?(selector:string)=>nodes.get(selector)||walk(body).find(n=>matches(n,selector))||null:get,querySelectorAll:(selector:string)=>walk(body).filter(n=>matches(n,selector)),
  createElement:(tag:string)=>new Node(tag),createElementNS:(_ns:string,tag:string)=>new Node(tag),createTextNode:(text:string)=>Object.assign(new Node('#text'),{_text:text}),
  addEventListener:(name:string,fn:(e:any)=>unknown)=>(documentEvents[name]??=[]).push(fn)};
 const context:Record<string,any>={window,document,localStorage:store,sessionStorage:store,navigator:{userAgent:'fixture',clipboard:{writeText:async()=>{}}},crypto:{randomUUID},
  setTimeout,clearTimeout,queueMicrotask,AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Audio:vi.fn(),Event,Error,console:{debug,info:vi.fn(),warn:vi.fn()},...options.globals};
 const run=(file:string)=>runInNewContext(source(file),context);
 for(const file of files)run(file);
 const all=()=>[body,...nodes.values()].flatMap(n=>[n,...walk(n)]).filter((n,i,list)=>list.indexOf(n)===i);
 return {nodes,window,document,body,storage:store,debug,get,all,run,
  button:(label:string)=>all().find(n=>n.tagName==='BUTTON'&&n.textContent.trim()===label),
  buttons:(label:string)=>all().filter(n=>n.tagName==='BUTTON'&&n.textContent.trim()===label),
  find:(selector:string)=>all().find(n=>matches(n,selector)),
  emit:(type:string,detail?:any)=>{window.dispatchEvent(Object.assign(new Event(type),detail||{}));},
  emitDocument:(type:string)=>{for(const fn of documentEvents[type]||[])fn(new Event(type));}};
}

// The static ESH panel and sidebar from index.html, enough for workspace.js, esh-dock.js and layout.js.
export function primeShell(body:Node,register:(selector:string,node:Node)=>void){
 const el=(tag:string,attrs:Record<string,string>={},...children:Node[])=>{const n=new Node(tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(attrs.class)n.className=attrs.class;n.append(...children);if(attrs.id)register('#'+attrs.id,n);return n;};
 const brandSmall=el('small');brandSmall.textContent='FORGE WORKSPACE';register('.brand small',brandSmall);
 const brand=el('a',{class:'brand'},brandSmall);
 const bottom=el('div',{class:'sidebar-bottom'},el('div',{class:'profile'}));register('.sidebar-bottom',bottom);
 const sidebar=el('aside',{id:'sidebar',class:'sidebar'},brand,bottom);
 const title=el('span',{id:'conversation-title'});title.textContent='New conversation';
 const subtitle=el('small',{id:'conversation-subtitle',class:'conversation-subtitle'});subtitle.hidden=true;
 const main=el('main',{},el('header',{class:'topbar'},el('div',{},title,subtitle)),el('section',{id:'chat-log',class:'chat-log'}));
 const strong=el('strong',{id:'workspace-esh-title'});strong.textContent='ESH · current conversation';
 const grip=el('button',{id:'workspace-esh-grip'}),float=el('button',{id:'workspace-esh-float'}),close=el('button',{id:'workspace-esh-close'});
 const titlebar=el('div',{class:'workspace-esh-titlebar'},grip,strong,float,close);
 const output=el('div',{id:'workspace-esh-output',class:'workspace-esh-output'});
 const command=el('textarea',{id:'workspace-esh-command'}),label=el('label',{class:'workspace-field'},command);label._text='Command';
 const review=el('button',{id:'workspace-esh-review'}),reviewed=el('pre',{id:'workspace-esh-reviewed'}),run=el('button',{id:'workspace-esh-run'}),status=el('p',{id:'workspace-esh-status'});
 run.disabled=true;
 const controls=el('div',{class:'workspace-esh-controls'},label,review,reviewed,run,status);
 const resize=el('button',{id:'workspace-esh-resize'});
 const esh=el('aside',{id:'workspace-esh',class:'workspace-esh'},titlebar,output,controls,resize);esh.hidden=true;
 body.append(sidebar,main,esh);
}
