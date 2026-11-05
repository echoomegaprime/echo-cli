(() => {
 'use strict';
 // Persistent voice controls under the composer. Shown only when the Workspace
 // backend reports voice.configured === true. Every label comes from the backend
 // voice status. Brief speech and automatic sends are remembered per signed-in
 // account in localStorage (try/catch, two booleans, nothing else); spoken
 // replies and hands-free voice are never stored and start off in every session.
 const $=selector=>document.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const providerNames={elevenlabs:'ElevenLabs','elevenlabs-scribe':'ElevenLabs Scribe'};
 const providerName=id=>typeof id==='string'&&id?providerNames[id.toLowerCase()]||id:'';
 const storageKey='echo-prime-voice-v1',persisted=['brief','autoSend'],maxAccounts=16;
 function readStore(){try{const value=JSON.parse(localStorage.getItem(storageKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
 function savedFor(uid){const entry=readStore()[uid],out={};for(const key of persisted)out[key]=entry?.[key]===true;return out;}
 function remember(uid,options){
  const store=readStore();delete store[uid];store[uid]={brief:options?.brief===true,autoSend:options?.autoSend===true};
  for(const key of Object.keys(store).slice(0,Math.max(0,Object.keys(store).length-maxAccounts)))delete store[key];
  try{localStorage.setItem(storageKey,JSON.stringify(store));return true;}catch{return false;}
 }
 const uidOf=b=>{const session=b?.session;const uid=session?.user?.uid;return session?.authenticated===true&&typeof uid==='string'&&uid?uid:null;};
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
 window.EchoPrimeVoiceBar={model,providerName,storageKey,persisted,savedFor,remember};

 let ui=null,known=null;// {uid,brief,autoSend}: the saved toggles applied to the current account
 function snapshot(b){return model({voice:b.state.data?.voice,options:b.voiceOptions,capture:b.state.capture,micPending:b.state.micPending,speaking:!!b.state.speech});}
 function say(text){if(ui)ui.message.textContent=String(text||'').slice(0,400);}
 // Restore the two remembered toggles once per signed-in account (after workspace.js has reset
 // every option on the identity change), then write them back whenever either one changes.
 function persistence(b){
  const uid=uidOf(b);if(!uid){known=null;return;}
  if(known?.uid!==uid){const saved=savedFor(uid);for(const key of persisted)b.voiceOptions[key]=saved[key];known={uid,...saved};return;}
  if(persisted.some(key=>known[key]!==(b.voiceOptions[key]===true))){for(const key of persisted)known[key]=b.voiceOptions[key]===true;remember(uid,known);}
 }
 function sync(){
  const b=bridge();if(!b||!ui)return;
  persistence(b);
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
  for(const name of ['echo-workspace-context','echo-account-changed'])window.addEventListener(name,()=>{if(name==='echo-account-changed'){say('');known=null;}sync();});
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
