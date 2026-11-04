(() => {
 'use strict';
 // Persistent voice controls under the composer. Shown only when the Workspace
 // backend reports voice.configured === true. Every label comes from the backend
 // voice status; nothing is read from or written to browser storage, so spoken
 // replies, brief speech and automatic sends start off in every session.
 const $=selector=>document.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const providerNames={elevenlabs:'ElevenLabs','elevenlabs-scribe':'ElevenLabs Scribe'};
 const providerName=id=>typeof id==='string'&&id?providerNames[id.toLowerCase()]||id:'';
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }
 function model({voice,options,capture,micPending,speaking}){
  if(!voice||voice.configured!==true)return {visible:false};
  const label=[voice.label,voice.persona].find(value=>typeof value==='string'&&value.trim()),provider=providerName(voice.provider);
  const mic=capture?'Listening':micPending?'Transcribing · Microphone off':'Microphone off';
  const line=[label?label.trim():'Configured voice',provider,speaking?'Speaking':'',mic].filter(Boolean).join(' · ');
  const usage=typeof voice.provider_usage==='string'&&voice.provider_usage.trim()?voice.provider_usage.trim():provider?`Spoken text and your selected audio use ${provider}.`:'Spoken text and your selected audio use the configured provider.';
  const flag=key=>options?.[key]===true;
  return {visible:true,line,footer:'Personality Forge · '+usage,toggles:{spoken:flag('spoken'),brief:flag('brief'),autoSend:flag('autoSend')},conversation:flag('conversation'),limitReached:flag('limitReached')};
 }
 window.EchoPrimeVoiceBar={model,providerName};

 let ui=null;
 function snapshot(b){return model({voice:b.state.data?.voice,options:b.voiceOptions,capture:b.state.capture,micPending:b.state.micPending,speaking:!!b.state.speech});}
 function say(text){if(ui)ui.message.textContent=String(text||'').slice(0,400);}
 function sync(){
  const b=bridge();if(!b||!ui)return;
  const view=snapshot(b);ui.root.hidden=!view.visible;b.state.voiceBar=view.visible;
  if(!view.visible)return;
  ui.line.textContent=view.line;ui.footer.textContent=view.footer;
  for(const [key,box] of Object.entries(ui.boxes))box.checked=view.toggles[key];
  ui.note.textContent=view.limitReached?'Voice conversation paused after ten turns. Use ◉ Voice to resume explicitly.':view.conversation?'Hands-free voice is on: at most ten captured turns.':'';
 }
 function control(label,run){
  const b=bridge(),epoch=b?.state.accountEpoch,node=el('button',{type:'button',class:'quiet-button'},label);
  node.addEventListener('click',async()=>{
   const now=bridge();if(!now||now.state.accountEpoch!==epoch||node.disabled)return;
   node.disabled=true;
   try{await run(now);say('');}catch(error){say(error instanceof Error?error.message:'Voice action could not be completed. No automatic retry was made.');}
   finally{node.disabled=false;sync();}
  });
  return node;
 }
 function toggle(key,label){
  const box=el('input',{type:'checkbox','data-voice-option':key});
  box.addEventListener('change',()=>{
   const b=bridge();if(!b)return;
   b.voiceOptions[key]=box.checked===true;
   if(key==='spoken'&&!box.checked){b.endConversation();b.stopAudio();}
   sync();
  });
  return {box,node:el('label',{class:'check'},box,label)};
 }
 function build(){
  const spoken=toggle('spoken','Spoken replies'),brief=toggle('brief','Brief speech'),auto=toggle('autoSend','Send speech automatically');
  ui={boxes:{spoken:spoken.box,brief:brief.box,autoSend:auto.box},
   line:el('small',{'data-voice-line':'',role:'status'}),message:el('small',{'data-voice-message':'',role:'status',class:'voice-message'}),note:el('small',{class:'voice-note'}),footer:el('small',{class:'muted'})};
  ui.root=el('div',{class:'voice-bar','data-voice-bar':'','aria-label':'Voice controls'},
   el('div',{class:'voice-controls'},control('Interrupt & speak',now=>now.interrupt()),control('Stop voice',now=>now.stopVoice()),spoken.node,brief.node,auto.node),
   ui.line,ui.message,ui.note,ui.footer);
  ui.root.hidden=true;
  ($('#composer-extras')||$('.composer-caption'))?.after(ui.root);
  const b=bridge();
  for(const name of ['echo-workspace-context','echo-account-changed'])window.addEventListener(name,()=>{if(name==='echo-account-changed')say('');sync();});
  b.onStatus(text=>{say(text);sync();});
  sync();
 }
 (async()=>{
  try{
   const workspace=window.EchoPrimeWorkspace;if(!workspace||!await workspace.ready||!workspace.enabled||!bridge())return;
   build();
  }catch{}
 })();
})();
