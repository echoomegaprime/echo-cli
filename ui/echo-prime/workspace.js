(() => {
 'use strict';
 const $=selector=>document.querySelector(selector),all=selector=>[...document.querySelectorAll(selector)];
 const state={enabled:false,data:null,chat:null,view:'chats',attachments:new Set(),epoch:0,accountEpoch:0,panel:0,voiceEpoch:0,micEpoch:0,micPending:false,capture:null,micController:null,turn:null,controller:new AbortController(),audio:null,audioUrl:null,audioDone:null,speech:null};
 const voiceOptions={spoken:false,brief:false,autoSend:false,conversation:false,remaining:0,limitReached:false};let listenTimer,captureSeconds=8,composerUi,viewUi,navigationGeneration=0,startupComplete=false;
 const dialog=$('#workspace-dialog'),content=$('#workspace-panel-content'),notice=$('#workspace-panel-status');
 const esh={generation:0,rows:new Map(),review:null,busy:false,floating:false,rect:{x:280,y:90,width:640,height:430}};let eshUi;
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
 function status(text){notice.textContent=text;if(composerUi)composerUi.notice.textContent=text||voiceDescription();}
 function log(operation,outcome){console.debug('[echo.workspace]',{schema_version:1,event:'workspace_operation',operation,outcome});}
 function button(label,action,className='quiet-button',panelScoped=true){
  const node=element('button',{type:'button',class:className},label),epoch=state.epoch,accountEpoch=state.accountEpoch,panel=state.panel;
  const current=()=>accountEpoch===state.accountEpoch&&(!panelScoped||epoch===state.epoch&&panel===state.panel);
  node.addEventListener('click',async()=>{if(node.disabled||!node.isConnected||!current())return;node.disabled=true;try{await action();}catch(error){if(current()){status(error instanceof Error?error.message:'Workspace operation failed. No automatic retry was made.');log('panel_action','failed');}}finally{node.disabled=false;}});return node;
 }
 const card=(title,...children)=>element('article',{class:'workspace-card-content'},element('h3',{},String(title)),...children);
 function emit(name,detail){window.dispatchEvent(Object.assign(new Event(name),{detail}));}
 const pageDefinitions={projects:{title:'Projects',subtitle:'Instructions, saved conversations and focused work for each project.'},library:{title:'Library',subtitle:'Private files, notes, downloads and conversation imports for your account.'},plugins:{title:'Plugins & memory',subtitle:'Manage your connections, preferences and verified memory receipts.'},memory:{title:'Memory',subtitle:'Review private preferences and the admitted memory connections for your account.'},sdk:{title:'SDK',subtitle:'Search capabilities, inspect current schemas and review each exact request.',ownerOnly:true},vault:{title:'Vault',subtitle:'Manage admitted service references. Credential values stay inside the existing Vault.',ownerOnly:true},review:{title:'Code review',subtitle:'Review a chosen file or pasted code with the relevant project context.'},operations:{title:'Tools & diagnostics',subtitle:'Current owner observations, capability discovery and governed ESH receipts.',ownerOnly:true}};
 function activeNavigation(){const view=state.view==='memory'?'plugins':state.view;for(const node of all('.nav-item')){const active=node.dataset.workspaceView===view||node.dataset.view==='conversation'&&view==='chats';node.classList.toggle('active',active);node.setAttribute('aria-current',active?'page':'false');}}
 function ensureMainView(){
  if(viewUi)return;const host=element('section',{id:'workspace-main-view',class:'workspace-main-view','aria-labelledby':'workspace-view-title'}),title=element('h1',{id:'workspace-view-title',tabindex:'-1'}),subtitle=element('p',{id:'workspace-view-subtitle',class:'workspace-view-subtitle'}),back=element('button',{id:'workspace-view-back',type:'button',class:'quiet-button'},'← Back to conversation'),body=element('div',{class:'workspace-view-body'});host.hidden=true;back.addEventListener('click',()=>showConversation());host.append(element('header',{class:'workspace-view-header'},back,title,subtitle),body);$('main').append(host);viewUi={host,title,subtitle,body,id:null};
 }
 function showConversation(clear=true,invalidate=true){
  if(invalidate)navigationGeneration++;if(!viewUi)return;const wasOpen=!viewUi.host.hidden;viewUi.host.hidden=true;viewUi.id=null;state.view='chats';$('.workspace-body').hidden=false;$('.workspace-body').inert=false;if(clear&&wasOpen){state.panel++;clearFields();content.replaceChildren();viewUi.title.textContent='';viewUi.subtitle.textContent='';status('');endConversation();stopAudio();}$('#conversation-title').textContent=state.chat?.title||'New conversation';activeNavigation();if(wasOpen){log('workspace_view','conversation_restored');emit('echo-workspace-view',{view:'chats'});}
 }
 function beginViewNavigation(){return {generation:++navigationGeneration,epoch:state.epoch,accountEpoch:state.accountEpoch,uid:transport.session?.user?.uid||null,bootstrap:!startupComplete};}
 function currentViewNavigation(intent,rebase=false){
  if(intent.generation!==navigationGeneration)return false;const uid=transport.session?.user?.uid||null;
  // The first session load establishes initial account telemetry. It may be
  // awaited by the first navigation, but never by an intent for another UID.
  if(intent.bootstrap&&rebase){if(intent.uid&&intent.uid!==uid)return false;intent.epoch=state.epoch;intent.accountEpoch=state.accountEpoch;intent.uid=uid;intent.bootstrap=false;}
  return !intent.bootstrap&&intent.epoch===state.epoch&&intent.accountEpoch===state.accountEpoch&&intent.uid===uid;
 }
 function staleView(){log('workspace_view','admission_superseded');const body=element('div'),node=element('p');body.inert=true;return {body,status:node,isCurrent:()=>false,setStatus:()=>{},close:()=>{}};}
 async function presentView(options,intent){
  if(!options||typeof options.id!=='string'||!/^[a-z][a-z0-9_-]{0,59}$/.test(options.id))throw new Error('Invalid Workspace page.');const navigation=intent||beginViewNavigation();await ready;if(!currentViewNavigation(navigation,true))return staleView();if(!state.enabled)throw new Error('An authenticated Workspace backend is not configured.');
  if(options.ownerOnly){try{await ownerHeaders();}catch(error){if(!currentViewNavigation(navigation))return staleView();throw error;}if(!currentViewNavigation(navigation))return staleView();}
  ensureMainView();if(dialog.open)dialog.close();state.panel++;clearFields();endConversation();stopAudio();content.replaceChildren();status('');viewUi.body.append(notice,content);viewUi.id=options.id;state.view=options.id;viewUi.title.textContent=String(options.title||'Your Workspace').slice(0,120);viewUi.subtitle.textContent=String(options.subtitle||'Your private Workspace.').slice(0,500);$('#workspace-panel-title').textContent=viewUi.title.textContent;$('#conversation-title').textContent=viewUi.title.textContent;$('.workspace-body').hidden=true;$('.workspace-body').inert=true;viewUi.host.hidden=false;activeNavigation();const epoch=state.epoch,accountEpoch=state.accountEpoch,panel=state.panel,id=options.id,current=()=>currentViewNavigation(navigation)&&epoch===state.epoch&&accountEpoch===state.accountEpoch&&panel===state.panel&&viewUi.id===id&&!viewUi.host.hidden;log('workspace_view','page_opened');emit('echo-workspace-view',{view:id});return {body:content,status:notice,isCurrent:current,setStatus:text=>{if(current())status(String(text));},close:()=>{if(current())showConversation();}};
 }
 function modalContent(){showConversation();dialog.append(notice,content);}
 function safeReceipt(value,depth=0){
  if(depth>6)return '[nested receipt]';if(typeof value==='string')return value.slice(0,4000).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [redacted]');if(Array.isArray(value))return value.slice(0,80).map(item=>safeReceipt(item,depth+1));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,80).map(([key,item])=>[key,/(?:secret|token|password|credential|authorization|cookie|api.?key)/i.test(key)?'[redacted]':safeReceipt(item,depth+1)]));return value;
 }
 function receiptCard(title,value){const safe=safeReceipt(value),summary=safe?.ok===false||safe?.error?'Needs attention · inspect the returned receipt':typeof safe?.status==='string'?safe.status:Number.isFinite(safe?.count)?`${safe.count} records returned`:'Receipt returned · verify its postcondition';return card(title,element('p',{},summary),element('details',{},element('summary',{},'Receipt metadata'),pre(safe)));}
 function activityCard(event){
  const kind=event.kind||event.type;if(!['tool_started','tool_result','action_receipt','action_failed'].includes(kind))return null;let data=event;try{if(typeof event.content==='string')data=JSON.parse(event.content);}catch{return null;}if(!data||typeof data!=='object')return null;
  const tool=String(data.tool||data.action||data.request?.action||'Tool').slice(0,100),outcome=kind==='tool_started'?'started':kind==='action_failed'?'outcome unconfirmed':data.result?.ok===false||data.result?.error?'needs attention':data.result?.verdict==='gated'?'gated':'receipt returned',node=receiptCard(`${tool} · ${outcome}`,{request_id:data.request_id||data.request?.request_id,arguments:data.arguments||data.request,result:data.result});node.className+=' workspace-activity-card';return node;
 }
 function updateComposerLimit(){$('#prompt').setAttribute('maxlength',state.enabled&&$('#workspace-chat-kind').value==='workspace'?'100000':'12000');}
 function navigationIntent(value){if(!value||typeof value!=='object')return null;if(value.action==='open_chat'&&typeof value.id==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value.id))return {action:'open_chat',id:value.id};if(value.action==='navigate'&&['chats','projects','library','plugins','sdk','vault','review','media','diagnostics'].includes(value.view))return {action:'navigate',view:value.view};return null;}
 async function applyNavigation(value,epoch,accountEpoch){
  if(!value||epoch!==state.epoch||accountEpoch!==state.accountEpoch)return;if(value.action==='open_chat'){await openChat(value.id);log('tool_navigation','saved_chat_opened');return;}
  if(['sdk','vault','diagnostics','media'].includes(value.view)&&!transport.session?.ownerAccess)throw new Error('Primary owner admission is required for that view.');
  if(value.view==='chats'){if(dialog.open)dialog.close();showConversation();renderChat();}else if(value.view==='media'){if(!window.EchoPrimeStudio?.open)throw new Error('Creative Studio is unavailable.');window.EchoPrimeStudio.open('all');}else await open(value.view==='diagnostics'?'operations':value.view);log('tool_navigation','view_opened');
 }
 function voiceDescription(){const voice=state.data?.voice;return voice?.configured?`${voice.voice||voice.name||'Configured voice'} · ${voice.provider||'Personality Forge'} · ${state.capture?'Microphone on':state.micPending?'Transcription pending':'Microphone off'}`:'Voice connection needed · Microphone off';}
 function ensureComposer(){
  if(composerUi)return;
  const tools=element('div',{id:'workspace-composer-tools',class:'workspace-composer-tools'}),chips=element('div',{id:'workspace-attachment-chips',class:'workspace-attachment-chips','aria-label':'Attached library files'}),meter=element('progress',{id:'workspace-context-meter',max:100,value:0,'aria-label':'Context capacity used'}),voice=element('section',{id:'workspace-voice-bar',class:'workspace-voice-bar','aria-label':'Voice controls'}),voiceNotice=element('p',{id:'workspace-voice-status',role:'status','aria-live':'polite'});
  $('#composer').append(tools,chips);$('#workspace-context').append(meter);$('.composer-wrap').append(voice);
  composerUi={tools,chips,meter,voice,notice:voiceNotice,nav:element('div',{id:'workspace-parity-nav'}),checkpoint:element('details',{id:'workspace-checkpoint',class:'workspace-checkpoint'})};$('#workspace-navigation').append(composerUi.nav);$('#workspace-conversation-controls').append(composerUi.checkpoint);
 }
 function selectedPersonality(){for(const event of [...(state.chat?.events||[])].reverse())if((event.kind||event.type)==='personality_selected'&&typeof event.content==='string')return event.content;return 'auto';}
 function personalityControl(){
  const profiles=state.data?.personalities||[],select=element('select',{id:'workspace-personality','aria-label':'Conversation personality'},...profiles.map(profile=>element('option',{value:profile.id},String(profile.name||profile.id)+(profile.registered?'':' · not registered')))),epoch=state.epoch,chatId=state.chat?.id;select.value=selectedPersonality();select.disabled=!chatId||!profiles.length;
  select.addEventListener('change',async()=>{
   if(epoch!==state.epoch||state.chat?.id!==chatId||!select.isConnected||state.turn)return;const profile=select.value;if(!profiles.some(item=>item.id===profile))return;select.disabled=true;
   try{const receipt=await api('/action',{action:'personality_select',chat_id:chatId,profile});if(receipt.profile!==profile||receipt.permissions_changed!==false)throw new Error('Personality change returned without the expected permission-preserving receipt.');const readback=await api('/chats/'+encodeURIComponent(chatId));if(epoch!==state.epoch)return;const event=[...(readback.events||[])].reverse().find(item=>(item.kind||item.type)==='personality_selected');if(event?.content!==profile)throw new Error('Personality change returned; saved selection readback is unconfirmed.');state.chat=readback;renderChat();status('Personality saved and read back. Permissions are unchanged.');log('personality_select','saved_and_read_back');}
   catch(error){if(epoch===state.epoch){select.value=selectedPersonality();status(error instanceof Error?error.message:'Personality selection was not confirmed.');log('personality_select','unconfirmed');}}
   finally{if(epoch===state.epoch)select.disabled=!state.chat;}
  });composerUi.personality=select;return field('Personality',select);
 }
 function voiceToggle(label,key){const toggle=element('input',{type:'checkbox'}),epoch=state.accountEpoch;toggle.checked=voiceOptions[key];toggle.addEventListener('change',()=>{if(epoch!==state.accountEpoch)return;voiceOptions[key]=toggle.checked;if(key==='spoken'&&!toggle.checked){endConversation();stopAudio();}log('voice_preference',key+'_'+String(toggle.checked));});return field(label,toggle);}
 async function startVoiceConversation(){if(voiceOptions.conversation||state.capture||state.micPending)throw new Error('Stop the active microphone or voice conversation first.');voiceOptions.conversation=true;voiceOptions.remaining=10;voiceOptions.limitReached=false;try{await dictate();}catch(error){endConversation();stopAudio();throw error;}}
 async function stopVoice(){const speech=state.speech;endConversation();stopAudio();if(speech?.session_id)await api('/voice/cancel',speech);status('Voice stopped. Microphone off. In-flight provider work may finish; no request is replayed.');}
 async function interruptAndSpeak(){state.turn?.abort();await stopVoice();if(!state.chat)await newChat();await dictate();}
 function renderComposer(){
  ensureComposer();updateComposerLimit();composerUi.tools.hidden=!state.enabled;composerUi.chips.hidden=!state.enabled;
  const memoryLabel=state.data?.memory_mode==='automatic'?'◈ Memory · automatic':'◈ Private preferences';
  composerUi.tools.replaceChildren(button('Attach',()=>open('library'),'quiet-button',false),button(memoryLabel,()=>open('plugins'),'workspace-memory-chip',false),personalityControl());
  composerUi.nav.replaceChildren(...[['sdk','SDK',true],['vault','Vault',true],['review','Code review',false]].map(([view,label,owner])=>{const node=button(label,()=>open(view),'nav-item',false);node.setAttribute('data-workspace-view',view);if(owner){node.setAttribute('data-owner-only','');node.hidden=!transport.session?.ownerAccess;}return node;}));
  all('[data-workspace-view="plugins"]').forEach(node=>{node.textContent='Plugins & memory';});all('[data-workspace-view="memory"]').forEach(node=>{node.hidden=true;});all('[data-workspace-view="library"]').forEach(node=>{node.textContent='Library';});
  composerUi.voice.hidden=!state.enabled||!state.data?.voice?.configured||!transport.session?.authenticated;
  const duration=element('select',{id:'workspace-capture-duration','aria-label':'Maximum microphone capture duration'},...[8,30,60,120].map(seconds=>element('option',{value:seconds},`${seconds} seconds`)));duration.value=String(captureSeconds);const accountEpoch=state.accountEpoch;duration.addEventListener('change',()=>{if(accountEpoch!==state.accountEpoch)return;const value=Number(duration.value);if([8,30,60,120].includes(value)){captureSeconds=value;log('microphone_duration',String(value));}});
  const actions=element('div',{class:'workspace-voice-actions'});
  const dictateButton=button('Dictate',dictate,'quiet-button',false);dictateButton.setAttribute('id','workspace-voice-dictate');const finishButton=button('Finish and transcribe',async()=>{if(state.capture)await state.capture.finish(false);else throw new Error('There is no active microphone capture.');},'quiet-button',false);finishButton.setAttribute('id','workspace-voice-finish');
  actions.append(dictateButton,finishButton,button('Interrupt & speak',interruptAndSpeak,'quiet-button',false),button('Stop voice',stopVoice,'quiet-button',false),button('Start voice conversation · up to ten turns',startVoiceConversation,'quiet-button',false));
  composerUi.voice.replaceChildren(element('strong',{},'Voice & personality'),actions,element('div',{class:'workspace-voice-options'},voiceToggle('Spoken replies','spoken'),voiceToggle('Brief speech','brief'),voiceToggle('Send speech automatically','autoSend'),field('Capture limit · 8-second request segments',duration)),composerUi.notice,element('small',{},'Voice starts off each session. Microphone access starts only after an explicit action. Automatic conversations stop after ten turns.'));
  composerUi.notice.textContent=voiceDescription();updateContext();activeNavigation();
 }
 async function api(path,body){const epoch=state.epoch,panel=state.panel,value=await transport.request(path,body,state.controller.signal);if(epoch!==state.epoch||panel!==state.panel)throw new Error('Workspace view changed; response discarded.');return value;}
 function clearPasswords(){all('#workspace-dialog input[type="password"], #workspace-panel-content input[type="password"]').forEach(node=>{node.value='';});}
 function clearFields(){all('#workspace-dialog input, #workspace-dialog textarea, #workspace-panel-content input, #workspace-panel-content textarea').forEach(node=>{node.value='';});}
 function releaseAudio(){state.audioDone?.(false);state.audioDone=null;state.audio?.pause();state.audio=null;if(state.audioUrl)URL.revokeObjectURL(state.audioUrl);state.audioUrl=null;}
 function endConversation(){voiceOptions.conversation=false;voiceOptions.remaining=0;voiceOptions.limitReached=false;clearTimeout(listenTimer);}
 function stopCapture(){state.micEpoch++;state.micController?.abort();state.micController=null;state.micPending=false;void state.capture?.finish(true);state.capture=null;}
 function stopAudio(){state.voiceEpoch++;releaseAudio();state.speech=null;stopCapture();}
 function clearConversation(invalidate=true){
  showConversation(true,invalidate);
  state.epoch++;state.turn?.abort();state.turn=null;state.chat=null;state.attachments.clear();endConversation();stopAudio();
  $('#chat-log').replaceChildren();$('#chat-log').hidden=true;$('#welcome').hidden=false;$('#prompt').value='';$('#conversation-title').textContent='New conversation';$('#draft-notice').hidden=true;setBusy(false);updateContext();
  clearESH();
 }
 function identityChanged(session){
  state.accountEpoch++;
  state.controller.abort();state.controller=new AbortController();clearFields();content.replaceChildren();status('');state.data=null;clearConversation(startupComplete);
  voiceOptions.spoken=false;voiceOptions.brief=false;voiceOptions.autoSend=false;
  $('#workspace-chat-search').value='';$('#workspace-project').replaceChildren(element('option',{value:''},'No project'));
  window.EchoPrimeChat?.reset();$('#history').replaceChildren();
  window.dispatchEvent(new Event('echo-account-changed'));
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
  }
  captureSeconds=8;renderComposer();
 }
 function setBusy(value){$('#composer .send').disabled=value;$('#stop-chat').hidden=!value;$('#chat-log').setAttribute('aria-busy',String(value));}
 function updateContext(){
  ensureComposer();const events=[...(state.chat?.events||[])].reverse(),messages=state.chat?.messages||[],parse=event=>{try{return typeof event?.content==='string'?JSON.parse(event.content):event?.content;}catch{return null;}},identityEvent=events.find(event=>(event.kind||event.type)==='model_identity'),identity=parse(identityEvent),latestUsage=parse(events.find(event=>(event.kind||event.type)==='model_usage')),reply=[...messages].reverse().find(message=>message.role==='assistant'),requestEvent=events.find(event=>['context','request_failed'].includes(event.kind||event.type)),latestRequest=parse(requestEvent);
  const request=typeof reply?.request_id==='string'?reply.request_id.replace(/:reply$/,''):null,latestProvider=latestRequest?.provider||latestRequest?.model_provider,failed=(requestEvent?.kind||requestEvent?.type)==='request_failed',validIdentity=identity&&typeof identity.request_id==='string'&&['qwen','claude','gpt','grok'].includes(identity.provider)&&(!request||identity.request_id===request)&&(!latestRequest?.request_id||latestRequest.request_id===identity.request_id)&&(!latestProvider||latestProvider===identity.provider),matchedUsage=validIdentity&&latestUsage?.request_id===identity.request_id&&latestUsage?.provider===identity.provider,managed=validIdentity&&identity.provider!=='qwen'||matchedUsage&&(latestUsage?.context_measurement==='provider_managed'||latestUsage?.provider_managed===true);
  let label='',percent=0,capacity=0,used=0,kind='estimate';
  if(failed)label='Latest request did not complete · context usage unavailable';
  else if(managed)label='Provider-managed context · capacity and usage not reported';
  else if(identityEvent||reply){
   if(validIdentity&&identity.provider==='qwen'&&matchedUsage&&Number.isFinite(latestUsage.prompt_tokens)&&latestUsage.prompt_tokens>=0&&Number.isFinite(latestUsage.context_length)&&latestUsage.context_length>0){capacity=latestUsage.context_length;used=latestUsage.prompt_tokens;kind='last measured prompt';}
   else label='Context usage unavailable for the latest request';
  }else{capacity=Number(state.data?.context_length)||0;used=Math.ceil((messages.reduce((n,m)=>n+(typeof m.content==='string'?m.content.length:0),0)+(Number(state.data?.base_context_chars)||0)+$('#prompt').value.length)/4);}
  if(capacity>0){percent=Math.min(100,Math.max(0,100*used/capacity));label=`${used.toLocaleString()} / ${capacity.toLocaleString()} tokens · ${percent.toFixed(1)}% · ${kind}`;}
  $('#workspace-context').textContent=label;composerUi.meter.hidden=capacity<=0;composerUi.meter.value=percent;$('#workspace-context').append(composerUi.meter);
  $('#workspace-attachments').textContent=state.attachments.size?`${state.attachments.size} attached files`:'';
  composerUi.chips.replaceChildren(...[...state.attachments].map(id=>{const name=(state.data?.library||[]).find(item=>item.id===id)?.name||'Library file';return element('span',{class:'workspace-attachment-chip'},String(name),button('Remove '+name,()=>{state.attachments.delete(id);updateContext();},'quiet-button',false));}));
  if(composerUi.personality)composerUi.personality.value=selectedPersonality();const summary=state.chat?.summary;composerUi.checkpoint.hidden=!state.enabled||typeof summary!=='string'||!summary.trim();composerUi.checkpoint.replaceChildren();if(!composerUi.checkpoint.hidden)composerUi.checkpoint.append(element('summary',{},'Continuation checkpoint · original messages remain saved'),pre(summary.slice(0,12000)),...(summary.length>12000?[element('p',{},'Preview limited to 12,000 characters. Download the complete saved checkpoint.')]:[]),button('Download checkpoint',()=>saveText('conversation-checkpoint.md',summary),'quiet-button',false));
 }
 function renderMessageBody(text){
  const body=element('div',{class:'workspace-message-body'}),pattern=/```([\w.+-]*)[^\n]*\n([\s\S]*?)```/g;let offset=0,match;
  while((match=pattern.exec(text))){if(match.index>offset)body.append(element('p',{},text.slice(offset,match.index)));const code=match[2],language=match[1]||'text';body.append(element('div',{class:'workspace-code-block'},element('span',{},language),element('pre',{},element('code',{},code)),button('Save file',()=>saveText('echo-code.'+({javascript:'js',typescript:'ts',python:'py',powershell:'ps1',text:'txt'}[language]||language.replace(/[^a-z0-9]/gi,'').slice(0,12)||'txt'),code),'quiet-button',false)));offset=pattern.lastIndex;}
  if(offset<text.length||!body.children.length)body.append(element('p',{},text.slice(offset)));return body;
 }
 async function saveMessage(message){
  if(!state.chat||typeof message.content!=='string')throw new Error('Open a saved message first.');if(message.content.length>100000)throw new Error('Library entries support at most 100,000 characters. Download the message or save a smaller selection.');const epoch=state.epoch,name=safeFilename(`${String(state.chat.title||'conversation').slice(0,100)}-${message.role||'message'}.md`),item=await api('/library',{name,content:message.content,chat_id:state.chat.id,project_id:state.chat.project_id||null});if(typeof item.id!=='string')throw new Error('Library save returned without a file reference. Inspect your library before retrying.');const readback=await api('/library/'+encodeURIComponent(item.id));if(epoch!==state.epoch)return;if(readback.content!==message.content)throw new Error('Library save returned; exact content readback did not match.');await refresh();status('Message saved to your library and exact content read back.');log('message_save','saved_and_read_back');
 }
 function line(role,text,detail,message){
  const article=element('article',{class:'chat-message '+role},element('strong',{},role==='user'?'You':role==='assistant'?'Echo Prime':'Activity'),element('p',{},String(text)));
  if(message&&['user','assistant'].includes(role)){
   article.replaceChildren(element('strong',{},role==='user'?'You':'Echo Prime'),renderMessageBody(String(text)));
   const actions=element('div',{class:'workspace-message-actions'},button('Copy',async()=>{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable. Select and copy the message text.');await navigator.clipboard.writeText(String(text));status('Message copied.');log('message_copy','copied');},'quiet-button',false),button('Save to library',()=>saveMessage(message),'quiet-button',false));
   if(role==='assistant'){const listen=button('Listen',()=>speakReply(message,state.chat?.id),'quiet-button',false);listen.disabled=!state.data?.voice?.configured;actions.append(listen);}article.append(actions);
  }
  if(detail)article.append(element('small',{},String(detail)));$('#chat-log').append(article);$('#chat-log').hidden=false;$('#welcome').hidden=true;return article.querySelector('p');
 }
 function renderChat(){
  $('#chat-log').replaceChildren();
  for(const message of (state.chat?.messages||[]).slice(-1000))if(['user','assistant'].includes(message.role))line(message.role,message.content||'',message.created||'',message);
  const activity=(state.chat?.events||[]).slice(-1000).map(activityCard).filter(Boolean).slice(-100);if(activity.length)$('#chat-log').append(element('details',{class:'workspace-activity-log','aria-label':'Saved conversation activity'},element('summary',{},`Conversation activity · ${activity.length} receipts`),...activity));
  $('#conversation-title').textContent=viewUi&&!viewUi.host.hidden?viewUi.title.textContent:state.chat?.title||'New conversation';$('#welcome').hidden=!!state.chat?.messages?.length||!!activity.length;$('#chat-log').hidden=!state.chat?.messages?.length&&!activity.length;updateContext();syncESH();
  emit('echo-workspace-chat',{chat:state.chat});
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
  state.data=data;renderHistory();renderProjects();renderComposer();emit('echo-workspace-state',{state:data});
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
  if(typeof text!=='string'||!text.trim()||text.length>100000)return {handled:true,sent:false,detail:'Enter a message of up to 100,000 characters.'};
  if(state.turn)return {handled:true,sent:false,detail:'Wait for this turn or select Stop.'};
  if(!transport.session?.authenticated||transport.session.user?.status!=='approved'){await open('account');return {handled:true,sent:false,detail:'Sign in to your approved private Workspace first.'};}
  if(!state.chat)await newChat();if(!state.chat)return {handled:true,sent:false,detail:'Conversation was not created.'};
  const epoch=state.epoch,accountEpoch=state.accountEpoch,turnPanel=state.panel,chatId=state.chat.id,requestId=crypto.randomUUID(),controller=new AbortController();state.turn=controller;setBusy(true);line('user',text);
  let answer=null,answerText='',completed=false,verified=false,spoken=false,pendingUi=null;
  try{
   const result=await transport.chat({chat_id:chatId,content:text,request_id:requestId,attachments:[...state.attachments]},event=>{
    if(epoch!==state.epoch||controller.signal.aborted)return;
    if(event.type==='tool_started'||event.type==='tool_result')ingestESH(event);
    if(event.type==='status'){$('#draft-notice').textContent=String(event.text||'Echo is answering…').slice(0,600);$('#draft-notice').hidden=false;}
    else if(event.type==='token'&&typeof event.text==='string'){if(!answer)answer=line('assistant','');answerText+=event.text;if(answerText.length>2_000_000)throw new Error('Answer exceeds display limit.');answer.textContent=answerText;}
    else if(event.type==='tool_started'||event.type==='tool_result'){const receipt=activityCard(event);if(receipt)$('#chat-log').append(receipt);if(event.type==='tool_result')pendingUi=navigationIntent(event.result?.ui_action)||pendingUi;}
   },controller.signal);
   if(epoch!==state.epoch)return {handled:true,cancelled:true};completed=true;state.chat=result;renderChat();
   const readback=await api('/chats/'+encodeURIComponent(chatId));if(epoch!==state.epoch)return {handled:true,cancelled:true};
   state.chat=readback;renderChat();await refresh();verified=true;log('chat','returned_and_read_back');
   let detail='Reply returned and saved conversation read back.';
   if((voiceOptions.spoken||voiceOptions.conversation)&&!document.hidden){
    const reply=[...(state.chat.messages||[])].reverse().find(message=>message.role==='assistant');
    try{spoken=await speakReply(reply,chatId);if(!spoken)endConversation();}catch(error){endConversation();if(epoch===state.epoch){status('Speech unavailable. '+(error instanceof Error?error.message:'No audio receipt returned.')+' No automatic retry was made.');detail+=' Speech is unavailable.';}}
   }
   if(pendingUi&&turnPanel===state.panel){try{await applyNavigation(pendingUi,epoch,accountEpoch);}catch{if(epoch===state.epoch&&accountEpoch===state.accountEpoch){status('Reply saved. The requested view could not be opened under current admission.');log('tool_navigation','unavailable');detail+=' Requested view unavailable.';}}}
   return {handled:true,sent:true,verified:true,detail};
  }catch(error){
   if(epoch!==state.epoch)return {handled:true,cancelled:true};
   let detail=completed?'Reply returned; saved readback is unavailable. Reopen the conversation before retrying.':controller.signal.aborted?'Cancellation requested. Final upstream outcome is unconfirmed until its saved receipt is read back.':(error instanceof Error?error.message:'Conversation failed.')+' No automatic retry was made.';
   endConversation();if(!completed){
    try{const saved=await transport.request('/chats/'+encodeURIComponent(chatId),undefined,state.controller.signal);if(epoch!==state.epoch||accountEpoch!==state.accountEpoch)return {handled:true,cancelled:true};state.chat=saved;renderChat();const failure=(saved.events||[]).find(event=>{if((event.kind||event.type)!=='request_failed')return false;try{return JSON.parse(event.content).request_id===requestId;}catch{return false;}});detail+=failure?' Saved failure receipt read back.':' Saved conversation read back; this request’s final receipt is not available yet.';log('chat','failure_readback_returned');}
    catch{if(epoch!==state.epoch||accountEpoch!==state.accountEpoch)return {handled:true,cancelled:true};detail+=' Saved receipt readback is unavailable. Reopen the conversation before retrying.';log('chat','failure_readback_unavailable');}
    line('activity',detail);
   }return {handled:true,sent:completed,verified:false,detail};
  }finally{if(state.turn===controller){state.turn=null;setBusy(false);}if(epoch===state.epoch&&verified&&spoken&&voiceOptions.conversation)scheduleListening();}
 }
 function section(title,...nodes){content.append(card(title,...nodes));}
 function eshBadge(text){if(!eshUi){const badge=element('span',{id:'workspace-esh-badge',class:'workspace-esh-badge',role:'status'}),prefix=element('span',{id:'workspace-esh-prompt',class:'workspace-esh-prompt','aria-hidden':'true'},'PS >');$('#workspace-esh-title').append(badge);$('#workspace-esh-command').before(prefix);$('#workspace-esh-command').setAttribute('placeholder','Review an exact command · Ctrl+Enter reviews, then runs the unchanged review');eshUi={badge,prefix};}eshUi.badge.textContent=text;}
 function clearESH(){esh.generation++;esh.rows.clear();esh.review=null;esh.busy=false;$('#workspace-esh-command').value='';$('#workspace-esh-reviewed').textContent='';$('#workspace-esh-output').replaceChildren();$('#workspace-esh-run').disabled=true;$('#workspace-esh').hidden=true;$('#workspace-esh-status').textContent='Open a saved conversation before dispatch. Policy and grants remain with the canonical ESH owner.';eshBadge('Conversation required');}
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
  emit('echo-workspace-layout',{floating:esh.floating,rect:{...esh.rect}});
 }
 async function openESH(){await ready;await ownerHeaders();syncESH();if(dialog.open)dialog.close();$('#workspace-esh').hidden=false;eshBadge(state.chat?'Review required':'Conversation required');applyESH();$('#workspace-esh-command').focus();}
 $('#workspace-open-esh').addEventListener('click',event=>{event.stopImmediatePropagation?.();return openESH().catch(()=>{$('#draft-notice').textContent='Current primary owner admission is required for ESH.';$('#draft-notice').hidden=false;eshBadge('Owner admission required');});});
 $('#workspace-esh-close').addEventListener('click',()=>{$('#workspace-esh').hidden=true;esh.review=null;$('#workspace-esh-reviewed').textContent='';$('#workspace-esh-command').value='';$('#workspace-esh-run').disabled=true;});
 $('#workspace-esh-command').addEventListener('input',()=>{esh.review=null;$('#workspace-esh-reviewed').textContent='Review the changed command again.';$('#workspace-esh-run').disabled=true;eshBadge('Review required');});
 $('#workspace-esh-command').addEventListener('keydown',async event=>{if(event.key!=='Enter'||!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing)return;event.preventDefault();if(event.repeat||esh.busy)return;const review=esh.review;if(review&&review.epoch===state.epoch&&review.chatId===state.chat?.id&&review.command===$('#workspace-esh-command').value.trim())await $('#workspace-esh-run').click();else await $('#workspace-esh-review').click();});
 $('#workspace-esh-review').addEventListener('click',()=>{if(esh.busy||!state.chat?.id||!transport.session?.ownerAccess){$('#workspace-esh-status').textContent='Open a saved conversation under the primary owner before reviewing a command.';eshBadge('Owner conversation required');return;}const command=$('#workspace-esh-command').value.trim();if(!command)return;esh.review={command,chatId:state.chat.id,epoch:state.epoch};$('#workspace-esh-reviewed').textContent=command;$('#workspace-esh-run').disabled=false;$('#workspace-esh-status').textContent='Exact command reviewed. Ctrl+Enter or Run reviewed command dispatches this unchanged command once.';eshBadge('Reviewed');});
 $('#workspace-esh-run').addEventListener('click',async()=>{
  const review=esh.review;if(esh.busy||!review||review.epoch!==state.epoch||review.chatId!==state.chat?.id||review.command!==$('#workspace-esh-command').value.trim())return;
  esh.review=null;esh.busy=true;$('#workspace-esh-run').disabled=true;eshBadge('Dispatching reviewed command');const epoch=state.epoch,generation=esh.generation,id=crypto.randomUUID(),current=()=>epoch===state.epoch&&generation===esh.generation&&review.chatId===state.chat?.id;
  try{
   await ownerHeaders();if(!current())return;ingestESH({type:'tool_started',tool:'esh',request_id:id,arguments:{command:review.command}});esh.rows.get(id).source='You';renderESH();$('#workspace-esh-status').textContent='Dispatching the reviewed command…';
   const receipt=await transport.request('/action',{action:'esh',command:review.command,chat_id:review.chatId,request_id:id},state.controller.signal);if(!current())return;
   ingestESH({type:'tool_result',tool:'esh',request_id:id,result:receipt});$('#workspace-esh-status').textContent='Command receipt returned. Verify its output before relying on a repair.';eshBadge('Receipt '+(esh.rows.get(id)?.outcome||'returned'));log('esh','returned');
   const chat=await transport.request('/chats/'+encodeURIComponent(review.chatId),undefined,state.controller.signal);if(current()){state.chat=chat;syncESH();}
  }catch(error){if(current()){ingestESH({type:'tool_result',tool:'esh',request_id:id,result:{ok:false,state:'unconfirmed',error:error instanceof Error?error.message:'Receipt unavailable.'}});$('#workspace-esh-status').textContent='Outcome unconfirmed. Inspect the conversation journal before any retry.';eshBadge('Outcome unconfirmed');log('esh','unconfirmed');}}
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
 function safeFilename(name){let value=String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,120).replace(/[. ]+$/,'').trim();if(!value)value='echo-file.txt';if(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))value=('_'+value).slice(0,120);return value;}
 function saveText(name,text){const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=element('a',{href:url,download:safeFilename(name)});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);log('file_download','started');}
 async function journal(){if(!state.chat)throw new Error('Open a saved conversation first.');const chat=state.chat,page=await presentView({id:'conversation-journal',title:'Conversation journal',subtitle:'The saved journal for this conversation. Remote memory delivery has separate receipts.'}),text=await transport.text('/journals/'+encodeURIComponent(chat.id),state.controller.signal);if(!page.isCurrent())return;content.replaceChildren(pre(text),button('Download journal',()=>saveText((chat.title||'conversation')+'.md',text)));}
 async function projects(){
  const name=input('Project name'),instructions=element('textarea',{rows:5,maxlength:12000,placeholder:'Project instructions'});
  section('Create a project',field('Name',name),field('Instructions',instructions),button('Create project',async()=>{await api('/projects',{name:name.value,instructions:instructions.value});await refresh();await open('projects');}));
  for(const project of state.data.projects||[]){const title=input('Name',project.name||''),guide=element('textarea',{rows:4,maxlength:12000});guide.value=project.instructions||'';const chats=(state.data.chats||[]).filter(chat=>chat.project_id===project.id);section(project.name||'Project',field('Name',title),field('Instructions',guide),button('Save changes',async()=>{await api('/project/update',{id:project.id,name:title.value,instructions:guide.value});await refresh();status('Project updated.');}),button('Start a project conversation',async()=>{$('#workspace-project').value=project.id;await newChat();dialog.close();}),element('p',{},`${chats.length} saved project conversations`),...chats.slice(0,100).map(chat=>button(chat.title||'Untitled conversation',()=>openChat(chat.id))));}
 }
 async function library(){
  const name=input('notes.md'),text=element('textarea',{rows:6,maxlength:100000,placeholder:'Text or code · up to 100,000 characters'}),file=element('input',{type:'file',accept:'.txt,.md,.py,.js,.ts,.tsx,.jsx,.json,.csv,.html,.css,.yaml,.yml,.toml,.ps1,.go,.rs,.sql'});
  let fileRead=0;
  file.addEventListener('change',async()=>{const chosen=file.files?.[0],epoch=state.epoch,panel=state.panel,version=++fileRead;try{if(!chosen)return;if(chosen.size>100000||/(?:^\.env|id_rsa|id_ed25519|credentials?|secrets?|\.(?:pem|key|pfx|db)$)/i.test(chosen.name))throw new Error('Choose a non-credential text file of at most 100,000 bytes.');const value=await chosen.text();if(epoch!==state.epoch||panel!==state.panel||version!==fileRead||!file.isConnected)return;if(value.length>100000)throw new Error('Library entries support at most 100,000 characters.');name.value=safeFilename(chosen.name);text.value=value;}catch(error){if(epoch===state.epoch&&panel===state.panel)status(error.message);}finally{file.value='';}});
  section('Write a note or save a file',field('Choose a text file · at most 100,000 bytes',file),field('Name',name),field('Contents · at most 100,000 characters',text),button('Save to your library',async()=>{if(!text.value.trim()||text.value.length>100000)throw new Error('Enter nonempty text of at most 100,000 characters.');const item=await api('/library',{name:safeFilename(name.value),content:text.value,chat_id:state.chat?.id,project_id:state.chat?.project_id||$('#workspace-project').value||null});await refresh();await open('library');status('File saved'+(item.path?' · '+item.path:'.'));}));
  const search=input('Find a library file','','search'),libraryRows=[];section('Your library',field('Search by name or path',search));search.addEventListener('input',()=>{const query=search.value.toLowerCase();for(const row of libraryRows)row.node.hidden=!row.name.includes(query);});
  for(const item of state.data.library||[]){
   const attach=element('input',{type:'checkbox','aria-label':'Attach '+item.name}),epoch=state.epoch,panel=state.panel;attach.checked=state.attachments.has(item.id);attach.addEventListener('change',()=>{if(epoch!==state.epoch||panel!==state.panel||!attach.isConnected)return;if(attach.checked)state.attachments.add(item.id);else state.attachments.delete(item.id);updateContext();});
   section(item.name||'File',element('p',{},String(item.path||'Private account file')),field('Attach to next message',attach),button('Read / download',async()=>{const value=await api('/library/'+encodeURIComponent(item.id));content.replaceChildren(pre(value.content||''),element('p',{},String(value.sha256||'')),button('Download file',()=>saveText(value.name||item.name,value.content||'')));}),button('Review code',async()=>{const value=await api('/library/'+encodeURIComponent(item.id));if(typeof value.content!=='string'||!value.content.trim()||value.content.length>40000)throw new Error('Code review requires a nonempty text file of up to 40,000 characters.');status('Reviewing this file using the canonical Workspace model…');const review=await api('/review',{name:value.name||item.name,content:value.content,project_id:value.project_id||null});if(typeof review.id!=='string')throw new Error('Review returned without a saved conversation. Inspect the library before retrying.');await openChat(review.id);await refresh();log('code_review','saved_and_read_back');}),button('Open linked conversation',async()=>{if(!item.chat_id)throw new Error('This file has no linked conversation.');await openChat(item.chat_id);}));
   libraryRows.push({node:content.children[content.children.length-1],name:String(item.name||'').toLowerCase()+' '+String(item.path||'').toLowerCase()});
  }
  if(state.chat)content.append(button('Open this conversation’s journal',journal));
  const imported=element('textarea',{id:'workspace-import-data',rows:5,maxlength:1500000,placeholder:'Paste an authorized neutral/ChatGPT/Claude JSON export or plain text'}),title=input('Imported conversation'),source=element('select',{id:'workspace-import-source'},...['authorized-import','chatgpt','claude','grok','other'].map(value=>element('option',{value},value==='authorized-import'?'Neutral / chosen transcript':value))),importFile=element('input',{id:'workspace-import-file',type:'file',accept:'.json,.txt,.md'});source.value='authorized-import';title.setAttribute('id','workspace-import-title');let importRead=0;
  importFile.addEventListener('change',async()=>{const chosen=importFile.files?.[0],epoch=state.epoch,panel=state.panel,version=++importRead;try{if(!chosen)return;if(chosen.size>1900000||!/[.](?:json|txt|md)$/i.test(chosen.name)||/(?:^\.env|credentials?|secrets?|tokens?)/i.test(chosen.name))throw new Error('Choose one non-credential JSON, text or Markdown export of at most 1,900,000 bytes.');const value=await chosen.text();if(epoch!==state.epoch||panel!==state.panel||version!==importRead||!importFile.isConnected)return;if(value.length>1900000)throw new Error('Choose an export with at most 1,900,000 characters.');imported.value=value;if(!title.value.trim())title.value=chosen.name.replace(/\.[^.]+$/,'').slice(0,200);log('import_file','loaded_for_review');}catch(error){if(epoch===state.epoch&&panel===state.panel)status(error.message);}finally{importFile.value='';}});
  section('Import conversation',element('p',{},'Choose one conversation you are authorized to import. This reads the selected file only and does not connect to another provider account. Paste up to 1,500,000 characters or choose a file up to 1,900,000 bytes.'),field('Source',source),field('Title',title),field('Export file',importFile),field('Export',imported),button('Import',async()=>{const value=normalizeImport(imported.value,title.value,source.value);const result=await api('/import',value);await refresh();status('Import returned. Open the saved conversation to inspect its selected branch and messages.');if(result.id)await openChat(result.id);}));
 }
 function normalizeImport(raw,title,source='authorized-import'){
  if(!['authorized-import','chatgpt','claude','grok','other'].includes(source))throw new Error('Choose a supported import source.');if(raw.length>1900000)throw new Error('Choose one export of at most 1,900,000 characters.');
  let value;try{value=JSON.parse(raw);}catch{value={messages:[{role:'user',content:raw}]};}
  if(Array.isArray(value)){if(value.length!==1)throw new Error('Choose one exported conversation at a time.');value=value[0];}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose one exported conversation.');
  let messages=value.messages;
  if(value.mapping){
   const branch=[],seen=new Set();let current=value.current_node;
   while(current){if(seen.has(current)||seen.size>=10000)throw new Error('Invalid exported conversation branch.');seen.add(current);const node=value.mapping[current];if(!node||typeof node!=='object')throw new Error('Export branch is incomplete.');if(node.message)branch.push(node.message);current=node.parent;}
   messages=branch.reverse().filter(m=>['user','assistant'].includes(m.author?.role)&&Array.isArray(m.content?.parts)).map(m=>({role:m.author.role,content:m.content.parts.filter(p=>typeof p==='string').join('\n'),...(Number.isFinite(m.create_time)?{timestamp:new Date(m.create_time*1000).toISOString()}:{} )})).filter(m=>m.content.trim());
  }else if(Array.isArray(value.chat_messages))messages=value.chat_messages.filter(m=>['human','assistant'].includes(m.sender)).map(m=>({role:m.sender==='human'?'user':'assistant',content:typeof m.text==='string'?m.text:(m.content||[]).filter(x=>x.type==='text'||typeof x.text==='string').map(x=>x.text||'').join('\n'),timestamp:m.created_at}));
  if(!Array.isArray(messages)||messages.length<1||messages.length>1000||messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()))throw new Error('Import requires 1–1000 nonempty user or assistant messages.');
  return {source,title:(title||value.title||value.name||'Imported conversation').slice(0,200),messages:messages.map(m=>({role:m.role,content:m.content,...(typeof m.timestamp==='string'?{timestamp:m.timestamp.slice(0,100)}:{})}))};
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
  await memory();
  section('Automatic journal & memory delivery',element('p',{},state.data.memory_mode==='automatic'?'Conversation journaling and admitted memory hooks run automatically in this Workspace.':'Read the current Workspace memory and synchronization state before relying on automatic delivery.'),element('p',{},'Local journal persistence and exact remote memory receipts are separate evidence.'),pre({sync:state.data.sync,knowledge:state.data.knowledge,directive_loaded:state.data.directive?.loaded===true}));
  if(transport.session.ownerAccess){
   const note=element('textarea',{rows:4,maxlength:18000,placeholder:'Nonsecret memory to store in Crystal'});
   section('Save a Crystal memory',field('Memory',note),button('Store and verify memory',async()=>{const receipt=await api('/action',{action:'crystal_save',content:note.value,chat_id:state.chat?.id});if(receipt.readback_verified!==true)throw new Error('Memory write returned without verified exact readback.');note.value='';status('Crystal memory saved and exact content read back.');content.append(receiptCard('Crystal write · exact readback verified',receipt));log('crystal_save','exact_readback_verified');}));
   section('Admitted memory connections',button('Check connections',async()=>{const result=await api('/plugins');for(const [name,value] of Object.entries(result||{}).slice(0,20))content.append(receiptCard(name,value));status('Connection observations returned. A configured connection is separate from a successful action.');}),button('Read Personality Forge assets',async()=>{content.append(receiptCard('Personality Forge assets',await api('/action',{action:'personality_assets',chat_id:state.chat?.id})));}));
  }
  const connections=await api('/mcp');
  for(const connection of connections.connections||[])section(connection.name||'MCP connection',element('p',{},String(connection.url||'')),element('p',{},`${connection.tool_count||0} tools · ${connection.enabled?'Enabled':'Disabled'}`),button('Inspect tool schemas',async()=>{content.append(receiptCard('Advertised tool schemas',await api('/mcp/tools/'+encodeURIComponent(connection.id))));}),button(connection.enabled?'Disable':'Enable',async()=>{await api('/mcp',{action:'enable',id:connection.id,enabled:!connection.enabled});await open('plugins');}),button('Remove connection',async()=>{await api('/mcp',{action:'remove',id:connection.id});await open('plugins');}));
  const name=input('Connection name'),url=input('https://service.example/mcp','','url'),auth=element('select',{},element('option',{value:'none'},'No authentication'),element('option',{value:'bearer'},'Bearer token')),token=input('This server’s credential','','password');
  section('Connect a Streamable HTTP MCP server',field('Name',name),field('Public HTTPS endpoint',url),field('Authentication',auth),field('Credential · encrypted by the canonical owner',token),element('p',{},'This field sends the credential only to your account’s connection store. OAuth onboarding and legacy SSE-only endpoints remain unsupported.'),button('Connect and discover tools',async()=>{try{await api('/mcp',{action:'add',name:name.value,url:url.value,auth:auth.value,token:token.value});await open('plugins');status('Connection returned; inspect its advertised schemas before use.');}finally{token.value='';}}));
 }
 async function sdk(){
  if(!transport.session?.ownerAccess)throw new Error('Primary owner admission required.');
  const query=input('Capability name or intent'),cap=input('echo.namespace.operation'),command=input('Exact command'),options=element('textarea',{rows:6,maxlength:20000,placeholder:'{}'}),reviewed=pre('No request reviewed.');cap.setAttribute('id','workspace-sdk-capability');command.setAttribute('id','workspace-sdk-command');options.setAttribute('id','workspace-sdk-options');options.value='{}';let review=null;
  const run=button('Run reviewed SDK request',async()=>{if(!review||review!==snapshot())throw new Error('Review this exact request again.');const request=JSON.parse(review);review=null;run.disabled=true;await ownerHeaders();const result=await api('/action',{action:'sdk',...request,chat_id:state.chat?.id});content.append(receiptCard(request.capability+' · '+request.command,result));status('SDK receipt returned. Verify the operation’s postcondition before relying on it.');log('sdk_invoke','receipt_returned');});run.disabled=true;
  const snapshot=()=>{let value;try{value=JSON.parse(options.value);}catch{throw new Error('Options must be a JSON object.');}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Options must be a JSON object.');if(!/^echo\.[A-Za-z0-9_.-]{1,175}$/.test(cap.value.trim())||!command.value.trim())throw new Error('Enter an exact Echo capability and command.');if(cap.value.startsWith('echo.vault.')||/"[^"\n]*(?:secret|token|password|api.?key)[^"\n]*"\s*:/i.test(JSON.stringify(value)))throw new Error('Use the isolated Vault form for credentials.');return JSON.stringify({capability:cap.value.trim(),command:command.value.trim(),options:value});};
  for(const node of [cap,command,options])node.addEventListener('input',()=>{review=null;run.disabled=true;reviewed.textContent='Request changed. Review again.';});
  const showCapabilities=value=>{const rows=value?.results||value?.capabilities||value?.items;if(!Array.isArray(rows)){content.append(receiptCard('Capability catalog',value));return;}if(!rows.length){content.append(card('No capabilities returned',element('p',{},'Try another capability name or intent.')));return;}for(const row of rows.slice(0,100)){const name=typeof row==='string'?row:row.capability||row.name||row.id,label=typeof name==='string'?name:'Capability';content.append(card(label,element('p',{},typeof row.description==='string'?row.description:'Inspect the current exact schema before preparing a request.'),...(/^echo\.[A-Za-z0-9_.-]+$/.test(label)?[button('Use this capability',()=>{cap.value=label;review=null;run.disabled=true;reviewed.textContent='Capability changed. Read its schema and review a request.';status('Capability selected. Read its exact schema and enter a command.');})]:[]),element('details',{},element('summary',{},'Registry metadata'),pre(safeReceipt(row)))));}};
  section('SDK discovery',field('Search',query),button('Search live capability registry',async()=>{showCapabilities(await api('/action',{action:'sdk',capability:'echo.caps.search',command:'search',options:{q:query.value,limit:20}}));}),button('Read catalog',async()=>{showCapabilities(await api('/catalog'));}));
  section('Exact capability request',field('Capability',cap),button('Read exact schema',async()=>{content.append(receiptCard('Exact capability schema',await api('/action',{action:'sdk_detail',capability:cap.value})));}),field('Command',command),field('Options JSON · no credentials',options),button('Review SDK request',()=>{review=snapshot();reviewed.textContent=JSON.stringify(JSON.parse(review),null,2);run.disabled=false;log('sdk_review','prepared');}),reviewed,run);
 }
 async function vault(){
  if(!transport.session?.ownerAccess)throw new Error('Primary owner admission required.');
  const service=input('Service reference'),username=input('Account reference'),secret=input('Credential value','','password');
  const operation=async name=>{await ownerHeaders();try{const receipt=await api('/action',{action:'vault',operation:name,service:service.value,username:username.value,...(name==='put'?{secret:secret.value}:{})});const keys=['ok','stored','service','username','version','created_at','updated_at','status','count','operation','note'],project=value=>Object.fromEntries(keys.filter(key=>key in (value||{})).map(key=>[key,value[key]])),rows=Array.isArray(receipt.entries)?receipt.entries.map(project):[project(receipt)];if(!rows.length)content.append(card('No Vault references returned',element('p',{},'No matching reference was returned under current admission.')));for(const row of rows.slice(0,50))content.append(card(String(row.service||'Vault reference'),element('p',{},row.username?'Account: '+String(row.username):'Account reference not reported'),element('p',{},row.stored===true?'Stored · metadata receipt returned':row.status?'Status: '+String(row.status):'Metadata receipt returned'),...(row.version?[element('p',{},'Version: '+String(row.version))]:[]),element('details',{},element('summary',{},'Reference metadata'),pre(row))));status('Vault metadata returned. Credential values remain inside the governed owner.');log('vault_'+name,'metadata_returned');}finally{secret.value='';}};
  section('Vault references',element('p',{},'Locate and list admitted service references. Retrieval returns metadata only; use the reference through a supported connector.'),field('Service',service),field('Account',username),button('List references',()=>operation('list')),button('Locate reference',()=>operation('locate')),button('Read reference metadata',()=>operation('get')));
  section('Isolated Vault credential entry',field('Credential',secret),button('Store credential in existing Vault',()=>operation('put')));
 }
 async function review(){
  const name=input('review.txt'),code=element('textarea',{rows:12,maxlength:40000,placeholder:'Paste code to review'}),project=element('select',{},element('option',{value:''},'No project'),...(state.data.projects||[]).map(item=>element('option',{value:item.id},item.name||'Project')));
  section('Code review',field('File name',name),field('Project context',project),field('Code · up to 40,000 characters',code),button('Review this code',async()=>{if(!code.value.trim()||code.value.length>40000)throw new Error('Enter nonempty code up to 40,000 characters.');const result=await api('/review',{name:name.value,content:code.value,project_id:project.value||null});if(typeof result.id!=='string')throw new Error('Review returned without a saved conversation. Inspect the journal before retrying.');await openChat(result.id);await refresh();log('code_review','saved_and_read_back');}));
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
  const epoch=state.epoch,panel=state.panel;listenTimer=setTimeout(()=>{if(!voiceOptions.conversation||epoch!==state.epoch||panel!==state.panel||document.hidden)return;void dictate().catch(()=>{endConversation();stopAudio();status('Voice conversation stopped. Review the last receipt before resuming.');});},300);
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
  const output=new Float32Array(Math.min(1920000,Math.floor(size*16000/rate))),ratio=rate/16000;
  for(let i=0;i<output.length;i++){const start=Math.floor(i*ratio),end=Math.min(input.length,Math.max(start+1,Math.floor((i+1)*ratio)));let total=0;for(let j=start;j<end;j++)total+=input[j];output[i]=total/Math.max(1,end-start);}return output;
 }
 async function dictate(){
  if(state.capture){await state.capture.finish(false);return;}
  if(state.micPending)throw new Error('A microphone request is already pending. Select Stop microphone to cancel.');
  if(state.turn||!state.chat)throw new Error('Open an idle saved conversation before dictating.');
  if(!state.data?.voice?.configured)throw new Error('Personality Forge transcription is not configured for this Workspace. Text chat remains available.');
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone capture is unavailable in this browser. Text chat remains available.');
  stopAudio();const epoch=state.epoch,panel=state.panel,version=state.micEpoch,chatId=state.chat.id,duration=captureSeconds;state.micPending=true;let stream,context;
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
     const samples=resample(chunks,context.sampleRate),transcripts=[];chunks.length=0;const total=Math.ceil(samples.length/128000);
     for(let offset=0;offset<samples.length;offset+=128000){
      if(!current()||controller.signal.aborted)return;const segment=Math.floor(offset/128000)+1;status(`Transcribing segment ${segment} / ${total} · Microphone off…`);
      const audio=encodeWav(samples.subarray(offset,Math.min(samples.length,offset+128000))),result=await transport.request('/voice/transcribe',{chat_id:chatId,request_id:crypto.randomUUID(),audio_b64:audio},controller.signal);
      if(!current()||controller.signal.aborted)return;if(result.provider!=='elevenlabs-scribe'||typeof result.text!=='string'||result.text.length>12000)throw new Error('The canonical transcription provider did not confirm a bounded transcript. No message was sent.');transcripts.push(result.text.trim());
      if(transcripts.join(' ').length>12000)throw new Error('The transcript exceeds the composer limit. No message was sent.');
     }
     const draft=[$('#prompt').value.trim(),...transcripts].filter(Boolean).join(' ');if(draft.length>12000)throw new Error('The transcript exceeds the composer limit. No message was sent.');
     $('#prompt').value=draft;updateContext();status('Transcribed into your composer. Review and send when ready.');log('microphone','transcribed_for_review');
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
    const room=Math.max(0,Math.floor(context.sampleRate*duration)-frames),data=new Float32Array(event.inputBuffer.getChannelData(0).slice(0,room));
    if(data.length){chunks.push(data);frames+=data.length;const rms=Math.sqrt(data.reduce((sum,sample)=>sum+sample*sample,0)/data.length);if(rms>0.012){heard=true;silence=0;}else silence+=data.length/context.sampleRate;}
    if(frames>=Math.floor(context.sampleRate*duration)||heard&&silence>=2)void finish(false);
   };
   timer=setTimeout(()=>void finish(false),duration*1000);await context.resume();if(!current()){await finish(true);return;}status(`Listening · Up to ${duration} seconds · Pause two seconds or select Finish and transcribe`);log('microphone','capturing');
  }catch(error){if(state.capture){await state.capture.finish(true);state.capture=null;}else{stream?.getTracks().forEach(track=>track.stop());await context?.close().catch(()=>{});}if(current()){endConversation();state.micPending=false;status(error instanceof Error?error.message:'Microphone permission is unavailable.');}}
 }
 async function voice(){
  const profiles=element('select',{},...(state.data.personalities||[]).map(value=>element('option',{value:value.id},value.name+(value.registered?'':' · not registered'))));
  section('Conversation personality',field('Profile',profiles),button('Use for this conversation',async()=>{if(!state.chat)throw new Error('Open a saved conversation first.');content.append(pre(await api('/action',{action:'personality_select',chat_id:state.chat.id,profile:profiles.value})));}),pre(state.data.voice||{configured:false}));
  const replies=element('select',{},...(state.chat?.messages||[]).filter(message=>message.role==='assistant').map(message=>element('option',{value:message.id},message.content.slice(0,100))));
  const option=(id,label,key)=>{const node=element('input',{type:'checkbox',id});node.checked=voiceOptions[key];const epoch=state.epoch,panel=state.panel;node.addEventListener('change',()=>{if(epoch!==state.epoch||panel!==state.panel)return;voiceOptions[key]=node.checked;if(key==='spoken'&&!node.checked){endConversation();stopAudio();}});return field(label,node);};
  section('Voice preferences · off at session startup',option('workspace-voice-spoken','Speak replies automatically · uses the configured provider quota','spoken'),option('workspace-voice-brief','Brief extractive speech · canonical summary mode','brief'),option('workspace-voice-auto-send','Send dictated speech automatically · skips manual transcript review','autoSend'),element('p',{},'Preferences stay in this signed-in page only. A new account starts with every option off. Microphone access still requires an explicit Dictate or Start voice conversation action.'));
  section('Listen to a saved reply',field('Assistant reply',replies),element('p',{},'Uses the configured Personality Forge provider and its quota.'),button('Listen',async()=>{if(!state.chat||!replies.value)throw new Error('Open a saved assistant reply first.');await speakReply((state.chat.messages||[]).find(message=>message.id===replies.value&&message.role==='assistant'),state.chat.id);}),button('Stop speech',async()=>{const speech=state.speech;endConversation();stopAudio();if(speech?.session_id)await api('/voice/cancel',speech);status('Playback stopped. In-flight provider work may finish; no request will be replayed.');}));
  section('Dictate into the composer',element('p',{},'Microphone off until you select Dictate and grant browser permission. Choose up to 120 seconds in the voice bar. Each request sends at most eight seconds of mono PCM audio to the configured ElevenLabs Scribe provider. Segments are transcribed sequentially into one reviewed draft unless you explicitly enable automatic sends.'),button('Dictate a message',dictate),button('Finish and transcribe',async()=>{if(state.capture)await state.capture.finish(false);else throw new Error('There is no active microphone capture.');}),button('Stop microphone',()=>{endConversation();stopCapture();status('Microphone off. Pending transcription may finish; its result will be discarded.');}));
  section('Hands-free voice conversation',element('p',{},'Explicit opt-in starts the microphone, automatically sends each transcription and speaks the saved reply. Stops after at most ten captured turns, on any uncertainty, or when this panel, account, tab visibility or page changes. Select Start again to resume.'),button('Start voice conversation · up to ten turns',startVoiceConversation),button('Stop voice conversation',()=>{endConversation();stopAudio();status('Voice conversation stopped. Microphone off. No pending response will restart it.');}));
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
  if(logoutBusy)return;logoutBusy=true;const panel=state.panel,accountEpoch=state.accountEpoch;let revocationReturned=false;
  try{
   status('Revoking this local session…');
   // Successful revocation intentionally invalidates identity and its UI epoch.
   // Use the transport's revocation-only proof rather than the private api wrapper.
   await transport.request('/auth/logout',{});
   revocationReturned=true;
   const session=await transport.loadSession();
   if(session?.workspaceConfigured!==true||session.authenticated!==false||session.user!==null||session.csrf!==null)throw new Error('Anonymous session readback unavailable.');
   if(panel!==state.panel)return;clearFields();content.replaceChildren();await account(session);
   if(panel===state.panel)status('Signed out. Anonymous session readback verified.');log('logout','anonymous_readback_verified');
  }catch{
   // A separately admitted newer identity owns its own view; never overwrite it
   // with a late result from an older account's sign-out attempt.
   if(!revocationReturned&&transport.session?.authenticated&&accountEpoch!==state.accountEpoch)return;
   transport.clear();
   if(panel===state.panel){clearFields();content.replaceChildren();status('Sign-out could not be confirmed. This page has been cleared. No automatic retry or account readmission was attempted. Reload to check the current session before signing in again.');}
   log('logout','unconfirmed');
  }finally{logoutBusy=false;}
 }
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
   section(session.user.name||session.user.email||'Your account',element('p',{},session.user.status==='approved'?'Your private Workspace is available.':'Account status: '+session.user.status),button('Sign out',signOut));
   if(session.ownerAccess){const value=await api('/auth/accounts');for(const user of (value.accounts||[]).slice(0,200)){if(user.role==='owner')continue;section(user.email||'Member account',element('p',{},'Status: '+user.status),button('Approve account',()=>decision(user,'approve')),button('Deny account',()=>decision(user,'deny')));}}
   return;
  }
  const email=input('Email or existing supported user ID'),password=input('Password','','password'),name=input('Display name'),googleButton=element('div',{});
  section('Sign in to your private Workspace',field('Email / user ID',email),field('Password',password),button('Sign in',async()=>{const body={email:email.value.trim(),password:password.value};password.value='';try{await auth('login',body);await accountRefresh();}finally{body.password='';password.value='';}}),field('Display name · new accounts',name),button('Create account',async()=>{const body={email:email.value.trim(),password:password.value,display_name:name.value};password.value='';try{const result=await auth('signup',body);status(result.message||'Signup returned. Verify your email and wait for owner approval.');}finally{body.password='';password.value='';}}),button('Request password recovery',async()=>{status((await auth('reset',{email:email.value.trim()})).message||'Recovery request returned.');}),googleButton);
  try{
   const config=await auth('config');
   if(config.google_login_enabled&&typeof config.google_client_id==='string'){
    const render=()=>{if(panel!==state.panel||!dialog.open||!googleButton.isConnected)return;window.google.accounts.id.initialize({client_id:config.google_client_id,auto_select:false,callback:async result=>{if(panel!==state.panel||!dialog.open||!googleButton.isConnected){result.credential='';return;}try{await auth('login',{provider:'google',id_token:result.credential});await accountRefresh();}catch(error){if(panel===state.panel)status(error.message);}finally{result.credential='';}}});window.google.accounts.id.renderButton(googleButton,{theme:'filled_black',size:'large',width:280});};
    if(window.google?.accounts?.id)render();else{let script=document.querySelector('script[data-prime-google]');if(!script){script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.dataset.primeGoogle='1';script.addEventListener('error',()=>status('Google sign-in script is unavailable. Use an existing supported account route.'));document.head.append(script);}script.addEventListener('load',render,{once:true});}
   }
  }catch{if(panel===state.panel)status('Google configuration is unavailable. No alternate identity provider was selected.');}
 }
 function decision(user,choice){clearFields();content.replaceChildren(card('Review account decision',element('p',{},`${choice==='approve'?'Approve':'Deny'} ${user.email||user.uid}?`),element('p',{},'Exact account: '+user.uid),button('Confirm this account decision',async()=>{const receipt=await api('/auth/decide',{uid:user.uid,decision:choice});await open('account');status('Account decision returned: '+(receipt.user?.status||'read the current account status above')+'.');}),button('Cancel',()=>open('account'))));}
 async function accountRefresh(){
  const session=await transport.loadSession();if(session?.authenticated&&session.user.status==='approved')await refresh();await open('account');
 }
 async function open(view){
  const navigation=beginViewNavigation();await ready;if(!currentViewNavigation(navigation,true))return;
  if(Object.hasOwn(pageDefinitions,view)){
   let page;try{page=await presentView({id:view,...pageDefinitions[view]},navigation);if(!page.isCurrent())return;await refresh();if(!page.isCurrent())return;await ({projects,library,memory,plugins,operations,sdk,vault,review}[view])();}
   catch(error){if(currentViewNavigation(navigation)&&(!page||page.isCurrent())){status(error instanceof Error?error.message:'Workspace page is unavailable.');if(!viewUi||viewUi.host.hidden){$('#draft-notice').textContent=notice.textContent;$('#draft-notice').hidden=false;}}}return;
  }
  modalContent();state.panel++;clearFields();endConversation();stopAudio();content.replaceChildren();status('');$('#workspace-panel-title').textContent=({voice:'Voice & personality',account:'Your account'})[view]||'Your Workspace';
  if(!dialog.open)dialog.showModal();
  if(!state.enabled){status('A reviewed authenticated Workspace backend is not configured for this local Prime host.');return;}
  const epoch=state.epoch,panel=state.panel;
  try{if(view!=='account'){await refresh();if(epoch!==state.epoch||panel!==state.panel)return;}await ({projects,library,memory,plugins,voice,operations,sdk,vault,review,account}[view]||account)();}catch(error){if(epoch===state.epoch&&panel===state.panel)status(error.message);}
 }
 async function ownerHeaders(){
  await ready;if(!state.enabled)return {};
  const previous=transport.session?.user?.uid;let session;try{session=await transport.loadSession();}catch{throw new Error('Current account admission unavailable.');}
  if(previous&&previous!==session?.user?.uid)throw new Error('Account changed. Review your request again.');
  if(!session?.ownerAccess)throw new Error('Primary owner admission required.');return transport.headers();
 }
 all('[data-workspace-view]').forEach(node=>node.addEventListener('click',event=>{event.stopImmediatePropagation?.();void open(node.dataset.workspaceView);}));
 all('[data-view="conversation"]').forEach(node=>node.addEventListener('click',()=>showConversation()));
 document.addEventListener('keydown',event=>{if(!viewUi||viewUi.host.hidden||dialog.open||event.isComposing)return;if(event.key==='Escape'||event.altKey&&event.key==='ArrowLeft'){event.preventDefault();showConversation();}});
 dialog.addEventListener('close',()=>{state.panel++;clearFields();endConversation();stopAudio();});
 $('#workspace-chat-kind').addEventListener('change',()=>{state.epoch++;state.turn?.abort();state.turn=null;endConversation();stopAudio();window.EchoPrimeChat.reset();$('#prompt').value='';$('#draft-notice').hidden=true;updateComposerLimit();if($('#workspace-chat-kind').value==='workspace')renderChat();});
 $('#workspace-project').addEventListener('change',()=>{const epoch=state.epoch;if(state.chat)void api('/chat/update',{chat_id:state.chat.id,title:state.chat.title,project_id:$('#workspace-project').value||null}).then(chat=>{if(epoch===state.epoch)state.chat=chat;}).catch(error=>{if(epoch===state.epoch)status(error.message);});});
 $('#workspace-rename').addEventListener('click',()=>{if(!state.chat)return;modalContent();content.replaceChildren();const title=input('Conversation title',state.chat.title);content.append(field('Title',title),button('Save title',async()=>{state.chat=await api('/chat/update',{chat_id:state.chat.id,title:title.value,project_id:state.chat.project_id});await refresh();renderChat();dialog.close();}));$('#workspace-panel-title').textContent='Rename conversation';if(!dialog.open)dialog.showModal();});
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
  }catch{status('Workspace connection is unavailable. No automatic retry or alternate account was used.');return false;}finally{startupComplete=true;}
 })();
 window.EchoPrimeWorkspace={ready,get enabled(){return state.enabled;},get session(){return transport.session;},get chat(){return state.chat;},get data(){return state.data;},get view(){return state.view;},request(path,body,signal){return transport.request(path,body,signal);},presentView:options=>presentView(options),showConversation,layout:{get:()=>({floating:esh.floating,rect:{...esh.rect}}),set:value=>{if(!value||typeof value!=='object')return;if(typeof value.floating==='boolean')esh.floating=value.floating;for(const key of ['x','y','width','height'])if(typeof value.rect?.[key]==='number'&&Number.isFinite(value.rect[key]))esh.rect[key]=value.rect[key];applyESH();}},get generalMode(){return state.enabled&&$('#workspace-chat-kind').value==='workspace';},send,newChat,open,ownerHeaders,invalidate(){transport.clear();},cancel(){state.turn?.abort();}};
})();
