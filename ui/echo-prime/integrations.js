(() => {
 'use strict';
 const $=s=>document.querySelector(s), snapshot=window.EchoPrimeCatalog||{capabilities:[],models:[]};
 let catalog=snapshot.capabilities, selected=null, ticket=null, host=false, submitting=false,generation=0,revision=0,controller=new AbortController();
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
 function invalidate(){generation++;revision++;controller.abort();controller=new AbortController();ticket=null;selected=null;host=false;submitting=false;catalog=snapshot.capabilities;
  for(const id of ['creative-prompt','creative-arguments','creative-search'])$('#'+id).value='';
  for(const id of ['creative-result','request-review','request-cost','connection-result','tool-details','selected-tool'])$('#'+id).textContent='';
  $('#execute-request').disabled=true;for(const id of ['review-dialog','creative-dialog'])if($('#'+id).open)$('#'+id).close();render();debug('account','cleared');
 }
 window.addEventListener('echo-account-changed',invalidate);
 function fail(error){result.textContent=error instanceof Error?error.message:'Connection unavailable';}
 function models(){
  const target=$('#model-list');target.replaceChildren();
  for(const m of snapshot.models||[]){if(m.nsfwCapable&&!$('#include-adult').checked)continue;const item=document.createElement('span');item.className='model-tag';item.textContent=m.name+(m.nsfwCapable?' · NSFW-capable':'')+' · '+m.node;item.title=m.note||'Listed in the registry; live availability is unverified.';target.append(item);}
 }
 function render(){
  const query=$('#creative-search').value.toLowerCase(),category=$('#creative-category').value,target=$('#creative-tools');target.replaceChildren();
  const rows=catalog.filter(c=>(category==='all'||c.category===category)&&(c.id+' '+c.description).toLowerCase().includes(query));
  status.textContent=rows.length+' of '+catalog.length+' creative capabilities · '+(host?'Host connected; availability checked per request':'Registry snapshot · live availability unverified');
  for(const c of rows){const b=document.createElement('button');b.className='creative-tool';b.setAttribute('aria-pressed',String(selected?.id===c.id));const title=document.createElement('strong'),small=document.createElement('small'),state=document.createElement('span');title.textContent=c.id.replace(/^echo\./,'');small.textContent=c.description;state.textContent=c.health+' · '+(c.scope||'scope unknown');b.append(title,state,small);b.addEventListener('click',()=>choose(c));target.append(b);}
 }
 function payload(){
  const text=$('#creative-prompt').value.trim(),kind=modes[selected?.category];
  return {command:selected?.id.split('.').at(-1)||'generate',options:kind?{[kind]:text,...(/^echo\.media\.(image|video)_generate$/.test(selected.id)?{wait:false}:{})}:{}};
 }
 function choose(c){selected=c;ticket=null;revision++;$('#execute-request').disabled=true;$('#selected-tool').textContent=c.id;$('#tool-details').textContent=c.description;$('#creative-arguments').value=JSON.stringify(payload(),null,2);render();}
 function open(category='all',prompt=''){
  $('#creative-category').value=category;$('#creative-prompt').value=prompt;
  if(!selected||selected.category!==category){const c=catalog.find(x=>x.category===category&&x.id.startsWith('echo.media.'))||catalog.find(x=>x.category===category);if(c)choose(c);}
  else $('#creative-arguments').value=JSON.stringify(payload(),null,2);
  render();if(!$('#creative-dialog').open)$('#creative-dialog').showModal();$('#creative-search').focus();
 }
 async function connections(){
  const current=generation;
  $('#connection-result').textContent='Checking owner connections…';
  try{const s=await api('status');if(current!==generation)return;host=s.sdk.state==='attached';
   const row=document.querySelector('[data-system="ESH"].system-row .system-state');if(row)row.textContent=s.esh.state+(s.esh.ledgerVerified?' · ledger verified':'');
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
  try{const r=await api('execute',{id:current.id,digest:current.digest});if(epoch===generation){result.textContent=JSON.stringify(r,null,2);debug('execute','returned');}}catch(e){if(epoch===generation){result.textContent='Outcome unknown. Do not resubmit automatically. Request ID: '+current.requestId+'\n'+e.message;debug('execute','unconfirmed');}}finally{if(epoch===generation)submitting=false;}
 });
 window.EchoPrimeStudio={open};models();render();
})();
