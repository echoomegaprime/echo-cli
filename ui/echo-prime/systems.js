(() => {
 'use strict';
 // Live "Echo systems" panel. The rows app.js renders were a static list ("Awaiting connection" for everything); this module
 // replaces each row's state with the real answer from the service behind it, owner-only, refreshed while the dialog is open.
 // Nothing here starts a service, grants access or falls back: an unreachable service says so, with its reason.
 const POLL_MS=30000,TIMEOUT_MS=12000;
 const $=s=>document.querySelector(s);
 const dialog=()=>$('#systems-dialog');
 let generation=0,timer=0,running=0;
 function debug(event,detail){try{console.debug('[echo.systems]',{event,...(detail||{})});}catch{}}
 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 async function headers(){try{return workspace()?.ownerHeaders?await workspace().ownerHeaders():{};}catch{return {};}}
 function withTimeout(promise){return Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('No answer within '+TIMEOUT_MS/1000+' s')),TIMEOUT_MS))]);}
 async function prime(path){
  const response=await fetch(path,{method:'GET',credentials:'same-origin',headers:{'x-prime-request':'1',...await headers()}});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok)throw new Error(data&&typeof data.error==='string'?data.error:'HTTP '+response.status);
  return data;
 }
 async function ws(path){const bridge=workspace()?.bridge;if(!bridge||typeof bridge.api!=='function')throw new Error('Workspace backend is not connected');return bridge.api(path);}
 /** A probe the page itself cancelled (an account reset aborts in-flight requests, or the Workspace view moved on) says
  *  nothing about the service, so it is never rendered as offline (live test 2026-11-06: "Unreachable · signal is aborted"). */
 function interrupted(error){return !!error&&(error.name==='AbortError'||/\baborted\b|response discarded|view changed|session changed/i.test(String(error.message||'')));}
 /** Settle every probe independently so one slow service never hides the others. */
 async function settle(map){
  const keys=Object.keys(map),values=await Promise.allSettled(keys.map(k=>withTimeout(map[k]())));
  return Object.fromEntries(keys.map((k,i)=>[k,values[i].status==='fulfilled'?{ok:true,value:values[i].value}:{ok:false,error:String(values[i].reason?.message||values[i].reason||'failed').slice(0,240),...(interrupted(values[i].reason)?{interrupted:true}:{})}]));
 }
 const skipped=probe=>!!probe&&probe.ok===false&&probe.interrupted===true;
 const text=v=>typeof v==='string'?v:'';
 function fromPlugin(probe,name,detail){
  if(!probe.ok)return {state:'offline',text:'Unreachable',reason:probe.error};
  const p=probe.value?.[name];
  if(!p)return {state:'off',text:'Not configured',reason:'The Workspace backend has no '+name+' plugin configured'};
  if(p.ok!==true)return {state:'offline',text:'Not connected',reason:text(p.error)||'The plugin did not answer'};
  return {state:'connected',text:'Connected',reason:detail?detail(p.status||{}):''};
 }
 function fromHealth(probe,offText){
  if(!probe.ok)return {state:'offline',text:'Unreachable',reason:probe.error};
  const h=probe.value||{};
  if(h.configured===false)return {state:'off',text:offText||'Off',reason:text(h.reason)};
  if(h.available===true)return {state:'connected',text:'Connected',reason:text(h.service?.version?('version '+h.service.version):'')};
  return {state:'degraded',text:'Not available',reason:text(h.reason)};
 }
 /** The verdict for every row, from the probe results. Exported for tests. */
 function verdicts(r){
  const out={};
  if(skipped(r.health)){/* interrupted: the FORGE row keeps its last result */}
  else if(r.health.ok){const m=r.health.value?.model||{};out.FORGE=m.ok===true?{state:'connected',text:'Connected',reason:(m.model||'model')+' loaded'+(m.context_length?' · '+Math.round(m.context_length/1024)+'K context':'')}:{state:'degraded',text:'Model not ready',reason:text(m.error)||'The configured model is not loaded'};}
  else out.FORGE={state:'offline',text:'Unreachable',reason:r.health.error};
  if(!skipped(r.plugins)){
   out.CONTINUITY=fromPlugin(r.plugins,'ecf',s=>s.eventCount?s.eventCount+' events':'');
   out.CRYSTAL=fromPlugin(r.plugins,'crystal',s=>typeof s.total==='number'?s.total+' crystals':'');
   out.ESH=fromPlugin(r.plugins,'esh',s=>[s.version?'v'+s.version:'',s.policy_mode?s.policy_mode+' policy':''].filter(Boolean).join(' · '));
   out.PERSONALITY=fromPlugin(r.plugins,'personality',s=>text(s.service));
  }
  out.SWARM=fromHealth(r.swarm,'Off');
  const adk=fromHealth(r.adk,'Off'),bots=fromHealth(r.bots,'Off');
  out.AGENTS=adk.state==='connected'?{...adk,reason:[adk.reason,bots.state==='connected'?'echoBots on':'echoBots: '+(bots.reason||bots.text)].filter(Boolean).join(' · ')}:adk;
  out.SHADOWGLASS=fromHealth(r.browser,'Off');
  // The fleet schema names a node's state `connection` (fleet.py; fleet.js reads the same field). `dormant` is a node's
  // policy (CRUCIBLE is dormant by design), so it is counted and named but never makes the row degraded.
  if(skipped(r.fleet)){/* interrupted: the NEXUS row keeps its last result */}
  else if(r.fleet.ok){const nodes=(Array.isArray(r.fleet.value?.nodes)?r.fleet.value.nodes:[]).filter(n=>n&&typeof n==='object');
   const state=n=>typeof n.connection==='string'?n.connection:typeof n.state==='string'?n.state:'unknown';
   const up=nodes.filter(n=>state(n)==='connected').length,dormant=nodes.filter(n=>state(n)==='dormant').length,expected=nodes.length-dormant;
   out.NEXUS=nodes.length?{state:expected>0&&up===expected?'connected':up?'degraded':'offline',text:up+' of '+nodes.length+' nodes connected'+(dormant?' · '+dormant+' dormant (policy)':''),reason:nodes.filter(n=>state(n)!=='connected').map(n=>(n.name||n.id)+': '+(n.reason||state(n))).join(' · ')}:{state:'degraded',text:'No nodes reported',reason:'The fleet probe returned no nodes'};}
  else out.NEXUS={state:'offline',text:'Unreachable',reason:r.fleet.error};
  out.CREATIVE=window.EchoPrimeStudio?{state:'connected',text:'Available',reason:'Creative studio is loaded; each provider is checked when you generate'}:{state:'off',text:'Not loaded',reason:'Creative studio module is not present'};
  out.CERTFORGE={state:'off',text:'Not wired into Prime',reason:'CertForge runs on the SDK gate; Prime has no CertForge route yet'};
  out['MUSIC FORGE']={state:'off',text:'Not connected',reason:'No Music Forge service is configured for this workspace'};
  return out;
 }
 function apply(verdict){
  let up=0,total=0;
  for(const row of document.querySelectorAll('#systems-list .system-row')){
   const name=row.dataset.system,v=verdict[name],state=row.querySelector('.system-state');if(!state)continue;total++;
   if(!v){if(row.dataset.state==='connected')up++;continue;}// no verdict (an interrupted probe): the row keeps its last result
   row.dataset.state=v.state;row.dataset.live='1';state.textContent=v.text;
   const reason=v.reason||'';state.title=reason;row.setAttribute('aria-label',name+': '+v.text+(reason?' — '+reason:''));
   let note=row.querySelector('.system-reason');if(!note&&reason){note=document.createElement('small');note.className='system-reason';row.querySelector('div')?.append(note);}
   if(note)note.textContent=reason;
   if(v.state==='connected')up++;
  }
  return {up,total};
 }
 function lock(message){
  for(const row of document.querySelectorAll('#systems-list .system-row')){const state=row.querySelector('.system-state');if(state){state.textContent=message;row.dataset.state='locked';delete row.dataset.live;}row.querySelector('.system-reason')?.remove();}
 }
 async function refresh(reason){
  const d=dialog();if(!d)return;
  // An account change supersedes a check in flight (its probes were aborted); anything else waits for the running check.
  if(running&&reason!=='account')return;
  const mine=++generation,description=d.querySelector('.dialog-description');
  await Promise.resolve(workspace()?.ready).catch(()=>{});
  if(mine!==generation)return;
  const access=admission();
  if(access==='signin'){lock('Sign in to see');if(description)description.textContent='Sign in as the owner to see the live state of every Echo system.';return;}
  if(access==='member'){lock('Owner only');if(description)description.textContent='Live system status is visible to the primary owner.';return;}
  running=mine;
  if(description)description.textContent='Checking every Echo system…';
  try{
   const r=await settle({health:()=>ws('/health'),plugins:()=>ws('/plugins'),fleet:()=>ws('/fleet'),swarm:()=>prime('/api/prime/swarm/health'),adk:()=>prime('/api/prime/adk/health'),bots:()=>prime('/api/prime/bots/health'),browser:()=>prime('/api/prime/browser/status')});
   if(mine!==generation)return;
   const {up,total}=apply(verdicts(r));
   const at=new Date(),cut=Object.values(r).filter(skipped).length;
   if(description)description.textContent=up+' of '+total+' systems connected · checked '+at.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+(cut?' · '+cut+(cut===1?' check was':' checks were')+' interrupted; those rows keep their last result':'');
   debug('systems_checked',{reason,up,total});
  }catch(error){if(description)description.textContent='Status check failed: '+String(error?.message||error).slice(0,200);debug('systems_failed',{reason});}
  finally{if(running===mine)running=0;}
 }
 function schedule(){clearTimeout(timer);const d=dialog();if(d?.open&&!document.hidden)timer=setTimeout(()=>{void refresh('poll').finally(schedule);},POLL_MS);}
 function watch(){
  const d=dialog();if(!d)return;
  new MutationObserver(()=>{if(d.open){void refresh('open');schedule();}else clearTimeout(timer);}).observe(d,{attributes:true,attributeFilter:['open']});
  $('#refresh-connections')?.addEventListener('click',()=>{void refresh('button');});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&d.open){void refresh('visible');schedule();}});
  // workspace.js announces an account change on window (window.dispatchEvent), not on document.
  window.addEventListener('echo-account-changed',()=>{if(d.open)void refresh('account');});
 }
 window.EchoPrimeSystems=Object.freeze({refresh,verdicts,interrupted});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch,{once:true});else watch();
})();
