(() => {
 'use strict';
 // Model picker. The server decides what each provider id means; this file only offers the reviewed ids,
 // remembers the choice in this browser, and states plainly which model answered or why one is unavailable.
 const storageKey='echo-prime-model-v1',variantKey='echo-prime-argon-model-v1',ids=['qwen','claude','gpt','grok','argon'];
 const fallbackLabels={qwen:'Qwen (FORGE, 256K)',claude:'Claude (claude CLI)',gpt:'GPT (codex CLI)',grok:'Grok (grok CLI)',argon:'Argon (Gemini 4, agy CLI)'};
 let chosen=null,chosenVariant=null,report=null,failed=false,generation=0;
 try{const stored=localStorage.getItem(storageKey);if(ids.includes(stored))chosen=stored;}catch{}
 try{const stored=localStorage.getItem(variantKey);if(typeof stored==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(stored))chosenVariant=stored;}catch{}
 const wrap=document.createElement('div'),label=document.createElement('label'),select=document.createElement('select'),note=document.createElement('small');
 wrap.className='model-picker';wrap.setAttribute('style','display:flex;flex-direction:column;gap:2px;min-width:0');
 label.className='sr-only';label.textContent='Model';
 select.id='model-select';select.setAttribute('aria-label','Model for ECHO Code');select.setAttribute('style','max-width:100%');
 note.className='connection-note';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
 label.append(select);
 // Second select: the Gemini variants agy offers, shown only while Argon is selected.
 const variantLabel=document.createElement('label'),variantSelect=document.createElement('select');
 variantLabel.className='sr-only';variantLabel.textContent='Gemini model';
 variantSelect.id='argon-model-select';variantSelect.setAttribute('aria-label','Gemini model for Argon');variantSelect.setAttribute('style','max-width:100%');variantSelect.hidden=true;
 variantLabel.append(variantSelect);wrap.append(label,variantLabel,note);
 const mount=document.querySelector('.composer-toolbar')||document.querySelector('#composer');
 if(mount)mount.append(wrap);
 function entries(){
  return ids.map(id=>{
   const row=report&&Array.isArray(report.providers)?report.providers.find(p=>p&&p.id===id):null;
   return {id,label:row&&typeof row.label==='string'?row.label:fallbackLabels[id],available:row?row.available!==false:true,reason:row&&typeof row.reason==='string'?row.reason:''};
  });
 }
 function current(){return chosen||(report&&ids.includes(report.default)?report.default:'qwen');}
 function argonRow(){return report&&Array.isArray(report.providers)?report.providers.find(p=>p&&p.id==='argon')||null:null;}
 function variants(){
  const row=argonRow();
  return row&&Array.isArray(row.variants)?row.variants.filter(v=>v&&typeof v.id==='string'&&v.id):[];
 }
 /** The Gemini id shown in the second select (what you see is what is sent), or undefined when Argon is not selected or agy listed none. */
 function currentVariant(){
  if(current()!=='argon')return undefined;
  const list=variants();
  if(!list.length)return undefined;
  return list.some(v=>v.id===chosenVariant)?chosenVariant:list[0].id;
 }
 function render(){
  const list=entries(),selected=current();
  select.replaceChildren(...list.map(e=>{const option=document.createElement('option');option.value=e.id;option.textContent=e.label+(e.available?'':' (unavailable)');return option;}));
  select.value=selected;
  const gemini=selected==='argon'?variants():[],shown=currentVariant();
  variantSelect.replaceChildren(...gemini.map(v=>{const option=document.createElement('option');option.value=v.id;option.textContent=typeof v.label==='string'&&v.label?v.label:v.id;return option;}));
  variantSelect.hidden=!gemini.length;
  if(shown)variantSelect.value=shown;
  variantSelect.disabled=!!failed||(!!report&&!report.routing);
  const row=list.find(e=>e.id===selected);
  if(failed)note.textContent='Model status unavailable. Nothing will be sent to a model until the status route answers.';
  else if(!report)note.textContent='Checking models…';
  else if(!report.routing)note.textContent='Model choice is not enabled on this host.';
  else if(row&&!row.available)note.textContent=row.label+' is unavailable: '+(row.reason||'no reason given')+'. No other model will be used.';
  else if(selected==='argon'&&row&&!gemini.length){const why=argonRow()&&typeof argonRow().variantsReason==='string'?argonRow().variantsReason:'no Gemini models were listed';note.textContent=row.label+' selected. '+why+'; the agy default model is used. If it fails, the turn fails; no other model is used.';}
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
 variantSelect.addEventListener('change',()=>{
  if(!variants().some(v=>v.id===variantSelect.value))return;
  chosenVariant=variantSelect.value;
  try{localStorage.setItem(variantKey,chosenVariant);}catch{}
  render();
 });
 window.addEventListener('echo-account-changed',()=>{refresh();});
 render();
 const ready=refresh();
 window.EchoPrimeModels={
  ready,refresh,
  /** The provider id to send with a chat turn, or undefined when the host does not route by provider. */
  provider(){return report&&report.routing===true&&!failed?current():undefined;},
  /** The Gemini model id to send with an Argon turn (validated by the server against agy's list), else undefined. */
  model(){return report&&report.routing===true&&!failed?currentVariant():undefined;},
  describe(model){
   if(!model||typeof model!=='object')return '';
   const name=typeof model.label==='string'?model.label:String(model.id||'model');
   if(model.answered===false)return 'no model answered ('+name+' returned no answer)';
   if(typeof model.model==='string'&&model.model)return 'answered by '+model.model;
   return 'model not reported by '+(model.id==='argon'?'agy':name)+' (requested: '+(typeof model.requested==='string'&&model.requested?model.requested:'CLI default')+')';
  },
 };
})();
