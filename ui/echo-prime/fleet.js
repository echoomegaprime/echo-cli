(() => {
 'use strict';
 const NODES=['quench','forge','anvil','hammer','temper','crucible'];
 const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 function text(value,limit=180){
  if(typeof value!=='string')return '';
  return value.replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[redacted]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit);
 }
 function timestamp(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;}
 function normalizeFleet(value,now=Date.now()){
  const rows=Array.isArray(value?.nodes)?value.nodes:[];
  return {observedAt:timestamp(value?.observed_at),nodes:NODES.map(id=>{
   const row=rows.find(item=>object(item)&&item.id===id)||{};
   const checkedAt=timestamp(row.checked_at)||timestamp(row.observed_at),age=checkedAt?now-Date.parse(checkedAt):Infinity;
   const stale=age>120000||age< -30000;
   const connection=!stale&&['connected','disconnected'].includes(row.connection)?row.connection:'unknown';
   return {id,connection,stale,checkedAt,evidence:text(row.evidence)||'Awaiting a fresh live probe',role:text(row.role),latencyMs:count(row.latency_ms),hostname:text(row.hostname||row.identity?.hostname),os:text(row.os||row.identity?.os),addressSource:text(row.address_source)};
  })};
 }
 function modelState(value){
  const model=object(value?.model)?value.model:null,context=count(model?.context_length),configuredContext=count(model?.configured_context_length);
  let state='unknown',label='FORGE · Status unavailable';
  if(model?.loaded===false){state='needed';label='FORGE · Connection needed';}
  else if(model?.loaded===true){
   const ready=model.ok===true&&model.exclusive_model===true&&context>0&&configuredContext===context;
   state=ready?'ready':'attention';label=ready?`FORGE · Model loaded · ${context.toLocaleString()} context`:'FORGE · Model loaded · Check configuration';
  }
  return {state,label,model:text(model?.model,140),context,configuredContext,exclusive:model?.exclusive_model===true};
 }
 function syncSummary(value){
  const verified=count(value?.verified),remaining=count(value?.remaining),privateLocal=value?.mode==='private_local';
  let label='Journal · Delivery status unavailable';
  if(privateLocal)label='Private journal & memories';
  else if(verified!==null&&remaining!==null)label=remaining?`Journal saved · ${remaining.toLocaleString()} awaiting ECF`:verified?'Journal · ECF readback verified':'Journal & ECF receipts';
  return {verified,remaining,privateLocal,label,blocked:count(value?.blocked),retry:count(value?.retry)};
 }
 function diagnosticSummary(value){
  const source=object(value?.mission)?value.mission:{},mission={};
  for(const key of ['configured','ready'])if(typeof source[key]==='boolean')mission[key]=source[key];
  for(const key of ['run_id','role'])if(typeof source[key]==='string')mission[key]=text(source[key]);
  if(source.error)mission.issue=true;
  const fields=['observed_at_utc','operation','status','capability','http_status','duration_ms','count','verification'];
  const operations=(Array.isArray(value?.operations)?value.operations:[]).filter(object).slice(-100).reverse().map(row=>{
   const result={};for(const field of fields){if(typeof row[field]==='string')result[field]=text(row[field],220);else if(typeof row[field]==='number'&&Number.isFinite(row[field]))result[field]=row[field];}return result;
  });
  return {mission,sync:syncSummary(value?.sync),operations};
 }
 function debug(operation,outcome,extra={}){console.debug('[echo.prime.fleet]',{schema_version:1,observed_at_utc:new Date().toISOString(),event:'fleet_observation',operation,outcome,...extra});}
 function createController({workspace,now=()=>Date.now(),onUpdate=()=>{}}){
  let generation=0,abort=new AbortController(),pending=null,pendingHealth=false;
  const initial=()=>({fleet:normalizeFleet(null,now()),model:modelState(null),sync:syncSummary(null),checkedAt:null,fleetError:false,healthError:false});
  let snapshot=initial();
  const owner=()=>{
   const session=workspace.session;
   return workspace.enabled===true&&session?.workspaceConfigured===true&&session.authenticated===true&&session.ownerAccess===true&&session.user?.status==='approved'&&typeof session.user.uid==='string'?session.user.uid:null;
  };
  const publish=()=>onUpdate(snapshot);
  function invalidate(){generation++;abort.abort();abort=new AbortController();pending=null;snapshot=initial();publish();debug('identity','cleared');}
  async function read(path,body){
   const uid=owner(),epoch=generation,signal=abort.signal;
   if(!uid)throw new Error('Approved primary owner admission required.');
   const requestAbort=new AbortController(),cancel=()=>requestAbort.abort();
   if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
   const deadline=setTimeout(cancel,path==='/sync'?45000:12000);
   try{
    const result=await workspace.request(path,body,requestAbort.signal);
    if(requestAbort.signal.aborted||epoch!==generation||owner()!==uid)throw new Error('Owner session changed; observation discarded.');
    return result;
   }finally{clearTimeout(deadline);signal.removeEventListener('abort',cancel);}
  }
  async function refresh(health=true){
   if(!owner()){invalidate();return;}
   if(pending){const active=pending;if(health&&!pendingHealth){await active;if(owner())return refresh(true);}return active;}
   pendingHealth=health;
   const epoch=generation;
   const work=(async()=>{
    try{const value=await read('/fleet');if(epoch!==generation)return;snapshot={...snapshot,fleet:normalizeFleet(value,now()),checkedAt:new Date(now()).toISOString(),fleetError:false};debug('fleet','read',{nodes:snapshot.fleet.nodes.length});}
    catch{if(epoch!==generation)return;snapshot={...snapshot,fleet:normalizeFleet(null,now()),fleetError:true};debug('fleet','unavailable');}
    publish();
    if(!health||!owner()||epoch!==generation)return;
    try{const value=await read('/health');if(epoch!==generation)return;snapshot={...snapshot,model:modelState(value),sync:syncSummary(value?.sync),healthError:false};debug('health','read',{model_state:snapshot.model.state});}
    catch{if(epoch!==generation)return;snapshot={...snapshot,model:modelState(null),sync:syncSummary(null),healthError:true};debug('health','unavailable');}
    publish();
   })();pending=work;
   try{await work;}finally{if(pending===work)pending=null;}
  }
  async function diagnostics(){
   try{const result=diagnosticSummary(await read('/diagnostics'));debug('diagnostics','read',{count:result.operations.length});return result;}
   catch{if(!owner())throw new Error('Approved primary owner admission required.');debug('diagnostics','unavailable');throw new Error('Diagnostics are unavailable. No repair was attempted.');}
  }
  let syncing=false;
  async function retrySync(){
   if(!owner())throw new Error('Approved primary owner admission required.');
   if(syncing)throw new Error('One synchronization pass is already pending.');
   syncing=true;
   try{
    await read('/sync',{});debug('sync','write_returned');
    const value=await read('/health');snapshot={...snapshot,model:modelState(value),sync:syncSummary(value?.sync),healthError:false};publish();debug('sync','readback',{verified:snapshot.sync.verified,remaining:snapshot.sync.remaining});
    return snapshot.sync;
   }catch{snapshot={...snapshot,sync:syncSummary(null),healthError:true};publish();debug('sync','unconfirmed');throw new Error('Synchronization is unconfirmed. No automatic retry was made; refresh the delivery status before trying again.');}
   finally{syncing=false;}
  }
  return {get admitted(){return !!owner();},get snapshot(){return snapshot;},refresh,invalidate,diagnostics,retrySync};
 }
 const api={normalizeFleet,modelState,syncSummary,diagnosticSummary,createController};
 window.EchoPrimeFleet=api;
 if(typeof document==='undefined')return;
 function element(tag,attributes={},...children){
  const node=document.createElement(tag);for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);return node;
 }
 async function mount(){
  const workspace=window.EchoPrimeWorkspace;if(!workspace||document.querySelector('#prime-fleet-bar'))return;
  const topbar=document.querySelector('.topbar'),navigation=document.querySelector('#workspace-navigation');if(!topbar||!navigation)return;
  const bar=element('section',{id:'prime-fleet-bar',class:'prime-fleet-bar',hidden:true,'aria-label':'Live fleet observations','data-owner-only':''});
  const nodes=element('div',{class:'prime-fleet-nodes','aria-label':'Node connections'}),forge=element('button',{type:'button',class:'prime-forge-status unknown'},'FORGE · Status unavailable');
  const note=element('span',{class:'prime-fleet-note'},'Awaiting live observations');bar.append(nodes,forge,note);topbar.after(bar);
  const logs=element('button',{type:'button',class:'nav-item',hidden:true,'data-owner-only':'','data-workspace-view':'logs','aria-controls':'workspace-main-view'},'Logs & debugging');
  const journal=element('button',{type:'button',class:'nav-item prime-journal-status',hidden:true,'data-owner-only':'','data-workspace-view':'journal','aria-controls':'workspace-main-view'},'Journal & ECF receipts');navigation.append(logs,journal);
  const title=element('h2',{id:'prime-observations-title'},'Fleet observations'),close=element('button',{type:'button',class:'quiet-button','aria-label':'Close fleet observations'},'Close');
  const status=element('p',{class:'prime-observations-status',role:'status','aria-live':'polite'}),body=element('div',{class:'prime-observations-body'});
  const dialog=element('dialog',{id:'prime-observations-dialog',class:'panel-dialog workspace-dialog prime-observations-dialog','aria-labelledby':'prime-observations-title'},element('div',{class:'dialog-title'},title,close),status,body);document.body.append(dialog);
  close.addEventListener('click',()=>dialog.close());
  const nodeButtons=new Map();let viewEpoch=0,controller,page=null,pageRequest=0;
  const render=snapshot=>{
   const admitted=controller?.admitted===true;bar.hidden=!admitted;logs.hidden=!admitted;journal.hidden=!admitted;
   if(!admitted){clearPage();body.replaceChildren();status.textContent='';if(dialog.open)dialog.close();}
   for(const node of snapshot.fleet.nodes){const button=nodeButtons.get(node.id);if(!button)continue;button.className='prime-fleet-node '+node.connection;button.setAttribute('aria-label',`${node.id.toUpperCase()}: ${node.connection}${node.stale?' · awaiting fresh evidence':''}`);button.title=button.getAttribute('aria-label');button.querySelector('.prime-fleet-state').textContent=node.connection;}
   forge.textContent=snapshot.model.label;forge.className='prime-forge-status '+snapshot.model.state;
   journal.textContent=snapshot.sync.label;journal.title='Journal & ECF receipts';
   note.textContent=snapshot.fleetError?'Fleet observations unavailable':snapshot.checkedAt?'Last checked '+new Date(snapshot.checkedAt).toLocaleTimeString():'Awaiting live observations';
  };
  controller=createController({workspace,onUpdate:render});
  function card(name,...children){return element('article',{class:'prime-evidence-card'},element('h3',{},name),...children);}
  const paragraph=value=>element('p',{},value),details=value=>element('pre',{class:'workspace-receipt'},JSON.stringify(value,null,2));
  function show(name){if(!controller.admitted)return false;viewEpoch++;title.textContent=name;status.textContent='';body.replaceChildren();if(!dialog.open)dialog.showModal();return true;}
  const currentPage=handle=>controller.admitted&&handle===page&&handle?.isCurrent();
  function clearPage(){pageRequest++;const previous=page;page=null;if(previous?.isCurrent())previous.close();}
  async function openPage(id,name,subtitle){
   if(!controller.admitted||typeof workspace.presentView!=='function'){debug('page','unavailable');return null;}
   const request=++pageRequest;page=null;if(dialog.open)dialog.close();
   const handle=await workspace.presentView({id,title:name,subtitle,ownerOnly:true});
   if(request!==pageRequest||!controller.admitted||!handle?.isCurrent())return null;
   page=handle;debug('page','opened',{view:id});return handle;
  }
  function pageAction(label,handle,fn){
   const button=element('button',{type:'button',class:'quiet-button'},label);
   button.addEventListener('click',async()=>{if(button.disabled||!currentPage(handle))return;button.disabled=true;try{await fn();}catch{if(currentPage(handle))handle.setStatus('Observation unavailable. No repair or automatic retry was attempted.');}finally{if(currentPage(handle))button.disabled=false;}});return button;
  }
  for(const id of NODES){
   const button=element('button',{type:'button',class:'prime-fleet-node unknown'},element('span',{class:'prime-fleet-led','aria-hidden':'true'}),element('span',{},id.toUpperCase()),element('span',{class:'prime-fleet-state'},'unknown'));nodeButtons.set(id,button);nodes.append(button);
   button.addEventListener('click',async()=>{
    if(!show(id.toUpperCase()+' · connection evidence'))return;const epoch=viewEpoch;status.textContent='Reading current probe…';await controller.refresh(false);if(epoch!==viewEpoch||!controller.admitted)return;
    const node=controller.snapshot.fleet.nodes.find(row=>row.id===id);status.textContent=node.connection==='unknown'?'Current connection is unknown.':node.connection==='connected'?'A fresh live probe reported connected.':'The latest live probe reported disconnected.';
    body.append(card('Probe evidence',paragraph(node.evidence),details({connection:node.connection,checked_at:node.checkedAt,stale:node.stale,latency_ms:node.latencyMs,role:node.role||null,hostname:node.hostname||null,os:node.os||null})),paragraph('Registry and inventory entries establish enrollment. Remote control and service readiness require their own checks.'));
   });
  }
  forge.addEventListener('click',async()=>{
   if(!show('FORGE · Model connection'))return;const epoch=viewEpoch;status.textContent='Checking the configured model…';await controller.refresh(true);if(epoch!==viewEpoch||!controller.admitted)return;const model=controller.snapshot.model;status.textContent=model.label;
   body.append(card('Configured inference lane',details({model:model.model||null,context_length:model.context,configured_context_length:model.configuredContext,exclusive_model:model.exclusive,state:model.state})),paragraph('Loaded and ready are separate: readiness requires the configured model, context and exclusive lane to agree. This observation does not send a model prompt.'));
  });
  async function loadDiagnostics(handle){
   if(!currentPage(handle))return;handle.setStatus('Reading diagnostics…');
   try{const value=await controller.diagnostics();if(!currentPage(handle))return;
    const operations=element('div',{class:'prime-operation-list'});
    if(!value.operations.length)operations.append(paragraph('No recent operation metadata was returned.'));
    for(const row of value.operations)operations.append(card(row.operation||'Operation',paragraph([row.status,row.observed_at_utc].filter(Boolean).join(' · ')),details(row)));
    handle.body.replaceChildren(pageAction('Refresh',handle,()=>loadDiagnostics(handle)),card('Mission & memory sync',paragraph('Write submission and exact memory readback are separate outcomes.'),details({mission:value.mission,sync:value.sync})),card('Recent operations',paragraph('Metadata only. Message bodies, credential fields and raw error output are excluded.'),operations));handle.setStatus('Diagnostics read. Repair claims require their own verification.');
   }catch{if(!currentPage(handle))return;handle.setStatus('Diagnostics are unavailable. No repair was attempted.');handle.body.replaceChildren(pageAction('Refresh',handle,()=>loadDiagnostics(handle)));}
  }
  logs.addEventListener('click',async()=>{try{const handle=await openPage('logs','Logs & debugging','Read current mission, memory synchronization and recent operation receipts.');if(currentPage(handle))await loadDiagnostics(handle);}catch{debug('logs_page','unavailable');}});
  function renderJournal(handle){
   if(!currentPage(handle))return;const sync=controller.snapshot.sync;
   const summary=sync.privateLocal?'This account keeps journals and memories in its private local store.':sync.verified===null||sync.remaining===null?'Delivery counts are unavailable. No ECF success is inferred.':`${sync.verified.toLocaleString()} records have exact ECF readback. ${sync.remaining.toLocaleString()} are awaiting confirmation.`;
   const metric=(name,value)=>card(name,element('p',{class:'prime-journal-count'},value===null?'Unavailable':value.toLocaleString()));
   handle.body.replaceChildren(element('div',{class:'prime-journal-counts'},metric('Exact ECF readback',sync.verified),metric('Awaiting confirmation',sync.remaining)),card('Journal & ECF delivery',paragraph(summary),paragraph('Original messages and Markdown journals stay in the Workspace. An accepted write is separate from exact retrieval; only verified records count as ECF readback.'),details({verified:sync.verified,remaining:sync.remaining,blocked:sync.blocked,retry:sync.retry})),pageAction('Refresh delivery status',handle,()=>refreshJournal(handle)),...(!sync.privateLocal?[pageAction('Retry pending records · one pass',handle,async()=>{
    if(!currentPage(handle))return;handle.setStatus('Running one eligible synchronization pass…');
    try{await controller.retrySync();if(!currentPage(handle))return;renderJournal(handle);handle.setStatus('Synchronization returned. Counts above come from a separate health readback.');}
    catch{if(currentPage(handle))handle.setStatus('Synchronization is unconfirmed. No automatic retry was made. Refresh delivery status before trying again.');}
   })]:[]));
  }
  async function refreshJournal(handle){if(!currentPage(handle))return;handle.setStatus('Checking delivery receipts…');await controller.refresh(true);if(!currentPage(handle))return;renderJournal(handle);handle.setStatus('Current delivery observation. Receipt details remain with the canonical Workspace.');}
  journal.addEventListener('click',async()=>{try{const handle=await openPage('journal','Journal & ECF receipts','Review local journals, pending delivery and exact Continuity Fabric readback.');if(currentPage(handle))await refreshJournal(handle);}catch{debug('journal_page','unavailable');}});
  dialog.addEventListener('close',()=>{viewEpoch++;body.replaceChildren();status.textContent='';});
  function identityChanged(){viewEpoch++;clearPage();controller.invalidate();queueMicrotask(()=>{if(!document.hidden&&controller.admitted)void controller.refresh(true);});}
  window.addEventListener('echo-account-changed',identityChanged);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)controller.invalidate();else if(controller.admitted)void controller.refresh(true);});
  let ticks=0,timer=null;
  const startPolling=()=>{if(timer===null)timer=window.setInterval(()=>{if(document.hidden||!controller.admitted)return;void controller.refresh(++ticks%4===0);},15000);};startPolling();
  window.addEventListener('pagehide',()=>{window.clearInterval(timer);timer=null;clearPage();controller.invalidate();});
  window.addEventListener('pageshow',event=>{if(event.persisted){startPolling();if(!document.hidden&&controller.admitted)void controller.refresh(true);}});
  await workspace.ready;render(controller.snapshot);if(!document.hidden&&controller.admitted)await controller.refresh(true);debug('mount','ready');
 }
 api.mount=mount;
 void mount().catch(()=>debug('mount','unavailable'));
})();
