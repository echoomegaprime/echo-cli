(() => {
 'use strict';
 // Auto media routing + Enhance prompt. Server decides the pick (POST /api/prime/media/route) and the enhancement
 // (POST /api/prime/enhance); this file only shows the pick with its reason, lets the user override it explicitly,
 // offers the next-best tool after a failure (never switches by itself), and replaces composer text with an Undo.
 // Nothing here sends a message or submits a generation: the Studio's review-then-execute path stays the only spend path.
 const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
 const MODE_OF={Chat:'chat',Image:'image',Video:'video',Music:'music','Sound FX':'sfx',Voice:'voice',Auto:'auto'};
 const CATEGORY_MODE={image:'image',video:'video',music:'music',sound:'sfx',voice:'voice',tools:'chat',all:'auto',auto:'auto'};
 const PREFERENCE=['claude','gpt','grok','argon','qwen'];
 const LABELS={qwen:'Qwen',claude:'Claude',gpt:'GPT',grok:'Grok',argon:'Gemini (Argon)'};
 let generation=0,autoMode=false,passthrough=false,composerMode='Chat',report=null,reportState='loading',provider=null,lastRoute=null,routing=null,busy=false;
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(key==='value')node.value=value;else if(value!==false&&value!==undefined&&value!==null)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);
  return node;
 }
 function debug(scope,event,detail){console.debug('[echo.'+scope+']',{schema_version:1,event,...(detail||{})});}
 async function headers(){try{return window.EchoPrimeWorkspace&&window.EchoPrimeWorkspace.ownerHeaders?await window.EchoPrimeWorkspace.ownerHeaders():{};}catch{return {};}}
 function admission(){
  const ws=window.EchoPrimeWorkspace;if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 async function api(path,data,timeoutMs){
  const current=generation,sent={'X-Prime-Request':'1',...await headers(),'Content-Type':'application/json'};
  if(current!==generation)throw new Error('Account session changed.');
  if(!/^https?:$/.test(location.protocol))throw new Error('Open ECHO Prime through its local host to connect. This file is an offline preview.');
  const response=await fetch('/api/'+path,{method:'POST',credentials:'same-origin',headers:sent,body:JSON.stringify(data),signal:AbortSignal.timeout(timeoutMs||30000)});
  const type=response.headers&&response.headers.get?response.headers.get('content-type')||'':'';
  if(!type.includes('application/json'))throw new Error('The authorized ECHO host is not connected.');
  const value=await response.json();
  if(current!==generation)throw new Error('Account session changed.');
  if(!response.ok){
   if((response.status===401||response.status===403)&&admission()==='owner'&&window.EchoPrimeWorkspace&&typeof window.EchoPrimeWorkspace.invalidate==='function')window.EchoPrimeWorkspace.invalidate();
   throw new Error(value&&value.error||'Request failed');
  }
  return value;
 }
 const describe=model=>{
  if(!model||typeof model!=='object')return 'model not reported';
  if(typeof model.model==='string'&&model.model)return model.model;
  return 'model not reported by '+(typeof model.label==='string'?model.label:String(model.id||'provider'))+(model.requested?' (requested: '+model.requested+')':'');
 };

 // ---- models report (which providers may enhance) ----------------------------------------------------------------
 async function loadModels(){
  const current=generation,ws=window.EchoPrimeWorkspace;
  if(ws)await Promise.resolve(ws.ready).catch(()=>{});
  if(current!==generation)return;
  const access=admission();
  if(access==='signin'||access==='member'){report=null;reportState=access;renderEnhance();return;}
  try{
   const response=await fetch('/api/prime/models',{credentials:'same-origin',headers:{'X-Prime-Request':'1',...await headers()}});
   const data=await response.json();
   if(current!==generation)return;
   if(!response.ok||!data||!Array.isArray(data.providers))throw new Error('status');
   report=data;reportState='ready';
   const available=providers().filter(p=>p.available);
   if(!provider||!available.some(p=>p.id===provider))provider=(PREFERENCE.map(id=>available.find(p=>p.id===id)).find(Boolean)||available[0]||{id:null}).id;
   debug('enhance','models_loaded',{routing:data.routing===true,available:available.map(p=>p.id),provider});
  }catch{if(current!==generation)return;report=null;reportState='failed';}
  renderEnhance();
 }
 function providers(){
  if(!report||report.routing!==true)return [];
  return report.providers.filter(p=>p&&typeof p.id==='string'&&LABELS[p.id]).map(p=>({id:p.id,label:LABELS[p.id],available:p.available!==false,reason:typeof p.reason==='string'?p.reason:''}));
 }
 function enhanceGate(){
  if(reportState==='signin')return 'Sign in to enhance prompts.';
  if(reportState==='member')return 'Prompt enhancement is available to the primary owner only.';
  if(reportState==='failed')return 'Model status unavailable; nothing is sent to a model until it answers.';
  if(reportState==='loading')return 'Checking models…';
  if(!report||report.routing!==true)return 'Prompt enhancement needs the reviewed models section of the Prime configuration.';
  if(!provider)return 'No enhancement provider is available right now; no other model is used.';
  return '';
 }

 // ---- Enhance control --------------------------------------------------------------------------------------------
 const enhancers=[];
 function mountEnhance(options){
  const button=el('button',{type:'button',class:'quiet-button enhance-button','data-enhance':options.name,'aria-label':'Enhance prompt'},'✨ Enhance');
  const select=el('select',{class:'enhance-provider','data-enhance-provider':options.name,'aria-label':'Enhance with'});
  const undo=el('button',{type:'button',class:'enhance-undo','data-enhance-undo':options.name},'Undo enhance');undo.hidden=true;
  const note=el('small',{class:'enhance-note',role:'status','aria-live':'polite','data-enhance-note':options.name});note.hidden=true;
  const added=el('ul',{class:'enhance-added','data-enhance-added':options.name});added.hidden=true;
  const wrap=el('div',{class:'enhance-wrap'},button,select,undo);
  options.mount(wrap,note,added);
  const state={options,button,select,undo,note,added,previous:null};
  select.addEventListener('change',()=>{if(providers().some(p=>p.id===select.value&&p.available)){provider=select.value;renderEnhance();}});
  button.addEventListener('click',()=>run(state));
  undo.addEventListener('click',()=>{
   if(state.previous===null)return;
   const area=options.textarea();if(!area)return;
   area.value=state.previous;state.previous=null;area.dispatchEvent(new Event('input'));
   undo.hidden=true;added.hidden=true;added.replaceChildren();note.hidden=false;note.textContent='Restored your original prompt.';
   debug('enhance','prime_enhance_undo',{surface:options.name});
  });
  enhancers.push(state);return state;
 }
 function renderEnhance(){
  const gate=enhanceGate(),list=providers();
  for(const s of enhancers){
   s.select.replaceChildren(...list.map(p=>{const option=el('option',{value:p.id},p.label+(p.available?'':' (unavailable)'));option.disabled=!p.available;return option;}));
   if(provider)s.select.value=provider;
   s.select.hidden=!list.length;s.select.disabled=!!gate||busy;
   s.button.disabled=!!gate||busy;
   s.button.title=gate||'Improve this prompt with '+(LABELS[provider]||'the selected model')+'. The text is replaced; nothing is sent.';
   s.button.textContent=busy&&s.busy?'✨ Enhancing…':'✨ Enhance';
   if(gate&&!s.previous){s.note.hidden=false;s.note.textContent=gate;}
  }
 }
 async function run(state){
  if(busy)return;
  const gate=enhanceGate();if(gate){state.note.hidden=false;state.note.textContent=gate;return;}
  const area=state.options.textarea(),text=area?area.value.trim():'';
  if(!text){state.note.hidden=false;state.note.textContent='Type a prompt first.';return;}
  if(text.length>4000){state.note.hidden=false;state.note.textContent='Enhance takes up to 4,000 characters; shorten the prompt first.';return;}
  const mode=state.options.mode(),chosen=provider,current=generation;
  busy=true;state.busy=true;renderEnhance();state.note.hidden=false;state.note.textContent='Asking '+(LABELS[chosen]||chosen)+' to enhance this '+(mode==='auto'?'prompt':mode+' prompt')+'…';
  try{
   const result=await api('prime/enhance',{mode,text,provider:chosen},125000);
   if(current!==generation)return;
   if(!result||typeof result.text!=='string'||!result.text.trim())throw new Error('The provider returned no text; nothing was changed.');
   const live=state.options.textarea();if(!live)return;
   if(live.value.trim()!==text){state.note.textContent='The prompt changed while enhancing; nothing was replaced. Press Enhance again.';return;}
   state.previous=live.value;live.value=result.text;live.dispatchEvent(new Event('input'));
   state.undo.hidden=false;
   const list=Array.isArray(result.added)?result.added.filter(a=>typeof a==='string'&&a.trim()).slice(0,20):[];
   state.added.replaceChildren(...list.map(a=>el('li',{},a)));state.added.hidden=!list.length;
   state.note.textContent='Enhanced by '+(result.providerLabel||LABELS[result.provider]||result.provider)+' · '+describe(result.model)+(result.mode?' · as a '+result.mode+' prompt':'')+(list.length?' · added '+list.length+(list.length===1?' thing':' things')+' (listed below)':' · no additions reported')+'. Nothing was sent; review and press Send yourself.';
   debug('enhance','prime_enhance_applied',{surface:state.options.name,mode:result.mode,provider:result.provider,model:result.model&&result.model.model,added:list.length});
  }catch(error){
   if(current!==generation)return;
   state.note.textContent=(error instanceof Error?error.message:'Enhance failed')+' Your prompt was not changed.';
   debug('enhance','prime_enhance_failed',{surface:state.options.name,mode});
  }finally{if(current===generation){busy=false;state.busy=false;renderEnhance();}}
 }

 // ---- Auto mode in the composer -------------------------------------------------------------------------------------
 const tabs=$('.mode-tabs'),prompt=$('#prompt'),composer=$('#composer');
 const autoTab=el('button',{type:'button',role:'tab','aria-selected':'false','data-mode':'Auto',title:'Describe anything; Echo picks the best tool and shows why'},'Auto');
 const composerNotice=el('p',{id:'enhance-composer-notice',class:'draft-notice',role:'status','aria-live':'polite'});composerNotice.hidden=true;
 function setAuto(on){
  autoMode=on;
  autoTab.classList.toggle('selected',on);autoTab.setAttribute('aria-selected',String(on));
  if(on){for(const b of $$('.mode-tabs button'))if(b!==autoTab){b.classList.remove('selected');b.setAttribute('aria-selected','false');}
   if(prompt)prompt.placeholder='Describe anything to create — Echo picks the tool and shows why…';composerMode='Auto';}
  if(prompt)prompt.dataset.autoMode=on?'1':'';
 }
 if(tabs){
  tabs.prepend(autoTab);
  for(const b of $$('.mode-tabs button'))if(b!==autoTab)b.addEventListener('click',()=>{composerMode=b.dataset.mode||'Chat';setAuto(false);});
  autoTab.addEventListener('click',()=>{setAuto(true);if(prompt)prompt.focus();});
 }
 function notice(text){composerNotice.hidden=!text;composerNotice.textContent=text||'';}
 async function routeFromComposer(form){
  const text=prompt?prompt.value.trim():'';
  if(!text){if(prompt)prompt.focus();return;}
  const current=generation;
  if(routing)return;routing=true;notice('Choosing the best tool for this prompt…');
  try{
   const r=await api('prime/media/route',{text,mode:'auto',fallback:'chat'},45000);
   if(current!==generation)return;
   debug('media','media_route',{surface:'composer',kind:r.classification&&r.classification.kind,confidence:r.classification&&r.classification.confidence,picked:r.picked?r.picked.id:null,alternatives:(r.alternatives||[]).length});
   if(r.classification&&r.classification.kind==='chat'){
    notice('Treated as a chat message ('+Math.round((r.classification.confidence||0)*100)+'% sure). Pick Image, Video, Music, Sound FX or Voice to create something instead.');
    passthrough=true;try{form.requestSubmit();}finally{passthrough=false;}
    return;
   }
   notice('');
   if(window.EchoPrimeStudio&&typeof window.EchoPrimeStudio.open==='function')window.EchoPrimeStudio.open('auto',text,r);
  }catch(error){if(current===generation)notice((error instanceof Error?error.message:'Routing failed')+' Nothing was sent.');}
  finally{if(current===generation)routing=false;}
 }
 // Capture phase on the document runs before the composer's own submit handler, so Auto can take the turn without editing app.js.
 document.addEventListener('submit',event=>{
  if(!autoMode||passthrough||!composer||event.target!==composer)return;
  event.preventDefault();event.stopPropagation();if(event.stopImmediatePropagation)event.stopImmediatePropagation();
  void routeFromComposer(composer);
 },true);
 const caption=$('.composer-caption');if(caption)caption.after(composerNotice);

 // ---- Creative Studio: Auto panel --------------------------------------------------------------------------------------
 const studio=window.EchoPrimeStudio,tools=$('#creative-tools'),category=$('#creative-category'),brief=$('#creative-prompt');
 const panel=el('div',{id:'media-auto',class:'media-auto','data-media-auto':''});panel.hidden=true;
 const status=el('p',{class:'media-status',role:'status','aria-live':'polite'});
 const pickBox=el('div',{class:'media-pick','data-media-pick':''});pickBox.hidden=true;
 const alternatives=el('div',{class:'media-alternatives',role:'list','data-media-alternatives':''});alternatives.hidden=true;
 const failure=el('div',{class:'media-failure',role:'alert','data-media-failure':''});failure.hidden=true;
 const repick=el('button',{type:'button',class:'quiet-button','data-media-repick':''},'Pick again for this brief');
 const toggle=el('button',{type:'button',class:'quiet-button','data-media-alternatives-toggle':'','aria-expanded':'false'},'Use a different tool');
 const actions=el('div',{class:'media-actions'},toggle,repick);
 panel.append(status,pickBox,actions,alternatives,failure);
 if(tools)tools.before(panel);
 toggle.addEventListener('click',()=>{alternatives.hidden=!alternatives.hidden;toggle.setAttribute('aria-expanded',String(!alternatives.hidden));});
 repick.addEventListener('click',()=>{void routeInStudio(brief?brief.value.trim():'',null);});
 const badge=(text,cls)=>el('span',{class:'media-badge'+(cls?' '+cls:'')},text);
 function applyPick(pick,how){
  if(!studio||typeof studio.apply!=='function')return false;
  const ok=studio.apply({id:pick.id,arguments:pick.request&&pick.request.arguments});
  if(ok){lastRoute.applied=pick;debug('media','media_pick_applied',{id:pick.id,how});}
  return ok;
 }
 function renderPick(r){
  pickBox.replaceChildren();alternatives.replaceChildren();failure.hidden=true;failure.replaceChildren();
  const c=r.classification||{},kind=c.kind||'unknown',sure=Math.round((c.confidence||0)*100);
  const alts=Array.isArray(r.alternatives)?r.alternatives:[],excluded=Array.isArray(r.excluded)?r.excluded:[];
  if(r.picked){
   const p=r.picked;
   pickBox.hidden=false;
   pickBox.append(el('strong',{},p.label+' · '+p.provider),el('p',{class:'media-reason'},p.reason),
    el('div',{class:'media-badges'},badge(kind+' · '+sure+'% sure'+(c.styles&&c.styles.length?' · '+c.styles.join(', '):'')),badge('health '+p.health+(p.healthSource==='probe'?' (probed)':p.healthSource==='snapshot'?' (snapshot)':''),'health-'+p.health),badge(p.costNote),badge('quality '+p.quality+'/10 · speed '+p.speed+'/10'),...(p.argumentShape==='unmodeled'?[badge('review request details','health-unknown')]:[])));
   status.textContent='Auto picked a tool for this '+kind+' brief. Review the request below, then submit it yourself; nothing runs until you do.';
   if(!applyPick(p,'auto'))status.textContent+=' (The tool is not in this catalog view; search the live registry.)';
  }else{
   pickBox.hidden=true;
   status.textContent=r.reason||'Nothing was picked.';
  }
  toggle.hidden=!alts.length;toggle.textContent=r.picked?'Use a different tool ('+alts.length+')':'Tools for this ('+alts.length+')';
  alternatives.hidden=!(alts.length&&!r.picked);toggle.setAttribute('aria-expanded',String(!alternatives.hidden));
  for(const a of alts){
   const b=el('button',{type:'button',class:'media-alternative',role:'listitem','data-media-alternative':a.id},el('strong',{},a.label+' · '+a.provider),el('span',{},'health '+a.health+' · '+a.costNote+' · '+a.quality+'/10'),el('small',{},a.reason));
   b.addEventListener('click',()=>{if(applyPick(a,'override')){status.textContent='You chose '+a.label+'. Review the request below, then submit it yourself.';lastRoute.picked=a;}});
   alternatives.append(b);
  }
  if(excluded.length)alternatives.append(el('ul',{class:'media-excluded'},...excluded.map(x=>el('li',{},x.label+': '+x.reason))));
 }
 async function routeInStudio(text,route){
  const current=generation;
  panel.hidden=false;
  if(!text){status.textContent='Type a brief above and Auto picks the best tool for it.';pickBox.hidden=true;alternatives.hidden=true;toggle.hidden=true;failure.hidden=true;return;}
  if(routing&&!route)return;
  if(route){lastRoute=route;renderPick(route);return;}
  routing=true;status.textContent='Choosing the best tool…';
  try{
   const r=await api('prime/media/route',{text,mode:'auto',fallback:'image'},45000);
   if(current!==generation)return;
   lastRoute=r;renderPick(r);
   debug('media','media_route',{surface:'studio',kind:r.classification&&r.classification.kind,picked:r.picked?r.picked.id:null,alternatives:(r.alternatives||[]).length,probed:r.probe?r.probe.probed.length:0});
  }catch(error){if(current===generation)status.textContent=(error instanceof Error?error.message:'Routing failed')+' Pick a tool from the list below instead.';}
  finally{if(current===generation)routing=false;}
 }
 if(studio&&typeof studio.open==='function'){
  const originalOpen=studio.open;
  studio.open=function(cat='all',text='',route){
   const auto=cat==='auto'||cat==='all';
   originalOpen.call(studio,auto?'auto':cat,text);
   if(auto)void routeInStudio(String(text||'').trim(),route||null);else panel.hidden=true;
  };
 }
 if(category)category.addEventListener('change',()=>{panel.hidden=category.value!=='auto';if(category.value==='auto')void routeInStudio(brief?brief.value.trim():'',lastRoute&&brief&&lastRoute.text===brief.value.trim()?lastRoute:null);});
 // A failed or uncertain submission of the auto pick: show it and offer the next best as an explicit choice. No automatic switch.
 window.addEventListener('echo-studio-executed',event=>{
  const d=event&&event.detail||{};
  if(!lastRoute||!lastRoute.picked||d.name!==lastRoute.picked.id||!['blocked','uncertain'].includes(d.state))return;
  const next=(lastRoute.alternatives||[]).find(a=>a.id!==lastRoute.picked.id);
  failure.hidden=false;failure.replaceChildren(el('p',{},lastRoute.picked.label+' did not complete ('+d.state+'): '+(d.detail||'no detail')+'. Nothing was retried.'));
  if(next){
   const use=el('button',{type:'button',class:'quiet-button','data-media-next':next.id},'Use '+next.label+' instead');
   use.addEventListener('click',()=>{if(applyPick(next,'after-failure')){lastRoute.picked=next;lastRoute.alternatives=lastRoute.alternatives.filter(a=>a.id!==next.id);failure.hidden=true;status.textContent='Switched to '+next.label+' at your request. Review the request below, then submit it yourself.';}});
   failure.append(el('p',{},'Next best: '+next.label+' · '+next.provider+' · '+next.reason),use);
  }else failure.append(el('p',{},'No other healthy tool is listed for this kind.'));
  debug('media','media_pick_failed',{id:d.name,state:d.state,next:next?next.id:null});
 });

 // ---- mount the two Enhance controls ----------------------------------------------------------------------------------
 if(composer){
  const sendActions=$('#composer .send-actions');
  mountEnhance({name:'composer',textarea:()=>$('#prompt'),mode:()=>autoMode?'auto':(MODE_OF[composerMode]||'chat'),
   mount(wrap,note,added){if(sendActions){const send=sendActions.querySelector('.send');if(send)send.before(wrap);else sendActions.append(wrap);}else composer.append(wrap);composerNotice.after(note,added);}});
 }
 if(brief){
  mountEnhance({name:'studio',textarea:()=>$('#creative-prompt'),mode:()=>{const cat=category?category.value:'auto';if(cat==='auto'||cat==='all'){const k=lastRoute&&lastRoute.classification&&lastRoute.classification.kind;return k&&k!=='chat'&&k!=='image-edit'?k:k==='image-edit'?'image':'auto';}return CATEGORY_MODE[cat]||'auto';},
   mount(wrap,note,added){const row=$('.creative-actions');if(row)row.append(wrap);else brief.after(wrap);(row||brief).after(note,added);}});
 }
 window.addEventListener('echo-account-changed',()=>{generation++;busy=false;routing=false;lastRoute=null;setAuto(false);notice('');panel.hidden=true;pickBox.replaceChildren();alternatives.replaceChildren();failure.replaceChildren();for(const s of enhancers){s.previous=null;s.undo.hidden=true;s.added.replaceChildren();s.added.hidden=true;s.note.hidden=true;s.busy=false;}report=null;reportState='loading';renderEnhance();void loadModels();});
 renderEnhance();
 const ready=loadModels();
 window.EchoPrimeMediaRouter={ready,refresh:loadModels,route:routeInStudio,isAuto:()=>autoMode,setAuto,provider:()=>provider,lastRoute:()=>lastRoute};
})();
