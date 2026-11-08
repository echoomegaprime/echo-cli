(() => {
 'use strict';
 const doc=document,HEX=/^[a-f0-9]{32}$/;
 const el=(tag,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=String(text);if(cls)node.className=cls;return node;};
 const field=(label,node)=>{const wrap=el('label',undefined,'workspace-field');node.setAttribute('aria-label',label);wrap.append(el('span',label),node);return wrap;};
 const button=(text,fn)=>{const node=el('button',text,'quiet-button');node.type='button';node.addEventListener('click',fn);return node;};
 const input=(value='',type='text')=>{const node=el('input');node.type=type;node.value=value;node.autocomplete='off';return node;};
 const area=(value='',rows=4)=>{const node=el('textarea');node.value=value;node.rows=rows;return node;};
 const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const text=value=>typeof value==='string'?value:'';
 const json=value=>JSON.stringify(value,null,2);
 function safeLink(value){try{const url=new URL(value);if((url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))&&!url.username&&!url.password)return url.href;}catch{}return null;}

 function mount(container,options){
  const controller=new AbortController(),bot=options.bot,botId=bot&&bot.bot_id;
  let current=options.mode==='teams'?'teams':'browser',epoch=0,busy=false,closed=false;
  const title=el('h3',bot?bot.name+' · workspace':'Teams & templates'),tabs=el('div',undefined,'bots-toolbar');
  const notice=el('p','', 'bots-notice');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const content=el('section',undefined,'bot-workspace-content');
  container.replaceChildren(title,tabs,notice,content);
  const api=(operation,params={})=>options.api('workspace/'+operation,params,controller.signal);
  const scoped=(operation,params={})=>api(operation,{bot_id:botId,...params});
  const say=value=>{if(!closed)notice.textContent=value;};
  async function perform(fn){
   if(busy||closed)return;busy=true;const mine=epoch;
   for(const node of content.querySelectorAll('button'))node.disabled=true;
   try{await fn();}catch(error){if(!closed&&mine===epoch&&error.name!=='AbortError')say(error.message+'. Check current state before retrying an interrupted action.');}
   finally{busy=false;if(!closed&&mine===epoch)for(const node of content.querySelectorAll('button'))node.disabled=node.dataset.unavailable==='true';}
  }
  const act=(label,fn)=>button(label,()=>perform(fn));
  function download(bundle){
   const url=URL.createObjectURL(new Blob([bundle],{type:'application/json'})),link=el('a');link.href=url;link.download='echo-team.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function browser(mine){
   const status=await scoped('browser.status');if(closed||mine!==epoch)return;
   const availability=el('p',status.available?'Browser ready for this bot.':text(status.reason)||'Browser is unavailable.','bots-meta');
   const isolation=el('p','Isolation: '+(text(status.isolation)||'not reported')+(status.os_isolation===false?' · shares the host operating system':''),'bots-meta');
   const address=input(text(status.url));address.type='url';address.placeholder='https://…';address.maxLength=2048;
   const row=el('div',undefined,'bots-inline'),output=el('div',undefined,'bot-browser-output');
   async function show(result){
    if(closed||mine!==epoch)return;
    output.replaceChildren();
    if(result.url)address.value=result.url;
    if(result.title)output.append(el('h4',result.title));
    const snapshot=record(result.snapshot),snapshotText=text(result.text)||text(snapshot.text);
    if(snapshotText){const pre=el('pre',snapshotText,'bot-workspace-output');output.append(pre);}
    const controls=Array.isArray(result.controls)?result.controls:Array.isArray(result.elements)?result.elements:Array.isArray(snapshot.controls)?snapshot.controls:[];
    for(const control of controls.slice(0,100)){
     if(!control||typeof control.ref!=='string')continue;
     const line=el('div',undefined,'bot-browser-control');line.append(el('span',text(control.label)||text(control.name)||text(control.text)||control.ref));
     const kind=text(control.kind)||text(control.role)||text(control.type);
     if(['textbox','input','textarea','searchbox','editable'].includes(kind)||control.editable===true){
      const value=input();value.maxLength=4096;value.placeholder='Value';value.setAttribute('aria-label','Value for '+(control.label||control.ref));
      line.append(value,act('Fill',async()=>{await scoped('browser.act',{action:'fill',ref:control.ref,value:value.value});await show(await scoped('browser.act',{action:'snapshot'}));}));
     }else line.append(act('Click',async()=>{await scoped('browser.act',{action:'click',ref:control.ref});await show(await scoped('browser.act',{action:'snapshot'}));}));
     output.append(line);
    }
    const artifact=record(result.artifact),artifactId=text(artifact.artifact_id)||text(result.artifact_id);
    if(HEX.test(artifactId)){
     const image=await scoped('browser.artifact',{artifact_id:artifactId});if(closed||mine!==epoch)return;
     if(image.mime_type!=='image/png'||typeof image.base64!=='string'||image.base64.length>720000||!/^[A-Za-z0-9+/=]+$/.test(image.base64))throw new Error('Invalid browser screenshot');
     const shot=el('img');shot.alt='Screenshot of this bot’s browser';shot.className='bot-browser-shot';shot.src='data:image/png;base64,'+image.base64;output.append(shot);
    }
    if(!snapshotText&&!controls.length&&!artifactId)output.append(el('pre',json(result),'bot-workspace-output'));
   }
   const navigate=act('Open',async()=>{await show(await scoped('browser.act',{action:'navigate',url:address.value}));say('Page opened in this bot’s browser.');});
   row.append(field('Web address',address),navigate);
   const toolbar=el('div',undefined,'bots-toolbar');
   toolbar.append(act('Read page',async()=>show(await scoped('browser.act',{action:'snapshot'}))),act('Screenshot',async()=>show(await scoped('browser.act',{action:'screenshot'}))),act('Close browser',async()=>{await scoped('browser.close');say('Browser closed. Its profile is retained.');output.replaceChildren();}));
   const reset=button('Reset profile',()=>{const confirm=act('Confirm reset profile',async()=>{await scoped('browser.reset');say('Browser profile and screenshots removed.');output.replaceChildren();address.value='';confirm.remove();});toolbar.append(confirm);say('Reset removes this bot’s browser profile and screenshots.');});toolbar.append(reset);
   content.replaceChildren(availability,isolation,row,toolbar,output);
   if(!status.available){for(const node of [navigate,...toolbar.querySelectorAll('button')]){if(node===reset)continue;node.disabled=true;node.dataset.unavailable='true';}}
  }
  async function apps(mine){
   const [catalog,connections]=await Promise.all([api('marketplace'),scoped('connection.list')]);if(closed||mine!==epoch)return;
   const providers=Array.isArray(catalog.providers)?catalog.providers:[],connected=Array.isArray(connections.connections)?connections.connections:[];
   content.replaceChildren(el('h4','Connected apps'),el('p','Each connection belongs to this bot. Select the operations it may use, then complete the provider’s consent.','bots-meta'));
   const auth=el('div'),existing=el('div',undefined,'bot-connection-list');content.append(existing,auth);
   if(!connected.length)existing.append(el('p','No apps connected to this bot.','bots-meta'));
   for(const connection of connected){
    const card=el('article',undefined,'bots-card'),provider=providers.find(p=>p.id===connection.provider_id);
    card.append(el('h4',connection.provider_name||connection.provider_id),el('p',text(connection.status),'bots-meta'));
    if(connection.last_error)card.append(el('p',text(record(connection.last_error).message),'bots-error'));
    const controls=el('div',undefined,'bots-toolbar');
    if(connection.status==='connected')controls.append(act('Refresh grant',async()=>{await scoped('connection.refresh',{connection_id:connection.id});say('Grant refreshed.');await apps(mine);}));
    if(connection.status!=='disconnected')controls.append(act('Disconnect',async()=>{const receipt=await scoped('connection.disconnect',{connection_id:connection.id});await apps(mine);say('Disconnected for this bot. Provider revocation: '+(text(receipt.revocation_status)||String(receipt.provider_revoked===true)));}));
    card.append(controls);
    if(connection.status==='connected'&&provider){
     const picker=el('select');picker.setAttribute('aria-label','Connected app operation');
     const operations=(provider.operations||[]).filter(op=>(connection.operation_ids||[]).includes(op.id));
     for(const op of operations){const option=el('option',op.name||op.id);option.value=op.id;picker.append(option);}
     const form=el('div'),result=el('pre','', 'bot-workspace-output');
     function draw(){
      form.replaceChildren();const op=operations.find(item=>item.id===picker.value);if(!op)return;
      form.append(el('p',text(op.description),'bots-meta'));const fields=[];
      for(const [name,schema] of Object.entries(record(record(op.input_schema).properties))){
       let node;
       if(Array.isArray(schema.enum)){node=el('select');for(const choice of schema.enum){const option=el('option',choice);option.value=String(choice);node.append(option);}}
       else if(schema.type==='boolean')node=input('','checkbox');
       else if(schema.type==='object'||schema.type==='array')node=area('',2);
       else node=input('',schema.type==='integer'||schema.type==='number'?'number':'text');
       node.required=(record(op.input_schema).required||[]).includes(name);fields.push({name,schema,node});form.append(field(name+(node.required?' *':''),node));
      }
      const paramsFor=()=>{
       const params={};for(const {name,schema,node} of fields){if(!node.value&&schema.type!=='boolean'){if(node.required)throw new Error(name+' is required');continue;}params[name]=schema.type==='boolean'?node.checked:schema.type==='integer'||schema.type==='number'?Number(node.value):schema.type==='array'||schema.type==='object'?JSON.parse(node.value):node.value;}
       return params;
      };
      form.append(act(op.read_only?'Run read operation':'Run operation',async()=>{
       const params=paramsFor();
       const reply=await scoped('connection.invoke',{connection_id:connection.id,operation_id:op.id,input_json:JSON.stringify(params)});if(closed||mine!==epoch)return;result.textContent=json(reply);say('Operation returned.');
      }));
      if(op.read_only){
       const watch=el('details'),interval=input('15','number'),path=input(),compare=el('select'),value=input();interval.min='1';interval.max='1440';path.placeholder='files.0.name';value.placeholder='Value to compare';
       for(const operator of ['exists','equals','contains','gt','lt']){const option=el('option',({exists:'Exists',equals:'Equals',contains:'Contains',gt:'Greater than',lt:'Less than'})[operator]);option.value=operator;compare.append(option);}compare.value='exists';
       watch.append(el('summary','Watch for changes'),field('Check every (minutes)',interval),field('Result path (optional, dot-separated)',path),field('Condition',compare),field('Compare with',value),act('Create disabled watch',async()=>{
        const minutes=Number(interval.value);if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw new Error('Choose an interval from 1 to 1440 minutes');
        const predicate={path:path.value.trim()?path.value.trim().split('.').map(piece=>/^\d+$/.test(piece)?Number(piece):piece):[],operator:compare.value};
        if(compare.value!=='exists'){try{predicate.value=JSON.parse(value.value);}catch{predicate.value=value.value;}}
        await scoped('subscription.create',{connection_id:connection.id,operation_id:op.id,params_json:JSON.stringify(paramsFor()),interval_s:minutes*60,predicate_json:JSON.stringify(predicate)});await apps(mine);say('Watch created disabled. Enable it in App events when ready.');
       }));form.append(watch);
      }
     }
     picker.addEventListener('change',draw);if(operations.length){picker.value=operations[0].id;draw();card.append(picker,form,result);}
    }
    existing.append(card);
   }
   content.append(el('h4','App marketplace'));
   if(!providers.length)content.append(el('p','No provider definitions are installed.','bots-meta'));
   for(const provider of providers){
    const card=el('article',undefined,'bots-card'),picks=[];
    card.append(el('h4',provider.name||provider.id),el('p',text(provider.description),'bots-meta'));
    if(provider.warning||provider.revocation_effect)card.append(el('p',text(provider.warning)||text(provider.revocation_effect),'bots-notice'));
    if(!provider.configured)card.append(el('p',text(provider.unavailable_reason)||'Provider setup is required.','bots-meta'));
    for(const operation of provider.operations||[]){const checkbox=input('','checkbox');picks.push({id:operation.id,checkbox});const label=el('label',undefined,'bots-pick');label.append(checkbox,el('span',(operation.name||operation.id)+' · '+(operation.read_only?'read':'write')));card.append(label);}
    const connect=act('Connect to this bot',async()=>{
     const operationIds=picks.filter(p=>p.checkbox.checked).map(p=>p.id);if(!operationIds.length)throw new Error('Select at least one operation');
     const started=await scoped('connection.authorize',{provider_id:provider.id,operation_ids:operationIds});const href=safeLink(started.authorization_url);if(!href)throw new Error('Provider returned an invalid authorization address');
     const link=el('a','Continue to '+(provider.name||provider.id));link.href=href;link.target='_blank';link.rel='noopener noreferrer';link.className='quiet-button';auth.replaceChildren(el('p','Complete the provider’s consent, then refresh this list.'),link);say('Authorization is pending.');
    });if(!provider.configured){connect.disabled=true;connect.dataset.unavailable='true';}card.append(connect);content.append(card);
   }
   const subscriptions=await scoped('subscription.list');if(closed||mine!==epoch)return;
   const events=el('section',undefined,'bot-connection-list');events.append(el('h4','App events'),el('p','Enabled watches poll an authorized read operation. A changed result that passes the condition queues one event for this bot.','bots-meta'));
   for(const subscription of subscriptions.subscriptions||[]){
    const card=el('article',undefined,'bots-card');card.append(el('h4',subscription.operation_id),el('p',(subscription.enabled?'Enabled':'Disabled')+' · every '+Math.round(subscription.interval_s/60)+' min'+(subscription.pending_delivery?' · delivery pending':''),'bots-meta'));
    if(subscription.last_error)card.append(el('p',text(record(subscription.last_error).message),'bots-error'));
    const controls=el('div',undefined,'bots-toolbar');
    controls.append(act(subscription.enabled?'Disable':'Enable',async()=>{await scoped(subscription.enabled?'subscription.disable':'subscription.enable',{subscription_id:subscription.id});await apps(mine);say('Watch updated.');}),act('Delete watch',async()=>{await scoped('subscription.delete',{subscription_id:subscription.id});await apps(mine);say('Watch deleted.');}));
    if(subscription.last_event){const details=el('details');details.append(el('summary','Last delivery receipt'),el('pre',json(subscription.last_event),'bot-workspace-output'));card.append(details);}card.append(controls);events.append(card);
   }
   if(!(subscriptions.subscriptions||[]).length)events.append(el('p','No app watches. Open a connected read operation above to create one.','bots-meta'));
   events.append(act('Check due watches',async()=>{const result=await scoped('subscription.poll',{limit:4});say((result.receipts||[]).length+' due watch(es) checked.');await apps(mine);}));content.append(events);
  }
  async function memory(mine){
   const value=await scoped('memory.read');if(closed||mine!==epoch)return;
   const notes=area(text(value.text),10);notes.maxLength=16000;notes.setAttribute('aria-label','Bot memory notes');
   const meta=el('p','Revision '+value.revision,'bots-meta'),history=el('div');
   content.replaceChildren(el('h4','Memory notes'),el('p','These notes are recalled as reference data on this bot’s next turn. Saving creates a revision.','bots-meta'),notes,meta,
    act('Save notes',async()=>{const saved=await scoped('memory.edit',{text:notes.value,expected_revision:value.revision});Object.assign(value,saved);notes.value=saved.text;meta.textContent='Revision '+saved.revision;say('Memory saved.');}),
    act('Revision history',async()=>{const revisions=await scoped('memory.revisions',{limit:50});if(closed||mine!==epoch)return;history.replaceChildren();for(const revision of revisions.revisions||[]){const row=el('div',undefined,'bot-browser-control');row.append(el('span','Revision '+revision.revision+' · '+(revision.created_at||revision.updated_at||'')),act('Restore this revision',async()=>{await scoped('memory.restore',{revision:revision.revision,expected_revision:value.revision});say('A new revision restored the selected notes.');await memory(mine);}));history.append(row);}}),history);
  }
  async function teams(mine){
   const catalog=await api('team.templates');if(closed||mine!==epoch)return;
   const bundle=area('',8);bundle.maxLength=262144;bundle.setAttribute('aria-label','Portable team JSON');bundle.placeholder='Paste an exported team or choose a template';
   const importName=el('h4','Import a team'),plan=el('pre','', 'bot-workspace-output'),memoryOpt=input('','checkbox'),renameAgents=area('{}',2),renameBots=area('{}',2),conflict=el('select');
   for(const [value,label] of [['reject','Reject existing agent names'],['reuse_identical','Reuse identical agent definitions']]){const option=el('option',label);option.value=value;conflict.append(option);}
   const optionsFor=()=>({bundle_json:bundle.value,conflict:conflict.value,rename_agents_json:renameAgents.value,rename_bots_json:renameBots.value,include_memory:memoryOpt.checked});
   let reviewed=null;
   const commit=act('Import reviewed plan',async()=>{if(!reviewed||reviewed.input!==JSON.stringify(optionsFor()))throw new Error('Preview this exact bundle and options first');const receipt=await api('team.import',{...optionsFor(),expected_plan_sha256:reviewed.sha});say('Imported '+(receipt.bots||[]).length+' paused bots.');plan.textContent=json(receipt);reviewed=null;commit.disabled=true;commit.dataset.unavailable='true';await options.refresh();});commit.disabled=true;commit.dataset.unavailable='true';
   const preview=act('Preview import',async()=>{const params=optionsFor(),result=await api('team.preview',params);if(closed||mine!==epoch)return;reviewed={input:JSON.stringify(params),sha:result.plan_sha256};plan.textContent=json(result);commit.disabled=false;commit.dataset.unavailable='false';say('Review the proposed bots and warnings, then import.');});
   const templates=el('div',undefined,'bot-template-list');
   for(const template of catalog.templates||[]){const card=el('article',undefined,'bots-card');card.append(el('h4',template.name||template.template_id||template.id),el('p',text(template.description),'bots-meta'),act('Load template',async()=>{const result=await api('team.template',{template_id:template.template_id||template.id});bundle.value=result.bundle_json;reviewed=null;commit.disabled=true;commit.dataset.unavailable='true';say('Template loaded. Preview it to validate this host’s capabilities.');}));templates.append(card);}
   const picks=el('div'),boxes=[],currentBots=typeof options.getBots==='function'?options.getBots():options.bots||[];for(const item of currentBots){const checkbox=input('','checkbox');checkbox.checked=item.bot_id===botId;boxes.push({id:item.bot_id,node:checkbox});const label=el('label',undefined,'bots-pick');label.append(checkbox,el('span',item.name));picks.append(label);}
   const name=input('My team'),kind=el('select');for(const value of ['team','department','template']){const option=el('option',value);option.value=value;kind.append(option);}const exportNotes=input('','checkbox');
   const exporting=act('Export selected bots',async()=>{const ids=boxes.filter(item=>item.node.checked).map(item=>item.id);if(!ids.length)throw new Error('Select bots to export');const result=await api('team.export',{bot_ids:ids,name:name.value,kind:kind.value,include_memory:exportNotes.checked});download(result.bundle_json);say('Exported '+ids.length+' bot definitions.');});
   const recovery=el('section');
   const recoveryButton=act('Review import history',async()=>{
    const history=await api('team.imports');if(closed||mine!==epoch)return;recovery.replaceChildren();
    for(const item of history.imports||[]){const card=el('article',undefined,'bots-card');card.append(el('p',item.import_id+' · '+item.status));
     card.append(act('Inspect import',async()=>{const detail=await api('team.inspect',{import_id:item.import_id});if(closed||mine!==epoch)return;card.append(el('pre',json(detail),'bot-workspace-output'));
      if(['prepared','notes_pending','recovery_required'].includes(detail.status)){
       const recover=async action=>{const result=await api('team.recover',{import_id:item.import_id,expected_recovery_sha256:detail.recovery_sha256,action});say('Import recovery: '+result.status);await options.refresh();await teams(mine);};
       if(detail.rollback_available)card.append(act('Roll back these unchanged resources',()=>recover('rollback')));
       card.append(act('Preserve these resources and close the hold',()=>recover('preserve')));
      }
     }));recovery.append(card);}
   });
   const advanced=el('details');advanced.append(el('summary','Import options'),field('Name conflicts',conflict),field('Rename agents (JSON name mapping)',renameAgents),field('Rename bots (JSON portable ref mapping)',renameBots),field('Include exported memory notes',memoryOpt));
   content.replaceChildren(el('h4','Installed templates'),templates,importName,el('p','Imported bots stay paused with empty capability leases. Browser profiles, app credentials and running work are excluded.','bots-meta'),bundle,advanced,preview,commit,plan,recoveryButton,recovery,el('h4','Export a team'),field('Team name',name),field('Kind',kind),picks,field('Include memory notes in export',exportNotes),exporting);
  }
  async function render(tab){
   if(busy||closed)return;current=tab;const mine=++epoch;say('Loading…');content.replaceChildren();
   for(const node of tabs.children)node.setAttribute('aria-pressed',String(node.dataset.tab===tab));
   try{await ({browser,apps,memory,teams}[tab])(mine);if(!closed&&mine===epoch)say('');}catch(error){if(!closed&&mine===epoch&&error.name!=='AbortError')say(error.message);}
  }
  for(const [key,label] of (bot?[['browser','Browser'],['apps','Apps'],['memory','Memory'],['teams','Teams']]:[['teams','Teams & templates']])){const tab=button(label,()=>render(key));tab.dataset.tab=key;tabs.append(tab);}
  tabs.append(button('Refresh',()=>render(current)));
  void render(current);
  return {destroy(){closed=true;controller.abort();epoch++;}};
 }
 window.EchoPrimeBotWorkspace={mount};
})();
