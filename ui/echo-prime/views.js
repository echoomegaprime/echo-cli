(() => {
 'use strict';
 // First-class Workspace views for Prime: Projects, Library, SDK, Vault and Code
 // review (reference: Workspace static/app.js renderProjects, renderLibrary,
 // renderSdk, renderVault, renderReview), plus the `ui_action` navigation a tool
 // result may request after a reply (app.js:176,192). Every request goes through
 // window.EchoPrimeWorkspace.bridge, i.e. the allowlisted /api/workspace routes.
 // Admission is read from the cached /api/session readback: nothing is fetched
 // while anonymous, and SDK/Vault never fetch for a member. No browser storage.
 const doc=document,$=selector=>doc.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const UI_VIEWS=['chats','projects','library','plugins','sdk','vault','review','media','diagnostics'];
 const LIMITS={upload:100000,importFile:1900000,review:40000,note:500000,catalogQuery:300};
 const SECRET_KEY=/secret|token|password|passphrase|credential|api.?key|private.?key/i;
 const CREDENTIAL_FILE=/(?:^\.env|id_rsa|id_ed25519|credentials?|secrets?|\.(?:pem|key|pfx|p12|db)$)/i;
 const MASK='••••••••';

 // ---- pure helpers (exported for tests) -------------------------------------
 function filterLibrary(items,query){
  const rows=Array.isArray(items)?items.filter(item=>item&&typeof item==='object'):[],needle=String(query||'').trim().toLowerCase();
  if(!needle)return rows;
  return rows.filter(item=>(String(item.name||'')+' '+String(item.path||'')).toLowerCase().includes(needle));
 }
 // The Workspace has no `?project=` route (app.py /api/chats takes only `q`); app.js:212-215 filters the saved
 // chat list client-side, and so does Prime.
 function projectChats(chats,projectId){
  return (Array.isArray(chats)?chats:[]).filter(chat=>chat&&typeof chat==='object'&&typeof chat.id==='string'&&chat.project_id===projectId);
 }
 function tierOf(entry){
  if(!entry||typeof entry!=='object')return null;
  const raw=entry.tier??entry.danger_tier;
  if(raw===undefined||raw===null||raw==='')return null;
  const value=Number(raw);
  return Number.isInteger(value)&&value>=0?value:null;
 }
 // Tier 0 and 1 run on click; tier 2 and above, or a capability whose tier is unknown, need the inline confirm.
 const needsConfirm=tier=>tier===null||tier>=2;
 function secretKeys(value,depth=0){
  if(depth>6||!value||typeof value!=='object')return [];
  if(Array.isArray(value))return value.flatMap(item=>secretKeys(item,depth+1));
  return Object.entries(value).flatMap(([key,item])=>[...(SECRET_KEY.test(key)?[key]:[]),...secretKeys(item,depth+1)]);
 }
 // Mirrors the Workspace refusal (app.py action 'sdk'): credential operations use the isolated Vault form.
 function refuseSdkOptions(capability,options){
  if(/^echo\.vault\./.test(String(capability||'')))return 'Use the isolated Vault form for credential operations.';
  if(secretKeys(options).length)return 'Use the isolated Vault form for credential operations.';
  return null;
 }
 const maskValue=value=>typeof value==='string'&&value?MASK:value;
 function maskSecrets(value,depth=0){
  if(depth>8||!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>maskSecrets(item,depth+1));
  const out={};
  for(const [key,item] of Object.entries(value))out[key]=SECRET_KEY.test(key)?(typeof item==='object'&&item!==null?maskSecrets(item,depth+1):maskValue(item)):maskSecrets(item,depth+1);
  return out;
 }
 const tierText=tier=>tier===null?'Tier unknown · confirmation required before invoking':`Tier ${tier}${needsConfirm(tier)?' · confirmation required before invoking':''}`;

 // ---- DOM helpers ------------------------------------------------------------
 function el(tag,attributes={},...children){
  const node=doc.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(value===false||value===undefined||value===null)continue;if(key==='class')node.className=value;else if(key==='value')node.value=value;else node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child===null||child===undefined||child===false)continue;node.append(typeof child==='string'?doc.createTextNode(child):child);}
  return node;
 }
 const message=error=>typeof error?.message==='string'&&error.message?error.message:'Operation failed. No automatic retry was made.';
 function pretty(value){if(typeof value==='string')return value;try{return JSON.stringify(value,null,2);}catch{return String(value);}}
 const pre=value=>el('pre',{class:'workspace-receipt'},pretty(value));
 const card=(title,note,...children)=>el('article',{class:'workspace-card-content views-card'},el('h3',{},title),note?el('p',{},note):null,...children);
 const muted=text=>el('p',{class:'views-muted'},text);
 const emptyNote=text=>el('p',{class:'views-empty'},text);
 let fields=[];
 function field(label,node,key){if(key)node.setAttribute('data-field',key);if(['INPUT','TEXTAREA','SELECT'].includes(String(node.tagName).toUpperCase()))fields.push(node);return el('label',{class:'workspace-field'},el('span',{},label),node);}
 const input=(placeholder,type='text')=>el('input',{type,placeholder,autocomplete:'off'});
 const area=(placeholder,rows=6)=>el('textarea',{rows:String(rows),placeholder,spellcheck:'false'});
 function clearFields(){for(const node of fields)if('value' in node)node.value='';fields=[];}
 function download(name,text){
  const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=el('a',{href:url,download:String(name||'file.txt').replace(/[\\/\x00-\x1f]/g,'_').slice(0,120)});
  link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }

 // ---- admission --------------------------------------------------------------
 const session=()=>bridge()?.session;
 const approved=s=>s?.authenticated===true&&s.user?.status==='approved';
 const isOwner=()=>{const s=session();return approved(s)&&s.ownerAccess===true;};
 function notify(text){const node=$('#draft-notice');if(node){node.textContent=String(text).slice(0,600);node.hidden=false;}}

 // ---- shared dialog ----------------------------------------------------------
 let dialog,eyebrow,heading,subtitle,notice,body,generation=0,current=null,reviewFields=null;
 function say(text){if(notice)notice.textContent=String(text||'').slice(0,600);}
 function ensureDialog(){
  if(dialog)return;
  const close=el('button',{type:'button',class:'icon-button close-dialog','aria-label':'Close this view'},'×');
  eyebrow=el('span',{class:'eyebrow'},'');heading=el('h2',{id:'views-title'},'');subtitle=el('p',{class:'dialog-description views-subtitle'},'');
  notice=el('p',{role:'status','aria-live':'polite',class:'views-status'});body=el('div',{class:'views-body'});
  dialog=el('dialog',{id:'views-dialog',class:'panel-dialog workspace-dialog views-dialog','aria-labelledby':'views-title'},el('div',{class:'dialog-title'},el('div',{},eyebrow,heading),close),subtitle,notice,body);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
  dialog.addEventListener('close',()=>{generation++;current=null;reviewFields=null;clearFields();body.replaceChildren();say('');});
  doc.body.append(dialog);
 }
 window.addEventListener('echo-account-changed',()=>{generation++;reviewFields=null;clearFields();if(dialog?.open)dialog.close();body?.replaceChildren();say('');});
 // A button bound to the current render, account and (optionally) owner admission at click time.
 function act(label,run,{owner=false}={},className='quiet-button'){
  const turn=generation,b=bridge(),epoch=b?.state.accountEpoch,node=el('button',{type:'button',class:className},label);
  node.addEventListener('click',async()=>{
   const now=bridge();if(!now||node.disabled||turn!==generation||now.state.accountEpoch!==epoch)return;
   node.disabled=true;
   try{if(owner&&!isOwner())throw new Error('Primary owner admission required.');await run(now);}
   catch(error){if(turn===generation)say(message(error));}
   finally{node.disabled=false;}
  });
  return node;
 }

 // ---- Projects (app.js renderProjects, projectEditor) ------------------------
 function projectsView(b,repaint){
  const data=b.state.data,projects=Array.isArray(data.projects)?data.projects.filter(p=>p&&typeof p.id==='string'):[],chats=data.chats;
  const name=input('Project name'),instructions=area('How should Echo work in this project?',6);
  const create=card('Create a project','Instructions are included in every chat assigned to this project.',field('Name',name,'project-name'),field('Instructions',instructions,'project-instructions'),
   act('Create project',async now=>{const value=name.value.trim();if(!value)throw new Error('Enter a project name first.');await now.api('/projects',{name:value,instructions:instructions.value});await now.refresh();repaint();say('Project created.');},{},'new-chat'));
  const cards=projects.slice(0,500).map(project=>projectCard(project,projectChats(chats,project.id),repaint));
  return [el('p',{class:'views-lead'},'Group conversations and files, and give Echo instructions it can carry from chat to chat.'),create,...(cards.length?cards:[emptyNote('No projects yet. Create one above.')])];
 }
 function projectCard(project,rows,repaint){
  const title=input('Name'),guide=area('Instructions',5);title.value=String(project.name||'');guide.value=String(project.instructions||'');
  const editor=el('details',{class:'views-editor'},el('summary',{},'Rename or edit instructions'),field('Name',title,'project-rename-'+project.id),field('Instructions',guide,'project-guide-'+project.id),
   act('Save project',async now=>{const value=title.value.trim();if(!value)throw new Error('Enter a project name first.');await now.api('/project/update',{id:project.id,name:value,instructions:guide.value});await now.refresh();repaint();say('Project updated.');}));
  const list=el('div',{class:'views-chat-list',role:'list','aria-label':'Conversations in '+String(project.name||'this project')});
  for(const chat of rows.slice(0,50))list.append(act(String(chat.title||'Untitled conversation'),async now=>{dialog.close();await now.openChat(chat.id);},{},'history-item'));
  if(!rows.length)list.append(emptyNote('No conversations in this project yet.'));
  const select=()=>{const node=$('#workspace-project');if(!node)return false;node.value=project.id;if(typeof node.dispatchEvent==='function')node.dispatchEvent(new Event('change'));return true;};
  return card(String(project.name||'Untitled project'),String(project.instructions||'No project instructions yet.'),
   el('p',{class:'views-count'},`${rows.length} chat${rows.length===1?'':'s'}`),
   el('div',{class:'views-row'},
    act('Start a chat',async()=>{const node=$('#workspace-project');if(node)node.value=project.id;dialog.close();await window.EchoPrimeWorkspace.newChat();},{},'new-chat'),
    act('Select project',()=>{select();say(`${project.name||'Project'} is now the project for this conversation.`);})),
   editor,list);
 }

 // ---- Library (app.js renderLibrary, saveFileDialog, importDialog) ----------
 function libraryView(b,repaint){
  const data=b.state.data,items=Array.isArray(data.library)?data.library.filter(item=>item&&typeof item.id==='string'):[],turn=generation;
  const search=el('input',{type:'search',placeholder:'Search names and paths','aria-label':'Search your library',autocomplete:'off','data-field':'library-search'});
  const list=el('div',{class:'views-files'});
  const draw=()=>{list.replaceChildren(...filterLibrary(items,search.value).slice(0,500).map(item=>fileRow(item)));if(!list.children.length)list.append(emptyNote(items.length?'No files match this search.':'Your library is empty. Write a note or upload a text file.'));};
  search.addEventListener('input',draw);draw();
  const name=input('note.md'),content=area('Text or code',10);content.setAttribute('maxlength',String(LIMITS.note));
  const note=card('Write a note','Every file saved from a chat is recorded in that chat’s journal.',field('Filename',name,'note-name'),field('Content',content,'note-content'),
   act('Save file',async now=>{
    const fileName=name.value.trim(),value=content.value;
    if(!fileName||CREDENTIAL_FILE.test(fileName))throw new Error('Choose a file name that is not a credential file. Credentials belong in the Vault.');
    if(!value.trim()||value.length>LIMITS.note)throw new Error('Enter between 1 and 500,000 characters.');
    const item=await now.api('/library',{name:fileName,content:value,chat_id:now.state.chat?.id,project_id:now.state.chat?.project_id||$('#workspace-project')?.value||null});
    await now.refresh();repaint();say('Saved'+(item?.path?': '+item.path:'.'));
   },{},'new-chat'));
  const upload=el('input',{type:'file',accept:'.txt,.md,.py,.js,.ts,.tsx,.jsx,.json,.html,.css,.csv,.sql,.ps1,.sh,.diff,.patch','aria-label':'Upload a text file','data-field':'library-upload'});
  upload.addEventListener('change',async()=>{
   const chosen=upload.files?.[0];
   try{
    if(!chosen)return;
    if(chosen.size>LIMITS.upload)throw new Error('Choose a text file under 100 KB.');
    if(CREDENTIAL_FILE.test(chosen.name))throw new Error('Credential files belong in the Vault.');
    const text=await chosen.text(),now=bridge();
    if(!now||turn!==generation||!upload.isConnected)return;
    await now.api('/library',{name:chosen.name,content:text,chat_id:now.state.chat?.id,project_id:now.state.chat?.project_id||$('#workspace-project')?.value||null});
    await now.refresh();repaint();say('Uploaded '+chosen.name+'.');
   }catch(error){if(turn===generation)say(message(error));}
   finally{upload.value='';}
  });
  const source=el('select',{'aria-label':'Source'},...['chatgpt','claude','grok','other'].map(value=>el('option',{value},value)));
  const importTitle=input('Chat title'),importData=area('Paste a normalized JSON chat or a transcript',8),importFile=el('input',{type:'file',accept:'.json,.txt,.md','aria-label':'Import file','data-field':'import-file'});
  importFile.addEventListener('change',async()=>{
   const chosen=importFile.files?.[0];
   try{
    if(!chosen)return;
    if(chosen.size>LIMITS.importFile)throw new Error('Choose an export under 1.9 MB.');
    const text=await chosen.text();
    if(turn!==generation||!importFile.isConnected)return;
    importData.value=text;if(!importTitle.value)importTitle.value=chosen.name;
   }catch(error){if(turn===generation)say(message(error));}
   finally{importFile.value='';}
  });
  const imports=card('Import an earlier chat','Import a chat you choose. This does not connect to or monitor another provider’s account. Imported records are journaled and queued for ECF.',
   field('Source',source,'import-source'),field('Title',importTitle,'import-title'),field('File · up to 1.9 MB',importFile),field('Transcript or JSON',importData,'import-data'),
   act('Import chat',async now=>{
    if(typeof now.normalizeImport!=='function')throw new Error('Import is unavailable in this Prime build.');
    const value={...now.normalizeImport(importData.value,importTitle.value),source:source.value};
    const result=await now.api('/import',value);await now.refresh();
    say('Import returned. Open the saved conversation to inspect its messages.');
    if(typeof result?.id==='string'){dialog.close();await now.openChat(result.id);}
   },{},'new-chat'));
  return [el('p',{class:'views-lead'},'Notes, code and outputs stay searchable. Every file saved from a chat is recorded in that chat’s journal.'),
   card('Your files','',field('Search',search),field('Upload a text file · up to 100 KB',upload),list),note,imports];
 }
 function fileRow(item){
  const out=el('div',{class:'views-file-out'});
  return el('article',{class:'views-file-row'},
   el('div',{class:'views-file-meta'},el('strong',{},String(item.name||'File')),el('small',{},String(item.path||'Private account file'))),
   el('div',{class:'views-row'},
    act('Open',async now=>{const value=await now.api('/library/'+encodeURIComponent(item.id));out.replaceChildren(muted(String(value?.path||'')),pre(typeof value?.content==='string'?value.content:''),act('Download',()=>download(value?.name||item.name,typeof value?.content==='string'?value.content:'')));}),
    act('Attach',now=>{now.state.attachments.add(item.id);now.updateContext();dialog.close();$('#prompt')?.focus();}),
    act('Review',async now=>{const value=await now.api('/library/'+encodeURIComponent(item.id));if(typeof value?.content!=='string')throw new Error('This file has no text content to review.');await open('review');prefillReview(String(value.name||item.name||'file.txt'),value.content,typeof value.project_id==='string'?value.project_id:null);}),
    typeof item.chat_id==='string'?act('Open linked conversation',async now=>{dialog.close();await now.openChat(item.chat_id);}):null),
   out);
 }

 // ---- SDK (app.js renderSdk) --------------------------------------------------
 function sdkView(b){
  const data=b.state.data,catalog=data.catalog&&typeof data.catalog==='object'?data.catalog:{};
  const query=el('input',{type:'search',placeholder:'Search capabilities, for example vault or files','aria-label':'Search capabilities',autocomplete:'off','data-field':'sdk-query'});
  const results=el('div',{class:'sdk-results'}),output=el('div',{class:'views-output'});
  const capability=input('echo.namespace.action'),command=input('Command'),options=area('{}',6);options.value='{}';
  const tierLine=el('p',{class:'views-muted sdk-tier',role:'status'},'Pick a capability from the catalog to see its tier.');
  const confirmBox=el('div',{class:'sdk-confirm'});confirmBox.hidden=true;
  let selected=null,pending=null;
  const currentTier=()=>selected&&selected.id===capability.value.trim()?tierOf(selected):null;
  const syncTier=()=>{tierLine.textContent=capability.value.trim()?tierText(currentTier()):'Pick a capability from the catalog to see its tier.';};
  function resetConfirm(){pending=null;confirmBox.hidden=true;confirmBox.replaceChildren();}
  capability.addEventListener('input',()=>{syncTier();resetConfirm();});
  for(const node of [command,options])node.addEventListener('input',resetConfirm);
  async function search(now){
   const q=query.value.trim().slice(0,LIMITS.catalogQuery),value=await now.api('/catalog?q='+encodeURIComponent(q)),rows=Array.isArray(value?.results)?value.results.filter(entry=>entry&&typeof entry.id==='string'):[];
   results.replaceChildren(muted(`${(Number.isFinite(Number(value?.matches))?Number(value.matches):rows.length).toLocaleString('en-US')} matches · showing up to 100`),
    ...rows.slice(0,100).map(entry=>{
     const tier=tierOf(entry),node=el('button',{type:'button',class:'sdk-result'},el('strong',{},entry.id),el('span',{},String(entry.description||'')),el('small',{},`Scope: ${entry.scope||entry.required_scope||'check live schema'} · tier ${tier===null?'?':tier}`));
     node.addEventListener('click',()=>{selected={id:entry.id,tier:tier===null?undefined:tier};capability.value=entry.id;command.value=entry.id.split('.').pop();syncTier();resetConfirm();});
     return node;
    }));
   if(!rows.length)results.append(emptyNote('No capabilities match this search.'));
  }
  query.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();searchButton.click();}});
  const searchButton=act('Search',search,{owner:true},'new-chat');
  function prepare(){
   const cap=capability.value.trim(),cmd=command.value.trim();
   if(!cap||!cmd)throw new Error('Enter a capability and a command first.');
   let parsed;try{parsed=JSON.parse(options.value.trim()||'{}');}catch{throw new Error('Options must be a JSON object.');}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Options must be a JSON object.');
   const refusal=refuseSdkOptions(cap,parsed);if(refusal)throw new Error(refusal);
   return {capability:cap,command:cmd,options:parsed,tier:currentTier()};
  }
  async function invoke(now,request){
   output.replaceChildren(muted('Invoking '+request.capability+'…'));
   const value=await now.api('/action',{action:'sdk',capability:request.capability,command:request.command,options:request.options,chat_id:now.state.chat?.id});
   output.replaceChildren(pre(maskSecrets(value)));say('Capability returned a receipt. Verify it before relying on the result.');
  }
  const invokeButton=act('Invoke capability',async now=>{
   const request=prepare();
   if(!needsConfirm(request.tier)){resetConfirm();await invoke(now,request);return;}
   pending=request;confirmBox.hidden=false;
   confirmBox.replaceChildren(
    el('p',{},request.tier===null?`${request.capability} has no tier in the catalog snapshot, so it is treated as privileged. Confirm to invoke it with the current role.`:`${request.capability} is tier ${request.tier}. Confirm to invoke it with the current role.`),
    pre({capability:request.capability,command:request.command,options:request.options}),
    el('div',{class:'views-row'},
     act('Confirm and invoke',async later=>{const request=pending;if(!request)return;if(JSON.stringify(prepare())!==JSON.stringify(request))throw new Error('The request changed. Review it again.');resetConfirm();await invoke(later,request);},{owner:true},'new-chat'),
     act('Cancel',()=>{resetConfirm();say('Invocation cancelled. Nothing was sent.');})));
  },{owner:true},'new-chat');
  const detail=act('Read live schema',async now=>{
   const cap=capability.value.trim();if(!cap)throw new Error('Enter a capability first.');
   const value=await now.api('/action',{action:'sdk_detail',capability:cap});
   output.replaceChildren(pre(maskSecrets(value)));
   const tier=tierOf(value)??tierOf(value?.capability)??tierOf(value?.detail);
   if(tier!==null&&capability.value.trim()===cap){selected={id:cap,tier};syncTier();}
  },{owner:true});
  return [el('p',{class:'views-lead'},`Catalog snapshot: ${(Number(catalog.count)||0).toLocaleString('en-US')} capabilities. ${typeof catalog.coverage==='string'?catalog.coverage+' ':''}Live invocation uses the inherited SOL mission scope.`),
   card('Find a capability','',el('div',{class:'views-row'},field('Search',query),searchButton),results),
   card('Inspect or invoke',data.mission_present?'A mission is present. Each capability still enforces its own permissions.':'No SOL mission is attached to this Workspace. Discovery works from the saved catalog; live SDK calls are blocked until an authorized launch.',
    field('Capability',capability,'sdk-capability'),field('Command',command,'sdk-command'),field('Options · JSON object',options,'sdk-options'),tierLine,
    el('div',{class:'views-row'},detail,invokeButton),confirmBox,output)];
 }

 // ---- Vault (app.js renderVault) ---------------------------------------------
 function vaultView(b){
  const data=b.state.data;
  const service=input('Exact service name'),username=input('Account or username');
  const secret=el('input',{type:'password',placeholder:'Credential value',autocomplete:'new-password',spellcheck:'false'});
  const reveal=el('button',{type:'button',class:'quiet-button vault-reveal','aria-pressed':'false'},'Show');
  reveal.addEventListener('click',()=>{const shown=secret.getAttribute('type')==='text';secret.setAttribute('type',shown?'password':'text');reveal.textContent=shown?'Show':'Hide';reveal.setAttribute('aria-pressed',String(!shown));});
  const output=el('div',{class:'views-output'});
  async function run(now,operation){
   const payload={action:'vault',operation,service:service.value.trim(),username:username.value.trim(),chat_id:now.state.chat?.id};
   if(operation!=='list'&&!payload.service)throw new Error('Enter the exact service name first.');
   if(operation==='put'){if(!secret.value)throw new Error('Enter a credential value in the Vault field.');payload.secret=secret.value;}
   try{
    const value=await now.api('/action',payload);
    output.replaceChildren(vaultResult(value));
    say(operation==='put'?'Vault operation returned. No credential value is displayed or added to the conversation.':'Vault returned a reference. Secret values stay inside the governed broker.');
   }finally{secret.value='';delete payload.secret;}
  }
  return [el('p',{class:'views-lead'},'Store a credential through the scoped Vault hook, or retrieve its reference and metadata. Echo’s supported service connectors resolve the value on the server.'),
   el('p',{class:'views-callout'},data.mission_present?'The current role must have the Vault permissions required by each action.':'Access pending: this Workspace has no SOL mission. Hook availability does not grant permission.'),
   card('Credential reference','Exact service and account names avoid ambiguous matches.',field('Service',service,'vault-service'),field('Account',username,'vault-username'),
    el('div',{class:'views-row'},act('Locate reference',now=>run(now,'locate'),{owner:true}),act('Retrieve through Vault',now=>run(now,'get'),{owner:true}),act('List metadata',now=>run(now,'list'),{owner:true}))),
   card('Store or update','Only this isolated field carries the credential value. It is excluded from prompts, journals, the library and ECF records.',
    el('div',{class:'views-row'},field('Credential',secret,'vault-secret'),reveal),act('Store in Vault',now=>run(now,'put'),{owner:true},'new-chat')),
   output];
 }
 // Rows with any secret-looking value masked; a per-value Reveal toggle swaps the text in place and nothing is logged.
 function maskedRow(key,value){
  const row=el('div',{class:'vault-row'},el('span',{},String(key)));
  if(SECRET_KEY.test(key)&&typeof value==='string'&&value){
   const text=el('strong',{class:'vault-masked','data-masked':'true'},MASK),toggle=el('button',{type:'button',class:'quiet-button vault-reveal','aria-pressed':'false'},'Reveal');
   toggle.addEventListener('click',()=>{const hidden=text.getAttribute('data-masked')==='true';text.textContent=hidden?value:MASK;text.setAttribute('data-masked',String(!hidden));toggle.textContent=hidden?'Hide':'Reveal';toggle.setAttribute('aria-pressed',String(hidden));});
   row.append(el('span',{class:'vault-value'},text,toggle));
  }else row.append(el('strong',{},typeof value==='string'?value:pretty(maskSecrets(value))));// nested shapes keep their secret-looking keys masked too
  return row;
 }
 function vaultResult(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return pre(maskSecrets(value));
  if(Array.isArray(value.entries)){
   const columns=['service','username','version','updated_at','status'];
   const table=el('table',{class:'vault-table'},el('thead',{},el('tr',{},...columns.map(name=>el('th',{scope:'col'},name.replace('_',' '))))),
    el('tbody',{},...value.entries.filter(row=>row&&typeof row==='object').slice(0,200).map(row=>el('tr',{},...columns.map(name=>el('td',{},row[name]===undefined||row[name]===null?'':String(maskSecrets({[name]:row[name]})[name])))))));
   return el('div',{class:'vault-rows'},muted(`${Number.isFinite(Number(value.count))?Number(value.count):value.entries.length} entries · metadata only`),table);
  }
  return el('div',{class:'vault-rows'},...Object.entries(value).map(([key,item])=>maskedRow(key,item)));
 }

 // ---- Code review (app.js renderReview) ---------------------------------------
 function reviewView(b){
  const data=b.state.data,turn=generation;
  const name=input('File name'),source=area('Paste a diff or source file…',16);name.value='changes.diff';
  const project=el('select',{'aria-label':'Project'},el('option',{value:''},'No project'),...(Array.isArray(data.projects)?data.projects:[]).filter(p=>p&&typeof p.id==='string').slice(0,500).map(p=>el('option',{value:p.id},String(p.name||'Untitled project'))));
  project.value=b.state.chat?.project_id||$('#workspace-project')?.value||'';
  const file=el('input',{type:'file',accept:'.diff,.patch,.py,.js,.ts,.tsx,.jsx,.json,.html,.css,.ps1,.sh,.go,.rs,.cs,.cpp,.c,.java','aria-label':'Upload a file or diff','data-field':'review-file'});
  file.addEventListener('change',async()=>{
   const chosen=file.files?.[0];
   try{
    if(!chosen)return;
    if(chosen.size>LIMITS.review)throw new Error('Review one file or diff under 40 KB.');
    const text=await chosen.text();
    if(turn!==generation||!file.isConnected)return;
    source.value=text;name.value=chosen.name;
   }catch(error){if(turn===generation)say(message(error));}
   finally{file.value='';}
  });
  reviewFields={name,source,project};
  const button=act('Review with FORGE',async now=>{
   const fileName=name.value.trim(),content=source.value;
   if(!fileName)throw new Error('Enter a file name first.');
   if(!content.trim()||content.length>LIMITS.review)throw new Error('Paste a nonempty file or diff of up to 40,000 characters.');
   button.textContent='Reviewing…';say('Reviewing with the Workspace model…');
   try{
    const chat=await now.api('/review',{name:fileName,content,project_id:project.value||null});
    if(typeof chat?.id!=='string')throw new Error('Review returned without a saved conversation. Inspect the library before retrying.');
    await now.refresh();dialog.close();await now.openChat(chat.id);
   }finally{button.textContent='Review with FORGE';}
  },{},'new-chat');
  return [el('p',{class:'views-lead'},'Findings include a severity, file and line, impact, and suggested fix. The supplied source and review report are saved together. A model review does not execute tests.'),
   card('A second look at your code','',el('div',{class:'views-row'},field('File name',name,'review-name'),field('Project',project,'review-project')),field('Upload a text file · up to 40 KB',file),field('Code or diff',source,'review-source'),button)];
 }
 function prefillReview(name,content,projectId){
  if(!reviewFields)return false;
  reviewFields.name.value=name;reviewFields.source.value=content;
  if(projectId)reviewFields.project.value=projectId;
  return true;
 }

 // ---- views and navigation ---------------------------------------------------
 const VIEWS={
  projects:{eyebrow:'PROJECTS',title:'Everything for the same idea.',subtitle:'Give related work a shared home.',render:projectsView},
  library:{eyebrow:'LIBRARY',title:'Keep what matters.',subtitle:'Useful files, saved with their context.',render:libraryView},
  sdk:{eyebrow:'ECHO SDK',title:'The SDK, within reach.',subtitle:'Discover a capability. Inspect its contract. Run it with the current role.',render:sdkView,owner:true},
  vault:{eyebrow:'VAULT',title:'Use credentials without putting them in chat.',subtitle:'Credentials stay separate from conversations.',render:vaultView,owner:true},
  review:{eyebrow:'CODE REVIEW',title:'A second look at your code.',subtitle:'Specific findings, grounded in the source you provide.',render:reviewView},
 };
 function access(view){
  const s=session();
  if(!bridge()||!approved(s))return 'signin';
  if(VIEWS[view].owner&&s.ownerAccess!==true)return 'owner';
  return 'ok';
 }
 function paint(view,turn){
  const b=bridge(),spec=VIEWS[view];
  if(!b||!spec||turn!==generation||current!==view||!dialog.open)return;
  clearFields();reviewFields=null;
  if(!b.state.data){body.replaceChildren(emptyNote('Workspace state is unavailable. No automatic retry was made.'));return;}
  body.replaceChildren(...spec.render(b,()=>paint(view,turn)));
 }
 async function open(view){
  if(view==='library'&&typeof window.EchoPrimeLibrary?.open==='function'){closeOwn();return window.EchoPrimeLibrary.open('library');}
  const spec=VIEWS[view];if(!spec)return false;
  ensureDialog();
  if(!dialog.open)dialog.showModal();
  generation++;const turn=generation;current=view;reviewFields=null;clearFields();body.replaceChildren();say('');
  eyebrow.textContent=spec.eyebrow;heading.textContent=spec.title;subtitle.textContent=spec.subtitle;
  const level=access(view);
  if(level==='signin'){body.append(emptyNote('Sign in to an approved Workspace account to use this view.'));return true;}
  if(level==='owner'){body.append(emptyNote('Primary owner admission is required for this view.'));return true;}
  const b=bridge();
  try{await b.refresh();}catch(error){if(turn===generation)say(message(error));}
  if(turn!==generation||current!==view||!dialog.open)return true;
  paint(view,turn);
  return true;
 }
 function closeOwn(){if(dialog?.open)dialog.close();}
 // The Workspace tool's `navigate` targets. Owner-only destinations are refused for anyone else before any fetch.
 async function navigate(view){
  if(typeof view!=='string'||!UI_VIEWS.includes(view))return false;
  if(view==='chats'){closeOwn();$('#prompt')?.focus();return true;}
  if(view==='media'){closeOwn();if(!window.EchoPrimeStudio?.open)return false;window.EchoPrimeStudio.open('all');return true;}
  if(view==='plugins'){closeOwn();if(!approved(session())||typeof window.EchoPrimePlugins?.open!=='function')return false;await window.EchoPrimePlugins.open();return true;}
  if(view==='diagnostics'){closeOwn();if(!isOwner()){notify('Primary owner admission is required for Logs & debugging.');return false;}if(typeof window.EchoPrimeLogs?.open!=='function')return false;window.EchoPrimeLogs.open();return true;}
  if(VIEWS[view].owner&&!isOwner()){notify('Primary owner admission is required for this view.');return false;}
  return open(view);
 }
 window.EchoPrimeViews={open,navigate,prefillReview,UI_VIEWS,views:Object.keys(VIEWS),LIMITS,
  core:{filterLibrary,projectChats,tierOf,needsConfirm,refuseSdkOptions,maskSecrets,maskValue,secretKeys}};
 (async()=>{
  try{
   const workspace=window.EchoPrimeWorkspace;if(!workspace||!await workspace.ready||!workspace.enabled||!bridge())return;
   for(const node of doc.querySelectorAll('[data-prime-view]'))node.addEventListener('click',()=>void open(node.dataset.primeView));
  }catch{}
 })();
})();
