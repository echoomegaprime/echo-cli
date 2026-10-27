(() => {
 'use strict';
 const $=s=>document.querySelector(s), snapshot=window.EchoPrimeCatalog||{capabilities:[],models:[]};
 let catalog=snapshot.capabilities, selected=null, ticket=null, host=false, submitting=false;
 const status=$('#catalog-state'), result=$('#creative-result');
 const modes={image:'prompt',video:'prompt',music:'prompt',sound:'text',voice:'text'};
 async function api(path,data){
  if(!/^https?:$/.test(location.protocol))throw Error('Open ECHO Prime through its local host to connect. This file is an offline preview.');
  const response=await fetch('/api/'+path,{method:data?'POST':'GET',headers:{'X-Prime-Request':'1',...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(25000)});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('The authorized ECHO host is not connected.');
  const value=await response.json();if(!response.ok)throw Error(value.error||'Connection unavailable');return value;
 }
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
 function choose(c){selected=c;ticket=null;$('#selected-tool').textContent=c.id;$('#tool-details').textContent=c.description;$('#creative-arguments').value=JSON.stringify(payload(),null,2);render();}
 function open(category='all',prompt=''){
  $('#creative-category').value=category;$('#creative-prompt').value=prompt;
  if(!selected||selected.category!==category){const c=catalog.find(x=>x.category===category&&x.id.startsWith('echo.media.'))||catalog.find(x=>x.category===category);if(c)choose(c);}
  else $('#creative-arguments').value=JSON.stringify(payload(),null,2);
  render();if(!$('#creative-dialog').open)$('#creative-dialog').showModal();$('#creative-search').focus();
 }
 async function connections(){
  $('#connection-result').textContent='Checking owner connections…';
  try{const s=await api('status');host=s.sdk.state==='attached';
   const row=document.querySelector('[data-system="ESH"].system-row .system-state');if(row)row.textContent=s.esh.state+(s.esh.ledgerVerified?' · ledger verified':'');
   $('#connection-result').textContent='ESH: '+s.esh.state+'. '+s.esh.detail+'. SDK: '+s.sdk.state+'.';
   if(Array.isArray(s.capabilities))catalog=s.capabilities;
  }catch(e){host=false;$('#connection-result').textContent=e.message;}
  render();
 }
 $('#creative-search').addEventListener('input',render);$('#creative-category').addEventListener('change',render);$('#include-adult').addEventListener('change',models);
 $('#creative-prompt').addEventListener('input',()=>{if(selected)$('#creative-arguments').value=JSON.stringify(payload(),null,2);ticket=null;});
 $('#creative-arguments').addEventListener('input',()=>{ticket=null;});
 $('#refresh-connections').addEventListener('click',connections);
 $('#refresh-catalog').addEventListener('click',async()=>{try{const query=$('#creative-search').value.trim()||$('#creative-category').value;const r=await api('search',{query:query==='all'?'image':query});const merged=new Map(catalog.map(c=>[c.id,c]));for(const c of r.capabilities)merged.set(c.id,c);catalog=[...merged.values()];render();result.textContent='Live registry returned '+r.capabilities.length+' entries for '+query+'.';}catch(e){fail(e);}});
 $('#prepare-creative').addEventListener('click',async()=>{
  if(!selected){result.textContent='Select a capability first.';return;}
  try{ticket=await api('prepare',{target:'sdk',name:selected.id,arguments:JSON.parse($('#creative-arguments').value)});$('#request-review').textContent=JSON.stringify(ticket.request,null,2);$('#request-cost').textContent=ticket.cost+' Required scope: '+(ticket.scope||'owner-defined');$('#execute-request').disabled=false;$('#review-dialog').showModal();}catch(e){ticket=null;fail(e);}
 });
 $('#execute-request').addEventListener('click',async()=>{
  if(!ticket||submitting)return;submitting=true;$('#execute-request').disabled=true;const current=ticket;ticket=null;
  $('#review-dialog').close();result.textContent='Submitting the reviewed request…';
  try{const r=await api('execute',{id:current.id,digest:current.digest});result.textContent=JSON.stringify(r,null,2);}catch(e){result.textContent='Outcome unknown. Do not resubmit automatically. Request ID: '+current.requestId+'\n'+e.message;}finally{submitting=false;}
 });
 window.EchoPrimeStudio={open};models();render();
})();
