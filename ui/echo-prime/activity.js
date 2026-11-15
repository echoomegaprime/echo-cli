(() => {
 'use strict';
 // One compact activity strip per turn. Replaces the full-width "Activity" chat
 // bubbles and the large streaming "thinking" notice (both read as cards on mobile)
 // with a single collapsed line: tool chips (workspace ✓ 0.8s · esh ✗ unknown) plus a
 // thinking/answering status line. Tap to expand per-tool detail (request id, status,
 // evidence, duration). Auto-collapses when the reply arrives; a failed tool keeps a red
 // chip with its reason. aria-live polite; reduced motion is handled in activity.css.
 const now=()=>{try{if(typeof performance!=='undefined'&&typeof performance.now==='function')return performance.now();}catch{}try{return Date.now();}catch{return 0;}};
 const secs=ms=>Math.max(0,Math.round(ms/100)/10); // one decimal second
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=String(text);return n;};
 // observed/ok -> success; unknown/unconfirmed -> warn; everything else (ok:false, error, exit!=0) -> fail.
 function classify(status){
  const s=typeof status==='string'?status.toLowerCase():'';
  if(s==='observed'||s==='ok'||s==='returned'||s==='completed')return {kind:'ok',mark:'✓'};
  if(s==='unknown'||s==='unconfirmed'||s==='pending'||s==='gated')return {kind:'warn',mark:'✗'};
  if(!s)return {kind:'warn',mark:'✗'};
  return {kind:'fail',mark:'✗'};
 }
 function makeStrip(container,options){
  const label=options&&typeof options.label==='string'?options.label:'Activity';
  const uid='activity-'+(makeStrip.seq=(makeStrip.seq||0)+1);
  const strip=el('div','activity-strip');strip.dataset.collapsed='true';strip.dataset.state='running';
  const summary=el('button','activity-summary');summary.setAttribute('type','button');summary.setAttribute('aria-expanded','false');summary.setAttribute('aria-controls',uid);summary.setAttribute('aria-label',label+' — tap to expand');
  const caret=el('span','activity-caret','▸');
  const chips=el('span','activity-chips');chips.setAttribute('role','list');
  const liveWrap=el('span','activity-line');liveWrap.setAttribute('aria-live','polite');
  const dot=el('span','activity-dot');
  const lineText=el('span','activity-line-text','Echo is thinking…');
  liveWrap.append(dot,lineText);
  summary.append(caret,chips,liveWrap);
  const details=el('div','activity-details');details.id=uid;details.hidden=true;
  strip.append(summary,details);
  const started=now();
  const rows=new Map();// id -> {name, startedAt, chipEl, detailEl, done}
  let ticker=null,finished=false,collapsed=true;
  function stopTicker(){if(ticker!==null){try{(typeof clearInterval==='function'?clearInterval:clearTimeout)(ticker);}catch{}ticker=null;}}
  function liveSeconds(){return secs(now()-started);}
  function renderLine(text){lineText.textContent=text;}
  function tick(verb){renderLine(verb+' '+liveSeconds()+'s');}
  function ensureTicker(verb){
   stopTicker();if(finished)return;
   if(typeof setInterval==='function'){ticker=setInterval(()=>{if(finished){stopTicker();return;}tick(verb);},1000);}
   tick(verb);
  }
  function setCollapsed(value){
   collapsed=!!value;strip.dataset.collapsed=String(collapsed);summary.setAttribute('aria-expanded',String(!collapsed));details.hidden=collapsed;caret.textContent=collapsed?'▸':'▾';
  }
  summary.addEventListener('click',()=>setCollapsed(!collapsed));
  function chipFor(id,name){
   let row=rows.get(id);
   if(row)return row;
   const chip=el('span','activity-chip pending');chip.setAttribute('role','listitem');
   chip.append(el('span','activity-chip-name',String(name||'tool').slice(0,40)),el('span','activity-chip-mark','…'));
   chips.append(chip);
   const detail=el('div','activity-detail');
   detail.append(el('span','activity-detail-tool',String(name||'tool').slice(0,60)),el('span','activity-detail-meta','running'));
   details.append(detail);
   row={name,startedAt:now(),chip,detail,done:false};rows.set(id,row);
   return row;
  }
  const handle={
   node:strip,
   tool(id,name){if(finished)return handle;chipFor(String(id||name||'tool'),name);ensureTicker('Echo is working…');return handle;},
   result(id,name,status,evidence){
    if(finished)return handle;
    const row=chipFor(String(id||name||'tool'),name);row.done=true;
    const c=classify(status);const dur=secs(now()-row.startedAt);
    const statusWord=typeof status==='string'&&status?status:'done';
    row.chip.className='activity-chip '+c.kind;
    row.chip.replaceChildren(el('span','activity-chip-name',String(name||row.name||'tool').slice(0,40)),el('span','activity-chip-mark',c.mark+(c.kind==='ok'?' '+dur+'s':' '+statusWord)));
    const ev=evidence&&typeof evidence==='object'?evidence:null;
    const meta=[statusWord,dur+'s',String(id||'').slice(0,80),ev&&ev.action?('action '+String(ev.action).slice(0,40)):'',ev&&ev.potential_side_effect?'side-effect possible':''].filter(Boolean).join(' · ');
    row.detail.replaceChildren(el('span','activity-detail-tool',String(name||row.name||'tool').slice(0,60)),el('span','activity-detail-meta '+c.kind,meta.slice(0,300)));
    return handle;
   },
   status(text){if(finished)return handle;stopTicker();renderLine(String(text||'').slice(0,300)||'Echo is thinking…');return handle;},
   note(text){const t=String(text||'').trim();if(!t)return handle;const detail=el('div','activity-detail');detail.append(el('span','activity-detail-tool','·'),el('span','activity-detail-meta',t.slice(0,300)));details.append(detail);return handle;},
   thinking(){if(finished)return handle;ensureTicker('Echo is thinking…');return handle;},
   answering(){if(finished)return handle;ensureTicker('Echo is answering…');return handle;},
   done(summaryText){
    finished=true;stopTicker();strip.dataset.state='done';
    const failures=[...rows.values()].filter(r=>r.chip.className.includes('fail')||r.chip.className.includes('warn')).length;
    renderLine(summaryText?String(summaryText).slice(0,160):(rows.size?(rows.size+' tool'+(rows.size===1?'':'s')+(failures?' · '+failures+' need attention':' · done')):'Done'));
    setCollapsed(true);// a tap still reveals what ran; failures already carry a red chip
    return handle;
   },
   fail(reason){
    finished=true;stopTicker();strip.dataset.state='failed';
    // mark any still-pending chips as unresolved so the strip never claims success
    for(const row of rows.values())if(!row.done){row.chip.className='activity-chip warn';row.chip.replaceChildren(el('span','activity-chip-name',String(row.name||'tool').slice(0,40)),el('span','activity-chip-mark','✗ unresolved'));}
    renderLine(String(reason||'Turn ended without completion.').slice(0,200));
    setCollapsed(rows.size>0);// keep the reason line visible; expand only when there is tool detail to show
    return handle;
   },
   elapsed(){return liveSeconds();},
   get collapsed(){return collapsed;},
   remove(){finished=true;stopTicker();try{strip.remove();}catch{}if(container&&container.hidden!==undefined)container.hidden=!container.children||!container.children.length;return handle;}
  };
  if(container){container.replaceChildren(strip);if(container.hidden!==undefined)container.hidden=false;}
  return handle;
 }
 window.EchoPrimeActivity={
  start(container,options){return makeStrip(container,options||{});},
  clear(container){if(container){try{container.replaceChildren();}catch{}if(container.hidden!==undefined)container.hidden=true;}}
 };
})();
