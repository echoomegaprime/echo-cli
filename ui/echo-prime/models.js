(() => {
 'use strict';
 // Model picker. The server decides what each provider id means; this file only offers the reviewed ids,
 // remembers the choice in this browser, and states plainly which model answered or why one is unavailable.
 const storageKey='echo-prime-model-v1',ids=['qwen','claude','gpt','grok'];
 const fallbackLabels={qwen:'Qwen (FORGE, 256K)',claude:'Claude (claude CLI)',gpt:'GPT (codex CLI)',grok:'Grok (grok CLI)'};
 let chosen=null,report=null,failed=false,generation=0;
 try{const stored=localStorage.getItem(storageKey);if(ids.includes(stored))chosen=stored;}catch{}
 const wrap=document.createElement('div'),label=document.createElement('label'),select=document.createElement('select'),note=document.createElement('small');
 wrap.className='model-picker';wrap.setAttribute('style','display:flex;flex-direction:column;gap:2px;min-width:0');
 label.className='sr-only';label.textContent='Model';
 select.id='model-select';select.setAttribute('aria-label','Model for ECHO Code');select.setAttribute('style','max-width:100%');
 note.className='connection-note';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
 label.append(select);wrap.append(label,note);
 const mount=document.querySelector('.composer-toolbar')||document.querySelector('#composer');
 if(mount)mount.append(wrap);
 function entries(){
  return ids.map(id=>{
   const row=report&&Array.isArray(report.providers)?report.providers.find(p=>p&&p.id===id):null;
   return {id,label:row&&typeof row.label==='string'?row.label:fallbackLabels[id],available:row?row.available!==false:true,reason:row&&typeof row.reason==='string'?row.reason:''};
  });
 }
 function current(){return chosen||(report&&ids.includes(report.default)?report.default:'qwen');}
 function render(){
  const list=entries(),selected=current();
  select.replaceChildren(...list.map(e=>{const option=document.createElement('option');option.value=e.id;option.textContent=e.label+(e.available?'':' (unavailable)');return option;}));
  select.value=selected;
  const row=list.find(e=>e.id===selected);
  if(failed)note.textContent='Model status unavailable. Nothing will be sent to a model until the status route answers.';
  else if(!report)note.textContent='Checking models…';
  else if(!report.routing)note.textContent='Model choice is not enabled on this host.';
  else if(row&&!row.available)note.textContent=row.label+' is unavailable: '+(row.reason||'no reason given')+'. No other model will be used.';
  else note.textContent=row?row.label+' selected. If it fails, the turn fails; no other model is used.':'';
  select.disabled=!!failed||(!!report&&!report.routing);
 }
 async function headers(){
  try{return window.EchoPrimeWorkspace&&window.EchoPrimeWorkspace.ownerHeaders?await window.EchoPrimeWorkspace.ownerHeaders():{};}catch{return {};}
 }
 async function refresh(){
  const current=++generation;
  try{
   const response=await fetch('/api/prime/models',{credentials:'same-origin',headers:{'x-prime-request':'1',...await headers()}});
   const data=await response.json();
   if(current!==generation)return;
   if(!response.ok||!data||typeof data!=='object'||!Array.isArray(data.providers))throw new Error('status');
   report=data;failed=false;
  }catch{if(current!==generation)return;report=null;failed=true;}
  render();
 }
 select.addEventListener('change',()=>{
  if(!ids.includes(select.value))return;
  chosen=select.value;
  try{localStorage.setItem(storageKey,chosen);}catch{}
  render();
 });
 window.addEventListener('echo-account-changed',()=>{refresh();});
 render();
 const ready=refresh();
 window.EchoPrimeModels={
  ready,refresh,
  /** The provider id to send with a chat turn, or undefined when the host does not route by provider. */
  provider(){return report&&report.routing===true&&!failed?current():undefined;},
  describe(model){
   if(!model||typeof model!=='object')return '';
   const name=typeof model.label==='string'?model.label:String(model.id||'model');
   if(model.answered===false)return 'no model answered ('+name+' returned no answer)';
   if(typeof model.model==='string'&&model.model)return 'answered by '+model.model;
   return 'model not reported by '+name+' (requested: '+(typeof model.requested==='string'&&model.requested?model.requested:'CLI default')+')';
  },
 };
})();
