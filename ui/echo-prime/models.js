(() => {
 'use strict';
 // Model picker. The server decides what each provider id means; this file only offers the reviewed ids,
 // remembers the choice in this browser, and states plainly which model answered or why one is unavailable.
 // 'auto' = "Auto (Echo decides)": offered, and the owner's default, only when the server reports models.auto enabled.
 const storageKey='echo-prime-model-v1',variantKey='echo-prime-argon-model-v1',ids=['auto','qwen','claude','gpt','grok','argon','swarm'],COOLDOWN_MS=5000;
 const fallbackLabels={auto:'Auto (Echo decides)',qwen:'Qwen (FORGE, 256K)',claude:'Claude (claude CLI)',gpt:'GPT (codex CLI)',grok:'Grok (grok CLI)',argon:'Argon (Gemini 4, agy CLI)',swarm:'Swarm (40-seat brain)'};
 const autoEnabled=()=>!!(report&&report.auto&&report.auto.enabled===true);
 const shortName=label=>String(label||'').replace(/\s*\(.*$/,'').trim()||String(label||'');
 // `gate` is '' when the status route may be read, else 'signin' or 'member': the honest picker state for someone the
 // owner-only route would refuse. `failedAt` starts the cool-down after a failed read.
 let swarmState=null,chosen=null,chosenVariant=null,report=null,failed=false,gate='',generation=0,failedAt=-Infinity;
 try{const stored=localStorage.getItem(storageKey);if(ids.includes(stored))chosen=stored;}catch{}
 try{const stored=localStorage.getItem(variantKey);if(typeof stored==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(stored))chosenVariant=stored;}catch{}
 const wrap=document.createElement('div'),label=document.createElement('label'),select=document.createElement('select'),note=document.createElement('small');
 wrap.className='model-picker';wrap.setAttribute('style','display:flex;flex-direction:column;gap:2px;min-width:0');
 label.className='sr-only';label.textContent='Model';
 select.id='model-select';select.setAttribute('aria-label','Model');select.setAttribute('style','max-width:100%');
 note.className='connection-note';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
 label.append(select);
 // Second select: the Gemini variants agy offers, shown only while Argon is selected.
 const variantLabel=document.createElement('label'),variantSelect=document.createElement('select');
 variantLabel.className='sr-only';variantLabel.textContent='Gemini model';
 variantSelect.id='argon-model-select';variantSelect.setAttribute('aria-label','Gemini model for Argon');variantSelect.setAttribute('style','max-width:100%');variantSelect.hidden=true;
 variantLabel.append(variantSelect);wrap.append(label,variantLabel,note);
 const mount=document.querySelector('.composer-toolbar')||document.querySelector('#composer');
 if(mount)mount.append(wrap);
 function entries(){
  return ids.filter(id=>id!=='auto'||autoEnabled()).map(id=>{
   if(id==='auto')return {id,label:fallbackLabels.auto,available:true,reason:''};
   if(id==='swarm')return {id,label:fallbackLabels.swarm,available:!!swarmState&&swarmState.available===true,reason:swarmState&&typeof swarmState.reason==='string'?swarmState.reason:swarmState?'':'swarm status not loaded'};
   const row=report&&Array.isArray(report.providers)?report.providers.find(p=>p&&p.id===id):null;
   return {id,label:row&&typeof row.label==='string'?row.label:fallbackLabels[id],available:row?row.available!==false:true,reason:row&&typeof row.reason==='string'?row.reason:''};
  });
 }
 function current(){
  if(chosen&&(chosen!=='auto'||autoEnabled()))return chosen;
  if(autoEnabled())return 'auto';
  return report&&ids.includes(report.default)&&report.default!=='auto'?report.default:'qwen';
 }
 function autoNote(){
  const chains=report&&report.auto&&report.auto.chains&&typeof report.auto.chains==='object'?report.auto.chains:null;
  const first=task=>chains&&Array.isArray(chains[task])&&chains[task].length?shortName(fallbackLabels[chains[task][0]]||chains[task][0]):'';
  const route=chains?' Coding → '+first('coding')+', documents/images → '+first('long_context')+', web research → '+first('research')+', everything else → '+first('general')+'.':'';
  return fallbackLabels.auto+' selected. Echo classifies each message and picks an available provider before the call; the reply says which one answered.'+route+(report&&report.auto&&report.auto.declineTo==='qwen'?' A vendor that declines is re-run on Qwen and labelled.':'')+' An unavailable provider fails the turn.';
 }
 function argonRow(){return report&&Array.isArray(report.providers)?report.providers.find(p=>p&&p.id==='argon')||null:null;}
 function variants(){
  const row=argonRow();
  return row&&Array.isArray(row.variants)?row.variants.filter(v=>v&&typeof v.id==='string'&&v.id):[];
 }
 /** The Gemini id shown in the second select (what you see is what is sent), or undefined when Argon is not selected or agy listed none. */
 function currentVariant(){
  if(current()!=='argon')return undefined;
  const list=variants();
  if(!list.length)return undefined;
  return list.some(v=>v.id===chosenVariant)?chosenVariant:list[0].id;
 }
 /** True while the composer is in an Echo conversation (the Workspace chat), where Qwen answers through the Workspace and a vendor pick through Prime. */
 function conversation(){const ws=workspace();return !!ws&&ws.generalMode===true;}
 function labelOf(id){const row=entries().find(e=>e.id===id);return row?row.label:fallbackLabels[id]||String(id||'');}
 function render(){
  const list=entries(),selected=current(),chat=conversation();
  select.replaceChildren(...list.map(e=>{const option=document.createElement('option');option.value=e.id;option.textContent=e.label+(e.available?'':' (unavailable)');return option;}));
  select.value=selected;
  const gemini=selected==='argon'?variants():[],shown=currentVariant();
  variantSelect.replaceChildren(...gemini.map(v=>{const option=document.createElement('option');option.value=v.id;option.textContent=typeof v.label==='string'&&v.label?v.label:v.id;return option;}));
  variantSelect.hidden=!gemini.length;
  if(shown)variantSelect.value=shown;
  variantSelect.disabled=!!failed||!!gate||(!!report&&!report.routing);
  const row=list.find(e=>e.id===selected);
  if(gate==='signin')note.textContent='Sign in to choose a model. Nothing is sent to a model until you sign in.';
  else if(gate==='member')note.textContent='Model choice is available to the primary owner only.';
  else if(failed)note.textContent='Model status unavailable. Nothing will be sent to a model until the status route answers.';
  else if(!report)note.textContent='Checking models…';
  else if(!report.routing)note.textContent='Model choice is not enabled on this host.';
  else if(selected==='auto')note.textContent=chat?'Auto in an Echo conversation keeps Qwen on your private Workspace, with its memory and tools. Pick Claude, GPT, Grok or Argon to have that model answer here instead.':autoNote();
  else if(row&&!row.available)note.textContent=row.label+' is unavailable: '+(row.reason||'no reason given')+'. No other model will be used.';
  else if(chat&&selected==='qwen'&&row)note.textContent='Echo conversation: '+row.label+' answers through your private Workspace, with its memory and tools; each reply names the model.';
  else if(chat&&selected==='swarm'&&row)note.textContent=row.label+' runs in ECHO Code conversations. Switch Conversation to ECHO Code to use it; nothing is sent to it from an Echo conversation.';
  else if(chat&&row&&!(selected==='argon'&&!gemini.length))note.textContent=row.label+' answers this Echo conversation through Prime; its replies are labelled and not saved to the Workspace. If it fails, the turn fails; no other model is used.';
  else if(selected==='argon'&&row&&!gemini.length){const why=argonRow()&&typeof argonRow().variantsReason==='string'?argonRow().variantsReason:'no Gemini models were listed';note.textContent=row.label+' selected. '+why+'; the agy default model is used. If it fails, the turn fails; no other model is used.';}
  else if(selected==='swarm')note.textContent=row.label+' selected. Runs can take many minutes and spend the shown budget; the worker has no cancel. If it fails the turn fails; no other model is used.';
  else note.textContent=row?row.label+' selected. If it fails, the turn fails; no other model is used.':'';
  select.disabled=!!failed||!!gate||(!!report&&!report.routing);
 }
 async function headers(){
  try{return window.EchoPrimeWorkspace&&window.EchoPrimeWorkspace.ownerHeaders?await window.EchoPrimeWorkspace.ownerHeaders():{};}catch{return {};}
 }
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 /** What the Workspace's cached session admits, read without a request: 'open' (this host has no authenticated
  *  Workspace, so the Prime cookie alone decides), 'signin', 'member' or 'owner'. /api/prime/models is owner-only. */
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 function debug(outcome,detail){console.debug('[echo.models]',{event:'model_status',outcome,...(detail||{})});}
 /** Reads the status route once the Workspace knows who is signed in. Anyone the owner-only route would refuse gets the
  *  honest picker state without a request; a refusal is never retried; after any failure the next read waits COOLDOWN_MS,
  *  whatever events fire. */
 async function refresh(){
  const current=++generation,ws=workspace();
  if(ws)await Promise.resolve(ws.ready).catch(()=>{});
  if(current!==generation)return;
  const access=admission();
  if(access==='signin'||access==='member'){report=null;failed=false;gate=access;debug('skipped',{reason:access});render();return;}
  if(Date.now()-failedAt<COOLDOWN_MS){debug('cooldown',{remaining_ms:COOLDOWN_MS-(Date.now()-failedAt)});return;}
  try{
   const sent={'x-prime-request':'1',...await headers()},owner=admission()==='owner';
   const response=await fetch('/api/prime/models',{credentials:'same-origin',headers:sent});
   const data=await response.json();
   if(current!==generation)return;
   // Only a session that claimed owner admission has anything to invalidate (a real expiry or demotion). A signed-out
   // visitor or a member is refused by design; clearing the page for them is what restarted the 401 loop.
   if((response.status===401||response.status===403)&&owner&&ws&&typeof ws.invalidate==='function'){ws.invalidate();debug('invalidated',{status:response.status});}
   if(!response.ok||!data||typeof data!=='object'||!Array.isArray(data.providers))throw new Error('status');
   report=data;failed=false;gate='';debug('returned',{routing:data.routing===true,providers:data.providers.length});
  }catch{if(current!==generation)return;failedAt=Date.now();report=null;failed=true;gate='';debug('failed');}
  render();
 }
 select.addEventListener('change',()=>{
  if(!ids.includes(select.value))return;
  chosen=select.value;
  try{localStorage.setItem(storageKey,chosen);}catch{}
  render();
 });
 variantSelect.addEventListener('change',()=>{
  if(!variants().some(v=>v.id===variantSelect.value))return;
  chosenVariant=variantSelect.value;
  try{localStorage.setItem(variantKey,chosenVariant);}catch{}
  render();
 });
 window.addEventListener('echo-account-changed',()=>{refresh();});
 window.addEventListener('echo-chat-kind',()=>render());// workspace.js: Echo conversation <-> ECHO Code changes what the note must say
 render();
 const ready=refresh();
 window.EchoPrimeModels={
  ready,refresh,
  /** swarm.js reports the worker state here ({available,reason}); the picker never assumes the swarm is up. */
  setSwarm(state){swarmState=state&&typeof state==='object'?{available:state.available===true,reason:typeof state.reason==='string'?state.reason:''}:null;render();},
  /** True when the next message must go through the swarm instead of the chat route. */
  swarm(){return !!(report&&report.routing===true&&!failed&&current()==='swarm');},
  /** The provider id to send with a chat turn, or undefined when the host does not route by provider. */
  provider(){return report&&report.routing===true&&!failed?current():undefined;},
  /** The Gemini model id to send with an Argon turn (validated by the server against agy's list), else undefined. */
  model(){return report&&report.routing===true&&!failed?currentVariant():undefined;},
  /** Who answers the next Echo conversation turn: {} = Qwen through the Workspace (also Auto, a member, or a host without
   *  routing); {vendor:{id,label,model?}} = that vendor through Prime; {blocked} = the pick cannot be honoured, with why. */
  conversationRoute(){
   const id=current(),label=labelOf(id);
   if(gate)return {};
   if(failed)return id==='qwen'||id==='auto'?{}:{blocked:'Model status is unavailable, so '+label+' could not be confirmed. Nothing was sent: pick Qwen to answer through your Workspace, or try again in a moment.'};
   if(!report||report.routing!==true||id==='qwen'||id==='auto')return {};
   if(id==='swarm')return {blocked:label+' runs in ECHO Code conversations. Switch Conversation to ECHO Code to use it; nothing was sent.'};
   const variant=currentVariant();
   return {vendor:{id,label,...(variant?{model:variant}:{})}};
  },
  /** Picks a model for the next message (the Swarm brain sidebar item uses this); false for an id the picker does not offer. */
  choose(id){
   if(!ids.includes(id)||(id==='auto'&&!autoEnabled()))return false;
   chosen=id;try{localStorage.setItem(storageKey,chosen);}catch{}render();return true;
  },
  /** The picker's label for a provider id (the current pick when omitted). */
  label(id){return labelOf(id===undefined?current():id);},
  /** Per-reply note. Plain: "answered by <model>". Auto: "routed to Claude (coding) · answered by …". Decline re-route: "Claude declined; answered by Qwen (FORGE, 256K) · <model>". */
  describe(model){
   if(!model||typeof model!=='object')return '';
   const name=typeof model.label==='string'?model.label:String(model.id||'model');
   let body;
   if(model.answered===false)body='no model answered ('+name+' returned no answer)';
   else if(model.declinedBy)body='answered by '+name+(typeof model.model==='string'&&model.model?' · '+model.model:'');
   else if(typeof model.model==='string'&&model.model)body='answered by '+model.model;
   else body='model not reported by '+(model.id==='argon'?'agy':name)+' (requested: '+(typeof model.requested==='string'&&model.requested?model.requested:'CLI default')+')';
   if(model.declinedBy)body=shortName(typeof model.declinedLabel==='string'&&model.declinedLabel?model.declinedLabel:fallbackLabels[model.declinedBy]||model.declinedBy)+' declined; '+body;
   if(model.routed&&typeof model.routed==='object'&&typeof model.routed.task==='string'){
    const target=model.declinedBy?(typeof model.declinedLabel==='string'&&model.declinedLabel?model.declinedLabel:model.declinedBy):name;
    body='routed to '+shortName(target)+' ('+model.routed.task.replace(/_/g,' ')+') · '+body;
   }
   return body;
  },
 };
})();
