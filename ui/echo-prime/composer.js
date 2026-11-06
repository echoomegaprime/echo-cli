(() => {
 'use strict';
 // Composer parity with the private Workspace: attach chips, context meter,
 // Memory chip, hands-free Voice button, message actions, code-block saves,
 // Personality select and checkpoint banner. It reads Workspace state only
 // through window.EchoPrimeWorkspace.bridge and never stores anything locally.
 const $=selector=>document.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const number=value=>Number(value).toLocaleString('en-US');
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(key==='value')node.value=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }
 const chatChars=chat=>typeof chat?.context_chars==='number'&&Number.isFinite(chat.context_chars)?chat.context_chars:(chat?.messages||[]).reduce((n,m)=>n+(typeof m?.content==='string'?m.content.length:0),0);
 // Same arithmetic as the Workspace: the last model_usage after any checkpoint is
 // measured; otherwise four characters per token across saved context + draft.
 function contextMeter(input){
  const capacity=Number(input?.capacity);
  if(!(capacity>0))return null;
  const draft=String(input.draft||''),events=Array.isArray(input.events)?input.events:[];let usage=null;
  for(let i=events.length-1;i>=0;i--){
   const event=events[i];if(event?.kind==='compacted')break;
   if(event?.kind==='model_usage'){try{usage=JSON.parse(event.content);}catch{usage=null;}break;}
  }
  const prompt=Number(usage?.prompt_tokens),measured=usage!==null&&typeof usage==='object'&&usage.prompt_tokens!==undefined&&Number.isFinite(prompt)&&prompt>=0;
  const draftTokens=Math.ceil(draft.length/4);
  const used=Math.max(0,measured?prompt+(Number(usage.completion_tokens)||0)+draftTokens:Math.ceil(((Number(input.contextChars)||0)+(Number(input.baseChars)||0)+draft.length)/4));
  const percent=Math.max(0,Math.min(100,used/capacity*100)),basis=measured?(draft?'last turn + draft estimate':'measured last turn'):'estimate';
  return {used,capacity,percent,measured,basis,text:`${number(used)} / ${number(capacity)} · ${percent.toFixed(1)}% · ${basis}`,
   title:measured?'Last measured prompt includes instructions, memories, attached files and tool definitions. A draft is estimated at four characters per token.':'Estimate includes saved messages, workspace instructions and your draft. Retrieved memory and attachments are measured when sent.'};
 }
 function splitBlocks(text){
  const value=String(text??''),parts=value.split('```');
  if(parts.length%2===0)return value?[{type:'text',text:value}]:[];
  const blocks=[];
  parts.forEach((part,index)=>{
   if(index%2){const newline=part.indexOf('\n'),language=newline<0?'':part.slice(0,newline).trim(),code=newline<0?part:part.slice(newline+1).replace(/\n$/,'');blocks.push({type:'code',language,text:code});}
   else{const prose=part.replace(/^\n+|\n+$/g,'');if(prose.trim())blocks.push({type:'text',text:prose});}
  });
  return blocks;
 }
 const extensions={python:'py',javascript:'js',typescript:'ts',powershell:'ps1',bash:'sh',json:'json',html:'html',css:'css',rust:'rs',markdown:'md'};
 function fileNameFor(language){const key=String(language||'').trim().toLowerCase();return 'note.'+(extensions[key]||(/^[a-z]{1,6}$/.test(key)?key:'txt'));}
 const credentialName=/(?:^\.env|id_rsa|id_ed25519|credentials?|secrets?|\.(?:pem|key|pfx|db)$)/i;
 // The rail colours the bar by how full the window is: ok below 70%, high from 70%, critical from 90%.
 const meterLevel=percent=>percent>=90?'critical':percent>=70?'high':'ok';
 window.EchoPrimeComposer={contextMeter,meterLevel,chatChars,splitBlocks,fileNameFor};

 function notify(text){const node=$('#draft-notice');if(node){node.textContent=String(text).slice(0,600);node.hidden=false;}}
 function makeDialog(kind,title){
  const body=el('div',{class:'composer-dialog-body'}),state=el('p',{role:'status'}),close=el('button',{type:'button',class:'icon-button','aria-label':'Close'},'✕');
  const dialog=el('dialog',{class:'panel-dialog workspace-dialog composer-dialog','data-composer-dialog':kind,'aria-label':title},el('div',{class:'dialog-title'},el('h2',{},title),close),state,body);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  document.body.append(dialog);return {dialog,body,state};
 }
 function action(label,run,className='quiet-button'){
  const b=bridge(),epoch=b?.state.accountEpoch,node=el('button',{type:'button',class:className},label);
  node.addEventListener('click',async()=>{
   const now=bridge();if(!now||now.state.accountEpoch!==epoch||node.disabled)return;
   node.disabled=true;
   try{await run(now);}catch(error){notify(error instanceof Error?error.message:'That action could not be completed. No automatic retry was made.');}
   finally{node.disabled=false;}
  });
  return node;
 }

 let built=false,ui={};
 // ---- save to library -------------------------------------------------
 function saveDialog(content,language){
  const b=bridge();if(!b)return;
  if(!ui.saveDialog){
   const name=el('input',{type:'text','data-field':'name',maxlength:'120',autocomplete:'off'}),text=el('textarea',{rows:'12',maxlength:'500000','data-field':'content',spellcheck:'false'});
   const made=makeDialog('save','Save to your library');ui.saveDialog={...made,name,text};
   const submit=action('Save to your library',async now=>{
    const fileName=name.value.trim(),value=text.value;
    if(!fileName||credentialName.test(fileName)){made.state.textContent='Choose a file name that is not a credential file. Credentials belong in the Vault.';return;}
    if(!value.trim()||value.length>500000){made.state.textContent='Enter between 1 and 500,000 characters.';return;}
    const chat=now.state.chat,item=await now.api('/library',{name:fileName,content:value,chat_id:chat?.id,project_id:chat?.project_id||$('#workspace-project')?.value||null});
    await now.refresh();notify('Saved to your library'+(item?.path?' · '+item.path:'.'));made.dialog.close();
   },'new-chat');
   made.body.append(el('label',{class:'workspace-field'},el('span',{},'Filename'),name),el('label',{class:'workspace-field'},el('span',{},'Content'),text),el('p',{class:'composer-note'},'The conversation journal records the saved file, its path and its contents.'),submit);
   made.dialog.addEventListener('close',()=>{name.value='';text.value='';made.state.textContent='';});
  }
  const d=ui.saveDialog;d.name.value=fileNameFor(language);d.text.value=content;d.state.textContent='';d.dialog.showModal();
 }
 // ---- attach ------------------------------------------------------------
 function paintAttachChoices(b,body,dialog){
  const files=(b.state.data?.library||[]).slice(0,100);
  const uploads=(window.EchoPrimeLibrary?.uploads?.()||[]).slice(0,100);
  body.replaceChildren(el('p',{class:'composer-note'},'Selected file and upload contents are included in your next message.'));
  if(typeof window.EchoPrimeLibrary?.open==='function'){
   body.append(action('Open Library & upload files',()=>{dialog.close();void window.EchoPrimeLibrary.open('library');}));
  }
  if(!files.length&&!uploads.length)body.append(el('p',{},'Your library is empty. Save a note, code block or upload a file first.'));
  for(const up of uploads){
   const box=el('input',{type:'checkbox','data-file':up.id,'aria-label':'Attach '+(up.name||'upload')});box.checked=b.state.attachments.has(up.id);
   box.addEventListener('change',()=>{const now=bridge();if(!now)return;if(box.checked)now.state.attachments.add(up.id);else now.state.attachments.delete(up.id);now.updateContext();});
   const thumb=up.kind==='image'?el('img',{class:'chip-thumb',src:`/api/prime/uploads/${encodeURIComponent(up.id)}/file?thumb=1`,alt:''}):null;
   body.append(el('label',{class:'file-choice'},box,thumb,el('span',{},String(up.name||'Upload'),el('small',{},`${up.type||'file'} · upload`))));
  }
  for(const file of files){
   const box=el('input',{type:'checkbox','data-file':file.id,'aria-label':'Attach '+(file.name||'file')});box.checked=b.state.attachments.has(file.id);
   box.addEventListener('change',()=>{const now=bridge();if(!now)return;if(box.checked)now.state.attachments.add(file.id);else now.state.attachments.delete(file.id);now.updateContext();});
   body.append(el('label',{class:'file-choice'},box,el('span',{},String(file.name||'File'),el('small',{},String(file.path||'')))));
  }
  body.append(action('Done',()=>dialog.close(),'new-chat'));
 }
 function attachDialog(){
  const b=bridge();if(!b)return;
  if(!ui.attachDialog)ui.attachDialog=makeDialog('attach','Attach from your library');
  const {dialog,body}=ui.attachDialog;
  paintAttachChoices(b,body,dialog);
  dialog.showModal();
  if(typeof window.EchoPrimeLibrary?.refresh==='function'){
   void window.EchoPrimeLibrary.refresh().then(()=>{const now=bridge();if(now&&dialog.open)paintAttachChoices(now,body,dialog);}).catch(()=>{});
  }
 }
 function renderChips(b){
  const chips=[...(b.state.attachments||[])].map(id=>{
   const file=(b.state.data?.library||[]).find(item=>item.id===id);
   const upload=!file?window.EchoPrimeLibrary?.uploadById?.(id):null;
   const labelName=file?.name||upload?.name||'File';
   const chip=action(labelName+' ×',now=>{now.state.attachments.delete(id);now.updateContext();
    // The "Attached <file> to your next message." notice goes with the file it names.
    const notice=$('#draft-notice');if(notice&&notice.textContent==='Attached '+labelName+' to your next message.'){notice.textContent='';notice.hidden=true;}},'chip');
   if(upload?.kind==='image'){
    const img=el('img',{class:'chip-thumb',src:`/api/prime/uploads/${encodeURIComponent(upload.id)}/file?thumb=1`,alt:''});
    if(typeof chip.prepend==='function')chip.prepend(img);else{img.parent=chip;chip.children.unshift(img);}
   }
   chip.setAttribute('aria-label','Remove attachment '+(file?.name||upload?.name||'file'));return chip;
  });
  ui.chips.replaceChildren(...chips);ui.chips.hidden=!chips.length;
 }
 // ---- messages -----------------------------------------------------------
 function messageActions(article,row,b){
  const actions=el('div',{class:'message-actions'});
  actions.append(action('Copy',async()=>{if(!navigator.clipboard?.writeText)throw new Error('Clipboard is unavailable in this browser.');await navigator.clipboard.writeText(row.content);notify('Copied.');}));
  if(row.role==='assistant'){
   actions.append(action('Save to library',()=>saveDialog(row.content,'md')));
   if(row.id&&b.state.data?.voice?.configured===true)actions.append(action('▶ Listen',async now=>{if(window.EchoPrimeSpeech?.speakMessage){void window.EchoPrimeSpeech.speakMessage(row,now.state.chat?.id,{force:true});return;}await now.speakReply(row,now.state.chat?.id);}));
  }
  article.append(actions);
 }
 function decorate(b){
  const log=$('#chat-log'),chat=b.state.chat;if(!log||!chat)return;
  const rows=(chat.messages||[]).filter(m=>m&&['user','assistant'].includes(m.role)).slice(-1000);
  const articles=[...log.children].filter(n=>/\bchat-message\b/.test(n.className)&&/\b(user|assistant)\b/.test(n.className));
  articles.forEach((article,index)=>{
   const row=rows[index],paragraph=article.querySelector('p');
   if(!row||!paragraph||article.dataset.actions||paragraph.textContent!==String(row.content??''))return;
   article.dataset.actions='1';
   if(row.role==='assistant'){
    const blocks=splitBlocks(row.content);
    if(blocks.some(block=>block.type==='code')){
     const body=el('div',{class:'message-body'});
     for(const block of blocks){
      if(block.type==='text')body.append(el('p',{},block.text));
      else body.append(el('div',{class:'code-block'},el('div',{class:'code-head'},el('span',{},block.language||'Code'),action('Save file',()=>saveDialog(block.text,block.language))),el('pre',{},el('code',{},block.text))));
     }
     paragraph.hidden=true;paragraph.after(body);
    }
   }
   messageActions(article,row,b);
  });
 }
 // ---- personality + checkpoint ---------------------------------------------
 function syncPersonality(b){
  const profiles=b.state.data?.personalities||[],signature=profiles.map(p=>p.id+':'+p.name).join('|');
  if(ui.personalitySignature!==signature){
   const options=profiles.some(p=>p.id==='auto')?profiles:[{id:'auto',name:'Auto'},...profiles];
   ui.personality.replaceChildren(...options.map(p=>el('option',{value:p.id},String(p.name||p.id)+(p.registered===false?' · not registered':''))));ui.personalitySignature=signature;
  }
  const events=b.state.chat?.events||[],selected=[...events].reverse().find(e=>e.kind==='personality_selected');
  ui.personality.value=typeof selected?.content==='string'&&selected.content?selected.content:'auto';
  ui.personalityLabel.hidden=!profiles.length;ui.personality.disabled=!b.state.chat?.id;
 }
 function syncCheckpoint(b){
  const summary=typeof b.state.chat?.summary==='string'?b.state.chat.summary:'';
  ui.checkpoint.hidden=!summary;ui.checkpointBody.textContent=summary;
 }
 // ---- main sync -----------------------------------------------------------
 function sync(){
  const b=bridge();if(!b||!built)return;
  const data=b.state.data,voice=data?.voice?.configured===true;
  ui.attach.hidden=!data;ui.memory.hidden=!data;ui.voice.hidden=!voice;
  const handsFree=window.EchoPrimeSpeech?.conversation?.active?.()===true||b.voiceOptions.conversation===true;
  ui.voice.textContent=handsFree?'◉ Voice on':'◉ Voice';ui.voice.setAttribute('aria-pressed',String(handsFree));
  renderChips(b);
  const meter=contextMeter({capacity:data?.context_length,contextChars:chatChars(b.state.chat),baseChars:data?.base_context_chars,draft:$('#prompt')?.value||'',events:b.state.chat?.events});
  ui.meterRow.hidden=!meter;
  if(meter){ui.bar.max=meter.capacity;ui.bar.value=meter.used;ui.bar.setAttribute('aria-valuetext',meter.text);ui.label.textContent=meter.text;ui.meterRow.setAttribute('title',meter.title);ui.meterRow.dataset.level=meterLevel(meter.percent);}
  syncPersonality(b);syncCheckpoint(b);decorate(b);
 }
 function build(b){
  built=true;
  ui.attach=action('＋ Attach',()=>attachDialog(),'quiet-button composer-tool');ui.attach.setAttribute('aria-label','Attach files from your library');
  // speech.js (when loaded) provides the continuous conversation mode; otherwise the bridge's hands-free loop runs.
  ui.voice=action('◉ Voice',async now=>{const speech=window.EchoPrimeSpeech;if(speech?.conversation){await speech.conversation.toggle();return;}if(now.voiceOptions.conversation){await now.stopVoice();return;}await now.startConversation();},'quiet-button composer-tool');
  ui.voice.setAttribute('aria-pressed','false');ui.voice.setAttribute('title','Hands-free voice conversation: explicit opt-in; continues until you stop it.');
  ui.memory=el('span',{class:'memory-chip',title:'Relevant chat history, Crystal, ECF, Arcanum and Knowledge Forge are checked automatically.'},'◈ Memory · automatic');
  $('#composer .composer-bottom .persona')?.after(el('div',{class:'composer-tools'},ui.attach,ui.voice,ui.memory));
  ui.chips=el('div',{class:'attachment-chips',role:'list','aria-label':'Attached files'});ui.chips.hidden=true;$('#prompt')?.before(ui.chips);
  ui.bar=el('progress',{max:'1',value:'0','aria-label':'Context window used'});ui.label=el('span',{'data-context-label':'',role:'status'});
  ui.meterRow=el('div',{class:'context-meter'},ui.bar,ui.label);ui.meterRow.hidden=true;
  const extras=el('div',{id:'composer-extras',class:'composer-extras'},ui.meterRow),contextSlot=$('#rail-context-slot');
  if(contextSlot)contextSlot.append(extras);else $('.composer-caption')?.after(extras);
  ui.personality=el('select',{id:'workspace-personality','data-personality':'','aria-label':'Personality'});ui.personalityLabel=el('label',{},'Personality',ui.personality);ui.personalityLabel.hidden=true;
  ui.personality.addEventListener('change',async()=>{
   const now=bridge(),epoch=now?.state.accountEpoch,chat=now?.state.chat;if(!now||!chat?.id)return;
   try{
    await now.api('/action',{action:'personality_select',chat_id:chat.id,profile:ui.personality.value});
    const fresh=await now.api('/chats/'+encodeURIComponent(chat.id));if(now.state.accountEpoch===epoch)now.setChat(fresh);notify('Personality loaded.');
   }catch(error){notify(error instanceof Error?error.message:'Personality could not be changed.');sync();}
  });
  $('#workspace-context')?.before(ui.personalityLabel);
  ui.checkpointBody=el('div',{class:'prose'});ui.checkpoint=el('details',{class:'checkpoint','data-checkpoint':''},el('summary',{},'Checkpoint active · original history preserved'),ui.checkpointBody);ui.checkpoint.hidden=true;
  $('#chat-log')?.before(ui.checkpoint);
  const hint=$('.keyboard-hint');if(hint)hint.textContent='Enter to send · Shift+Enter for a new line';
  for(const name of ['echo-workspace-context','echo-account-changed','echo-uploads-changed','echo-speech-changed'])window.addEventListener(name,sync);
  b.onStatus(()=>sync());
  window.addEventListener('echo-account-changed',()=>{for(const made of [ui.saveDialog,ui.attachDialog])if(made?.dialog.open)made.dialog.close();});
  sync();
 }
 // ---- Enhance prompt (sparkle) ---------------------------------------------
 // The chat composer's Enhance button, beside Send. media-router.js (a classic script, so it has run before this deferred
 // one) owns the shared control: provider chip, primary-owner gate, Undo, the "what I added" list and the account reset,
 // so the composer and every Studio mode behave the same. Enhance only replaces the draft; it never sends the message.
 function mountEnhance(){
  const router=window.EchoPrimeMediaRouter,composer=$('#composer');
  if(!composer||ui.enhance||typeof router?.mountEnhance!=='function')return;
  const actions=$('#composer .send-actions');
  ui.enhance=router.mountEnhance({name:'composer',textarea:()=>$('#prompt'),mode:()=>router.composerMode(),
   mount(wrap,note,added){
    const send=actions?.querySelector('.send');
    if(send)send.before(wrap);else if(actions)actions.append(wrap);else composer.append(wrap);
    const anchor=$('#enhance-composer-notice')||$('.composer-caption');
    if(anchor)anchor.after(note,added);else composer.append(note,added);
   }});
 }
 try{mountEnhance();}catch(error){console.debug('[echo.enhance]',{schema_version:1,event:'prime_enhance_mount_failed',reason:error instanceof Error?error.message:'failed'});}
 (async()=>{
  try{
   const workspace=window.EchoPrimeWorkspace;if(!workspace||!await workspace.ready||!workspace.enabled)return;
   const b=bridge();if(b)build(b);
  }catch{}
 })();
})();
