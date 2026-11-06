/* ECHO Prime sidebar navigation (2026-11-04).
 *
 * One declarative list, NAV_GROUPS, drives group order, labels and icons. nav.js never fabricates a button for a
 * declared item that is absent: it ADOPTS the `.nav-item` buttons that other modules place in the sidebar
 * (index.html, logs.js, sibling slices) by their hooks — id, data-view, data-workspace-view, label — and moves
 * them, listeners intact, into labelled, collapsible groups. Late modules call
 * window.EchoPrimeNav.register({id,label,icon,group,ownerOnly,workspace,onClick}).
 *
 * Visibility has two owners that never overlap:
 *  - the adopted button's own `hidden` stays with the module that wrote it (workspace.js owner sweep, logs.js);
 *  - the "Workspace connected" gate, formerly the hidden #workspace-navigation container, lives on the nav.js slot
 *    (<li>) around each button that came from that container or was declared `workspace:true`.
 * Collapse state persists in localStorage under its own key (try/catch). No network, no secrets.
 */
(() => {
 'use strict';
 const doc=document,win=window;
 const STORAGE='echo-prime-nav-v1';
 const NAV_GROUPS=[
  {id:'talk',label:'Talk',items:[
   {id:'conversation',label:'Conversation',icon:'i-chat',match:{view:'conversation'}},
   {id:'projects',label:'Projects',icon:'i-folder',workspace:true,match:{workspaceView:'projects',primeView:'projects'}},
   {id:'library',label:'Library',icon:'i-library',workspace:true,match:{workspaceView:'library',primeView:'library',label:'Library'}},
  ]},
  {id:'create',label:'Create',items:[
   {id:'studio',label:'Creative studio',icon:'i-spark',match:{view:'studio'}},
   {id:'code-review',label:'Code review',icon:'i-code',workspace:true,match:{workspaceView:'library',primeView:'review',label:'Code review'}},
  ]},
  {id:'agents',label:'Agents',items:[
   {id:'agents',label:'Agents (Echo ADK)',icon:'i-agents',match:{id:['open-agents','agents-open'],view:'agents',label:/^Agents\b/i}},
   {id:'echobots',label:'echoBots',icon:'i-bot',match:{id:['open-echobots','echobots-open'],view:'echobots',label:/^echoBots\b/i}},
   {id:'swarm',label:'Swarm brain',icon:'i-swarm',match:{id:['open-swarm','swarm-open'],view:'swarm',label:/^Swarm\b/i}},
  ]},
  {id:'echo',label:'Echo',items:[
   {id:'systems',label:'Echo systems',icon:'i-chip',match:{view:'systems'}},
   {id:'steward',label:'Node Steward',icon:'i-shield',match:{id:'open-steward'}},
   {id:'esh',label:'ESH shell',icon:'i-code',ownerOnly:true,match:{id:'workspace-open-esh'}},
   {id:'fleet',label:'Fleet nodes',icon:'i-nodes',match:{id:['open-fleet','fleet-open'],view:'fleet',label:/^Fleet\b/i}},
   {id:'plugins',label:'Plugins & memory',icon:'i-memory',workspace:true,match:{id:'workspace-open-plugins'}},
   {id:'voice',label:'Voice & personality',icon:'i-mic',workspace:true,match:{workspaceView:'voice'}},
   {id:'browser',label:'Browser',icon:'i-globe',match:{id:['open-browser','browser-open'],view:'browser',label:/^Browser\b/i}},
  ]},
  {id:'operate',label:'Operate',items:[
   {id:'sdk',label:'SDK',icon:'i-sdk',workspace:true,ownerOnly:true,match:{workspaceView:'operations',primeView:'sdk',label:'SDK'}},
   {id:'vault',label:'Vault',icon:'i-lock',workspace:true,ownerOnly:true,match:{workspaceView:'operations',primeView:'vault',label:'Vault'}},
   {id:'logs',label:'Logs & debugging',icon:'i-logs',workspace:true,ownerOnly:true,match:{id:'logs-open',view:'logs'}},
   {id:'journal',label:'Journal & ECF receipts',icon:'i-memory',match:{id:'journal-status'}},
  ]},
  {id:'bottom',label:'Account',bottom:true,items:[
   {id:'account',label:'Account',icon:'i-user',match:{id:'workspace-account',workspaceView:'account'}},
   // Owner-only member management (workspace.js view 'members'); the button lives in #workspace-navigation.
   {id:'members',label:'Members',icon:'i-members',workspace:true,ownerOnly:true,match:{id:'workspace-members',workspaceView:'members'}},
   {id:'appearance',label:'Appearance',icon:'i-sliders',match:{id:'open-appearance'}},
  ]},
 ];
 // Anything that matches no declared hook still gets a home, after Operate, so sibling merges never lose a button.
 const MORE={id:'more',label:'More',items:[]};
 const GROUP_ORDER=[...NAV_GROUPS.filter(g=>!g.bottom).map(g=>g.id),MORE.id];

 const state={sidebar:null,nav:null,inbox:null,bottom:null,groups:new Map(),entries:[],nodes:new Map(),items:new Map(),collapsed:new Set(),dynamic:0,scheduled:false,syncing:false,observer:null,home:null,active:null};
 for(const group of NAV_GROUPS)group.items.forEach((item,index)=>state.entries.push({group,item,order:index}));

 // ---- small DOM helpers that work in a browser and in the test harness ----------------------------------------
 function el(tag,attributes={},...children){
  const node=doc.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(value===undefined||value===null||value===false)continue;if(key==='class')node.className=value;else node.setAttribute(key,String(value));}
  for(const child of children){if(child===null||child===undefined)continue;node.append(typeof child==='string'?doc.createTextNode(child):child);}
  return node;
 }
 function icon(name){const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('aria-hidden','true');const use=doc.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+name);svg.append(use);return svg;}
 const attr=(node,name)=>typeof node?.getAttribute==='function'?node.getAttribute(name):null;
 const has=(node,name)=>typeof node?.hasAttribute==='function'?node.hasAttribute(name):attr(node,name)!==null;
 const data=(node,key)=>node?.dataset?node.dataset[key]:undefined;
 const classes=node=>String(node?.className||'').split(/\s+/).filter(Boolean);
 const hasClass=(node,name)=>classes(node).includes(name);
 function contains(parent,node){for(let cursor=node;cursor;cursor=cursor.parentNode||cursor.parent||null)if(cursor===parent)return true;return false;}
 function labelOf(node){
  const kids=node?.childNodes||node?.children||[];let text='';
  for(const kid of kids)if(kid&&kid.nodeType===3)text+=kid.textContent||'';
  if(!text.trim())text=String(node?.textContent||'');
  return text.replace(/\s+/g,' ').trim();
 }
 const labelMatches=(pattern,text)=>pattern instanceof RegExp?pattern.test(text):String(pattern).replace(/\s+/g,' ').trim().toLowerCase()===text.toLowerCase();
 function firstSvg(node){for(const kid of node.children||[])if(String(kid.tagName||'').toLowerCase()==='svg')return kid;return null;}

 // ---- persistence (collapse state only; never anything about the account) --------------------------------------
 function load(){try{const raw=win.localStorage?.getItem(STORAGE);const saved=raw?JSON.parse(raw):null;if(saved&&Array.isArray(saved.collapsed))for(const id of saved.collapsed)if(typeof id==='string'&&GROUP_ORDER.includes(id))state.collapsed.add(id);}catch{}}
 function save(){try{win.localStorage?.setItem(STORAGE,JSON.stringify({collapsed:[...state.collapsed]}));}catch{}}

 // ---- groups ----------------------------------------------------------------------------------------------------
 function ensureGroup(def){
  let group=state.groups.get(def.id);if(group)return group;
  if(def.bottom){
   const root=el('div',{class:'nav-bottom'}),list=el('ul',{class:'nav-group-items',role:'list','aria-label':def.label});root.append(list);
   if(state.bottom){if(state.bottom.children?.length&&typeof state.bottom.children[0].before==='function')state.bottom.children[0].before(root);else state.bottom.append(root);}
   else state.nav.append(root);
   group={def,root,list,toggle:null,slots:()=>[...list.children]};state.groups.set(def.id,group);return group;
  }
  const labelId='nav-group-'+def.id+'-label',listId='nav-group-'+def.id;
  const toggle=el('button',{type:'button',class:'nav-group-toggle',id:labelId,'aria-expanded':'true','aria-controls':listId,'data-group':def.id},el('span',{},def.label),icon('i-chevron'));
  const list=el('ul',{class:'nav-group-items',id:listId,role:'list','aria-labelledby':labelId});
  const root=el('section',{class:'nav-group','data-group':def.id,'data-group-order':String(GROUP_ORDER.indexOf(def.id))});
  root.append(toggle,list);root.hidden=true;
  toggle.addEventListener('click',()=>setCollapsed(def.id,!state.collapsed.has(def.id)));
  // Keep NAV_GROUPS order even when "More" is created late.
  const order=GROUP_ORDER.indexOf(def.id);let placed=false;
  for(const sibling of [...(state.nav.children||[])]){if(!hasClass(sibling,'nav-group'))continue;if(Number(attr(sibling,'data-group-order'))>order&&typeof sibling.before==='function'){sibling.before(root);placed=true;break;}}
  if(!placed)state.nav.append(root);
  group={def,root,list,toggle,slots:()=>[...list.children]};state.groups.set(def.id,group);
  applyCollapse(group);return group;
 }
 function applyCollapse(group){if(!group.toggle)return;const collapsed=state.collapsed.has(group.def.id);group.list.hidden=collapsed;group.toggle.setAttribute('aria-expanded',String(!collapsed));if(group.root.classList?.toggle)group.root.classList.toggle('collapsed',collapsed);}
 function setCollapsed(id,collapsed){const group=state.groups.get(id);if(!group||!group.toggle)return;if(collapsed)state.collapsed.add(id);else state.collapsed.delete(id);applyCollapse(group);save();}

 // ---- adoption --------------------------------------------------------------------------------------------------
 function score(item,node){
  const m=item.match||{},id=attr(node,'id')||node.id||'',text=labelOf(node);
  const ids=[].concat(m.id||[]);
  if(id&&ids.includes(id))return 4;
  if(m.primeView&&data(node,'primeView')===m.primeView)return 3;
  if(m.workspaceView&&data(node,'workspaceView')===m.workspaceView){if(m.label===undefined)return 2;return labelMatches(m.label,text)?3:0;}
  if(m.view&&data(node,'view')===m.view)return 3;
  if(m.label!==undefined&&!m.workspaceView&&labelMatches(m.label,text))return 1;
  return 0;
 }
 function resolve(node){
  let best=null,bestScore=0;
  for(const entry of state.entries){const value=score(entry.item,node);if(value>bestScore){best=entry;bestScore=value;}}
  return best?{entry:best,rank:bestScore}:null;
 }
 function dynamicEntry(id,label,icon,groupId){
  const group=NAV_GROUPS.find(g=>g.id===groupId&&!g.bottom)||MORE;
  const entry={group,item:{id,label,icon:icon||null,match:{id:[id],label}},order:1000+state.dynamic++,dynamic:true};
  state.entries.push(entry);return entry;
 }
 function decorate(node,item){
  if(item.icon&&!firstSvg(node)){const svg=icon(item.icon);const first=(node.childNodes||node.children||[])[0];try{if(first&&typeof node.insertBefore==='function')node.insertBefore(svg,first);else if(typeof node.prepend==='function')node.prepend(svg);else node.append(svg);}catch{node.append(svg);}}
  if(!attr(node,'type')&&String(node.tagName||'').toLowerCase()==='button')node.setAttribute('type','button');
 }
 function insertOrdered(list,slot,order){
  slot.setAttribute('data-order',String(order));
  for(const sibling of [...(list.children||[])]){if(Number(attr(sibling,'data-order'))>order&&typeof sibling.before==='function'){sibling.before(slot);return;}}
  list.append(slot);
 }
 function adopt(node,explicit){
  if(!node||state.nodes.has(node)||!hasClass(node,'nav-item')||hasClass(node,'nav-group-toggle'))return null;
  const origin=!!(state.inbox&&contains(state.inbox,node));
  const resolved=explicit||resolve(node)||{entry:dynamicEntry(attr(node,'id')||'nav-'+(state.dynamic+1),labelOf(node)||'Untitled',null,MORE.id),rank:1};
  const {entry,rank}=resolved,group=ensureGroup(entry.group);
  const slot=el('li',{class:'nav-slot','data-nav-item':entry.item.id});
  if(entry.item.workspace||origin)slot.setAttribute('data-workspace','1');
  if(entry.item.ownerOnly||has(node,'data-owner-only'))slot.setAttribute('data-owner-only','1');
  decorate(node,entry.item);
  slot.append(node);
  const record={slot,node,entry,rank,duplicate:false};
  const primary=state.items.get(entry.item.id);
  if(primary&&primary.node!==node){
   // Two buttons for one item (today: the HTML `data-view="logs"` button and logs.js `#logs-open`). The stronger
   // hook stays visible; the other keeps its hooks but its slot is hidden, so merges stay additive.
   if(rank>primary.rank){markDuplicate(primary);state.items.set(entry.item.id,record);}
   else markDuplicate(record);
  }else state.items.set(entry.item.id,record);
  insertOrdered(group.list,slot,entry.order);
  state.nodes.set(node,record);
  node.addEventListener('click',()=>onItemClick(node));
  if(hasClass(node,'active')&&!state.home){state.home=node;node.setAttribute('aria-current','page');state.active=node;}
  return record;
 }
 function markDuplicate(record){record.duplicate=true;record.slot.hidden=true;record.slot.setAttribute('data-nav-duplicate','1');}
 function sweep(){
  if(!state.sidebar)return;
  const candidates=typeof state.sidebar.querySelectorAll==='function'?[...state.sidebar.querySelectorAll('.nav-item')]:[];
  for(const node of candidates)adopt(node);
 }

 // ---- visibility ------------------------------------------------------------------------------------------------
 const connected=()=>!(state.inbox&&state.inbox.hidden);
 function sync(){
  if(!state.sidebar)return;
  state.syncing=true;
  try{
   sweep();
   const live=connected();
   for(const record of state.nodes.values()){if(record.duplicate)continue;if(has(record.slot,'data-workspace'))record.slot.hidden=!live;}
   for(const group of state.groups.values()){
    const visible=group.slots().some(slot=>!slot.hidden&&!(slot.children?.[0]?.hidden));
    group.root.hidden=!visible;
   }
  }finally{state.syncing=false;if(state.observer&&typeof state.observer.takeRecords==='function')state.observer.takeRecords();}
 }
 function schedule(){if(state.scheduled)return;state.scheduled=true;const run=()=>{state.scheduled=false;sync();};if(typeof queueMicrotask==='function')queueMicrotask(run);else Promise.resolve().then(run);}

 // ---- active state: Conversation is home; an item that opened a dialog is current until that dialog closes --------
 function setActive(target){
  const node=typeof target==='string'?state.items.get(target)?.node:target;if(!node||!state.nodes.has(node))return;
  for(const other of state.nodes.keys()){const on=other===node;if(other.classList?.toggle)other.classList.toggle('active',on);if(on)other.setAttribute('aria-current','page');else if(typeof other.removeAttribute==='function')other.removeAttribute('aria-current');}
  state.active=node;
 }
 function onItemClick(node){
  // Mobile drawer: app.js closes it for the buttons it bound at load; registered or late buttons reuse that handler
  // through the scrim (menu(false) is idempotent, so a double close is harmless).
  if(state.sidebar&&hasClass(state.sidebar,'open')){const scrim=doc.querySelector('#scrim');if(scrim&&typeof scrim.click==='function')scrim.click();}
  const after=()=>{if(!state.nodes.has(node))return;const open=typeof doc.querySelector==='function'&&doc.querySelector('dialog[open]');if(open)setActive(node);else if(node===state.home)setActive(node);};
  if(typeof queueMicrotask==='function')queueMicrotask(after);else Promise.resolve().then(after);
 }
 function bindActive(){doc.addEventListener('close',()=>{if(state.home&&state.active!==state.home)setActive(state.home);},true);}

 // ---- keyboard: arrows move between visible controls, Home/End jump, Left/Right fold a group --------------------
 function visibleControls(){
  const out=[];
  for(const id of [...GROUP_ORDER,'bottom']){const group=state.groups.get(id);if(!group||group.root.hidden)continue;
   if(group.toggle)out.push(group.toggle);
   if(group.list.hidden)continue;
   for(const slot of group.slots()){const node=slot.children?.[0];if(slot.hidden||!node||node.hidden)continue;out.push(node);}
  }
  return out;
 }
 function bindKeys(){
  state.sidebar.addEventListener('keydown',event=>{
   const target=event.target;if(!target)return;
   const isToggle=hasClass(target,'nav-group-toggle');if(!isToggle&&!state.nodes.has(target))return;
   const key=event.key,controls=visibleControls(),index=controls.indexOf(target);
   const focus=node=>{if(node&&typeof node.focus==='function')node.focus();};
   if(key==='ArrowDown'||key==='ArrowUp'){event.preventDefault?.();if(!controls.length)return;focus(controls[(index+(key==='ArrowDown'?1:-1)+controls.length)%controls.length]);}
   else if(key==='Home'){event.preventDefault?.();focus(controls[0]);}
   else if(key==='End'){event.preventDefault?.();focus(controls[controls.length-1]);}
   else if((key==='ArrowLeft'||key==='ArrowRight')&&hasClass(target,'nav-group-toggle')){event.preventDefault?.();setCollapsed(attr(target,'data-group'),key==='ArrowLeft');}
  });
 }

 // ---- public API ------------------------------------------------------------------------------------------------
 function register(spec){
  if(!spec||typeof spec!=='object')throw new TypeError('EchoPrimeNav.register expects {id,label,icon?,group?,ownerOnly?,workspace?,onClick?}');
  const id=String(spec.id||'').trim(),label=String(spec.label||'').replace(/\s+/g,' ').trim();
  if(!/^[A-Za-z][\w-]{0,80}$/.test(id))throw new TypeError('EchoPrimeNav.register: id must be a short identifier');
  if(!label)throw new TypeError('EchoPrimeNav.register: label is required');
  const known=state.items.get(id)||[...state.items.values()].find(record=>attr(record.node,'id')===id);
  if(known)return known.node;
  let entry=state.entries.find(e=>e.item.id===id||[].concat(e.item.match?.id||[]).includes(id));
  if(!entry)entry=dynamicEntry(id,label,typeof spec.icon==='string'?spec.icon:null,typeof spec.group==='string'?spec.group:MORE.id);
  let node=typeof doc.getElementById==='function'?doc.getElementById(id):null;
  if(!node&&typeof doc.querySelector==='function')node=doc.querySelector('[id="'+id.replace(/"/g,'')+'"]');
  const created=!node;
  if(created){
   node=el('button',{type:'button',class:'nav-item',id},label);
   if(spec.ownerOnly===true||entry.item.ownerOnly){
    node.setAttribute('data-owner-only','');
    // The workspace.js owner sweep ran before this button existed; apply the same rule once from the cached session.
    const ws=win.EchoPrimeWorkspace,session=ws?.session;node.hidden=!!ws?.enabled&&!(session&&session.ownerAccess===true);
   }
   if(typeof spec.onClick==='function')node.addEventListener('click',event=>{try{spec.onClick(event);}catch(error){console.warn('[echo.nav] click handler failed:',error instanceof Error?error.message:error);}});
  }
  if(spec.workspace===true&&!entry.item.workspace)entry={...entry,item:{...entry.item,workspace:true}};
  const record=adopt(node,{entry,rank:4});
  if(record&&typeof spec.count!=='undefined')setCount(entry.item.id,spec.count);
  sync();
  return record?record.node:node;
 }
 function setCount(id,value){
  const record=state.items.get(id);if(!record)return false;
  let badge=null;for(const kid of record.node.children||[])if(hasClass(kid,'nav-count')){badge=kid;break;}
  const text=value===null||value===undefined||value===0||value===''?'':String(value);
  if(!text){if(badge&&typeof badge.remove==='function')badge.remove();return true;}
  if(!badge){badge=el('span',{class:'nav-count'});record.node.append(badge);}
  badge.textContent=text;return true;
 }
 function observe(){
  if(typeof MutationObserver!=='function'||!state.sidebar)return;
  try{state.observer=new MutationObserver(()=>{if(!state.syncing)schedule();});state.observer.observe(state.sidebar,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});}catch{state.observer=null;}
 }
 function init(){
  state.sidebar=doc.querySelector('#sidebar');state.nav=doc.querySelector('#prime-nav')||doc.querySelector('.sidebar nav');
  state.inbox=doc.querySelector('#workspace-navigation');state.bottom=doc.querySelector('.sidebar-bottom');
  if(!state.sidebar||!state.nav)return false;
  load();
  for(const group of NAV_GROUPS)ensureGroup(group);
  sweep();sync();observe();bindKeys();bindActive();
  const ws=win.EchoPrimeWorkspace;if(ws&&ws.ready&&typeof ws.ready.then==='function')ws.ready.then(()=>sync(),()=>sync());
  win.addEventListener('echo-account-changed',()=>schedule());
  return true;
 }
 const mounted=init();
 win.EchoPrimeNav={
  NAV_GROUPS,mounted,register,sync,setActive,setCount,
  collapse:id=>setCollapsed(id,true),expand:id=>setCollapsed(id,false),
  collapsed:()=>[...state.collapsed],
  groups:()=>[...GROUP_ORDER,'bottom'].filter(id=>state.groups.has(id)).map(id=>{const group=state.groups.get(id);return {id,label:group.def.label,hidden:!!group.root.hidden,collapsed:state.collapsed.has(id),items:group.slots().map(slot=>({id:attr(slot,'data-nav-item'),hidden:!!(slot.hidden||slot.children?.[0]?.hidden),duplicate:has(slot,'data-nav-duplicate'),workspace:has(slot,'data-workspace'),ownerOnly:has(slot,'data-owner-only')}))};}),
  item:id=>state.items.get(id)?.node||null,
 };
})();
