(() => {
 'use strict';
 const $=s=>document.querySelector(s);
 let sessionId,active=null,generation=0;
 function busy(value){$('#composer .send').disabled=value;$('#stop-chat').hidden=!value;$('#chat-log').setAttribute('aria-busy',String(value));}
 function line(role,text,detail){
  const article=document.createElement('article'),label=document.createElement('strong'),content=document.createElement('p');
  article.className='chat-message '+role;label.textContent=role==='user'?'You':'ECHO Code';content.textContent=text;
  article.append(label,content);if(detail){const meta=document.createElement('small');meta.textContent=detail;article.append(meta);}
  $('#chat-log').append(article);$('#chat-log').hidden=false;$('#welcome').hidden=true;article.scrollIntoView({block:'nearest'});
 }
 async function api(path,body,signal){
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',
   headers:{'x-prime-request':'1',...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Chat request failed');return data;
 }
 window.EchoPrimeChat={
  reset(){generation++;active?.abort();active=null;sessionId=undefined;$('#chat-log').replaceChildren();$('#chat-log').hidden=true;$('#welcome').hidden=false;busy(false);},
  cancel(){active?.abort();},
  async send(text){
   if(active)return {sent:false,detail:'Wait for the current turn or select Stop.'};
   const controller=new AbortController(),current=generation;active=controller;busy(true);
   const timer=setTimeout(()=>controller.abort(),125000);let submitted=false;
   try{
    const status=await api('status',undefined,controller.signal);
    if(current!==generation)return {cancelled:true};
    if(controller.signal.aborted)throw new Error('Interrupted');
    if(status.chat?.state!=='attached')return {sent:false,detail:status.chat?.detail||'Shared chat host is not connected. Your draft is saved.'};
    if(status.chat.busy)return {sent:false,detail:'The host is finishing another turn. Your draft is saved.'};
    line('user',text);submitted=true;
    const result=await api('chat',{requestId:crypto.randomUUID(),prompt:text,...(sessionId?{sessionId}:{})},controller.signal);
    if(current!==generation)return {cancelled:true};
    sessionId=result.sessionId;
    const evidence=Array.isArray(result.evidence)?result.evidence.map(e=>e.path+' ['+e.sha256+']').join('; '):'';
    line('assistant',result.answer||'Turn ended without an answer.',
     (result.answerVerification==='unverified_model_text'?'Model text; verify claims. ':'Application result. ')+
     'Read-only · '+result.status+' · Session '+sessionId+(evidence?' · Sources: '+evidence:''));
    return {sent:result.status==='completed',detail:result.status==='completed'?'Answer received.':'Turn '+result.status+'. No automatic retry was made.'};
   }catch(error){
    if(current!==generation)return {cancelled:true};
    const detail=controller.signal.aborted?'Turn cancelled. The provider may still be finishing; no retry was made.':
     (error instanceof Error?error.message:'Chat connection failed')+(submitted?' No automatic retry was made.':' Your draft is saved.');
    if(submitted)line('assistant',detail,'Connection result');
    return {sent:false,detail};
   }finally{clearTimeout(timer);if(active===controller){active=null;busy(false);}}
  },
 };
 $('#stop-chat').addEventListener('click',()=>window.EchoPrimeChat.cancel());
 window.addEventListener('pagehide',()=>active?.abort());
})();
