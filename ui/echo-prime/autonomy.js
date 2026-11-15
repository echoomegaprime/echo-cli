(() => {
 'use strict';
 const roles=['builder','observer','troubleshooter','researcher','architect','commander','enhancer','publisher'];
 const pins=new Map();let generation=0;
 function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;}
 function strip(){
  let node=document.querySelector('#prime-autonomy-strip');if(node)return node;
  node=el('section');node.setAttribute('id','prime-autonomy-strip');node.className='workspace-conversation-controls';node.setAttribute('aria-label','Role and continuity activity');
  document.querySelector('#composer')?.before(node);return node;
 }
 function roleChip(state,sessionId,pinSupported=true){
  const node=el('span'),label=el('span','as '+state.role+(state.available===false?' · method unavailable':''));node.append(label);
  if(!roles.includes(state.role))return node;
  if(!pins.has(sessionId))pins.set(sessionId,state.pinned?state.role:null);
  const select=el('select');select.setAttribute('aria-label','Fleet role');for(const role of roles){const option=el('option',role);option.value=role;select.append(option);}select.value=pins.get(sessionId)||state.role;
  const pin=el('button');pin.type='button';pin.className='quiet-button';pin.disabled=!pinSupported;
  function update(){const locked=!!pins.get(sessionId);pin.textContent=locked?'Unlock role':'Pin role';pin.setAttribute('aria-pressed',String(locked));pin.title=pinSupported?'Applies on your next owner turn; broker permissions stay unchanged':'Role pin is not connected on this host';}
  pin.addEventListener('click',()=>{if(!pinSupported)return;pins.set(sessionId,pins.get(sessionId)?null:select.value);update();});
  select.addEventListener('change',()=>{if(pinSupported)pins.set(sessionId,select.value);update();});select.disabled=!pinSupported;update();node.append(select,pin);return node;
 }
 function activity(row){const node=el('span');node.setAttribute('role','status');node.textContent=row.receiptId?'ECF receipt '+row.receiptId+' · read back':String(row.message||'Continuity unavailable').slice(0,600);return node;}
 function reviewCard(result,options){
  const review=result?.review,node=el('article');node.className='chat-message activity';
  if(!review||typeof review.id!=='string'||typeof review.digest!=='string')return node;
  node.append(el('strong','ESH review required'),el('pre',JSON.stringify(review.request,null,2)),el('p',result.message||'Review this exact request before Run.'));
  const run=el('button','Run'),status=el('p');run.type='button';const epoch=generation;
  run.addEventListener('click',async()=>{
   if(run.disabled||epoch!==generation)return;run.disabled=true;status.textContent='Submitting reviewed request…';
   try{
    const receipt=await options.api('execute',{id:review.id,digest:review.digest});if(epoch!==generation)return;
    status.textContent='ESH '+String(receipt.state||'unconfirmed')+'.';node.append(el('pre',JSON.stringify(receipt,null,2)));
    if(options.resume)await options.resume(receipt);
   }catch(error){if(epoch===generation)status.textContent=String(error?.message||'Execution unavailable')+'. Inspect the original receipt before retrying.';}
  });node.append(run,status);return node;
 }
 function renderTurn(result,options={}){
  const host=options.host||strip();host.replaceChildren();
  if(result.role)host.append(roleChip(result.role,result.sessionId,options.pinSupported!==false));
  for(const row of (result.activity||[]).slice(-8))host.append(activity(row));
  for(const value of (result.autonomy||[]).slice(-20))if(value?.review&&options.api)host.append(reviewCard(value,options));
 }
 function event(event,options={}){
  if(event.type==='role_changed')renderTurn({role:event.role,sessionId:options.sessionId},options);
  else if(event.type==='continuity_activity')strip().append(activity(event));
  else if(event.type==='tool_result'&&event.result?.review&&options.api)strip().append(reviewCard(event.result,options));
 }
 window.EchoPrimeAutonomy={roleChip,reviewCard,renderTurn,event,pinFor:id=>pins.has(id)?pins.get(id):undefined};
 window.addEventListener('echo-account-changed',()=>{generation++;pins.clear();document.querySelector('#prime-autonomy-strip')?.replaceChildren();});
})();
