(() => {
 'use strict';
 // echoBots: always-on governed agents (Echo's answer to Grok Bots) served by the loopback echo-adk-api service through the
 // Prime server (/api/prime/bots/*, owner-only). This file owns the "echoBots" nav entry and view: bot cards, the create form,
 // pause/resume/delete, a bot chat polled every 3 s (paused while the tab is hidden) and group chats of 2 to 6 bots.
 // Nothing here is fetched until the Workspace session says owner (or the host has no Workspace and the Prime cookie decides).
 // There is no fallback: when the service is off, down or refuses, the view says so and nothing else answers.
 const doc=document;
 const POLL_MS=3000,TICK_MS=1000,LIST_MS=30000,MAX_FAILURES=5,MAX_TEXT=12000,MAX_NAME=64,MAX_CAP=5,GROUP_MIN=2,GROUP_MAX=6,COOLDOWN_MS=5000,STORAGE='echo-prime-bot-v1';
 const HEX=/^[0-9a-f]{32}$/,STATUSES=['paused','idle','running','error'];
 let verdict={configured:false,available:false,reason:'echoBots status not loaded'},health=null,healthCheckedAt=null,bots=[],agents=null,agentsLoaded=false;
 let selected=null,pendingDelete=null,editing=null,pane='none',noteText='',busy=false,generation=0,healthGeneration=0,failedAt=-Infinity,lastList=0;
 let dialog=null,ui=null,navButton=null,chat=null,group=null,timer=null,workspaceView=null;
 const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const str=(v,n)=>typeof v==='string'?(v.length>n?v.slice(0,n)+'…':v):'';
 const list=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x):[];
 function el(tag,text,cls){const e=doc.createElement(tag);if(text!==undefined&&text!==null)e.textContent=String(text);if(cls)e.className=cls;return e;}
 function attr(node,attributes){for(const [k,v] of Object.entries(attributes))if(v!==undefined&&v!==false)node.setAttribute(k,String(v));return node;}
 function button(label,onClick,cls){const b=attr(el('button',label,cls||'quiet-button'),{type:'button'});b.addEventListener('click',onClick);return b;}
 function money(v){return num(v)===null?'not reported':'$'+(Math.round(v*100)/100).toFixed(2);}
 function when(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v))return '';const date=new Date(v);return Number.isFinite(date.getTime())?date.toISOString().slice(0,19).replace('T',' ')+' UTC':'';}
 function service(){return health&&health.service&&typeof health.service==='object'?health.service:{};}
 function readiness(){
  const s=service(),f=s.features||{},c=s.connections||{},memory=c.memory||{},browser=c.browser||{};
  return [
   'Calendar scheduling: '+(f.calendar_schedules===true?'available':'not reported'),
   'Event delivery: '+(f.idempotent_events===true?'idempotent events available':'not reported'),
   'Memory: '+(memory.recall===true?(memory.provider==='local'?'local recall':'recall available')+(memory.durable===true?', durable':'')+(memory.shared===false?', scoped per bot':''):'recall not reported'),
   'Browser: '+(browser.available===true?'available':typeof browser.reason==='string'?str(browser.reason,200):'readiness not reported')
  ];
 }
 function shortId(id){return typeof id==='string'?id.slice(0,8)+'…':'';}
 function debug(event,detail){console.debug('[echo.bots]',{event,...(detail||{})});}
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 async function headers(){try{const ws=workspace();return ws&&ws.ownerHeaders?await ws.ownerHeaders():{};}catch{return {};}}
 /** What the Workspace's cached session admits, read without a request: 'open' (no authenticated Workspace on this host, the
  *  Prime cookie alone decides), 'signin', 'member' or 'owner'. Every /api/prime/bots route is owner-only. */
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 const allowed=()=>{const a=admission();return a==='open'||a==='owner';};
 function orbEvent(name,detail){try{if(typeof doc.dispatchEvent==='function'&&typeof CustomEvent==='function')doc.dispatchEvent(new CustomEvent(name,{detail}));}catch{}}
 // The orb keeps 24 moons across every publisher, busy first. Busy bots (running, or in a live group chat) go first here and
 // the rest keep list order, so the 24 sent always include a running bot or a group member listed past the 24th.
 function publishSatellites(){
  const live=!!group&&!group.done;
  const moons=allowed()?bots.map(bot=>{const inGroup=live&&group.bots.includes(bot.bot_id),satelliteGroup=inGroup?group.groupId:undefined;return {id:'bot:'+bot.bot_id,kind:'bot',name:str(bot.name,80)||shortId(bot.bot_id),status:STATUSES.includes(bot.status)?bot.status:'idle',busy:bot.status==='running'||inGroup,group:satelliteGroup};}):[];
  moons.sort((a,b)=>Number(b.busy)-Number(a.busy));
  orbEvent('echo-orb-satellites',{source:'bots',satellites:moons.slice(0,24)});
 }
 async function request(url,body,signal){
  const sent={'x-prime-request':'1',...await headers(),...(body?{'content-type':'application/json'}:{})},owner=admission()==='owner';
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',headers:sent,...(body?{body:JSON.stringify(body)}:{}),signal});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
   // Only a session that claimed owner admission has anything to invalidate (a real expiry or demotion); a visitor or member
   // is refused by design and a 405 from a route this host does not serve is not an identity event.
   const ws=workspace();
   if((response.status===401||response.status===403)&&(!data||data.source!=='bot_service')&&owner&&ws&&typeof ws.invalidate==='function'){ws.invalidate();debug('invalidated',{status:response.status,url});}
   const error=new Error(data&&typeof data.error==='string'?data.error:'echoBots request failed (HTTP '+response.status+')');error.status=response.status;error.outcomeUnknown=data&&data.outcome_unknown===true;throw error;
  }
  if(!data||typeof data!=='object')throw new Error('echoBots returned an unrecognized response');
  return data;
 }
 const api=(path,body,signal)=>request('/api/prime/bots/'+path,body,signal);
 function report(next){verdict=next;renderStatus();applyNav();return verdict;}
 /** Reads the service health once the Workspace knows who is signed in; skips the owner-only route for anyone else, never
  *  retries a refusal and waits COOLDOWN_MS after any failure whatever events fire. */
 async function refreshHealth(){
  const mine=++healthGeneration,ws=workspace();
  if(ws)await Promise.resolve(ws.ready).catch(()=>{});
  if(mine!==healthGeneration)return verdict;
  applyNav();
  const access=admission();
  if(access==='signin'){debug('skipped',{reason:'signin'});return report({configured:false,available:false,reason:'Sign in to use echoBots.'});}
  if(access==='member'){debug('skipped',{reason:'owner_only'});return report({configured:false,available:false,reason:'echoBots are available to the primary owner only.'});}
  if(Date.now()-failedAt<COOLDOWN_MS){debug('cooldown',{remaining_ms:COOLDOWN_MS-(Date.now()-failedAt)});return verdict;}
  try{
   const data=await api('health');
   if(mine!==healthGeneration)return verdict;
   health=data;healthCheckedAt=new Date().toISOString();debug('health',{configured:data.configured===true,available:data.available===true});
   return report({configured:data.configured===true,available:data.available===true,reason:data.available===true?'':typeof data.reason==='string'?data.reason:'unavailable'});
  }catch(error){
   if(mine!==healthGeneration)return verdict;
   failedAt=Date.now();health=null;healthCheckedAt=null;
   const message=error instanceof Error?error.message:'request failed';
   debug('health_failed',{status:error&&typeof error.status==='number'?error.status:null,message});
   return report({configured:false,available:false,reason:'echoBots status unavailable ('+message+')'});
  }
 }
 function applyNav(){if(navButton)navButton.hidden=!allowed();}
 function note(text){noteText=text||'';if(ui)ui.note.textContent=noteText;}
 // ---- status, note and the Grok comparison ----------------------------------
 function renderStatus(){
  if(!ui)return;
  const access=admission();let text;
  if(access==='signin')text='Sign in to use echoBots.';
  else if(access==='member')text='echoBots are available to the primary owner only.';
  else if(!verdict.configured){
   const reason=typeof verdict.reason==='string'?verdict.reason:'';
   if(/status not loaded/.test(reason))text='Checking echoBots…';
   else if(/status unavailable/.test(reason))text=reason+'. Nothing was fetched from the service; no automatic retry was made.';
   else text='echoBots is off: the reviewed Prime configuration has no bots section. Add "bots": {"baseUrl": "http://127.0.0.1:8378"} (a loopback origin only; optional "defaultBudget" with max_calls, max_cost_usd, max_wall_s) to the --config file and restart Prime. Nothing is fetched while it is off.'+(reason?' ('+reason+')':'');
  }
  else if(!verdict.available)text='echoBots service unavailable: '+(verdict.reason||'no reason given')+'. Run status cannot be verified from this view.';
  else{
   const s=service();
   text='echo-adk-api'+(typeof s.version==='string'?' '+str(s.version,20):'')+' · '+(num(s.bots)===null?'bots not counted':s.bots+' bot'+(s.bots===1?'':'s'))+' · '+(num(s.agents)===null?'agents not counted':s.agents+' agent'+(s.agents===1?'':'s'))+' · '+(num(s.runsActive)===null?'active runs not counted':s.runsActive+' active run'+(s.runsActive===1?'':'s'))+'. Default daily cap '+money(health.defaultBudget&&health.defaultBudget.max_cost_usd)+'.';
  }
  ui.status.textContent=text;
  if(ui.readiness){
   ui.readiness.replaceChildren();ui.readiness.hidden=!verdict.available;
   if(verdict.available){
    for(const line of readiness())ui.readiness.append(el('p',line,'bots-meta'));
    const budget=service().budgets;
    if(budget&&typeof budget==='object')ui.readiness.append(el('p','Service budget snapshot'+(typeof budget.day==='string'&&/^\d{4}-\d\d-\d\d$/.test(budget.day)?' for '+budget.day+' (UTC)':'')+': '+money(budget.spent_today_usd)+' used · '+money(budget.reserved_usd)+' reserved · '+money(budget.available_usd)+' available · '+money(budget.daily_cap_usd)+' cap. Checked '+(when(healthCheckedAt)||'at an unreported time')+'. Refresh to update.','bots-meta'));
    else ui.readiness.append(el('p','Service budget accounting: not reported.','bots-meta'));
   }
  }
 }
 function comparison(){
  const d=el('details',undefined,'bots-note');d.append(el('summary','Bot controls and data scope'));
  d.append(el('p','Bots start paused. Each bot has a capability lease, memory notes and run history. Configured browsers use separate processes and profiles on the same host. App connections belong to one bot and require provider consent. Readiness and budget figures come from the connected service. Deleting a bot removes its local resources; provider revocation is reported separately.'));
  return d;
 }
 // ---- bot cards -------------------------------------------------------------
 function badge(bot){
  const status=STATUSES.includes(bot.status)?bot.status:'unknown';
  return el('span',status==='unknown'?'status not reported':status,'bots-badge bots-status-'+status);
 }
 function meter(bot){
  const budget=bot.budget&&typeof bot.budget==='object'?bot.budget:{},spent=num(budget.spent_today_usd)??num(bot.spent_today_usd),cap=num(budget.daily_cap_usd)??num(bot.daily_cost_cap_usd),reserved=num(budget.reserved_usd),available=num(budget.available_usd),used=(spent||0)+(reserved||0);
  const wrap=el('div',undefined,'bots-meter-wrap');
  const bar=attr(el('div',undefined,'bots-meter'),{role:'meter','aria-label':'Used and reserved today against the daily cost cap','aria-valuemin':'0','aria-valuemax':String(cap===null?0:cap),'aria-valuenow':String(cap===null?0:Math.min(cap,used)),'aria-valuetext':money(spent)+' used; '+money(reserved)+' reserved; '+money(available)+' available'});
  const pct=cap!==null&&cap>0?Math.min(100,Math.max(0,(spent||0)/cap*100)):(spent||0)>0?100:0;
  const heldPct=cap!==null&&cap>0?Math.min(100-pct,Math.max(0,(reserved||0)/cap*100)):0;
  bar.append(attr(el('span',undefined,'bots-meter-fill'+(pct>=100?' bots-meter-full':'')),{style:'width:'+pct+'%'}),attr(el('span',undefined,'bots-meter-reserved'),{style:'width:'+heldPct+'%'}));
  wrap.append(bar,el('small',money(spent)+' used · '+money(reserved)+' reserved · '+money(available)+' available of '+money(cap)+' today (UTC)','bots-meta'));
  if(num(budget.uncertain_charged_today_usd)>0)wrap.append(el('small',money(budget.uncertain_charged_today_usd)+' charged conservatively because final cost was not reported.','bots-meta'));
  return wrap;
 }
 function row(label,value){const p=el('p',undefined,'bots-row');p.append(el('span',label,'bots-label'),el('span',value));return p;}
 function schedule(bot){const s=bot.schedule;if(!s||typeof s!=='object')return 'on message only';if(s.once_at)return 'once '+str(s.once_at,16)+' '+str(s.tz,100)+(bot.schedule_complete?' · complete':'');if(s.cron)return 'cron '+str(s.cron,256)+' · '+str(s.tz,100);if(typeof s.at==='string'&&typeof s.tz==='string'){const days=Array.isArray(s.weekdays)?s.weekdays.map(d=>['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'][d]).filter(Boolean).join(', '):Array.isArray(s.monthdays)?'days '+s.monthdays.join(', ')+(Array.isArray(s.months)?' · months '+s.months.join(', '):' of each month'):'days not reported';return str(s.at,5)+' '+str(s.tz,100)+' · '+days+' · '+(s.missed==='once'?'catch up once':'skip missed');}const every=num(s.every_s);return every===null?'not reported':every%60===0?'every '+(every/60)+' min':'every '+every+' s';}
 function card(bot){
  const art=el('article',undefined,'bots-card'+(selected===bot.bot_id?' bots-card-selected':'')+(pendingDelete===bot.bot_id?' bots-card-confirm':''));
  attr(art,{'data-bot-id':bot.bot_id});
  const head=el('div',undefined,'bots-card-head');
  head.append(el('h3',str(bot.name,80)||'(unnamed bot)'),el('span',str(bot.mode,20)||'personal','bots-badge bots-mode'),badge(bot));
  if(bot.origin&&typeof bot.origin==='object'&&bot.origin.by==='echo')head.append(el('span','Echo-made from your prompt','bots-badge autoagent-badge'));// created by Echo from a chat prompt (autoagents.js)
  art.append(head,row('Agent',str(bot.agent,80)||'not reported'),row('Schedule',schedule(bot)),row('Plugins',list(bot.plugins).length?list(bot.plugins).slice(0,12).map(p=>str(p,40)).join(', '):'none'),meter(bot),
   row('Inbox',num(bot.inbox_depth)===null?'not reported':bot.inbox_depth+' waiting'),row('Next run',bot.status==='paused'?'paused':when(bot.next_run_at)||(bot.schedule?'not reported':'on message')),row('Last run',when(bot.last_run_at)||'never'));
  if(typeof bot.last_run_id==='string'&&HEX.test(bot.last_run_id))art.append(runLink(bot.last_run_id));
  if(typeof bot.last_error==='string'&&bot.last_error)art.append(el('p','Last error: '+str(bot.last_error,300),'bots-error'));
  const actions=el('div',undefined,'bots-actions'),controls=[];
  controls.push(button(selected===bot.bot_id&&pane==='chat'?'Chat open':'Open chat',()=>select(bot.bot_id)));
  const paused=bot.status==='paused';
  controls.push(button(paused?'Resume':'Pause',()=>act(bot.bot_id,paused?'resume':'pause')));
  controls.push(button('Stop',()=>act(bot.bot_id,'stop')),button('Edit',()=>edit(bot.bot_id)));
  if(service().features&&service().features.bot_workspaces===true)controls.push(button('Browser & apps',()=>{stopChat();selected=bot.bot_id;pane='workspace';renderPane();}));
  if(pendingDelete===bot.bot_id)controls.push(button('Confirm delete',()=>act(bot.bot_id,'delete'),'quiet-button bots-danger'),button('Cancel',()=>{pendingDelete=null;note('');renderList();}));
  else controls.push(button('Delete',()=>{pendingDelete=bot.bot_id;note('Select Confirm delete on '+(str(bot.name,80)||'this bot')+' to remove it, or Cancel.');renderList();}));
  for(const b of controls)b.disabled=busy;
  actions.append(...controls);
  if(pendingDelete===bot.bot_id)actions.append(el('small','Deleting removes this bot from the service. Run records and backups may remain.','bots-meta'));
  art.append(actions);
  return art;
 }
 function renderList(){
  if(!ui)return;
  if(!verdict.available){ui.list.replaceChildren();return;}
  if(!bots.length){ui.list.replaceChildren(el('p','No bots yet. Create one: it starts paused and runs nothing until you resume it.','bots-meta'));return;}
  ui.list.replaceChildren(...bots.slice(0,200).map(card));
 }
 async function loadList(){
  if(!allowed()||!verdict.available)return;
  const gen=generation;
  try{
   const data=await api('list');
   if(gen!==generation)return;
   bots=Array.isArray(data.bots)?data.bots.filter(b=>b&&typeof b==='object'&&HEX.test(String(b.bot_id))):[];
   publishSatellites();
   lastList=Date.now();
   if(pendingDelete&&!bots.some(b=>b.bot_id===pendingDelete))pendingDelete=null;
   if(selected&&!bots.some(b=>b.bot_id===selected)){stopChat();selected=null;editing=null;if(pane==='chat'||pane==='edit'||pane==='workspace')pane='none';}
   renderList();renderPane();debug('list',{bots:bots.length});
  }catch(error){if(gen!==generation)return;note('Bot list unavailable: '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.');}
 }
 async function loadAgents(){
  if(agentsLoaded||!allowed())return;
  agentsLoaded=true;const gen=generation;
  try{
   const data=await request('/api/prime/adk/agents');
   if(gen!==generation)return;
   agents=Array.isArray(data.agents)?data.agents.filter(a=>a&&typeof a==='object'&&typeof a.name==='string'&&a.name).slice(0,200):null;
  }catch(error){if(gen!==generation)return;agents=null;debug('agents_unavailable',{status:error&&typeof error.status==='number'?error.status:null});}
  if(pane==='create')renderPane();
 }
 async function act(botId,action){
  if(busy||!HEX.test(botId))return;
  const gen=generation,bot=bots.find(b=>b.bot_id===botId),name=bot?str(bot.name,80):shortId(botId);
  busy=true;renderList();
  try{
   const result=await api(botId+'/'+action,{});
   if(gen!==generation)return;
   if(action==='stop'){
    bots=bots.map(b=>b.bot_id===botId?{...b,status:STATUSES.includes(result.status)?result.status:b.status}:b);
    note('Stop requested for '+name+'. Active provider steps may still be running. Refresh to check before editing.');
   }else if(action==='delete'){
    bots=bots.filter(b=>b.bot_id!==botId);pendingDelete=null;
    if(selected===botId){stopChat();selected=null;editing=null;if(pane==='chat'||pane==='edit'||pane==='workspace')pane='none';try{localStorage.removeItem(STORAGE);}catch{}}
    const revocations=result.cleanup&&result.cleanup.connections&&result.cleanup.connections.connections,remaining=Array.isArray(revocations)?revocations.filter(c=>!c.provider_revoked&&c.revocation_status!=='not_needed'):[];
    note('Deleted '+name+' (confirmed by the service).'+(remaining.length?' Local app access was removed; '+remaining.length+' provider revocation(s) need review in the provider account.':''));
   }else{
    bots=bots.map(b=>b.bot_id===botId?result:b);
    note((action==='pause'?'Paused ':'Resumed ')+name+': status '+(STATUSES.includes(result.status)?result.status:'not reported')+'.');
   }
   publishSatellites();
   debug('action',{action,outcome:'returned'});
  }catch(error){if(gen!==generation)return;note((action==='delete'?'Delete':action==='pause'?'Pause':action==='stop'?'Stop':'Resume')+' failed for '+name+': '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.');debug('action',{action,outcome:'failed'});}
  finally{if(gen===generation){busy=false;renderList();renderPane();}}
 }
 async function edit(botId){
  if(busy||!allowed()||!HEX.test(botId))return;
  const gen=generation;busy=true;renderList();
  try{
   const bot=await api(botId);
   if(gen!==generation)return;
   if(bot.bot_id!==botId)throw new Error('the service answered for a different bot');
   bots=bots.map(b=>b.bot_id===botId?bot:b);
   if(bot.status!=='paused'||num(bot.inbox_depth)!==0){note('Pause the bot and stop pending work before editing. Stop requests cancellation; active steps may take time to finish.');return;}
   stopChat();selected=botId;editing=bot;pane='edit';note('');renderPane(true);
  }catch(error){if(gen===generation)note('Bot editor unavailable: '+(error instanceof Error?error.message:'request failed')+'.');}
  finally{if(gen===generation){busy=false;renderList();}}
 }
 // ---- panes: create, chat, group -------------------------------------------
 function field(label,node){const l=el('label',undefined,'workspace-field');l.append(el('span',label),node);return l;}
 function createPane(existing){
  const wrap=el('section',undefined,'bots-form');
  wrap.append(el('h3',existing?'Edit bot':'New bot'),el('p',existing?'Editing requires a paused bot with no active or pending work. The service checks this again when saving. Saving leaves the bot paused.':'Bots start paused. Resume one from its card when you are ready; a paused bot still accepts messages and answers when resumed.','bots-meta'));
  const name=attr(el('input'),{maxlength:MAX_NAME,placeholder:'Bot name (up to 64 characters)',autocomplete:'off'});
  let agent;
  if(existing){agent=attr(el('input'),{readonly:true,'aria-label':'Agent (cannot change)'});agent.value=existing.agent;agent.disabled=true;}
  else if(agents&&agents.length){
   agent=el('select');
   for(const a of agents){const o=el('option',a.name+(typeof a.role==='string'&&a.role?' · '+str(a.role,60):''));o.value=a.name;agent.append(o);}
   agent.value=agents[0].name;
  }else agent=attr(el('input'),{maxlength:120,placeholder:'Echo ADK agent name (the Agents view did not answer; type the exact name)',autocomplete:'off'});
  const mode=el('select');for(const m of ['personal','team']){const o=el('option',m);o.value=m;mode.append(o);}mode.value='personal';
  const scheduled=attr(el('input'),{type:'checkbox'});
  const minutes=attr(el('input'),{type:'number',min:'1',max:'10080',step:'1'});minutes.value='15';minutes.disabled=true;
  const scheduleType=attr(el('select'),{'aria-label':'Schedule type'});
  for(const [value,label] of [['interval','Every N minutes'],['calendar','Weekly calendar'],['once','Once'],['monthly','Monthly'],['yearly','Yearly'],['cron','Custom cron']]){const option=el('option',label);option.value=value;scheduleType.append(option);}scheduleType.value='interval';
  const calendarReady=service().features&&service().features.calendar_schedules===true;
  scheduleType.children[1].disabled=!calendarReady;
  for(let i=2;i<scheduleType.children.length;i++)scheduleType.children[i].disabled=service().features&&service().features.extended_schedules!==true;
  const time=attr(el('input'),{type:'time','aria-label':'Local run time'});time.value='09:00';
  const timezone=attr(el('input'),{maxlength:100,placeholder:'Timezone, e.g. America/Chicago','aria-label':'Schedule timezone',autocomplete:'off'});
  try{timezone.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{timezone.value='UTC';}
  const dayGroup=attr(el('fieldset',undefined,'bots-weekdays'),{'aria-label':'Run on weekdays'});dayGroup.append(el('legend','Run on'));
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((label,i)=>{const box=attr(el('input'),{type:'checkbox',value:String(i+1),'aria-label':label});box.checked=i<5;const pick=el('label',undefined,'bots-pick');pick.append(box,el('span',label));dayGroup.append(pick);return box;});
  const missed=attr(el('select'),{'aria-label':'Missed run policy'});
  for(const [value,label] of [['skip','Skip missed times'],['once','Catch up once after downtime']]){const option=el('option',label);option.value=value;missed.append(option);}missed.value='skip';
  const calendarFields=el('div',undefined,'bots-calendar');
  const once=attr(el('input'),{type:'datetime-local','aria-label':'One-time local date and time'}),monthdays=attr(el('input'),{'aria-label':'Days of month',placeholder:'1, 15',maxlength:100}),months=attr(el('input'),{'aria-label':'Months of year',placeholder:'1, 6, 12',maxlength:50}),cron=attr(el('input'),{'aria-label':'Five-field cron',placeholder:'0 9 * * 1-5',maxlength:256});monthdays.value='1';months.value='1';cron.value='0 9 * * 1-5';
  const onceField=field('Local date and time',once),monthdaysField=field('Days of month (1–31)',monthdays),monthsField=field('Months (1–12)',months),cronField=field('Cron: minute hour day month weekday',cron);
  const timeField=field('Local time',time),clockRow=el('div',undefined,'bots-inline');clockRow.append(timeField,field('Timezone (IANA name)',timezone));
  calendarFields.append(clockRow,onceField,dayGroup,monthdaysField,monthsField,cronField,field('If a scheduled time was missed',missed),el('p','Daylight saving: a skipped local time is skipped; a repeated time runs once. Dates absent from a month are skipped. The next run is shown in UTC.','bots-meta'));
  const minutesField=field('Every N minutes (1 to 10080)',minutes);
  function updateSchedule(){const kind=scheduleType.value,calendar=scheduled.checked&&kind!=='interval';scheduleType.disabled=!scheduled.checked;minutes.disabled=!scheduled.checked||calendar;minutesField.hidden=calendar;calendarFields.hidden=!calendar;for(const control of [time,timezone,missed,once,monthdays,months,cron,...days])control.disabled=!calendar;dayGroup.hidden=kind!=='calendar';onceField.hidden=kind!=='once';monthdaysField.hidden=!['monthly','yearly'].includes(kind);monthsField.hidden=kind!=='yearly';cronField.hidden=kind!=='cron';timeField.hidden=['once','cron'].includes(kind);}
  scheduled.addEventListener('change',updateSchedule);scheduleType.addEventListener('change',updateSchedule);updateSchedule();
  const instruction=attr(el('textarea'),{rows:'3',maxlength:MAX_TEXT,placeholder:'Standing instruction (optional, up to 12000 characters)'});
  const plugins=attr(el('input'),{placeholder:'Skill names, comma-separated (optional)',autocomplete:'off'});
  const cap=attr(el('input'),{type:'number',min:'0',max:String(MAX_CAP),step:'0.01'});cap.value=String(num(health&&health.defaultBudget&&health.defaultBudget.max_cost_usd)||0);
  const scopes=attr(el('input'),{placeholder:'Exact capability ids, comma-separated (optional; the agent default lease applies when empty)',autocomplete:'off'});
  const ttl=attr(el('input'),{type:'number',min:'1',step:'1'});ttl.value='3600';
  const uses=attr(el('input'),{type:'number',min:'1',step:'1'});uses.value='100';
  if(existing){
   name.value=existing.name;mode.value=existing.mode||'personal';instruction.value=typeof existing.instruction==='string'?existing.instruction:'';plugins.value=list(existing.plugins).join(', ');cap.value=String(existing.daily_cost_cap_usd);
   const lease=existing.lease||{};scopes.value=list(lease.scopes).join(', ');ttl.value=num(lease.ttl_s)===null?'':String(lease.ttl_s);uses.value=num(lease.max_uses)===null?'':String(lease.max_uses);
   scopes.setAttribute('placeholder','Exact capability ids; leave empty to revoke all capabilities');
   if(existing.schedule){const s=existing.schedule;scheduled.checked=true;timezone.value=s.tz||timezone.value;missed.value=s.missed||'skip';if(s.once_at){scheduleType.value='once';once.value=s.once_at;}else if(s.cron){scheduleType.value='cron';cron.value=s.cron;}else if(s.monthdays){scheduleType.value=s.months?'yearly':'monthly';time.value=s.at;monthdays.value=s.monthdays.join(', ');if(s.months)months.value=s.months.join(', ');}else if(typeof s.at==='string'){scheduleType.value='calendar';time.value=s.at;days.forEach((day,i)=>{day.checked=Array.isArray(s.weekdays)&&s.weekdays.includes(i+1);});}else minutes.value=String(s.every_s/60);}
   updateSchedule();
  }
  const scheduleDraft=()=>JSON.stringify([scheduled.checked,scheduleType.value,minutes.value,time.value,timezone.value,days.map(day=>day.checked),missed.value,once.value,monthdays.value,months.value,cron.value]);
  const initial={name:name.value.trim(),mode:mode.value,instruction:instruction.value,plugins:plugins.value,cap:cap.value,scopes:scopes.value,ttl:ttl.value,uses:uses.value,schedule:scheduleDraft()};
  const scheduleRow=el('div',undefined,'bots-inline');scheduleRow.append(field('Run on a schedule',scheduled),field('Schedule type',scheduleType),minutesField);
  const leaseRow=el('div',undefined,'bots-inline');leaseRow.append(field('Lease TTL (seconds)',ttl),field('Lease max uses',uses));
  const submit=button(existing?'Save bot changes':'Create bot (starts paused)',async()=>{
   if(busy)return;
   const n=name.value.trim(),a=String(agent.value||'').trim();
   if(!n||n.length>MAX_NAME){note('Give the bot a name of 1 to '+MAX_NAME+' characters.');return;}
   if(!a){note('Name the Echo ADK agent this bot runs.');return;}
   const body=existing?{}:{name:n,agent:a,mode:mode.value};
   if(existing&&n!==initial.name)body.name=n;
   if(existing&&mode.value!==initial.mode)body.mode=mode.value;
   if((!existing||scheduleDraft()!==initial.schedule)&&scheduled.checked){
    if(scheduleType.value!=='interval'){
     if(!calendarReady){note('Calendar scheduling is not reported by this service.');return;}
     const tz=timezone.value.trim(),weekdays=days.flatMap((day,i)=>day.checked?[i+1]:[]);
     if(!['once','cron'].includes(scheduleType.value)&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)){note('Choose a local time in HH:mm format.');return;}
     try{if(!tz)throw new Error();new Intl.DateTimeFormat('en',{timeZone:tz}).format();}catch{note('Enter a valid IANA timezone, such as America/Chicago or UTC.');return;}
     if(scheduleType.value==='calendar'){if(!weekdays.length){note('Choose at least one weekday.');return;}body.schedule={at:time.value,tz,weekdays,missed:missed.value};}
     else if(scheduleType.value==='once'){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(once.value)){note('Choose a local date and time.');return;}body.schedule={once_at:once.value,tz,missed:missed.value};}
     else if(scheduleType.value==='cron'){if(cron.value.trim().split(/\s+/).length!==5){note('Enter five cron fields.');return;}body.schedule={cron:cron.value.trim(),tz,missed:missed.value};}
     else{const dates=monthdays.value.split(',').map(s=>Number(s.trim())),selectedMonths=months.value.split(',').map(s=>Number(s.trim()));if(!dates.length||dates.some(n=>!Number.isInteger(n)||n<1||n>31)||(scheduleType.value==='yearly'&&(!selectedMonths.length||selectedMonths.some(n=>!Number.isInteger(n)||n<1||n>12)))){note('Enter valid day and month numbers separated by commas.');return;}body.schedule={at:time.value,tz,monthdays:[...new Set(dates)],...(scheduleType.value==='yearly'?{months:[...new Set(selectedMonths)]}:{}),missed:missed.value};}
    }else{const m=Number(minutes.value);if(!Number.isSafeInteger(m)||m<1||m>10080){note('The schedule needs a whole number of minutes from 1 to 10080.');return;}body.schedule={every_s:m*60};if(existing&&existing.schedule&&existing.schedule.missed)body.schedule.missed=existing.schedule.missed;}
   }
   if(existing&&scheduleDraft()!==initial.schedule&&!scheduled.checked)body.schedule=null;
   if(existing?instruction.value!==initial.instruction:instruction.value.trim())body.instruction=instruction.value.trim()?instruction.value:null;
   const skills=plugins.value.split(',').map(s=>s.trim()).filter(Boolean);if(existing?plugins.value!==initial.plugins:skills.length)body.plugins=skills;
   const c=Number(cap.value);if(!cap.value.trim()||!Number.isFinite(c)||c<0||c>MAX_CAP){note('The daily cost cap must be between $0 and $'+MAX_CAP+'.');return;}if(!existing||cap.value!==initial.cap)body.daily_cost_cap_usd=Math.round(c*100)/100;
   const ids=scopes.value.split(',').map(s=>s.trim()).filter(Boolean);
   if(existing){
    const lease={};if(scopes.value!==initial.scopes)lease.scopes=ids;
    for(const [key,node,previous] of [['ttl_s',ttl,initial.ttl],['max_uses',uses,initial.uses]])if(node.value!==previous){const value=Number(node.value);if(!Number.isSafeInteger(value)||value<1){note('Lease TTL and max uses must be whole numbers of at least 1.');return;}lease[key]=value;}
    if(Object.keys(lease).length)body.lease=lease;
    if(!Object.keys(body).length){note('No changes to save.');return;}
   }else if(ids.length){const t=Number(ttl.value),u=Number(uses.value);if(!Number.isInteger(t)||t<1||!Number.isInteger(u)||u<1){note('Lease TTL and max uses must be whole numbers of at least 1.');return;}body.lease={scopes:ids,ttl_s:t,max_uses:u};}
   const gen=generation;busy=true;submit.disabled=true;note((existing?'Saving ':'Creating ')+n+'…');
   try{
    const bot=await api(existing?existing.bot_id+'/update':'create',body);
    if(gen!==generation)return;
    if(!bot||!HEX.test(String(bot.bot_id)))throw new Error('the service returned no bot id');
    if(existing&&bot.bot_id!==existing.bot_id)throw new Error('the service answered for a different bot');
    bots=[...bots.filter(b=>b.bot_id!==bot.bot_id),bot];
    publishSatellites();
    note((existing?'Updated ':'Created ')+str(bot.name,80)+': status '+(STATUSES.includes(bot.status)?bot.status:'not reported')+(bot.status==='paused'?' (resume it from its card when ready)':'')+'.');
    debug(existing?'update':'create',{outcome:'returned',status:bot.status});
    if(window.EchoPrimeAutoagents&&typeof window.EchoPrimeAutoagents.satellites==='function')window.EchoPrimeAutoagents.satellites({source:'bots',action:existing?'updated':'created',botId:bot.bot_id,status:bot.status});// the orb listens for echo-orb-satellites
    select(bot.bot_id);
   }catch(error){if(gen!==generation)return;note((existing?'Bot not updated: ':'Bot not created: ')+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.');debug(existing?'update':'create',{outcome:'failed'});}
   finally{if(gen===generation){busy=false;submit.disabled=false;renderList();}}
  },'new-chat bots-submit');
  wrap.append(field('Name',name),field('Agent',agent),field('Mode',mode),scheduleRow,calendarFields);
  if(!calendarReady)wrap.append(el('p','Calendar scheduling is not reported by the connected service.','bots-meta'));
  wrap.append(field('Instruction',instruction),field('Plugins',plugins),field('Daily cost cap (USD, at most '+MAX_CAP+')',cap),field('Lease scopes',scopes),leaseRow,submit);
  if(existing)wrap.append(button('Cancel edit',()=>select(existing.bot_id)));
  return wrap;
 }
 function roleLabel(message,bot){return message.role==='user'?'You':message.role==='bot'?(bot?str(bot.name,80):'Bot'):message.role==='system'?'System':str(message.role,20)||'Message';}
 function runLink(runId){
  const b=button('run '+shortId(runId),async()=>{
   const view=window.EchoPrimeAgents;
   try{if(view&&typeof view.openRun==='function'){await view.openRun(runId);return;}if(view&&typeof view.open==='function'&&typeof view.watch==='function'){await view.open();view.watch(runId);return;}note('Run '+runId+'. Open it in the Agents view once that view is installed.');}catch(error){note('Run view unavailable: '+(error instanceof Error?error.message:'request failed')+'.');}
  },'quiet-button bots-run');
  attr(b,{'data-run-id':runId,title:'Run '+runId});return b;
 }
 function messageNode(message,bot){
  const art=el('article',undefined,'bots-msg bots-msg-'+(['user','bot','system'].includes(message.role)?message.role:'other'));
  art.append(el('strong',roleLabel(message,bot)),el('p',str(message.text,MAX_TEXT)));
  const meta=el('small',when(message.created_at),'bots-meta');
  if(typeof message.run_id==='string'&&HEX.test(message.run_id))meta.append(el('span',' · '),runLink(message.run_id));
  art.append(meta);return art;
 }
 function chatPane(){
  const bot=bots.find(b=>b.bot_id===selected);
  const wrap=el('section',undefined,'bots-chat');
  if(!bot){wrap.append(el('p','Select a bot to chat with it.','bots-meta'));return wrap;}
  const head=el('div',undefined,'bots-card-head');head.append(el('h3',str(bot.name,80)),el('span',str(bot.agent,80),'bots-meta'),badge(bot));
  wrap.append(head);
  if(bot.status==='paused')wrap.append(el('p','This bot is paused: your messages queue and it answers when you resume it from its card.','bots-meta'));
  const log=attr(el('div',undefined,'bots-transcript'),{role:'log','aria-live':'polite','aria-label':'Conversation with '+str(bot.name,80)});
  const status=attr(el('p',undefined,'bots-poll'),{role:'status'});
  const input=attr(el('textarea'),{rows:'2',maxlength:MAX_TEXT,placeholder:'Message '+str(bot.name,80)+'… (up to 12000 characters)'});
  if(chat&&chat.botId===bot.bot_id&&chat.input)input.value=chat.input.value;// a rebuild (status change) keeps the draft
  const send=button('Send',async()=>{
   if(!chat||chat.botId!==bot.bot_id||chat.sending)return;
   const text=input.value;
   if(!text.trim()){note('Type a message first.');return;}
   if(text.length>MAX_TEXT){note('Messages are limited to '+MAX_TEXT+' characters; the text stays in the box.');return;}
   const c=chat;c.sending=true;send.disabled=true;
   try{
    const reply=await api(bot.bot_id+'/message',{text});
    if(chat!==c)return;
    input.value='';note('Queued for '+str(bot.name,80)+' as run '+shortId(reply.runId)+(bot.status==='paused'?' (answers when resumed)':'')+'.');
    debug('message',{outcome:'accepted'});c.lastPoll=0;
   }catch(error){if(chat!==c)return;note('Message not sent: '+(error instanceof Error?error.message:'request failed')+'. The text stays in the box; no automatic retry was made.');debug('message',{outcome:'failed'});}
   finally{if(chat===c){c.sending=false;send.disabled=false;}}
  },'new-chat bots-submit');
  const composer=el('div',undefined,'bots-composer');composer.append(input,send);
  wrap.append(log,status,composer);
  if(chat&&chat.botId===bot.bot_id){chat.log=log;chat.status=status;chat.input=input;renderTranscript();}
  return wrap;
 }
 function renderTranscript(){
  if(!chat||!chat.log)return;
  const bot=bots.find(b=>b.bot_id===chat.botId);
  chat.log.replaceChildren(...(chat.messages.length?chat.messages.slice(-200).map(m=>messageNode(m,bot)):[el('p','No messages yet. Each reply arrives through the bot\u2019s own run.','bots-meta')]));
  chat.status.textContent=chat.note||('Polling every 3 s'+(doc.hidden?' · polling paused while this tab is hidden':'')+(chat.since?'':' · full transcript requested'));
 }
 function startChat(botId){
  stopChat();
  chat={botId,since:null,messages:[],controller:new AbortController(),lastPoll:0,inflight:false,failures:0,note:'',sending:false,log:null,status:null,input:null};
  ensureTimer();
 }
 function stopChat(){if(chat){chat.controller.abort();chat=null;}}
 async function pollChat(){
  const c=chat;if(!c)return;
  c.inflight=true;c.lastPoll=Date.now();
  try{
   const data=await api(c.botId+'/messages'+(c.since?'?since='+encodeURIComponent(c.since)+'&limit=200':'?limit=200'),undefined,c.controller.signal);
   if(chat!==c)return;
   c.failures=0;c.note='';
   const rows=Array.isArray(data.messages)?data.messages.filter(m=>m&&typeof m==='object'&&HEX.test(String(m.message_id))):[];
   const seen=new Set(c.messages.map(m=>m.message_id));
   for(const m of rows)if(!seen.has(m.message_id)){c.messages.push(m);seen.add(m.message_id);}
   if(c.messages.length>1000)c.messages=c.messages.slice(-1000);
   if(c.messages.length)c.since=c.messages[c.messages.length-1].message_id;
   renderTranscript();
  }catch(error){
   if(chat!==c||c.controller.signal.aborted)return;
   c.failures++;
   const message=error instanceof Error?error.message:'request failed';
   if(error&&error.status===404){c.note='The service no longer knows this bot ('+message+'). Polling stopped.';renderTranscript();stopChat();loadList();return;}
   if(c.failures>=MAX_FAILURES){c.note='Lost contact with the echoBots service after '+MAX_FAILURES+' failed reads: '+message+'. Polling stopped; select the bot again to retry.';renderTranscript();stopChat();return;}
   c.note='Transcript read failed ('+c.failures+'/'+MAX_FAILURES+'): '+message+'. Retrying.';renderTranscript();
  }finally{c.inflight=false;}
 }
 function groupPane(){
  const wrap=el('section',undefined,'bots-group');
  wrap.append(el('h3','Group chat'),el('p','Pick 2 to 6 bots and a prompt. Each bot answers through its own run with its own Lease; the group exchanges messages only, never state.','bots-meta'));
  if(!group||group.done){
   const name=attr(el('input'),{maxlength:MAX_NAME,placeholder:'Group name',autocomplete:'off'});
   const picks=el('div',undefined,'bots-picks');const boxes=[];
   for(const bot of bots.slice(0,50)){const box=attr(el('input'),{type:'checkbox'});box.value=bot.bot_id;boxes.push(box);const l=el('label',undefined,'bots-pick');l.append(box,el('span',str(bot.name,80)+' · '+(STATUSES.includes(bot.status)?bot.status:'status not reported')));picks.append(l);}
   if(!bots.length)picks.append(el('p','Create at least two bots first.','bots-meta'));
   const prompt=attr(el('textarea'),{rows:'3',maxlength:MAX_TEXT,placeholder:'Prompt for the group (up to 12000 characters)'});
   const start=button('Start group chat',async()=>{
    if(busy)return;
    const chosen=boxes.filter(b=>b.checked).map(b=>b.value);
    if(chosen.length<GROUP_MIN||chosen.length>GROUP_MAX){note('Pick between '+GROUP_MIN+' and '+GROUP_MAX+' bots ('+chosen.length+' selected).');return;}
    const n=name.value.trim();if(!n||n.length>MAX_NAME){note('Give the group a name of 1 to '+MAX_NAME+' characters.');return;}
    if(!prompt.value.trim()){note('Write a prompt for the group.');return;}
    const gen=generation;busy=true;start.disabled=true;note('Starting the group…');
    try{
     const accepted=await api('groups/create',{name:n,bots:chosen,prompt:prompt.value});
     if(gen!==generation)return;
     if(!accepted||!HEX.test(String(accepted.groupId)))throw new Error('the service returned no group id');
     stopGroup();
     group={groupId:accepted.groupId,name:n,bots:chosen,runIds:list(accepted.runIds),data:null,controller:new AbortController(),lastPoll:0,inflight:false,failures:0,note:'',done:false,stopped:false,view:null};
     publishSatellites();
     note('Group '+n+' accepted as '+shortId(accepted.groupId)+' with '+list(accepted.runIds).length+' runs.');debug('group',{outcome:'accepted',bots:chosen.length});
     ensureTimer();renderPane();
    }catch(error){if(gen!==generation)return;note('Group not started: '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.');debug('group',{outcome:'failed'});}
    finally{if(gen===generation){busy=false;start.disabled=false;}}
   },'new-chat bots-submit');
   wrap.append(field('Name',name),picks,field('Prompt',prompt),start);
   if(group&&group.done)wrap.append(el('hr'));
  }
  if(group){const view=el('div',undefined,'bots-group-view');group.view=view;wrap.append(view);renderGroup();}
  return wrap;
 }
 function groupRunning(data){
  if(!data)return true;
  if(data.status==='queued'||data.status==='running')return true;
  if(typeof data.status==='string')return false;
  return typeof data.summary!=='string';
 }
 function renderGroup(){
  const g=group;if(!g||!g.view)return;
  const data=g.data,running=groupRunning(data),names=new Map(bots.map(b=>[b.bot_id,str(b.name,80)]));
  const label=g.stopped?'no longer watched (it may still be running)':running?'still running':'finished';
  const nodes=[el('h3',str(g.name,80)+' · '+label+(data&&typeof data.status==='string'?' ('+str(data.status,20)+')':''))];
  nodes.push(el('p','Group '+g.groupId+' · '+g.bots.map(id=>names.get(id)||shortId(id)).join(', ')+' · '+g.runIds.length+' run'+(g.runIds.length===1?'':'s')+(running&&!g.stopped?' · the group is still running; replies appear as each bot\u2019s run finishes':''),'bots-meta'));
  const log=attr(el('div',undefined,'bots-transcript'),{role:'log','aria-live':'polite','aria-label':'Group transcript'});
  const rows=data&&Array.isArray(data.messages)?data.messages.filter(m=>m&&typeof m==='object'):[];
  if(!rows.length)log.append(el('p',running?'No replies yet.':'The group finished without messages.','bots-meta'));
  for(const m of rows.slice(-200)){const art=el('article',undefined,'bots-msg bots-msg-bot');art.append(el('strong',names.get(m.bot_id)||shortId(String(m.bot_id))||'Bot'),el('p',str(m.text,MAX_TEXT)),el('small',when(m.created_at),'bots-meta'));log.append(art);}
  nodes.push(log);
  if(data&&typeof data.summary==='string'&&data.summary){const s=el('div',undefined,'bots-summary');s.append(el('strong','Summary'),el('p',str(data.summary,MAX_TEXT)));nodes.push(s);}
  nodes.push(attr(el('p',g.note||(g.stopped?'Polling stopped by you; the runs may continue up to their caps.':g.done?'Polling stopped: the group is finished.':'Polling every 3 s'+(doc.hidden?' · polling paused while this tab is hidden':'')),'bots-poll'),{role:'status'}));
  if(!g.done)nodes.push(button('Stop watching',()=>{stopGroup(true);renderPane();}));
  g.view.replaceChildren(...nodes);
 }
 function stopGroup(keep){if(group){group.controller.abort();group.done=true;if(keep)group.stopped=true;else group=null;publishSatellites();}}
 async function pollGroup(){
  const g=group;if(!g||g.done)return;
  g.inflight=true;g.lastPoll=Date.now();
  try{
   const data=await api('groups/'+g.groupId,undefined,g.controller.signal);
   if(group!==g)return;
   g.failures=0;g.note='';g.data=data;
   if(!groupRunning(data)){g.done=true;publishSatellites();debug('group',{outcome:'finished'});}
   renderGroup();
  }catch(error){
   if(group!==g||g.controller.signal.aborted)return;
   g.failures++;
   const message=error instanceof Error?error.message:'request failed';
   if(error&&error.status===404){g.note='The service does not know group '+g.groupId+' ('+message+'). Polling stopped.';g.done=true;}
   else if(g.failures>=MAX_FAILURES){g.note='Lost contact with the echoBots service after '+MAX_FAILURES+' failed reads: '+message+'. Polling stopped; the runs may still be spending their caps.';g.done=true;}
   else g.note='Group read failed ('+g.failures+'/'+MAX_FAILURES+'): '+message+'. Retrying.';
   if(g.done)publishSatellites();
   renderGroup();
  }finally{g.inflight=false;}
 }
 // ---- polling loop ------------------------------------------------------------
 /** Starts the loop, or brings the next tick forward to now (a new chat, a new group, the tab becoming visible). */
 function ensureTimer(){if(timer)clearTimeout(timer);timer=setTimeout(tick,0);}
 function tick(){
  timer=null;
  const open=!!(dialog&&dialog.open);
  if(!open||!allowed()){return;}
  if(doc.hidden){if(chat)renderTranscript();if(group&&!group.done)renderGroup();}
  else{
   const now=Date.now();
   if(chat&&!chat.inflight&&now-chat.lastPoll>=POLL_MS)void pollChat();
   if(group&&!group.done&&!group.inflight&&now-group.lastPoll>=POLL_MS)void pollGroup();
   if(verdict.available&&now-lastList>=LIST_MS){lastList=now;void loadList();}
  }
  if(chat||(group&&!group.done)||open)timer=setTimeout(tick,TICK_MS);
 }
 // ---- view ----------------------------------------------------------------------
 function select(botId){
  if(!HEX.test(String(botId))||!bots.some(b=>b.bot_id===botId))return;
  selected=botId;editing=null;pane='chat';try{localStorage.setItem(STORAGE,botId);}catch{}
  if(!chat||chat.botId!==botId)startChat(botId);
  renderList();renderPane();
 }
 /** The pane is rebuilt only when what it shows changes (bot, status, agents list, group); a list refresh alone keeps drafts in place. */
 function paneKey(){
  if(pane==='workspace')return 'workspace:'+selected;
  if(pane==='chat'){const b=bots.find(x=>x.bot_id===selected);return 'chat:'+selected+':'+(b?b.status:'');}
  if(pane==='create')return 'create:'+(agents&&agents.length?'select':'text');
  if(pane==='edit')return 'edit:'+(editing?editing.bot_id:'none');
  if(pane==='group')return 'group:'+(group?group.groupId+':'+(group.done?'done':'live'):'none')+':'+bots.length;
  return pane;
 }
 function renderPane(force){
  if(!ui)return;
  if(!verdict.available||!allowed()){ui.pane.replaceChildren();ui.tools.hidden=true;ui.paneKey='';return;}
  ui.tools.hidden=false;
  const key=paneKey();
  if(!force&&key===ui.paneKey){if(pane==='chat')renderTranscript();else if(pane==='group')renderGroup();return;}
  ui.paneKey=key;
  if(workspaceView){workspaceView.destroy();workspaceView=null;}
  if((pane==='workspace'||pane==='teams')&&window.EchoPrimeBotWorkspace){
   workspaceView=window.EchoPrimeBotWorkspace.mount(ui.pane,{bot:pane==='workspace'?bots.find(b=>b.bot_id===selected):null,bots,getBots:()=>bots,mode:pane,api,refresh:loadList});return;
  }
  ui.pane.replaceChildren(pane==='create'?createPane():pane==='edit'&&editing?createPane(editing):pane==='chat'?chatPane():pane==='group'?groupPane():el('p','Open a bot\u2019s chat, create a new bot or start a group chat.','bots-meta'));
 }
 function ensureDialog(){
  if(dialog)return;
  dialog=attr(el('dialog',undefined,'panel-dialog workspace-dialog bots-dialog'),{id:'bots-dialog','aria-labelledby':'bots-title'});
  const title=el('div',undefined,'dialog-title'),heading=el('div');heading.append(el('span','ALWAYS-ON TEAMMATES','eyebrow'),attr(el('h2','echoBots'),{id:'bots-title'}));
  const close=attr(el('button','×','icon-button close-dialog'),{type:'button','aria-label':'Close echoBots'});close.addEventListener('click',()=>dialog.close());
  title.append(heading,close);
  const status=attr(el('p',undefined,'dialog-description'),{id:'bots-status',role:'status','aria-live':'polite'});
  const readinessNode=attr(el('section',undefined,'bots-readiness'),{'aria-label':'Service readiness'});
  const noteLine=attr(el('p',undefined,'bots-notice'),{id:'bots-note',role:'status'});
  const tools=el('div',undefined,'bots-toolbar');
  tools.append(button('Refresh',async()=>{lastList=0;await refreshHealth();await loadList();}),button('New bot',()=>{pane='create';renderPane();}),button('Group chat',()=>{pane='group';renderPane();}));
  tools.append(button('Teams & templates',()=>{stopChat();pane='teams';renderPane();}));
  const body=el('div',undefined,'bots-body'),listNode=attr(el('section',undefined,'bots-list'),{id:'bots-list','aria-label':'Your bots'}),paneNode=attr(el('section',undefined,'bots-pane'),{id:'bots-pane'});
  body.append(listNode,paneNode);
  dialog.append(title,status,readinessNode,comparison(),tools,noteLine,body);
  dialog.addEventListener('close',()=>{stopChat();stopGroup();if(workspaceView){workspaceView.destroy();workspaceView=null;}pane='none';debug('view',{outcome:'closed'});});
  doc.body.append(dialog);
  ui={status,readiness:readinessNode,note:noteLine,tools,list:listNode,pane:paneNode,paneKey:''};
 }
 async function open(){
  ensureDialog();
  if(!dialog.open)dialog.showModal();
  renderStatus();note('');renderList();renderPane(true);
  await refreshHealth();
  if(!dialog.open)return;
  renderList();renderPane();
  if(!allowed()||!verdict.available)return;
  void loadAgents();
  await loadList();
  if(!dialog.open)return;
  let remembered=null;try{remembered=localStorage.getItem(STORAGE);}catch{}
  if(!selected&&typeof remembered==='string'&&HEX.test(remembered)&&bots.some(b=>b.bot_id===remembered))select(remembered);
  else if(selected&&bots.some(b=>b.bot_id===selected)){if(!chat)startChat(selected);pane='chat';renderList();renderPane();}
  ensureTimer();
 }
 function reset(){
  generation++;stopChat();stopGroup();bots=[];selected=null;pendingDelete=null;editing=null;pane='none';busy=false;agents=null;agentsLoaded=false;health=null;healthCheckedAt=null;lastList=0;
  publishSatellites();
  if(dialog&&dialog.open)dialog.close();
  note('');
 }
 function mount(){
  navButton=attr(el('button','echoBots','nav-item'),{type:'button',id:'bots-open'});
  navButton.hidden=!allowed();
  navButton.addEventListener('click',()=>void open());
  const nav=doc.querySelector('nav[aria-label="Workspace"]')||doc.querySelector('#sidebar');
  if(nav)nav.append(navButton);
 }
 mount();
 doc.addEventListener('visibilitychange',()=>{
  if(chat)chat.lastPoll=0;if(group)group.lastPoll=0;
  if(!doc.hidden&&dialog&&dialog.open)ensureTimer();
  else{if(chat)renderTranscript();if(group&&!group.done)renderGroup();}
 });
 if(typeof doc.addEventListener==='function')doc.addEventListener('echo-orb-open',async event=>{try{const d=event&&event.detail;if(!d||d.kind!=='bot'||typeof d.id!=='string'||!/^bot:[0-9a-f]{32}$/.test(d.id))return;const botId=d.id.slice(4);await open();select(botId);}catch{}});
 window.addEventListener('echo-account-changed',()=>{reset();void refreshHealth();});
 window.addEventListener('pagehide',()=>{stopChat();stopGroup();if(workspaceView){workspaceView.destroy();workspaceView=null;}});
 window.EchoPrimeBots={ready:refreshHealth(),refresh:refreshHealth,open,async openBot(botId){if(!HEX.test(String(botId)))return;await open();select(botId);},close(){if(dialog&&dialog.open)dialog.close();},admission,
  state(){return {verdict,selected,pane,pendingDelete,polling:!!chat,group:group?{groupId:group.groupId,done:group.done}:null,bots:bots.length};}};
})();
