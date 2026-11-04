(() => {
 'use strict';
 // Geometry follows the canonical Workspace layout contract. This key stores
 // appearance only; commands, account identity, and conversation data never enter it.
 const key='echo-prime-layout-v1';
 const number=(v,d)=>typeof v==='number'&&Number.isFinite(v)?v:d;
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const limits=v=>({width:Math.max(160,number(v?.width,1280)),height:Math.max(160,number(v?.height,800))});
 function clampRect(rect={},view){
  const v=limits(view),width=clamp(number(rect.width,640),Math.min(300,v.width-16),v.width-16),height=clamp(number(rect.height,330),Math.min(180,v.height-16),v.height-16);
  return {x:clamp(number(rect.x,280),8,v.width-width-8),y:clamp(number(rect.y,90),8,v.height-height-8),width,height};
 }
 function normalize(saved,view){
  const s=saved?.version===1?saved:{},v=limits(view);
  return {version:1,side:s.side==='right'?'right':'left',sidebar:clamp(number(s.sidebar,250),180,Math.max(180,Math.min(480,v.width-360))),dockHeight:clamp(number(s.dockHeight,330),100,Math.max(100,Math.min(540,v.height*.65))),mode:s.mode==='float'?'float':'dock',rect:clampRect(s.rect,view)};
 }
 function resizeRect(rect,edge,dx,dy,view){
  const r=clampRect(rect,view),v=limits(view),minW=Math.min(300,v.width-16),minH=Math.min(180,v.height-16);
  let left=r.x,top=r.y,right=r.x+r.width,bottom=r.y+r.height;
  if(edge.includes('w'))left=clamp(left+dx,8,right-minW);
  if(edge.includes('e'))right=clamp(right+dx,left+minW,v.width-8);
  if(edge.includes('n'))top=clamp(top+dy,8,bottom-minH);
  if(edge.includes('s'))bottom=clamp(bottom+dy,top+minH,v.height-8);
  return {x:left,y:top,width:right-left,height:bottom-top};
 }
 function readLayout(storage,view){try{return normalize(JSON.parse(storage.getItem(key)),view);}catch{return normalize(null,view);}}
 function writeLayout(storage,state,view){try{storage.setItem(key,JSON.stringify(normalize(state,view)));return true;}catch{return false;}}
 let mounted;
 function mount(){
  if(mounted)return mounted;
  const sidebar=document.querySelector('#sidebar'),host=document.querySelector('#workspace-esh'),shell=window.EchoPrimeWorkspace?.layout,root=document.documentElement;
  if(!sidebar||!host||!shell)return null;
  const view=()=>({width:window.innerWidth,height:window.innerHeight});let storage;try{storage=window.localStorage;}catch{}
  let state=readLayout(storage,view()),applying=false;
  const make=(label,cls)=>{const b=document.createElement('button');b.type='button';b.className=cls;b.setAttribute('aria-label',label);b.title=label;return b;};
  function apply(){
   if(applying)return;applying=true;
   try{state=normalize(state,view());root.classList.toggle('prime-sidebar-right',state.side==='right');root.style.setProperty('--prime-sidebar-width',state.sidebar+'px');host.style.setProperty('--prime-dock-height',state.dockHeight+'px');shell.set({floating:state.mode==='float',rect:{...state.rect}});}finally{applying=false;}
  }
  function save(reason){apply();const persisted=writeLayout(storage,state,view());console.debug('[echo.prime.layout]',JSON.stringify({event:'layout.changed',reason,persisted,mode:state.mode,side:state.side}));}
  function drag(el,start,move,reason){
   el.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false)return;event.preventDefault();
    const old=JSON.parse(JSON.stringify(state)),data=start(event),x=event.clientX,y=event.clientY,id=event.pointerId;
    el.setPointerCapture(id);document.body.classList.add('prime-layout-dragging');
    const onMove=e=>{if(e.pointerId!==id)return;move(data,e.clientX-x,e.clientY-y,e);apply();};
    const finish=e=>{if(e.pointerId!==id)return;el.removeEventListener('pointermove',onMove);el.removeEventListener('pointerup',finish);el.removeEventListener('pointercancel',cancel);el.removeEventListener('lostpointercapture',cancel);document.body.classList.remove('prime-layout-dragging');if(el.hasPointerCapture(id))el.releasePointerCapture(id);save(reason);};
    const cancel=e=>{if(e.pointerId!==id)return;state=old;finish(e);};
    el.addEventListener('pointermove',onMove);el.addEventListener('pointerup',finish);el.addEventListener('pointercancel',cancel);el.addEventListener('lostpointercapture',cancel);
   });
  }
  const tools=document.createElement('div');tools.className='prime-layout-tools';
  const move=make('Move navigation to the left or right','prime-layout-move'),reset=make('Reset panel layout','prime-layout-reset');move.textContent='⇆ Navigation';reset.textContent='Reset layout';tools.append(move,reset);sidebar.prepend(tools);
  move.addEventListener('click',()=>{state.side=state.side==='left'?'right':'left';save('navigation-side');});
  move.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();state.side=e.key==='ArrowRight'?'right':'left';save('navigation-key');});
  drag(move,()=>true,(_s,_x,_y,e)=>{state.side=e.clientX>view().width/2?'right':'left';},'navigation-drag');
  const sideResize=make('Resize navigation width','prime-sidebar-resize');sideResize.setAttribute('role','separator');sideResize.setAttribute('aria-orientation','vertical');sidebar.append(sideResize);
  drag(sideResize,()=>state.sidebar,(width,dx)=>{state.sidebar=width+dx*(state.side==='right'?-1:1);},'navigation-width');
  sideResize.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home'].includes(e.key))return;e.preventDefault();state.sidebar=e.key==='Home'?250:state.sidebar+(e.key==='ArrowRight'?20:-20)*(state.side==='right'?-1:1);save('navigation-width-key');});
  const dockResize=make('Resize docked ESH height','prime-dock-resize');dockResize.setAttribute('role','separator');dockResize.setAttribute('aria-orientation','horizontal');host.prepend(dockResize);
  drag(dockResize,()=>state.dockHeight,(height,_x,dy)=>{state.dockHeight=height-dy;},'dock-height');
  dockResize.addEventListener('keydown',e=>{if(!['ArrowUp','ArrowDown','Home'].includes(e.key))return;e.preventDefault();state.dockHeight=e.key==='Home'?330:state.dockHeight+(e.key==='ArrowUp'?20:-20);save('dock-height-key');});
  const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]};
  for(const edge of ['n','e','s','w','ne','nw','se','sw']){
   const handle=make('Resize ESH '+edge.toUpperCase()+'. Drag or use arrow keys.','prime-panel-edge prime-edge-'+edge);handle.setAttribute('data-layout-edge',edge);host.append(handle);
   const start=()=>{const current=shell.get();state.rect=clampRect(current.rect,view());state.mode='float';return {...state.rect};};
   drag(handle,start,(rect,dx,dy)=>{state.rect=resizeRect(rect,edge,dx,dy,view());},'shell-edge');
   handle.addEventListener('keydown',e=>{if(!delta[e.key])return;e.preventDefault();const r=start();state.rect=resizeRect(r,edge,...delta[e.key],view());save('shell-edge-key');});
  }
  const resetLayout=()=>{state=normalize(null,view());save('reset');};reset.addEventListener('click',resetLayout);
  window.addEventListener('echo-workspace-layout',e=>{if(applying||!e.detail)return;state.mode=e.detail.floating?'float':'dock';state.rect=clampRect(e.detail.rect,view());writeLayout(storage,state,view());});
  window.addEventListener('resize',apply);apply();mounted={reset:resetLayout,getState:()=>JSON.parse(JSON.stringify(state))};return mounted;
 }
 window.EchoPrimeLayout={key,normalize,clampRect,resizeRect,readLayout,writeLayout,mount};
 window.EchoPrimeWorkspace?.ready?.then(mount);
})();
