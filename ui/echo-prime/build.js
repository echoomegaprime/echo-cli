(() => {
 'use strict';
 const $=s=>document.querySelector(s),panel=$('#build-dialog'),opener=$('#open-build');
 if(!panel||!opener)return;
 const status=$('#build-status'),list=$('#build-list'),form=$('#build-form'),engine=$('#build-engine'),title=$('#build-title'),prompt=$('#build-prompt'),submit=$('#build-submit');
 const enhanceHolder=$('#build-enhance'),enhanceFeedback=$('#build-enhance-feedback');
 const view=$('#build-view'),heading=$('#build-heading'),meta=$('#build-meta'),log=$('#build-log'),frame=$('#build-preview'),turn=$('#build-turn'),turnPrompt=$('#build-turn-prompt'),turnSubmit=$('#build-turn-submit'),deploy=$('#build-deploy-review'),receipt=$('#build-receipt'),repo=$('#build-repo');
 let generation=0,controller=null,timer=null,current=null,health=null,providers=[],cursor=0,lines=[],busy=false,enhancing=false,previewAt=0,previewVersion='',failures=0,checking=false;
 const debug=(event,detail={})=>console.debug('[echo.build]',{event:'prime_build_'+event,...detail});
 const enhanceEvent=(event,detail={})=>console.debug('[echo.enhance]',{schema_version:1,event,surface:'build',...detail});
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const ws=()=>window.EchoPrimeWorkspace;
 const admitted=()=>!ws()?.enabled||ws()?.session?.authenticated===true&&ws()?.session?.ownerAccess===true;
 const elapsed=b=>{const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(b.created_at))/1000));return Number.isFinite(seconds)?Math.floor(seconds/60)+'m '+seconds%60+'s':'unknown';};
 const active=b=>b&&['queued','scaffolding','building','qa'].includes(b.status);
 async function api(path,body,signal=controller?.signal){
  if(!admitted())throw new Error('Echo Build is available to the primary owner only.');
  const headers={'x-prime-request':'1',...(ws()?.ownerHeaders?await ws().ownerHeaders():{}),...(body!==undefined?{'content-type':'application/json'}:{})};
  const response=await fetch('/api/prime/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers,signal,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  let data;try{data=await response.json();}catch{throw new Error('Echo Build returned an unreadable response');}
  if(!response.ok){if([401,403].includes(response.status)&&ws()?.session?.ownerAccess)ws().invalidate();throw new Error(data.error||'Echo Build request failed (HTTP '+response.status+')');}
  return data;
 }
 // The Enhance control and its notes are owner-only like the rest of this view; nothing of it shows (or can be pressed) otherwise.
 function syncEnhance(){const on=admitted();if(enhanceHolder)enhanceHolder.hidden=!on;if(enhanceFeedback)enhanceFeedback.hidden=!on;}
 function controls(){
  syncEnhance();
  submit.disabled=busy||enhancing||!health?.available||!providers.some(p=>p.available&&p.engine===engine.value);
  turnSubmit.disabled=busy||!current||active(current);
  for(const action of ['hibernate','revive','stop','deploy']){
   const button=$('#build-'+action);
   button.disabled=busy||!current||(action==='revive'?!['hibernated','failed'].includes(current.status):action==='deploy'?!['running','deployed'].includes(current.status):current.status==='hibernated');
  }
 }
 function renderList(rows){
  list.replaceChildren();
  if(!rows.length){list.append(el('p','No builds yet. Describe an app, API, program, CLI or website to begin.','build-muted'));return;}
  for(const b of rows){
   const button=el('button',undefined,'build-card');button.setAttribute('type','button');
   const phase=['queued','scaffolding','building','qa','running','deployed','hibernated','failed'].includes(b.status)?b.status:'unknown';
   button.append(el('strong',b.title),el('span',b.status,'build-chip build-chip-'+phase),el('small',b.engine+' · '+elapsed(b)+' · '+(b.status==='running'||b.status==='deployed'?'Live preview':'Preview '+b.status)));
   button.addEventListener('click',()=>select(b.build_id));list.append(button);
  }
 }
 function renderBuild(b){
  current=b;view.hidden=false;heading.textContent=b.title;meta.textContent=b.status+' · '+b.engine+' · elapsed '+elapsed(b);
  repo.hidden=!b.repo?.url||!/^https:\/\/github\.com\/echoomegaprime\/echo-build-[a-z0-9-]+$/.test(b.repo.url);
  if(!repo.hidden){repo.href=b.repo.url;repo.textContent='Private repository · '+b.repo.branch;}
  const ready=['running','deployed'].includes(b.status);frame.hidden=!ready;
  if(!ready){frame.removeAttribute('src');previewAt=0;previewVersion='';}
  controls();
 }
 async function preview(mine){
  if(!current||!['running','deployed'].includes(current.status))return;
  // Access/debug logs update the record continuously; only a completed build should reset the app's interactive state.
  const version=current.log?.filter(e=>e.event==='prime_build_running').at(-1)?.at||previewVersion||current.created_at;
  if(previewAt&&Date.now()-previewAt<300000&&previewVersion===version)return;
  const id=current.build_id,p=await api('build/'+id+'/preview-session',{});
  if(mine!==generation||current?.build_id!==id)return;
  if(!new RegExp('^/api/prime/build/'+id+'/preview/[a-f0-9]{48}/$').test(p.url))throw new Error('Invalid preview session');
  if(frame.getAttribute('src')!==p.url||previewVersion!==version)frame.setAttribute('src',p.url);
  previewAt=Date.now();previewVersion=version;
 }
 async function refresh(mine=generation){
  if(checking||!panel.open||document.hidden||!health?.available||!admitted())return;
  checking=true;
  try{
   const rows=await api('build/list');if(mine!==generation)return;renderList(Array.isArray(rows.builds)?rows.builds:[]);
   if(current){
    const id=current.build_id,b=await api('build/'+id);if(mine!==generation||current?.build_id!==id)return;renderBuild(b);
    const result=await api('build/'+id+'/log?since='+cursor);if(mine!==generation||current?.build_id!==id)return;
    if(result.truncated)lines=['[Older log events were truncated by the server]'];
    for(const row of result.events||[])lines.push(row.at+' '+row.event+' '+row.message);
    lines=lines.slice(-1000);log.textContent=lines.join('\n').slice(-1048576);cursor=result.next;log.scrollTop=log.scrollHeight;
    await preview(mine);
   }
   failures=0;
  }catch(error){if(mine===generation&&error.name!=='AbortError'){status.textContent=error.message;failures++;debug('poll_failed',{failures});}}
  finally{checking=false;if(mine===generation)schedule();}
 }
 function schedule(){clearTimeout(timer);timer=null;if(panel.open&&!document.hidden&&admitted()&&health?.available&&failures<5)timer=setTimeout(()=>refresh(),2000);}
 async function select(id){
  if(busy)return;const mine=++generation;controller?.abort();controller=new AbortController();checking=false;clearTimeout(timer);
  cursor=0;lines=[];log.textContent='';current=null;previewAt=0;previewVersion='';frame.removeAttribute('src');deploy.replaceChildren();receipt.textContent='';
  try{const b=await api('build/'+id);if(mine!==generation)return;renderBuild(b);await refresh(mine);}catch(error){if(mine===generation)status.textContent=error.message;}
 }
 async function open(){if(!panel.open)panel.showModal();await load();}
 async function load(){
  const mine=++generation;controller?.abort();controller=new AbortController();checking=false;clearTimeout(timer);failures=0;health=null;providers=[];controls();
  await Promise.resolve(ws()?.ready).catch(()=>{});if(mine!==generation)return;
  syncEnhance();
  if(!admitted()){status.textContent=ws()?.session?.authenticated?'Echo Build is available to the primary owner only.':'Sign in as the primary owner to use Echo Build.';return;}
  try{
   health=await api('build/health');if(mine!==generation)return;
   if(!health.available){status.textContent=health.reason||'Echo Build is off: add a build section with root and engines to the Prime config.';return;}
   const models=await api('models');if(mine!==generation)return;
   const rows=models.buildProviders?.length?models.buildProviders:models.providers||[];
   providers=(health.engines||[]).map(id=>{const p=rows.find(r=>(r.engine||r.id)===id||id==='gemini'&&r.id==='argon');return {engine:id,available:p?.available===true,check:p?.check||'not checked',reason:p?.reason};});
   engine.replaceChildren(...providers.map(p=>{const option=el('option',p.engine+' · '+(p.available?p.check:p.reason||'unavailable'));option.value=p.engine;option.disabled=!p.available;return option;}));
   engine.value=providers.find(p=>p.available)?.engine||'';
   status.textContent='Real apps and programs · '+health.maxConcurrent+' concurrent build'+(health.maxConcurrent===1?'':'s')+' · '+Math.round(health.wallMs/60000)+' minute wall budget. Claude and GPT are checked for sign-in; Grok and Gemini (agy) document no sign-in check, so only their installation is checked.';
   controls();debug('health',{available:true});await refresh(mine);
  }catch(error){if(mine===generation&&error.name!=='AbortError'){status.textContent=error.message;health=null;controls();debug('health_failed');}}
 }
 async function mutate(path,body){
  if(busy)return;const mine=generation;busy=true;controls();deploy.replaceChildren();
  try{
   const result=await api('build/'+path,body);if(mine!==generation)return;
   if(result.build_id){renderBuild(result);status.textContent='Build '+result.status+'.';}
   else {receipt.textContent=JSON.stringify(result,null,2);status.textContent=result.status==='prepared'?'Forge unit prepared. It has not been installed or enabled.':'Deployment result received. See the receipt.';}
   debug('action',{action:path.split('/').at(-1),status:result.status});
   return result;
  }catch(error){if(mine===generation){status.textContent=error.message;debug('action_failed');}}
  finally{if(mine===generation){busy=false;controls();await refresh(mine);}}
 }
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  // While Enhance works the text may still be replaced; a build started now would run on text the user is about to lose sight of.
  if(enhancing){status.textContent='Enhance is still working. Build it is available when it finishes, so the build uses the text you see.';enhanceEvent('prime_enhance_build_blocked');return;}
  if(busy||submit.disabled)return;
  if(!title.value.trim()||!prompt.value.trim()||title.value.length>120||prompt.value.length>12000){status.textContent='Enter a title (up to 120 characters) and a prompt (up to 12000 characters).';return;}
  const b=await mutate('create',{title:title.value.trim(),prompt:prompt.value.trim(),engine:engine.value});
  if(b?.build_id){cursor=0;lines=[];await select(b.build_id);}
 });
 turn.addEventListener('submit',async event=>{
  event.preventDefault();if(!current||busy||turnSubmit.disabled)return;
  if(!turnPrompt.value.trim()||turnPrompt.value.length>12000){status.textContent='Enter a follow-up of 1..12000 characters.';return;}
  const b=await mutate(current.build_id+'/turn',{prompt:turnPrompt.value.trim()});if(b)turnPrompt.value='';
 });
 for(const action of ['hibernate','revive','stop'])$('#build-'+action).addEventListener('click',()=>{if(current&&!busy)return mutate(current.build_id+'/'+action,{});});
 $('#build-deploy').addEventListener('click',async()=>{
  deploy.replaceChildren();if(!current||busy)return;
  const id=current.build_id,mine=generation;
  const targets=[];if(health?.deploy?.forge)targets.push(['forge','FORGE user unit '+health.deploy.forge.unitPrefix+'-'+id+'.service; install directory %h/echo-build/'+id+' (prepare only)']);
  if(health?.deploy?.vercel){try{const plan=await api('build/'+id+'/deploy-plan?target=vercel');if(mine!==generation||current?.build_id!==id)return;targets.push(['vercel',plan.description,plan.targetRef]);}catch(error){if(mine!==generation)return;deploy.append(el('p',error.message));}}
  if(!targets.length){deploy.append(el('p','No deployment targets enabled in build.deploy.'));return;}
  for(const [target,label,targetRef] of targets){
   const row=el('div',undefined,'build-confirm');row.append(el('p',label));
   const confirm=el('button',target==='forge'?'Confirm: prepare Forge unit':'Confirm: deploy to Vercel','quiet-button');confirm.setAttribute('type','button');
   confirm.addEventListener('click',()=>{if(current?.build_id===id)return mutate(id+'/deploy',{target,confirm:true,...(targetRef?{targetRef}:{})});});row.append(confirm);deploy.append(row);
  }
  const cancel=el('button','Cancel','quiet-button');cancel.setAttribute('type','button');cancel.addEventListener('click',()=>deploy.replaceChildren());deploy.append(cancel);
 });
 engine.addEventListener('change',controls);
 opener.addEventListener('click',open);$('#refresh-build').addEventListener('click',load);$('#close-build').addEventListener('click',()=>panel.close());
 function clear(){generation++;controller?.abort();clearTimeout(timer);timer=null;checking=false;busy=false;frame.removeAttribute('src');frame.hidden=true;previewAt=0;previewVersion='';}
 panel.addEventListener('close',clear);
 document.addEventListener('visibilitychange',()=>{clearTimeout(timer);timer=null;if(!document.hidden&&panel.open)refresh();});
 window.addEventListener('echo-account-changed',()=>{clear();enhancing=false;current=null;health=null;providers=[];cursor=0;lines=[];list.replaceChildren();log.textContent='';receipt.textContent='';deploy.replaceChildren();title.value='';prompt.value='';turnPrompt.value='';view.hidden=true;controls();if(panel.open)panel.close();});
 // Enhance (sparkle): the shared control from media-router.js (a classic script that runs before this one), mounted beside Build it.
 // It rewrites the description into a build brief with the provider chosen in its own chip (never the Build engine) and never submits or starts a build.
 function mountEnhance(){
  const router=window.EchoPrimeMediaRouter;
  if(typeof router?.mountEnhance!=='function'){enhanceEvent('prime_enhance_mount_skipped',{reason:'media_router_absent'});return;}
  if(!enhanceHolder||!enhanceFeedback){enhanceEvent('prime_enhance_mount_skipped',{reason:'markup_absent'});return;}
  router.mountEnhance({name:'build',textarea:()=>prompt,mode:()=>'build',ariaLabel:'Enhance build description',
   doneNote:'Nothing was sent and no build was started; review the text, then press Build it yourself.',
   onBusy(on){enhancing=on===true;enhanceEvent('prime_enhance_build_locked',{locked:enhancing});controls();},
   mount(wrap,note,added){enhanceHolder.append(wrap);enhanceFeedback.append(note,added);}});
 }
 try{mountEnhance();}catch(error){enhanceEvent('prime_enhance_mount_failed',{reason:error instanceof Error?error.message:'failed'});}
 window.EchoPrimeBuild={open,select,active:()=>current?.build_id??null};
 controls();
})();
