(() => {
 'use strict';
 const $=selector=>document.querySelector(selector),all=selector=>[...document.querySelectorAll(selector)];
 const state={enabled:false,data:null,chat:null,attachments:new Set(),epoch:0,accountEpoch:0,panel:0,voiceEpoch:0,micEpoch:0,micPending:false,capture:null,micController:null,turn:null,controller:new AbortController(),audio:null,audioUrl:null,audioDone:null,speech:null};
 const voiceOptions={spoken:false,brief:false,autoSend:false,conversation:false,remaining:0,limitReached:false};let listenTimer;
 const dialog=$('#workspace-dialog'),content=$('#workspace-panel-content'),notice=$('#workspace-panel-status');
 const esh={generation:0,rows:new Map(),review:null,busy:false,floating:false,rect:{x:280,y:90,width:640,height:430}};
 const transport=new window.EchoPrimeWorkspaceTransport({onIdentityChange:identityChanged});
 function element(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(key==='value')node.value=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }
 const input=(placeholder,value='',type='text')=>element('input',{placeholder,value,type,autocomplete:'off'});
 const field=(label,node)=>element('label',{class:'workspace-field'},element('span',{},label),node);
 const pre=value=>element('pre',{class:'workspace-receipt'},typeof value==='string'?value:JSON.stringify(value,null,2));
 const statusHooks=[];
 function status(text){notice.textContent=text;for(const hook of statusHooks)try{hook(text);}catch{}}
 function log(operation,outcome){console.debug('[echo.workspace]',{schema_version:1,event:'workspace_operation',operation,outcome});}
 function button(label,action,className='quiet-button',panelScoped=true){
  const node=element('button',{type:'button',class:className},label),epoch=state.epoch,accountEpoch=state.accountEpoch,panel=state.panel;
  const current=()=>accountEpoch===state.accountEpoch&&(!panelScoped||epoch===state.epoch&&panel===state.panel);
  node.addEventListener('click',async()=>{if(node.disabled||!node.isConnected||!current())return;node.disabled=true;try{await action();}catch(error){if(current()){status(error instanceof Error?error.message:'Workspace operation failed. No automatic retry was made.');log('panel_action','failed');}}finally{node.disabled=false;}});return node;
 }
 const card=(title,...children)=>element('article',{class:'workspace-card-content'},element('h3',{},String(title)),...children);
 async function api(path,body){const epoch=state.epoch,panel=state.panel,value=await transport.request(path,body,state.controller.signal);if(epoch!==state.epoch||panel!==state.panel)throw new Error('Workspace view changed; response discarded.');return value;}
 function clearPasswords(){all('#workspace-dialog input[type="password"]').forEach(node=>{node.value='';});}
 function clearFields(){all('#workspace-dialog input, #workspace-dialog textarea').forEach(node=>{node.value='';});}
 function releaseAudio(){state.audioDone?.(false);state.audioDone=null;state.audio?.pause();state.audio=null;if(state.audioUrl)URL.revokeObjectURL(state.audioUrl);state.audioUrl=null;}
 function endConversation(){voiceOptions.conversation=false;voiceOptions.remaining=0;voiceOptions.limitReached=false;clearTimeout(listenTimer);}
 function stopCapture(){state.micEpoch++;state.micController?.abort();state.micController=null;state.micPending=false;void state.capture?.finish(true);state.capture=null;}
 function stopAudio(){state.voiceEpoch++;releaseAudio();state.speech=null;stopCapture();}
 function clearConversation(){
  state.epoch++;state.turn?.abort();state.turn=null;state.chat=null;state.attachments.clear();endConversation();stopAudio();
  $('#chat-log').replaceChildren();$('#chat-log').hidden=true;$('#welcome').hidden=false;$('#prompt').value='';$('#conversation-title').textContent='New conversation';$('#draft-notice').hidden=true;setBusy(false);updateContext();
  clearESH();
 }
 // One key per identity this page can render. A cleared session (null) and an anonymous readback are the same
 // identity: both are "signed out".
 const identityKey=session=>`${session?.authenticated===true}|${session?.user?.uid??''}|${session?.user?.status??''}|${session?.ownerAccess===true}`;
 let identity=null;// key of the identity this page renders; null until the first /api/session readback
 function identityChanged(session){
  // The transport calls this on every readback that differs from its cache and on every clear(); `ready` calls it once
  // after the first readback. Only a real change clears the page and tells the other modules (`echo-account-changed`).
  // Before 2026-11-04 every call did both, so an owner-only 401 for a visitor who was already signed out cleared the
  // page and made models/swarm/fleet refetch, which produced another 401: 545 /api/session reads in one minute.
  const key=identityKey(session),first=identity===null,changed=!first&&key!==identity;
  identity=key;
  if(!first&&!changed){log('identity','unchanged');return;}
  log('identity',first?'observed':'changed');
  state.accountEpoch++;
  state.controller.abort();state.controller=new AbortController();clearFields();content.replaceChildren();status('');state.data=null;clearConversation();
  voiceOptions.spoken=false;voiceOptions.brief=false;voiceOptions.autoSend=false;
  $('#workspace-chat-search').value='';$('#workspace-project').replaceChildren(element('option',{value:''},'No project'));
  window.EchoPrimeChat?.reset();$('#history').replaceChildren();
  // The first readback is an observation, not a change: models.js, swarm.js and fleet.js bootstrap from the session
  // themselves (after `ready`), and every other listener only clears state that is still empty at that point.
  if(changed)window.dispatchEvent(new Event('echo-account-changed'));
  if(session&&typeof session.workspaceConfigured==='boolean')state.enabled=session.workspaceConfigured;
  const owner=!!session?.ownerAccess;
  all('[data-owner-only]').forEach(node=>{node.hidden=state.enabled&&!owner;});
  $('#workspace-open-esh').hidden=!state.enabled||!owner;
  $('#open-steward').hidden=state.enabled&&!owner;
  $('.connection-pill').hidden=state.enabled&&!owner;
  $('#workspace-chat-kind option[value="coding"]').disabled=state.enabled&&!owner;
  if(state.enabled&&!owner)$('#workspace-chat-kind').value='workspace';
  if(state.enabled){
   $('#welcome-lead').textContent=owner?'What shall we create,':'What shall we create';$('#welcome-audience').textContent=owner?'Commander?':'together?';
   const name=session?.user?.name||session?.user?.email||'Your account';$('.profile > span:nth-child(2)').textContent=session?.authenticated?name:'Sign in';$('.avatar').textContent=session?.authenticated?name.slice(0,2).toUpperCase():'EP';
   $('.workspace-label').textContent=session?.authenticated?'Private Workspace':'Sign in to Workspace';
   accountControls(session,name);
  }
 }
 // Always-visible account controls (top bar + sidebar bottom). Only shown once a Workspace backend is configured;
 // anonymous visitors get Sign in / Request access, signed-in accounts get the avatar menu and one-click Sign out.
 function accountControls(session,name){
  const signedIn=session?.authenticated===true;
  for(const id of ['#topbar-signin','#sidebar-signin','#sidebar-signup'])$(id).hidden=signedIn;
  $('#topbar-account').hidden=!signedIn;$('#topbar-account').open=false;$('#sidebar-signout').hidden=!signedIn;
  $('#topbar-avatar').textContent=signedIn?initialsOf(session):'EP';$('#topbar-name').textContent=signedIn?name:'Account';$('#topbar-menu-name').textContent=signedIn?name:'Account';
  const email=session?.user?.email;$('#topbar-menu-email').textContent=signedIn&&email&&email!==name?String(email):'';$('#topbar-role').textContent=signedIn?roleOf(session):'';
 }
 let accountIntent=null;// 'signup' opens the account view on the request-access path
 function openAccount(intent){accountIntent=intent||null;return open('account');}
 for(const id of ['#topbar-signin','#sidebar-signin'])$(id).addEventListener('click',()=>void openAccount(null));
 $('#sidebar-signup').addEventListener('click',()=>void openAccount('signup'));
 for(const id of ['#topbar-signout','#sidebar-signout'])$(id).addEventListener('click',()=>{$('#topbar-account').open=false;void signOut();});
 $('#topbar-account').addEventListener('click',event=>{const target=event.target,item=typeof target?.closest==='function'?target.closest('[data-workspace-view]'):null;if(item||target?.dataset?.workspaceView==='account')$('#topbar-account').open=false;});
 function setBusy(value){$('#composer .send').disabled=value;$('#stop-chat').hidden=!value;$('#chat-log').setAttribute('aria-busy',String(value));}
 function updateContext(){
  const capacity=Number(state.data?.context_length),messages=state.chat?.messages||[];
  const used=Math.ceil((messages.reduce((n,m)=>n+(typeof m.content==='string'?m.content.length:0),0)+(Number(state.data?.base_context_chars)||0)+$('#prompt').value.length)/4);
  $('#workspace-context').textContent=capacity>0?`Estimated context ${used.toLocaleString()} / ${capacity.toLocaleString()} tokens`:'';
  $('#workspace-attachments').textContent=state.attachments.size?`${state.attachments.size} attached files`:'';
  window.dispatchEvent(new Event('echo-workspace-context'));
 }
 function line(role,text,detail){
  const article=element('article',{class:'chat-message '+role},element('strong',{},role==='user'?'You':role==='assistant'?'Echo Prime':'Activity'),element('p',{},String(text)));
  if(detail)article.append(element('small',{},String(detail)));$('#chat-log').append(article);$('#chat-log').hidden=false;$('#welcome').hidden=true;return article.querySelector('p');
 }
 function renderChat(){
  $('#chat-log').replaceChildren();
  for(const message of (state.chat?.messages||[]).slice(-1000))if(['user','assistant'].includes(message.role))line(message.role,message.content||'',message.created||'');
  $('#conversation-title').textContent=state.chat?.title||'New conversation';$('#welcome').hidden=!!state.chat?.messages?.length;$('#chat-log').hidden=!state.chat?.messages?.length;updateContext();syncESH();
 }
 function renderHistory(rows=state.data?.chats||[]){
  const list=$('#history');list.replaceChildren();
  for(const chat of rows.slice(0,500))list.append(button(chat.title||'Untitled conversation',()=>openChat(chat.id),'history-item',false));
  if(!rows.length)list.append(element('p',{},'Your saved conversations appear here.'));
 }
 function renderProjects(){
  const select=$('#workspace-project'),value=state.chat?.project_id||select.value;select.replaceChildren(element('option',{value:''},'No project'));
  for(const project of (state.data?.projects||[]).slice(0,500))select.append(element('option',{value:project.id},project.name||'Untitled project'));select.value=value||'';
 }
 async function refresh(){
  const epoch=state.epoch,data=await api('/state');if(epoch!==state.epoch)return;
  state.data=data;renderHistory();renderProjects();updateContext();
 }
 async function openChat(id){
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw new Error('Invalid conversation.');
  window.EchoPrimeChat.reset();clearConversation();const epoch=state.epoch,chat=await api('/chats/'+encodeURIComponent(id));if(epoch!==state.epoch)return;
  state.chat=chat;$('#workspace-chat-kind').value='workspace';renderChat();renderProjects();if(dialog.open)dialog.close();
 }
 async function newChat(){
  await ready;if(!state.enabled)return false;
  if(!transport.session?.authenticated||transport.session.user?.status!=='approved'){await open('account');return true;}
  const project=$('#workspace-project').value;window.EchoPrimeChat.reset();clearConversation();const epoch=state.epoch;
  const chat=await api('/chats',{project_id:project||null});if(epoch!==state.epoch)return true;
  state.chat=chat;$('#workspace-chat-kind').value='workspace';await refresh();renderChat();$('#prompt').focus();return true;
 }
 async function send(text){
  await ready;
  if(!state.enabled||$('#workspace-chat-kind').value!=='workspace')return {handled:false};
  if(state.turn)return {handled:true,sent:false,detail:'Wait for this turn or select Stop.'};
  if(!transport.session?.authenticated||transport.session.user?.status!=='approved'){await open('account');return {handled:true,sent:false,detail:'Sign in to your approved private Workspace first.'};}
  if(!state.chat)await newChat();if(!state.chat)return {handled:true,sent:false,detail:'Conversation was not created.'};
  const epoch=state.epoch,chatId=state.chat.id,controller=new AbortController();state.turn=controller;setBusy(true);line('user',text);
  let answer=null,answerText='',completed=false,verified=false,spoken=false;
  try{
   const result=await transport.chat({chat_id:chatId,content:text,request_id:crypto.randomUUID(),attachments:[...state.attachments]},event=>{
    if(epoch!==state.epoch||controller.signal.aborted)return;
    if(event.type==='tool_started'||event.type==='tool_result')ingestESH(event);
    if(event.type==='status'){$('#draft-notice').textContent=String(event.text||'Echo is answering…').slice(0,600);$('#draft-notice').hidden=false;}
    else if(event.type==='token'&&typeof event.text==='string'){if(!answer)answer=line('assistant','');answerText+=event.text;if(answerText.length>2_000_000)throw new Error('Answer exceeds display limit.');answer.textContent=answerText;}
    else if(event.type==='tool_started')line('activity','Using '+String(event.tool||'a tool').slice(0,100),'Request '+String(event.request_id||'').slice(0,100));
    else if(event.type==='tool_result')line('activity',String(event.tool||'Tool').slice(0,100)+' returned',String(event.evidence?.status||'Result received; postcondition may require separate verification.').slice(0,300));
   },controller.signal);
   if(epoch!==state.epoch)return {handled:true,cancelled:true};completed=true;state.chat=result;renderChat();
   const readback=await api('/chats/'+encodeURIComponent(chatId));if(epoch!==state.epoch)return {handled:true,cancelled:true};
   state.chat=readback;renderChat();await refresh();verified=true;log('chat','returned_and_read_back');
   let detail='Reply returned and saved conversation read back.';
   if((voiceOptions.spoken||voiceOptions.conversation)&&!document.hidden){
    const reply=[...(state.chat.messages||[])].reverse().find(message=>message.role==='assistant');
    try{spoken=await speakReply(reply,chatId);if(!spoken)endConversation();}catch(error){endConversation();if(epoch===state.epoch){status('Speech unavailable. '+(error instanceof Error?error.message:'No audio receipt returned.')+' No automatic retry was made.');detail+=' Speech is unavailable.';}}
   }
   return {handled:true,sent:true,verified:true,detail};
  }catch(error){
   if(epoch!==state.epoch)return {handled:true,cancelled:true};
   const detail=completed?'Reply returned; saved readback is unavailable. Reopen the conversation before retrying.':controller.signal.aborted?'Stopped displaying this turn. The upstream model may finish saving it; reopen the conversation before retrying.':(error instanceof Error?error.message:'Conversation failed.')+' No automatic retry was made.';
   endConversation();if(!completed)line('activity',detail);return {handled:true,sent:completed,verified:false,detail};
  }finally{if(state.turn===controller){state.turn=null;setBusy(false);}if(epoch===state.epoch&&verified&&spoken&&voiceOptions.conversation)scheduleListening();}
 }
 function section(title,...nodes){content.append(card(title,...nodes));}
 function clearESH(){esh.generation++;esh.rows.clear();esh.review=null;esh.busy=false;$('#workspace-esh-command').value='';$('#workspace-esh-reviewed').textContent='';$('#workspace-esh-output').replaceChildren();$('#workspace-esh-run').disabled=true;$('#workspace-esh').hidden=true;$('#workspace-esh-status').textContent='Open a saved conversation before dispatch. Policy and grants remain with the canonical ESH owner.';}
 function ingestESH(event,historical=false){
  let data=event;try{if(typeof event.content==='string')data=JSON.parse(event.content);}catch{return;}
  const kind=event.kind||event.type,manual=['action_receipt','action_failed'].includes(kind)&&(data.action||data.request?.action)==='esh';
  if(!manual&&!(['tool_started','tool_result'].includes(kind)&&data.tool==='esh'))return;
  const id=data.request_id||data.request?.request_id||event.id;if(typeof id!=='string')return;
  const previous=esh.rows.get(id)||{},result=kind==='action_failed'?{ok:false,error:data.error,state:'unconfirmed'}:data.result;
  const outcome=kind==='tool_started'?(previous.result?previous.outcome:historical?'unconfirmed':'running'):result?.verdict==='gated'?'gated':['unconfirmed','unknown'].includes(result?.state)?'unconfirmed':result?.ok===false||result?.error||result?.exit!=null&&result.exit!==0?'failed':'returned';
  esh.rows.set(id,{id,command:data.arguments?.command||data.request?.command||previous.command||'',source:manual?'You':previous.source||'Echo',outcome,result:result||previous.result});
  while(esh.rows.size>100)esh.rows.delete(esh.rows.keys().next().value);renderESH();
 }
 function renderESH(){
  const output=$('#workspace-esh-output');output.replaceChildren();
  for(const row of esh.rows.values())output.append(card(`${row.source} · ${row.outcome}`,pre(row.command||'Command receipt'),row.result?pre(row.result):element('p',{},row.outcome==='running'?'Waiting for a final receipt…':'No final receipt recorded. Check before retrying.')));
  if(!esh.rows.size)output.append(element('p',{},'Commands and receipts from this conversation appear here.'));
 }
 function syncESH(){for(const event of state.chat?.events||[])ingestESH(event,true);renderESH();}
 function applyESH(){
  const width=Number.isFinite(window.innerWidth)?window.innerWidth:1200,height=Number.isFinite(window.innerHeight)?window.innerHeight:800;
  esh.rect.width=Math.max(Math.min(300,width-16),Math.min(width-16,esh.rect.width));esh.rect.height=Math.max(Math.min(200,height-16),Math.min(height-16,esh.rect.height));
  esh.rect.x=Math.max(8,Math.min(width-esh.rect.width-8,esh.rect.x));esh.rect.y=Math.max(8,Math.min(height-esh.rect.height-8,esh.rect.y));
  const host=$('#workspace-esh');host.classList.toggle('floating',esh.floating);for(const [key,value] of Object.entries(esh.rect))host.style.setProperty('--esh-'+key,value+'px');$('#workspace-esh-float').textContent=esh.floating?'Dock':'Float';
 }
 async function openESH(){await ready;await ownerHeaders();syncESH();if(dialog.open)dialog.close();$('#workspace-esh').hidden=false;applyESH();$('#workspace-esh-command').focus();}
 $('#workspace-open-esh').addEventListener('click',()=>openESH().catch(()=>{$('#draft-notice').textContent='Current primary owner admission is required for ESH.';$('#draft-notice').hidden=false;}));
 $('#workspace-esh-close').addEventListener('click',()=>{$('#workspace-esh').hidden=true;esh.review=null;$('#workspace-esh-reviewed').textContent='';$('#workspace-esh-command').value='';$('#workspace-esh-run').disabled=true;});
 $('#workspace-esh-command').addEventListener('input',()=>{esh.review=null;$('#workspace-esh-reviewed').textContent='Review the changed command again.';$('#workspace-esh-run').disabled=true;});
 $('#workspace-esh-review').addEventListener('click',()=>{if(esh.busy||!state.chat?.id||!transport.session?.ownerAccess){$('#workspace-esh-status').textContent='Open a saved conversation under the primary owner before reviewing a command.';return;}const command=$('#workspace-esh-command').value.trim();if(!command)return;esh.review={command,chatId:state.chat.id,epoch:state.epoch};$('#workspace-esh-reviewed').textContent=command;$('#workspace-esh-run').disabled=false;});
 $('#workspace-esh-run').addEventListener('click',async()=>{
  const review=esh.review;if(esh.busy||!review||review.epoch!==state.epoch||review.chatId!==state.chat?.id||review.command!==$('#workspace-esh-command').value.trim())return;
  esh.review=null;esh.busy=true;$('#workspace-esh-run').disabled=true;const epoch=state.epoch,generation=esh.generation,id=crypto.randomUUID(),current=()=>epoch===state.epoch&&generation===esh.generation&&review.chatId===state.chat?.id;
  try{
   await ownerHeaders();if(!current())return;ingestESH({type:'tool_started',tool:'esh',request_id:id,arguments:{command:review.command}});esh.rows.get(id).source='You';renderESH();$('#workspace-esh-status').textContent='Dispatching the reviewed command…';
   const receipt=await transport.request('/action',{action:'esh',command:review.command,chat_id:review.chatId,request_id:id},state.controller.signal);if(!current())return;
   ingestESH({type:'tool_result',tool:'esh',request_id:id,result:receipt});$('#workspace-esh-status').textContent='Command receipt returned. Verify its output before relying on a repair.';log('esh','returned');
   const chat=await transport.request('/chats/'+encodeURIComponent(review.chatId),undefined,state.controller.signal);if(current()){state.chat=chat;syncESH();}
  }catch(error){if(current()){ingestESH({type:'tool_result',tool:'esh',request_id:id,result:{ok:false,state:'unconfirmed',error:error instanceof Error?error.message:'Receipt unavailable.'}});$('#workspace-esh-status').textContent='Outcome unconfirmed. Inspect the conversation journal before any retry.';log('esh','unconfirmed');}}
  finally{if(current())esh.busy=false;}
 });
 function moveESH(dx,dy){esh.floating=true;esh.rect.x+=dx;esh.rect.y+=dy;applyESH();log('esh_layout','moved');}
 $('#workspace-esh-float').addEventListener('click',()=>{esh.floating=!esh.floating;applyESH();});
 const arrows={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]};
 $('#workspace-esh-grip').addEventListener('keydown',event=>{const delta=arrows[event.key];if(delta){event.preventDefault();moveESH(...delta);}});
 $('#workspace-esh-resize').addEventListener('keydown',event=>{const delta=arrows[event.key];if(delta){event.preventDefault();esh.rect.width+=delta[0];esh.rect.height+=delta[1];esh.floating=true;applyESH();}});
 for(const [selector,resize] of [['#workspace-esh-grip',false],['#workspace-esh-resize',true]]){
  const node=$(selector);node.addEventListener('pointerdown',event=>{
   if(event.button!==0||event.isPrimary===false)return;event.preventDefault();esh.floating=true;applyESH();const original={...esh.rect},id=event.pointerId,x=event.clientX,y=event.clientY;node.setPointerCapture(id);
   const move=e=>{if(e.pointerId!==id)return;esh.rect=resize?{...original,width:original.width+e.clientX-x,height:original.height+e.clientY-y}:{...original,x:original.x+e.clientX-x,y:original.y+e.clientY-y};applyESH();};
   const finish=e=>{if(e.pointerId!==id)return;for(const [name,handler] of [['pointermove',move],['pointerup',finish],['pointercancel',cancel],['lostpointercapture',cancel]])node.removeEventListener(name,handler);if(node.hasPointerCapture(id))node.releasePointerCapture(id);log('esh_layout','changed');};
   const cancel=e=>{if(e.pointerId!==id)return;esh.rect=original;applyESH();finish(e);};node.addEventListener('pointermove',move);node.addEventListener('pointerup',finish);node.addEventListener('pointercancel',cancel);node.addEventListener('lostpointercapture',cancel);
  });
 }
 window.addEventListener('resize',applyESH);
 function saveText(name,text){const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=element('a',{href:url,download:String(name).replace(/[\\/\x00-\x1f]/g,'_').slice(0,120)});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function journal(){if(!state.chat)throw new Error('Open a saved conversation first.');const epoch=state.epoch,panel=state.panel,chat=state.chat,text=await transport.text('/journals/'+encodeURIComponent(chat.id),state.controller.signal);if(epoch!==state.epoch||panel!==state.panel)return;content.replaceChildren(pre(text),button('Download journal',()=>saveText((chat.title||'conversation')+'.md',text)));$('#workspace-panel-title').textContent='Conversation journal';if(!dialog.open)dialog.showModal();}
 async function projects(){
  const name=input('Project name'),instructions=element('textarea',{rows:5,maxlength:12000,placeholder:'Project instructions'});
  section('Create a project',field('Name',name),field('Instructions',instructions),button('Create project',async()=>{await api('/projects',{name:name.value,instructions:instructions.value});await refresh();await open('projects');}));
  for(const project of state.data.projects||[]){const title=input('Name',project.name||''),guide=element('textarea',{rows:4,maxlength:12000});guide.value=project.instructions||'';section(project.name||'Project',field('Name',title),field('Instructions',guide),button('Save changes',async()=>{await api('/project/update',{id:project.id,name:title.value,instructions:guide.value});await refresh();status('Project updated.');}),button('Start a project conversation',async()=>{$('#workspace-project').value=project.id;await newChat();dialog.close();}));}
 }
 async function library(){
  const name=input('notes.md'),text=element('textarea',{rows:6,maxlength:500000,placeholder:'Text or code'}),file=element('input',{type:'file',accept:'.txt,.md,.py,.js,.ts,.tsx,.jsx,.json,.csv,.html,.css,.yaml,.yml,.toml,.ps1,.go,.rs,.sql'});
  let fileRead=0;
  file.addEventListener('change',async()=>{const chosen=file.files?.[0],epoch=state.epoch,panel=state.panel,version=++fileRead;try{if(!chosen)return;if(chosen.size>500000||/(?:^\.env|id_rsa|id_ed25519|credentials?|secrets?|\.(?:pem|key|pfx|db)$)/i.test(chosen.name))throw new Error('Choose a non-credential text file under 500 KB.');const value=await chosen.text();if(epoch!==state.epoch||panel!==state.panel||version!==fileRead||!file.isConnected)return;name.value=chosen.name;text.value=value;}catch(error){if(epoch===state.epoch&&panel===state.panel)status(error.message);}finally{file.value='';}});
  section('Save a file',field('Choose a text file',file),field('Name',name),field('Contents',text),button('Save to your library',async()=>{const item=await api('/library',{name:name.value,content:text.value,chat_id:state.chat?.id,project_id:state.chat?.project_id||$('#workspace-project').value||null});await refresh();await open('library');status('File saved'+(item.path?' · '+item.path:'.'));}));
  for(const item of state.data.library||[]){
   const attach=element('input',{type:'checkbox','aria-label':'Attach '+item.name});attach.checked=state.attachments.has(item.id);attach.addEventListener('change',()=>{if(attach.checked)state.attachments.add(item.id);else state.attachments.delete(item.id);updateContext();});
   section(item.name||'File',element('p',{},String(item.path||'Private account file')),field('Attach to next message',attach),button('Read / download',async()=>{const value=await api('/library/'+encodeURIComponent(item.id));content.replaceChildren(pre(value.content||''),element('p',{},String(value.sha256||'')),button('Download file',()=>saveText(value.name||item.name,value.content||'')));}),button('Review code',async()=>{const value=await api('/library/'+encodeURIComponent(item.id));if(typeof value.content!=='string'||!value.content.trim()||value.content.length>40000)throw new Error('Code review requires a nonempty text file of up to 40,000 characters.');status('Reviewing this file using the canonical Workspace model…');const review=await api('/review',{name:value.name||item.name,content:value.content,project_id:value.project_id||null});if(typeof review.id!=='string')throw new Error('Review returned without a saved conversation. Inspect the library before retrying.');await openChat(review.id);await refresh();log('code_review','saved_and_read_back');}),button('Open linked conversation',async()=>{if(!item.chat_id)throw new Error('This file has no linked conversation.');await openChat(item.chat_id);}));
  }
  if(state.chat)content.append(button('Open this conversation’s journal',journal));
  const imported=element('textarea',{rows:5,maxlength:1500000,placeholder:'Paste an authorized neutral/ChatGPT/Claude JSON export or plain text'}),title=input('Imported conversation');
  section('Import conversation',field('Title',title),field('Export',imported),button('Import',async()=>{const value=normalizeImport(imported.value,title.value);const result=await api('/import',value);await refresh();status('Import returned. Open the saved conversation to inspect its selected branch and messages.');if(result.id)await openChat(result.id);}));
 }
 function normalizeImport(raw,title){
  let value;try{value=JSON.parse(raw);}catch{value={messages:[{role:'user',content:raw}]};}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose one exported conversation.');
  let messages=value.messages;
  if(value.mapping){
   const branch=[],seen=new Set();let current=value.current_node;
   while(current){if(seen.has(current)||seen.size>=10000)throw new Error('Invalid exported conversation branch.');seen.add(current);const node=value.mapping[current];if(!node||typeof node!=='object')throw new Error('Export branch is incomplete.');if(node.message)branch.push(node.message);current=node.parent;}
   messages=branch.reverse().filter(m=>['user','assistant'].includes(m.author?.role)&&Array.isArray(m.content?.parts)).map(m=>({role:m.author.role,content:m.content.parts.filter(p=>typeof p==='string').join('\n'),...(Number.isFinite(m.create_time)?{timestamp:new Date(m.create_time*1000).toISOString()}:{} )})).filter(m=>m.content.trim());
  }else if(Array.isArray(value.chat_messages))messages=value.chat_messages.filter(m=>['human','assistant'].includes(m.sender)).map(m=>({role:m.sender==='human'?'user':'assistant',content:typeof m.text==='string'?m.text:(m.content||[]).filter(x=>x.type==='text'||typeof x.text==='string').map(x=>x.text||'').join('\n'),timestamp:m.created_at}));
  if(!Array.isArray(messages)||messages.length<1||messages.length>1000||messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()))throw new Error('Import requires 1–1000 nonempty user or assistant messages.');
  return {source:'authorized-import',title:(title||value.title||value.name||'Imported conversation').slice(0,200),messages:messages.map(m=>({role:m.role,content:m.content,...(typeof m.timestamp==='string'?{timestamp:m.timestamp.slice(0,100)}:{})}))};
 }
 async function memory(){
  const note=element('textarea',{rows:4,maxlength:12000,placeholder:'A preference or note to retain'});
  section('Private preferences',field('What should Echo remember?',note),button('Save preference',async()=>{const receipt=await api('/action',{action:'memory_save',content:note.value,chat_id:state.chat?.id});await refresh();await open('memory');content.append(pre(receipt));}));
  for(const value of state.data.preferences||[])section(value.content||value.value||'Preference',button('Forget this preference',async()=>{await api('/action',{action:'memory_forget',id:value.id,chat_id:state.chat?.id});await refresh();await open('memory');}));
  section('Synchronization',pre({local:state.data.sync,knowledge:state.data.knowledge}),element('p',{},'A local save is separate from verified Fabric or Knowledge Forge ingestion.'));
  if(transport.session.ownerAccess){
   const query=input('Search your admitted ECF or Crystal connection'),source=element('select',{},element('option',{value:'ecf'},'Continuity Fabric'),element('option',{value:'crystal'},'Crystal'));
   section('Connected memory',field('Source',source),field('Query',query),button('Search',async()=>{const receipt=await api('/action',{action:'memory_search',plugin:source.value,query:query.value,chat_id:state.chat?.id});content.append(pre(receipt));}),button('Run one eligible synchronization pass',async()=>{content.append(pre(await api('/sync',{})));}));
  }
 }
 async function plugins(){
  const connections=await api('/mcp');
  for(const connection of connections.connections||[])section(connection.name||'MCP connection',element('p',{},String(connection.url||'')),element('p',{},`${connection.tool_count||0} tools · ${connection.enabled?'Enabled':'Disabled'}`),button('Inspect tool schemas',async()=>{content.append(pre(await api('/mcp/tools/'+encodeURIComponent(connection.id))));}),button(connection.enabled?'Disable':'Enable',async()=>{await api('/mcp',{action:'enable',id:connection.id,enabled:!connection.enabled});await open('plugins');}),button('Remove connection',async()=>{await api('/mcp',{action:'remove',id:connection.id});await open('plugins');}));
  const name=input('Connection name'),url=input('https://service.example/mcp','','url'),auth=element('select',{},element('option',{value:'none'},'No authentication'),element('option',{value:'bearer'},'Bearer token')),token=input('This server’s credential','','password');
  section('Connect a Streamable HTTP MCP server',field('Name',name),field('Public HTTPS endpoint',url),field('Authentication',auth),field('Credential · encrypted by the canonical owner',token),element('p',{},'This field sends the credential only to your account’s connection store. OAuth onboarding and legacy SSE-only endpoints remain unsupported.'),button('Connect and discover tools',async()=>{try{await api('/mcp',{action:'add',name:name.value,url:url.value,auth:auth.value,token:token.value});await open('plugins');status('Connection returned; inspect its advertised schemas before use.');}finally{token.value='';}}));
 }
 async function playSpeech(chunk,epoch,voice,chatId){
  const current=()=>epoch===state.epoch&&voice===state.voiceEpoch&&!document.hidden;
  while(chunk&&current()){
   if(typeof chunk.audio_url!=='string'||!/^\/api\/voice\/audio\/[A-Za-z0-9_-]{1,120}$/.test(chunk.audio_url))throw new Error('Unrecognized voice artifact.');
   const blob=await transport.audio(chunk.audio_url.replace(/^\/api/,''),state.controller.signal);if(!current())return false;
   releaseAudio();state.audioUrl=URL.createObjectURL(blob);const audio=new Audio(state.audioUrl);state.audio=audio;
   const ended=await new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(value,error)=>{if(settled)return;settled=true;if(state.audioDone===finish)state.audioDone=null;audio.removeEventListener('ended',done);audio.removeEventListener('error',failed);if(error)reject(error);else resolve(value);};
    const unavailable=()=>finish(false,new Error('Audio playback was unavailable. Press Listen again only after checking the saved speech receipt.'));
    const done=()=>finish(true),failed=unavailable;state.audioDone=finish;audio.addEventListener('ended',done,{once:true});audio.addEventListener('error',failed,{once:true});
    Promise.resolve(audio.play()).catch(unavailable);
   });
   if(!current()||!ended)return false;
   if(!chunk.has_more){releaseAudio();return true;}
   chunk=await api('/voice/next',{chat_id:chatId,session_id:chunk.session_id,chunk_index:chunk.chunk_index+1});
  }return false;
 }
 async function speakReply(reply,chatId){
  if(!reply?.id||!chatId||!state.data?.voice?.configured)throw new Error('Personality Forge speech is not configured for this Workspace.');
  if(state.speech)throw new Error('Stop the current speech before starting another.');
  stopAudio();const epoch=state.epoch,voice=state.voiceEpoch;state.speech={chat_id:chatId,session_id:null};status('Preparing governed speech…');
  try{
   const chunk=await api('/voice/start',{chat_id:chatId,message_id:reply.id,request_id:crypto.randomUUID(),mode:voiceOptions.brief?'summary':'full',read_identifiers:false});
   if(epoch!==state.epoch||voice!==state.voiceEpoch)return false;
   state.speech={chat_id:chatId,session_id:chunk.session_id};status(`Playing ${chunk.voice||'configured voice'} · ${chunk.provider||'provider reported by owner'}`);
   const complete=await playSpeech(chunk,epoch,voice,chatId);if(complete&&epoch===state.epoch&&voice===state.voiceEpoch)status('Speech finished. Microphone off.');return complete;
  }finally{if(epoch===state.epoch&&voice===state.voiceEpoch){releaseAudio();state.speech=null;}}
 }
 function scheduleListening(){
  clearTimeout(listenTimer);if(!voiceOptions.conversation)return;
  if(voiceOptions.remaining<=0){endConversation();voiceOptions.limitReached=true;status('Voice conversation paused after ten turns. Select Start voice conversation to resume explicitly.');return;}
  const epoch=state.epoch,panel=state.panel;listenTimer=setTimeout(()=>{if(!voiceOptions.conversation||epoch!==state.epoch||panel!==state.panel||document.hidden||!(dialog.open||state.voiceBar))return;void dictate().catch(()=>{endConversation();stopAudio();status('Voice conversation stopped. Review the last receipt before resuming.');});},300);
 }
 // Reuses the canonical Workspace mono 16 kHz PCM WAV contract. Raw samples
 // exist only for this bounded capture; no browser storage or automatic send.
 function encodeWav(samples){
  if(!samples.length||samples.length>128000)throw new Error('Use a microphone clip of up to eight seconds.');
  const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer),text=(offset,value)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
  samples.forEach((sample,i)=>view.setInt16(44+i*2,Math.max(-1,Math.min(1,sample))*(sample<0?32768:32767),true));
  let binary='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
 }
 function resample(chunks,rate){
  const size=chunks.reduce((n,part)=>n+part.length,0),input=new Float32Array(size);let offset=0;for(const part of chunks){input.set(part,offset);offset+=part.length;}
  const output=new Float32Array(Math.min(128000,Math.floor(size*16000/rate))),ratio=rate/16000;
  for(let i=0;i<output.length;i++){const start=Math.floor(i*ratio),end=Math.min(input.length,Math.max(start+1,Math.floor((i+1)*ratio)));let total=0;for(let j=start;j<end;j++)total+=input[j];output[i]=total/Math.max(1,end-start);}return output;
 }
 async function dictate(){
  if(state.capture){await state.capture.finish(false);return;}
  if(state.micPending)throw new Error('A microphone request is already pending. Select Stop microphone to cancel.');
  if(state.turn||!state.chat)throw new Error('Open an idle saved conversation before dictating.');
  if(!state.data?.voice?.configured)throw new Error('Personality Forge transcription is not configured for this Workspace. Text chat remains available.');
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone capture is unavailable in this browser. Text chat remains available.');
  stopAudio();const epoch=state.epoch,panel=state.panel,version=state.micEpoch,chatId=state.chat.id;state.micPending=true;let stream,context;
  const current=()=>epoch===state.epoch&&panel===state.panel&&version===state.micEpoch&&state.chat?.id===chatId;
  status('Requesting microphone permission…');
  try{
   stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   if(!current()){stream.getTracks().forEach(track=>track.stop());return;}
   const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw new Error('PCM microphone capture is unavailable in this browser.');
   context=new AudioContext();if(!Number.isFinite(context.sampleRate)||context.sampleRate<8000||context.sampleRate>192000)throw new Error('Unsupported microphone sample rate.');
   const source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain(),chunks=[];let frames=0,finished=false,heard=false,silence=0,timer;
   mute.gain.value=0;source.connect(processor);processor.connect(mute);mute.connect(context.destination);
   const finish=async cancel=>{
    if(finished)return;finished=true;clearTimeout(timer);processor.onaudioprocess=null;
    for(const node of [source,processor,mute])try{node.disconnect();}catch{}
    stream.getTracks().forEach(track=>track.stop());if(state.capture?.finish===finish)state.capture=null;
    await context.close().catch(()=>{});
    if(cancel||!current()){chunks.length=0;return;}
    state.micPending=true;const controller=new AbortController();state.micController=controller;
    try{
     if(!heard){endConversation();status('No speech detected. Microphone off.');return;}
     const audio=encodeWav(resample(chunks,context.sampleRate));chunks.length=0;status('Transcribing · Microphone off…');
     const result=await transport.request('/voice/transcribe',{chat_id:chatId,request_id:crypto.randomUUID(),audio_b64:audio},controller.signal);
     if(!current()||controller.signal.aborted)return;
     if(result.provider!=='elevenlabs-scribe'||typeof result.text!=='string'||result.text.length>12000)throw new Error('The canonical transcription provider did not confirm a bounded transcript.');
     const draft=[$('#prompt').value.trim(),result.text.trim()].filter(Boolean).join(' ');if(draft.length>12000)throw new Error('The transcript exceeds the composer limit. No message was sent.');
     $('#prompt').value=draft;updateContext();status('Transcribed into your composer. Close this panel to review and send.');log('microphone','transcribed_for_review');
     if(voiceOptions.autoSend||voiceOptions.conversation){
      if($('#workspace-chat-kind').value!=='workspace')throw new Error('Automatic speech sends require an Echo conversation.');
      const sendEpoch=state.epoch,sendPanel=state.panel;$('#prompt').value='';status('Sending speech under your explicit opt-in…');
      const outcome=await send(draft);if(sendEpoch!==state.epoch||sendPanel!==state.panel)return;
      if(!outcome.sent||!outcome.verified){endConversation();if(!$('#prompt').value)$('#prompt').value=draft;status('Automatic voice stopped. '+(outcome.detail||'Saved conversation confirmation unavailable.'));}
      else if(!voiceOptions.conversation&&!voiceOptions.limitReached)status('Transcribed message sent and saved conversation read back. Microphone off.');
     }
    }catch(error){if(current()){endConversation();status((error instanceof Error?error.message:'Transcription unavailable.')+' No automatic retry was made.');}}
    finally{chunks.length=0;if(current()){state.micPending=false;state.micController=null;}}
   };
   state.capture={finish};state.micPending=false;if(voiceOptions.conversation)voiceOptions.remaining--;
   processor.onaudioprocess=event=>{
    if(!current()){void finish(true);return;}
    const room=Math.max(0,Math.floor(context.sampleRate*8)-frames),data=new Float32Array(event.inputBuffer.getChannelData(0).slice(0,room));
    if(data.length){chunks.push(data);frames+=data.length;const rms=Math.sqrt(data.reduce((sum,sample)=>sum+sample*sample,0)/data.length);if(rms>0.012){heard=true;silence=0;}else silence+=data.length/context.sampleRate;}
    if(frames>=Math.floor(context.sampleRate*8)||heard&&silence>=2)void finish(false);
   };
   timer=setTimeout(()=>void finish(false),8000);await context.resume();if(!current()){await finish(true);return;}status('Listening · Up to eight seconds · Pause two seconds or select Finish and transcribe');log('microphone','capturing');
  }catch(error){if(state.capture){await state.capture.finish(true);state.capture=null;}else{stream?.getTracks().forEach(track=>track.stop());await context?.close().catch(()=>{});}if(current()){endConversation();state.micPending=false;status(error instanceof Error?error.message:'Microphone permission is unavailable.');}}
 }
 async function voice(){
  const profiles=element('select',{},...(state.data.personalities||[]).map(value=>element('option',{value:value.id},value.name+(value.registered?'':' · not registered'))));
  section('Conversation personality',field('Profile',profiles),button('Use for this conversation',async()=>{if(!state.chat)throw new Error('Open a saved conversation first.');content.append(pre(await api('/action',{action:'personality_select',chat_id:state.chat.id,profile:profiles.value})));}),pre(state.data.voice||{configured:false}));
  const replies=element('select',{},...(state.chat?.messages||[]).filter(message=>message.role==='assistant').map(message=>element('option',{value:message.id},message.content.slice(0,100))));
  const option=(id,label,key)=>{const node=element('input',{type:'checkbox',id});node.checked=voiceOptions[key];const epoch=state.epoch,panel=state.panel;node.addEventListener('change',()=>{if(epoch!==state.epoch||panel!==state.panel)return;voiceOptions[key]=node.checked;if(key==='spoken'&&!node.checked){endConversation();stopAudio();}});return field(label,node);};
  section('Voice preferences · off at session startup',option('workspace-voice-spoken','Speak replies automatically · uses the configured provider quota','spoken'),option('workspace-voice-brief','Brief extractive speech · canonical summary mode','brief'),option('workspace-voice-auto-send','Send dictated speech automatically · skips manual transcript review','autoSend'),element('p',{},'Preferences stay in this signed-in page only. A new account starts with every option off. Microphone access still requires an explicit Dictate or Start voice conversation action.'));
  section('Listen to a saved reply',field('Assistant reply',replies),element('p',{},'Uses the configured Personality Forge provider and its quota.'),button('Listen',async()=>{if(!state.chat||!replies.value)throw new Error('Open a saved assistant reply first.');await speakReply((state.chat.messages||[]).find(message=>message.id===replies.value&&message.role==='assistant'),state.chat.id);}),button('Stop speech',async()=>{const speech=state.speech;endConversation();stopAudio();if(speech?.session_id)await api('/voice/cancel',speech);status('Playback stopped. In-flight provider work may finish; no request will be replayed.');}));
  section('Dictate into the composer',element('p',{},'Microphone off until you select Dictate and grant browser permission. Sends at most eight seconds of mono PCM audio to the configured ElevenLabs Scribe provider. The transcript stays in your composer for review unless you explicitly enable automatic sends.'),button('Dictate a message',dictate),button('Finish and transcribe',async()=>{if(state.capture)await state.capture.finish(false);else throw new Error('There is no active microphone capture.');}),button('Stop microphone',()=>{endConversation();stopCapture();status('Microphone off. Pending transcription may finish; its result will be discarded.');}));
  section('Hands-free voice conversation',element('p',{},'Explicit opt-in starts the microphone, automatically sends each transcription and speaks the saved reply. Stops after at most ten captured turns, on any uncertainty, or when this panel, account, tab visibility or page changes. Select Start again to resume.'),button('Start voice conversation · up to ten turns',async()=>{if(voiceOptions.conversation||state.capture||state.micPending)throw new Error('Stop the active microphone or voice conversation first.');voiceOptions.conversation=true;voiceOptions.remaining=10;voiceOptions.limitReached=false;try{await dictate();}catch(error){endConversation();stopAudio();throw error;}}),button('Stop voice conversation',()=>{endConversation();stopAudio();status('Voice conversation stopped. Microphone off. No pending response will restart it.');}));
 }
 async function operations(){
  if(!transport.session?.ownerAccess)throw new Error('Primary owner admission required.');
  section('Current owner observations',button('Read diagnostics',async()=>{content.append(pre(await api('/diagnostics')));}),button('Read fleet',async()=>{content.append(pre(await api('/fleet')));}),button('Read plugin status',async()=>{content.append(pre(await api('/plugins')));}));
  const query=input('Capability name or intent'),cap=input('echo.namespace.operation');
  section('SDK discovery',field('Search',query),button('Search live capability registry',async()=>{content.append(pre(await api('/action',{action:'sdk',capability:'echo.caps.search',command:'search',options:{q:query.value,limit:20}})));}),field('Exact capability',cap),button('Read exact schema',async()=>{content.append(pre(await api('/action',{action:'sdk_detail',capability:cap.value})));}));
  section('ESH · existing policy and grants',button('Open dockable ESH panel',openESH),element('p',{},'The canonical owner reads ESH status before dispatch. Review each exact command in the current conversation. Float, move or resize the panel with its labeled controls. Policy denial remains denial; ambiguous requests are never retried automatically.'));
  const service=input('Service reference'),username=input('Account reference'),secret=input('Credential value','','password');
  section('Isolated Vault credential entry',field('Service',service),field('Account',username),field('Credential',secret),button('Store credential in existing Vault',async()=>{try{await api('/action',{action:'vault',operation:'put',service:service.value,username:username.value,secret:secret.value});status('Vault operation returned. No credential value is displayed or added to the conversation.');}finally{secret.value='';}}));
 }
 let authBusy=false;
 async function auth(operation,body){if(authBusy)throw new Error('Wait for the current account request.');authBusy=true;const epoch=state.epoch,panel=state.panel;try{const value=await transport.auth(operation,body,state.controller.signal);if(epoch!==state.epoch||panel!==state.panel)throw new Error('Account view changed; response discarded.');return value;}finally{authBusy=false;}}
 let logoutBusy=false;
 async function signOut(){
  // One click, no confirmation: from the account view or from the top-bar / sidebar Sign out buttons. The identity
  // change itself (page clear + `echo-account-changed`) is driven by the transport readback, exactly as a sign-in is.
  if(logoutBusy)return;logoutBusy=true;const panel=state.panel,accountEpoch=state.accountEpoch;let revocationReturned=false;
  try{
   notify('Revoking this local session…');
   // Successful revocation intentionally invalidates identity and its UI epoch.
   // Use the transport's revocation-only proof rather than the private api wrapper.
   await transport.request('/auth/logout',{});
   revocationReturned=true;
   const session=await transport.loadSession();
   if(session?.workspaceConfigured!==true||session.authenticated!==false||session.user!==null||session.csrf!==null)throw new Error('Anonymous session readback unavailable.');
   if(panel!==state.panel)return;clearFields();content.replaceChildren();
   if(dialog.open)await account(session);// the sign-in card replaces the account view; a closed dialog stays closed
   if(panel===state.panel)notify('Signed out. Anonymous session readback verified.');log('logout','anonymous_readback_verified');
  }catch{
   // A separately admitted newer identity owns its own view; never overwrite it
   // with a late result from an older account's sign-out attempt.
   if(!revocationReturned&&transport.session?.authenticated&&accountEpoch!==state.accountEpoch)return;
   transport.clear();
   if(panel===state.panel){clearFields();content.replaceChildren();notify('Sign-out could not be confirmed. This page has been cleared. No automatic retry or account readmission was attempted. Reload to check the current session before signing in again.');}
   log('logout','unconfirmed');
  }finally{logoutBusy=false;}
 }
 // Panel status when the Workspace dialog is open; the page-level notice otherwise (top-bar / sidebar sign-out).
 function notify(text){status(text);if(!dialog.open){$('#draft-notice').textContent=text;$('#draft-notice').hidden=false;}}
 async function account(verifiedSession){
  const panel=state.panel;let session;
  try{session=verifiedSession===undefined?await transport.loadSession():verifiedSession;}
  catch{
   if(panel!==state.panel)return;clearFields();content.replaceChildren();status('Session verification is unavailable. Private content has been cleared.');
   if(transport.canLogout)section('Local session control',element('p',{},'You can ask the canonical Workspace to revoke this browser session while identity verification is unavailable.'),button('Sign out locally',signOut));
   return;
  }
  if(panel!==state.panel)return;
  if(session?.authenticated){
   const user=session.user||{},name=user.name||user.email||'Your account';
   const identity=element('div',{class:'signin-identity'},element('span',{class:'signin-avatar','aria-hidden':'true'},initialsOf(session)),element('div',{},element('h3',{},name,element('span',{class:'signin-role-badge'},roleOf(session))),user.email&&user.email!==name?element('p',{class:'signin-email'},String(user.email)):null));
   const card=element('article',{class:'signin-card signed-in'},signinBrand(),identity,element('p',{class:'signin-lead'},user.status==='approved'?'Your private Workspace is available.':'Account status: '+user.status),user.status==='pending'?element('p',{class:'signin-fine'},'The primary owner approves new accounts. Your private Workspace opens once approved.'):null,button('Sign out',signOut));
   content.append(card);
   if(session.ownerAccess){const value=await api('/auth/accounts');for(const member of (value.accounts||[]).slice(0,200)){if(member.role==='owner')continue;section(member.email||'Member account',element('p',{},'Status: '+member.status),button('Approve account',()=>decision(member,'approve')),button('Deny account',()=>decision(member,'deny')));}}
   return;
  }
  // Anonymous: one centred card. Google Identity Services renders its own button (an iframe) into `slot`; Prime only
  // owns the container, theme and width. Every state is explicit: loading, ready, unavailable, blocked, error.
  const email=input('Email or existing supported user ID'),password=input('Password','','password'),name=input('Display name');
  const slot=element('div',{class:'signin-google-slot'}),googleStatus=element('p',{class:'signin-google-status',role:'status'}),googleWrap=element('div',{class:'signin-google','data-state':'loading'},slot,googleStatus);
  const retry=button('Retry Google sign-in',()=>google());retry.hidden=true;googleWrap.append(retry);
  const alt=element('details',{class:'signin-alt'},element('summary',{},'Use email or an existing account instead'),field('Email / user ID',email),field('Password',password),button('Sign in',async()=>{const body={email:email.value.trim(),password:password.value};password.value='';try{await auth('login',body);await accountRefresh();}finally{body.password='';password.value='';}}),field('Display name · new accounts',name),button('Create account',async()=>{const body={email:email.value.trim(),password:password.value,display_name:name.value};password.value='';try{const result=await auth('signup',body);status(result.message||'Signup returned. Verify your email and wait for owner approval.');}finally{body.password='';password.value='';}}),button('Request password recovery',async()=>{status((await auth('reset',{email:email.value.trim()})).message||'Recovery request returned.');}));
  const intent=accountIntent;accountIntent=null;const signup=intent==='signup';
  const card=element('article',{class:'signin-card','data-intent':signup?'signup':false},signinBrand(),element('h3',{},signup?'Request access to Echo Prime':'Sign in to Echo Prime'),element('p',{class:'signin-lead'},signup?'Continue with Google or create an account below. The primary owner approves each new member before the private Workspace opens.':'One sign-in opens your private Workspace: saved conversations, projects, files and memories, on every device.'),googleWrap,
   element('div',{class:'signin-roles'},element('div',{class:'signin-role'},element('strong',{},'Members'),'A private Workspace of your own. Nothing is shared with other accounts.'),element('div',{class:'signin-role'},element('strong',{},'Primary owner'),'Also operates the fleet: SDK, Vault, ESH shell, logs and node Stewards.')),
   alt,element('p',{class:'signin-fine'},'New accounts wait for owner approval. ',element('a',{href:'/privacy.html'},'Privacy'),' · No password or token is kept in this browser.'));
  if(signup){alt.open=true;}
  content.append(card);
  if(signup)email.focus();
  let timer=null;
  const setState=(value,text)=>{if(panel!==state.panel||!card.isConnected)return;googleWrap.setAttribute('data-state',value);googleStatus.textContent=text||'';retry.hidden=!(value==='blocked'||value==='error');if(value==='unavailable'||value==='blocked'||value==='error')alt.open=true;};
  async function google(){
   clearTimeout(timer);setState('loading','Preparing Google sign-in…');
   let config;
   try{config=await auth('config');}
   catch{if(panel===state.panel)status('Google configuration is unavailable. No alternate identity provider was selected.');setState('error','Google sign-in configuration is unavailable. Use email or an existing account below.');return;}
   if(panel!==state.panel||!card.isConnected)return;
   if(!config.google_login_enabled||typeof config.google_client_id!=='string'){setState('unavailable','Google sign-in is not enabled on this Workspace. Use email or an existing account below.');return;}
   const render=()=>{
    clearTimeout(timer);if(panel!==state.panel||!dialog.open||!slot.isConnected)return;
    if(!window.google?.accounts?.id){setState('blocked','Google’s identity library did not load. A content blocker or tracking protection may be blocking accounts.google.com; allow it, then retry.');return;}
    try{
     window.google.accounts.id.initialize({client_id:config.google_client_id,auto_select:false,callback:async result=>{if(panel!==state.panel||!dialog.open||!slot.isConnected){result.credential='';return;}setState('loading','Signing you in…');try{await auth('login',{provider:'google',id_token:result.credential});await accountRefresh();}catch(error){if(panel===state.panel){status(error.message);setState('error',error.message);}}finally{result.credential='';}}});
     slot.replaceChildren();window.google.accounts.id.renderButton(slot,googleButtonOptions(slot));
     setState('ready','If no Google window opens, allow pop-ups for this site and select the button again.');
    }catch(error){setState('blocked','Google sign-in could not render ('+(error instanceof Error?error.message:'unknown error')+'). Allow accounts.google.com and pop-ups, then retry.');}
   };
   if(window.google?.accounts?.id){render();return;}
   let script=document.querySelector('script[data-prime-google]');
   if(script&&script.dataset.primeGoogleState==='failed'){if(typeof script.remove==='function')script.remove();script=null;}
   if(!script){script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.dataset.primeGoogle='1';document.head.append(script);}
   script.addEventListener('load',render,{once:true});
   script.addEventListener('error',()=>{script.dataset.primeGoogleState='failed';clearTimeout(timer);if(panel!==state.panel)return;status('Google sign-in script is unavailable. Use an existing supported account route.');setState('blocked','The browser blocked Google’s sign-in script (tracking protection, a content blocker or no network). Allow accounts.google.com, then retry. Email sign-in still works.');},{once:true});
   timer=setTimeout(()=>{if(panel!==state.panel||googleWrap.getAttribute('data-state')!=='loading')return;setState('blocked','Google’s sign-in script has not loaded after 8 seconds. It may be blocked; allow accounts.google.com and retry, or use email below.');},8000);
  }
  void google();
 }
 // Sign-in card helpers. The GIS button is sized to its container (GIS accepts 200–400 px) and themed for the page.
 function googleButtonOptions(slot){const measured=Number(slot?.clientWidth)||0;return {type:'standard',theme:document.documentElement?.dataset?.theme==='light'?'outline':'filled_black',size:'large',shape:'pill',text:'continue_with',logo_alignment:'left',width:Math.max(200,Math.min(400,measured||320))};}
 function signinBrand(){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','echo-mark');svg.setAttribute('aria-hidden','true');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-echo-mark');svg.append(use);return element('div',{class:'signin-brand'},svg,element('span',{class:'wordmark-text','data-text':'ECHO PRIME'},'ECHO PRIME'));}
 function initialsOf(session){const base=String(session?.user?.name||session?.user?.email||'').trim();const parts=base.split(/[\s@._-]+/).filter(Boolean);const text=((parts[0]?.[0]||'')+(parts[1]?.[0]||parts[0]?.[1]||'')).toUpperCase();return text||'EP';}
 function roleOf(session){if(session?.ownerAccess===true)return 'Owner';if(session?.user?.status==='pending')return 'Pending';return 'Member';}
 function decision(user,choice){clearFields();content.replaceChildren(card('Review account decision',element('p',{},`${choice==='approve'?'Approve':'Deny'} ${user.email||user.uid}?`),element('p',{},'Exact account: '+user.uid),button('Confirm this account decision',async()=>{const receipt=await api('/auth/decide',{uid:user.uid,decision:choice});await open('account');status('Account decision returned: '+(receipt.user?.status||'read the current account status above')+'.');}),button('Cancel',()=>open('account'))));}
 async function accountRefresh(){
  const session=await transport.loadSession();if(session?.authenticated&&session.user.status==='approved')await refresh();await open('account');
 }
 async function open(view){
  await ready;state.panel++;clearFields();endConversation();stopAudio();content.replaceChildren();status('');$('#workspace-panel-title').textContent=({projects:'Projects',library:'Files & journals',memory:'Memory',plugins:'MCP connections',voice:'Voice & personality',operations:'Tools & diagnostics',account:'Your account'})[view]||'Your Workspace';
  if(!dialog.open)dialog.showModal();
  if(!state.enabled){status('A reviewed authenticated Workspace backend is not configured for this local Prime host.');return;}
  const epoch=state.epoch,panel=state.panel;
  try{if(view!=='account'){await refresh();if(epoch!==state.epoch||panel!==state.panel)return;}await ({projects,library,memory,plugins,voice,operations,account}[view]||account)();}catch(error){if(epoch===state.epoch&&panel===state.panel)status(error.message);}
 }
 async function ownerHeaders(){
  await ready;if(!state.enabled)return {};
  const previous=transport.session?.user?.uid;let session;try{session=await transport.loadSession();}catch{throw new Error('Current account admission unavailable.');}
  if(previous&&previous!==session?.user?.uid)throw new Error('Account changed. Review your request again.');
  if(!session?.ownerAccess)throw new Error('Primary owner admission required.');return transport.headers();
 }
 all('[data-workspace-view]').forEach(node=>node.addEventListener('click',()=>void open(node.dataset.workspaceView)));
 dialog.addEventListener('close',()=>{state.panel++;clearFields();endConversation();stopAudio();});
 $('#workspace-chat-kind').addEventListener('change',()=>{state.epoch++;state.turn?.abort();state.turn=null;endConversation();stopAudio();window.EchoPrimeChat.reset();$('#prompt').value='';$('#draft-notice').hidden=true;if($('#workspace-chat-kind').value==='workspace')renderChat();});
 $('#workspace-project').addEventListener('change',()=>{const epoch=state.epoch;if(state.chat)void api('/chat/update',{chat_id:state.chat.id,title:state.chat.title,project_id:$('#workspace-project').value||null}).then(chat=>{if(epoch===state.epoch)state.chat=chat;}).catch(error=>{if(epoch===state.epoch)status(error.message);});});
 $('#workspace-rename').addEventListener('click',()=>{if(!state.chat)return;content.replaceChildren();const title=input('Conversation title',state.chat.title);content.append(field('Title',title),button('Save title',async()=>{state.chat=await api('/chat/update',{chat_id:state.chat.id,title:title.value,project_id:state.chat.project_id});await refresh();renderChat();dialog.close();}));$('#workspace-panel-title').textContent='Rename conversation';if(!dialog.open)dialog.showModal();});
 for(const [id,path] of [['workspace-compact','compact'],['workspace-fork','fork']])$('#'+id).addEventListener('click',async()=>{try{if(!state.chat||state.turn)throw new Error('Open an idle saved conversation first.');const result=await api('/'+path,{chat_id:state.chat.id});await openChat(result.id||state.chat.id);await refresh();}catch(error){$('#draft-notice').textContent=error.message;$('#draft-notice').hidden=false;}});
 $('#workspace-journal').addEventListener('click',()=>void journal().catch(error=>status(error.message)));
 $('#prompt').addEventListener('input',updateContext);
 let searchTimer,searchRevision=0;
 $('#workspace-chat-search').addEventListener('input',()=>{clearTimeout(searchTimer);const epoch=state.epoch,revision=++searchRevision;searchTimer=setTimeout(()=>{if(epoch!==state.epoch||revision!==searchRevision)return;void api('/chats?q='+encodeURIComponent($('#workspace-chat-search').value)).then(rows=>{if(epoch===state.epoch&&revision===searchRevision)renderHistory(rows);}).catch(error=>{if(epoch===state.epoch&&revision===searchRevision){$('#draft-notice').textContent=error.message;$('#draft-notice').hidden=false;}});},200);});
 $('#stop-chat').addEventListener('click',()=>{state.turn?.abort();endConversation();stopAudio();});
 $('#voice-button').addEventListener('click',()=>{if(state.enabled)void open('voice');});
 window.addEventListener('pagehide',()=>{transport.clear();if(dialog.open)dialog.close();});
 window.addEventListener('pageshow',event=>{if(event.persisted&&state.enabled)void transport.loadSession().then(session=>{if(session?.authenticated&&session.user.status==='approved')return refresh();}).catch(()=>{});});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){endConversation();stopAudio();}else if(state.enabled)void transport.loadSession().catch(()=>{});});
 const ready=(async()=>{
  try{
   const session=await transport.loadSession();state.enabled=session?.workspaceConfigured===true;identityChanged(session);
   if(state.enabled){$('#workspace-navigation').hidden=false;$('#workspace-search-label').hidden=false;$('#clear-history').hidden=true;$('#workspace-conversation-controls').hidden=false;$('#composer').before($('#workspace-conversation-controls'));if(session.authenticated&&session.user.status==='approved')await refresh();else{$('#draft-notice').textContent='Sign in to your private Workspace to converse with Echo.';$('#draft-notice').hidden=false;}}
   return state.enabled;
  }catch{status('Workspace connection is unavailable. No automatic retry or alternate account was used.');return false;}
 })();
 // Narrow facade for the composer, voice bar and plugins view. It deliberately
 // omits the CSRF proof, transport and request headers.
 async function haltSpeech(){const speech=state.speech;stopAudio();if(speech?.session_id)await api('/voice/cancel',speech);}
 const bridge=Object.freeze({state,voiceOptions,get session(){return transport.session;},api,refresh,openChat,updateContext,dictate,speakReply,stopAudio,endConversation,
  onStatus(hook){if(typeof hook==='function')statusHooks.push(hook);},
  setChat(chat){if(chat&&chat.id&&chat.id===state.chat?.id){state.chat=chat;renderChat();}},
  async startConversation(){if(voiceOptions.conversation||state.capture||state.micPending)throw new Error('Stop the active microphone or voice conversation first.');voiceOptions.conversation=true;voiceOptions.remaining=10;voiceOptions.limitReached=false;try{await dictate();}catch(error){endConversation();stopAudio();throw error;}},
  async stopVoice(){endConversation();try{await haltSpeech();}finally{status('Voice stopped. Microphone off. No pending response will restart it.');}},
  async interrupt(){try{await haltSpeech();}catch{}await dictate();}});
 // `session` is the cached /api/session readback (null once cleared). Modules gate owner-only requests on it without
 // another request; `ownerHeaders()` is the path that re-reads the session.
 window.EchoPrimeWorkspace={ready,bridge,get enabled(){return state.enabled;},get session(){return transport.session;},get generalMode(){return state.enabled&&$('#workspace-chat-kind').value==='workspace';},send,newChat,open,ownerHeaders,invalidate(){transport.clear();},cancel(){state.turn?.abort();}};
})();
