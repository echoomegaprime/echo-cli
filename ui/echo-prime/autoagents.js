(() => {
 'use strict';
 // Autonomous agents: the chat card "Echo built an agent and a bot for this". When a chat turn result carries `autoagents`
 // (the make_agent / make_bot tool results), chat.js hands it to render() and one card per result is appended to the chat log:
 // agent name, role, purpose, capabilities with their tiers, schedule, budget, the bot's status (paused / running) and, when the
 // gate kept the bot paused, the reasons plus an "Approve and resume" button. Buttons: Resume / Pause / Open in echoBots /
 // Open agent / Delete (two-step, no confirm()). Every request goes through the owner-only Prime routes (/api/prime/bots/*,
 // /api/prime/adk/*); members and visitors see an explanation instead of a card and nothing is fetched for them. Creating or
 // resuming a bot dispatches `echo-orb-satellites` so the orb can show the new satellite. Nothing here retries or falls back.
 const doc=document;
 const HEX=/^[0-9a-f]{32}$/,NAME=/^[a-z0-9][a-z0-9-]{1,62}$/,STATUSES=['paused','idle','running','error'],ORB_EVENT='echo-orb-satellites',BOT_STORAGE='echo-prime-bot-v1';
 const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const str=(v,n)=>typeof v==='string'?(v.length>n?v.slice(0,n)+'…':v):'';
 function el(tag,text,cls){const e=doc.createElement(tag);if(text!==undefined&&text!==null)e.textContent=String(text);if(cls)e.className=cls;return e;}
 function attr(node,attributes){for(const [k,v] of Object.entries(attributes))if(v!==undefined&&v!==false)node.setAttribute(k,String(v));return node;}
 function button(label,onClick,cls){const b=attr(el('button',label,cls||'quiet-button'),{type:'button'});b.addEventListener('click',onClick);return b;}
 function money(v){return '$'+(Math.round((num(v)||0)*100)/100).toFixed(2);}
 function debug(event,detail){console.debug('[echo.autoagents]',{event,...(detail||{})});}
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 async function headers(){try{const ws=workspace();return ws&&ws.ownerHeaders?await ws.ownerHeaders():{};}catch{return {};}}
 /** 'open' (no authenticated Workspace: the Prime cookie decides), 'signin', 'member' or 'owner'; read from the cached session, never a request. */
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 async function request(url,body){
  const owner=admission()==='owner';
  const response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'x-prime-request':'1',...await headers(),'content-type':'application/json'},body:JSON.stringify(body||{})});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
   const ws=workspace();
   if((response.status===401||response.status===403)&&owner&&ws&&typeof ws.invalidate==='function'){ws.invalidate();debug('invalidated',{status:response.status,url});}
   const error=new Error(data&&typeof data.error==='string'?data.error:'Request failed (HTTP '+response.status+')');error.status=response.status;throw error;
  }
  if(!data||typeof data!=='object')throw new Error('Prime returned an unrecognized response');
  return data;
 }
 /** Tells the orb a satellite changed (a bot was created, resumed, paused or deleted). Never throws. */
 function satellites(detail){
  try{const event=typeof CustomEvent==='function'?new CustomEvent(ORB_EVENT,{detail}):Object.assign(new Event(ORB_EVENT),{detail});window.dispatchEvent(event);debug('satellites',detail);}catch{}
 }
 /** The "Echo-made from your prompt" badge for an agent or bot record carrying origin.by === 'echo'; null otherwise. */
 function badge(record){
  const origin=record&&typeof record==='object'&&record.origin&&typeof record.origin==='object'?record.origin:null;
  return origin&&origin.by==='echo'?attr(el('span','Echo-made from your prompt','autoagent-badge'),{title:'Echo created this definition from a chat prompt'+(typeof origin.prompt_sha256==='string'?' (prompt '+origin.prompt_sha256.slice(0,12)+'…)':'')}):null;
 }
 function tierText(c){const t=num(c&&c.tier);return t===null?'tier unknown':'tier '+t;}
 function cadence(s){const e=s&&typeof s==='object'?num(s.every_s):null;return e===null?'on message only':e%60===0?'every '+(e/60)+' min':'every '+e+' s';}
 function row(label,value){const p=el('p',undefined,'autoagent-row');p.append(el('span',label,'autoagent-label'),typeof value==='string'?el('span',value):value);return p;}
 function statusBadge(status){const s=STATUSES.includes(status)?status:'unknown';return el('span',s==='unknown'?'status not reported':s,'autoagent-status autoagent-status-'+s);}
 function explain(){
  const art=el('article',undefined,'chat-message assistant autoagent-card autoagent-explain');
  art.append(el('strong','Agents and bots are owner-only'),el('p','Echo builds agents and bots only for the primary owner. Nothing was created for your account; ask the owner to create this agent and bot, or to share the result with you.'));
  return art;
 }
 function valid(built){
  if(!built||typeof built!=='object'||built.kind!=='autoagent')return false;
  const a=built.agent;if(!a||typeof a!=='object'||!NAME.test(String(a.name)))return false;
  if(built.bot!==undefined&&(!built.bot||typeof built.bot!=='object'||!HEX.test(String(built.bot.bot_id||built.bot.botId))))return false;
  return true;
 }
 function card(built){
  const state={agent:{...built.agent},bot:built.bot?{...built.bot,botId:String(built.bot.botId||built.bot.bot_id)}:null,hadBot:!!built.bot,pendingDelete:false,busy:false,note:'',deleted:false};
  const art=attr(el('article',undefined,'chat-message assistant autoagent-card'),{'data-autoagent':typeof built.promptSha256==='string'?built.promptSha256.slice(0,64):''});
  if(state.bot)attr(art,{'data-bot-id':state.bot.botId});
  function note(text){state.note=text||'';render();}
  async function act(action){
   if(state.busy||!state.bot||!HEX.test(state.bot.botId))return;
   state.busy=true;render();
   try{
    const bot=await request('/api/prime/bots/'+state.bot.botId+'/'+action,{});
    state.bot={...state.bot,status:STATUSES.includes(bot.status)?bot.status:'unknown',approval:{required:false,reasons:[]},autoResumed:action==='resume'};
    state.note=(action==='resume'?'Resumed ':'Paused ')+state.bot.name+': status '+state.bot.status+'.';
    satellites({source:'autoagents',action,botId:state.bot.botId,status:state.bot.status});debug(action,{outcome:'returned'});
   }catch(error){state.note=(action==='resume'?'Resume':'Pause')+' failed: '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.';debug(action,{outcome:'failed'});}
   finally{state.busy=false;render();}
  }
  async function remove(){
   if(state.busy)return;
   state.busy=true;state.pendingDelete=false;render();
   const steps=[];
   try{
    if(state.bot&&HEX.test(state.bot.botId)){await request('/api/prime/bots/'+state.bot.botId+'/delete',{});steps.push('bot '+state.bot.name);satellites({source:'autoagents',action:'delete',botId:state.bot.botId});state.bot=null;}
    await request('/api/prime/adk/agents/'+encodeURIComponent(state.agent.name)+'/delete',{});steps.push('agent '+state.agent.name);
    state.deleted=true;state.note='Deleted '+steps.join(' and ')+' (confirmed by the service).';debug('delete',{outcome:'returned'});
   }catch(error){state.note='Delete stopped after '+(steps.length?steps.join(', '):'nothing')+': '+(error instanceof Error?error.message:'request failed')+'. No automatic retry was made.';debug('delete',{outcome:'failed'});}
   finally{state.busy=false;render();}
  }
  function openBots(){
   if(!state.bot)return;
   try{localStorage.setItem(BOT_STORAGE,state.bot.botId);}catch{}
   const view=window.EchoPrimeBots;
   if(view&&typeof view.open==='function'){void view.open();return;}
   note('Bot '+state.bot.botId+'. Open it in the echoBots view once that view is installed.');
  }
  function openAgent(){
   const view=window.EchoPrimeAgents;
   if(view&&typeof view.open==='function'){void view.open();return;}
   note('Agent '+state.agent.name+'. Open it in the Agents view once that view is installed.');
  }
  function render(){
   const a=state.agent,b=state.bot,nodes=[];
   const title=state.deleted?'Echo removed this agent'+(state.hadBot?' and its bot':''):b?(a.existing&&b.existing?'Echo already had an agent and a bot for this':'Echo built an agent and a bot for this'):a.existing?'Echo already had an agent for this':'Echo built an agent for this';
   const head=el('div',undefined,'autoagent-head');head.append(el('strong',title));
   const originBadge=badge(a);if(originBadge)head.append(originBadge);
   nodes.push(head);
   const agentBox=el('section',undefined,'autoagent-section');
   const agentHead=el('div',undefined,'autoagent-section-head');agentHead.append(el('h3','Agent '+str(a.name,63)),el('span',str(a.role,40)||'role not stated','autoagent-role'));
   if(a.existing)agentHead.append(el('span','already existed','autoagent-existing'));
   agentBox.append(agentHead);
   if(typeof a.purpose==='string'&&a.purpose.trim())agentBox.append(row('Purpose',str(a.purpose,400)));
   const caps=Array.isArray(a.capabilities)?a.capabilities.filter(c=>c&&typeof c==='object'&&typeof c.id==='string'):[];
   const capList=el('ul',undefined,'autoagent-caps');
   for(const c of caps.slice(0,64)){const li=el('li');li.append(el('code',str(c.id,120)),el('span',tierText(c),'autoagent-tier autoagent-tier-'+(num(c.tier)===null?'unknown':Math.min(3,Math.max(0,Math.floor(c.tier))))));capList.append(li);}
   if(!caps.length)capList.append(el('li','no capabilities listed'));
   agentBox.append(row('Capabilities',capList));
   const lane=a.lane&&typeof a.lane==='object'?a.lane:{},budget=lane.budget&&typeof lane.budget==='object'?lane.budget:{};
   agentBox.append(row('Lane',(str(lane.node,40)||'node not stated')+' · '+(str(lane.model,40)||'model not stated')));
   agentBox.append(row('Budget',num(budget.max_calls)!==null?'up to '+budget.max_calls+' calls, '+money(budget.max_cost_usd)+', '+Math.round((num(budget.max_wall_s)||0)/60)+' min':'not reported'));
   agentBox.append(row('Max steps',num(a.maxSteps)!==null?String(a.maxSteps):'not reported'));
   agentBox.append(row('Schedule',cadence(b?b.schedule:a.schedule)));
   nodes.push(agentBox);
   if(b){
    const botBox=el('section',undefined,'autoagent-section');
    const botHead=el('div',undefined,'autoagent-section-head');botHead.append(el('h3','Bot '+str(b.name,64)),el('span',str(b.mode,20)||'personal','autoagent-mode'),statusBadge(b.status));
    if(b.existing)botHead.append(el('span','already existed','autoagent-existing'));
    botBox.append(botHead,row('Daily cost cap',money(b.dailyCostCapUsd)+' per day'));
    const approval=b.approval&&typeof b.approval==='object'?b.approval:{required:false,reasons:[]};
    if(approval.required&&b.status==='paused'){
     const box=el('div',undefined,'autoagent-approval');
     box.append(el('strong','Approval needed: the bot stays paused until you resume it.'));
     const reasons=Array.isArray(approval.reasons)?approval.reasons.filter(r=>typeof r==='string'):[];
     const ul=el('ul');for(const r of reasons.slice(0,20))ul.append(el('li',str(r,300)));if(!reasons.length)ul.append(el('li','the gate gave no reason'));
     box.append(ul);botBox.append(box);
    }else if(b.autoResumed)botBox.append(el('p','Every capability is tier 0 or 1 and the daily cap is within the default, so Echo resumed it.','autoagent-meta'));
    else if(b.status==='paused')botBox.append(el('p','Paused: resume it when you are ready; a paused bot still queues messages.','autoagent-meta'));
    nodes.push(botBox);
   }
   if(!state.deleted){
    const actions=el('div',undefined,'autoagent-actions'),controls=[];
    if(b&&b.status==='paused')controls.push(button(b.approval&&b.approval.required?'Approve and resume':'Resume',()=>act('resume'),'quiet-button autoagent-primary'));
    else if(b)controls.push(button('Pause',()=>act('pause')));
    if(b)controls.push(button('Open in echoBots',openBots));
    controls.push(button('Open agent',openAgent));
    if(state.pendingDelete)controls.push(button('Confirm delete',remove,'quiet-button autoagent-danger'),button('Cancel',()=>{state.pendingDelete=false;note('');}));
    else controls.push(button('Delete',()=>{state.pendingDelete=true;note('Select Confirm delete to remove '+(b?'the bot and ':'')+'agent '+a.name+', or Cancel.');}));
    for(const c of controls)c.disabled=state.busy;
    actions.append(...controls);
    if(state.pendingDelete)actions.append(el('small',(b?'The bot is deleted first (its lease and memory scope go with it), then the agent definition. ':'The agent definition is deleted. ')+'The service confirms each step; nothing else is touched.','autoagent-meta'));
    nodes.push(actions);
   }
   nodes.push(attr(el('p',state.note,'autoagent-note'),{role:'status'}));
   nodes.push(el('small','Built from your prompt by Echo; verify the capabilities and schedule before relying on it.','autoagent-meta'));
   art.replaceChildren(...nodes);
  }
  render();
  return art;
 }
 /** Called by chat.js with the turn result. Appends one card per valid `autoagents` entry (or one explanation for a non-owner) to the chat log. */
 function render(result){
  const log=doc.querySelector('#chat-log');
  const items=result&&typeof result==='object'&&Array.isArray(result.autoagents)?result.autoagents.filter(valid):[];
  if(!log||!items.length)return [];
  const access=admission();
  if(access==='member'||access==='signin'){const n=explain();log.append(n);log.hidden=false;debug('render',{outcome:'owner_only'});return [n];}
  const nodes=[];
  for(const built of items){
   const n=card(built);log.append(n);nodes.push(n);
   if(built.bot&&built.bot.existing!==true)satellites({source:'autoagents',action:'created',botId:String(built.bot.botId||built.bot.bot_id),status:str(built.bot.status,20)});
  }
  log.hidden=false;debug('render',{outcome:'returned',cards:nodes.length});
  return nodes;
 }
 window.EchoPrimeAutoagents={render,card,badge,explain,admission,satellites,ORB_EVENT};
})();
