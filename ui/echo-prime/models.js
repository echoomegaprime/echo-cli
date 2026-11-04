(() => {
 'use strict';
 const controls=document.querySelector('#workspace-conversation-controls');
 const Transport=window.EchoPrimeWorkspaceTransport;
 if(!controls||typeof Transport?.prototype?.chat!=='function')return;
 const names={qwen:'Qwen 3.8',claude:'Claude',gpt:'GPT',grok:'Grok'};
 const modelName=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
 const requestName=/^[A-Za-z0-9_-]{1,100}$/;
 const choices=new Map();let selected=null,busy=0,generation=0;
 const label=document.createElement('label'),select=document.createElement('select'),note=document.createElement('span');
 label.textContent='Model';label.id='workspace-model-control';select.id='workspace-model';
 select.setAttribute('aria-label','Model for the next Echo conversation message');label.append(select);
 note.id='workspace-model-status';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
 controls.append(label,note);
 const log=(category)=>console.debug(JSON.stringify({schemaVersion:1,event:'prime_model_picker',category}));
 function mode(){return document.querySelector('#workspace-chat-kind')?.value==='workspace';}
 function availability(){select.disabled=busy>0||!choices.size||!mode();label.hidden=!mode();note.hidden=!mode();}
 function clearIdentity(){for(const article of document.querySelectorAll('#chat-log .chat-message.assistant')){const detail=article.querySelector('[data-model-identity]');if(detail){detail.textContent='';detail.hidden=true;}}}
 function reset(){generation++;choices.clear();selected=null;select.value='';select.replaceChildren();clearIdentity();note.textContent='Model selection unavailable. Refresh your signed-in Workspace.';availability();}
 function catalog(data){
  const session=window.EchoPrimeWorkspace?.session;
  if(!session?.authenticated||session.user?.status!=='approved'){reset();return;}
  const rows=data?.model_choices;
  if(!Array.isArray(rows)||rows.length<1||rows.length>4||data.default_model_provider!=='qwen'){
   reset();log('catalog_unavailable');return;
  }
  const validated=new Map();
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row)||!Object.hasOwn(names,row.id)||validated.has(row.id)||
    typeof row.label!=='string'||!row.label.trim()||row.label.length>80||
    !(row.requested_model===null||typeof row.requested_model==='string'&&modelName.test(row.requested_model))||
    row.context_length!==undefined&&(!Number.isInteger(row.context_length)||row.context_length<1024||row.context_length>1048576)){
    reset();log('catalog_rejected');return;
   }
   validated.set(row.id,row);
  }
  if(!validated.has('qwen')){reset();log('default_unavailable');return;}
  choices.clear();for(const [id,row] of validated)choices.set(id,row);
  if(!selected||!choices.has(selected))selected='qwen';
  select.replaceChildren();
  for(const [id,row] of choices){const option=document.createElement('option');option.value=id;option.textContent=row.label+(row.context_length?' · '+row.context_length.toLocaleString()+' context':'');select.append(option);}
  select.value=selected;note.textContent='Provider checked when you send.';availability();log('configured_choices');
 }
 select.addEventListener('change',()=>{
  if(!choices.has(select.value)||busy){selected=null;note.textContent='Model selection unavailable. Choose a configured provider.';log('selection_rejected');return;}
  selected=select.value;note.textContent='Next message: '+names[selected]+'. Provider checked when you send.';log('selection_changed');
 });
 function parseIdentity(event){
  if((event?.kind??event?.type)!=='model_identity')return null;
  let value;try{value=typeof event.content==='string'?JSON.parse(event.content):event.content;}catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(names,value.provider)||
   typeof value.request_id!=='string'||!requestName.test(value.request_id)||
   !(value.requested===null||typeof value.requested==='string'&&modelName.test(value.requested))||
   !(value.reported===true&&typeof value.model==='string'&&modelName.test(value.model)||value.reported===false&&value.model===null))return null;
  return value;
 }
 function identity(chat){
  if(!chat||!Array.isArray(chat.messages)||!Array.isArray(chat.events)){clearIdentity();return;}
  const identities=new Map();
  for(const event of chat.events.slice(-20000)){const value=parseIdentity(event);if(value)identities.set(value.request_id+':reply',value);}
  const replies=chat.messages.slice(-1000).filter(message=>message?.role==='assistant');
  const articles=document.querySelectorAll('#chat-log .chat-message.assistant');
  // Attach only to the same saved reply. A mutable last-provider value would
  // mislabel old messages after a selection or account change.
  for(let index=0;index<articles.length;index++){
   const article=articles[index],value=identities.get(replies[index]?.request_id);
   let detail=article.querySelector('[data-model-identity]');
   if(!detail){detail=document.createElement('small');detail.setAttribute('data-model-identity','1');article.append(detail);}
   detail.hidden=false;
   detail.textContent=value?(value.reported?'Answered by '+names[value.provider]+' · '+value.model:names[value.provider]+' · Model not reported'+(value.requested?' · requested '+value.requested:'')):'Model identity unavailable for this saved reply.';
  }
 }
 const canonicalChat=Transport.prototype.chat;
 Transport.prototype.chat=async function(input,onEvent,signal){
  if(!selected||!choices.has(selected))throw new Error('Model selection unavailable. Refresh your signed-in Workspace before sending.');
  const provider=selected,current=generation;busy++;availability();log('turn_started');
  try{return await canonicalChat.call(this,{...input,model_provider:provider},onEvent,signal);}
  catch(error){if(current===generation){note.textContent=names[provider]+' did not complete this turn. No provider fallback was made.';log('turn_failed');}throw error;}
  finally{busy--;availability();}
 };
 window.addEventListener('echo-account-changed',reset);
 window.addEventListener('echo-workspace-state',event=>catalog(event.detail?.state));
 window.addEventListener('echo-workspace-chat',event=>identity(event.detail?.chat));
 document.querySelector('#workspace-chat-kind')?.addEventListener('change',availability);
 reset();
 if(window.EchoPrimeWorkspace?.data)catalog(window.EchoPrimeWorkspace.data);
 if(window.EchoPrimeWorkspace?.chat)identity(window.EchoPrimeWorkspace.chat);
})();
