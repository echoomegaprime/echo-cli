(()=>{
 'use strict';
 const $=selector=>document.querySelector(selector),panel=$('#steward-dialog'),select=$('#steward-node'),mode=$('#steward-mode'),input=$('#steward-text'),target=$('#steward-target'),result=$('#steward-result'),submit=$('#steward-submit');
 let generation=0,controller,available=[],busy=false;
 function reset(){generation++;controller?.abort();result.textContent='';}
 function lock(value){busy=value;submit.disabled=value||!available.length;for(const element of [select,mode,input,target,$('#refresh-steward')])element.disabled=value;}
 async function request(path,data,signal){
  const response=await fetch('/api/steward/'+path,{method:data?'POST':'GET',credentials:'same-origin',headers:{'X-Prime-Request':'1',...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'Steward owner is unavailable.');return value;
 }
 function render(status){
  available=(status.nodes||[]).filter(node=>node.advisoryAvailable);
  const options=available.map(node=>{const option=document.createElement('option');option.value=node.id;option.textContent=node.id;return option;});select.replaceChildren(...options);select.value=available[0]?.id||'';
  $('#steward-nodes').replaceChildren();
  for(const node of status.nodes||[]){
   const row=document.createElement('tr');
   for(const value of [node.id,node.os,node.identityVerified&&node.admitted?'Verified · admitted':'Awaiting admission',node.runtime.current?node.runtime.state:'Unverified / stale',node.runtime.model||'Unknown',node.evaluation.verdict,node.rollbackReady?'Ready':'Unverified']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
   $('#steward-nodes').append(row);
  }
  const coverage=status.coverage;
  $('#steward-status').textContent=status.state==='connected'?(status.inventoryComplete?'Fleet inventory current. ':'Fleet inventory incomplete. ')+(coverage?coverage.available+' of '+coverage.total+' nodes available for advice; '+(coverage.residents||0)+' verified residents. ':'')+(status.coverageComplete?'Every inventoried node has a verified resident.':'Resident coverage is incomplete.'):(status.detail||'Current fleet inventory is unavailable.');
  lock(false);
 }
 async function refresh(){
  reset();available=[];lock(true);const revision=generation;controller=new AbortController();
  $('#steward-status').textContent='Checking fleet and resident models…';
  try{const value=await request('status',undefined,controller.signal);if(revision===generation)render(value);}
  catch(error){if(revision!==generation)return;render({nodes:[],state:'unavailable',detail:error.message});}
  finally{if(revision===generation)lock(false);}
 }
 $('#open-steward').addEventListener('click',()=>{if(!panel.open)panel.showModal();return refresh();});
 $('#close-steward').addEventListener('click',()=>panel.close());
 panel.addEventListener('close',()=>{reset();available=[];select.replaceChildren();input.value='';target.value='';lock(false);});
 $('#refresh-steward').addEventListener('click',refresh);
 select.addEventListener('change',reset);
 mode.addEventListener('change',()=>{reset();target.value='';$('#steward-target-label').hidden=mode.value!=='proposal';});
 $('#steward-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!available.some(node=>node.id===select.value)||!input.value.trim())return;
  if(mode.value==='proposal'&&!target.value.trim()){result.textContent='Name the exact service, path or resource in the incident.';return;}
  reset();const revision=generation;controller=new AbortController();lock(true);result.textContent='Asking this node’s Steward…';
  try{
   const value=await request('ask',{node:select.value,mode:mode.value,text:input.value.trim(),...(mode.value==='proposal'?{target:target.value.trim()}:{})},controller.signal);
   if(revision===generation)result.textContent=(value.text||JSON.stringify(value.proposal,null,2))+'\n\nAdvisory output. Verify the evidence before acting.';
  }catch(error){if(revision===generation)result.textContent=error.message;}
  finally{if(revision===generation)lock(false);}
 });
 lock(false);
})();
