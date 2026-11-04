(() => {
 'use strict';
 // Live node bar (QUENCH, FORGE, ANVIL, HAMMER, TEMPER, CRUCIBLE) and the FORGE
 // model line. Reads /api/fleet every 15 s (owner only) and /api/health every
 // 60 s, the cadence the reference Workspace uses. Nothing here is decoration:
 // a node is green only when the canonical backend reported it connected within
 // the last five minutes; every other situation is shown as unknown.
 const doc=document;
 const NODES=['quench','forge','anvil','hammer','temper','crucible'];
 const FLEET_MS=15000,HEALTH_MS=60000,STALE_MS=5*60*1000;
 const REASONS={
  checking:'Checking the Workspace connection.',
  offline:'No Workspace backend is connected, so this node cannot be probed.',
  signin:'Sign in to an approved Workspace account to see live node status.',
  pending:'Account approval is pending, so live node status is not available.',
  member:'Live fleet status is available to the primary owner only.',
 };
 const HEALTH_TEXT={
  checking:'FORGE · Checking…',loaded:'FORGE · Model loaded',needed:'FORGE · Connection needed',
  unknown:'FORGE · Status unknown',offline:'FORGE · Not connected',
 };

 function el(tag,attributes={},...children){
  const node=doc.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){
   if(value===false||value===undefined||value===null)continue;
   if(key==='class')node.className=value;else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity)){
   if(child===null||child===undefined||child===false)continue;
   node.append(typeof child==='string'?doc.createTextNode(child):child);
  }
  return node;
 }

 // ---- pure state mapping (exported for tests) -------------------------------
 function connectionState(value){return value==='connected'||value==='disconnected'?value:'unknown';}
 function placeholder(reason){return NODES.map(id=>({id,connection:'unknown',reason}));}
 function normalizeFleet(response,now=Date.now()){
  const rows=Array.isArray(response?.nodes)?response.nodes:[];
  return NODES.map(id=>{
   const row=rows.find(n=>n&&typeof n==='object'&&typeof n.id==='string'&&n.id.toLowerCase()===id);
   if(!row)return {id,connection:'unknown',reason:'The backend reported no probe for this node.'};
   const node={...row,id,connection:connectionState(row.connection)};
   const stamp=Date.parse(typeof row.checked_at==='string'?row.checked_at:response.observed_at);
   if(node.connection!=='unknown'&&Number.isFinite(stamp)&&now-stamp>STALE_MS){
    return {...node,connection:'unknown',reason:'The last probe is older than five minutes, so its '+node.connection+' result is not trusted.'};
   }
   return node;
  });
 }
 function healthState(response){
  const loaded=response?.model?.loaded;
  return loaded===true?'loaded':loaded===false?'needed':'unknown';
 }
 function classify(session){
  if(!session||session.workspaceConfigured!==true)return 'offline';
  if(session.authenticated!==true)return 'signin';
  if(session.user?.status!=='approved')return 'pending';
  return session.ownerAccess===true?'owner':'member';
 }

 // ---- controller ------------------------------------------------------------
 const transport=new window.EchoPrimeWorkspaceTransport({onIdentityChange(session){
  const key=identityKey(session);
  // Transport.clear() reports identity null on every failed admission. Only a
  // real change of account, approval or owner status may restart the bar.
  if(key===lastKey)return;
  lastKey=key;reset();later(pollAll);
 }});
 const identityKey=session=>session&&session.authenticated===true&&session.user?`${session.user.uid}|${session.user.status}|${!!session.ownerAccess}`:'anon';
 const later=fn=>void Promise.resolve().then(fn);
 let lastKey='anon',epoch=0,controller=new AbortController(),access='checking',nodes=placeholder(REASONS.checking),health='checking',sync=null;
 const busy={fleet:-1,health:-1},listeners=new Set(),buttons=new Map();
 let bar=null,forgeText=null,dialog=null,dialogBody=null,dialogTitle=null;

 const snapshot=()=>({generation:epoch,access,nodes:nodes.map(n=>({...n})),health,sync:sync&&typeof sync==='object'?{...sync}:null});
 function publish(){render();for(const listener of [...listeners]){try{listener(snapshot());}catch{/* a listener must not break polling */}}}
 function subscribe(listener){listeners.add(listener);listener(snapshot());return ()=>listeners.delete(listener);}
 function reset(){
  epoch++;controller.abort();controller=new AbortController();
  access='checking';nodes=placeholder(REASONS.checking);health='checking';sync=null;
  busy.fleet=-1;busy.health=-1;
  if(dialog?.open)dialog.close();
  publish();
 }
 async function admit(mine){
  try{const session=await transport.loadSession(controller.signal);return mine===epoch?classify(session):null;}
  catch{return mine===epoch?'offline':null;}
 }
 const reason=error=>String(typeof error?.message==='string'?error.message:'request failed').slice(0,200);
 async function request(path,body){
  const mine=epoch,value=await transport.request(path,body,controller.signal);
  if(mine!==epoch)throw new Error('Account changed; response discarded.');
  return value;
 }
 async function pollFleet(){
  const mine=epoch;if(busy.fleet===mine)return;busy.fleet=mine;
  try{
   const level=await admit(mine);if(level===null)return;
   access=level;
   if(level!=='owner'){nodes=placeholder(REASONS[level]);publish();return;}
   const response=await transport.request('/fleet',undefined,controller.signal);
   if(mine!==epoch)return;
   nodes=normalizeFleet(response);publish();
  }catch(error){
   if(mine!==epoch)return;
   nodes=placeholder('Fleet status is unavailable: '+reason(error));publish();
  }finally{if(busy.fleet===mine)busy.fleet=-1;}
 }
 async function pollHealth(){
  const mine=epoch;if(busy.health===mine)return;busy.health=mine;
  try{
   const level=await admit(mine);if(level===null)return;
   access=level;
   if(level==='offline'||level==='signin'||level==='pending'){health='offline';sync=null;publish();return;}
   const response=await transport.request('/health',undefined,controller.signal);
   if(mine!==epoch)return;
   health=healthState(response);sync=response?.sync&&typeof response.sync==='object'&&!Array.isArray(response.sync)?response.sync:null;publish();
  }catch(error){
   if(mine!==epoch)return;
   health='unknown';publish();
  }finally{if(busy.health===mine)busy.health=-1;}
 }
 const pollAll=()=>Promise.all([pollFleet(),pollHealth()]);

 // ---- rendering -------------------------------------------------------------
 function mount(){
  const right=doc.querySelector('main header .topbar-right'),header=doc.querySelector('main header');
  bar=el('div',{class:'fleet-bar',id:'fleet-bar',role:'group','aria-label':'Node connections'});
  for(const id of NODES){
   const button=el('button',{type:'button',class:'fleet-node unknown','data-node':id},el('span',{class:'fleet-led','aria-hidden':'true'}),el('span',{class:'fleet-label'},id.toUpperCase()));
   button.addEventListener('click',()=>openEvidence(id));
   buttons.set(id,button);bar.append(button);
  }
  forgeText=el('span',{class:'forge-connection',id:'forge-connection',role:'status','aria-live':'polite'},HEALTH_TEXT.checking);
  bar.append(forgeText);
  if(right&&typeof right.before==='function')right.before(bar);else header?.append(bar);
 }
 function render(){
  if(!bar)return;
  for(const node of nodes){
   const button=buttons.get(node.id);if(!button)continue;
   const label=`${node.id.toUpperCase()}: ${node.connection}`;
   button.className='fleet-node '+node.connection;
   button.setAttribute('aria-label',label+(node.connection==='unknown'?' · evidence available':''));
   button.title=label+(node.role?` · ${node.role}`:'');
  }
  const line=HEALTH_TEXT[health]||HEALTH_TEXT.unknown;
  if(forgeText.textContent!==line)forgeText.textContent=line;
  forgeText.className='forge-connection'+(health==='loaded'?' online':'');
 }
 function evidenceRows(node){
  const latency=Number.isFinite(node.latency_ms)?`${node.latency_ms} ms`:null;
  return [['Connection',node.connection],['Evidence',node.evidence||node.reason||'Awaiting live probe'],['Role',node.role],['Checked',node.checked_at],['Observed',node.observed_at],['Latency',latency],['Host',node.hostname],['Operating system',node.os],['LAN address',node.lan_address],['Tailscale address',node.tailscale_address],['SSH user',node.ssh_user],['Address source',node.address_source],['Remote control',node.remote_control],['Error',node.error]]
   .filter(([,value])=>(typeof value==='string'&&value)||typeof value==='number');
 }
 function ensureDialog(){
  if(dialog)return;
  dialogTitle=el('h2',{id:'fleet-evidence-title'},'Node evidence');
  const close=el('button',{type:'button',class:'icon-button close-dialog','aria-label':'Close node evidence'},'×');
  dialogBody=el('div',{class:'fleet-evidence-body'});
  dialog=el('dialog',{class:'panel-dialog fleet-evidence','aria-labelledby':'fleet-evidence-title'},el('div',{class:'dialog-title'},el('div',{},el('span',{class:'eyebrow'},'LIVE EVIDENCE'),dialogTitle),close),dialogBody);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
  dialog.addEventListener('close',()=>dialogBody.replaceChildren());
  doc.body.append(dialog);
 }
 function openEvidence(id){
  const node=nodes.find(n=>n.id===id);if(!node)return;
  ensureDialog();
  dialogTitle.textContent=id.toUpperCase();
  const list=el('dl',{class:'fleet-evidence-list'});
  for(const [name,value] of evidenceRows(node))list.append(el('dt',{},name),el('dd',{},String(value)));
  const children=[el('p',{class:'fleet-evidence-state '+node.connection},node.connection==='connected'?'Connected':node.connection==='disconnected'?'Disconnected':'Unknown'),list];
  if(typeof node.health==='string'&&node.health)children.push(el('h3',{},'Probe output'),el('pre',{class:'workspace-receipt'},node.health.slice(0,5000)));
  let raw='';try{raw=JSON.stringify(node,null,2).slice(0,20000);}catch{raw='';}
  if(raw)children.push(el('details',{},el('summary',{},'Raw probe record'),el('pre',{class:'workspace-receipt'},raw)));
  dialogBody.replaceChildren(...children);
  if(!dialog.open)dialog.showModal();
 }

 // ---- lifecycle -------------------------------------------------------------
 function start(){
  mount();render();
  setInterval(()=>{if(!doc.hidden)void pollFleet();},FLEET_MS);
  setInterval(()=>{if(!doc.hidden)void pollHealth();},HEALTH_MS);
  window.addEventListener('echo-account-changed',()=>{
   // workspace.js dispatches this only for a real identity change, and its cached session is the identity the page
   // now renders. When this bar already reflects that identity there is nothing to re-admit, so a repeated event can
   // never restart polling (the 2026-11-04 request storm re-read /api/session twice per event here).
   const key=identityKey(window.EchoPrimeWorkspace?.session);
   if(key===lastKey){console.debug('[echo.fleet]',{event:'account_event',outcome:'unchanged'});return;}
   reset();later(pollAll);
  });
  doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)void pollAll();});
  window.addEventListener('pagehide',()=>reset());
  window.addEventListener('pageshow',event=>{if(event.persisted)void pollAll();});
  const warm=Promise.resolve(window.EchoPrimeWorkspace?.ready).catch(()=>false).then(()=>transport.loadSession(controller.signal)).catch(()=>null);
  void warm.then(pollAll);
 }

 window.EchoPrimeFleet={
  NODES,FLEET_MS,HEALTH_MS,el,subscribe,snapshot,request,pollAll,pollFleet,pollHealth,
  core:{connectionState,normalizeFleet,healthState,classify,placeholder},
 };
 start();
})();
