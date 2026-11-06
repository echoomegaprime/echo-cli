(() => {
 'use strict';
 // Echo controls rail: one right-hand column that holds the mode chips, the model and personality pickers, the
 // voice controls and the context meter. It only arranges them. Every control is still created and driven by its
 // own module (app.js, models.js, brain.js, composer.js, voicebar.js, speech.js); those modules mount into the
 // card slots (#rail-<card>-slot) that index.html declares, so nothing is duplicated or re-implemented here.
 //
 // Layout: from 1100px the rail is docked and the conversation column shrinks; the header button hides and shows it
 // and the choice is remembered. Below 1100px the same button opens it as a slide-over drawer (backdrop, focus moves in,
 // Escape closes, focus returns to the button). Each card collapses on its header; that is remembered too. Storage holds
 // only {hidden, collapsed} under one key and every access is try/catch, so the page works when storage is blocked.
 //
 // This file is a classic script in <head>: it applies a remembered "hidden" before the body is parsed (no layout
 // shift), then wires the markup once the DOM is ready.
 const KEY='echo-prime-rail-v1',CARDS=['mode','model','personality','voice','context'],WIDE=1100;
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

 let store=null;try{store=window.localStorage;}catch{}
 let state=readState(store);
 const root=document.documentElement||document.body;
 const flag=(name,on)=>{try{if(root&&root.classList)root.classList.toggle(name,on);}catch{}};
 flag('rail-hidden',state.hidden);

 const api={KEY,CARDS,normalize,readState,writeState,state:()=>normalize(state),refresh(){},isWide:()=>Number(window.innerWidth)>=WIDE};
 window.EchoPrimeRail=api;

 function mount(){
  const $=selector=>document.querySelector(selector);
  const rail=$('#echo-rail');
  if(!rail)return;
  const toggle=$('#rail-toggle'),closeButton=$('#rail-close'),scrim=$('#rail-scrim'),main=$('main'),nav=$('#sidebar'),navScrim=$('#scrim');
  const cards=CARDS.map(id=>({id,card:$('#rail-card-'+id),button:$('#rail-card-btn-'+id),body:$('#rail-body-'+id),slot:$('#rail-'+id+'-slot')})).filter(c=>c.card&&c.button&&c.body);
  const wide=api.isWide;
  let open=false,held=null;

  // ---- drawer / docked visibility ----
  const shown=()=>wide()?!state.hidden:open;
  function paint(){
   if(toggle)toggle.setAttribute('aria-expanded',String(shown()));
   flag('rail-open',open);
   if(scrim)scrim.classList.toggle('visible',open);
  }
  function setOpen(next,focus=true){
   next=next===true;
   if(next&&wide())return false;
   if(next===open)return open;
   open=next;
   if(open){
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
  if(toggle)toggle.addEventListener('click',()=>{if(wide())setHidden(!state.hidden);else setOpen(!open);});
  if(closeButton)closeButton.addEventListener('click',()=>setOpen(false));
  if(scrim)scrim.addEventListener('click',()=>setOpen(false));
  window.addEventListener('keydown',event=>{if(event&&event.key==='Escape'&&open)setOpen(false);});
  window.addEventListener('resize',()=>{if(wide()&&open)setOpen(false,false);paint();});

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

  Object.assign(api,{refresh,toggleCard,setHidden,open:()=>setOpen(true),close:()=>setOpen(false),isOpen:()=>open});
  paint();
  refresh();
  // Transitions start after the first paint so a remembered collapsed card does not animate on load.
  const frame=typeof window.requestAnimationFrame==='function'?fn=>window.requestAnimationFrame(fn):fn=>setTimeout(fn,0);
  frame(()=>rail.classList.add('rail-ready'));
 }
 try{
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
 }catch{}
})();
