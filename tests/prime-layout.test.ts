import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function load(){
 const elements:any[]=[],listeners:Record<string,Function[]>={},stored=new Map<string,string>();
 class Node {
  children:any[]=[];attributes:Record<string,string>={};events:Record<string,Function[]>={};className='';textContent='';type='';
  style={setProperty:vi.fn()};classList={toggle:vi.fn(),add:vi.fn(),remove:vi.fn()};
  append(...n:any[]){this.children.push(...n);}prepend(...n:any[]){this.children.unshift(...n);}
  setAttribute(k:string,v:string){this.attributes[k]=v;}addEventListener(k:string,f:Function){(this.events[k]??=[]).push(f);}
  removeEventListener(){} setPointerCapture(){}hasPointerCapture(){return false;}releasePointerCapture(){}
  fire(k:string,e:any={}){for(const f of this.events[k]||[])f({preventDefault(){},...e});}
 }
 const sidebar=new Node(),host=new Node(),root=new Node();
 const storage={getItem:(k:string)=>stored.get(k)??null,setItem:(k:string,v:string)=>stored.set(k,v)};
 let shell={floating:false,rect:{x:280,y:90,width:640,height:330}};
 const layout={get:()=>structuredClone(shell),set:vi.fn((next:any)=>{shell=structuredClone(next);})};
 const window:any={innerWidth:1280,innerHeight:800,localStorage:storage,EchoPrimeWorkspace:{layout,ready:Promise.resolve()},addEventListener:(k:string,f:Function)=>(listeners[k]??=[]).push(f)};
 const document={body:root,documentElement:root,querySelector:(s:string)=>s==='#sidebar'?sidebar:s==='#workspace-esh'?host:null,createElement:()=>{const n=new Node();elements.push(n);return n;}};
 runInNewContext(readFileSync('ui/echo-prime/layout.js','utf8'),{window,document,console:{debug:vi.fn()},Number,JSON,Math});
 return {api:window.EchoPrimeLayout,elements,sidebar,host,root,stored,storage,layout,window,listeners};
}

it('clamps stale and malformed persisted geometry inside the current viewport',()=>{
 const {api}=load();const s=api.normalize({version:1,side:'right',sidebar:9000,dockHeight:-4,mode:'float',rect:{x:-50,y:9000,width:9000,height:NaN}},{width:640,height:480});
 expect(s.side).toBe('right');expect(s.sidebar).toBeLessThanOrEqual(280);expect(s.dockHeight).toBe(100);
 expect(s.rect.x).toBeGreaterThanOrEqual(8);expect(s.rect.y+s.rect.height).toBeLessThanOrEqual(472);
 expect(s.rect.width).toBeLessThanOrEqual(624);
});
it('bounds all eight resizing edges without moving the opposite edge',()=>{
 const {api}=load(),r={x:100,y:80,width:500,height:300},v={width:1280,height:800};
 for(const edge of ['n','e','s','w','ne','nw','se','sw']){
  const n=api.resizeRect(r,edge,-10000,10000,v);expect(n.x).toBeGreaterThanOrEqual(8);expect(n.y).toBeGreaterThanOrEqual(8);
  expect(n.width).toBeGreaterThanOrEqual(300);expect(n.height).toBeGreaterThanOrEqual(180);
  expect(n.x+n.width).toBeLessThanOrEqual(1272);expect(n.y+n.height).toBeLessThanOrEqual(792);
 }
});
it('persists only bounded appearance fields and recovers malformed storage',()=>{
 const {api,storage,stored}=load();api.writeLayout(storage,{version:1,side:'right',sidebar:300,mode:'float',rect:{x:10,y:20,width:500,height:300},command:'secret command',chat:'private'});
 const raw=[...stored.values()][0];expect(raw).not.toContain('secret');expect(raw).not.toContain('private');
 storage.setItem(api.key,'{bad');expect(api.readLayout(storage).side).toBe('left');
});
it('mounts eight accessible keyboard resizers and applies them through the existing shell boundary',()=>{
 const h=load();h.api.mount();const edges=h.elements.filter(n=>n.attributes['data-layout-edge']);expect(edges).toHaveLength(8);
 const east=edges.find(n=>n.attributes['data-layout-edge']==='e');east.fire('keydown',{key:'ArrowRight'});
 expect(h.layout.set).toHaveBeenCalled();expect(h.layout.get().floating).toBe(true);expect(h.layout.get().rect.width).toBe(660);
 expect(h.layout.get()).not.toHaveProperty('command');
});
it('moves navigation with keyboard and resets its saved appearance',()=>{
 const h=load();const mounted=h.api.mount();const move=h.elements.find(n=>n.attributes['aria-label']==='Move navigation to the left or right');
 move.fire('keydown',{key:'ArrowRight'});expect(mounted.getState().side).toBe('right');mounted.reset();expect(mounted.getState().side).toBe('left');
});
