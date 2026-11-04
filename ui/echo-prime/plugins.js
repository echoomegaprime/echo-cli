(() => {
 'use strict';
 // "Plugins & memory": MCP connections, private preferences and, for the primary
 // owner only, connection checks, recall, Crystal storage, journal hook status,
 // Personality Forge assets and the directive profile. All calls use the existing
 // allowlisted Workspace routes through window.EchoPrimeWorkspace.bridge.
 const $=selector=>document.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const navLabels={chats:'Chats',recent:'Recent chats'};
 const checkNames=[['crystal','Crystal memory'],['ecf','Continuity Fabric (ECF)'],['esh','ESH']];
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(key==='value')node.value=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }
 const pretty=value=>typeof value==='string'?value:JSON.stringify(value,null,2);
 const pre=value=>el('pre',{class:'workspace-receipt'},pretty(value));
 function toolSummary(value){
  const tools=value&&Array.isArray(value.tools)?value.tools:null;
  if(!tools||!tools.length||tools.some(tool=>!tool||typeof tool.name!=='string'))return pretty(value);
  return tools.map(tool=>typeof tool.description==='string'&&tool.description?`${tool.name} — ${tool.description}`:tool.name).join('\n');
 }
 function connectionCards(data){
  const source=data&&typeof data==='object'?data:{},keys=[...checkNames.map(([key])=>key),...Object.keys(source).filter(key=>!checkNames.some(([name])=>name===key))];
  return keys.map(key=>{
   const value=source[key],known=checkNames.find(([name])=>name===key);
   return {key,title:known?known[1]:key.toUpperCase(),ok:value?.ok===true,detail:value===undefined?'Not checked':value.ok===true?'Live read succeeded':String(value.error||'Unavailable').slice(0,400)};
  });
 }
 function syncSummary(sync){
  if(sync&&Number.isFinite(sync.verified)&&Number.isFinite(sync.remaining))return `${sync.verified} records have exact ECF readback; ${sync.remaining} awaiting confirmation.`;
  return sync?pretty(sync):'No delivery status has been reported.';
 }
 window.EchoPrimePlugins={open:()=>open(),toolSummary,connectionCards,syncSummary,navLabels};

 let dialog,body,notice,fields=[],generation=0;
 function field(label,node,key){if(key)node.setAttribute('data-field',key);if(['INPUT','TEXTAREA'].includes(String(node.tagName).toUpperCase()))fields.push(node);return el('label',{class:'workspace-field'},el('span',{},label),node);}
 const input=(placeholder,type='text')=>el('input',{type,placeholder,autocomplete:'off'});
 const area=(placeholder,rows=4)=>el('textarea',{rows:String(rows),maxlength:'12000',placeholder});
 const card=(title,...children)=>el('article',{class:'workspace-card-content'},el('h3',{},title),...children);
 function clearFields(){for(const node of fields)node.value='';fields=[];}
 function say(text){if(notice)notice.textContent=String(text||'').slice(0,600);}
 const isOwner=()=>bridge()?.session?.ownerAccess===true;
 function act(label,run,{owner=false}={}){
  const turn=generation,b=bridge(),epoch=b?.state.accountEpoch,node=el('button',{type:'button',class:'quiet-button'},label);
  node.addEventListener('click',async()=>{
   const now=bridge();if(!now||node.disabled||turn!==generation||now.state.accountEpoch!==epoch)return;
   node.disabled=true;
   try{if(owner&&!isOwner())throw new Error('Primary owner admission required.');await run(now);}
   catch(error){if(turn===generation)say(error instanceof Error?error.message:'Operation failed. No automatic retry was made.');}
   finally{node.disabled=false;}
  });
  return node;
 }
 function ensureDialog(){
  if(dialog)return;
  const close=el('button',{type:'button',class:'icon-button','aria-label':'Close Plugins and memory'},'✕');
  notice=el('p',{role:'status','aria-live':'polite',class:'composer-note'});body=el('div',{class:'plugins-body'});
  dialog=el('dialog',{class:'panel-dialog workspace-dialog composer-dialog','data-composer-dialog':'plugins','aria-label':'Plugins and memory'},el('div',{class:'dialog-title'},el('h2',{},'Plugins & memory'),close),notice,body);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{generation++;clearFields();body.replaceChildren();say('');});
  document.body.append(dialog);
  window.addEventListener('echo-account-changed',()=>{if(dialog.open)dialog.close();generation++;clearFields();body.replaceChildren();say('');});
 }
 function mcpCards(connections,b,rerender){
  const cards=[];
  for(const connection of connections){
   const out=el('div',{});
   cards.push(card(String(connection.name||'MCP connection'),el('p',{},String(connection.url||'')),el('p',{},`${connection.tool_count||0} tools · ${connection.enabled?'Enabled':'Disabled'}`),
    act('Inspect tool schemas',async now=>{out.replaceChildren(pre(toolSummary(await now.api('/mcp/tools/'+encodeURIComponent(connection.id)))));}),
    act(connection.enabled?'Disable':'Enable',async now=>{await now.api('/mcp',{action:'enable',id:connection.id,enabled:!connection.enabled});await rerender();}),
    act('Remove connection',async now=>{await now.api('/mcp',{action:'remove',id:connection.id});await rerender();}),out));
  }
  const name=input('Connection name'),url=input('https://service.example/mcp','url'),auth=el('select',{},el('option',{value:'none'},'No authentication'),el('option',{value:'bearer'},'Bearer token')),token=input('This server’s credential','password');
  cards.push(card('Connect a Streamable HTTP MCP server',field('Name',name,'mcp-name'),field('Public HTTPS endpoint',url,'mcp-url'),field('Authentication',auth,'mcp-auth'),field('Credential · encrypted by the canonical owner',token,'mcp-token'),
   el('p',{},'The credential goes only to your account’s connection store. OAuth onboarding and legacy SSE-only endpoints remain unsupported.'),
   act('Connect and discover tools',async now=>{
    try{await now.api('/mcp',{action:'add',name:name.value,url:url.value,auth:auth.value,token:token.value});}finally{token.value='';}
    await rerender();say('Connection returned; inspect its advertised schemas before use.');
   })));
  return cards;
 }
 function preferenceCards(b,rerender){
  const note=area('A preference or note to retain'),cards=[card('Private preferences',field('What should Echo remember?',note,'preference'),
   act('Save preference',async now=>{const receipt=await now.api('/action',{action:'memory_save',content:note.value,chat_id:now.state.chat?.id});await now.refresh();await rerender();body.append(pre(receipt));}))];
  for(const value of b.state.data?.preferences||[])cards.push(card(String(value.content||value.value||'Preference').slice(0,300),act('Forget this preference',async now=>{await now.api('/action',{action:'memory_forget',id:value.id,chat_id:now.state.chat?.id});await now.refresh();await rerender();})));
  return cards;
 }
 function ownerCards(b){
  const result=el('div',{}),show=value=>result.replaceChildren(pre(value));
  const statuses=el('div',{class:'plugin-statuses'}),paint=data=>statuses.replaceChildren(...connectionCards(data).map(c=>card(c.title,el('p',{},c.detail),el('span',{class:'pill '+(c.ok?'good':'pending')},c.ok?'Readable':c.detail==='Not checked'?'Not checked':'Unavailable'))));paint(null);
  const query=input('What would you like to recall?'),source=el('select',{},el('option',{value:'ecf'},'Continuity Fabric (ECF)'),el('option',{value:'crystal'},'Crystal')),memory=area('A memory to save explicitly to Crystal');
  const cards=[
   card('Check connections',el('p',{},'Reads Crystal, Continuity Fabric and ESH status live.'),act('Check connections',async now=>{say('Checking Echo connections…');paint(await now.api('/plugins'));say('');},{owner:true}),statuses),
   card('Recall a memory',el('p',{},'Results keep their original provenance.'),field('Source',source,'recall-source'),field('Search',query,'recall-query'),
    act('Search memories',async now=>{show(await now.api('/action',{action:'memory_search',plugin:source.value,query:query.value,chat_id:now.state.chat?.id}));},{owner:true})),
   card('Store a memory',el('p',{},'Crystal storage verifies exact readback; confirm the receipt before relying on it.'),field('Memory',memory,'crystal-content'),
    act('Save to Crystal',async now=>{
     if(!memory.value.trim())throw new Error('Enter the memory to store first.');
     show(await now.api('/action',{action:'crystal_save',content:memory.value,chat_id:now.state.chat?.id}));say('Crystal returned a receipt. Confirm its readback before treating this as saved.');
    },{owner:true})),
   card('Automatic journal hooks',el('p',{},'Chat start → create Markdown. Message → append journal and ECF queue. File saved → record content, path and hash. Compact → preserve originals and record the checkpoint. ECF delivery → retain receipt and verify retrieval.'),el('p',{class:'sync-summary'},syncSummary(b.state.data?.sync))),
   card('ESH action',el('p',{},'Echo uses ESH under your existing policy. Open the dock to review each exact command before it runs.'),act('Open dockable ESH panel',()=>{dialog.close();$('#workspace-open-esh')?.click();},{owner:true}))];
  if(b.state.data?.voice?.configured===true){
   const voice=b.state.data.voice,name=[voice.label,voice.persona].find(v=>typeof v==='string'&&v)||'The configured persona';
   cards.push(card('Personality Forge',el('p',{},`${name} is resolved through the saved persona. Dictation and playback controls sit beside each chat.`),act('View personality assets',async now=>{show(await now.api('/action',{action:'personality_assets',chat_id:now.state.chat?.id}));},{owner:true})));
  }
  const directive=b.state.data?.directive;
  cards.push(card('Directive profile',el('p',{},directive?.loaded?'Verified owner profile loaded into every model conversation.':String(directive?.reason||'No directive profile is loaded.'))),result);
  return cards;
 }
 async function render(){
  const b=bridge(),turn=generation;body.replaceChildren();clearFields();
  if(!b||b.session?.authenticated!==true||b.session.user?.status!=='approved'||!b.state.data){body.append(el('p',{},'Sign in to an approved account to manage plugins & memory.'));return;}
  let connections=[];
  try{connections=(await b.api('/mcp')).connections||[];}catch(error){if(turn===generation)say(error instanceof Error?error.message:'MCP connections are unavailable.');}
  if(turn!==generation)return;
  const rerender=()=>render();
  body.replaceChildren(...mcpCards(connections,b,rerender),...preferenceCards(b,rerender),...(isOwner()?ownerCards(b):[]));
 }
 async function open(){
  ensureDialog();generation++;say('');
  const b=bridge();
  if(!dialog.open)dialog.showModal();
  try{if(b&&b.session?.authenticated===true&&b.session.user?.status==='approved')await b.refresh();}catch(error){say(error instanceof Error?error.message:'Workspace state is unavailable.');}
  await render();
 }
 function labels(){
  const chats=$('[data-view="conversation"]'),heading=$('.history-heading');
  const relabel=(node,pattern,text)=>{const target=[...(node?.childNodes||[])].find(child=>child.nodeType===3&&pattern.test(child.textContent));if(target)target.textContent=text;};
  relabel(chats,/Conversation/,navLabels.chats);relabel(heading,/YOUR SPACE/i,navLabels.recent);
 }
 (async()=>{
  try{
   const workspace=window.EchoPrimeWorkspace;if(!workspace||!await workspace.ready||!workspace.enabled||!bridge())return;
   labels();$('#workspace-open-plugins')?.addEventListener('click',()=>void open());
  }catch{}
 })();
})();
