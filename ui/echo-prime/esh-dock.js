(() => {
 'use strict';
 // ESH dock chrome ported from the private Workspace (esh-panel.js): a status
 // badge in the titlebar, the `PS >` prompt, Ctrl+Enter and readable receipts
 // (stdout, stderr, exit code, audit id). Prime keeps its review-then-run gate:
 // Ctrl+Enter reviews the command first and runs only an already reviewed one.
 // workspace.js owns the rows and calls render(); nothing here fetches.
 const $=selector=>document.querySelector(selector);
 const labels={running:'Working…',returned:'Complete',failed:'Needs attention',gated:'Needs authorization',unconfirmed:'Unconfirmed'};
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }
 const asText=value=>typeof value==='string'?value:value===undefined||value===null?'':JSON.stringify(value,null,2);
 function statusFor(rows){
  const list=Array.isArray(rows)?rows:[],running=list.some(row=>row?.outcome==='running'),last=list[list.length-1];
  const outcome=running?'running':last?String(last.outcome||''):'ready';
  return {text:running?labels.running:last?labels[outcome]||'Ready':'Ready',working:running,outcome};
 }
 function entry(row){
  const result=row.result,exit=result&&typeof result==='object'&&result.exit!==undefined&&result.exit!==null?' · exit '+String(result.exit).slice(0,20):'';
  const node=el('article',{class:'esh-entry '+String(row.outcome||'')},
   el('div',{class:'esh-entry-head'},el('span',{},String(row.source||'Echo')),el('span',{},String(row.outcome||'')+exit)),
   el('pre',{class:'esh-command-text workspace-receipt'},'PS > '+(row.command||'Command receipt')));
  if(result&&typeof result==='object'){
   if(result.stdout)node.append(el('pre',{class:'esh-stdout workspace-receipt'},asText(result.stdout)));
   if(result.stderr)node.append(el('pre',{class:'esh-stderr workspace-receipt'},asText(result.stderr)));
   if(result.error||result.reason)node.append(el('p',{class:'esh-stderr'},asText(result.error||result.reason)));
   if(!result.stdout&&!result.stderr&&!result.error&&!result.reason)node.append(el('span',{class:'esh-no-output'},'No text output.'));
   node.append(el('details',{class:'esh-receipt'},el('summary',{},'Receipt'+(result.audit_id?' · '+String(result.audit_id).slice(0,120):'')),el('pre',{class:'workspace-receipt'},asText(result))));
  }else if(result!==undefined&&result!==null)node.append(el('pre',{class:'workspace-receipt'},asText(result)));
  else node.append(el('span',{class:'esh-no-output'},row.outcome==='running'?'Waiting for a final receipt…':'No final receipt recorded. Check before retrying.'));
  return node;
 }
 let badge=null;
 function render(output,rows){
  const list=Array.isArray(rows)?rows.slice(-100):[];
  if(output){output.replaceChildren(...list.map(entry));if(!list.length)output.append(el('p',{},'Commands and receipts from this conversation appear here.'));try{output.scrollTop=output.scrollHeight;}catch{}}
  const status=statusFor(list);
  if(badge){badge.textContent=status.text;badge.dataset.outcome=status.outcome;badge.classList.toggle('working',status.working);}
  return status;
 }
 function mount(){
  const title=$('#workspace-esh-title'),command=$('#workspace-esh-command'),review=$('#workspace-esh-review'),run=$('#workspace-esh-run');
  if(!title||!command||!review||!run)return false;
  badge=el('span',{class:'esh-status','data-esh-status':'',role:'status'},'Ready');badge.dataset.outcome='ready';title.after(badge);
  command.before(el('span',{class:'esh-prompt','aria-hidden':'true'},'PS >'));
  command.setAttribute('placeholder','Exact command for your existing ESH policy · Ctrl+Enter reviews, Ctrl+Enter again runs');
  command.addEventListener('keydown',event=>{
   if(event.key!=='Enter'||!(event.ctrlKey||event.metaKey)||event.isComposing)return;
   event.preventDefault();
   return run.disabled?review.click():run.click();
  });
  return true;
 }
 window.EchoPrimeEshDock={labels,statusFor,entry,render,mount};
 try{mount();}catch{}
})();
