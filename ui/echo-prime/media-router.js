(() => {
 'use strict';
 // Auto media routing + Enhance prompt. Server decides the pick (POST /api/prime/media/route) and the enhancement
 // (POST /api/prime/enhance); this file only shows the pick with its reason, lets the user override it explicitly,
 // offers the next-best tool after a failure (never switches by itself), and replaces composer text with an Undo.
 // Nothing here sends a message or submits a generation: the Studio's review-then-execute path stays the only spend path.
 const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
 const MODE_OF={Chat:'chat',Image:'image',Video:'video',Music:'music','Sound FX':'sfx',Voice:'voice',Auto:'auto'};
 const CATEGORY_MODE={image:'image',video:'video',music:'music',sound:'sfx',voice:'voice',tools:'chat',all:'auto',auto:'auto'};
 // A Studio medium the user chose becomes a routing hint: Echo still picks the best tool, but only of that kind.
 const HINT_OF_CATEGORY={image:'image',video:'video',music:'music',sound:'sfx',voice:'voice'};
 const PREFERENCE=['claude','gpt','grok','argon','qwen'];
 const LABELS={qwen:'Qwen',claude:'Claude',gpt:'GPT',grok:'Grok',argon:'Gemini (Argon)'};
 let generation=0,autoMode=false,passthrough=false,composerMode='Chat',report=null,reportState='loading',provider=null,lastRoute=null,routing=null,busy=false;
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(key==='value')node.value=value;else if(value!==false&&value!==undefined&&value!==null)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);
  return node;
 }
 // The sparkle is the page's own #i-spark symbol from the index.html sprite (no emoji font needed).
 function spark(){
  if(typeof document.createElementNS!=='function')return null;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');
  svg.setAttribute('aria-hidden','true');svg.setAttribute('class','enhance-spark');use.setAttribute('href','#i-spark');svg.append(use);return svg;
 }
 function debug(scope,event,detail){console.debug('[echo.'+scope+']',{schema_version:1,event,...(detail||{})});}
 async function headers(){try{return window.EchoPrimeWorkspace&&window.EchoPrimeWorkspace.ownerHeaders?await window.EchoPrimeWorkspace.ownerHeaders():{};}catch{return {};}}
 function admission(){
  const ws=window.EchoPrimeWorkspace;if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 async function api(path,data,timeoutMs){
  const current=generation,sent={'x-prime-request':'1',...await headers(),'content-type':'application/json'};
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
   const response=await fetch('/api/prime/models',{credentials:'same-origin',headers:{'x-prime-request':'1',...await headers()}});
   const data=await response.json();
   if(current!==generation)return;
   if(!response.ok||!data||!Array.isArray(data.providers))throw new Error('status');
   report=data;reportState='ready';
   const available=providers().filter(p=>p.available);
   if(!provider||!available.some(p=>p.id===provider))provider=(PREFERENCE.map(id=>available.find(p=>p.id===id)).find(Boolean)||available[0]||{id:null}).id;
   debug('enhance','models_loaded',{configured:data.configured===true,available:available.map(p=>p.id),provider});
  }catch{if(current!==generation)return;report=null;reportState='failed';}
  renderEnhance();
 }
 function providers(){
  if(!report||report.configured!==true)return [];
  return report.providers.filter(p=>p&&typeof p.id==='string'&&LABELS[p.id]).map(p=>({id:p.id,label:LABELS[p.id],available:p.available!==false,reason:typeof p.reason==='string'?p.reason:''}));
 }
 function enhanceGate(){
  if(reportState==='signin')return 'Sign in to enhance prompts.';
  if(reportState==='member')return 'Prompt enhancement is available to the primary owner only.';
  if(reportState==='failed')return 'Model status unavailable; nothing is sent to a model until it answers.';
  if(reportState==='loading')return 'Checking models…';
  if(!report||report.configured!==true)return 'Prompt enhancement needs the reviewed models section of the Prime configuration.';
  if(!provider)return 'No enhancement provider is available right now; no other model is used.';
  return '';
 }

 // ---- Enhance control --------------------------------------------------------------------------------------------
 const enhancers=[];
 function mountEnhance(options){
  const label=el('span',{class:'enhance-label'},'Enhance'),button=el('button',{type:'button',class:'quiet-button enhance-button','data-enhance':options.name,'aria-label':'Enhance prompt'},spark(),label);
  const select=el('select',{class:'enhance-provider','data-enhance-provider':options.name,'aria-label':'Enhance with'});
  const undo=el('button',{type:'button',class:'enhance-undo','data-enhance-undo':options.name},'Undo enhance');undo.hidden=true;
  const note=el('small',{class:'enhance-note',role:'status','aria-live':'polite','data-enhance-note':options.name});note.hidden=true;
  const added=el('ul',{class:'enhance-added','data-enhance-added':options.name});added.hidden=true;
  const wrap=el('div',{class:'enhance-wrap'},button,select,undo);
  options.mount(wrap,note,added);
  const state={options,button,label,select,undo,note,added,previous:null};
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
   s.label.textContent=busy&&s.busy?'Enhancing…':'Enhance';
   if(gate&&!s.previous){s.note.hidden=false;s.note.textContent=gate;s.gated=true;}
   else if(!gate&&s.gated){s.gated=false;s.note.hidden=true;s.note.textContent='';}
  }
 }
 async function run(state){
  if(busy)return;
  const gate=enhanceGate();if(gate){state.note.hidden=false;state.note.textContent=gate;state.gated=true;return;}state.gated=false;
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
  autoTab.addEventListener('click',()=>{
   // app.js keeps its own mode; selecting Chat first makes a chat passthrough a plain chat turn, never a Studio open.
   const chat=$$('.mode-tabs button').find(b=>b.dataset.mode==='Chat');if(chat&&composerMode!=='Chat'&&composerMode!=='Auto')chat.click();
   setAuto(true);if(prompt)prompt.focus();
  });
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
   r.text=text;r.mode='auto';if(window.EchoPrimeStudio&&typeof window.EchoPrimeStudio.open==='function')window.EchoPrimeStudio.open('auto',text,null,r);
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
 // The alternatives are always on screen next to the pick: overriding is one tap on the tool you want.
 const alternativesTitle=el('p',{class:'media-alternatives-title','data-media-alternatives-title':''});
 const alternatives=el('div',{class:'media-alternatives',role:'list','data-media-alternatives':''});alternatives.hidden=true;
 const excludedBox=el('details',{class:'media-excluded-wrap','data-media-excluded':''});excludedBox.hidden=true;
 const failure=el('div',{class:'media-failure',role:'alert','data-media-failure':''});failure.hidden=true;
 const repick=el('button',{type:'button',class:'quiet-button','data-media-repick':''},'Pick again for this brief');
 const actions=el('div',{class:'media-actions'},repick);
 panel.append(status,pickBox,alternativesTitle,alternatives,excludedBox,actions,failure);
 if(tools)tools.before(panel);
 alternativesTitle.hidden=true;
 repick.addEventListener('click',()=>{void routeInStudio(brief?brief.value.trim():'',null,HINT_OF_CATEGORY[category?category.value:'auto']);});
 const badge=(text,cls)=>el('span',{class:'media-badge'+(cls?' '+cls:'')},text);
 function applyPick(pick,how){
  if(!studio||typeof studio.apply!=='function')return false;
  const ok=studio.apply({id:pick.id,arguments:pick.request&&pick.request.arguments});
  if(ok){lastRoute.applied=pick;debug('media','media_pick_applied',{id:pick.id,how});}
  return ok;
 }
 // Which catalog the server ranked: the live SDK catalog, part of it, or only the shipped snapshot. Never left implicit.
 function catalogBadge(report){
  if(!report||typeof report!=='object')return null;
  const failed=Array.isArray(report.failed)?report.failed.length:0,total=Array.isArray(report.queries)?report.queries.length:0;
  if(report.source==='live')return badge('live catalog'+(report.cached?' (checked within the last minute)':''),'catalog-live');
  if(report.source==='partial')return badge('live catalog · '+failed+' of '+total+' searches failed','catalog-partial');
  if(report.source==='snapshot')return badge('shipped snapshot · not live','catalog-snapshot');
  return null;
 }
 function renderPick(r){
  pickBox.replaceChildren();alternatives.replaceChildren();excludedBox.replaceChildren();failure.hidden=true;failure.replaceChildren();
  const c=r.classification||{},kind=c.kind||'unknown',sure=Math.round((c.confidence||0)*100);
  repick.textContent=r.picked?'Pick again for this brief':'Pick the best tool';
  const alts=Array.isArray(r.alternatives)?r.alternatives:[],excluded=Array.isArray(r.excluded)?r.excluded:[];
  // Tools only the live catalog lists are added to the Studio's list first, so the pick and every override can be selected.
  if(studio&&typeof studio.merge==='function'&&Array.isArray(r.records)&&r.records.length){try{studio.merge(r.records);}catch{debug('media','media_records_refused',{count:r.records.length});}}
  const catalogNote=r.catalog&&r.catalog.source!=='live'&&typeof r.catalog.reason==='string'?' '+r.catalog.reason:'';
  if(r.picked){
   const p=r.picked;
   pickBox.hidden=false;
   pickBox.append(el('strong',{},p.label+' · '+p.provider),el('p',{class:'media-reason'},p.reason),
    el('div',{class:'media-badges'},badge(kind+' · '+sure+'% sure'+(c.styles&&c.styles.length?' · '+c.styles.join(', '):'')),badge('health '+p.health+(p.healthSource==='probe'?' (probed)':p.healthSource==='catalog'?' (live catalog)':p.healthSource==='snapshot'?' (snapshot)':''),'health-'+p.health),badge(p.costNote),badge('quality '+p.quality+'/10 · speed '+p.speed+'/10'),catalogBadge(r.catalog),...(p.argumentShape==='unmodeled'?[badge('review request details','health-unknown')]:[])));
   status.textContent='Echo picked a tool for this '+kind+' brief. Review the request below, then submit it yourself; nothing runs until you do.'+catalogNote;
   if(!applyPick(p,'auto'))status.textContent+=' (The tool is not in this catalog view; search the live registry.)';
  }else{
   pickBox.hidden=true;
   status.textContent=(r.reason||'Nothing was picked.')+catalogNote;
  }
  alternatives.hidden=!alts.length;alternativesTitle.hidden=!alts.length;
  alternativesTitle.textContent=r.picked?'Or use one of these instead (one tap):':'Tools for this ('+alts.length+'):';
  for(const a of alts){
   const b=el('button',{type:'button',class:'media-alternative',role:'listitem','data-media-alternative':a.id},el('strong',{},a.label+' · '+a.provider),el('span',{},'health '+a.health+' · '+a.costNote+' · '+a.quality+'/10'),el('small',{},a.reason));
   b.addEventListener('click',()=>{if(applyPick(a,'override')){status.textContent='You chose '+a.label+'. Review the request below, then submit it yourself.';lastRoute.picked=a;}});
   alternatives.append(b);
  }
  // Every generator the catalog lists for this kind but Auto will not use, with the reason (collapsed to keep the list short).
  excludedBox.hidden=!excluded.length;
  if(excluded.length)excludedBox.append(el('summary',{},'Not used for this brief ('+excluded.length+')'),el('ul',{class:'media-excluded'},...excluded.map(x=>el('li',{},x.label+': '+x.reason))));
 }
 async function routeInStudio(text,route,hint){
  const current=generation;
  panel.hidden=false;
  if(!text){status.textContent='Type a brief above and Echo picks the best tool for it.';repick.textContent='Pick the best tool';pickBox.hidden=true;alternatives.hidden=true;alternativesTitle.hidden=true;excludedBox.hidden=true;failure.hidden=true;return;}
  if(routing&&!route)return;
  if(route){lastRoute=route;renderPick(route);return;}
  const mode=hint||'auto';routing=true;status.textContent='Choosing the best '+(hint?hint+' ':'')+'tool…';
  try{
   const r=await api('prime/media/route',{text,mode,fallback:'image'},45000);
   if(current!==generation)return;
   r.text=text;r.mode=mode;lastRoute=r;renderPick(r);
   debug('media','media_route',{surface:'studio',kind:r.classification&&r.classification.kind,picked:r.picked?r.picked.id:null,alternatives:(r.alternatives||[]).length,probed:r.probe?r.probe.probed.length:0});
  }catch(error){if(current===generation)status.textContent=(error instanceof Error?error.message:'Routing failed')+' Pick a tool from the list below instead.';}
  finally{if(current===generation)routing=false;}
 }
 if(studio&&typeof studio.open==='function'){
  const originalOpen=studio.open;
  // Same signature as integrations.js open(category,prompt,inputs), plus an optional route the composer's Auto turn already prepared.
  studio.open=function(cat='all',text='',inputs=null,route=null){
   const auto=cat==='auto'||cat==='all',prompted=String(text||'').trim(),hint=HINT_OF_CATEGORY[cat];
   originalOpen.call(studio,auto?'auto':cat,text,inputs);
   const prepared=route&&typeof route==='object'&&!Array.isArray(route)?route:null;
   if(auto)void routeInStudio(prompted,prepared);
   else if(hint&&prompted)void routeInStudio(prompted,null,hint);
   else panel.hidden=true;
  };
 }
 if(category)category.addEventListener('change',()=>{
  const value=category.value,text=brief?brief.value.trim():'',hint=HINT_OF_CATEGORY[value];
  if(value==='auto')void routeInStudio(text,lastRoute&&lastRoute.text===text&&lastRoute.mode==='auto'?lastRoute:null);
  else if(hint&&text)void routeInStudio(text,null,hint);
  else panel.hidden=true;
 });
 // The first brief typed in Auto is routed once the user pauses (1.2 s): a prompt is all it takes. Once a tool is picked,
 // later edits never re-route by themselves; "Pick again for this brief" does that explicitly.
 let autoTimer=null;
 if(brief)brief.addEventListener('input',()=>{
  if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}
  if(!category||category.value!=='auto'||(lastRoute&&lastRoute.picked))return;
  const current=generation;
  autoTimer=setTimeout(()=>{autoTimer=null;const text=brief.value.trim();if(current!==generation||category.value!=='auto'||text.length<3||(lastRoute&&lastRoute.picked))return;void routeInStudio(text,null);},1200);
 });
 // Editing the brief (typing or Enhance) makes integrations.js rebuild the request from the brief alone. For the tool the
 // router applied, keep the router's exact request shape (style, size, duration) and only swap in the new brief text.
 if(brief)brief.addEventListener('input',()=>{
  const applied=lastRoute&&lastRoute.applied,sel=studio&&typeof studio.selected==='function'?studio.selected():null,area=$('#creative-arguments');
  if(!applied||!sel||sel.id!==applied.id||!area||!applied.request||!applied.request.arguments)return;
  let current;try{current=JSON.parse(area.value);}catch{return;}
  const next=JSON.parse(JSON.stringify(applied.request.arguments)),text=brief.value.trim(),options=next.options&&typeof next.options==='object'?next.options:null;
  if(!options)return;
  for(const key of ['prompt','text'])if(typeof options[key]==='string')options[key]=text;
  if(current&&Array.isArray(current.inputs))next.inputs=current.inputs;
  area.value=JSON.stringify(next,null,2);
 });
 // A failed or uncertain submission of the auto pick: show it and offer the next best as an explicit choice. No automatic switch.
 window.addEventListener('echo-studio-executed',event=>{
  const d=event&&event.detail||{};
  if(!lastRoute||!lastRoute.picked||d.name!==lastRoute.picked.id||!['blocked','uncertain','refused','failed'].includes(d.state))return;
  lastRoute.failed=[...(lastRoute.failed||[]),d.name];
  const next=(lastRoute.alternatives||[]).find(a=>a.id!==lastRoute.picked.id&&!lastRoute.failed.includes(a.id));
  failure.hidden=false;failure.replaceChildren(el('p',{},lastRoute.picked.label+' did not complete ('+d.state+'): '+(d.detail||'no detail')+'. Nothing was retried.'));
  if(d.state==='uncertain')failure.append(el('p',{class:'media-uncertain'},'The outcome is unknown: check the original request (ID '+(d.requestId||'not reported')+') before spending on another tool.'));
  if(next){
   const use=el('button',{type:'button',class:'quiet-button','data-media-next':next.id},'Use '+next.label+' instead');
   use.addEventListener('click',()=>{if(applyPick(next,'after-failure')){lastRoute.picked=next;lastRoute.alternatives=lastRoute.alternatives.filter(a=>a.id!==next.id);failure.hidden=true;status.textContent='Switched to '+next.label+' at your request. Review the request below, then submit it yourself.';}});
   failure.append(el('p',{},'Next best: '+next.label+' · '+next.provider+' · '+next.reason),use);
  }else failure.append(el('p',{},'No other healthy tool is listed for this kind.'));
  debug('media','media_pick_failed',{id:d.name,state:d.state,next:next?next.id:null});
 });

 // ---- Enhance controls ------------------------------------------------------------------------------------------------
 // The Studio control is mounted here; the chat composer's control is mounted by composer.js (a deferred script, so it
 // runs after this file) through window.EchoPrimeMediaRouter.mountEnhance with the shared provider chip, gate and Undo.
 if(brief){
  mountEnhance({name:'studio',textarea:()=>$('#creative-prompt'),mode:()=>{const cat=category?category.value:'auto';if(cat==='auto'||cat==='all'){const k=lastRoute&&lastRoute.classification&&lastRoute.classification.kind;return k&&k!=='chat'&&k!=='image-edit'?k:k==='image-edit'?'image':'auto';}return CATEGORY_MODE[cat]||'auto';},
   mount(wrap,note,added){const row=$('.creative-actions');if(row)row.append(wrap);else brief.after(wrap);(row||brief).after(note,added);}});
 }
 window.addEventListener('echo-account-changed',()=>{generation++;if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}busy=false;routing=false;lastRoute=null;setAuto(false);notice('');panel.hidden=true;pickBox.replaceChildren();alternatives.replaceChildren();excludedBox.replaceChildren();failure.replaceChildren();for(const s of enhancers){s.previous=null;s.undo.hidden=true;s.added.replaceChildren();s.added.hidden=true;s.note.hidden=true;s.busy=false;}report=null;reportState='loading';renderEnhance();void loadModels();});
 renderEnhance();
 const ready=loadModels();
 // Another surface (composer.js) mounts an Enhance control that shares this provider chip, owner gate and account reset.
 function mountShared(options){
  if(!options||typeof options.name!=='string'||typeof options.textarea!=='function'||typeof options.mode!=='function'||typeof options.mount!=='function')throw new Error('Invalid Enhance mount');
  const existing=enhancers.find(s=>s.options.name===options.name);if(existing)return existing;
  const state=mountEnhance(options);renderEnhance();return state;
 }
 window.EchoPrimeMediaRouter={ready,refresh:loadModels,route:routeInStudio,isAuto:()=>autoMode,setAuto,provider:()=>provider,lastRoute:()=>lastRoute,
  mountEnhance:mountShared,composerMode:()=>autoMode?'auto':(MODE_OF[composerMode]||'chat')};
})();
