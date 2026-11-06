(() => {
 'use strict';
 const $=s=>document.querySelector(s), snapshot=window.EchoPrimeCatalog||{capabilities:[],models:[]};
 let catalog=snapshot.capabilities, selected=null, template=null, ticket=null, host=false, submitting=false,generation=0,revision=0,controller=new AbortController();
 let studioInputs=[],pickerOpen=false,output=null,durationRow=null,durationInput=null,durationHint=null,background=null,view=0;
 // Requests still running after the owner moved on (another tool, medium or submission): Prime keeps following each one by
 // its request id, and its state shows in #creative-background, never in #creative-result, which belongs to the request on screen.
 const followers=new Map();
 const ROLES=['reference','init','mask','audio','script'];
 const status=$('#catalog-state'), result=$('#creative-result');
 // Per-call client waits. Execute answers within Prime's inline window (20 s) and long runs continue server-side, so no
 // request here outlives the public proxy's 100 s cut.
 const WAITS={execute:60000,prepare:30000,'prime/media/job':20000,search:30000,status:30000};
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(value!==false&&value!==undefined&&value!==null)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity))if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);
  return node;
 }
 async function api(path,data){
  const current=generation,headers=await window.EchoPrimeWorkspace?.ownerHeaders()||{};
  if(current!==generation)throw Error('Account session changed.');
  if(!/^https?:$/.test(location.protocol))throw Error('Open ECHO Prime through its local host to connect. This file is an offline preview.');
  const response=await fetch('/api/'+path,{method:data?'POST':'GET',credentials:'same-origin',headers:{'x-prime-request':'1',...headers,...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(WAITS[path]||30000)])});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('The authorized ECHO host is not connected.');
  const value=await response.json();if(current!==generation)throw Error('Account session changed.');
  if(!response.ok){
   // One refused request is not a sign-out: re-read the session, which signs the page out only when it says signed out.
   if((response.status===401||response.status===403)&&typeof window.EchoPrimeWorkspace?.recheck==='function')await window.EchoPrimeWorkspace.recheck().catch(()=>{});
   throw Error(value.error||'Connection unavailable');
  }
  return value;
 }
 function debug(operation,outcome){console.debug('[echo.studio]',{schema_version:1,event:'studio_operation',operation,outcome});}
 function noteBackground(){
  const lines=[...followers.values()].filter(f=>f.view!==view).map(f=>f.done||f.label+' is still running (request ID '+f.requestId+'). Prime keeps following it and saves the result to Library.');
  if(!lines.length&&!background)return;
  if(!background){background=el('p',{id:'creative-background',class:'creative-background','aria-live':'polite'});(output||result).after(background);}
  background.textContent=lines.join(' ');background.hidden=!lines.length;
 }
 function clearResult(){for(const [id,f] of followers)if(f.done)followers.delete(id);view++;result.textContent='';if(output)output.replaceChildren();noteBackground();}
 function invalidate(){generation++;revision++;controller.abort();controller=new AbortController();ticket=null;selected=null;template=null;host=false;submitting=false;catalog=snapshot.capabilities;studioInputs=[];pickerOpen=false;
  for(const id of ['creative-prompt','creative-arguments','creative-search'])$('#'+id).value='';
  for(const id of ['creative-result','request-review','request-cost','connection-result','tool-details','selected-tool'])$('#'+id).textContent='';
  if(output)output.replaceChildren();followers.clear();view++;if(background){background.textContent='';background.hidden=true;}if(durationInput)durationInput.value='';syncDuration();
  $('#execute-request').disabled=true;for(const id of ['review-dialog','creative-dialog'])if($('#'+id).open)$('#'+id).close();renderStudioInputs();render();debug('account','cleared');
 }
 window.addEventListener('echo-account-changed',invalidate);
 function fail(error){result.textContent=error instanceof Error?error.message:'Connection unavailable';}
 function models(){
  const target=$('#model-list');target.replaceChildren();
  for(const m of snapshot.models||[]){if(m.nsfwCapable&&!$('#include-adult').checked)continue;const item=document.createElement('span');item.className='model-tag';item.textContent=m.name+(m.nsfwCapable?' · NSFW-capable':'')+' · '+m.node;item.title=m.note||'Listed in the registry; live availability is unverified.';target.append(item);}
 }
 function render(){
  const query=$('#creative-search').value.toLowerCase(),category=$('#creative-category').value,target=$('#creative-tools');target.replaceChildren();
  const rows=catalog.filter(c=>(category==='all'||category==='auto'||c.category===category)&&(c.id+' '+c.description).toLowerCase().includes(query));
  status.textContent=rows.length+' of '+catalog.length+' creative capabilities · '+(host?'Host connected; availability checked per request':'Registry snapshot · live availability unverified');
  for(const c of rows){const b=document.createElement('button');b.className='creative-tool';b.setAttribute('aria-pressed',String(selected?.id===c.id));const title=document.createElement('strong'),small=document.createElement('small'),state=document.createElement('span');title.textContent=c.id.replace(/^echo\./,'');small.textContent=c.description;state.textContent=c.health+' · '+(c.scope||'scope unknown');b.append(title,state,small);b.addEventListener('click',()=>choose(c));target.append(b);}
 }
 // ---- request shapes ------------------------------------------------------------------------------------------------
 // The same rules as src/prime/media.ts argumentTemplate (tests/prime-media-ui.test.ts checks they agree): http json_body
 // caps and the ElevenLabs op router take flat fields, echo.llm.* takes {command:'call',...fields}, anything else gets the
 // fleet's dual {command,...fields,options:{...fields}} and is flagged for review.
 const HTTP_FLAT=/^echo\.(?:media\.(?:image|video)_generate|image\.generate|fal\.generate|elevenlabs\.tts|cartesia\.tts|voice\.(?:speak|cartesia\.tts|elevenlabs\.(?:tts|sfx|music))|aws\.polly_tts)$/,ELEVENLABS_OP=/^echo\.elevenlabs\.[a-z_]+\.[a-z_]+$/;
 const KIND_OF={image:'image',video:'video',music:'music',sound:'sfx',voice:'voice'};
 function templateFor(id,category){
  const kind=KIND_OF[category]||'other',llm=/^echo\.llm\./.test(id),flat=!llm&&(HTTP_FLAT.test(id)||ELEVENLABS_OP.test(id));
  const textKey=/sound_generation|(?:^|\.)tts$|\.speak$|polly|speech|\.sfx$/.test(id)||kind==='voice'||kind==='sfx'?'text':'prompt';
  const duration=id==='echo.media.video_generate'?{key:'length',unit:'frames',min:1,max:16}:/^echo\.llm\.together\./.test(id)&&kind==='video'?{key:'seconds',unit:'s-string',min:1,max:10}
   :/music_generation\.(?:generate|compose_detailed|stream_compose)$|^echo\.voice\.elevenlabs\.music$/.test(id)?{key:'music_length_ms',unit:'ms',min:3,max:600}:/sound_generation\.sound_generation$|^echo\.voice\.elevenlabs\.sfx$/.test(id)?{key:'duration_seconds',unit:'s',min:0.5,max:30}:null;
  return {envelope:llm?'llm':flat?'flat':'dual',verb:llm?'call':id.split('.').at(-1)||'generate',textKey,fixed:/^echo\.media\.(?:image|video)_generate$/.test(id)?{wait:false}:{},...(duration?{duration}:{}),modeled:llm||flat,source:'family'};
 }
 function durationFields(spec,seconds){
  const s=Math.min(spec.max,Math.max(spec.min,seconds));
  if(spec.unit==='ms')return {[spec.key]:Math.round(s*1000)};
  if(spec.unit==='s-string')return {[spec.key]:String(Math.max(1,Math.round(s)))};
  if(spec.unit==='frames'){const fps=Math.max(8,Math.min(24,Math.floor(128/s)));return {fps,length:Math.min(129,Math.round(s*fps)+1)};}
  return {[spec.key]:Math.round(s*10)/10};
 }
 function materialize(t,text,seconds){
  const fields={[t.textKey]:text,...(t.fixed||{})};
  if(t.duration&&typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>0)Object.assign(fields,durationFields(t.duration,seconds));
  if(t.envelope==='flat')return fields;
  if(t.envelope==='llm')return {command:'call',...fields};
  return {command:t.verb,...fields,options:{...fields}};
 }
 function seconds(){const v=durationInput?Number(durationInput.value):NaN;return durationInput&&durationInput.value!==''&&Number.isFinite(v)&&v>0?v:undefined;}
 function payload(){
  const text=$('#creative-prompt').value.trim(),t=template||(selected?templateFor(selected.id,selected.category):null);
  if(!t)return {};
  return {...materialize(t,text,seconds()),...(studioInputs.length?{inputs:studioInputs.map(i=>({upload_id:i.upload_id,role:i.role}))}:{})};
 }
 // ---- length control (video, music, sound effects) -------------------------------------------------------------------
 function mountDuration(){
  if(durationRow)return;
  const brief=$('#creative-prompt'),label=brief&&brief.parentNode;if(!label||typeof label.after!=='function')return;
  durationInput=el('input',{id:'creative-duration',type:'number',min:'1',max:'600',step:'1',inputmode:'decimal',placeholder:'Tool default'});
  durationHint=el('small',{class:'creative-duration-hint'});
  durationRow=el('label',{class:'creative-duration','data-creative-duration':''},'Length in seconds',durationInput,durationHint);durationRow.hidden=true;
  label.after(durationRow);
  durationInput.addEventListener('input',()=>{if(selected)$('#creative-arguments').value=JSON.stringify(payload(),null,2);edited();});
 }
 function syncDuration(){
  const spec=(template||(selected?templateFor(selected.id,selected.category):null))?.duration;
  if(!durationRow)return;
  durationRow.hidden=!spec;
  if(spec){durationInput.min=String(spec.min);durationInput.max=String(spec.max);durationInput.setAttribute('min',String(spec.min));durationInput.setAttribute('max',String(spec.max));durationHint.textContent='This tool takes '+spec.min+' to '+spec.max+' seconds; longer values are cut to '+spec.max+'. Empty uses the tool default.';}
 }
 function syncArguments(){if(selected)$('#creative-arguments').value=JSON.stringify(payload(),null,2);edited();}
 function addStudioInput(uploadId,role='reference'){
  if(typeof uploadId!=='string'||!/^upl_[0-9a-f]{32}$/.test(uploadId))return false;
  const cleanRole=ROLES.includes(role)?role:'reference';
  const existing=studioInputs.find(i=>i.upload_id===uploadId);
  if(existing)existing.role=cleanRole;
  else{if(studioInputs.length>=8)return false;studioInputs.push({upload_id:uploadId,role:cleanRole});}
  renderStudioInputs();syncArguments();return true;
 }
 function renderStudioInputs(){
  const box=$('#creative-inputs');if(!box||typeof box.replaceChildren!=='function')return;
  const head=document.createElement('div');head.className='creative-inputs-head';
  const label=document.createElement('small');label.textContent='Reference uploads (image-to-image · image-to-video · video-to-video)';
  const pickBtn=document.createElement('button');pickBtn.setAttribute('type','button');pickBtn.className='quiet-button';pickBtn.setAttribute('data-action','choose-studio-upload');pickBtn.textContent=pickerOpen?'Hide uploads':'Choose from uploads';
  pickBtn.addEventListener('click',async()=>{
   pickerOpen=!pickerOpen;
   if(pickerOpen&&typeof window.EchoPrimeLibrary?.refresh==='function'){try{await window.EchoPrimeLibrary.refresh();}catch{}}
   renderStudioInputs();
  });
  head.append(label,pickBtn);
  const rows=document.createElement('div');rows.className='creative-inputs-list';
  studioInputs.forEach((entry,idx)=>{
   const meta=window.EchoPrimeLibrary?.uploadById?.(entry.upload_id);
   const row=document.createElement('div');row.className='creative-input-row';row.setAttribute('data-studio-input',entry.upload_id);
   if(meta?.kind==='image'){const img=document.createElement('img');img.className='creative-input-thumb';img.setAttribute('src','/api/prime/uploads/'+encodeURIComponent(entry.upload_id)+'/file?thumb=1');img.setAttribute('alt','');row.append(img);}
   const name=document.createElement('span');name.textContent=meta?.name||entry.upload_id;
   const roleSelect=document.createElement('select');roleSelect.setAttribute('aria-label','Role for '+(meta?.name||entry.upload_id));roleSelect.setAttribute('data-input-role',entry.upload_id);
   for(const r of ROLES){const opt=document.createElement('option');opt.setAttribute('value',r);opt.textContent=r;roleSelect.append(opt);}
   roleSelect.value=entry.role;
   roleSelect.addEventListener('change',()=>{entry.role=ROLES.includes(roleSelect.value)?roleSelect.value:'reference';syncArguments();});
   const rmBtn=document.createElement('button');rmBtn.setAttribute('type','button');rmBtn.className='quiet-button';rmBtn.textContent='Remove';
   rmBtn.addEventListener('click',()=>{studioInputs.splice(idx,1);renderStudioInputs();syncArguments();});
   row.append(name,roleSelect,rmBtn);rows.append(row);
  });
  const nodes=[head,rows];
  if(pickerOpen){
   const picker=document.createElement('div');picker.className='creative-picker-list';
   const available=window.EchoPrimeLibrary?.uploads?.()||[];
   if(!available.length){const empty=document.createElement('small');empty.textContent='No uploads yet. Open Library & Artifacts to upload images, video or audio.';picker.append(empty);}
   for(const u of available.slice(0,60)){
    const b=document.createElement('button');b.setAttribute('type','button');b.className='creative-picker-item';b.setAttribute('data-pick-upload',u.id);
    if(u.kind==='image'){const img=document.createElement('img');img.className='creative-input-thumb';img.setAttribute('src','/api/prime/uploads/'+encodeURIComponent(u.id)+'/file?thumb=1');img.setAttribute('alt','');b.append(img);}
    const span=document.createElement('span');span.textContent=`${u.name} (${u.kind})`;b.append(span);
    b.addEventListener('click',()=>{const defRole=u.kind==='audio'?'audio':u.kind==='document'?'script':'reference';addStudioInput(u.id,defRole);});
    picker.append(b);
   }
   nodes.push(picker);
  }
  box.replaceChildren(...nodes);
 }
 // A new tool or medium starts with an empty result: the previous run's answer belongs to the previous tool.
 function choose(c,routed){selected=c;template=routed&&typeof routed==='object'&&typeof routed.envelope==='string'?routed:templateFor(c.id,c.category);ticket=null;revision++;clearResult();$('#execute-request').disabled=true;$('#selected-tool').textContent=c.id;$('#tool-details').textContent=c.description;syncDuration();$('#creative-arguments').value=JSON.stringify(payload(),null,2);render();}
 function open(category='all',prompt='',inputs=null){
  studioInputs=Array.isArray(inputs)?inputs.filter(x=>x&&typeof x.upload_id==='string'&&/^upl_[0-9a-f]{32}$/.test(x.upload_id)).slice(0,8).map(x=>({upload_id:x.upload_id,role:ROLES.includes(x.role)?x.role:'reference'})):[];
  pickerOpen=false;renderStudioInputs();
  if($('#creative-category').value!==category)clearResult();
  $('#creative-category').value=category;$('#creative-prompt').value=prompt;
  if(!selected||selected.category!==category){const c=catalog.find(x=>x.category===category&&x.id.startsWith('echo.media.'))||catalog.find(x=>x.category===category);if(c)choose(c);}
  else $('#creative-arguments').value=JSON.stringify(payload(),null,2);
  render();if(!$('#creative-dialog').open)$('#creative-dialog').showModal();$('#creative-search').focus();
 }
 async function connections(){
  const current=generation;
  $('#connection-result').textContent='Checking owner connections…';
  try{const s=await api('status');if(current!==generation)return;host=s.sdk.state==='attached';
   const row=document.querySelector('[data-system="ESH"].system-row:not([data-live]) .system-state');if(row)row.textContent=s.esh.state+(s.esh.ledgerVerified?' · ledger verified':'');
   $('#connection-result').textContent='ESH: '+s.esh.state+'. '+s.esh.detail+'. SDK: '+s.sdk.state+'.';
   if(Array.isArray(s.capabilities))catalog=s.capabilities;
  }catch(e){if(current!==generation)return;host=false;$('#connection-result').textContent=e.message;}
  if(current===generation)render();
 }
 $('#creative-search').addEventListener('input',render);$('#creative-category').addEventListener('change',()=>{clearResult();render();});$('#include-adult').addEventListener('change',models);
 function edited(){revision++;ticket=null;$('#execute-request').disabled=true;if($('#review-dialog').open)$('#review-dialog').close();}
 $('#creative-prompt').addEventListener('input',()=>{if(selected)$('#creative-arguments').value=JSON.stringify(payload(),null,2);edited();});
 $('#creative-arguments').addEventListener('input',edited);
 $('#refresh-connections').addEventListener('click',connections);
 $('#refresh-catalog').addEventListener('click',async()=>{const current=generation;try{const query=$('#creative-search').value.trim()||$('#creative-category').value;const r=await api('search',{query:query==='all'?'image':query});if(current!==generation)return;const merged=new Map(catalog.map(c=>[c.id,c]));for(const c of r.capabilities)merged.set(c.id,c);catalog=[...merged.values()];render();result.textContent='Live registry returned '+r.capabilities.length+' entries for '+query+'.';}catch(e){if(current===generation)fail(e);}});
 $('#prepare-creative').addEventListener('click',async()=>{
  if(!selected){result.textContent='Select a capability first.';return;}
  const current=generation,version=revision;
  const preparing=selected.id;
  try{const prepared=await api('prepare',{target:'sdk',name:selected.id,arguments:JSON.parse($('#creative-arguments').value)});if(current!==generation||version!==revision)return;ticket=prepared;$('#request-review').textContent=JSON.stringify(ticket.request,null,2);$('#request-cost').textContent=ticket.cost+' Required scope: '+(ticket.scope||'owner-defined')+'.';$('#execute-request').disabled=false;$('#review-dialog').showModal();debug('prepare','returned');}catch(e){if(current===generation&&version===revision){ticket=null;fail(e);
   // The auto-router offers the next-best tool when the review refuses its pick; it never re-prepares by itself.
   try{window.dispatchEvent(new CustomEvent('echo-studio-executed',{detail:{state:'refused',detail:String(e instanceof Error?e.message:'Review refused').slice(0,600),name:preparing,requestId:null}}));}catch{}}}
 });
 // ---- results ---------------------------------------------------------------------------------------------------------
 const clock=ms=>{const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
 const timeOf=iso=>{const t=Date.parse(iso||'');return Number.isFinite(t)?new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'its deadline';};
 function answerText(value){let text;try{text=JSON.stringify(value,null,2);}catch{text=String(value);}return text.length>4000?text.slice(0,4000)+'\n… (cut at 4,000 characters)':text;}
 function promptOf(args){const o=args&&typeof args.options==='object'&&args.options?args.options:{};for(const v of [args?.prompt,args?.text,o.prompt,o.text])if(typeof v==='string'&&v.trim())return v.trim();return $('#creative-prompt').value.trim();}
 function line(r){
  const j=r.job||{},label=j.label||r.capability||'The tool';
  if(r.state==='running')return label+' is working · '+clock(j.elapsedMs||0)+' elapsed · '+(j.phase==='polling'?'job '+(j.providerStatus||'queued')+(j.polls?' (status read '+j.polls+')':''):j.phase==='collecting'?'saving the file':'waiting for the provider')+'. Prime follows it until '+timeOf(j.deadline)+' and keeps the result in Library. Request ID '+r.requestId+'.';
  if(r.state==='submitted')return j.howToCheck||r.detail||label+' accepted the request. Request ID '+r.requestId+'.';
  if(r.state==='returned')return r.media?label+' finished in '+clock(j.elapsedMs||0)+'. Saved to Library as '+r.media.name+'.':r.mediaErrorKind==='unreadable'?label+' generated a file, but Prime could not read it: its media settings or uploads refused it (details below).':label+' answered'+(r.mediaError?', but no media file was stored.':'.');
  if(r.state==='blocked')return label+' did not complete: '+(r.detail||'refused')+(/[.!?]$/.test(r.detail||'')?'':'.');
  return r.detail||'Outcome unknown. Do not resubmit automatically. Request ID '+r.requestId+'.';
 }
 function mediaNode(media,alt){
  if(media.kind==='image')return el('img',{class:'creative-media',src:media.url,alt:alt||'Generated image'});
  if(media.kind==='video')return el('video',{class:'creative-media',src:media.url,controls:'',preload:'metadata'});
  if(media.kind==='audio')return el('audio',{class:'creative-audio',src:media.url,controls:'',preload:'metadata'});
  return el('a',{href:media.url,download:media.name},'Download '+media.name);
 }
 function renderOutcome(r,prompt){
  result.textContent=line(r);
  if(!output){output=el('div',{id:'creative-output',class:'creative-output','aria-live':'polite'});if(typeof result.after==='function')result.after(output);}
  const nodes=[];
  if(r.media){
   nodes.push(mediaNode(r.media,prompt));
   const open=el('button',{type:'button',class:'quiet-button','data-open-artifact':r.media.artifactId||''},'Open in Library');
   open.addEventListener('click',()=>{if(typeof window.EchoPrimeLibrary?.open==='function')void window.EchoPrimeLibrary.open('artifacts');});
   nodes.push(el('div',{class:'creative-output-actions'},el('a',{class:'quiet-button',href:r.media.url+'?download=1',download:r.media.name},'Download'),open));
  }
  if(r.state==='running')nodes.push(el('progress',{class:'creative-progress','aria-label':'Generation in progress'}));
  if(r.mediaError)nodes.push(el('p',{class:'creative-media-error',role:'alert'},r.mediaError));
  if(r.result!==undefined)nodes.push(el('details',{class:'creative-answer'},el('summary',{},'Provider answer (untrusted)'),el('pre',{},answerText(r.result))));
  output.replaceChildren(...nodes);
 }
 /** Follows a running request by its id until it ends (returned, blocked, uncertain or submitted-but-unfollowable),
  *  backing off from 2 s to 10 s, never past Prime's own deadline. It paints #creative-result only while its request is the
  *  one on screen (`mine===view`); after that it keeps following quietly and reports in #creative-background. */
 async function follow(first,epoch,prompt,mine){
  // The deadline moves when the call becomes a followed provider job (invoke limit -> job wall), so each answer resets it.
  let r=first,wait=2000,misses=0,until=(Date.parse(first.job?.deadline||'')||Date.now()+900000)+60000;
  const shown=()=>epoch===generation&&mine===view;
  while(epoch===generation&&r.state==='running'){
   const deadline=Date.parse(r.job?.deadline||'');if(Number.isFinite(deadline))until=deadline+60000;
   if(Date.now()>until){r={...r,state:'uncertain',detail:'Prime did not report a result by its own deadline. Check request ID '+first.requestId+' in Library or the gate execution log before submitting again.'};break;}
   await new Promise(resolve=>setTimeout(resolve,wait));wait=Math.min(10000,Math.round(wait*1.5));
   if(epoch!==generation)return null;
   try{const next=await api('prime/media/job',{requestId:first.requestId});if(!next||typeof next.state!=='string')throw Error('Prime answered without a request state');r=next;misses=0;}
   catch(e){if(epoch!==generation)return null;misses++;if(shown())result.textContent='Could not read progress ('+(e instanceof Error?e.message:'unavailable')+'); trying again. Request ID '+first.requestId+'.';
    if(misses>=5){r={...r,state:'uncertain',detail:'Progress could not be read five times in a row. The request may still be running: check request ID '+first.requestId+' before submitting again.'};break;}continue;}
   const f=followers.get(first.requestId);if(f&&r.job?.label)f.label=r.job.label;
   if(shown())renderOutcome(r,prompt);
  }
  return epoch===generation?r:null;
 }
 /** A request's final answer: shown when it is still the one on screen, reported to the auto-router (which offers the next
  *  tool after a failure), and kept: media files are already in Library (Prime registered them), other answers are saved. */
 function settle(r,ctx){
  const {current,tool,prompt,mine,executed}=ctx,shown=mine===view;
  if(shown)renderOutcome(r,prompt);
  // A provider body that says it failed (ok:false or an error string), or a media tool that answered without any file,
  // counts as a failure for the router's next-best offer. A file Prime's own settings could not read is not the tool's fault.
  const cat=tool?.category||'other',mediaTool=['image','video','music','sound','voice'].includes(cat);
  const body=r&&r.result&&typeof r.result==='object'&&!Array.isArray(r.result)?r.result:null,failed=r.state==='returned'&&!r.media&&(!!body&&(body.ok===false||typeof body.error==='string')||mediaTool&&r.mediaErrorKind==='no_media');
  if(shown)executed(failed?'failed':r.state,failed?String(body?.error||body?.detail||r.mediaError||'provider reported a failure'):r.detail||r.mediaError);
  if(r.media&&typeof window.EchoPrimeLibrary?.refresh==='function')void window.EchoPrimeLibrary.refresh().catch(()=>{});
  // Media results are registered by Prime with the stored file. Other tools' answers are kept as data, titled with the brief.
  if(r.state==='returned'&&!r.media&&!mediaTool&&typeof window.EchoPrimeArtifacts?.register==='function'){
   const reqArgs=current.request?.arguments||{},reqOpts=reqArgs.options||{};
   void window.EchoPrimeArtifacts.register({
    title:`${(current.request?.name||'Studio').replace(/^echo\./,'')} · ${(prompt||'result').slice(0,80)}`,
    kind:'other',content:r.result??r,
    provenance:{source:'studio',capability:current.request?.name,...(prompt?{prompt}:{}),...(typeof (reqArgs.model||reqOpts.model)==='string'?{model:String(reqArgs.model||reqOpts.model)}:{}),run_id:String(current.requestId||''),...(Array.isArray(reqArgs.inputs)&&reqArgs.inputs.length?{inputs:reqArgs.inputs}:{})},
   }).catch(()=>{});
  }
  const f=followers.get(current.requestId);
  if(f){if(shown)followers.delete(current.requestId);else f.done=r.state==='returned'&&r.media?f.label+' finished; saved to Library as '+r.media.name+'.':line(r);noteBackground();}
 }
 $('#execute-request').addEventListener('click',async()=>{
  if(!ticket||submitting)return;submitting=true;$('#execute-request').disabled=true;const current=ticket,epoch=generation,tool=selected;ticket=null;
  $('#review-dialog').close();clearResult();const mine=view;result.textContent='Submitting the reviewed request…';
  const prompt=promptOf(current.request?.arguments||{});
  // The auto-router listens for this to offer the next-best tool after a failure; it never resubmits by itself.
  const executed=(state,detail)=>{try{window.dispatchEvent(new CustomEvent('echo-studio-executed',{detail:{state,detail:String(detail||'').slice(0,600),name:current.request.name,requestId:current.requestId}}));}catch{}};
  let r;
  try{
   try{r=await api('execute',{id:current.id,digest:current.digest});}
   catch(e){
    // The answer was lost, not necessarily the request: Prime may still be running it, so look it up by id first.
    if(epoch!==generation)return;
    try{r=await api('prime/media/job',{requestId:current.requestId});}catch{throw e;}
   }
  }catch(e){if(epoch===generation&&mine===view){result.textContent='Outcome unknown. Do not resubmit automatically. Request ID: '+current.requestId+'. '+e.message;debug('execute','unconfirmed');executed('uncertain',e.message);}return;}
  // Prime has answered: the owner can review and submit the next request while this one keeps running server-side.
  finally{if(epoch===generation)submitting=false;}
  if(epoch!==generation)return;
  debug('execute',r.state);
  const ctx={current,tool,prompt,mine,executed};
  if(r.state!=='running'){settle(r,ctx);return;}
  if(mine===view)renderOutcome(r,prompt);
  followers.set(current.requestId,{requestId:current.requestId,label:r.job?.label||current.request.name,view:mine,done:''});
  void follow(r,epoch,prompt,mine).then(last=>{if(last)settle(last,ctx);}).catch(e=>{if(epoch===generation)settle({state:'uncertain',requestId:current.requestId,detail:'This page lost track of the request ('+(e instanceof Error?e.message:'error')+'). Check request ID '+current.requestId+' in Library or the gate execution log before submitting again.'},ctx);});
 });
 window.EchoPrimeStudio={open,addInput:addStudioInput,inputs:()=>studioInputs.map(i=>({...i})),templateFor,materialize,
   /** Auto-router hooks: select a listed capability by id, or select it and set the exact request the router prepared
    *  (its template keeps that shape when the brief or the length changes; `durationSeconds` fills the length control). */
   select(id){const c=catalog.find(x=>x.id===id);if(c)choose(c);return !!c;},
   apply(pick){const c=pick&&catalog.find(x=>x.id===pick.id);if(!c)return false;choose(c,pick.template);
    if(durationInput)durationInput.value=typeof pick.durationSeconds==='number'&&template?.duration?String(pick.durationSeconds):'';
    if(pick.arguments&&typeof pick.arguments==='object'&&!Array.isArray(pick.arguments))$('#creative-arguments').value=JSON.stringify({...pick.arguments,...(studioInputs.length?{inputs:studioInputs.map(i=>({upload_id:i.upload_id,role:i.role}))}:{})},null,2);return true;},
   /** Auto-router hook: rows the live catalog listed for a route (public catalog fields only). A new id is added under its
    *  medium; a listed id keeps its entry and takes the live health and registration. Returns how many ids were added. */
   merge(rows){
    let added=0,changed=false;
    for(const r of Array.isArray(rows)?rows.slice(0,20):[]){
     if(!r||typeof r.id!=='string'||!/^echo\.[A-Za-z0-9_.-]{1,180}$/.test(r.id))continue;
     const health=typeof r.health==='string'&&r.health?r.health.slice(0,32):'unknown',registered=r.registered!==false,at=catalog.findIndex(x=>x.id===r.id);
     if(at<0){catalog=[...catalog,{id:r.id,description:typeof r.description==='string'?r.description.slice(0,600):'',health,registered,scope:typeof r.scope==='string'?r.scope:'',category:Object.hasOwn(KIND_OF,r.category)||r.category==='tools'?r.category:'tools'}];added++;changed=true;}
     else if(catalog[at].health!==health||catalog[at].registered!==registered){catalog=catalog.map((x,i)=>i===at?{...x,health,registered}:x);changed=true;}
    }
    if(changed)render();return added;
   },
   catalog(){return catalog.slice();},
   selected(){return selected?{id:selected.id,category:selected.category}:null;},
  };mountDuration();renderStudioInputs();models();render();
})();
