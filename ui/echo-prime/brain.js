(() => {
 'use strict';
 // Echo's brain surface (Commander directives 2026-11-04): the "as <Name>" personality tag with pin/off controls,
 // dotted markers on identifiers Echo could not verify, and the per-reply Verify action. Owner-only data comes from
 // /api/prime/personality; a member or a signed-out visitor never fetches it (the same admission rule as models.js).
 // chat.js hands each rendered reply to decorate(); workspace.js calls beforeWorkspaceTurn() before a Workspace turn.
 const SELECT_ID='personality-select',AUTO='auto',COOLDOWN_MS=5000;
 let settings=null,catalog=[],configured=false,gate='',failed=false,failedAt=-Infinity,generation=0;
 const applied=new Map(); // Workspace chat id -> profile Prime last selected there (re-sent only on change)
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 function admission(){const ws=workspace();if(!ws||ws.enabled!==true)return 'open';const s=ws.session;if(!s||s.authenticated!==true)return 'signin';return s.ownerAccess===true?'owner':'member';}
 async function headers(){try{const ws=workspace();return ws&&ws.ownerHeaders?await ws.ownerHeaders():{};}catch{return {};}}
 async function api(path,body){
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'x-prime-request':'1',...await headers(),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok)throw new Error(data&&typeof data.error==='string'?data.error:'Request failed');
  return data;
 }
 function debug(event,detail){console.debug('[echo.brain]',{event,...(detail||{})});}
 const text=(value,max)=>String(value==null?'':value).slice(0,max||200);
 // ---- controls beside the model picker --------------------------------------------------------------------------
 const wrap=document.createElement('div'),label=document.createElement('label'),select=document.createElement('select'),toggle=document.createElement('button'),note=document.createElement('small');
 wrap.className='personality-control';label.className='sr-only';label.textContent='Personality';
 select.id=SELECT_ID;select.setAttribute('aria-label','Personality: automatic, or pin one');
 toggle.type='button';toggle.id='personality-toggle';toggle.className='quiet-button';toggle.setAttribute('role','switch');
 note.className='connection-note';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
 label.append(select);wrap.append(label,toggle,note);
 const mount=document.querySelector('#rail-personality-slot')||document.querySelector('.composer-toolbar')||document.querySelector('#composer');
 if(mount)mount.append(wrap);
 function option(value,labelText){const o=document.createElement('option');o.value=value;o.textContent=labelText;return o;}
 function render(){
  const on=!!settings&&settings.enabled!==false,pinned=settings&&typeof settings.pinned==='string'?settings.pinned:null;
  select.replaceChildren(option(AUTO,'Personality: auto (by task)'),...catalog.map(e=>option(e.id,text(e.name,60)+(e.registered?'':' · not registered'))));
  select.value=pinned&&catalog.some(e=>e.id===pinned)?pinned:AUTO;
  toggle.textContent=on?'Personality: on':'Personality: off';toggle.setAttribute('aria-checked',String(on));
  const locked=!!gate||failed||!configured;
  select.disabled=locked||!on;toggle.disabled=locked;select.hidden=!configured&&!gate;toggle.hidden=!configured&&!gate;
  if(gate==='signin')note.textContent='Sign in to see which personality answers.';
  else if(gate==='member')note.textContent='Personality selection is set by the primary owner.';
  else if(failed)note.textContent='Personality settings unavailable; replies still carry the personality the host chose.';
  else if(!configured)note.textContent='';
  else if(!on)note.textContent='Personality auto-selection is off: Echo answers as Echo Prime.';
  else if(pinned){const e=catalog.find(x=>x.id===pinned);note.textContent='Pinned to '+(e?text(e.name,60):pinned)+' for every reply.';}
  else note.textContent='Echo picks a personality per message from topic, tone and intent; the reply says which one answered.';
 }
 async function refresh(){
  const current=++generation,ws=workspace();
  if(ws)await Promise.resolve(ws.ready).catch(()=>{});
  if(current!==generation)return;
  const access=admission();
  if(access==='signin'||access==='member'){settings=null;catalog=[];configured=false;failed=false;gate=access;debug('personality_status',{outcome:'skipped',reason:access});render();return;}
  if(Date.now()-failedAt<COOLDOWN_MS){debug('personality_status',{outcome:'cooldown'});return;}
  try{
   const data=await api('prime/personality');
   if(current!==generation)return;
   if(!data||typeof data!=='object')throw new Error('status');
   configured=data.configured===true;gate='';failed=false;
   settings=configured&&data.settings&&typeof data.settings==='object'?{enabled:data.settings.enabled!==false,pinned:typeof data.settings.pinned==='string'?data.settings.pinned:null}:null;
   catalog=configured&&data.catalog&&Array.isArray(data.catalog.entries)?data.catalog.entries.filter(e=>e&&typeof e.id==='string'&&/^[a-z0-9]{1,20}$/.test(e.id)).map(e=>({id:e.id,name:typeof e.name==='string'&&e.name?e.name:e.id,registered:e.registered===true})):[];
   debug('personality_status',{outcome:'returned',configured,enabled:!!settings&&settings.enabled,pinned:settings?settings.pinned:null,catalog:catalog.length});
  }catch{if(current!==generation)return;failedAt=Date.now();settings=null;failed=true;gate='';debug('personality_status',{outcome:'failed'});}
  render();
 }
 async function update(patch){
  try{const next=await api('prime/personality',patch);settings={enabled:next.enabled!==false,pinned:typeof next.pinned==='string'?next.pinned:null};failed=false;debug('personality_settings',{...settings});}
  catch(error){note.textContent='Personality setting was not saved: '+text(error instanceof Error?error.message:'request failed',200);return false;}
  render();await handBack();return true;
 }
 select.addEventListener('change',()=>{update({pinned:select.value===AUTO?null:select.value});});
 toggle.addEventListener('click',()=>{update({enabled:!(settings&&settings.enabled!==false)});});
 // ---- Workspace conversation path ---------------------------------------------------------------------------------
 /** Before a Workspace turn (owner only, auto on): score the message on the server, then set the Workspace chat's personality
  *  through its own personality_select action. Re-sent only when the pick changes; a member's turn is untouched. */
 async function beforeWorkspaceTurn(turn){
  if(!turn||typeof turn!=='object'||typeof turn.chatId!=='string'||typeof turn.api!=='function')return null;
  if(admission()!=='owner'||!configured||!settings||settings.enabled===false)return null;
  const history=(Array.isArray(turn.messages)?turn.messages:[]).filter(m=>m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string').slice(-6).map(m=>({role:m.role,content:m.content.slice(0,4000)}));
  const pick=await api('prime/personality/select',{text:text(turn.text,12000),history});
  const id=pick&&pick.selection&&typeof pick.selection.id==='string'?pick.selection.id:null;
  if(!id)return null;
  if(applied.get(turn.chatId)!==id){await turn.api('/action',{action:'personality_select',chat_id:turn.chatId,profile:id});applied.set(turn.chatId,id);debug('workspace_personality_selected',{profile:id,pinned:pick.selection.pinned===true});}
  return pick.selection;
 }
 /** When auto-selection is switched off, give the current Workspace chat back to the Workspace's own auto mode once. */
 async function handBack(){
  if(!settings||settings.enabled!==false)return;
  // EchoPrimeWorkspace.bridge is a frozen object (workspace.js), not a function: the old function check never handed back.
  const ws=workspace(),b=ws&&ws.bridge&&typeof ws.bridge==='object'?ws.bridge:null,chat=b&&b.state?b.state.chat:null;
  if(!chat||typeof chat.id!=='string'||!applied.has(chat.id)||typeof b.api!=='function')return;
  try{await b.api('/action',{action:'personality_select',chat_id:chat.id,profile:AUTO});applied.delete(chat.id);debug('workspace_personality_released',{chat:chat.id});}catch{/* the Workspace keeps the last pick; the next owner turn will not touch it */}
 }
 // ---- reply decoration ----------------------------------------------------------------------------------------------
 function node(tag,className,content){const el=document.createElement(tag);if(className)el.className=className;if(content!==undefined)el.textContent=content;return el;}
 function textNode(value){return typeof document.createTextNode==='function'?document.createTextNode(value):node('span','',value);}
 /** Rebuilds the reply paragraph from text nodes with a dotted span over each unverified identifier. No markup from the model is ever parsed. */
 function mark(content,answer,claims){
  const spans=claims.filter(c=>c&&Number.isInteger(c.start)&&Number.isInteger(c.end)&&c.start>=0&&c.end<=answer.length&&c.end>c.start).sort((a,b)=>a.start-b.start);
  if(!spans.length)return 0;
  content.textContent='';let cursor=0,count=0;
  for(const c of spans){
   if(c.start<cursor)continue;
   if(c.start>cursor)content.append(textNode(answer.slice(cursor,c.start)));
   const span=node('span','unverified',answer.slice(c.start,c.end));span.setAttribute('title','Echo could not verify this');span.setAttribute('data-claim-kind',text(c.kind,20));
   content.append(span);cursor=c.end;count++;
  }
  if(cursor<answer.length)content.append(textNode(answer.slice(cursor)));
  return count;
 }
 function verifyAction(article,result){
  const button=node('button','quiet-button verify-action','Verify');button.type='button';button.setAttribute('aria-label','Ask Echo for the evidence behind this reply');
  button.addEventListener('click',async()=>{
   button.disabled=true;button.textContent='Verifying…';
   const box=node('div','verify-result');box.setAttribute('role','status');
   try{
    const v=await api('chat/verify',{requestId:crypto.randomUUID(),sessionId:result.sessionId});
    const s=v.summary||{};box.append(node('strong','',String(s.total||0)+' claim'+(s.total===1?'':'s')+' · '+String(s.verified||0)+' found in this turn\'s evidence · '+String(s.unverified||0)+' not found'));
    const list=document.createElement('ul');
    for(const c of (Array.isArray(v.claims)?v.claims:[]).slice(0,60)){const li=node('li',c.verified?'verified':'unverified-claim','['+text(c.kind,20)+'] '+text(c.value,160)+' — '+(c.verified?'from '+text(c.source,80):'not in any tool result or the message'));list.append(li);}
    if(list.children&&list.children.length)box.append(list);
    if(v.account&&typeof v.account.text==='string'){box.append(node('small','','Model\'s own account (unverified model text'+(v.account.model&&window.EchoPrimeModels?'; '+window.EchoPrimeModels.describe(v.account.model):'')+'):'));box.append(node('pre','',text(v.account.text,8000)));}
    button.textContent='Verified';debug('verify',{outcome:'returned',total:s.total,unverified:s.unverified});
   }catch(error){box.textContent='Verification failed: '+text(error instanceof Error?error.message:'request failed',300)+' No automatic retry was made.';button.textContent='Verify';button.disabled=false;debug('verify',{outcome:'failed'});}
   article.append(box);
  });
  return button;
 }
 /** Called by chat.js with the rendered article, its paragraph and the server reply. Purely additive: a missing field adds nothing. */
 function decorate(article,result,content){
  if(!article||!result||typeof result!=='object')return;
  const p=result.personality;
  if(p&&typeof p==='object'&&typeof p.id==='string'){
   const name=text(p.name||p.id,60);
   const tag=node('small','personality-tag','as '+name+(p.pinned===true?' (pinned)':'')+(typeof p.reason==='string'&&p.reason?' · '+text(p.reason,160):''));
   if(p.pinned!==true&&configured&&!gate){
    const pin=node('button','quiet-button personality-pin','Pin '+name);pin.type='button';pin.setAttribute('aria-label','Pin '+name+' for every reply');
    pin.addEventListener('click',async()=>{pin.disabled=true;const ok=await update({pinned:p.id});pin.textContent=ok?'Pinned':'Pin '+name;if(!ok)pin.disabled=false;});
    tag.append(pin);
   }
   article.append(tag);
  }
  const claims=result.claims;
  if(content&&claims&&Array.isArray(claims.unverified)&&claims.unverified.length&&typeof result.answer==='string'){
   const n=mark(content,result.answer,claims.unverified);
   if(n)article.append(node('small','claims-note',n+' identifier'+(n===1?'':'s')+' Echo could not verify against this turn\'s evidence (dotted).'));
   debug('unverified_claims',{count:n,total:claims.total});
  }
  if(result.status==='completed'&&typeof result.sessionId==='string')article.append(verifyAction(article,result));
 }
 window.addEventListener('echo-account-changed',()=>{applied.clear();refresh();});
 render();
 const ready=refresh();
 window.EchoPrimeBrain={ready,refresh,decorate,beforeWorkspaceTurn,settings(){return settings?{...settings}:null;}};
})();
