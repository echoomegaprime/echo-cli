'use strict';
(() => {
  const KEY = 'echo.workspace.layout.v1';
  const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function limits(view) {
    return {width: Math.max(160, number(view.width, 1280)), height: Math.max(160, number(view.height, 800))};
  }
  function clampRect(rect = {}, view) {
    const v = limits(view), maxW = v.width - 16, maxH = v.height - 16;
    const width = clamp(number(rect.width, 640), Math.min(300, maxW), maxW);
    const height = clamp(number(rect.height, 330), Math.min(180, maxH), maxH);
    return {x:clamp(number(rect.x, 280),8,v.width-width-8), y:clamp(number(rect.y, 90),8,v.height-height-8), width, height};
  }
  function normalize(saved, view) {
    const s = saved?.version === 1 ? saved : {}, v = limits(view);
    return {version:1, side:s.side === 'right' ? 'right' : 'left',
      sidebar:clamp(number(s.sidebar,250),180,Math.max(180,Math.min(480,v.width-360))),
      dockHeight:clamp(number(s.dockHeight,250),100,Math.max(100,Math.min(500,v.height*.5))),
      mode:s.mode === 'float' ? 'float' : 'dock', rect:clampRect(s.rect,view)};
  }
  function resizeRect(rect, edge, dx, dy, view) {
    const r = clampRect(rect,view), v = limits(view), minW = Math.min(300,v.width-16), minH = Math.min(180,v.height-16);
    let left=r.x, top=r.y, right=r.x+r.width, bottom=r.y+r.height;
    if (edge.includes('w')) left=clamp(left+dx,8,right-minW);
    if (edge.includes('e')) right=clamp(right+dx,left+minW,v.width-8);
    if (edge.includes('n')) top=clamp(top+dy,8,bottom-minH);
    if (edge.includes('s')) bottom=clamp(bottom+dy,top+minH,v.height-8);
    return {x:left,y:top,width:right-left,height:bottom-top};
  }
  function readLayout(storage, view) {
    try { return normalize(JSON.parse(storage.getItem(KEY)),view); } catch { return normalize(null,view); }
  }
  function writeLayout(storage, state) {
    try { storage.setItem(KEY,JSON.stringify(state)); return true; } catch { return false; }
  }
  function mount({root,sidebar,host,esh}) {
    const view = () => ({width:window.innerWidth,height:window.innerHeight});
    let storage; try { storage=window.localStorage; } catch {}
    let state=readLayout(storage,view());
    const make = (tag,cls,text,label) => {
      const el=document.createElement(tag); el.className=cls;
      if (text) el.textContent=text;
      if (tag==='button') el.type='button';
      if (label) { el.setAttribute('aria-label',label);el.title=label; }
      return el;
    };
    const title=make('div','esh-titlebar'), grip=make('button','panel-grip','⠿','Move ESH panel. Drag or use arrow keys.'),
      float=make('button','panel-control','Float','Float ESH panel'),
      reset=make('button','panel-control','Reset','Reset panel layout');
    title.append(grip,host.querySelector('.esh-toggle'),float,reset);host.prepend(title);
    const dockResize=make('button','dock-resizer','','Resize docked ESH panel. Drag or use up and down arrows.');
    dockResize.setAttribute('role','separator');dockResize.setAttribute('aria-orientation','horizontal');host.prepend(dockResize);
    const sideTools=make('div','sidebar-layout-tools'),
      sideMove=make('button','panel-grip','⠿ Move','Move navigation panel. Drag to the left or right side.'),
      sideSwitch=make('button','panel-control','⇆','Move navigation to the other side');
    sideTools.append(sideMove,sideSwitch);sidebar.prepend(sideTools);
    const sideResize=make('button','sidebar-resizer','','Resize navigation panel. Drag or use left and right arrows.');
    sideResize.setAttribute('role','separator');sideResize.setAttribute('aria-orientation','vertical');sidebar.append(sideResize);
    function apply() {
      state=normalize(state,view());
      root.classList.toggle('sidebar-right',state.side==='right');
      root.style.setProperty('--sidebar-width',state.sidebar+'px');
      host.classList.toggle('floating',state.mode==='float');
      host.style.setProperty('--dock-height',state.dockHeight+'px');
      for (const [key,val] of Object.entries(state.rect)) host.style.setProperty('--panel-'+key,val+'px');
      float.textContent=state.mode==='float'?'Dock':'Float';
      float.setAttribute('aria-label',state.mode==='float'?'Dock ESH panel':'Float ESH panel');
      dockResize.setAttribute('aria-valuenow',Math.round(state.dockHeight));
      dockResize.setAttribute('aria-valuemin','100');dockResize.setAttribute('aria-valuemax',Math.floor(Math.min(500,view().height*.5)));
      sideResize.setAttribute('aria-valuenow',Math.round(state.sidebar));sideResize.setAttribute('aria-valuemin','180');sideResize.setAttribute('aria-valuemax',Math.max(180,Math.min(480,view().width-360)));
    }
    function save(reason) {
      apply();const persisted=writeLayout(storage,state);
      console.debug('[echo.layout]',JSON.stringify({event:'layout.changed',reason,persisted,mode:state.mode,side:state.side,sidebar:Math.round(state.sidebar),dockHeight:Math.round(state.dockHeight),rect:state.rect}));
    }
    function detach() {
      if(state.mode==='float') return;
      const r=host.getBoundingClientRect();
      state.rect=clampRect({x:r.x+20,y:Math.max(8,r.y-50),width:Math.min(r.width,760),height:Math.max(r.height,280)},view());
      state.mode='float';esh.setOpen(true);apply();
    }
    function drag(el, start, move, reason) {
      el.addEventListener('pointerdown',event=>{
        if(event.button!==0 || event.isPrimary===false)return;
        event.preventDefault();const old=JSON.parse(JSON.stringify(state));
        const data=start(event);if(data===false)return;
        const x=event.clientX,y=event.clientY,id=event.pointerId;
        el.setPointerCapture(id);document.body.classList.add('panel-dragging');
        const onMove=e=>{if(e.pointerId!==id)return;move(data,e.clientX-x,e.clientY-y,e);apply();};
        const finish=e=>{
          if(e.pointerId!==id)return;
          el.removeEventListener('pointermove',onMove);el.removeEventListener('pointerup',finish);el.removeEventListener('pointercancel',cancel);el.removeEventListener('lostpointercapture',cancel);
          document.body.classList.remove('panel-dragging');
          if(el.hasPointerCapture(id))el.releasePointerCapture(id);
          save(reason);
        };
        const cancel=e=>{if(e.pointerId!==id)return;state=old;finish(e);};
        el.addEventListener('pointermove',onMove);el.addEventListener('pointerup',finish);el.addEventListener('pointercancel',cancel);el.addEventListener('lostpointercapture',cancel);
      });
    }
    drag(grip,()=>{detach();return {...state.rect};},(r,dx,dy)=>{state.rect=clampRect({...r,x:r.x+dx,y:r.y+dy},view());},'move-shell');
    grip.addEventListener('dblclick',()=>{state.mode=state.mode==='float'?'dock':'float';esh.setOpen(true);save('dock-toggle');});
    grip.addEventListener('keydown',e=>{
      const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[e.key];
      if(!delta)return;e.preventDefault();detach();state.rect=clampRect({...state.rect,x:state.rect.x+delta[0],y:state.rect.y+delta[1]},view());save('move-shell-key');
    });
    float.addEventListener('click',()=>{if(state.mode==='dock')detach();else state.mode='dock';save('dock-toggle');});
    reset.addEventListener('click',()=>{state=normalize(null,view());host.classList.remove('large');host.querySelector('.esh-toolbar button').textContent='Expand';save('reset');});
    drag(dockResize,()=>state.dockHeight,(height,dx,dy)=>{state.dockHeight=height-dy;},'resize-dock');
    dockResize.addEventListener('keydown',e=>{
      if(!['ArrowUp','ArrowDown','Home'].includes(e.key))return;e.preventDefault();
      state.dockHeight=e.key==='Home'?250:state.dockHeight+(e.key==='ArrowUp'?20:-20);save('resize-dock-key');
    });
    drag(sideResize,()=>state.sidebar,(width,dx)=>{state.sidebar=width+(state.side==='right'?-dx:dx);},'resize-navigation');
    sideResize.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home'].includes(e.key))return;e.preventDefault();
      state.sidebar=e.key==='Home'?250:state.sidebar+(e.key==='ArrowRight'?20:-20)*(state.side==='right'?-1:1);save('resize-navigation-key');
    });
    drag(sideMove,()=>true,(data,dx,dy,e)=>{state.side=e.clientX>view().width/2?'right':'left';},'move-navigation');
    sideMove.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();state.side=e.key==='ArrowRight'?'right':'left';save('move-navigation-key');});
    sideSwitch.addEventListener('click',()=>{state.side=state.side==='left'?'right':'left';save('move-navigation');});
    for(const edge of ['n','e','s','w','ne','nw','se','sw']) {
      const handle=make('button','panel-resizer panel-resizer-'+edge,'','Resize ESH '+edge.toUpperCase()+'. Drag or use arrow keys.');
      host.append(handle);
      drag(handle,()=>({...state.rect}),(r,dx,dy)=>{state.rect=resizeRect(r,edge,dx,dy,view());},'resize-shell');
      handle.addEventListener('keydown',e=>{
        const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[e.key];
        if(!delta)return;e.preventDefault();state.rect=resizeRect(state.rect,edge,...delta,view());save('resize-shell-key');
      });
    }
    host.querySelector('.esh-toolbar button').addEventListener('click',()=>{
      if(state.mode==='float')state.rect.height=host.classList.contains('large')?view().height*.7:330;
      else state.dockHeight=host.classList.contains('large')?view().height*.5:250;
      save('expand-shell');
    });
    window.addEventListener('resize',apply);
    apply();
    return {reset:()=>{state=normalize(null,view());save('reset');},getState:()=>JSON.parse(JSON.stringify(state))};
  }
  window.EchoLayout={normalize,clampRect,resizeRect,readLayout,writeLayout,mount};
})();
