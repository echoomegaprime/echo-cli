(() => {
 'use strict';
 // Swarm (40-seat brain). Selecting "Swarm" in the model picker sends the next message to the Maximalist Swarm Fusion Brain worker
 // through the Prime server (/api/prime/swarm/*): submit, poll every 3 s (paused while the tab is hidden), render the fused result.
 // The worker is a reconstruction (profile MAXIMALIST_RECONSTRUCTED, historical_parity false) and says so on every result.
 // There is no fallback: if the swarm is down, over budget or times out, the turn fails and says why; no other model answers.
 const $=s=>document.querySelector(s);
 const models=window.EchoPrimeModels,chat=window.EchoPrimeChat;
 if(!models||!chat||typeof models.setSwarm!=='function')return;
 const POLL_MS=3000,TICK_MS=1000,GRACE_S=120,MAX_FAILURES=5,MAX_CHARS=12000,COOLDOWN_MS=5000;
 let verdict={available:false,reason:'swarm status not loaded'},run=null,generation=0,healthGeneration=0,failedAt=-Infinity;
 const original={send:chat.send,cancel:chat.cancel,reset:chat.reset};
 const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const pct=v=>num(v)===null?'unknown':Math.round(Math.min(1,Math.max(0,v))*100)+'%';
 const list=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x):[];
 const clip=(v,n)=>{const s=typeof v==='string'?v:v===undefined||v===null?'':JSON.stringify(v);return s.length>n?s.slice(0,n)+'…':s;};
 function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
 function clock(ms){const s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
 function money(v){return '$'+(Math.round(v*100)/100).toFixed(2);}
 function budgetText(b){return b?'up to '+b.max_calls+' calls, '+money(b.max_cost_usd)+', '+Math.round(b.max_wall_s/60)+' min':'budget not reported';}
 function busy(value){$('#composer .send').disabled=value;$('#stop-chat').hidden=!value;$('#chat-log').setAttribute('aria-busy',String(value));}
 function line(role,text){
  const article=el('article',undefined,'chat-message '+role);article.append(el('strong',role==='user'?'You':'Swarm (40-seat brain)'),el('p',text));
  $('#chat-log').append(article);$('#chat-log').hidden=false;$('#welcome').hidden=true;article.scrollIntoView({block:'nearest'});return article;
 }
 async function headers(){
  try{return window.EchoPrimeWorkspace&&window.EchoPrimeWorkspace.ownerHeaders?await window.EchoPrimeWorkspace.ownerHeaders():{};}catch{return {};}
 }
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 /** What the Workspace's cached session admits, read without a request: 'open' (this host has no authenticated
  *  Workspace, so the Prime cookie alone decides), 'signin', 'member' or 'owner'. Every /api/prime/swarm route is owner-only. */
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 function debug(outcome,detail){console.debug('[echo.swarm]',{event:'swarm_health',outcome,...(detail||{})});}
 // Living orb (additive, optional): a watched swarm run puts the orb in deep thought and orbits as one swarm moon.
 function orbEvent(name,detail){try{if(typeof document.dispatchEvent==='function'&&typeof CustomEvent==='function')document.dispatchEvent(new CustomEvent(name,{detail}));}catch{}}
 function orb(mode){orbEvent('echo-orb-state',{mode,source:'swarm'});}
 function orbSatellites(r){orbEvent('echo-orb-satellites',{source:'swarm',satellites:r?[{id:'swarm:'+r.runId,kind:'swarm',name:'Swarm · run '+String(r.runId).slice(0,8),status:'running',busy:true}]:[]});}
 function report(available,reason){verdict={available,reason};models.setSwarm(verdict);return verdict;}
 async function api(path,body,signal){
  const sent={'x-prime-request':'1',...await headers(),...(body?{'content-type':'application/json'}:{})},owner=admission()==='owner';
  const response=await fetch('/api/prime/swarm/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:sent,...(body?{body:JSON.stringify(body)}:{}),signal});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
   // Only a session that claimed owner admission has anything to invalidate (a real expiry or demotion). A signed-out
   // visitor or a member is refused by design; clearing the page for them is what restarted the 401 loop.
   const ws=workspace();
   if((response.status===401||response.status===403)&&owner&&ws&&typeof ws.invalidate==='function'){ws.invalidate();debug('invalidated',{status:response.status,path});}
   const error=new Error(data&&typeof data.error==='string'?data.error:'Swarm request failed (HTTP '+response.status+')');error.status=response.status;throw error;
  }
  if(!data||typeof data!=='object')throw new Error('Swarm returned an unrecognized response');
  return data;
 }
 /** Reads the worker's health once the Workspace knows who is signed in. Skips the owner-only request for anyone who is
  *  not the owner, never retries a refusal, and after any failure waits COOLDOWN_MS before asking again, whatever events
  *  fire. Resolves to the {available, reason} the picker shows. */
 async function refreshHealth(){
  const mine=++healthGeneration,ws=workspace();
  if(ws)await Promise.resolve(ws.ready).catch(()=>{});
  if(mine!==healthGeneration)return verdict;
  const access=admission();
  if(access==='signin'){debug('skipped',{reason:'signin'});return report(false,'Sign in to use the Swarm.');}
  if(access==='member'){debug('skipped',{reason:'owner_only'});return report(false,'The Swarm is available to the primary owner only.');}
  if(Date.now()-failedAt<COOLDOWN_MS){debug('cooldown',{remaining_ms:COOLDOWN_MS-(Date.now()-failedAt)});return verdict;}
  try{
   const data=await api('health');
   if(mine!==healthGeneration)return verdict;
   debug('returned',{available:data.available===true});
   return report(data.available===true,data.available===true?'':typeof data.reason==='string'?data.reason:'unavailable');
  }catch(error){
   if(mine!==healthGeneration)return verdict;
   failedAt=Date.now();
   const message=error instanceof Error?error.message:'request failed';
   debug('failed',{status:error&&typeof error.status==='number'?error.status:null,message});
   return report(false,'Swarm status unavailable ('+message+')');
  }
 }
 /** The honest label every result carries. It is read from the result; nothing here assumes the values. */
 function badge(result){
  const prov=result&&typeof result.provenance==='object'&&result.provenance?result.provenance:{};
  const profile=typeof prov.profile==='string'?prov.profile:typeof (result||{}).profile==='string'?result.profile:null;
  const parity=typeof prov.historical_parity==='boolean'?prov.historical_parity:typeof (result||{}).historical_parity==='boolean'?result.historical_parity:null;
  const ok=profile==='MAXIMALIST_RECONSTRUCTED'&&parity===false;
  const box=el('p',undefined,'swarm-badge'+(ok?'':' swarm-badge-warn'));
  if(ok)box.append(el('strong','MAXIMALIST_RECONSTRUCTED · historical_parity: false'),el('span',' — a reconstruction, not the historical original.'));
  else box.append(el('strong','Profile not confirmed'),el('span',' — the worker reported profile '+(profile||'(none)')+' and historical_parity '+(parity===null?'(none)':String(parity))+'. Treat this as a reconstruction until verified.'));
  return box;
 }
 function section(title,open){const d=el('details',undefined,'swarm-section');if(open)d.open=true;d.append(el('summary',title));return d;}
 function bullets(items){const ul=el('ul');for(const text of items)ul.append(el('li',text));return ul;}
 function renderResult(article,result,info){
  article.replaceChildren(el('strong','Swarm (40-seat brain)'),badge(result));
  const answer=typeof result.answer==='string'&&result.answer.trim()?result.answer:'The run finished without an answer.';
  article.append(el('p',answer,'swarm-answer'),el('p','Confidence '+pct(result.confidence)+(num(result.fusion_passes)!==null?' · '+result.fusion_passes+' fusion pass'+(result.fusion_passes===1?'':'es'):''),'swarm-confidence'));
  const findings=Array.isArray(result.major_findings)?result.major_findings.filter(f=>f&&typeof f==='object'&&typeof f.claim==='string'):[];
  if(findings.length){
   const s=section('Major findings ('+findings.length+')',true),ol=el('ol');
   for(const f of findings.slice(0,30)){
    const li=el('li',f.claim),ev=list(f.evidence);
    li.append(el('small','seat '+clip(f.seat_id,60)+(f.role?' ('+clip(f.role,60)+')':'')+' · confidence '+pct(f.confidence)+(f.verified===true?' · verified':'')+(ev.length?' · evidence: '+clip(ev.join('; '),400):''),'swarm-meta'));
    ol.append(li);
   }
   s.append(ol);article.append(s);
  }
  const dissent=Array.isArray(result.dissent)?result.dissent.filter(d=>d&&typeof d==='object'&&typeof d.claim==='string'):[];
  const ds=section('Preserved dissent ('+dissent.length+')',true);
  if(!dissent.length)ds.append(el('p','No dissent was recorded for this run.','swarm-meta'));
  else{const ul=el('ul');for(const d of dissent.slice(0,30)){const li=el('li',d.claim);li.append(el('small','dissenting seats: '+list(d.dissenting_seats).join(', ')+(d.majority_position?' · majority held: '+clip(d.majority_position,300):'')+(d.reason_rejected?' · set aside because: '+clip(d.reason_rejected,300):'')+' · confidence '+pct(d.confidence),'swarm-meta'));ul.append(li);}ds.append(ul);}
  article.append(ds);
  const unresolved=list(result.unresolved),contra=Array.isArray(result.contradictions)?result.contradictions.filter(c=>c&&typeof c==='object'&&typeof c.topic==='string'):[];
  const us=section('Unresolved uncertainty ('+(unresolved.length+contra.length)+')',true);
  if(!unresolved.length&&!contra.length)us.append(el('p','The worker listed nothing unresolved. That is not proof there is nothing.','swarm-meta'));
  if(unresolved.length)us.append(bullets(unresolved.slice(0,30)));
  if(contra.length)us.append(el('p','Contradictions: ','swarm-meta'),bullets(contra.slice(0,20).map(c=>c.topic+(c.resolved===true?' (resolved)':' (unresolved)'))));
  article.append(us);
  const ps=section('Provenance',false),prov=result.provenance&&typeof result.provenance==='object'?result.provenance:{};
  ps.append(el('p','Seats used: '+list(result.models_used).length+' · run '+info.runId+' · '+clock(info.elapsedMs)+' elapsed','swarm-meta'),el('pre',clip(JSON.stringify(prov,null,1),4000)));
  article.append(ps,el('small','Fused model text from many seats; verify claims before relying on them.','swarm-meta'));
  // Hook for speech.js (additive): offers a "Speak result" action on the rendered answer.
  try{window.dispatchEvent(Object.assign(new Event('echo-result-rendered'),{detail:{source:'swarm',text:answer,article}}));}catch{}
 }
 function failBox(article,title,detail){
  article.replaceChildren(el('strong','Swarm (40-seat brain)'),el('p',title,'swarm-error'),el('small',detail+' No other model was used.','swarm-meta'));
 }
 function stopTimers(r){if(r.timer)clearTimeout(r.timer);r.timer=null;r.controller.abort();}
 /** Ends the watch. `stopped` marks the user's own Stop (or a quiet reset): the orb settles to idle, because no longer
  *  waiting is not a failure. Only a run that failed, vanished or timed out flashes the orb's error. */
 function finish(r,outcome,stopped){
  if(run!==r)return;
  run=null;stopTimers(r);busy(false);refreshHealth();r.resolve(outcome);
  orb(outcome&&outcome.sent?'success':stopped||outcome&&outcome.cancelled?'idle':'error');orb('idle');orbSatellites(null);
 }
 async function poll(r){
  r.inflight=true;r.lastPoll=Date.now();
  try{
   const data=await api('runs/'+encodeURIComponent(r.runId),undefined,r.controller.signal);
   if(run!==r)return;
   r.failures=0;r.phase=typeof data.phase==='string'?data.phase:r.phase;
   if(data.done===true){
    const info={runId:r.runId,elapsedMs:Date.now()-r.startedAt};
    if(typeof data.error==='string'&&data.error){failBox(r.article,'The swarm run failed: '+data.error,'Run '+r.runId+' ended with an error after '+clock(info.elapsedMs)+'.');console.debug('[echo.swarm]',{event:'swarm_run',outcome:'failed'});finish(r,{sent:false,detail:'Swarm run failed: '+data.error+'. No other model was used.'});return;}
    if(!data.result||typeof data.result!=='object'){failBox(r.article,'The swarm run finished without a result.','Run '+r.runId+' is marked done but returned nothing to show.');finish(r,{sent:false,detail:'Swarm run finished without a result. No other model was used.'});return;}
    renderResult(r.article,data.result,info);console.debug('[echo.swarm]',{event:'swarm_run',outcome:'completed'});
    finish(r,{sent:true,detail:'Swarm answer received.'});return;
   }
   status(r);
  }catch(error){
   if(run!==r||r.controller.signal.aborted)return;
   r.failures++;
   const message=error instanceof Error?error.message:'request failed';
   if(error&&error.status===404){failBox(r.article,'The worker does not know run '+r.runId+'.',message);finish(r,{sent:false,detail:'Swarm run not found on the worker. No other model was used.'});return;}
   if(r.failures>=MAX_FAILURES){failBox(r.article,'Lost contact with the swarm worker.','Run '+r.runId+' may still be running and spending its budget. Last error: '+message+'.');finish(r,{sent:false,detail:'Lost contact with the swarm worker (run '+r.runId+'). No other model was used.'});return;}
   r.note='Status check failed ('+r.failures+'/'+MAX_FAILURES+'): '+message+'. Retrying.';status(r);
  }finally{r.inflight=false;}
 }
 function status(r){
  r.statusLine.textContent=r.note||('Phase: '+r.phase+' · budget '+budgetText(r.budget)+(document.hidden?' · polling paused while this tab is hidden':''));
  r.elapsed.textContent=clock(Date.now()-r.startedAt);
 }
 function tick(r){
  if(run!==r)return;
  const elapsed=Date.now()-r.startedAt;
  r.elapsed.textContent=clock(elapsed);
  if(elapsed>((r.budget&&r.budget.max_wall_s)||1800)*1000+GRACE_S*1000){
   failBox(r.article,'Stopped waiting: the wall-clock budget plus grace has passed.','Run '+r.runId+' may still be running on the worker; the worker has no cancel.');
   finish(r,{sent:false,detail:'Timed out waiting for swarm run '+r.runId+'; it may still be running. No other model was used.'});return;
  }
  if(document.hidden){status(r);}
  else if(!r.inflight&&Date.now()-r.lastPoll>=POLL_MS)void poll(r);
  if(run===r)r.timer=setTimeout(()=>tick(r),TICK_MS);
 }
 function stopWatching(r,quiet){
  if(run!==r)return;
  const detail='Stopped waiting for swarm run '+r.runId+'. The worker has no cancel: the run may continue and spend up to its budget ('+budgetText(r.budget)+').';
  if(!quiet)failBox(r.article,'Stopped waiting.',detail);
  finish(r,quiet?{cancelled:true}:{sent:false,detail},true);
 }
 async function sendSwarm(text){
  if(run)return {sent:false,detail:'A swarm run is in progress. Wait for it or select Stop (the worker cannot cancel it).'};
  if(text.length>MAX_CHARS)return {sent:false,detail:'The swarm accepts at most '+MAX_CHARS+' characters. The prompt remains in this tab.'};
  const current=generation;busy(true);
  const state=await refreshHealth();
  if(current!==generation){busy(false);return {cancelled:true};}
  if(!state||state.available!==true){
   busy(false);
   return {sent:false,detail:'Swarm is unavailable: '+(state&&typeof state.reason==='string'?state.reason:'status could not be read')+'. Nothing was sent to any model; the prompt remains in this tab.'};
  }
  line('user',text);
  const article=line('assistant','Submitting to the swarm…');
  const controller=new AbortController();
  let accepted;
  try{accepted=await api('run',{objective:text},controller.signal);}
  catch(error){
   if(current!==generation)return {cancelled:true};
   const message=error instanceof Error?error.message:'request failed';
   failBox(article,'The swarm run was not started: '+message,'Nothing is running on the worker unless the connection dropped after it accepted the job.');
   busy(false);refreshHealth();
   return {sent:false,detail:'Swarm run not started: '+message+'. No other model was used.'};
  }
  if(current!==generation)return {cancelled:true};
  return new Promise(resolve=>{
   const r={runId:accepted.runId,phase:typeof accepted.phase==='string'?accepted.phase:'accepted',budget:accepted.budget,startedAt:Date.now(),lastPoll:0,inflight:false,failures:0,note:'',controller,article,timer:null,resolve};
   run=r;orb('deep');orbSatellites(r);
   const stop=el('button','Stop waiting','quiet-button swarm-stop');stop.setAttribute('type','button');stop.addEventListener('click',()=>stopWatching(r,false));
   r.statusLine=el('p',undefined,'swarm-status');r.statusLine.setAttribute('role','status');r.elapsed=el('span','0:00','swarm-elapsed');r.elapsed.setAttribute('aria-hidden','true');
   const pending=el('p',undefined,'swarm-badge');pending.append(el('strong','MAXIMALIST_RECONSTRUCTED · historical_parity: false'),el('span',' — a reconstruction, not the historical original. Confirmed from the result when it arrives.'));
   const clockLine=el('p','Elapsed ','swarm-meta');clockLine.append(r.elapsed);
   article.replaceChildren(el('strong','Swarm (40-seat brain)'),pending,
    el('p','Running 40 seats. This can take many minutes. Run '+r.runId+'. The worker has no cancel: Stop only stops waiting.','swarm-meta'),clockLine,stop,r.statusLine);
   status(r);
   console.debug('[echo.swarm]',{event:'swarm_run',outcome:'submitted'});
   r.timer=setTimeout(()=>tick(r),0);
  });
 }
 // Options ride through untouched: an Echo conversation hands chat.js its prepared prompt and session (workspace.js).
 chat.send=async(text,options)=>models.swarm()?sendSwarm(String(text)):original.send.call(chat,text,options);
 chat.cancel=()=>{if(run)stopWatching(run,false);else original.cancel.call(chat);};
 chat.reset=()=>{generation++;if(run)stopWatching(run,true);original.reset.call(chat);};
 document.addEventListener('visibilitychange',()=>{if(run){run.lastPoll=0;if(!document.hidden){if(run.timer)clearTimeout(run.timer);tick(run);}else status(run);}});
 // A watched run belongs to the account that started it: an account change stops watching quietly (orb idle, moon gone;
 // finish() re-reads health), whether or not the chat reset reaches here first.
 window.addEventListener('echo-account-changed',()=>{if(run)stopWatching(run,true);else refreshHealth();});
 window.addEventListener('pagehide',()=>{if(run)stopWatching(run,true);});
 // "Swarm brain" in the side panel (nav.js declares it under Agents; live test 2026-11-06 found it missing). The swarm
 // answers through ECHO Code, so the item switches the conversation to ECHO Code and picks the Swarm for the next message.
 // It is owner-only like every /api/prime/swarm route; workspace.js applies the [data-owner-only] rule on each identity.
 (()=>{
  const item=document.createElement('button');item.setAttribute('type','button');item.className='nav-item';item.setAttribute('id','open-swarm');item.setAttribute('data-owner-only','');item.hidden=true;item.textContent='Swarm brain';
  item.addEventListener('click',()=>{
   if(typeof models.choose==='function'&&!models.choose('swarm'))return;
   const kind=$('#workspace-chat-kind');
   if(kind&&kind.value!=='coding'){kind.value='coding';kind.dispatchEvent(new Event('change'));}
   const notice=$('#draft-notice');if(notice){notice.textContent='Swarm (40-seat brain) picked for your next ECHO Code message. A run can take many minutes and spends up to its budget; its result says so.';notice.hidden=false;}
   $('#prompt')?.focus();
  });
  ($('#prime-nav')||$('#sidebar'))?.append(item);
 })();
 window.EchoPrimeSwarm={ready:refreshHealth(),refresh:refreshHealth,active(){return run?run.runId:null;}};
})();
