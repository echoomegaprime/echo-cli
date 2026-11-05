(() => {
 'use strict';
 const $=s=>document.querySelector(s), snapshot=window.EchoPrimeCatalog||{capabilities:[],models:[]};
 let catalog=snapshot.capabilities, selected=null, ticket=null, host=false, submitting=false,generation=0,revision=0,controller=new AbortController();
 let studioInputs=[],pickerOpen=false;
 const ROLES=['reference','init','mask','audio','script'];
 const status=$('#catalog-state'), result=$('#creative-result');
 const modes={image:'prompt',video:'prompt',music:'prompt',sound:'text',voice:'text'};
 async function api(path,data){
  const current=generation,headers=await window.EchoPrimeWorkspace?.ownerHeaders()||{};
  if(current!==generation)throw Error('Account session changed.');
  if(!/^https?:$/.test(location.protocol))throw Error('Open ECHO Prime through its local host to connect. This file is an offline preview.');
  const response=await fetch('/api/'+path,{method:data?'POST':'GET',credentials:'same-origin',headers:{'X-Prime-Request':'1',...headers,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('The authorized ECHO host is not connected.');
  const value=await response.json();if(current!==generation)throw Error('Account session changed.');
  if(!response.ok){if(response.status===401||response.status===403){if(window.EchoPrimeWorkspace?.invalidate)window.EchoPrimeWorkspace.invalidate();else invalidate();}throw Error(value.error||'Connection unavailable');}return value;
 }
 function debug(operation,outcome){console.debug('[echo.studio]',{schema_version:1,event:'studio_operation',operation,outcome});}
 function invalidate(){generation++;revision++;controller.abort();controller=new AbortController();ticket=null;selected=null;host=false;submitting=false;catalog=snapshot.capabilities;studioInputs=[];pickerOpen=false;
  for(const id of ['creative-prompt','creative-arguments','creative-search'])$('#'+id).value='';
  for(const id of ['creative-result','request-review','request-cost','connection-result','tool-details','selected-tool'])$('#'+id).textContent='';
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
 function payload(){
  const text=$('#creative-prompt').value.trim(),kind=modes[selected?.category];
  return {command:selected?.id.split('.').at(-1)||'generate',options:kind?{[kind]:text,...(/^echo\.media\.(image|video)_generate$/.test(selected.id)?{wait:false}:{})}:{},...(studioInputs.length?{inputs:studioInputs.map(i=>({upload_id:i.upload_id,role:i.role}))}:{})};
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
 function choose(c){selected=c;ticket=null;revision++;$('#execute-request').disabled=true;$('#selected-tool').textContent=c.id;$('#tool-details').textContent=c.description;$('#creative-arguments').value=JSON.stringify(payload(),null,2);render();}
 function open(category='all',prompt='',inputs=null){
  studioInputs=Array.isArray(inputs)?inputs.filter(x=>x&&typeof x.upload_id==='string'&&/^upl_[0-9a-f]{32}$/.test(x.upload_id)).slice(0,8).map(x=>({upload_id:x.upload_id,role:ROLES.includes(x.role)?x.role:'reference'})):[];
  pickerOpen=false;renderStudioInputs();
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
 $('#creative-search').addEventListener('input',render);$('#creative-category').addEventListener('change',render);$('#include-adult').addEventListener('change',models);
 function edited(){revision++;ticket=null;$('#execute-request').disabled=true;if($('#review-dialog').open)$('#review-dialog').close();}
 $('#creative-prompt').addEventListener('input',()=>{if(selected)$('#creative-arguments').value=JSON.stringify(payload(),null,2);edited();});
 $('#creative-arguments').addEventListener('input',edited);
 $('#refresh-connections').addEventListener('click',connections);
 $('#refresh-catalog').addEventListener('click',async()=>{const current=generation;try{const query=$('#creative-search').value.trim()||$('#creative-category').value;const r=await api('search',{query:query==='all'?'image':query});if(current!==generation)return;const merged=new Map(catalog.map(c=>[c.id,c]));for(const c of r.capabilities)merged.set(c.id,c);catalog=[...merged.values()];render();result.textContent='Live registry returned '+r.capabilities.length+' entries for '+query+'.';}catch(e){if(current===generation)fail(e);}});
 $('#prepare-creative').addEventListener('click',async()=>{
  if(!selected){result.textContent='Select a capability first.';return;}
  const current=generation,version=revision;
  try{const prepared=await api('prepare',{target:'sdk',name:selected.id,arguments:JSON.parse($('#creative-arguments').value)});if(current!==generation||version!==revision)return;ticket=prepared;$('#request-review').textContent=JSON.stringify(ticket.request,null,2);$('#request-cost').textContent=ticket.cost+' Required scope: '+(ticket.scope||'owner-defined');$('#execute-request').disabled=false;$('#review-dialog').showModal();debug('prepare','returned');}catch(e){if(current===generation&&version===revision){ticket=null;fail(e);}}
 });
 $('#execute-request').addEventListener('click',async()=>{
  if(!ticket||submitting)return;submitting=true;$('#execute-request').disabled=true;const current=ticket,epoch=generation;ticket=null;
  $('#review-dialog').close();result.textContent='Submitting the reviewed request…';
  // The auto-router listens for this to offer the next-best tool after a failure; it never resubmits by itself.
  const executed=(state,detail)=>{try{window.dispatchEvent(new CustomEvent('echo-studio-executed',{detail:{state,detail:String(detail||'').slice(0,600),name:current.request.name,requestId:current.requestId}}));}catch{}};
  try{const r=await api('execute',{id:current.id,digest:current.digest});if(epoch===generation){
   result.textContent=JSON.stringify(r,null,2);debug('execute','returned');executed(r.state,r.detail);
   if(typeof window.EchoPrimeArtifacts?.register==='function'&&r?.state!=='blocked'&&r?.state!=='uncertain'){
    const reqArgs=current.request?.arguments||{},reqOpts=reqArgs.options||{},cat=selected?.category||'other';
    const artKind=['image','video','music','sound','voice'].includes(cat)?cat:'other';
    const brief=String(reqOpts.prompt||reqOpts.text||'');
    void window.EchoPrimeArtifacts.register({
     title:`${(current.request?.name||'Studio').replace(/^echo\./,'')} · ${(brief||'generation').slice(0,60)}`,
     kind:artKind,
     content:r,
     ...(typeof r?.url==='string'?{external_url:r.url}:typeof r?.output_url==='string'?{external_url:r.output_url}:{}),
     provenance:{
      source:'studio',
      capability:current.request?.name,
      ...(brief?{prompt:brief}:{}),
      ...(typeof (r?.model||reqOpts.model)==='string'?{model:String(r?.model||reqOpts.model)}:{}),
      run_id:String(r?.run_id||r?.job_id||current.requestId||''),
      ...(Array.isArray(reqArgs.inputs)&&reqArgs.inputs.length?{inputs:reqArgs.inputs}:{}),
     },
    }).catch(()=>{});
   }
  }}catch(e){if(epoch===generation){result.textContent='Outcome unknown. Do not resubmit automatically. Request ID: '+current.requestId+'\n'+e.message;debug('execute','unconfirmed');executed('uncertain',e.message);}}finally{if(epoch===generation)submitting=false;}
 });
 window.EchoPrimeStudio={open,addInput:addStudioInput,inputs:()=>studioInputs.map(i=>({...i})),
   /** Auto-router hooks: select a listed capability by id, or select it and set the exact request the router prepared. */
   select(id){const c=catalog.find(x=>x.id===id);if(c)choose(c);return !!c;},
   apply(pick){const c=pick&&catalog.find(x=>x.id===pick.id);if(!c)return false;choose(c);if(pick.arguments&&typeof pick.arguments==='object'&&!Array.isArray(pick.arguments))$('#creative-arguments').value=JSON.stringify(pick.arguments,null,2);return true;},
   catalog(){return catalog.slice();},
   selected(){return selected?{id:selected.id,category:selected.category}:null;},
  };renderStudioInputs();models();render();
})();
