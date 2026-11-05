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
 let verdict={configured:false,available:false,reason:'echoBots status not loaded'},health=null,bots=[],agents=null,agentsLoaded=false;
 let selected=null,pendingDelete=null,pane='none',noteText='',busy=false,generation=0,healthGeneration=0,failedAt=-Infinity,lastList=0;
 let dialog=null,ui=null,navButton=null,chat=null,group=null,timer=null;
 const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const str=(v,n)=>typeof v==='string'?(v.length>n?v.slice(0,n)+'…':v):'';
 const list=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x):[];
 function el(tag,text,cls){const e=doc.createElement(tag);if(text!==undefined&&text!==null)e.textContent=String(text);if(cls)e.className=cls;return e;}
 function attr(node,attributes){for(const [k,v] of Object.entries(attributes))if(v!==undefined&&v!==false)node.setAttribute(k,String(v));return node;}
 function button(label,onClick,cls){const b=attr(el('button',label,cls||'quiet-button'),{type:'button'});b.addEventListener('click',onClick);return b;}
 function money(v){return '$'+(Math.round((num(v)||0)*100)/100).toFixed(2);}
 function when(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(v)?v.slice(0,10)+' '+v.slice(11,19)+' UTC':'';}
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
 async function request(url,body,signal){
  const sent={'x-prime-request':'1',...await headers(),...(body?{'content-type':'application/json'}:{})},owner=admission()==='owner';
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',headers:sent,...(body?{body:JSON.stringify(body)}:{}),signal});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
   // Only a session that claimed owner admission has anything to invalidate (a real expiry or demotion); a visitor or member
   // is refused by design and a 405 from a route this host does not serve is not an identity event.
   const ws=workspace();
   if((response.status===401||response.status===403)&&owner&&ws&&typeof ws.invalidate==='function'){ws.invalidate();debug('invalidated',{status:response.status,url});}
   const error=new Error(data&&typeof data.error==='string'?data.error:'echoBots request failed (HTTP '+response.status+')');error.status=response.status;throw error;
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
   health=data;debug('health',{configured:data.configured===true,available:data.available===true});
   return report({configured:data.configured===true,available:data.available===true,reason:data.available===true?'':typeof data.reason==='string'?data.reason:'unavailable'});
  }catch(error){
   if(mine!==healthGeneration)return verdict;
   failedAt=Date.now();health=null;
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
  else if(!verdict.available)text='echoBots service unavailable: '+(verdict.reason||'no reason given')+'. No bot runs until it answers; nothing else is used instead.';
  else{
   const s=health&&health.service&&typeof health.service==='object'?health.service:{};
   text='echo-adk-api'+(typeof s.version==='string'?' '+str(s.version,20):'')+' · '+(num(s.bots)===null?'bots not counted':s.bots+' bot'+(s.bots===1?'':'s'))+' · '+(num(s.agents)===null?'agents not counted':s.agents+' agent'+(s.agents===1?'':'s'))+' · '+(num(s.runsActive)===null?'active runs not counted':s.runsActive+' active run'+(s.runsActive===1?'':'s'))+'. Default daily cap '+money(health.defaultBudget&&health.defaultBudget.max_cost_usd)+'.';
  }
  ui.status.textContent=text;
 }
 function comparison(){
  const d=el('details',undefined,'bots-note');d.append(el('summary','How echoBots differ from Grok Bots'));
  d.append(el('p','Grok Bots share one cloud computer per user: xAI\u2019s own docs say separate Bots are not a security boundary, and files, browser sessions and command-line credentials are shared across all of a user\u2019s Bots and can outlive a deleted Bot. Each echoBot instead runs on Echo\u2019s own nodes with its own Lease (exact capability ids, max_uses, ttl) and its own memory scope bot:<id>; it never holds a token and nothing is shared between bots, so deleting one leaves nothing behind. Every bot starts paused and has a per-bot daily cost cap (at most $5; the service refuses more with budget_exceeded) under a fleet-wide $200/day ceiling. Group chats of 2 to 6 bots exchange messages only, never state.'));
  return d;
 }
 // ---- bot cards -------------------------------------------------------------
 function badge(bot){
  const status=STATUSES.includes(bot.status)?bot.status:'unknown';
  return el('span',status==='unknown'?'status not reported':status,'bots-badge bots-status-'+status);
 }
 function meter(bot){
  const spent=num(bot.spent_today_usd),cap=num(bot.daily_cost_cap_usd);
  const wrap=el('div',undefined,'bots-meter-wrap');
  const bar=attr(el('div',undefined,'bots-meter'),{role:'meter','aria-label':'Spent today against the daily cost cap','aria-valuemin':'0','aria-valuemax':String(cap===null?0:cap),'aria-valuenow':String(spent===null?0:spent)});
  const pct=cap!==null&&cap>0?Math.min(100,Math.max(0,(spent||0)/cap*100)):(spent||0)>0?100:0;
  bar.append(attr(el('span',undefined,'bots-meter-fill'+(pct>=100?' bots-meter-full':'')),{style:'width:'+Math.round(pct)+'%'}));
  wrap.append(bar,el('small',(spent===null?'spend not reported':money(spent))+' of '+(cap===null?'cap not reported':money(cap))+' today','bots-meta'));
  return wrap;
 }
 function row(label,value){const p=el('p',undefined,'bots-row');p.append(el('span',label,'bots-label'),el('span',value));return p;}
 function schedule(bot){const s=bot.schedule&&typeof bot.schedule==='object'?num(bot.schedule.every_s):null;return s===null?'on message only':s%60===0?'every '+(s/60)+' min':'every '+s+' s';}
 function card(bot){
  const art=el('article',undefined,'bots-card'+(selected===bot.bot_id?' bots-card-selected':'')+(pendingDelete===bot.bot_id?' bots-card-confirm':''));
  attr(art,{'data-bot-id':bot.bot_id});
  const head=el('div',undefined,'bots-card-head');
  head.append(el('h3',str(bot.name,80)||'(unnamed bot)'),el('span',str(bot.mode,20)||'personal','bots-badge bots-mode'),badge(bot));
  if(bot.origin&&typeof bot.origin==='object'&&bot.origin.by==='echo')head.append(el('span','Echo-made from your prompt','bots-badge autoagent-badge'));// created by Echo from a chat prompt (autoagents.js)
  art.append(head,row('Agent',str(bot.agent,80)||'not reported'),row('Schedule',schedule(bot)),row('Plugins',list(bot.plugins).length?list(bot.plugins).slice(0,12).map(p=>str(p,40)).join(', '):'none'),meter(bot),
   row('Inbox',num(bot.inbox_depth)===null?'not reported':bot.inbox_depth+' waiting'),row('Last run',when(bot.last_run_at)||'never'));
  if(typeof bot.last_error==='string'&&bot.last_error)art.append(el('p','Last error: '+str(bot.last_error,300),'bots-error'));
  const actions=el('div',undefined,'bots-actions'),controls=[];
  controls.push(button(selected===bot.bot_id&&pane==='chat'?'Chat open':'Open chat',()=>select(bot.bot_id)));
  const paused=bot.status==='paused';
  controls.push(button(paused?'Resume':'Pause',()=>act(bot.bot_id,paused?'resume':'pause')));
  if(pendingDelete===bot.bot_id)controls.push(button('Confirm delete',()=>act(bot.bot_id,'delete'),'quiet-button bots-danger'),button('Cancel',()=>{pendingDelete=null;note('');renderList();}));
  else controls.push(button('Delete',()=>{pendingDelete=bot.bot_id;note('Select Confirm delete on '+(str(bot.name,80)||'this bot')+' to remove it, or Cancel.');renderList();}));
  for(const b of controls)b.disabled=busy;
  actions.append(...controls);
  if(pendingDelete===bot.bot_id)actions.append(el('small','Deleting removes the bot and its lease; the service confirms with deleted:true. Nothing is shared with other bots, so nothing of it remains.','bots-meta'));
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
   lastList=Date.now();
   if(pendingDelete&&!bots.some(b=>b.bot_id===pendingDelete))pendingDelete=null;
   if(selected&&!bots.some(b=>b.bot_id===selected)){stopChat();selected=null;if(pane==='chat')pane='none';}
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
   if(action==='delete'){
    bots=bots.filter(b=>b.bot_id!==botId);pendingDelete=null;
    if(selected===botId){stopChat();selected=null;if(pane==='chat')pane='none';try{localStorage.removeItem(STORAGE);}catch{}}
    note('Deleted '+name+' (confirmed by the service).');
   }else{
    bots=bots.map(b=>b.bot_id===botId?result:b);
    note((action==='pause'?'Paused ':'Resumed ')+name+': status '+(STATUSES.includes(result.status)?result.status:'not reported')+'.');
   }
   debug('action',{action,outcome:'returned'});
  }catch(error){if(gen!==generation)return;note((action==='delete'?'Delete':action==='pause'?'Pause':'Resume')+' failed for '+name+': '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.');debug('action',{action,outcome:'failed'});}
  finally{if(gen===generation){busy=false;renderList();renderPane();}}
 }
 // ---- panes: create, chat, group -------------------------------------------
 function field(label,node){const l=el('label',undefined,'workspace-field');l.append(el('span',label),node);return l;}
 function createPane(){
  const wrap=el('section',undefined,'bots-form');
  wrap.append(el('h3','New bot'),el('p','Bots start paused. Resume one from its card when you are ready; a paused bot still accepts messages and answers when resumed.','bots-meta'));
  const name=attr(el('input'),{maxlength:MAX_NAME,placeholder:'Bot name (up to 64 characters)',autocomplete:'off'});
  let agent;
  if(agents&&agents.length){
   agent=el('select');
   for(const a of agents){const o=el('option',a.name+(typeof a.role==='string'&&a.role?' · '+str(a.role,60):''));o.value=a.name;agent.append(o);}
   agent.value=agents[0].name;
  }else agent=attr(el('input'),{maxlength:120,placeholder:'Echo ADK agent name (the Agents view did not answer; type the exact name)',autocomplete:'off'});
  const mode=el('select');for(const m of ['personal','team']){const o=el('option',m);o.value=m;mode.append(o);}mode.value='personal';
  const scheduled=attr(el('input'),{type:'checkbox'});
  const minutes=attr(el('input'),{type:'number',min:'1',step:'1'});minutes.value='15';minutes.disabled=true;
  scheduled.addEventListener('change',()=>{minutes.disabled=!scheduled.checked;});
  const instruction=attr(el('textarea'),{rows:'3',maxlength:MAX_TEXT,placeholder:'Standing instruction (optional, up to 12000 characters)'});
  const plugins=attr(el('input'),{placeholder:'Skill names, comma-separated (optional)',autocomplete:'off'});
  const cap=attr(el('input'),{type:'number',min:'0',max:String(MAX_CAP),step:'0.01'});cap.value=String(num(health&&health.defaultBudget&&health.defaultBudget.max_cost_usd)||0);
  const scopes=attr(el('input'),{placeholder:'Exact capability ids, comma-separated (optional; the agent default lease applies when empty)',autocomplete:'off'});
  const ttl=attr(el('input'),{type:'number',min:'1',step:'1'});ttl.value='3600';
  const uses=attr(el('input'),{type:'number',min:'1',step:'1'});uses.value='100';
  const scheduleRow=el('div',undefined,'bots-inline');scheduleRow.append(field('Run on a schedule',scheduled),field('Every N minutes (at least 1)',minutes));
  const leaseRow=el('div',undefined,'bots-inline');leaseRow.append(field('Lease TTL (seconds)',ttl),field('Lease max uses',uses));
  const submit=button('Create bot (starts paused)',async()=>{
   if(busy)return;
   const n=name.value.trim(),a=String(agent.value||'').trim();
   if(!n||n.length>MAX_NAME){note('Give the bot a name of 1 to '+MAX_NAME+' characters.');return;}
   if(!a){note('Name the Echo ADK agent this bot runs.');return;}
   const body={name:n,agent:a,mode:mode.value};
   if(scheduled.checked){const m=Number(minutes.value);if(!Number.isInteger(m)||m<1){note('The schedule needs a whole number of minutes, at least 1.');return;}body.schedule={every_s:m*60};}
   if(instruction.value.trim())body.instruction=instruction.value;
   const skills=plugins.value.split(',').map(s=>s.trim()).filter(Boolean);if(skills.length)body.plugins=skills;
   const c=Number(cap.value);if(!Number.isFinite(c)||c<0||c>MAX_CAP){note('The daily cost cap must be between $0 and $'+MAX_CAP+'.');return;}body.daily_cost_cap_usd=Math.round(c*100)/100;
   const ids=scopes.value.split(',').map(s=>s.trim()).filter(Boolean);
   if(ids.length){const t=Number(ttl.value),u=Number(uses.value);if(!Number.isInteger(t)||t<1||!Number.isInteger(u)||u<1){note('Lease TTL and max uses must be whole numbers of at least 1.');return;}body.lease={scopes:ids,ttl_s:t,max_uses:u};}
   const gen=generation;busy=true;submit.disabled=true;note('Creating '+n+'…');
   try{
    const bot=await api('create',body);
    if(gen!==generation)return;
    if(!bot||!HEX.test(String(bot.bot_id)))throw new Error('the service returned no bot id');
    bots=[...bots.filter(b=>b.bot_id!==bot.bot_id),bot];
    note('Created '+str(bot.name,80)+': status '+(STATUSES.includes(bot.status)?bot.status:'not reported')+(bot.status==='paused'?' (resume it from its card when ready)':'')+'.');
    debug('create',{outcome:'returned',status:bot.status});
    if(window.EchoPrimeAutoagents&&typeof window.EchoPrimeAutoagents.satellites==='function')window.EchoPrimeAutoagents.satellites({source:'bots',action:'created',botId:bot.bot_id,status:bot.status});// the orb listens for echo-orb-satellites
    select(bot.bot_id);
   }catch(error){if(gen!==generation)return;note('Bot not created: '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.');debug('create',{outcome:'failed'});}
   finally{if(gen===generation){busy=false;submit.disabled=false;renderList();}}
  },'new-chat bots-submit');
  wrap.append(field('Name',name),field('Agent',agent),field('Mode',mode),scheduleRow,field('Instruction',instruction),field('Plugins',plugins),field('Daily cost cap (USD, at most '+MAX_CAP+')',cap),field('Lease scopes',scopes),leaseRow,submit);
  return wrap;
 }
 function roleLabel(message,bot){return message.role==='user'?'You':message.role==='bot'?(bot?str(bot.name,80):'Bot'):message.role==='system'?'System':str(message.role,20)||'Message';}
 function runLink(runId){
  const b=button('run '+shortId(runId),()=>{
   const view=window.EchoPrimeAgents;
   if(view&&typeof view.openRun==='function')view.openRun(runId);else note('Run '+runId+'. Open it in the Agents view once that view is installed.');
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
 function stopGroup(keep){if(group){group.controller.abort();group.done=true;if(keep)group.stopped=true;else group=null;}}
 async function pollGroup(){
  const g=group;if(!g||g.done)return;
  g.inflight=true;g.lastPoll=Date.now();
  try{
   const data=await api('groups/'+g.groupId,undefined,g.controller.signal);
   if(group!==g)return;
   g.failures=0;g.note='';g.data=data;
   if(!groupRunning(data)){g.done=true;debug('group',{outcome:'finished'});}
   renderGroup();
  }catch(error){
   if(group!==g||g.controller.signal.aborted)return;
   g.failures++;
   const message=error instanceof Error?error.message:'request failed';
   if(error&&error.status===404){g.note='The service does not know group '+g.groupId+' ('+message+'). Polling stopped.';g.done=true;}
   else if(g.failures>=MAX_FAILURES){g.note='Lost contact with the echoBots service after '+MAX_FAILURES+' failed reads: '+message+'. Polling stopped; the runs may still be spending their caps.';g.done=true;}
   else g.note='Group read failed ('+g.failures+'/'+MAX_FAILURES+'): '+message+'. Retrying.';
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
  selected=botId;pane='chat';try{localStorage.setItem(STORAGE,botId);}catch{}
  if(!chat||chat.botId!==botId)startChat(botId);
  renderList();renderPane();
 }
 /** The pane is rebuilt only when what it shows changes (bot, status, agents list, group); a list refresh alone keeps drafts in place. */
 function paneKey(){
  if(pane==='chat'){const b=bots.find(x=>x.bot_id===selected);return 'chat:'+selected+':'+(b?b.status:'');}
  if(pane==='create')return 'create:'+(agents&&agents.length?'select':'text');
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
  ui.pane.replaceChildren(pane==='create'?createPane():pane==='chat'?chatPane():pane==='group'?groupPane():el('p','Open a bot\u2019s chat, create a new bot or start a group chat.','bots-meta'));
 }
 function ensureDialog(){
  if(dialog)return;
  dialog=attr(el('dialog',undefined,'panel-dialog workspace-dialog bots-dialog'),{id:'bots-dialog','aria-labelledby':'bots-title'});
  const title=el('div',undefined,'dialog-title'),heading=el('div');heading.append(el('span','ALWAYS-ON TEAMMATES','eyebrow'),attr(el('h2','echoBots'),{id:'bots-title'}));
  const close=attr(el('button','×','icon-button close-dialog'),{type:'button','aria-label':'Close echoBots'});close.addEventListener('click',()=>dialog.close());
  title.append(heading,close);
  const status=attr(el('p',undefined,'dialog-description'),{id:'bots-status',role:'status','aria-live':'polite'});
  const noteLine=attr(el('p',undefined,'bots-notice'),{id:'bots-note',role:'status'});
  const tools=el('div',undefined,'bots-toolbar');
  tools.append(button('Refresh',()=>{lastList=0;void loadList();}),button('New bot',()=>{pane='create';renderPane();}),button('Group chat',()=>{pane='group';renderPane();}));
  const body=el('div',undefined,'bots-body'),listNode=attr(el('section',undefined,'bots-list'),{id:'bots-list','aria-label':'Your bots'}),paneNode=attr(el('section',undefined,'bots-pane'),{id:'bots-pane'});
  body.append(listNode,paneNode);
  dialog.append(title,status,comparison(),tools,noteLine,body);
  dialog.addEventListener('close',()=>{stopChat();stopGroup();pane='none';debug('view',{outcome:'closed'});});
  doc.body.append(dialog);
  ui={status,note:noteLine,tools,list:listNode,pane:paneNode,paneKey:''};
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
  generation++;stopChat();stopGroup();bots=[];selected=null;pendingDelete=null;pane='none';busy=false;agents=null;agentsLoaded=false;health=null;lastList=0;
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
 window.addEventListener('echo-account-changed',()=>{reset();void refreshHealth();});
 window.addEventListener('pagehide',()=>{stopChat();stopGroup();});
 window.EchoPrimeBots={ready:refreshHealth(),refresh:refreshHealth,open,close(){if(dialog&&dialog.open)dialog.close();},admission,
  state(){return {verdict,selected,pane,pendingDelete,polling:!!chat,group:group?{groupId:group.groupId,done:group.done}:null,bots:bots.length};}};
})();
