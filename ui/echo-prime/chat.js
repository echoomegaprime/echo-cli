(() => {
 'use strict';
 const $=s=>document.querySelector(s);
 // Compact per-turn activity line, shared with the Workspace path. Optional: absent in unit
 // harnesses that don't load activity.js, so every call is guarded.
 const activity=window.EchoPrimeActivity;
 const activityHost=()=>$('#chat-activity');
 let sessionId,active=null,generation=0;
 function busy(value){$('#composer .send').disabled=value;$('#stop-chat').hidden=!value;$('#chat-log').setAttribute('aria-busy',String(value));}
 function line(role,text,detail){
  const article=document.createElement('article'),label=document.createElement('strong'),content=document.createElement('p');
  article.className='chat-message '+role;label.textContent=role==='user'?'You':'ECHO Code';content.textContent=text;
  article.append(label,content);if(detail){const meta=document.createElement('small');meta.textContent=detail;article.append(meta);}
  $('#chat-log').append(article);$('#chat-log').hidden=false;$('#welcome').hidden=true;article.scrollIntoView({block:'nearest'});
 }
 async function api(path,body,signal){
  const current=generation;let headers={};if(window.EchoPrimeWorkspace)headers=await window.EchoPrimeWorkspace.ownerHeaders();
  if(current!==generation||signal?.aborted)throw new Error('Account session changed.');
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',
   headers:{'x-prime-request':'1',...headers,...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal});
   const data=await response.json();if(current!==generation||signal?.aborted)throw new Error('Account session changed.');
   if(!response.ok){if(response.status===401||response.status===403){if(window.EchoPrimeWorkspace?.invalidate)window.EchoPrimeWorkspace.invalidate();else window.dispatchEvent(new Event('echo-account-changed'));}throw new Error(data.error||'Chat request failed');}return data;
 }
 window.EchoPrimeChat={
  reset(){generation++;active?.abort();active=null;sessionId=undefined;activity?.clear(activityHost());$('#chat-log').replaceChildren();$('#chat-log').hidden=true;$('#welcome').hidden=false;busy(false);},
  cancel(){active?.abort();},
  async send(text){
   if(active)return {sent:false,detail:'Wait for the current turn or select Stop.'};
   const controller=new AbortController(),current=generation;active=controller;busy(true);
   const timer=setTimeout(()=>controller.abort(),125000);let submitted=false,strip=null;
   const ensureStrip=()=>{if(!strip&&activity)strip=activity.start(activityHost(),{label:'ECHO Code'});return strip;};
   try{
    const status=await api('status',undefined,controller.signal);
    if(current!==generation)return {cancelled:true};
    if(controller.signal.aborted)throw new Error('Interrupted');
    if(status.chat?.state!=='attached')return {sent:false,detail:status.chat?.detail||'Shared chat host is not connected. The prompt remains in this tab.'};
    if(status.chat.busy)return {sent:false,detail:'The host is finishing another turn. The prompt remains in this tab.'};
    line('user',text);submitted=true;ensureStrip()?.thinking();
    const result=await api('chat',{requestId:crypto.randomUUID(),prompt:text,...(sessionId?{sessionId}:{}),...(window.EchoPrimeModels?.provider()?{provider:window.EchoPrimeModels.provider()}:{}),...(window.EchoPrimeModels?.model?.()?{model:window.EchoPrimeModels.model()}:{})},controller.signal);
    if(current!==generation)return {cancelled:true};
    sessionId=result.sessionId;
    const evidence=Array.isArray(result.evidence)?result.evidence.map(e=>e.path+' ['+e.sha256+']').join('; '):'';
    const completed=result.status==='completed';
    // The server guard (agent.ts) always returns a truthful summary when the model emits no final
    // action, so answer is non-empty; this fallback only covers a malformed/absent field.
    line('assistant',(typeof result.answer==='string'&&result.answer.trim())?result.answer:'The turn produced no final answer; the steps above are saved. Nothing was retried.',
     (result.answerVerification==='unverified_model_text'?'Model text; verify claims. ':'Application result. ')+
     'Read-only · '+result.status+' · Session '+sessionId+(evidence?' · Sources: '+evidence:'')+(result.model&&window.EchoPrimeModels?' · '+window.EchoPrimeModels.describe(result.model):''));
    strip?.done(completed?'Answer received':'Turn '+result.status);
    console.debug('[echo.code]',{schema_version:1,event:'coding_turn',outcome:completed?'completed':'returned'});
    return {sent:completed,detail:completed?'Answer received.':'Turn '+result.status+'. No automatic retry was made.'};
   }catch(error){
    if(current!==generation)return {cancelled:true};
    const detail=controller.signal.aborted?'Turn cancelled. The provider may still be finishing; no retry was made.':
     (error instanceof Error?error.message:'Chat connection failed')+(submitted?' No automatic retry was made.':' The prompt remains in this tab.');
    if(submitted)line('assistant',detail,'Connection result');
    strip?.fail(controller.signal.aborted?'Cancelled.':'Connection failed.');
    return {sent:false,detail};
   }finally{clearTimeout(timer);if(active===controller){active=null;busy(false);}}
  },
 };
 $('#stop-chat').addEventListener('click',()=>window.EchoPrimeChat.cancel());
 window.addEventListener('echo-account-changed',()=>window.EchoPrimeChat.reset());
 window.addEventListener('pagehide',()=>active?.abort());
})();
