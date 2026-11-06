(() => {
 'use strict';
 // Unified Library (Prime streaming uploads + Workspace library notes/imports)
 // and Artifact Center (Studio media, Echo Build outputs, ADK run proofs, chat exports).
 // Keeps zero browser storage, clears on account change, and never handles credentials.
 const doc=document,$=selector=>doc.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const CREDENTIAL_FILE=/(?:^\.env(?:\.|$)|^id_(?:rsa|ed25519|ecdsa|dsa)|credentials?|secrets?|\.(?:pem|key|pfx|p12|kdbx|jks|keystore|db)$)/i;
 const FORBIDDEN_EXT=/\.(?:exe|dll|msi|msp|scr|com|pif|bat|cmd|ps1|psm1|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|hta|cpl|jar|war|ear|class|apk|ipa|dmg|pkg|app|deb|rpm|bin|run|elf|so|dylib|sys|drv|wasm|sh|bash|zsh|py|rb|pl|php|zip|tar|gz|tgz|bz2|tbz2|xz|txz|7z|rar|cab|iso|ar|zst|lz4)$/i;
 const UPLOAD_ACCEPT='.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.mp3,.wav,.pdf,.txt,.md,.markdown,.csv,.json,.docx,.xlsx,.pptx';
 const LIMITS={wsUpload:100000,wsImport:1900000,wsNote:500000,previewTextBytes:262144};

 // ---- Pure helpers (exported on EchoPrimeLibrary.core for unit tests) --------
 function formatBytes(bytes){
  const n=Number(bytes);
  if(!Number.isFinite(n)||n<=0)return '0 B';
  if(n<1024)return `${Math.round(n)} B`;
  if(n<1024*1024)return `${(n/1024).toFixed(n<10240?1:0)} KB`;
  if(n<1024*1024*1024)return `${(n/(1024*1024)).toFixed(1)} MB`;
  return `${(n/(1024*1024*1024)).toFixed(2)} GB`;
 }

 function studioTargetForUpload(item){
  const kind=String(item?.kind||'file');
  if(kind==='image')return {category:'image',role:'reference'};
  if(kind==='video')return {category:'video',role:'reference'};
  if(kind==='audio')return {category:'video',role:'audio'};
  if(kind==='document')return {category:'video',role:'script'};
  return {category:'image',role:'reference'};
 }

 function mergeLibraryItems(uploads,workspaceFiles){
  const up=(Array.isArray(uploads)?uploads:[])
   .filter(u=>u&&typeof u==='object'&&typeof u.id==='string')
   .map(u=>({...u,source:'upload',tags:Array.isArray(u.tags)?u.tags:[]}));
  const ws=(Array.isArray(workspaceFiles)?workspaceFiles:[])
   .filter(f=>f&&typeof f==='object'&&typeof f.id==='string')
   .map(f=>({
    id:f.id,
    name:String(f.name||'File'),
    path:String(f.path||'Private account file'),
    chat_id:typeof f.chat_id==='string'?f.chat_id:undefined,
    project_id:typeof f.project_id==='string'?f.project_id:undefined,
    kind:'workspace',
    type:'text/plain',
    source:'workspace',
    tags:[],
   }));
  return [...up,...ws];
 }

 function filterUnifiedItems(items,filters={}){
  const rows=Array.isArray(items)?items.filter(x=>x&&typeof x==='object'):[];
  const kind=String(filters.kind||'all');
  const needle=String(filters.query||'').trim().toLowerCase();
  return rows.filter(item=>{
   if(kind!=='all'){
    if(kind==='workspace'){if(item.source!=='workspace')return false;}
    else if(item.kind!==kind)return false;
   }
   if(!needle)return true;
   const hay=[item.name||'',item.path||'',item.type||'',item.kind||'',...(Array.isArray(item.tags)?item.tags:[])].join(' ').toLowerCase();
   return hay.includes(needle);
  });
 }

 function filterArtifacts(artifacts,filters={}){
  const rows=Array.isArray(artifacts)?artifacts.filter(x=>x&&typeof x==='object'):[];
  const kind=String(filters.kind||'all');
  const src=String(filters.source||'all');
  const needle=String(filters.query||'').trim().toLowerCase();
  return rows.filter(art=>{
   const prov=art.provenance&&typeof art.provenance==='object'?art.provenance:{};
   if(kind!=='all'&&art.kind!==kind)return false;
   if(src!=='all'&&prov.source!==src)return false;
   if(!needle)return true;
   const hay=[
    art.title||'',art.summary||'',art.kind||'',...(Array.isArray(art.tags)?art.tags:[]),
    prov.source||'',prov.prompt||'',prov.model||'',prov.capability||'',prov.run_id||'',prov.agent||'',prov.verdict||''
   ].join(' ').toLowerCase();
   return hay.includes(needle);
  });
 }

 // ---- DOM helpers ------------------------------------------------------------
 function el(tag,attributes={},...children){
  const node=doc.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){
   if(value===false||value===undefined||value===null)continue;
   if(key==='class')node.className=value;
   else if(key==='value')node.value=value;
   else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity)){
   if(child===null||child===undefined||child===false)continue;
   node.append(typeof child==='string'?doc.createTextNode(child):child);
  }
  return node;
 }

 const errText=err=>typeof err?.message==='string'&&err.message?err.message:'Operation failed. No automatic retry was made.';
 function debugLog(event,extra={}){console.debug('[echo.library]',{schema_version:1,event,...extra});}
 function notifyDraft(text){const n=$('#draft-notice');if(n){n.textContent=String(text).slice(0,600);n.hidden=false;}}

 // ---- Session / Headers ------------------------------------------------------
 function workspaceEnabled(){return window.EchoPrimeWorkspace?.enabled===true;}
 function currentSession(){return window.EchoPrimeWorkspace?.session||bridge()?.session||null;}
 function isApprovedSession(){
  if(!workspaceEnabled())return true;
  const s=currentSession();
  return s?.authenticated===true&&s.user?.status==='approved';
 }

 function requestHeaders(extra={}){
  if(typeof location!=='undefined'&&location.protocol&&!/^https?:$/.test(location.protocol)){
   throw new Error('Open ECHO Prime through its local host to use uploads and artifacts.');
  }
  if(workspaceEnabled()){
   const s=currentSession();
   if(!s?.authenticated||s.user?.status!=='approved'){
    throw new Error('Sign in to an approved Workspace account to use Library and Artifact Center.');
   }
   return {'x-prime-request':'1',...(typeof s.csrf==='string'&&s.csrf?{'x-echo-csrf':s.csrf}:{}),...extra};
  }
  return {'x-prime-request':'1',...extra};
 }

 // ---- State ------------------------------------------------------------------
 let generation=0;
 let controller=new AbortController();
 let uploadMap=new Map();
 let uploadsMeta={configured:false,maxBytes:200*1024*1024,types:[],reason:''};
 let artifactList=[];
 let artifactsMeta={configured:false,reason:''};
 let activeTab='library';
 let layoutMode='grid';
 let kindFilter='all';
 let searchQuery='';
 let artifactSourceFilter='all';
 let artifactKindFilter='all';
 let artifactSearchQuery='';
 let confirmingDeleteId=null;
 let confirmingArtifactDeleteId=null;
 const standaloneAttachments=new Set();

 let dialog=null,tabBar=null,statusNode=null,bodyNode=null;
 let previewDialog=null,previewTitle=null,previewMeta=null,previewBody=null;

 function say(text){if(statusNode)statusNode.textContent=String(text||'').slice(0,600);}

 function emitUploadsChanged(){
  window.dispatchEvent(new Event('echo-uploads-changed'));
  bridge()?.updateContext?.();
 }

 async function primeJson(path,body,signal){
  const turn=generation;
  const sig=signal?AbortSignal.any([controller.signal,signal]):AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
  const headers=requestHeaders(body!==undefined?{'content-type':'application/json'}:{});
  const response=await fetch('/api/prime/'+path,{
   method:body!==undefined?'POST':'GET',
   credentials:'same-origin',
   headers,
   body:body!==undefined?JSON.stringify(body):undefined,
   signal:sig,
  });
  if(!response.headers?.get?.('content-type')?.includes('application/json')){
   throw new Error('Prime host returned an unexpected response.');
  }
  const value=await response.json();
  if(turn!==generation)throw new Error('Account session changed.');
  if(!response.ok){
   if(response.status===401){window.EchoPrimeWorkspace?.invalidate?.();}
   throw new Error(value?.error||'Request failed');
  }
  return value;
 }

 // ---- Client API Methods -----------------------------------------------------
 async function refreshUploads(){
  if(!isApprovedSession())return [];
  const turn=generation;
  const res=await primeJson('uploads/list');
  if(turn!==generation)return [];
  uploadsMeta={
   configured:res.configured===true,
   maxBytes:Number(res.maxBytes)||200*1024*1024,
   types:Array.isArray(res.types)?res.types:[],
   reason:typeof res.reason==='string'?res.reason:'',
  };
  uploadMap=new Map();
  for(const item of Array.isArray(res.uploads)?res.uploads:[]){
   if(item&&typeof item.id==='string')uploadMap.set(item.id,item);
  }
  emitUploadsChanged();
  return [...uploadMap.values()];
 }

 async function refreshArtifacts(){
  if(!isApprovedSession())return [];
  const turn=generation;
  const res=await primeJson('artifacts');
  if(turn!==generation)return [];
  artifactsMeta={configured:res.configured===true,reason:typeof res.reason==='string'?res.reason:''};
  artifactList=Array.isArray(res.artifacts)?res.artifacts:[];
  return artifactList;
 }

 async function uploadFile(file,opts={}){
  if(!file)throw new Error('Choose a file to upload first.');
  const rawName=String(opts.name||file.name||'upload').trim();
  if(!rawName||CREDENTIAL_FILE.test(rawName))throw new Error('Credential and key files belong in the Vault and cannot be uploaded.');
  if(FORBIDDEN_EXT.test(rawName))throw new Error('Executables, scripts and archives are refused.');
  if(uploadsMeta.configured&&Number.isFinite(file.size)&&file.size>uploadsMeta.maxBytes){
   throw new Error(`File exceeds the ${formatBytes(uploadsMeta.maxBytes)} upload limit.`);
  }
  const turn=generation;
  const tags=Array.isArray(opts.tags)?opts.tags.join(','):typeof opts.tags==='string'?opts.tags.trim():'';
  let headers=requestHeaders();
  let body;
  if(typeof FormData==='function'&&(typeof Blob==='undefined'||file instanceof Blob)){
   const form=new FormData();
   if(opts.name)form.append('name',String(opts.name).trim());
   if(tags)form.append('tags',tags);
   form.append('file',file,rawName);
   body=form;
  }else{
   const bytes=typeof file.arrayBuffer==='function'?new Uint8Array(await file.arrayBuffer()):file instanceof Uint8Array?file:typeof file.text==='function'?new TextEncoder().encode(await file.text()):new Uint8Array();
   headers={
    ...headers,
    'Content-Type':String(file.type||'application/octet-stream'),
    'X-Upload-Filename':encodeURIComponent(rawName),
    ...(tags?{'X-Upload-Tags':encodeURIComponent(tags)}:{}),
   };
   body=bytes;
  }
  debugLog('prime_upload_client_start',{size:file.size||0});
  const response=await fetch('/api/prime/uploads',{
   method:'POST',
   credentials:'same-origin',
   headers,
   body,
   signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]),
  });
  const value=await response.json();
  if(turn!==generation)throw new Error('Account session changed.');
  if(!response.ok)throw new Error(value?.error||'Upload failed.');
  uploadMap.set(value.id,value);
  uploadsMeta.configured=true;
  debugLog('prime_upload_client_done',{uploadId:value.id,kind:value.kind});
  emitUploadsChanged();
  return value;
 }

 async function updateUpload(id,patch){
  const updated=await primeJson(`uploads/${encodeURIComponent(id)}/update`,patch);
  uploadMap.set(updated.id,updated);
  emitUploadsChanged();
  return updated;
 }

 async function deleteUpload(id){
  const res=await primeJson(`uploads/${encodeURIComponent(id)}/delete`,{});
  uploadMap.delete(id);
  bridge()?.state?.attachments?.delete?.(id);
  standaloneAttachments.delete(id);
  emitUploadsChanged();
  return res;
 }

 async function registerArtifact(payload){
  if(!isApprovedSession())return null;
  const record=await primeJson('artifacts',payload);
  artifactList=[record,...artifactList.filter(a=>a.id!==record.id)];
  debugLog('prime_artifact_client_registered',{artifactId:record.id,kind:record.kind});
  if(dialog?.open&&activeTab==='artifacts')paint();
  return record;
 }

 async function deleteArtifact(id){
  const res=await primeJson(`artifacts/${encodeURIComponent(id)}/delete`,{});
  artifactList=artifactList.filter(a=>a.id!==id);
  return res;
 }

 // ---- Preview Modal ----------------------------------------------------------
 function ensurePreviewDialog(){
  if(previewDialog)return;
  const close=el('button',{type:'button',class:'icon-button close-dialog','aria-label':'Close preview'},'×');
  previewTitle=el('h3',{id:'library-preview-title'},'Preview');
  previewMeta=el('p',{class:'views-muted'},'');
  previewBody=el('div',{class:'library-preview-body'});
  previewDialog=el('dialog',{id:'library-preview-dialog',class:'panel-dialog workspace-dialog library-preview-dialog','aria-labelledby':'library-preview-title'},
   el('div',{class:'dialog-title'},previewTitle,close),
   previewMeta,
   previewBody);
  close.addEventListener('click',()=>previewDialog.close());
  previewDialog.addEventListener('click',e=>{
   if(e.target!==previewDialog)return;
   const r=previewDialog.getBoundingClientRect();
   if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)previewDialog.close();
  });
  previewDialog.addEventListener('close',()=>{previewBody.replaceChildren();previewTitle.textContent='';previewMeta.textContent='';});
  doc.body.append(previewDialog);
 }

 async function openUploadPreview(item){
  ensurePreviewDialog();
  const turn=generation;
  const fileUrl=`/api/prime/uploads/${encodeURIComponent(item.id)}/file`;
  previewTitle.textContent=item.name;
  const dims=item.width&&item.height?` · ${item.width}×${item.height}`:'';
  const dur=item.duration?` · ${item.duration}s`:'';
  const pgs=item.pages?` · ${item.pages} page${item.pages===1?'':'s'}`:'';
  previewMeta.textContent=`${item.type} · ${formatBytes(item.bytes)}${dims}${dur}${pgs}`;
  previewBody.replaceChildren();

  if(item.kind==='image'){
   previewBody.append(el('img',{class:'preview-media',src:fileUrl,alt:item.name}));
  }else if(item.kind==='video'){
   previewBody.append(el('video',{class:'preview-media',controls:'controls',preload:'metadata',src:fileUrl}));
  }else if(item.kind==='audio'){
   previewBody.append(el('audio',{class:'preview-audio',controls:'controls',preload:'metadata',src:fileUrl}));
  }else if(item.type==='application/pdf'){
   previewBody.append(el('iframe',{class:'preview-pdf',title:item.name,src:fileUrl}));
  }else if(['text/plain','text/markdown','text/csv','application/json'].includes(item.type)){
   const loading=el('p',{class:'views-muted'},'Loading text preview…');
   previewBody.append(loading);
   if(!previewDialog.open)previewDialog.showModal();
   try{
    const resp=await fetch(fileUrl,{
     credentials:'same-origin',
     headers:{...requestHeaders(),Range:`bytes=0-${LIMITS.previewTextBytes-1}`},
     signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),
    });
    const text=await resp.text();
    if(turn!==generation||!previewDialog.open)return;
    previewBody.replaceChildren(...[
     el('pre',{class:'preview-text'},text),
     item.bytes>LIMITS.previewTextBytes?el('small',{class:'views-muted'},`Showing first ${formatBytes(LIMITS.previewTextBytes)} of ${formatBytes(item.bytes)}.`):null,
     el('div',{class:'library-actions'},el('a',{class:'quiet-button',href:`${fileUrl}?download=1`,download:item.name},'Download original'))
    ].filter(Boolean));
    return;
   }catch(err){
    if(turn===generation&&previewDialog.open)previewBody.replaceChildren(el('p',{class:'views-muted'},errText(err)));
    return;
   }
  }else{
   previewBody.append(el('p',{class:'views-muted'},`SHA-256: ${item.sha256||'verified on server'}. Download to inspect in a local office reader.`));
  }
  previewBody.append(el('div',{class:'library-actions'},el('a',{class:'quiet-button',href:`${fileUrl}?download=1`,download:item.name},'Download file')));
  if(!previewDialog.open)previewDialog.showModal();
 }

 async function openWorkspaceFilePreview(item){
  const b=bridge();if(!b)return;
  const turn=generation;
  const value=await b.api('/library/'+encodeURIComponent(item.id));
  if(turn!==generation)return;
  ensurePreviewDialog();
  const title=String(value?.name||item.name||'File');
  const text=typeof value?.content==='string'?value.content:'';
  previewTitle.textContent=title;
  previewMeta.textContent=String(value?.path||item.path||'Workspace library file');
  const dlBtn=el('button',{type:'button',class:'quiet-button'},'Download');
  dlBtn.addEventListener('click',()=>{
   const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob);
   const a=el('a',{href:url,download:title.replace(/[\\/]/g,'_').slice(0,120)});
   a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  previewBody.replaceChildren(el('pre',{class:'preview-text'},text),el('div',{class:'library-actions'},dlBtn));
  if(!previewDialog.open)previewDialog.showModal();
 }

 async function openArtifactPreview(art){
  const turn=generation;
  const detail=await primeJson(`artifacts/${encodeURIComponent(art.id)}`);
  if(turn!==generation)return;
  ensurePreviewDialog();
  previewTitle.textContent=detail.title;
  previewMeta.textContent=`${detail.provenance?.source||'artifact'} · ${detail.kind} · ${formatBytes(detail.bytes)}`;
  previewBody.replaceChildren();
  if(detail.upload_id){
   const uUrl=`/api/prime/uploads/${encodeURIComponent(detail.upload_id)}/file`;
   if(detail.kind==='image')previewBody.append(el('img',{class:'preview-media',src:uUrl,alt:detail.title}));
   else if(detail.kind==='video')previewBody.append(el('video',{class:'preview-media',controls:'controls',src:uUrl}));
   else if(['music','sound','voice'].includes(detail.kind))previewBody.append(el('audio',{class:'preview-audio',controls:'controls',src:uUrl}));
  }
  if(typeof detail.content==='string'&&detail.content){
   previewBody.append(el('pre',{class:'preview-text'},detail.content));
  }
  previewBody.append(renderProvenanceList(detail.provenance));
  previewBody.append(el('div',{class:'library-actions'},el('a',{class:'quiet-button',href:`/api/prime/artifacts/${encodeURIComponent(detail.id)}/file?download=1`,download:detail.title},'Download artifact')));
  if(!previewDialog.open)previewDialog.showModal();
 }

 // ---- Actions: Attach to Chat & Use in Studio --------------------------------
 function attachItemToChat(id,name){
  const b=bridge();
  if(b){
   if(b.state.attachments.size>=8&&!b.state.attachments.has(id)){
    say('Attach at most 8 files per message.');
    return;
   }
   b.state.attachments.add(id);
   b.updateContext();
  }else{
   if(standaloneAttachments.size>=8&&!standaloneAttachments.has(id)){
    say('Attach at most 8 files per message.');
    return;
   }
   standaloneAttachments.add(id);
   window.dispatchEvent(new Event('echo-uploads-changed'));
  }
  notifyDraft(`Attached ${name} to your next message.`);
  if(dialog?.open)dialog.close();
  $('#prompt')?.focus?.();
 }

 function useUploadInStudio(item){
  if(!window.EchoPrimeStudio?.open){
   say('Creative Studio is unavailable in this view.');
   return;
  }
  const target=studioTargetForUpload(item);
  if(dialog?.open)dialog.close();
  window.EchoPrimeStudio.open(target.category,'',[{upload_id:item.id,role:target.role}]);
 }

 function reuseArtifact(art){
  const prov=art.provenance||{};
  const studioKinds=['image','video','music','sound','voice'];
  if((prov.source==='studio'||studioKinds.includes(art.kind))&&window.EchoPrimeStudio?.open){
   const cat=studioKinds.includes(art.kind)?art.kind:'image';
   const inputs=Array.isArray(prov.inputs)&&prov.inputs.length?prov.inputs:(art.upload_id?[{upload_id:art.upload_id,role:'reference'}]:[]);
   if(dialog?.open)dialog.close();
   window.EchoPrimeStudio.open(cat,prov.prompt||'',inputs);
   return;
  }
  const promptNode=$('#prompt');
  if(promptNode){
   promptNode.value=prov.prompt||art.summary||art.title||'';
   bridge()?.updateContext?.();
   notifyDraft(`Loaded "${art.title}" prompt into composer.`);
   if(dialog?.open)dialog.close();
   promptNode.focus?.();
  }
 }

 // ---- Rendering --------------------------------------------------------------
 function ensureDialog(){
  if(dialog)return;
  const close=el('button',{type:'button',class:'icon-button close-dialog','aria-label':'Close Library and Artifact Center'},'×');
  statusNode=el('p',{role:'status','aria-live':'polite',class:'library-status'});
  tabBar=el('div',{class:'library-tabs',role:'tablist','aria-label':'Library and Artifact Center tabs'});
  bodyNode=el('div',{class:'library-body'});
  dialog=el('dialog',{id:'library-dialog',class:'panel-dialog workspace-dialog library-dialog','aria-labelledby':'library-dialog-title'},
   el('div',{class:'dialog-title'},el('div',{},el('span',{class:'eyebrow'},'ECHO LIBRARY & ARTIFACTS'),el('h2',{id:'library-dialog-title'},'Library & Artifact Center')),close),
   tabBar,
   statusNode,
   bodyNode);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{
   if(e.target!==dialog)return;
   const r=dialog.getBoundingClientRect();
   if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();
  });
  dialog.addEventListener('close',()=>{
   confirmingDeleteId=null;
   confirmingArtifactDeleteId=null;
   say('');
  });
  doc.body.append(dialog);
 }

 function renderTabs(){
  const libCount=uploadMap.size+(Array.isArray(bridge()?.state?.data?.library)?bridge().state.data.library.length:0);
  const artCount=artifactList.length;
  const makeTab=(id,label,count)=>{
   const btn=el('button',{type:'button',role:'tab',class:'library-tab','data-library-tab':id,'aria-selected':String(activeTab===id)},
    label,el('span',{class:'library-tab-count'},String(count)));
   btn.addEventListener('click',()=>{activeTab=id;confirmingDeleteId=null;confirmingArtifactDeleteId=null;say('');paint();});
   return btn;
  };
  tabBar.replaceChildren(makeTab('library','Library',libCount),makeTab('artifacts','Artifact Center',artCount));
 }

 function renderUploadCardItem(item,turn){
  const fileUrl=`/api/prime/uploads/${encodeURIComponent(item.id)}/file`;
  const visual=el('div',{class:'library-visual'});
  if(item.kind==='image'){
   visual.append(el('img',{class:'library-thumb',src:`${fileUrl}?thumb=1`,alt:item.name,loading:'lazy'}));
  }else{
   const sub=item.width&&item.height?`${item.width}×${item.height}`:item.duration?`${item.duration}s`:item.pages?`${item.pages}p`:formatBytes(item.bytes);
   visual.append(el('span',{class:'library-kind-badge'},item.kind.toUpperCase(),el('small',{},sub)));
  }

  const dims=item.width&&item.height?` · ${item.width}×${item.height}`:'';
  const dur=item.duration?` · ${item.duration}s`:'';
  const pgs=item.pages?` · ${item.pages} page${item.pages===1?'':'s'}`:'';
  const meta=el('div',{class:'library-meta'},
   el('strong',{},item.name),
   el('small',{},`${item.type} · ${formatBytes(item.bytes)}${dims}${dur}${pgs}`),
   el('div',{class:'library-tags'},
    item.exif_gps_stripped?el('span',{class:'hygiene-badge'},'EXIF GPS stripped'):null,
    ...(item.tags||[]).map(t=>el('span',{class:'library-tag'},`#${t}`))
   )
  );

  const previewBtn=el('button',{type:'button',class:'quiet-button','data-action':'preview'},'Preview');
  previewBtn.addEventListener('click',()=>void openUploadPreview(item).catch(e=>say(errText(e))));

  const attachBtn=el('button',{type:'button',class:'quiet-button','data-action':'attach'},'Attach to chat');
  attachBtn.addEventListener('click',()=>attachItemToChat(item.id,item.name));

  const studioBtn=el('button',{type:'button',class:'new-chat','data-action':'use-in-studio'},'Use in Studio');
  studioBtn.addEventListener('click',()=>useUploadInStudio(item));

  const downloadLink=el('a',{class:'quiet-button',href:`${fileUrl}?download=1`,download:item.name},'Download');

  const delBtn=el('button',{type:'button',class:'quiet-button','data-action':'delete-step1'},'Delete');
  delBtn.addEventListener('click',()=>{confirmingDeleteId=item.id;paint();});

  const actions=el('div',{class:'library-actions library-card-full'},previewBtn,studioBtn,attachBtn,downloadLink,delBtn);

  let confirmRow=null;
  if(confirmingDeleteId===item.id){
   const confirmYes=el('button',{type:'button',class:'danger-button','data-action':'delete-confirm'},'Confirm delete');
   const confirmNo=el('button',{type:'button',class:'quiet-button','data-action':'delete-cancel'},'Cancel');
   confirmYes.addEventListener('click',async()=>{
    confirmYes.disabled=true;
    try{
     await deleteUpload(item.id);
     if(turn!==generation)return;
     confirmingDeleteId=null;
     say(`Deleted ${item.name}.`);
     paint();
    }catch(e){if(turn===generation)say(errText(e));}
    finally{confirmYes.disabled=false;}
   });
   confirmNo.addEventListener('click',()=>{confirmingDeleteId=null;paint();});
   confirmRow=el('div',{class:'library-confirm-delete library-card-full'},`Delete "${item.name}" permanently?`,confirmYes,confirmNo);
  }

  const renameInput=el('input',{type:'text',value:item.name,'data-field':`rename-${item.id}`,maxlength:'180'});
  const tagsInput=el('input',{type:'text',value:(item.tags||[]).join(', '),'data-field':`tags-${item.id}`,placeholder:'reference, character, draft'});
  const saveEdit=el('button',{type:'button',class:'quiet-button','data-action':'save-meta'},'Save changes');
  saveEdit.addEventListener('click',async()=>{
   saveEdit.disabled=true;
   try{
    const nextTags=tagsInput.value.split(',').map(s=>s.trim()).filter(Boolean);
    await updateUpload(item.id,{name:renameInput.value.trim(),tags:nextTags});
    if(turn!==generation)return;
    say(`Updated ${renameInput.value.trim()}.`);
    paint();
   }catch(e){if(turn===generation)say(errText(e));}
   finally{saveEdit.disabled=false;}
  });
  const editDetails=el('details',{class:'library-edit library-card-full'},
   el('summary',{},'Rename & tags'),
   el('label',{class:'workspace-field'},el('span',{},'Name'),renameInput),
   el('label',{class:'workspace-field'},el('span',{},'Tags (comma-separated)'),tagsInput),
   saveEdit);

  return el('article',{class:'library-card','data-upload-id':item.id,'data-item-kind':item.kind},visual,meta,actions,confirmRow,editDetails);
 }

 function renderWorkspaceCardItem(item,turn){
  const visual=el('div',{class:'library-visual'},el('span',{class:'library-kind-badge'},'NOTE',el('small',{},'Workspace')));
  const meta=el('div',{class:'library-meta'},
   el('strong',{},item.name),
   el('small',{},item.path),
   el('div',{class:'library-tags'},el('span',{class:'source-badge'},'Workspace'))
  );
  const previewBtn=el('button',{type:'button',class:'quiet-button','data-action':'preview'},'Preview');
  previewBtn.addEventListener('click',()=>void openWorkspaceFilePreview(item).catch(e=>say(errText(e))));
  const attachBtn=el('button',{type:'button',class:'quiet-button','data-action':'attach'},'Attach to chat');
  attachBtn.addEventListener('click',()=>attachItemToChat(item.id,item.name));
  const reviewBtn=el('button',{type:'button',class:'quiet-button','data-action':'review'},'Review');
  reviewBtn.addEventListener('click',async()=>{
   const b=bridge();if(!b||!window.EchoPrimeViews?.open)return;
   try{
    const val=await b.api('/library/'+encodeURIComponent(item.id));
    if(turn!==generation)return;
    if(typeof val?.content!=='string')throw new Error('This file has no text content to review.');
    dialog.close();
    await window.EchoPrimeViews.open('review');
    window.EchoPrimeViews.prefillReview?.(String(val.name||item.name||'file.txt'),val.content,typeof val.project_id==='string'?val.project_id:null);
   }catch(e){if(turn===generation)say(errText(e));}
  });
  const chatBtn=item.chat_id?el('button',{type:'button',class:'quiet-button'},'Open chat'):null;
  if(chatBtn)chatBtn.addEventListener('click',async()=>{const b=bridge();if(!b)return;dialog.close();await b.openChat(item.chat_id);});

  const actions=el('div',{class:'library-actions library-card-full'},previewBtn,attachBtn,reviewBtn,chatBtn);
  return el('article',{class:'library-card workspace-item','data-library-id':item.id,'data-item-kind':'workspace'},visual,meta,actions);
 }

 function renderWorkspaceAuthoringTools(turn){
  const b=bridge();
  if(!b||!b.state?.data)return null;
  const noteName=el('input',{type:'text',placeholder:'note.md','data-field':'note-name',autocomplete:'off'});
  const noteContent=el('textarea',{rows:'6',placeholder:'Text or code','data-field':'note-content',maxlength:String(LIMITS.wsNote),spellcheck:'false'});
  const saveNote=el('button',{type:'button',class:'new-chat'},'Save note');
  saveNote.addEventListener('click',async()=>{
   saveNote.disabled=true;
   try{
    const fn=noteName.value.trim(),val=noteContent.value;
    if(!fn||CREDENTIAL_FILE.test(fn))throw new Error('Choose a file name that is not a credential file. Credentials belong in the Vault.');
    if(!val.trim()||val.length>LIMITS.wsNote)throw new Error('Enter between 1 and 500,000 characters.');
    const item=await b.api('/library',{name:fn,content:val,chat_id:b.state.chat?.id,project_id:b.state.chat?.project_id||$('#workspace-project')?.value||null});
    await b.refresh();
    if(turn!==generation)return;
    say('Saved'+(item?.path?': '+item.path:'.'));
    paint();
   }catch(e){if(turn===generation)say(errText(e));}
   finally{saveNote.disabled=false;}
  });

  const wsQuickUpload=el('input',{type:'file',accept:'.txt,.md,.py,.js,.ts,.tsx,.jsx,.json,.html,.css,.csv,.sql,.ps1,.sh,.diff,.patch','data-field':'library-upload'});
  wsQuickUpload.addEventListener('change',async()=>{
   const chosen=wsQuickUpload.files?.[0];
   try{
    if(!chosen)return;
    if(chosen.size>LIMITS.wsUpload)throw new Error('Choose a text file under 100 KB for Workspace journal notes, or use the media uploader above.');
    if(CREDENTIAL_FILE.test(chosen.name))throw new Error('Credential files belong in the Vault.');
    const text=await chosen.text();
    if(turn!==generation)return;
    await b.api('/library',{name:chosen.name,content:text,chat_id:b.state.chat?.id,project_id:b.state.chat?.project_id||$('#workspace-project')?.value||null});
    await b.refresh();
    if(turn!==generation)return;
    say('Uploaded Workspace note '+chosen.name+'.');
    paint();
   }catch(e){if(turn===generation)say(errText(e));}
   finally{wsQuickUpload.value='';}
  });

  const impSource=el('select',{'data-field':'import-source'},...['chatgpt','claude','grok','other'].map(v=>el('option',{value:v},v)));
  impSource.value='chatgpt';
  const impTitle=el('input',{type:'text',placeholder:'Chat title','data-field':'import-title'});
  const impData=el('textarea',{rows:'5',placeholder:'Paste a normalized JSON chat or transcript','data-field':'import-data',spellcheck:'false'});
  const impFile=el('input',{type:'file',accept:'.json,.txt,.md','data-field':'import-file'});
  impFile.addEventListener('change',async()=>{
   const chosen=impFile.files?.[0];
   try{
    if(!chosen)return;
    if(chosen.size>LIMITS.wsImport)throw new Error('Choose an export under 1.9 MB.');
    const text=await chosen.text();
    if(turn!==generation)return;
    impData.value=text;if(!impTitle.value)impTitle.value=chosen.name;
   }catch(e){if(turn===generation)say(errText(e));}
   finally{impFile.value='';}
  });
  const impBtn=el('button',{type:'button',class:'new-chat'},'Import chat');
  impBtn.addEventListener('click',async()=>{
   impBtn.disabled=true;
   try{
    if(typeof b.normalizeImport!=='function')throw new Error('Import is unavailable in this Prime build.');
    const payload={...b.normalizeImport(impData.value,impTitle.value),source:impSource.value};
    const res=await b.api('/import',payload);
    await b.refresh();
    if(turn!==generation)return;
    say('Import returned.');
    if(typeof res?.id==='string'){dialog.close();await b.openChat(res.id);}
   }catch(e){if(turn===generation)say(errText(e));}
   finally{impBtn.disabled=false;}
  });

  return el('details',{class:'library-workspace-tools'},
   el('summary',{},'Workspace notes & chat import (journaled)'),
   el('div',{class:'library-workspace-grid'},
    el('article',{class:'workspace-card-content views-card'},
     el('h3',{},'Write a note'),
     el('label',{class:'workspace-field'},el('span',{},'Filename'),noteName),
     el('label',{class:'workspace-field'},el('span',{},'Content'),noteContent),
     el('label',{class:'workspace-field'},el('span',{},'Quick text note upload · up to 100 KB'),wsQuickUpload),
     saveNote),
    el('article',{class:'workspace-card-content views-card'},
     el('h3',{},'Import an earlier chat · up to 1.9 MB'),
     el('label',{class:'workspace-field'},el('span',{},'Source'),impSource),
     el('label',{class:'workspace-field'},el('span',{},'Title'),impTitle),
     el('label',{class:'workspace-field'},el('span',{},'Export file'),impFile),
     el('label',{class:'workspace-field'},el('span',{},'Transcript or JSON'),impData),
     impBtn)));
 }

 function renderLibraryTab(turn){
  const filePicker=el('input',{type:'file',accept:UPLOAD_ACCEPT,'data-field':'prime-upload-file','aria-label':'Choose image, video, audio or document'});
  const customName=el('input',{type:'text',placeholder:'Optional display name','data-field':'prime-upload-name',maxlength:'180'});
  const customTags=el('input',{type:'text',placeholder:'Optional tags (e.g. hero, ref)','data-field':'prime-upload-tags',maxlength:'240'});
  const uploadBtn=el('button',{type:'button',class:'new-chat','data-action':'submit-upload'},'Upload to Library');

  const runUpload=async()=>{
   const chosen=filePicker.files?.[0];
   if(!chosen){say('Choose a file first.');return;}
   uploadBtn.disabled=true;
   say(`Uploading ${chosen.name}…`);
   try{
    const meta=await uploadFile(chosen,{name:customName.value.trim()||undefined,tags:customTags.value.trim()||undefined});
    if(turn!==generation)return;
    customName.value='';customTags.value='';filePicker.value='';
    say(`Uploaded ${meta.name} (${formatBytes(meta.bytes)}${meta.exif_gps_stripped?' · EXIF GPS stripped':''}).`);
    paint();
   }catch(e){if(turn===generation)say(errText(e));}
   finally{uploadBtn.disabled=false;}
  };
  uploadBtn.addEventListener('click',runUpload);

  const uploadSection=uploadsMeta.configured
   ?el('section',{class:'library-upload-card'},
     el('h3',{},`Upload pictures, video, audio & documents · up to ${formatBytes(uploadsMeta.maxBytes)}`),
     el('p',{class:'views-muted'},'Images (PNG, JPEG with automatic EXIF GPS strip, WebP, GIF), video (MP4, WebM, MOV), audio (MP3, WAV), PDF, Office (DOCX/XLSX/PPTX) and text/CSV/JSON. Executables and archives are refused.'),
     el('div',{class:'library-upload-row'},
      el('label',{class:'workspace-field'},el('span',{},'File'),filePicker),
      el('label',{class:'workspace-field'},el('span',{},'Display name'),customName),
      el('label',{class:'workspace-field'},el('span',{},'Tags'),customTags),
      uploadBtn))
   :el('p',{class:'views-callout'},uploadsMeta.reason||'Local media & document uploads are off: add an `uploads` section to the Prime config to enable streaming uploads.');

  const searchInput=el('input',{type:'search',value:searchQuery,placeholder:'Search names, paths, types and tags…','aria-label':'Search unified library','data-field':'unified-search'});
  const kindDefs=[
   ['all','All'],['image','Images'],['video','Video'],['audio','Audio'],['document','Documents'],['file','Files'],['workspace','Workspace notes']
  ];
  const filterBar=el('div',{class:'library-filters'});
  for(const [k,label] of kindDefs){
   const pill=el('button',{type:'button',class:'library-pill','data-kind-filter':k,'aria-pressed':String(kindFilter===k)},label);
   pill.addEventListener('click',()=>{kindFilter=k;paint();});
   filterBar.append(pill);
  }
  const gridBtn=el('button',{type:'button',class:'library-pill','data-layout-mode':'grid','aria-pressed':String(layoutMode==='grid')},'Grid');
  const listBtn=el('button',{type:'button',class:'library-pill','data-layout-mode':'list','aria-pressed':String(layoutMode==='list')},'List');
  gridBtn.addEventListener('click',()=>{layoutMode='grid';paint();});
  listBtn.addEventListener('click',()=>{layoutMode='list';paint();});

  const toolbar=el('div',{class:'library-toolbar'},
   el('div',{class:'library-search-wrap'},searchInput),
   filterBar,
   el('div',{class:'library-layout-toggle'},gridBtn,listBtn));

  const container=el('div',{class:`library-items mode-${layoutMode}`,'data-layout':layoutMode});
  const renderList=()=>{
   const merged=mergeLibraryItems([...uploadMap.values()],bridge()?.state?.data?.library||[]);
   const visible=filterUnifiedItems(merged,{kind:kindFilter,query:searchQuery});
   container.replaceChildren(...visible.slice(0,500).map(item=>item.source==='upload'?renderUploadCardItem(item,turn):renderWorkspaceCardItem(item,turn)));
   if(!visible.length){
    container.append(el('p',{class:'views-empty'},merged.length?'No library items match the current search or filter.':'No uploads or Workspace files yet. Upload a picture, video or document above.'));
   }
  };
  searchInput.addEventListener('input',()=>{searchQuery=searchInput.value;renderList();});
  renderList();

  return [uploadSection,toolbar,container,renderWorkspaceAuthoringTools(turn)];
 }

 function renderProvenanceList(prov){
  const p=prov&&typeof prov==='object'?prov:{};
  const dl=el('dl',{class:'artifact-provenance'});
  const addRow=(label,val)=>{if(val!==undefined&&val!==null&&String(val).trim()!=='')dl.append(el('dt',{},label),el('dd',{},val));};
  addRow('Source',p.source||'other');
  addRow('Prompt',p.prompt);
  addRow('Model',p.model);
  addRow('Capability',p.capability);
  addRow('Agent',p.agent);
  addRow('Run ID',p.run_id);
  addRow('Verdict',p.verdict);
  addRow('Events SHA-256',p.events_sha256);
  addRow('Chat ID',p.chat_id);
  if(Array.isArray(p.inputs)&&p.inputs.length){
   addRow('Reference inputs',p.inputs.map(i=>`${i.role}:${i.upload_id}`).join(', '));
  }
  return dl;
 }

 function renderArtifactCard(art,turn){
  const prov=art.provenance||{};
  const head=el('div',{class:'artifact-head'},
   el('strong',{},art.title),
   el('div',{class:'artifact-badges'},
    el('span',{class:'source-badge'},prov.source||'other'),
    el('span',{class:'library-tag'},art.kind||'other'),
    ...(art.tags||[]).map(t=>el('span',{class:'library-tag'},`#${t}`))
   )
  );
  const metaLine=el('p',{class:'artifact-meta-line'},`${art.type||'application/json'} · ${formatBytes(art.bytes)} · ${art.created_at||''}`);
  const thumb=art.upload_id&&art.kind==='image'
   ?el('div',{class:'library-visual'},el('img',{class:'library-thumb',src:`/api/prime/uploads/${encodeURIComponent(art.upload_id)}/file?thumb=1`,alt:art.title,loading:'lazy'}))
   :null;

  const provList=renderProvenanceList(prov);

  const previewBtn=el('button',{type:'button',class:'quiet-button','data-action':'artifact-preview'},'Preview');
  previewBtn.addEventListener('click',()=>void openArtifactPreview(art).catch(e=>say(errText(e))));

  const reuseBtn=el('button',{type:'button',class:'new-chat','data-action':'artifact-reuse'},'Re-use');
  reuseBtn.addEventListener('click',()=>reuseArtifact(art));

  const downloadLink=el('a',{class:'quiet-button',href:`/api/prime/artifacts/${encodeURIComponent(art.id)}/file?download=1`,download:art.title},'Download');

  const openChatBtn=prov.chat_id&&bridge()?.openChat?el('button',{type:'button',class:'quiet-button'},'Open chat'):null;
  if(openChatBtn)openChatBtn.addEventListener('click',async()=>{dialog.close();await bridge().openChat(prov.chat_id);});

  const delBtn=el('button',{type:'button',class:'quiet-button','data-action':'artifact-delete-step1'},'Delete');
  delBtn.addEventListener('click',()=>{confirmingArtifactDeleteId=art.id;paint();});

  const actions=el('div',{class:'library-actions'},previewBtn,reuseBtn,downloadLink,openChatBtn,delBtn);

  let confirmRow=null;
  if(confirmingArtifactDeleteId===art.id){
   const yes=el('button',{type:'button',class:'danger-button','data-action':'artifact-delete-confirm'},'Confirm delete');
   const no=el('button',{type:'button',class:'quiet-button','data-action':'artifact-delete-cancel'},'Cancel');
   yes.addEventListener('click',async()=>{
    yes.disabled=true;
    try{
     await deleteArtifact(art.id);
     if(turn!==generation)return;
     confirmingArtifactDeleteId=null;
     say(`Removed artifact "${art.title}".`);
     paint();
    }catch(e){if(turn===generation)say(errText(e));}
    finally{yes.disabled=false;}
   });
   no.addEventListener('click',()=>{confirmingArtifactDeleteId=null;paint();});
   confirmRow=el('div',{class:'library-confirm-delete'},`Delete artifact "${art.title}"?`,yes,no);
  }

  return el('article',{class:'artifact-card','data-artifact-id':art.id,'data-artifact-source':prov.source||'other'},head,metaLine,thumb,provList,actions,confirmRow);
 }

 function renderArtifactsTab(turn){
  const searchInput=el('input',{type:'search',value:artifactSearchQuery,placeholder:'Search title, prompt, model, capability or run ID…','aria-label':'Search artifacts','data-field':'artifact-search'});
  const sources=[['all','All sources'],['studio','Studio'],['build','Echo Build'],['adk','ADK Runs'],['chat_export','Exported Chats']];
  const srcBar=el('div',{class:'library-filters'});
  for(const [val,label] of sources){
   const pill=el('button',{type:'button',class:'library-pill','data-source-filter':val,'aria-pressed':String(artifactSourceFilter===val)},label);
   pill.addEventListener('click',()=>{artifactSourceFilter=val;paint();});
   srcBar.append(pill);
  }
  const kindSelect=el('select',{'data-field':'artifact-kind','aria-label':'Filter artifacts by kind'},
   ...['all','image','video','music','sound','voice','code','proof','chat','document','other'].map(k=>el('option',{value:k},k==='all'?'All kinds':k)));
  kindSelect.value=artifactKindFilter;
  kindSelect.addEventListener('change',()=>{artifactKindFilter=kindSelect.value;paint();});

  const exportChatBtn=bridge()?.state?.chat?.messages?.length&&artifactsMeta.configured
   ?el('button',{type:'button',class:'quiet-button','data-action':'export-current-chat'},'Export current chat')
   :null;
  if(exportChatBtn){
   exportChatBtn.addEventListener('click',async()=>{
    const chat=bridge()?.state?.chat;if(!chat)return;
    exportChatBtn.disabled=true;
    try{
     const lines=(chat.messages||[]).map(m=>`### ${m.role||'message'}\n\n${m.content||''}`).join('\n\n---\n\n');
     await registerArtifact({
      title:chat.title||'Exported conversation',
      kind:'chat',
      type:'text/markdown',
      content:`# ${chat.title||'Conversation'}\n\n${lines}`,
      provenance:{source:'chat_export',chat_id:chat.id,prompt:(chat.messages||[]).find(m=>m.role==='user')?.content?.slice(0,500)},
     });
     if(turn===generation)say('Exported current conversation to Artifact Center.');
    }catch(e){if(turn===generation)say(errText(e));}
    finally{exportChatBtn.disabled=false;}
   });
  }

  const toolbar=el('div',{class:'library-toolbar'},el('div',{class:'library-search-wrap'},searchInput),srcBar,kindSelect,exportChatBtn);
  const listWrap=el('div',{class:'library-items mode-list'});
  const draw=()=>{
   const visible=filterArtifacts(artifactList,{kind:artifactKindFilter,source:artifactSourceFilter,query:artifactSearchQuery});
   listWrap.replaceChildren(...visible.slice(0,500).map(art=>renderArtifactCard(art,turn)));
   if(!visible.length){
    listWrap.append(el('p',{class:'views-empty'},artifactList.length?'No artifacts match this filter.':'No artifacts recorded yet. Studio generations, Echo Build replies, ADK run proofs and exported chats appear here with provenance.'));
   }
  };
  searchInput.addEventListener('input',()=>{artifactSearchQuery=searchInput.value;draw();});
  draw();

  const banner=!artifactsMeta.configured?el('p',{class:'views-callout'},artifactsMeta.reason||'Artifact Center persistence is off: add an `uploads` section to the Prime config.'):null;
  return [banner,toolbar,listWrap];
 }

 function paint(){
  if(!dialog?.open)return;
  const turn=generation;
  renderTabs();
  if(!isApprovedSession()){
   bodyNode.replaceChildren(el('p',{class:'views-empty'},'Sign in to an approved Workspace account to use Library and Artifact Center.'));
   return;
  }
  bodyNode.replaceChildren(...(activeTab==='artifacts'?renderArtifactsTab(turn):renderLibraryTab(turn)).filter(Boolean));
 }

 async function open(tab='library'){
  activeTab=tab==='artifacts'?'artifacts':'library';
  ensureDialog();
  if(!dialog.open)dialog.showModal();
  const turn=++generation;
  confirmingDeleteId=null;
  confirmingArtifactDeleteId=null;
  say('');
  paint();
  if(!isApprovedSession())return true;
  try{
   const tasks=[refreshUploads(),refreshArtifacts()];
   if(bridge()?.refresh)tasks.push(bridge().refresh());
   await Promise.all(tasks);
  }catch(e){
   if(turn===generation)say(errText(e));
  }
  if(turn===generation&&dialog.open)paint();
  return true;
 }

 function close(){
  if(previewDialog?.open)previewDialog.close();
  if(dialog?.open)dialog.close();
 }

 function resetForAccountChange(){
  generation++;
  controller.abort();
  controller=new AbortController();
  uploadMap=new Map();
  artifactList=[];
  standaloneAttachments.clear();
  searchQuery='';
  artifactSearchQuery='';
  confirmingDeleteId=null;
  confirmingArtifactDeleteId=null;
  close();
  bodyNode?.replaceChildren();
  say('');
 }

 window.addEventListener('echo-account-changed',resetForAccountChange);

 // Bind dedicated nav triggers when present in index.html
 $('#open-library')?.addEventListener('click',()=>void open('library'));
 $('#open-artifacts')?.addEventListener('click',()=>void open('artifacts'));

 window.EchoPrimeLibrary={
  open,
  close,
  refresh:async()=>{await Promise.all([refreshUploads(),refreshArtifacts()]);if(dialog?.open)paint();},
  uploads:()=>[...uploadMap.values()],
  uploadById:id=>uploadMap.get(id)||null,
  standaloneAttachments:()=>standaloneAttachments,
  uploadFile,
  updateUpload,
  deleteUpload,
  core:{formatBytes,studioTargetForUpload,mergeLibraryItems,filterUnifiedItems,filterArtifacts},
 };

 window.EchoPrimeArtifacts={
  register:registerArtifact,
  list:()=>[...artifactList],
  get:id=>primeJson(`artifacts/${encodeURIComponent(id)}`),
  remove:deleteArtifact,
 };
})();
