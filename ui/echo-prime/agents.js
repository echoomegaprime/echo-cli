(() => {
 'use strict';
 // Agents (Echo ADK). The "Agents" nav entry opens a view that lists the Echo ADK agent definitions, starts a governed run
 // through the Prime server (/api/prime/adk/*), polls it every 3 s (paused while the tab is hidden) and renders every step
 // Envelope, the final text and the Proof card. Every /api/prime/adk route is owner-only: nothing is fetched until the view
 // is opened by someone the cached session admits (hotfix 6a973a2). There is no fallback: a gated step says what it needs,
 // an unavailable provider is named, a budget stop is a budget stop. Stop asks the service to stop after the current step;
 // a provider call already running is not interrupted.
 const $=s=>document.querySelector(s);
 const panel=$('#agents-dialog'),opener=$('#open-agents');
 if(!panel||!opener)return;
 const POLL_MS=3000,TICK_MS=1000,GRACE_S=120,MAX_FAILURES=5,MAX_CHARS=12000,COOLDOWN_MS=5000,STORAGE_KEY='echo-prime-adk-v1';
 const status=$('#agents-status'),list=$('#agents-list'),form=$('#agents-form'),select=$('#agents-agent'),prompt=$('#agents-prompt'),calls=$('#agents-calls'),cost=$('#agents-cost'),wall=$('#agents-wall'),submit=$('#agents-submit'),runView=$('#agents-run'),runsList=$('#agents-runs');
 let generation=0,controller=null,health=null,agents=[],run=null,busy=false,failedAt=-Infinity,remembered=null;
 // The definitions the orb shows: the last list Echo ADK returned. A reload keeps it until its fetch answers, so Refresh,
 // reopening the view or a moon click never blanks the moons (which would reset their orbits, trails and arcs).
 let orbAgents=[];
 try{const stored=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(stored&&typeof stored==='object'&&!Array.isArray(stored))remembered={agent:typeof stored.agent==='string'?stored.agent.slice(0,64):'',prompt:typeof stored.prompt==='string'?stored.prompt.slice(0,MAX_CHARS):''};}catch{}
 const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
 const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x).slice(0,50):[];
 const clip=(v,n)=>{const s=typeof v==='string'?v:v===undefined||v===null?'':JSON.stringify(v);return s.length>n?s.slice(0,n)+'…':s;};
 function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
 function clock(ms){const s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
 function money(v){return '$'+(Math.round(v*100)/100).toFixed(2);}
 function budgetText(b){const x=obj(b);return num(x.max_calls)!==null&&num(x.max_cost_usd)!==null&&num(x.max_wall_s)!==null?'up to '+x.max_calls+' calls, '+money(x.max_cost_usd)+', '+Math.round(x.max_wall_s/60)+' min':'budget not reported';}
 function spentText(s){const x=obj(s);return num(x.calls)!==null||num(x.cost_usd)!==null||num(x.wall_s)!==null?'spent '+(num(x.calls)??0)+' calls, '+money(num(x.cost_usd)??0)+', '+Math.round(num(x.wall_s)??0)+' s':'spend not reported';}
 async function headers(){
  try{return window.EchoPrimeWorkspace&&window.EchoPrimeWorkspace.ownerHeaders?await window.EchoPrimeWorkspace.ownerHeaders():{};}catch{return {};}
 }
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 /** What the Workspace's cached session admits, read without a request: 'open' (no authenticated Workspace on this host, the
  *  Prime cookie alone decides), 'signin', 'member' or 'owner'. Every /api/prime/adk route is owner-only. */
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 function debug(event,outcome,detail){console.debug('[echo.agents]',{event,outcome,...(detail||{})});}
 // Living orb (additive, optional): every agent definition orbits as a moon (running while its run is watched) and a
 // watched run puts the orb in deep thought. Silent where no event can be dispatched; nothing is fetched for the orb.
 function orbEvent(name,detail){try{if(typeof document.dispatchEvent==='function'&&typeof CustomEvent==='function')document.dispatchEvent(new CustomEvent(name,{detail}));}catch{}}
 function orb(mode){orbEvent('echo-orb-state',{mode,source:'agents'});}
 // The orb keeps 24 moons across every publisher, busy first; the watched agent goes first here, so it orbits wherever it is listed.
 function publishSatellites(){
  const moons=orbAgents.map(a=>{const busy=!!run&&run.agent===a.name;return {id:'agent:'+a.name,kind:'agent',name:String(a.name),status:busy?'running':'idle',busy};});
  moons.sort((a,b)=>Number(b.busy)-Number(a.busy));
  orbEvent('echo-orb-satellites',{source:'agents',satellites:moons.slice(0,24)});
 }
 /** Publishes what a load settled: the definitions Echo ADK listed, or none when it answered that there are none to show
  *  (signed out, member, Echo ADK off or unavailable). A failed or superseded load publishes nothing. */
 function showAgents(list){orbAgents=list;publishSatellites();}
 async function api(path,body,signal,method){
  const sent={'x-prime-request':'1',...await headers(),...(body!==undefined?{'content-type':'application/json'}:{})},owner=admission()==='owner';
  const response=await fetch('/api/prime/adk/'+path,{method:method||(body!==undefined?'POST':'GET'),credentials:'same-origin',headers:sent,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
   // Only a session that claimed owner admission has anything to invalidate. A signed-out visitor or a member is refused by
   // design; clearing the page for them is what restarted the 401 loop (hotfix 6a973a2).
   const ws=workspace();
   if((response.status===401||response.status===403)&&owner&&ws&&typeof ws.invalidate==='function'){ws.invalidate();debug('adk_request','invalidated',{status:response.status,path});}
   const error=new Error(data&&typeof data.error==='string'?data.error:'Echo ADK request failed (HTTP '+response.status+')');error.status=response.status;throw error;
  }
  if(!data||typeof data!=='object')throw new Error('Echo ADK returned an unrecognized response');
  return data;
 }
 // Refresh is never locked: every early return in load() (off, unavailable, sign-in, cool-down, failure) must leave a way back in.
 // Re-entry is already guarded by `generation`.
 function lock(value){busy=value;submit.disabled=value||!agents.length;for(const node of [select,prompt,calls,cost,wall])if(node)node.disabled=value;}
 function remember(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({agent:select.value,prompt:prompt.value.slice(0,MAX_CHARS)}));}catch{}}
 // ---- agent definitions ------------------------------------------------------
 function agentCard(a){
  const lane=obj(a.lane),card=el('article',undefined,'workspace-card-content adk-agent');
  card.append(el('h3',String(a.name)),el('p',typeof a.role==='string'&&a.role?a.role:'role not stated','adk-agent-role'));
  if(obj(a.origin).by==='echo')card.append(el('span','Echo-made from your prompt','autoagent-badge'));// definitions Prime created from a chat prompt (autoagents.js)
  const rows=el('dl',undefined,'adk-rows');
  const row=(k,v)=>{if(v===undefined||v===null||v==='')return;rows.append(el('dt',k),el('dd',v));};
  row('Skills',strings(a.skills).join(', ')||'none listed');
  row('Capabilities',strings(a.capabilities).join(', ')||'none listed');
  row('Lane',(typeof lane.node==='string'?lane.node:'node not stated')+' · '+(typeof lane.model==='string'?lane.model:'model not stated'));
  row('Lane budget',budgetText(lane.budget));
  if(num(a.max_steps)!==null)row('Max steps',String(a.max_steps));
  if(typeof a.source==='string'&&a.source)row('Source',clip(a.source,160));
  card.append(rows);
  if(typeof a.instruction==='string'&&a.instruction.trim()){const d=el('details',undefined,'adk-section');d.append(el('summary','Instruction'),el('pre',clip(a.instruction,4000)));card.append(d);}
  return card;
 }
 function renderAgents(){
  list.replaceChildren(...(agents.length?agents.map(agentCard):[el('p','Echo ADK lists no agent definitions.','adk-muted')]));
  const options=agents.map(a=>{const o=el('option',String(a.name));o.value=String(a.name);return o;});
  select.replaceChildren(...options);
  const wanted=remembered&&agents.some(a=>a.name===remembered.agent)?remembered.agent:agents.length?String(agents[0].name):'';
  select.value=wanted;
  if(remembered&&remembered.prompt&&!prompt.value)prompt.value=remembered.prompt;
 }
 function renderRuns(rows){
  const items=Array.isArray(rows)?rows.filter(r=>r&&typeof r==='object'&&typeof r.runId==='string'):[];
  runsList.replaceChildren(el('h3','Recent runs'));
  if(!items.length){runsList.append(el('p','No runs recorded by Echo ADK.','adk-muted'));return;}
  for(const r of items.slice(0,50)){
   const b=el('button',clip(r.agent||'agent',40)+' · '+clip(r.status,20)+' · '+r.runId.slice(0,8)+'…'+(typeof r.startedAt==='string'?' · '+r.startedAt.slice(0,19).replace('T',' '):''),'quiet-button adk-run-row');
   b.setAttribute('type','button');b.addEventListener('click',()=>{if(run&&run.runId===r.runId)return;if(run)stopWatching(run,true);watch(r.runId,r.agent||'',null);});
   runsList.append(b);
  }
 }
 // ---- load on open -------------------------------------------------------------
 async function load(){
  const mine=++generation,ws=workspace();
  controller?.abort();controller=new AbortController();
  if(ws)await Promise.resolve(ws.ready).catch(()=>{});
  if(mine!==generation)return;
  const access=admission();
  agents=[];renderAgents();runsList.replaceChildren();lock(true);
  if(access==='signin'){showAgents([]);status.textContent='Sign in to use Agents. Nothing was requested from Echo ADK.';debug('adk_health','skipped',{reason:'signin'});return;}
  if(access==='member'){showAgents([]);status.textContent='Agents are available to the primary owner only. Nothing was requested from Echo ADK.';debug('adk_health','skipped',{reason:'owner_only'});return;}
  if(Date.now()-failedAt<COOLDOWN_MS){status.textContent='Echo ADK status check failed a moment ago; try Refresh in a few seconds.';debug('adk_health','cooldown');return;}
  status.textContent='Checking Echo ADK…';
  try{
   health=await api('health',undefined,controller.signal);
   if(mine!==generation)return;
   if(health.configured!==true){showAgents([]);status.textContent=typeof health.reason==='string'?health.reason:'Echo ADK is off: add an `adk` section to the Prime config';debug('adk_health','off');return;}
   if(health.available!==true){showAgents([]);status.textContent='Echo ADK is unavailable: '+(typeof health.reason==='string'?health.reason:'no reason given')+'. Nothing was started.';debug('adk_health','unavailable');return;}
   const b=obj(health.defaultBudget);
   if(num(b.max_calls)!==null&&!calls.value)calls.value=String(b.max_calls);
   if(num(b.max_cost_usd)!==null&&!cost.value)cost.value=String(b.max_cost_usd);
   if(num(b.max_wall_s)!==null&&!wall.value)wall.value=String(b.max_wall_s);
   const [listed,recent]=await Promise.all([api('agents',undefined,controller.signal),api('runs?limit=20',undefined,controller.signal).catch(e=>({runs:[],error:e instanceof Error?e.message:'runs unavailable'}))]);
   if(mine!==generation)return;
   agents=Array.isArray(listed.agents)?listed.agents.filter(a=>a&&typeof a==='object'&&typeof a.name==='string'):[];
   renderAgents();showAgents(agents);renderRuns(recent.runs);
   const svc=obj(health.service);
   status.textContent='Echo ADK '+(typeof svc.version==='string'?svc.version:'(version not reported)')+' · '+agents.length+' agent'+(agents.length===1?'':'s')+' · '+(num(svc.runsActive)??0)+' active run'+(num(svc.runsActive)===1?'':'s')+' · default '+budgetText(health.defaultBudget)+(recent.error?' · recent runs unavailable ('+recent.error+')':'');
   lock(false);debug('adk_health','returned',{agents:agents.length});
  }catch(error){
   if(mine!==generation)return;
   failedAt=Date.now();
   const message=error instanceof Error?error.message:'request failed';
   status.textContent='Echo ADK status unavailable ('+message+'). Nothing was started.';debug('adk_health','failed',{status:error&&typeof error.status==='number'?error.status:null,message});
  }
 }
 // ---- run view -----------------------------------------------------------------
 function verdictBadge(v){const ok=['allowed','gated','denied'].includes(v);return el('span',ok?v:'verdict '+(v===undefined?'(none)':clip(v,20)),'adk-verdict adk-verdict-'+(ok?v:'unknown'));}
 function stepRow(step,index){
  const s=obj(step),data=obj(s.data),kind=typeof s.kind==='string'?s.kind:'step';
  const li=el('li',undefined,'adk-step adk-step-'+clip(kind,20)),head=el('div',undefined,'adk-step-head');
  head.append(el('span','#'+(num(s.step)??index+1),'adk-step-no'),el('strong',kind));
  if(typeof s.capability==='string'&&s.capability)head.append(el('code',clip(s.capability,120)));
  if(s.tier!==undefined&&s.tier!==null)head.append(el('span','tier '+clip(s.tier,8),'adk-tier'));
  head.append(verdictBadge(s.verdict),el('span',num(s.duration_ms)!==null?Math.round(s.duration_ms)+' ms':'duration not reported','adk-duration'));
  li.append(head);
  if(kind==='model'){
   const a=obj(data.answered);
   const who=a.reported===false?'model not reported'+(typeof a.provider==='string'?' by '+a.provider:'')+' (requested: '+(typeof a.requested==='string'&&a.requested?a.requested:'not stated')+')':typeof a.model==='string'&&a.model?'answered by '+a.model+(typeof a.provider==='string'&&a.provider?' · '+a.provider:''):'model not reported';
   li.append(el('p',who,'adk-step-model'));
  }
  if(kind==='final'&&typeof data.text==='string')li.append(el('p',clip(data.text,2000),'adk-step-final'));
  if(s.verdict==='gated')li.append(gatedDetail(s));
  if(s.verdict==='denied')li.append(el('p','Denied by policy; nothing was executed for this step.','adk-step-note'));
  const meta=[];
  if(s.ok===false)meta.push('ok: false');
  if(typeof s.audit_id==='string'&&s.audit_id)meta.push('audit '+clip(s.audit_id,40));
  if(num(s.redacted)!==null&&s.redacted>0)meta.push(s.redacted+' redacted');
  if(s.untrusted===true)meta.push('untrusted output');
  if(meta.length)li.append(el('small',meta.join(' · '),'adk-meta'));
  return li;
 }
 function gatedDetail(source){
  const s=obj(source),needs=strings(s.needs),box=el('div',undefined,'adk-gated');
  box.append(el('strong','Gated: this step needs a Lease before it can run.'));
  box.append(el('p',needs.length?'Needs: '+needs.join(', '):'Needs: the service did not say what is required.'));
  box.append(el('p',typeof s.how==='string'&&s.how?'How: '+clip(s.how,600):'How: the service did not say how to grant it.'));
  return box;
 }
 function proofCard(proof){
  const p=obj(proof),verdict=['PASS','FAIL','UNKNOWN'].includes(p.verdict)?p.verdict:'UNKNOWN';
  const card=el('section',undefined,'adk-proof adk-proof-'+verdict.toLowerCase()),head=el('div',undefined,'adk-proof-head');
  head.append(el('strong','Proof'),el('span',verdict+(verdict!==p.verdict&&p.verdict!==undefined?' (reported: '+clip(p.verdict,20)+')':''),'adk-proof-verdict'));
  card.append(head);
  const rows=el('dl',undefined,'adk-rows');
  rows.append(el('dt','events_sha256'),el('dd',typeof p.events_sha256==='string'&&p.events_sha256?clip(p.events_sha256,64):'not reported'));
  if(typeof p.lease_id==='string'&&p.lease_id)rows.append(el('dt','lease'),el('dd',clip(p.lease_id,64)));
  const actions=Array.isArray(p.actions)?p.actions.filter(a=>a&&typeof a==='object'):[];
  rows.append(el('dt','actions'),el('dd',String(actions.length)));
  const receipts=Array.isArray(p.receipts)?p.receipts:[],artifacts=Array.isArray(p.artifacts)?p.artifacts:[];
  rows.append(el('dt','receipts'),el('dd',String(receipts.length)),el('dt','artifacts'),el('dd',String(artifacts.length)));
  card.append(rows);
  if(actions.length){const ul=el('ul',undefined,'adk-actions');for(const a of actions.slice(0,100))ul.append(el('li',clip(a.cap,120)+' · tier '+clip(a.tier,8)+' · '+clip(a.verdict,20)+(a.audit_id?' · audit '+clip(a.audit_id,40):'')));card.append(ul);}
  if(receipts.length){const d=el('details',undefined,'adk-section');d.append(el('summary','Receipts ('+receipts.length+')'),el('pre',clip(JSON.stringify(receipts.slice(0,50),null,1),6000)));card.append(d);}
  return card;
 }
 function finalText(steps){for(let i=steps.length-1;i>=0;i--){const s=obj(steps[i]);if(s.kind==='final'&&typeof obj(s.data).text==='string')return obj(s.data).text;}return null;}
 function renderRun(r,data){
  const steps=Array.isArray(data.steps)?data.steps:[],runStatus=typeof data.status==='string'?data.status:'unknown';
  const nodes=[];
  const head=el('div',undefined,'adk-run-head');
  head.append(el('strong','Run '+r.runId),el('span',runStatus,'adk-status adk-status-'+clip(runStatus,12)),el('span','agent '+clip(data.agent||r.agent||'(not reported)',64),'adk-meta'));
  nodes.push(head);
  const line=el('p',undefined,'adk-run-line');r.elapsed=el('span',clock(Date.now()-r.startedAt),'adk-elapsed');
  line.append(el('span','Elapsed '),r.elapsed,el('span',' · '+budgetText(data.budget||r.budget)+' · '+spentText(data.spent)));
  nodes.push(line);
  r.statusLine=el('p',undefined,'adk-run-status');r.statusLine.setAttribute('role','status');nodes.push(r.statusLine);
  if(!data.done){
   const stop=el('button',r.stopRequested?'Stop requested':'Stop after this step','quiet-button adk-stop');stop.setAttribute('type','button');stop.disabled=!!r.stopRequested||!!r.stopping;
   stop.addEventListener('click',()=>requestStop(r));
   nodes.push(stop,el('small','Stop asks Echo ADK to stop after the current step. A provider call that is already running is not interrupted.','adk-meta'));
  }
  if(runStatus==='gated'){
   let gatedStep=null;for(let i=steps.length-1;i>=0;i--)if(obj(steps[i]).verdict==='gated'){gatedStep=steps[i];break;}
   nodes.push(gatedDetail(gatedStep||obj(data.error)));
  }
  const e=obj(data.error);
  if(e.code==='unavailable'){const box=el('div',undefined,'adk-stopbox');box.append(el('strong','Provider '+(typeof e.provider==='string'&&e.provider?e.provider:'(not named)')+' is unavailable.'),el('p','The step ended with unavailable. No fallback provider was used.'+(typeof e.message==='string'&&e.message?' '+clip(e.message,600):'')));nodes.push(box);}
  else if(e.code==='budget_exceeded'){const box=el('div',undefined,'adk-stopbox');box.append(el('strong','Budget stop: the run stopped at its budget.'),el('p',(typeof e.message==='string'&&e.message?clip(e.message,600)+' ':'')+spentText(data.spent)+'.'));nodes.push(box);}
  else if(runStatus==='failed'){const box=el('div',undefined,'adk-stopbox');box.append(el('strong','The run failed'+(typeof e.code==='string'?' ('+clip(e.code,40)+')':'')+'.'),el('p',typeof e.message==='string'&&e.message?clip(e.message,600):'Echo ADK gave no reason.'));nodes.push(box);}
  const text=finalText(steps);
  if(text!==null)nodes.push(el('h3','Final text'),el('p',clip(text,20000),'adk-final'));
  else if(runStatus==='done')nodes.push(el('p','The run finished without a final text.','adk-muted'));
  const stepsBox=el('section',undefined,'adk-steps');stepsBox.append(el('h3','Steps ('+steps.length+')'));
  if(steps.length){const ol=el('ol');steps.slice(0,500).forEach((s,i)=>ol.append(stepRow(s,i)));stepsBox.append(ol);}else stepsBox.append(el('p',runStatus==='queued'?'Queued; no step has run yet.':'No steps reported yet.','adk-muted'));
  nodes.push(stepsBox);
  if(data.proof&&typeof data.proof==='object')nodes.push(proofCard(data.proof));
  else if(data.done)nodes.push(el('p','No Proof was reported for this run.','adk-muted'));
  nodes.push(el('small','Output from governed agent steps; verify before relying on it.','adk-meta'));
  runView.replaceChildren(...nodes);
  runView.hidden=false;
  statusLine(r);
 }
 function failBox(r,title,detail){
  const head=el('div',undefined,'adk-run-head');head.append(el('strong','Run '+r.runId));
  runView.replaceChildren(head,el('p',title,'adk-error'),el('small',detail+' No fallback provider was used.','adk-meta'));
  runView.hidden=false;
 }
 function statusLine(r){
  if(!r.statusLine)return;
  r.statusLine.textContent=r.note||('Status: '+r.status+(document.hidden?' · polling paused while this tab is hidden':' · polling every 3 s'));
  if(r.elapsed)r.elapsed.textContent=clock(Date.now()-r.startedAt);
 }
 function stopTimers(r){if(r.timer)clearTimeout(r.timer);r.timer=null;r.controller.abort();}
 function finish(r){
  if(run!==r)return;
  run=null;stopTimers(r);
  // A result flashes success (done) or error (failed) over the orb; any other end (stopped, unknown run, lost contact,
  // wall clock) just releases this source's claim.
  if(r.status==='done'||r.status==='failed')orb(r.status==='done'?'success':'error');
  orb('idle');publishSatellites();
  if(admission()!=='signin'&&admission()!=='member'&&health&&health.available===true)api('runs?limit=20',undefined,undefined).then(v=>{if(!run)renderRuns(v.runs);}).catch(()=>{});
 }
 async function poll(r){
  r.inflight=true;r.lastPoll=Date.now();
  try{
   const data=await api('runs/'+encodeURIComponent(r.runId),undefined,r.controller.signal);
   if(run!==r)return;
   r.failures=0;r.status=typeof data.status==='string'?data.status:r.status;
   if(data.done===true){
    renderRun(r,data);r.note='Finished after '+clock(Date.now()-r.startedAt)+'.';statusLine(r);
    debug('adk_run',data.status==='done'?'completed':'failed',{runId:r.runId,steps:Array.isArray(data.steps)?data.steps.length:0});
    if(typeof window.EchoPrimeArtifacts?.register==='function'&&!r.artifactRegistered){
     r.artifactRegistered=true;
     const p=obj(data.proof),ft=finalText(Array.isArray(data.steps)?data.steps:[]);
     void window.EchoPrimeArtifacts.register({
      title:`ADK · ${clip(data.agent||r.agent||'agent',60)} · ${clip(r.runId,40)}`,
      kind:'proof',
      content:{run_id:r.runId,status:data.status,final_text:ft,proof:data.proof||null,spent:data.spent||null},
      provenance:{
       source:'adk',
       agent:String(data.agent||r.agent||''),
       run_id:String(r.runId),
       ...(r.prompt?{prompt:String(r.prompt)}:{}),
       ...(typeof p.verdict==='string'?{verdict:p.verdict}:{}),
       ...(typeof p.events_sha256==='string'?{events_sha256:p.events_sha256}:{}),
      },
     }).catch(()=>{});
    }
    finish(r);return;
   }
   renderRun(r,data);
  }catch(error){
   if(run!==r||r.controller.signal.aborted)return;
   r.failures++;
   const message=error instanceof Error?error.message:'request failed';
   if(error&&error.status===404){failBox(r,'Echo ADK does not know run '+r.runId+'.',message);debug('adk_run','not_found',{runId:r.runId});finish(r);return;}
   if(r.failures>=MAX_FAILURES){failBox(r,'Lost contact with Echo ADK.','Run '+r.runId+' may still be running and spending its budget. Last error: '+message+'.');debug('adk_run','lost_contact',{runId:r.runId});finish(r);return;}
   r.note='Status check failed ('+r.failures+'/'+MAX_FAILURES+'): '+message+'. Retrying.';statusLine(r);
  }finally{r.inflight=false;}
 }
 function tick(r){
  if(run!==r)return;
  const elapsed=Date.now()-r.startedAt,wallS=num(obj(r.budget).max_wall_s)??1800;
  if(r.elapsed)r.elapsed.textContent=clock(elapsed);
  if(elapsed>wallS*1000+GRACE_S*1000){
   failBox(r,'Stopped waiting: the wall-clock budget plus grace has passed.','Run '+r.runId+' may still be running on Echo ADK; open it from Recent runs and use Stop to end it after its current step.');
   debug('adk_run','timeout',{runId:r.runId});finish(r);return;
  }
  if(document.hidden)statusLine(r);
  else if(!r.inflight&&Date.now()-r.lastPoll>=POLL_MS)void poll(r);
  if(run===r)r.timer=setTimeout(()=>tick(r),TICK_MS);
 }
 function stopWatching(r,quiet){
  if(run!==r)return;
  if(!quiet)failBox(r,'Stopped watching.','Run '+r.runId+' continues on Echo ADK until it finishes or is stopped.');
  run=null;stopTimers(r);
  orb('idle');publishSatellites();
 }
 async function requestStop(r){
  if(run!==r||r.stopping||r.stopRequested)return;
  r.stopping=true;r.note='Asking Echo ADK to stop after the current step…';statusLine(r);
  try{
   const reply=await api('runs/'+encodeURIComponent(r.runId)+'/stop',{},r.controller.signal);
   if(run!==r)return;
   r.stopRequested=true;r.note='Stop requested (status '+clip(reply.status,20)+'). The run stops after the current step; a running provider call is not interrupted.';
   debug('adk_run','stop_requested',{runId:r.runId});
  }catch(error){
   if(run!==r)return;
   r.note='Stop was not accepted: '+(error instanceof Error?error.message:'request failed')+'. The run continues.';
  }finally{if(run===r){r.stopping=false;statusLine(r);r.lastPoll=0;}}
 }
 function watch(runId,agent,budget,runPrompt=''){
  const r={runId,agent,budget,prompt:runPrompt,artifactRegistered:false,status:'queued',startedAt:Date.now(),lastPoll:0,inflight:false,failures:0,note:'',controller:new AbortController(),timer:null,stopRequested:false,stopping:false,statusLine:null,elapsed:null};
  run=r;
  renderRun(r,{status:'queued',agent,budget,steps:[],done:false});
  r.timer=setTimeout(()=>tick(r),0);
  orb('deep');publishSatellites();
  return r;
 }
 // ---- form ---------------------------------------------------------------------
 function budgetInput(){
  const out={};
  for(const [node,key] of [[calls,'max_calls'],[cost,'max_cost_usd'],[wall,'max_wall_s']]){
   const raw=String(node.value||'').trim();if(!raw)continue;
   const n=Number(raw);if(!Number.isFinite(n))throw new Error('Budget '+key+' must be a number.');
   out[key]=n;
  }
  return out;
 }
 form.addEventListener('submit',async event=>{
  if(event&&typeof event.preventDefault==='function')event.preventDefault();
  if(busy||!agents.some(a=>a.name===select.value))return;
  const text=String(prompt.value||'');
  if(!text.trim()){status.textContent='Enter a prompt for the agent.';return;}
  if(text.length>MAX_CHARS){status.textContent='Echo ADK accepts at most '+MAX_CHARS+' characters. The prompt remains in this view.';return;}
  let budget;try{budget=budgetInput();}catch(error){status.textContent=error.message;return;}
  if(run)stopWatching(run,true);
  remember();lock(true);const mine=generation;
  status.textContent='Submitting to Echo ADK…';
  try{
   const accepted=await api('runs',{agent:select.value,prompt:text,...(Object.keys(budget).length?{budget}:{})},controller?controller.signal:undefined);
   if(mine!==generation)return;
   status.textContent='Run '+accepted.runId+' accepted ('+clip(accepted.status,20)+'). '+budgetText(accepted.budget)+'.';
   debug('adk_run','submitted',{runId:accepted.runId,agent:select.value});
   watch(accepted.runId,select.value,accepted.budget,text);
  }catch(error){
   if(mine!==generation)return;
   const message=error instanceof Error?error.message:'request failed';
   status.textContent='The run was not started: '+message+'. Nothing is running unless the connection dropped after Echo ADK accepted it. No fallback provider was used.';
   debug('adk_run','refused',{status:error&&typeof error.status==='number'?error.status:null});
  }finally{if(mine===generation)lock(false);}
 });
 function clearPrivate(){
  generation++;controller?.abort();controller=null;
  if(run)stopWatching(run,true);
  agents=[];orbAgents=[];health=null;list.replaceChildren();select.replaceChildren();runsList.replaceChildren();runView.replaceChildren();runView.hidden=true;prompt.value='';calls.value='';cost.value='';wall.value='';
  status.textContent='Agents have not been checked.';lock(true);
  if(panel.open)panel.close();
  publishSatellites();
 }
 opener.addEventListener('click',()=>{if(!panel.open)panel.showModal();return load();});
 $('#close-agents').addEventListener('click',()=>panel.close());
 $('#refresh-agents').addEventListener('click',()=>load());
 panel.addEventListener('close',()=>{generation++;controller?.abort();if(run)stopWatching(run,true);lock(true);});
 select.addEventListener('change',remember);
 document.addEventListener('visibilitychange',()=>{if(run){run.lastPoll=0;if(!document.hidden){if(run.timer)clearTimeout(run.timer);tick(run);}else statusLine(run);}});
 window.addEventListener('echo-account-changed',clearPrivate);
 window.addEventListener('pagehide',()=>{if(run)stopWatching(run,true);});
 // A click on an agent moon opens this view and selects that agent (additive; the list is loaded by open() as usual).
 document.addEventListener('echo-orb-open',event=>{
  const d=event&&event.detail;if(!d||d.kind!=='agent'||typeof d.id!=='string'||!d.id.startsWith('agent:'))return;
  const name=d.id.slice(6);
  Promise.resolve(window.EchoPrimeAgents.open()).then(()=>{if(agents.some(a=>a.name===name)){select.value=name;remember();}}).catch(()=>{});
 });
 runView.hidden=true;lock(true);
 window.EchoPrimeAgents={open(){if(!panel.open)panel.showModal();return load();},refresh:load,active(){return run?run.runId:null;},watch(id){return watch(String(id),'',null);}};
})();
