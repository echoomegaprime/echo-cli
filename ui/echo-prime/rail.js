(() => {
 'use strict';
 // Echo controls rail: one right-hand column that holds the mode chips, the model and personality pickers, the
 // voice controls and the context meter. It only arranges them. Every control is still created and driven by its
 // own module (app.js, models.js, brain.js, composer.js, voicebar.js, speech.js); those modules mount into the
 // card slots (#rail-<card>-slot) that index.html declares, so nothing is duplicated or re-implemented here.
 //
 // Layout: the rail is docked (conversation column shrinks, header button hides and shows it, choice remembered) only
 // while the viewport is 1100px or wider AND the navigation leaves the conversation column at least COLUMN_MIN px next
 // to the rail. Otherwise, narrow viewport or a wide navigation, the same button opens it as a slide-over drawer
 // (backdrop, focus moves in, Escape closes, focus returns to the button). rail.css keys on the `rail-squeezed` class
 // this file sets when the viewport is wide but the navigation is not leaving enough room. The drawer lets go of the
 // page when you act in it: a mode chip closes it and puts the cursor in the prompt, "Connect Echo systems" closes it
 // and the button gets focus back when the dialog closes. Each card collapses on its header; that is remembered too.
 // Storage holds only {hidden, collapsed} under one key and every access is try/catch, so the page works when
 // storage is blocked.
 //
 // This file is a classic script in <head>: it applies a remembered "hidden" and the squeezed class before the body is
 // parsed (no layout shift), then wires the markup once the DOM is ready.
 const KEY='echo-prime-rail-v1',LAYOUT_KEY='echo-prime-layout-v1',CARDS=['mode','model','personality','voice','context'];
 const WIDE=1100,RAIL_W=320/* = --rail-w in rail.css */,COLUMN_MIN=520,DOCK_SPACE=RAIL_W+COLUMN_MIN,NAV_DEFAULT=250;
 const clean=()=>({v:1,hidden:false,collapsed:{}});
 function normalize(raw){
  const out=clean();
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.v!==1)return out;
  out.hidden=raw.hidden===true;
  if(raw.collapsed&&typeof raw.collapsed==='object'&&!Array.isArray(raw.collapsed))for(const id of CARDS)if(raw.collapsed[id]===true)out.collapsed[id]=true;
  return out;
 }
 function readState(store){try{return normalize(JSON.parse(store.getItem(KEY)));}catch{return clean();}}
 function writeState(store,state){try{store.setItem(KEY,JSON.stringify(normalize(state)));return true;}catch{return false;}}
 // layout.js keeps the navigation width; before it has run (this script is in <head>) the saved value is the best guess.
 function savedNav(store){try{const saved=JSON.parse(store.getItem(LAYOUT_KEY)),n=saved&&saved.version===1?Number(saved.sidebar):NaN;return Number.isFinite(n)?Math.max(180,Math.min(480,n)):NAV_DEFAULT;}catch{return NAV_DEFAULT;}}

 let store=null;try{store=window.localStorage;}catch{}
 let state=readState(store);
 const navHint=savedNav(store);
 const root=document.documentElement||document.body;
 const flag=(name,on)=>{try{if(root&&root.classList)root.classList.toggle(name,on);}catch{}};
 const viewport=()=>Number(window.innerWidth)||0;
 function navWidth(){
  try{const style=document.body&&document.body.style,n=style&&typeof style.getPropertyValue==='function'?parseFloat(style.getPropertyValue('--sidebar-width')):NaN;if(Number.isFinite(n)&&n>0)return n;}catch{}
  return navHint;
 }
 const docked=()=>{const width=viewport();return width>=WIDE&&width-navWidth()>=DOCK_SPACE;};
 const squeezed=()=>viewport()>=WIDE&&!docked();
 flag('rail-hidden',state.hidden);
 flag('rail-squeezed',squeezed());

 const api={KEY,CARDS,WIDE,DOCK_SPACE,normalize,readState,writeState,state:()=>normalize(state),refresh(){},sync(){},isDocked:docked};
 window.EchoPrimeRail=api;

 function mount(){
  const $=selector=>document.querySelector(selector);
  const rail=$('#echo-rail');
  if(!rail)return;
  const toggle=$('#rail-toggle'),closeButton=$('#rail-close'),scrim=$('#rail-scrim'),main=$('main'),nav=$('#sidebar'),navScrim=$('#scrim');
  const cards=CARDS.map(id=>({id,card:$('#rail-card-'+id),button:$('#rail-card-btn-'+id),body:$('#rail-body-'+id),slot:$('#rail-'+id+'-slot')})).filter(c=>c.card&&c.button&&c.body);
  let open=false,held=null,restoreFocus=false;

  // ---- drawer / docked visibility ----
  const shown=()=>docked()?!state.hidden:open;
  function paint(){
   if(toggle)toggle.setAttribute('aria-expanded',String(shown()));
   flag('rail-open',open);
   if(scrim)scrim.classList.toggle('visible',open);
  }
  function setOpen(next,focus=true){
   next=next===true;
   if(next&&docked())return false;
   if(next===open)return open;
   open=next;
   if(open){
    restoreFocus=false;
    // A phone navigation drawer closes first; whatever inert state the page keeps on main and the navigation is handed back untouched.
    if(navScrim&&navScrim.classList.contains('visible'))navScrim.click();
    held={main:!!main&&main.inert===true,nav:!!nav&&nav.inert===true};
    if(main)main.inert=true;
    if(nav)nav.inert=true;
   }else if(held){
    if(main)main.inert=held.main;
    if(nav)nav.inert=held.nav;
    held=null;
   }
   paint();
   if(focus){const target=open?closeButton:toggle;if(target&&typeof target.focus==='function')target.focus();}
   return open;
  }
  function setHidden(next){
   state.hidden=next===true;
   flag('rail-hidden',state.hidden);
   writeState(store,state);
   paint();
  }
  // Viewport or navigation width changed: dock or un-dock, and close a drawer that has just become a docked rail.
  function sync(){
   flag('rail-squeezed',squeezed());
   if(docked()&&open)setOpen(false,false);
   paint();
  }
  if(toggle)toggle.addEventListener('click',()=>{if(docked())setHidden(!state.hidden);else setOpen(!open);});
  if(closeButton)closeButton.addEventListener('click',()=>setOpen(false));
  if(scrim)scrim.addEventListener('click',()=>setOpen(false));
  // Escape closes the drawer, unless a dialog is open (it owns Escape) or another handler has already used the key.
  window.addEventListener('keydown',event=>{
   if(!event||event.key!=='Escape'||!open||event.defaultPrevented)return;
   if(Array.from(document.querySelectorAll('dialog')).some(dialog=>dialog.open))return;
   setOpen(false);
  });
  window.addEventListener('resize',sync);
  if(typeof MutationObserver==='function'&&document.body)new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['style']});// layout.js writes --sidebar-width there while the navigation is dragged

  // ---- the drawer lets go of the page when you act in it ----
  // A mode chip is a choice about the next message: close the drawer and put the cursor in the prompt (app.js focuses it too,
  // but its main is inert until the drawer is gone). "Connect Echo systems" opens a modal dialog: close the drawer first, and
  // give the focus to the rail button when that dialog closes (the browser would otherwise return it to a hidden control).
  // These listeners run in the capture phase so they act before app.js's own handlers.
  function leaveDrawer(forDialog){
   if(!open)return;
   setOpen(false,false);
   if(forDialog){restoreFocus=true;return;}
   const prompt=$('#prompt');
   if(prompt&&typeof prompt.focus==='function')prompt.focus();
  }
  const wired=new WeakSet();
  const modeTabs=rail.querySelector('.mode-tabs');
  function wireLeaving(){
   const targets=[...(modeTabs?Array.from(modeTabs.querySelectorAll('button')).map(node=>[node,false]):[]),...Array.from(rail.querySelectorAll('[data-open]')).map(node=>[node,true])];
   for(const [node,forDialog] of targets){if(wired.has(node))continue;wired.add(node);node.addEventListener('click',()=>leaveDrawer(forDialog),true);}
  }
  wireLeaving();
  if(typeof MutationObserver==='function'&&modeTabs)new MutationObserver(wireLeaving).observe(modeTabs,{childList:true});// media-router.js adds the Auto chip
  document.addEventListener('close',()=>{
   if(!restoreFocus)return;
   restoreFocus=false;
   if(toggle&&typeof toggle.focus==='function')toggle.focus();
  },true);// `close` does not bubble; capturing at the document sees every dialog

  // ---- cards ----
  function paintCard(c){
   const collapsed=state.collapsed[c.id]===true;
   c.button.setAttribute('aria-expanded',String(!collapsed));
   if(collapsed)c.card.setAttribute('data-collapsed','true');else c.card.removeAttribute('data-collapsed');
   c.body.inert=collapsed;// a collapsed card leaves the tab order; the stylesheet hides it from view and from assistive technology
  }
  function toggleCard(id){
   const c=cards.find(item=>item.id===id);
   if(!c)return false;
   if(state.collapsed[id])delete state.collapsed[id];else state.collapsed[id]=true;
   writeState(store,state);
   paintCard(c);
   return state.collapsed[id]===true;
  }
  for(const c of cards){
   c.button.addEventListener('click',()=>toggleCard(c.id));
   paintCard(c);
  }

  // ---- cards with nothing to show stay out of the way (Voice before sign-in, Context before a window size is known) ----
  // rail.css also hides a card whose slot is empty, so a failure of this file cannot hide controls that did mount.
  const controlTag=/^(INPUT|SELECT|TEXTAREA|BUTTON|PROGRESS)$/;
  function live(node){
   for(const child of Array.from(node.children||[])){
    if(child.hidden)continue;
    if(controlTag.test(String(child.tagName||'').toUpperCase()))return true;
    const inner=Array.from(child.children||[]);
    if(inner.length){if(live(child))return true;continue;}
    if(String(child.textContent||'').trim())return true;
   }
   return false;
  }
  function refresh(){
   for(const c of cards){const has=live(c.slot||c.body);if(c.card.hidden===has)c.card.hidden=!has;}
  }
  let queued=false;
  const schedule=()=>{if(queued)return;queued=true;Promise.resolve().then(()=>{queued=false;refresh();});};
  for(const name of ['echo-workspace-context','echo-account-changed','echo-speech-changed','echo-uploads-changed'])window.addEventListener(name,schedule);
  if(typeof MutationObserver==='function')for(const c of cards)if(c.slot)new MutationObserver(schedule).observe(c.slot,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});

  Object.assign(api,{refresh,sync,toggleCard,setHidden,open:()=>setOpen(true),close:()=>setOpen(false),isOpen:()=>open});
  sync();
  refresh();
  // Transitions start after the first paint so a remembered collapsed card does not animate on load.
  const frame=typeof window.requestAnimationFrame==='function'?fn=>window.requestAnimationFrame(fn):fn=>setTimeout(fn,0);
  frame(()=>rail.classList.add('rail-ready'));
 }
 try{
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
 }catch{}
})();
