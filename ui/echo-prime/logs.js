(() => {
 'use strict';
 // "Logs & debugging" page and the "Journal & ECF receipts" status/delivery
 // dialog. Both read the canonical Workspace through the shared fleet
 // transport. Diagnostics and ECF retry are owner-only upstream; other accounts
 // see only their private-memory explanation and never a fabricated receipt.
 const doc=document,fleet=window.EchoPrimeFleet;
 if(!fleet)return;
 const {el}=fleet;
 const GOOD=/^(ok|returned|verified|completed|complete|success|succeeded|sent|connected|ready)$/i,BAD=/(error|fail|blocked|denied|forbidden|timeout|timed_out|uncertain|unavailable)/i;

 // ---- pure mapping (exported for tests) -------------------------------------
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 function syncLabel(sync){
  if(!sync||typeof sync!=='object')return 'Journal & ECF receipts';
  if(sync.mode==='private_local')return 'Private journal & memories';
  const remaining=count(sync.remaining);
  return remaining?`Journal saved · ${remaining} awaiting ECF`:'Journal & ECF receipts';
 }
 function operationTone(status){
  if(typeof status!=='string'||!status)return 'neutral';
  return BAD.test(status)?'bad':GOOD.test(status)?'good':'neutral';
 }
 function formatTime(value){
  return typeof value==='string'&&/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(value)?value.slice(0,10)+' '+value.slice(11,19)+' UTC':'time not recorded';
 }
 function operationDetails(item){
  const parts=[];
  for(const [key,label] of [['capability',''],['command',''],['source',''],['admission','admission '],['verification','verified by '],['error_category','error ']]){
   if(typeof item[key]==='string'&&item[key])parts.push(label+item[key].slice(0,160));
  }
  if(count(item.http_status)!==null)parts.push('HTTP '+item.http_status);
  if(Number.isFinite(item.duration_ms))parts.push(Math.round(item.duration_ms)+' ms');
  if(count(item.count)!==null)parts.push(item.count+' items');
  if(count(item.bytes)!==null)parts.push(item.bytes+' bytes');
  return parts.join(' · ');
 }
 const ownerCapable=snapshot=>snapshot.access==='owner';

 // ---- state -----------------------------------------------------------------
 let current=fleet.snapshot(),generation=current.generation,loadId=0,syncNote='',retrying=false;
 let journalButton=null,logsButton=null,logsDialog=null,logsBody=null,logsStatus=null,syncDialog=null,syncBody=null,syncTitle=null;

 function dialogShell(id,eyebrow,title,closeLabel,toolbar){
  const heading=el('h2',{id:id+'-title'},title);
  const close=el('button',{type:'button',class:'icon-button close-dialog','aria-label':closeLabel},'×');
  const body=el('div',{class:'logs-body'});
  const dialog=el('dialog',{id,class:'panel-dialog workspace-dialog logs-dialog','aria-labelledby':id+'-title'},el('div',{class:'dialog-title'},el('div',{},el('span',{class:'eyebrow'},eyebrow),heading),close),toolbar,body);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
  dialog.addEventListener('close',()=>{loadId++;body.replaceChildren();});
  doc.body.append(dialog);
  return {dialog,body,heading};
 }

 // ---- Logs & debugging ------------------------------------------------------
 function row(label,value){return value===null||value===undefined||value===''?null:el('div',{class:'logs-row'},el('span',{},label),el('strong',{},String(value)));}
 function card(title,note,...children){return el('article',{class:'workspace-card-content logs-card'},el('h3',{},title),note?el('p',{},note):null,...children);}
 const yesNo=value=>value===true?'yes':value===false?'no':'unknown';
 function missionCard(mission){
  if(!mission||typeof mission!=='object')return card('Mission & memory sync','Mission status was not reported.');
  return card('Mission & memory sync','Readback status is separate from a submitted write.',
   el('div',{class:'logs-rows'},row('Mission linked',yesNo(mission.configured)),row('Ready',yesNo(mission.ready)),row('Role',mission.role),row('Run',mission.run_id),row('Problem',mission.error)));
 }
 const SYNC_ORDER=['pending','written','retry','blocked'];
 function syncCounts(sync){
  const rows=[row('Verified with exact ECF readback',count(sync.verified)),row('Awaiting confirmation',count(sync.remaining))];
  const extra=Object.keys(sync).filter(k=>!['verified','remaining','last_issue','mode'].includes(k)&&count(sync[k])!==null).sort((a,b)=>(SYNC_ORDER.indexOf(a)+1||99)-(SYNC_ORDER.indexOf(b)+1||99)||a.localeCompare(b));
  for(const key of extra)rows.push(row(key.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()),sync[key]));
  if(typeof sync.last_issue==='string'&&sync.last_issue)rows.push(row('Latest issue',sync.last_issue.slice(0,600)));
  return el('div',{class:'logs-rows'},rows);
 }
 function syncCard(sync){
  if(!sync||typeof sync!=='object')return card('Journal & ECF delivery','Delivery status was not reported.');
  if(sync.mode==='private_local')return card('Journal & ECF delivery','This account keeps its journals and memories privately; nothing is delivered to shared ECF.');
  return card('Journal & ECF delivery','A successful write is shown separately from verified retrieval.',syncCounts(sync));
 }
 function operationCard(operation){
  const tone=operationTone(operation.status),details=operationDetails(operation);
  return el('article',{class:'workspace-card-content logs-operation '+tone},
   el('div',{class:'logs-operation-head'},el('h3',{},typeof operation.operation==='string'&&operation.operation?operation.operation.slice(0,160):'Operation'),el('span',{class:'logs-pill '+tone},typeof operation.status==='string'&&operation.status?operation.status.slice(0,60):'no status')),
   el('small',{},formatTime(operation.observed_at_utc)),details?el('p',{},details):null);
 }
 function operationsCard(operations,busyChats){
  const list=Array.isArray(operations)?operations.filter(o=>o&&typeof o==='object'&&!Array.isArray(o)):[];
  const cards=list.slice(-100).reverse().map(operationCard);
  const busy=Array.isArray(busyChats)&&busyChats.length?`${busyChats.length} conversation${busyChats.length===1?' is':'s are'} generating now.`:'';
  return card('Recent operations','Metadata only. Credential values and message bodies are excluded.'+(busy?' '+busy:''),
   cards.length?el('div',{class:'logs-operations'},cards):el('p',{class:'logs-empty'},'No operations have been recorded yet.'));
 }
 async function loadLogs(){
  if(!logsDialog)return;
  const mine=++loadId,gen=generation;
  logsStatus.textContent='Loading diagnostics…';
  try{
   const value=await fleet.request('/diagnostics');
   if(mine!==loadId||gen!==generation||!logsDialog.open)return;
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Diagnostics response was not understood.');
   logsBody.replaceChildren(missionCard(value.mission),syncCard(value.sync),operationsCard(value.operations,value.busy_chats));
   logsStatus.textContent='Read from the Workspace at '+new Date().toLocaleTimeString()+'.';
  }catch(error){
   if(mine!==loadId||gen!==generation||!logsDialog.open)return;
   logsBody.replaceChildren(card('Diagnostics unavailable',(typeof error?.message==='string'?error.message:'The request failed.').slice(0,300)+' No automatic retry was made.'));
   logsStatus.textContent='Diagnostics could not be read.';
  }
 }
 function openLogs(){
  if(!ownerCapable(current))return;
  if(!logsDialog){
   const refresh=el('button',{type:'button',class:'quiet-button'},'Refresh');
   logsStatus=el('p',{class:'dialog-description',role:'status','aria-live':'polite'});
   const shell=dialogShell('logs-dialog','OWNER DIAGNOSTICS','Logs & debugging','Close logs and debugging',el('div',{class:'logs-toolbar'},refresh,logsStatus));
   logsDialog=shell.dialog;logsBody=shell.body;
   refresh.addEventListener('click',()=>void loadLogs());
  }
  if(!logsDialog.open)logsDialog.showModal();
  void loadLogs();
 }

 // ---- Journal & ECF delivery ------------------------------------------------
 function renderSync(){
  if(!syncDialog)return;
  const sync=current.sync;
  if(!sync){
   syncTitle.textContent='Journal & ECF receipts';
   syncBody.replaceChildren(el('p',{},'Delivery status has not been read from the Workspace yet. Nothing is assumed.'));return;
  }
  if(sync.mode==='private_local'){
   syncTitle.textContent='Your private memories';
   syncBody.replaceChildren(el('p',{},'Chats, Markdown journals and saved memories persist in your account’s own storage. Echo checks your saved memories and previous chats automatically.'),el('p',{class:'logs-muted'},'This account does not send or retrieve memories through the owner’s shared ECF or Crystal services.'));return;
  }
  syncTitle.textContent='Journal & ECF delivery';
  const verified=count(sync.verified),remaining=count(sync.remaining);
  const nodes=[
   el('p',{},`Every new chat starts a Markdown journal. ${verified===null?'An unknown number of':verified} records have exact ECF readback; ${remaining===null?'an unknown number are':remaining+' are'} awaiting confirmation.`),
   el('p',{class:'logs-muted'},'Original messages stay on disk when a checkpoint is created. ECF retries while the Workspace runs. A successful write is shown separately from verified retrieval.'),
   syncCounts(sync),
  ];
  if(ownerCapable(current)){
   const retry=el('button',{type:'button',class:'quiet-button'},'Retry pending records');
   retry.disabled=retrying;
   retry.addEventListener('click',()=>void retrySync(retry));
   nodes.push(retry);
  }
  if(syncNote)nodes.push(el('p',{role:'status'},syncNote));
  syncBody.replaceChildren(...nodes);
 }
 async function retrySync(button){
  if(retrying||button.disabled||!ownerCapable(current))return;
  const gen=generation;retrying=true;button.disabled=true;syncNote='Checking ECF delivery…';renderSync();
  try{
   await fleet.request('/sync',{});
   if(gen!==generation)return;
   syncNote='The delivery check returned. Counts are being read back from the Workspace.';renderSync();
   await fleet.pollHealth();
   if(gen!==generation)return;
   syncNote='The delivery check returned and the counts above were read back from the Workspace.';
  }catch(error){
   if(gen!==generation)return;
   syncNote='Delivery check failed: '+(typeof error?.message==='string'?error.message:'request failed').slice(0,200)+' No automatic retry was made.';
  }finally{retrying=false;}
  renderSync();
 }
 function openSync(){
  if(!syncDialog){
   const shell=dialogShell('sync-dialog','JOURNAL','Journal & ECF delivery','Close journal delivery');
   syncDialog=shell.dialog;syncBody=shell.body;syncTitle=shell.heading;
   syncDialog.addEventListener('close',()=>{syncNote='';});
  }
  syncNote='';renderSync();
  if(!syncDialog.open)syncDialog.showModal();
  void fleet.pollHealth();
 }

 // ---- mount and follow the shared snapshot ---------------------------------
 function mount(){
  const sidebar=doc.querySelector('.sidebar-bottom');
  journalButton=el('button',{type:'button',class:'nav-item journal-status',id:'journal-status'},'Journal & ECF receipts');
  journalButton.hidden=true;
  journalButton.addEventListener('click',openSync);
  if(sidebar&&typeof sidebar.before==='function')sidebar.before(journalButton);else doc.querySelector('#sidebar')?.append(journalButton);
  logsButton=el('button',{type:'button',class:'nav-item',id:'logs-open','data-owner-only':'true'},'Logs & debugging');
  logsButton.hidden=true;
  logsButton.addEventListener('click',openLogs);
  const navigation=doc.querySelector('#workspace-navigation');
  if(navigation)navigation.append(logsButton);else doc.querySelector('#sidebar')?.append(logsButton);
 }
 function apply(snapshot){
  if(snapshot.generation!==generation){
   generation=snapshot.generation;syncNote='';
   if(logsDialog?.open)logsDialog.close();
   if(syncDialog?.open)syncDialog.close();
  }
  current=snapshot;
  journalButton.hidden=!(snapshot.access==='owner'||snapshot.access==='member');
  journalButton.textContent=syncLabel(snapshot.sync);
  logsButton.hidden=!ownerCapable(snapshot);
  if(logsDialog?.open&&!ownerCapable(snapshot))logsDialog.close();
  if(syncDialog?.open)renderSync();
 }
 mount();
 fleet.subscribe(apply);
 window.EchoPrimeLogs={syncLabel,operationTone,operationDetails,formatTime,open:openLogs,openSync};
})();
