(() => {
 'use strict';
 // In-chat browser panel. Drives the Commander's OWN signed-in Chrome through the ShadowGlass extension relay
 // (Prime server routes /api/prime/browser/*, owner-only). It is never available to bots or members, never types
 // credentials, and never opens extra windows — the relay drives the live Chrome, which is the feature.
 // Live view = a full-page screenshot polled every 1.5 s while visible (paused when hidden or collapsed), falling
 // back to readable text + interactive nodes whenever a screenshot is unavailable (the relay's CDP screenshot can
 // time out). "Let Echo drive" turns a fenced ```browser block in a reply into an Approve/Skip batch — nothing runs
 // without the owner's click. Account-scoped: only panel geometry/open state is persisted; never tabs, URLs or titles.
 const $=s=>document.querySelector(s);
 const POLL_MS=1500,STORE='echo-prime-browser-v1',MAX_ACTIONS=20;
 const VERBS=['open','navigate','click','type','read'];
 let panel=null,els={},state={open:false,collapsed:false,view:'text',tabs:[],activeTab:null,current:null,width:420};
 // generation: poll/snapshot epoch · accountEpoch: bumps on echo-account-changed (aborts an executing batch) ·
 // lifecycle: bumps on open/close so a late activation step never resumes a closed panel.
 let generation=0,accountEpoch=0,lifecycle=0,pollTimer=null,inflight=false,lastPoll=0;
 // decided: block keys the owner already approved/skipped this session · proposed: pending cards by key (re-shown if a redraw drops them)
 const decided=new Set(),proposed=new Map();

 function el(tag,attrs,...kids){
  const n=document.createElement(tag);
  if(attrs)for(const [k,v] of Object.entries(attrs)){if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(v!==false&&v!==undefined&&v!==null)n.setAttribute(k,String(v));}
  for(const kid of kids.flat())if(kid!==null&&kid!==undefined)n.append(typeof kid==='string'?document.createTextNode(kid):kid);
  return n;
 }
 const clip=(v,n)=>{const s=typeof v==='string'?v:'';return s.length>n?s.slice(0,n)+'…':s;};

 function workspace(){const ws=window.EchoPrimeWorkspace;return ws&&typeof ws==='object'?ws:null;}
 /** What the cached session admits, read without a request: 'open' (no authenticated Workspace — the Prime cookie
  *  alone decides), 'signin', 'member' or 'owner'. Every /api/prime/browser route is owner-only. */
 function admission(){
  const ws=workspace();if(!ws||ws.enabled!==true)return 'open';
  const session=ws.session;if(!session||session.authenticated!==true)return 'signin';
  return session.ownerAccess===true?'owner':'member';
 }
 const quiet=message=>Object.assign(new Error(message),{quiet:true});
 const refusal=access=>access==='signin'?quiet('Sign in to use the in-chat browser.'):access==='member'?quiet('The in-chat browser is the primary owner\'s only.'):null;
 async function settled(){const ws=workspace();if(ws)await Promise.resolve(ws.ready).catch(()=>{});return ws;}
 /** Owner proof headers. On a Workspace host a rejected ownerHeaders() (demoted/expired owner) PROPAGATES: it must never
  *  degrade to {} and still fire the request. On an open host there is no Workspace and the Prime cookie alone decides. */
 async function headers(){
  const ws=await settled();if(!ws||typeof ws.ownerHeaders!=='function')return {};
  try{return await ws.ownerHeaders();}catch(error){throw quiet(error&&error.message||'Primary owner admission required.');}
 }
 /** Owner-only fetch. A signin/member visitor is refused WITHOUT any request (clearing the page for them restarted the
  *  old 401 loop); admission is read after the Workspace is `ready` and re-checked after the async owner proof, so a
  *  session that changed mid-flight never gets a request. Only an owner session that 401/403s has anything to invalidate. */
 async function api(path,body,signal){
  await settled();
  let access=admission(),denied=refusal(access);if(denied)throw denied;
  const proof=await headers();
  access=admission();denied=refusal(access);if(denied)throw denied;
  const sent={'x-prime-request':'1',...proof,...(body?{'content-type':'application/json'}:{})};
  const response=await fetch('/api/prime/browser/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:sent,...(body?{body:JSON.stringify(body)}:{}),signal});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
   const ws=workspace();
   if((response.status===401||response.status===403)&&access==='owner'&&ws&&typeof ws.invalidate==='function')ws.invalidate();
   throw new Error(data&&typeof data.error==='string'?data.error:'Browser request failed (HTTP '+response.status+')');
  }
  if(!data||typeof data!=='object')throw new Error('Browser relay returned an unrecognized response');
  return data;
 }
 const act=(verb,extra,signal)=>api('act',{verb,...extra},signal);

 // ---- fenced ```browser block → batch of actions (parsed; NOT run) ----
 function parseActions(text){
  if(typeof text!=='string')return [];
  const out=[];const re=/```browser\s*\n([\s\S]*?)```/gi;let m;
  while((m=re.exec(text))&&out.length<MAX_ACTIONS){
   for(const raw of m[1].split('\n')){
    const line=raw.trim();if(!line||out.length>=MAX_ACTIONS)continue;
    const hit=/^(open|navigate|click|type|read)\s+(.+)$/i.exec(line);
    if(!hit)continue;
    out.push({verb:hit[1].toLowerCase(),value:hit[2].trim().slice(0,4096)});
   }
  }
  return out;
 }
 /** The act body for one drive action against `tab` — built at EXECUTION time so later steps follow a tab an earlier `open` created. */
 function actionCall(a,tab){
  switch(a.verb){
   case 'open':return {verb:'open',url:a.value};
   case 'navigate':return {verb:'navigate',tab,url:a.value};
   case 'click':return {verb:'click',tab,text:a.value};
   case 'type':return {verb:'type',tab,text:a.value};
   default:return {verb:'read',tab,selector:a.value};
  }
 }

 // ---- chat cards ----
 function chatLine(role){
  const article=el('article',{class:'chat-message '+role});
  const host=$('#chat-log');if(host){host.append(article);host.hidden=false;const w=$('#welcome');if(w)w.hidden=true;if(article.scrollIntoView)article.scrollIntoView({block:'nearest'});}
  return article;
 }
 function systemCard(title){
  const card=chatLine('activity');card.classList&&card.classList.add('browser-card');
  card.append(el('strong',{text:'In-chat browser'}),el('p',{text:title}));
  return card;
 }
 /** Builds the Approve/Skip card for a drive batch. NOTHING fetches until Approve is clicked. The card shows every action in
  *  full (what is shown is exactly what runs). On Approve the batch runs against a batch-local tab that follows each successful
  *  `open`, is pinned to the account epoch it was approved under (an account change aborts it), and stops on the first failure. */
 function proposeBatch(actions,key){
  const items=(Array.isArray(actions)?actions:[]).filter(a=>a&&VERBS.includes(a.verb)&&typeof a.value==='string'&&a.value.trim());
  if(!items.length)return null;
  const start=state.activeTab;
  const card=systemCard('Echo proposed '+items.length+' browser action'+(items.length===1?'':'s')+(start!==null?' · starting on tab '+start:' · no tab is open, so the first action must be open'));
  const list=el('ol',{class:'browser-batch'});
  for(const a of items)list.append(el('li',{},el('code',{text:a.verb}),' ',el('span',{class:'browser-batch-value',text:a.value})));
  const result=el('div',{class:'browser-batch-result'});
  const approve=el('button',{type:'button',class:'new-chat','data-browser-approve':'1'},'Approve'),skip=el('button',{type:'button',class:'quiet-button'},'Skip');
  const controls=el('div',{class:'browser-batch-controls'},approve,skip);
  card.append(list,controls,result);
  const decide=()=>{if(key)decided.add(key);};
  skip.addEventListener('click',()=>{decide();controls.hidden=true;result.append(el('p',{class:'browser-meta',text:'Skipped. Nothing was run.'}));});
  approve.addEventListener('click',async()=>{
   if(approve.disabled)return;approve.disabled=true;skip.disabled=true;controls.hidden=true;decide();
   const epoch=accountEpoch;let tab=start;
   if(!state.open)openPanel();
   for(let i=0;i<items.length;i++){
    const a=items[i],row=el('p',{class:'browser-meta',text:'['+(i+1)+'/'+items.length+'] '+a.verb+'…'});result.append(row);
    const c=actionCall(a,tab);
    try{
     const out=await act(c.verb,c);
     if(epoch!==accountEpoch){row.textContent='['+(i+1)+'/'+items.length+'] '+a.verb+' finished after the account changed; stopping.';break;}
     if(a.verb==='open'&&out&&typeof out.id==='number'){tab=out.id;state.activeTab=out.id;}
     row.textContent='['+(i+1)+'/'+items.length+'] '+a.verb+' ✓ '+clip(out&&out.value!==undefined?('read: '+out.value):(out&&out.url?out.url:'done'),400);
    }catch(error){
     if(epoch!==accountEpoch){row.textContent='['+(i+1)+'/'+items.length+'] '+a.verb+' stopped: the account changed.';break;}
     row.textContent='['+(i+1)+'/'+items.length+'] '+a.verb+' failed: '+clip(error&&error.message||'failed',300);result.append(el('p',{class:'browser-error',text:'Stopped: the remaining actions were not run.'}));break;
    }
   }
   if(epoch===accountEpoch)refreshTabs().catch(()=>{});
  });
  return card;
 }
 // Scan assistant replies for a COMPLETE ```browser block (a streaming reply stays unmarked until its closing fence arrives).
 // Keyed by block text within the account epoch: a block the owner already approved/skipped is never re-proposed; a pending
 // card that a chat redraw (workspace renderChat → replaceChildren) removed IS re-proposed so the owner can still decide.
 function scan(root){
  const host=root||$('#chat-log');if(!host||!host.children)return;
  const present=[...host.children];
  for(const node of present){
   const cls=node.className||'';if(!/\bassistant\b/.test(cls))continue;
   const text=node.textContent||'';if(!/```browser[\s\S]*?```/i.test(text))continue;
   if(node.dataset&&node.dataset.browserScanned)continue;
   if(node.dataset)node.dataset.browserScanned='1';
   const key='b:'+text.length+':'+clip(text,160);
   if(decided.has(key))continue;
   const existing=proposed.get(key);if(existing&&present.includes(existing))continue;
   const actions=parseActions(text);if(!actions.length)continue;
   const card=proposeBatch(actions,key);if(card)proposed.set(key,card);
  }
 }

 // ---- panel ----
 function store(){try{localStorage.setItem(STORE,JSON.stringify({open:state.open,collapsed:state.collapsed,width:state.width}));}catch{}}
 /** Widest the dock may be: never wider than the viewport minus room for the conversation (a restored 900 px at 801 px must not cover the chat). */
 function maxWidth(){const vw=Number(window.innerWidth)||1200;return Math.max(300,Math.min(900,vw-320));}
 const clampWidth=w=>Math.max(300,Math.min(maxWidth(),Math.round(Number(w)||420)));
 function restore(){try{const s=JSON.parse(localStorage.getItem(STORE)||'{}');if(s&&typeof s==='object'){if(typeof s.width==='number')state.width=clampWidth(s.width);state.collapsed=!!s.collapsed;}}catch{}}
 function applyLayout(){
  if(!panel)return;
  document.body.classList&&document.body.classList.toggle('browser-open',state.open);
  document.body.classList&&document.body.classList.toggle('browser-collapsed',state.open&&state.collapsed);
  if(document.body.style&&document.body.style.setProperty)document.body.style.setProperty('--browser-w',clampWidth(state.width)+'px');
  panel.hidden=!state.open;
  if(els.collapse)els.collapse.textContent=state.collapsed?'▸':'▾';
 }
 function build(){
  if(panel)return;
  els.tabstrip=el('div',{class:'browser-tabs',role:'tablist','aria-label':'Open tabs'});
  els.addr=el('input',{type:'url',class:'browser-addr',placeholder:'https://…  (Enter to go)',autocomplete:'off',spellcheck:'false'});
  els.back=el('button',{type:'button',class:'quiet-button browser-btn','aria-label':'Back',title:'Back'},'◂');
  els.fwd=el('button',{type:'button',class:'quiet-button browser-btn','aria-label':'Forward',title:'Forward'},'▸');
  els.reload=el('button',{type:'button',class:'quiet-button browser-btn','aria-label':'Reload',title:'Reload'},'⟳');
  els.newtab=el('button',{type:'button',class:'quiet-button browser-btn','aria-label':'New tab',title:'New tab'},'+');
  els.viewtoggle=el('button',{type:'button',class:'quiet-button browser-btn',title:'Toggle image / text view'},state.view==='image'?'Text view':'Image view');
  els.collapse=el('button',{type:'button',class:'quiet-button browser-btn','aria-label':'Collapse'},'▾');
  els.closeBtn=el('button',{type:'button',class:'quiet-button browser-btn','aria-label':'Close'},'✕');
  els.view=el('div',{class:'browser-view',role:'group','aria-label':'Live page'});
  els.statusLine=el('p',{class:'browser-status',role:'status'});
  els.fieldSel=el('input',{type:'text',class:'browser-field-sel',placeholder:'CSS selector',autocomplete:'off',spellcheck:'false'});
  els.fieldVal=el('input',{type:'text',class:'browser-field-val',placeholder:'value to type',autocomplete:'off'});
  els.fill=el('button',{type:'button',class:'quiet-button browser-btn'},'Fill');
  els.read=el('button',{type:'button',class:'quiet-button browser-btn'},'Read');
  els.sendChat=el('button',{type:'button',class:'quiet-button browser-btn'},'Send to chat');
  els.resizer=el('button',{type:'button',class:'browser-resizer','aria-label':'Resize panel'});
  const header=el('div',{class:'browser-header'},el('strong',{text:'In-chat browser'}),el('small',{text:'Commander\'s Chrome'}),el('span',{class:'browser-spacer'}),els.collapse,els.closeBtn);
  const toolbar=el('div',{class:'browser-toolbar'},els.back,els.fwd,els.reload,els.addr,els.newtab,els.viewtoggle);
  const fieldbar=el('div',{class:'browser-fieldbar'},els.fieldSel,els.fieldVal,els.fill,els.read,els.sendChat);
  panel=el('aside',{id:'browser-panel',class:'browser-panel',role:'region','aria-label':'In-chat browser'},els.resizer,header,toolbar,els.tabstrip,els.view,fieldbar,els.statusLine);
  if(document.body&&document.body.append)document.body.append(panel);
  wire();
 }
 function status(text){if(els.statusLine)els.statusLine.textContent=text||'';}

 function offState(reason){
  els.view.replaceChildren(
   el('p',{class:'browser-off-title',text:'In-chat browser is off'}),
   el('p',{class:'browser-meta',text:reason||'Enable it with a reviewed `browser` section in the Prime config (loopback relayUrl only, default http://127.0.0.1:9780).'}),
   el('p',{class:'browser-meta',text:'This drives the Commander\'s own signed-in ShadowGlass Chrome through a loopback relay. It is never available to bots or members, and never types credentials.'}));
  els.tabstrip.replaceChildren();
 }

 function renderTabs(){
  els.tabstrip.replaceChildren();
  for(const t of state.tabs.slice(0,30)){
   const active=t.id===state.activeTab;
   const tab=el('button',{type:'button',class:'browser-tab'+(active?' active':''),role:'tab','aria-selected':String(active),title:clip(t.url,300)},clip(t.title||t.url||'tab',28));
   tab.addEventListener('click',()=>{if(state.activeTab===t.id)return;state.activeTab=t.id;state.current=null;els.view.replaceChildren(el('p',{class:'browser-meta',text:'Loading…'}));renderTabs();pollNow();});
   const x=el('span',{class:'browser-tab-x','aria-hidden':'true'},'×');
   x.addEventListener('click',async ev=>{if(ev.stopPropagation)ev.stopPropagation();try{await act('close',{tab:t.id});}catch(e){status(e.message);}await refreshTabs();if(state.activeTab===t.id)state.activeTab=state.tabs[0]?state.tabs[0].id:null;pollNow();});
   tab.append(x);els.tabstrip.append(tab);
  }
 }
 async function refreshTabs(signal){
  const data=await api('tabs',undefined,signal);
  state.tabs=Array.isArray(data.tabs)?data.tabs:[];
  if(!state.tabs.some(t=>t.id===state.activeTab))state.activeTab=state.tabs[0]?state.tabs[0].id:null;
  renderTabs();
 }

 function renderSnapshot(snap){
  state.current=snap;
  if(els.addr&&document.activeElement!==els.addr)els.addr.value=snap.url||'';
  const view=els.view;view.replaceChildren();
  if(state.view==='image'&&snap.screenshot){
   const img=el('img',{class:'browser-shot',alt:'Live page screenshot'});img.src=snap.screenshot;
   img.addEventListener('click',ev=>clickShot(ev,img));
   view.append(img);
   if(!snap.metrics)view.append(el('p',{class:'browser-meta',text:'Click mapping unavailable for this frame (no viewport metrics).'}));
  }else{
   if(state.view==='image'&&snap.screenshotReason)view.append(el('p',{class:'browser-meta',text:snap.screenshotReason}));
   view.append(el('p',{class:'browser-page-title',text:clip(snap.title,200)}),el('p',{class:'browser-meta',text:clip(snap.url,300)}));
   const body=el('div',{class:'browser-text'});body.append(el('pre',{text:clip(snap.text,8000)}));view.append(body);
   const nodes=Array.isArray(snap.nodes)?snap.nodes.filter(n=>n&&typeof n==='object'&&n.name&&!n.secret).slice(0,60):[];
   if(nodes.length){
    const ul=el('ul',{class:'browser-nodes'});
    for(const node of nodes){
     const li=el('li',{});
     const label=clip((node.role||'')+' · '+(node.name||''),80);
     const go=el('button',{type:'button',class:'browser-node','title':clip(node.selector,200)},label);
     go.addEventListener('click',async()=>{try{await act('click',{tab:snap.tab,text:String(node.name).slice(0,2000)});status('Clicked: '+label);pollNow();}catch(e){status(e.message);}}); // the tab this frame came from, never a later active tab
     li.append(go);ul.append(li);
    }
    view.append(el('p',{class:'browser-meta',text:'Interactive elements:'}),ul);
   }
  }
 }
 function clickShot(ev,img){
  const snap=state.current;if(!snap||!snap.screenshot||!snap.metrics){status('Screenshot click needs viewport metrics; use the element list or text view.');return;}
  const rect=img.getBoundingClientRect?img.getBoundingClientRect():{left:0,top:0,width:img.width||1,height:img.height||1};
  const natW=img.naturalWidth||rect.width,natH=img.naturalHeight||rect.height,dpr=snap.metrics.dpr||1;
  const px=(ev.clientX-rect.left)*(natW/(rect.width||1)),py=(ev.clientY-rect.top)*(natH/(rect.height||1));
  const x=Math.round(px/dpr-(snap.metrics.scrollX||0)),y=Math.round(py/dpr-(snap.metrics.scrollY||0));
  act('click',{tab:snap.tab,x,y}).then(()=>{status('Clicked at ('+x+', '+y+')');pollNow();}).catch(e=>status(e.message));
 }

 // ---- polling ----
 function paused(){return !state.open||state.collapsed||document.hidden;}
 async function pollNow(){
  if(inflight||paused()||state.activeTab===null)return;
  inflight=true;lastPoll=Date.now();const mine=generation,tab=state.activeTab,view=state.view;
  try{
   const snap=await api('snapshot/'+encodeURIComponent(tab)+(view==='image'?'?shot=1':''),undefined);
   // A frame is only rendered for the tab/view it was requested for: switching tabs mid-flight discards it.
   if(mine!==generation||!state.open||tab!==state.activeTab||view!==state.view)return;
   if(snap&&typeof snap.tab==='number'&&snap.tab!==tab)return;
   renderSnapshot(snap);status('');
  }catch(error){if(mine!==generation||tab!==state.activeTab)return;if(!error.quiet)status('Live view unavailable: '+clip(error.message,200));}
  finally{inflight=false;}
 }
 function loop(){
  if(generation&&!paused()&&!inflight&&Date.now()-lastPoll>=POLL_MS&&state.activeTab!==null)void pollNow();
  pollTimer=setTimeout(loop,500);
 }
 function startLoop(){if(pollTimer)clearTimeout(pollTimer);generation++;loop();}
 function stopLoop(){if(pollTimer)clearTimeout(pollTimer);pollTimer=null;generation++;inflight=false;}

 /** Panel activation. Every await is followed by a lifecycle check so closing the panel mid-activation stops it: a late
  *  status answer never triggers a tabs fetch or starts the poll loop on a closed panel. */
 async function activate(){
  const mine=++lifecycle;
  await settled();if(mine!==lifecycle||!state.open)return;
  const denied=refusal(admission());if(denied){offState(denied.message);return;}
  status('Checking the ShadowGlass relay…');
  let st;try{st=await api('status');}catch(e){if(mine!==lifecycle||!state.open)return;offState(e.quiet?e.message:'Relay status unavailable: '+clip(e.message,200));return;}
  if(mine!==lifecycle||!state.open)return;
  if(!st.configured){offState();return;}
  if(!st.available){offState(st.reason||'ShadowGlass is not connected.');return;}
  status('');
  try{await refreshTabs();}catch(e){if(mine!==lifecycle||!state.open)return;status(e.message);}
  if(mine!==lifecycle||!state.open)return;
  startLoop();pollNow();
 }

 function openPanel(){build();state.open=true;state.collapsed=false;applyLayout();store();activate();}
 function closePanel(){lifecycle++;state.open=false;applyLayout();store();stopLoop();}
 function toggleCollapse(){state.collapsed=!state.collapsed;applyLayout();store();if(!state.collapsed&&!paused()){startLoop();pollNow();}}

 function wire(){
  els.closeBtn.addEventListener('click',closePanel);
  els.collapse.addEventListener('click',toggleCollapse);
  els.reload.addEventListener('click',()=>act('reload',{tab:state.activeTab}).then(()=>pollNow()).catch(e=>status(e.message)));
  els.back.addEventListener('click',()=>act('back',{tab:state.activeTab}).then(()=>pollNow()).catch(e=>status(e.message)));
  els.fwd.addEventListener('click',()=>act('forward',{tab:state.activeTab}).then(()=>pollNow()).catch(e=>status(e.message)));
  els.newtab.addEventListener('click',()=>navigateAddr(true));
  els.addr.addEventListener('keydown',e=>{if(e.key==='Enter'){if(e.preventDefault)e.preventDefault();navigateAddr(false);}});
  els.viewtoggle.addEventListener('click',()=>{state.view=state.view==='image'?'text':'image';els.viewtoggle.textContent=state.view==='image'?'Text view':'Image view';pollNow();});
  els.fill.addEventListener('click',()=>{const sel=els.fieldSel.value.trim(),val=els.fieldVal.value;if(!sel)return status('Enter a CSS selector to fill.');act('fill',{tab:state.activeTab,selector:sel,value:val}).then(()=>{status('Filled '+clip(sel,80));pollNow();}).catch(e=>status(e.message));});
  els.read.addEventListener('click',()=>{const sel=els.fieldSel.value.trim();if(!sel)return status('Enter a CSS selector to read.');act('read',{tab:state.activeTab,selector:sel}).then(out=>status('Read '+clip(sel,40)+': '+clip(out&&out.value,200))).catch(e=>status(e.message));});
  els.sendChat.addEventListener('click',sendToChat);
  if(els.resizer)wireResize();
 }
 function wireResize(){
  const onMove=e=>{state.width=clampWidth((Number(window.innerWidth)||1200)-(e.clientX||0));applyLayout();};
  const onUp=()=>{store();window.removeEventListener('mousemove',onMove);window.removeEventListener('mouseup',onUp);};
  els.resizer.addEventListener('mousedown',e=>{if(e.preventDefault)e.preventDefault();window.addEventListener('mousemove',onMove);window.addEventListener('mouseup',onUp);});
  els.resizer.addEventListener('keydown',e=>{if(e.key==='ArrowLeft')state.width=clampWidth(state.width+20);else if(e.key==='ArrowRight')state.width=clampWidth(state.width-20);else return;applyLayout();store();});
 }
 function navigateAddr(forceNew){
  const raw=els.addr.value.trim();if(!raw)return;
  let url=raw;if(!/^https?:\/\//i.test(url))url='https://'+url;
  if(forceNew||state.activeTab===null){act('open',{url}).then(out=>{if(out&&typeof out.id==='number')state.activeTab=out.id;return refreshTabs();}).then(()=>pollNow()).catch(e=>status(e.message));}
  else act('navigate',{tab:state.activeTab,url}).then(()=>pollNow()).catch(e=>status(e.message));
 }
 function sendToChat(){
  const snap=state.current;if(!snap)return status('Nothing to send yet.');
  const prompt=$('#prompt');if(!prompt)return;
  let selection='';try{const s=window.getSelection&&window.getSelection();if(s&&String(s).trim())selection=String(s).trim().slice(0,1000);}catch{}
  const block=clip(snap.title,200)+' — '+clip(snap.url,300)+(selection?'\n> '+selection:'');
  prompt.value=(prompt.value?prompt.value.replace(/\s*$/,'')+'\n\n':'')+block;if(prompt.focus)prompt.focus();
  status('Added page reference to the composer.');
 }

 // ---- /browse chat command + reply scanning ----
 function isBrowse(text){return typeof text==='string'&&/^\/browse(\s|$)/i.test(text.trim());}
 async function handleBrowse(text){
  const arg=text.trim().replace(/^\/browse\s*/i,'').trim();
  openPanel();
  if(admission()==='member'||admission()==='signin')return {handled:true,sent:false,detail:'The in-chat browser is the primary owner\'s only.'};
  if(!arg)return {handled:true,sent:true,detail:'Opened the in-chat browser.'};
  let url=arg;if(!/^https?:\/\//i.test(url))url='https://'+url;
  try{const out=await act('open',{url});if(out&&typeof out.id==='number')state.activeTab=out.id;await refreshTabs();pollNow();return {handled:true,sent:true,detail:'Opened '+clip(url,120)+' in the in-chat browser.'};}
  catch(error){return {handled:true,sent:false,detail:'Could not open the browser: '+clip(error&&error.message||'failed',200)};}
 }
 function wrapSends(){
  const chat=window.EchoPrimeChat;
  if(chat&&typeof chat.send==='function'){const original=chat.send.bind(chat);chat.send=text=>isBrowse(text)?handleBrowse(String(text)):original(text);}
  const ws=workspace();
  if(ws&&typeof ws.send==='function'){const original=ws.send.bind(ws);ws.send=text=>isBrowse(text)?handleBrowse(String(text)):original(text);}
 }

 /** Account change: abort the executing batch (epoch), stop polling, forget proposals, and clear EVERY account-derived
  *  DOM field (frame, address, selector/value inputs, status) so nothing of the previous account stays visible. */
 function reset(){
  accountEpoch++;generation++;lifecycle++;stopLoop();decided.clear();proposed.clear();
  state.tabs=[];state.activeTab=null;state.current=null;
  if(els.tabstrip)els.tabstrip.replaceChildren();if(els.view)els.view.replaceChildren();
  for(const k of ['addr','fieldSel','fieldVal'])if(els[k])els[k].value='';
  status('');
  if(state.open)closePanel();
 }

 restore();
 const openNav=$('#open-browser');if(openNav)openNav.addEventListener('click',()=>state.open?closePanel():openPanel());
 wrapSends();
 if(typeof MutationObserver==='function'){const host=$('#chat-log');if(host){try{new MutationObserver(()=>scan(host)).observe(host,{childList:true,subtree:true});}catch{}}}
 document.addEventListener('visibilitychange',()=>{if(state.open){if(!paused()){startLoop();pollNow();}}});
 window.addEventListener('echo-account-changed',reset);
 window.addEventListener('pagehide',stopLoop);
 window.addEventListener('resize',()=>{if(state.open){state.width=clampWidth(state.width);applyLayout();}});
 window.EchoPrimeBrowser={parseActions,admission,proposeBatch,scan,isBrowse,handleBrowse,open:openPanel,close:closePanel,isOpen(){return state.open;},paused,state};
})();
