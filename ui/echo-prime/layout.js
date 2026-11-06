(() => {
 'use strict';
 // Layout system ported from the private Workspace (layout.js): navigation side
 // and width, docked ESH height, the floating ESH rectangle with eight edge
 // resizers, Reset, and persistence. Only geometry is stored (localStorage,
 // try/catch); never a command, a message or an account value. workspace.js
 // keeps ownership of the ESH rectangle and exposes it through
 // bridge.eshLayout; this module reads and writes it through that accessor and
 // listens for `echo-esh-layout` when the grip or corner handle moves it.
 const KEY='echo-prime-layout-v1';
 const number=(value,fallback)=>Number.isFinite(value)?value:fallback,clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
 const defaults={sidebar:250,dockHeight:430,rect:{x:280,y:90,width:640,height:430}};
 const arrows={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]};
 function limits(view){return {width:Math.max(160,number(view?.width,1280)),height:Math.max(160,number(view?.height,800))};}
 const sidebarMax=v=>Math.max(180,Math.min(480,v.width-360)),dockMax=v=>Math.max(160,Math.min(760,Math.floor(v.height*.85)));
 function clampRect(rect,view){
  const v=limits(view),maxW=v.width-16,maxH=v.height-16,r=rect&&typeof rect==='object'?rect:{};
  const width=clamp(number(r.width,defaults.rect.width),Math.min(300,maxW),maxW),height=clamp(number(r.height,defaults.rect.height),Math.min(200,maxH),maxH);
  return {x:clamp(number(r.x,defaults.rect.x),8,v.width-width-8),y:clamp(number(r.y,defaults.rect.y),8,v.height-height-8),width,height};
 }
 function normalize(saved,view){
  const s=saved&&typeof saved==='object'&&!Array.isArray(saved)&&saved.version===1?saved:{},v=limits(view);
  return {version:1,side:s.side==='right'?'right':'left',sidebar:clamp(number(s.sidebar,defaults.sidebar),180,sidebarMax(v)),
   dockHeight:clamp(number(s.dockHeight,defaults.dockHeight),160,dockMax(v)),mode:s.mode==='float'?'float':'dock',rect:clampRect(s.rect,view)};
 }
 function resizeRect(rect,edge,dx,dy,view){
  const r=clampRect(rect,view),v=limits(view),minW=Math.min(300,v.width-16),minH=Math.min(200,v.height-16),e=String(edge||'');
  let left=r.x,top=r.y,right=r.x+r.width,bottom=r.y+r.height;
  if(e.includes('w'))left=clamp(left+dx,8,right-minW);
  if(e.includes('e'))right=clamp(right+dx,left+minW,v.width-8);
  if(e.includes('n'))top=clamp(top+dy,8,bottom-minH);
  if(e.includes('s'))bottom=clamp(bottom+dy,top+minH,v.height-8);
  return {x:left,y:top,width:right-left,height:bottom-top};
 }
 function readLayout(storage,view){try{return normalize(JSON.parse(storage.getItem(KEY)),view);}catch{return normalize(null,view);}}
 function writeLayout(storage,state){try{storage.setItem(KEY,JSON.stringify(state));return true;}catch{return false;}}
 function mount({root,sidebar,host,bridge}){
  const view=()=>({width:window.innerWidth,height:window.innerHeight});
  let storage=null;try{storage=window.localStorage;}catch{}
  let state=readLayout(storage,view());
  const make=(tag,cls,text,label)=>{const node=document.createElement(tag);node.className=cls;if(text)node.textContent=text;if(tag==='button')node.setAttribute('type','button');if(label){node.setAttribute('aria-label',label);node.setAttribute('title',label);}return node;};
  // Navigation panel: move (drag / arrows / ⇆) and resize.
  const tools=make('div','sidebar-layout-tools'),sideMove=make('button','quiet-button panel-grip','⠿ Move','Move navigation panel. Drag to the left or right side, or use the arrow keys.'),sideSwitch=make('button','quiet-button panel-control','⇆','Move navigation to the other side');
  tools.append(sideMove,sideSwitch);(sidebar.querySelector('.sidebar-bottom')||sidebar).prepend(tools);
  const sideResize=make('button','sidebar-resizer','','Resize navigation panel. Drag or use the left and right arrow keys.');
  sideResize.setAttribute('role','separator');sideResize.setAttribute('aria-orientation','vertical');sidebar.append(sideResize);
  // ESH panel: dock height, Reset and eight edge resizers for the floating rectangle.
  const dockResize=make('button','dock-resizer','','Resize docked ESH panel. Drag or use the up and down arrow keys.');
  dockResize.setAttribute('role','separator');dockResize.setAttribute('aria-orientation','horizontal');host.prepend(dockResize);
  const reset=make('button','quiet-button panel-control','Reset','Reset panel layout');
  (host.querySelector('#workspace-esh-float')||host.querySelector('.workspace-esh-titlebar')||host).after(reset);
  const handles=[];
  for(const edge of ['n','e','s','w','ne','nw','se','sw']){const handle=make('button','panel-resizer panel-resizer-'+edge,'','Resize ESH '+edge.toUpperCase()+'. Drag or use the arrow keys.');handle.dataset.edge=edge;host.append(handle);handles.push(handle);}
  const geometry=()=>{const g=bridge?.eshLayout?.get?.();return g&&typeof g==='object'?g:{rect:state.rect,floating:state.mode==='float'};};
  const place=(rect,floating)=>{state.rect=clampRect(rect,view());state.mode=floating?'float':'dock';bridge?.eshLayout?.set?.({rect:{...state.rect},floating});};
  function apply(){
   state=normalize(state,view());const v=limits(view());
   root.classList.toggle('sidebar-right',state.side==='right');root.style.setProperty('--sidebar-width',state.sidebar+'px');
   host.style.setProperty('--dock-height',state.dockHeight+'px');
   dockResize.setAttribute('aria-valuenow',String(Math.round(state.dockHeight)));dockResize.setAttribute('aria-valuemin','160');dockResize.setAttribute('aria-valuemax',String(dockMax(v)));
   sideResize.setAttribute('aria-valuenow',String(Math.round(state.sidebar)));sideResize.setAttribute('aria-valuemin','180');sideResize.setAttribute('aria-valuemax',String(sidebarMax(v)));
  }
  function save(reason){
   apply();const persisted=writeLayout(storage,state);
   console.debug('[echo.layout]',{schema_version:1,event:'layout_changed',reason,persisted,mode:state.mode,side:state.side,sidebar:Math.round(state.sidebar),dockHeight:Math.round(state.dockHeight),rect:state.rect});
  }
  function drag(node,start,move,reason){
   node.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false)return;event.preventDefault();
    const old=JSON.parse(JSON.stringify(state)),data=start(event);if(data===false)return;
    const x=event.clientX,y=event.clientY,id=event.pointerId;
    try{node.setPointerCapture(id);}catch{}document.body.classList.add('panel-dragging');
    const onMove=e=>{if(e.pointerId!==id)return;move(data,e.clientX-x,e.clientY-y,e);apply();};
    const finish=e=>{
     if(e.pointerId!==id)return;
     for(const [name,fn] of [['pointermove',onMove],['pointerup',finish],['pointercancel',cancel],['lostpointercapture',cancel]])node.removeEventListener(name,fn);
     document.body.classList.remove('panel-dragging');try{if(node.hasPointerCapture(id))node.releasePointerCapture(id);}catch{}
     save(reason);
    };
    const cancel=e=>{if(e.pointerId!==id)return;state=old;if(reason==='resize-shell')place(old.rect,old.mode==='float');finish(e);};
    node.addEventListener('pointermove',onMove);node.addEventListener('pointerup',finish);node.addEventListener('pointercancel',cancel);node.addEventListener('lostpointercapture',cancel);
   });
  }
  drag(sideResize,()=>state.sidebar,(width,dx)=>{state.sidebar=width+(state.side==='right'?-dx:dx);},'resize-navigation');
  sideResize.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home'].includes(e.key))return;e.preventDefault();state.sidebar=e.key==='Home'?defaults.sidebar:state.sidebar+(e.key==='ArrowRight'?20:-20)*(state.side==='right'?-1:1);save('resize-navigation-key');});
  drag(sideMove,()=>true,(data,dx,dy,e)=>{state.side=e.clientX>view().width/2?'right':'left';},'move-navigation');
  sideMove.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();state.side=e.key==='ArrowRight'?'right':'left';save('move-navigation-key');});
  sideSwitch.addEventListener('click',()=>{state.side=state.side==='left'?'right':'left';save('move-navigation');});
  drag(dockResize,()=>state.dockHeight,(height,dx,dy)=>{state.dockHeight=height-dy;},'resize-dock');
  dockResize.addEventListener('keydown',e=>{if(!['ArrowUp','ArrowDown','Home'].includes(e.key))return;e.preventDefault();state.dockHeight=e.key==='Home'?defaults.dockHeight:state.dockHeight+(e.key==='ArrowUp'?20:-20);save('resize-dock-key');});
  for(const handle of handles){
   const edge=handle.dataset.edge;
   drag(handle,()=>({...clampRect(geometry().rect,view())}),(r,dx,dy)=>{place(resizeRect(r,edge,dx,dy,view()),true);},'resize-shell');
   handle.addEventListener('keydown',e=>{const delta=arrows[e.key];if(!delta)return;e.preventDefault();place(resizeRect(geometry().rect,edge,delta[0],delta[1],view()),true);save('resize-shell-key');});
  }
  const resetAll=()=>{state=normalize(null,view());place(state.rect,false);save('reset');};
  reset.addEventListener('click',resetAll);
  window.addEventListener('echo-esh-layout',()=>{const g=geometry();state.rect=clampRect(g.rect,view());state.mode=g.floating?'float':'dock';save('shell');});
  window.addEventListener('resize',apply);
  // Hand the persisted rectangle to its owner once; later changes arrive as events.
  bridge?.eshLayout?.set?.({rect:{...state.rect},floating:state.mode==='float'});
  apply();
  return {reset:resetAll,getState:()=>JSON.parse(JSON.stringify(state))};
 }
 window.EchoPrimeLayout={KEY,defaults,normalize,clampRect,resizeRect,readLayout,writeLayout,mount};
 try{
  const sidebar=document.querySelector('#sidebar'),host=document.querySelector('#workspace-esh');
  if(sidebar&&host)window.EchoPrimeLayout.instance=mount({root:document.body,sidebar,host,bridge:window.EchoPrimeWorkspace?.bridge});
 }catch{}
})();
