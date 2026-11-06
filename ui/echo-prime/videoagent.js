(() => {
 'use strict';
 const $=s=>document.querySelector(s),dialog=$('#agents-dialog');
 if(!dialog)return;
 const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},arr=v=>Array.isArray(v)?v:[];
 const str=v=>v===undefined||v===null?'':String(v),message=e=>e?.message||String(e);
 const clip=v=>{const s=JSON.stringify(v);return s?.length>3000?s.slice(0,3000)+'…':s;};
 const mappedKind=(kind,mapping)=>Object.hasOwn(mapping,kind)?mapping[kind]:'reference';
 const uploadKind=kind=>mappedKind(kind,{image:'image',video:'clip',audio:'audio',document:'script'});
 const artifactKind=kind=>mappedKind(kind,{image:'image',video:'clip',voice:'audio',music:'audio',sound:'audio',document:'script',code:'script',chat:'script'});
 const validId=id=>typeof id==='string'&&/^(upl|art)_[0-9a-f]{32}$/.test(id);
 const cleanInputs=inputs=>arr(inputs).map(i=>({id:i.id,kind:['image','clip','audio','script','reference'].includes(i.kind)?i.kind:'reference'}));
 // These builders intentionally send only identifiers, never Library bytes or URLs.
 function requestBody(value){return {brief:value.brief.trim(),prompts:arr(value.prompts).map(p=>p.trim()),inputs:cleanInputs(value.inputs),style:value.style||'',aspect:value.aspect||'16:9',...(value.name?.trim()?{name:value.name.trim()}:{}),...(value.duration_s!==''&&value.duration_s!==undefined?{duration_s:Number(value.duration_s)}:{})};}
 function storyboardBody(value){return {brief:value.brief.trim(),style:value.style||'',aspect:value.aspect||'16:9',inputs:cleanInputs(value.inputs),...(value.name?.trim()?{name:value.name.trim()}:{}),shots:arr(value.shots).map(s=>({prompt:s.prompt.trim(),duration_s:Number(s.duration_s),camera:s.camera||'',motion:s.motion||'',voiceover:s.voiceover||'',inputs:arr(s.inputs).filter(id=>arr(value.inputs).some(i=>i.id===id))}))};}
 function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=str(text);if(cls)e.className=cls;return e;}
 function button(text,fn,cls='quiet-button'){const b=el('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
 function field(parent,label,tag,id,attrs={}){const wrap=el('label',undefined,'video-field'),node=el(tag);node.id=id;Object.assign(node,attrs);wrap.append(el('span',label),node);parent.append(wrap);return node;}
 function admission(){const ws=window.EchoPrimeWorkspace;if(!ws||ws.enabled!==true)return 'open';const session=ws.session;if(!session||session.authenticated!==true)return 'signin';return session.ownerAccess===true?'owner':'member';}
 const denied=()=>admission()==='signin'?'Sign in to build video agents.':admission()==='member'?'Video agents are available to the primary owner only.':'';
 let generation=0,statusVersion=0,tab='list',plan=null,agentName=null,run=null,busy=false,dirty=false,rows=[],inputs=[],cards=[],pickerVersion=0;
 const controllers=new Set();
 function debug(event,outcome,detail={}){console.debug('[echo.video]',{event,outcome,...detail});}
 async function api(path,body){
  const mine=generation,controller=new AbortController();controllers.add(controller);
  try{
   if(denied())throw new Error(denied());
   const owner=admission()==='owner';let headers={};
   try{headers=await window.EchoPrimeWorkspace?.ownerHeaders?.()||{};}catch{}
   if(mine!==generation||controller.signal.aborted)throw new Error('Request cancelled');
   if(denied())throw new Error(denied());
   const response=await fetch('/api/prime/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-prime-request':'1',...headers,...(body!==undefined?{'content-type':'application/json'}:{})},signal:controller.signal,...(body!==undefined?{body:JSON.stringify(body)}:{})});
   let data;try{data=await response.json();}catch{}
   if(mine!==generation)throw new Error('Request cancelled');
   if(!response.ok){
    if((response.status===401||response.status===403)&&owner)window.EchoPrimeWorkspace?.invalidate?.();
    throw new Error(typeof data?.error==='string'?data.error:'Echo request failed (HTTP '+response.status+')');
   }
   if(!data||typeof data!=='object')throw new Error('Echo returned an unrecognized response');
   debug(path,'returned',{status:response.status});return data;
  }catch(error){debug(path,mine!==generation||controller.signal.aborted?'cancelled':'failed');throw error;}
  finally{controllers.delete(controller);}
 }
 const tabs=el('div',undefined,'video-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Agent views');
 const listTab=button('Agents',()=>selectTab('list')),videoTab=button('Video agent',()=>selectTab('video'));
 listTab.id='video-agents-list-tab';videoTab.id='video-agents-tab';
 for(const b of [listTab,videoTab])b.setAttribute('role','tab');videoTab.setAttribute('aria-controls','video-agent-panel');tabs.append(listTab,videoTab);
 const title=dialog.querySelector('.dialog-title');if(title)title.after(tabs);else dialog.append(tabs);
 const panel=el('section',undefined,'video-panel');panel.id='video-agent-panel';panel.hidden=true;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',videoTab.id);
 const notes=dialog.querySelectorAll('.connection-note'),note=notes[notes.length-1];if(note&&note.parentNode===dialog)dialog.insertBefore(panel,note);else dialog.append(panel);
 const status=el('p','Video agents have not been checked.','video-status');status.id='video-status';status.setAttribute('role','status');
 const notice=el('p',undefined,'video-status');notice.id='video-notice';notice.setAttribute('role','status');
 const refresh=button('Refresh',()=>loadStatus());
 const form=el('div',undefined,'video-form'),brief=field(form,'Brief','textarea','video-brief',{maxLength:4000,required:true,rows:3});
 const details=el('div',undefined,'video-grid');form.append(details);
 const name=field(details,'Name (optional)','input','video-name',{maxLength:40});details.append(el('small','Agent is named video-<name>','video-help'));
 const style=field(details,'Style','input','video-style',{maxLength:80}),aspect=field(details,'Aspect','select','video-aspect');
 for(const value of ['16:9','9:16','1:1','4:3','3:4']){const option=el('option',value);option.value=value;aspect.append(option);}aspect.value='16:9';
 const duration=field(details,'Total duration (s, optional)','input','video-duration',{type:'number',min:'2',max:'600',step:'1'});
 const prompts=el('ol',undefined,'video-prompts');prompts.id='video-prompts';
 const addPrompt=button('Add prompt',()=>{if(rows.length<18){rows.push(promptRow());renderRows();edited();}});
 const chips=el('div',undefined,'video-chips'),picker=el('div',undefined,'video-picker');chips.id='video-inputs';picker.hidden=true;
 const choose=button('Choose inputs',()=>togglePicker());choose.setAttribute('aria-expanded','false');
 const planButton=button('Plan storyboard',()=>submitPlan(false),'new-chat');planButton.id='video-plan';
 form.append(el('h3','Scenes / shots'),prompts,addPrompt,el('h3','Inputs'),chips,choose,picker,planButton);
 const board=el('section',undefined,'video-storyboard');board.id='video-storyboard';board.hidden=true;
 const runView=el('section',undefined,'video-run adk-run');runView.id='video-run';runView.hidden=true;
 panel.append(refresh,status,form,notice,board,runView);
 let createButton=null,replanButton=null,runButton=null,dirtyLine=null;
 function edited(){dirty=!!plan;if(dirtyLine&&dirty)dirtyLine.textContent='Edited - re-plan to recompute capabilities and budget';if(agentName){agentName=null;syncControls();}}
 for(const node of [brief,name,style,aspect,duration])node.addEventListener('input',edited);
 aspect.addEventListener('change',edited);
 function promptRow(value=''){const row=el('li',undefined,'video-prompt-row'),label=el('label'),caption=el('span'),prompt=el('textarea');prompt.maxLength=2000;prompt.value=value;label.append(caption,prompt);
  const move=delta=>{const index=rows.indexOf(record),next=index+delta;if(next<0||next>=rows.length)return;[rows[index],rows[next]]=[rows[next],rows[index]];renderRows();edited();};
  const up=button('Up',()=>move(-1)),down=button('Down',()=>move(1)),remove=button('Remove',()=>{if(rows.length===1)return;rows.splice(rows.indexOf(record),1);renderRows();edited();});
  const actions=el('div',undefined,'video-actions');actions.append(up,down,remove);row.append(label,actions);prompt.addEventListener('input',edited);
  const record={row,caption,prompt,up,down,remove};return record;
 }
 function renderRows(){rows.forEach((r,i)=>{r.caption.textContent='Shot '+(i+1);r.prompt.setAttribute('aria-label','Shot '+(i+1));});prompts.replaceChildren(...rows.map(r=>r.row));syncControls();}
 function syncControls(){
  const locked=busy||!!denied();
  for(const node of [...form.querySelectorAll('input,textarea,select,button'),...board.querySelectorAll('input,textarea,select,button')])node.disabled=locked;
  rows.forEach((r,i)=>{r.up.disabled=locked||i===0;r.down.disabled=locked||i===rows.length-1;r.remove.disabled=locked||rows.length===1;});
  addPrompt.disabled=locked||rows.length>=18;
  if(createButton)createButton.disabled=locked||plan?.ready!==true||plan?.catalog?.live!==true;
  if(runButton)runButton.disabled=locked||!agentName||!!(run&&!run.done);
 }
 function addInput(entry){if(!validId(entry.id)||inputs.some(i=>i.id===entry.id)||inputs.length>=64)return;const meta=window.EchoPrimeLibrary?.uploadById?.(entry.id)||arr(window.EchoPrimeArtifacts?.list?.()).find(i=>i.id===entry.id);inputs.push({id:entry.id,kind:cleanInputs([entry])[0].kind,name:entry.name||meta?.name||meta?.title||entry.id});renderChips();edited();}
 function renderChips(){chips.replaceChildren(...inputs.map(i=>{const chip=el('span',undefined,'video-chip'),remove=button('×',()=>{inputs=inputs.filter(x=>x.id!==i.id);renderChips();edited();});remove.setAttribute('aria-label','Remove '+i.name);chip.append(el('span',i.name+' · '+i.kind),remove);return chip;}));}
 async function togglePicker(){
  if(denied())return;picker.hidden=!picker.hidden;choose.setAttribute('aria-expanded',String(!picker.hidden));const version=++pickerVersion,mine=generation;if(picker.hidden)return;
  picker.replaceChildren(el('p','Loading inputs…'));
  let failure='';try{await window.EchoPrimeLibrary?.refresh?.();}catch(error){failure='Library unavailable: '+message(error);}
  if(mine!==generation||version!==pickerVersion||picker.hidden)return;
  const uploads=arr(window.EchoPrimeLibrary?.uploads?.()),artifacts=arr(window.EchoPrimeArtifacts?.list?.()).filter(a=>a.kind==='image'||a.kind==='video');
  picker.replaceChildren();if(failure)picker.append(el('p',failure));
  if(!uploads.length&&!artifacts.length)picker.append(el('p','No uploads yet. Open Library & Artifacts to upload images, clips or audio.'));
  for(const [items,mapping] of [[uploads,uploadKind],[artifacts,artifactKind]])for(const item of items){const b=button((item.name||item.title||item.id)+' · '+item.kind,()=>addInput({id:item.id,name:item.name||item.title,kind:mapping(item.kind)}));b.setAttribute('data-input-id',item.id);picker.append(b);}
 }
 async function loadStatus(){
  const mine=generation,version=++statusVersion;syncControls();if(denied()){status.textContent=denied();return;}
  status.textContent='Checking video agents…';
  try{await Promise.resolve(window.EchoPrimeWorkspace?.ready).catch(()=>{});if(mine!==generation||version!==statusVersion)return;
   const value=await api('video/status');if(mine!==generation||version!==statusVersion)return;
   status.textContent=value.configured?'Video agents are configured. Live catalog: '+(value.catalog?'available':'unavailable')+' · Echo ADK: '+(value.adk?'available':'unavailable')+' · Uploads: '+(value.uploads?'available':'unavailable'):value.reason||'Video agents cannot be created. Planning is still available.';
  }catch(error){if(mine===generation&&version===statusVersion)status.textContent=message(error);}finally{if(mine===generation)syncControls();}
 }
 function selectTab(value){const opening=value==='video'&&tab!=='video';tab=value;dialog.dataset.agentsTab=tab;panel.hidden=tab!=='video';listTab.setAttribute('aria-selected',String(tab==='list'));videoTab.setAttribute('aria-selected',String(tab==='video'));listTab.tabIndex=tab==='list'?0:-1;videoTab.tabIndex=tab==='video'?0:-1;if(opening){resumeRun();return loadStatus();}}
 tabs.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'list':event.key==='End'?'video':tab==='list'?'video':'list';selectTab(next);(next==='list'?listTab:videoTab).focus();}});
 function base(){return {brief:brief.value,style:style.value,aspect:aspect.value,name:name.value,inputs};}
 function currentStoryboard(){return storyboardBody({...base(),shots:cards.map(c=>({prompt:c.prompt.value,duration_s:c.duration.value,camera:c.camera.value,motion:c.motion.value,voiceover:c.voiceover.value,inputs:c.checks.filter(x=>x.box.checked).map(x=>x.id)}))});}
 function validate(body,storyboard){
  if(!body.brief||body.brief.length>4000)return 'Enter a brief of 1 to 4000 characters.';
  const shots=storyboard?body.shots:body.prompts;
  if(!shots.length||shots.length>18)return 'Use 1 to 18 prompt rows.';
  if(shots.some(s=>!(storyboard?s.prompt:s).trim()||(storyboard?s.prompt:s).length>2000))return 'Every prompt must contain 1 to 2000 characters.';
  if(body.name?.length>40||body.style.length>80)return 'Name must be at most 40 characters and style at most 80.';
  if(!['16:9','9:16','1:1','4:3','3:4'].includes(body.aspect))return 'Choose a supported aspect.';
  if(!storyboard&&body.duration_s!==undefined&&(!Number.isInteger(body.duration_s)||body.duration_s<2||body.duration_s>600))return 'Total duration must be an integer from 2 to 600 seconds.';
  if(storyboard&&shots.some(s=>!Number.isInteger(s.duration_s)||s.duration_s<2||s.duration_s>15||s.camera.length>80||s.motion.length>80||s.voiceover.length>800))return 'Shot duration must be an integer from 2 to 15 seconds; camera and motion at most 80 characters; voice-over at most 800.';
  return '';
 }
 async function mutate(action){if(busy)return;const mine=generation;if(denied()){notice.textContent=denied();return;}busy=true;syncControls();try{await action(mine);}catch(error){if(mine===generation)notice.textContent=message(error);}finally{if(mine===generation){busy=false;syncControls();}}}
 function submitPlan(storyboard){const body=storyboard?currentStoryboard():requestBody({...base(),prompts:rows.map(r=>r.prompt.value),duration_s:duration.value});const reason=validate(body,storyboard);if(reason){notice.textContent=reason;return;}return mutate(async mine=>{const value=await api('video/plan',body);if(mine!==generation)return;agentName=null;applyPlan(value.plan);notice.textContent='Storyboard planned.';});}
 function budgetText(b){return typeof b?.max_calls==='number'&&typeof b?.max_cost_usd==='number'&&typeof b?.max_wall_s==='number'?'up to '+b.max_calls+' calls, $'+b.max_cost_usd.toFixed(2)+', '+Math.round(b.max_wall_s/60)+' min'+(b.clamped?' (clamped to the service caps)':''):'budget not reported';}
 function generationText(shot){const g=obj(shot.generation),ids=arr(shot.inputs),kind=g.mode==='clip'?'clip':'image',id=ids.find(id=>inputs.some(i=>i.id===id&&i.kind===kind))||ids[0]||'input';if(g.mode==='clip')return 'use clip '+id+' as-is';if(!g.capability)return 'no capability: '+(g.mode||'generation not reported');return g.mode==='image_to_video'?'animate '+id+' via '+g.capability:'text to video via '+g.capability;}
 function applyPlan(value){
  plan=obj(value);dirty=false;cards=[];board.hidden=false;board.replaceChildren();
  // The server's input list is authoritative, including names and source metadata.
  inputs=arr(plan.inputs).map(i=>({id:i.id,kind:i.kind,name:i.name||i.id}));renderChips();
  const summary=[plan.name,arr(plan.shots).length+' shots',plan.duration_s!==undefined?plan.duration_s+' s':'',plan.resolution?str(plan.resolution.width)+' × '+str(plan.resolution.height):'',plan.max_steps!==undefined?plan.max_steps+' max steps':'',typeof plan.estimate?.status_checks==='number'&&plan.estimate.status_checks>0?plan.estimate.status_checks+' job status checks':'',budgetText(plan.budget),plan.lane?[plan.lane.node,plan.lane.model].filter(Boolean).join(' · '):''].filter(Boolean).join(' · ');
  board.append(el('h3','Storyboard'),el('p',summary,'video-summary'),el('p',plan.catalog?.live?'Live catalog: '+arr(plan.catalog.ids).length+' capabilities verified':'Live catalog unavailable: '+(plan.catalog?.reason||'reason not reported')));
  const caps=el('ul',undefined,'video-capabilities');for(const cap of arr(plan.capabilities))caps.append(el('li',cap));board.append(el('h4','Capabilities'),caps);
  const narration=obj(plan.narration);board.append(el('p',narration.capability?'Narration: '+narration.capability+' (voice freeman), '+(narration.lines??0)+' lines':narration.lines>0?'Narration: no narration capability in the live catalog':'Narration: none'));
  if(plan.stitch?.note)board.append(el('p',plan.stitch.note));
  const warnings=el('ul',undefined,'video-warnings');for(const warning of [...arr(plan.warnings),...arr(plan.catalog?.warnings)])warnings.append(el('li',warning));board.append(warnings);
  if(!plan.ready){const missing=el('div',undefined,'video-not-ready'),list=el('ul');missing.append(el('strong','Not ready'));for(const item of arr(plan.missing))list.append(el('li',item));missing.append(list);board.append(missing);}
  for(const [i,shot] of arr(plan.shots).entries()){
   const card=el('article',undefined,'video-shot');card.append(el('h4','Shot '+(i+1)));
   const prompt=field(card,'Prompt','textarea','video-shot-'+i+'-prompt',{value:shot.prompt||'',maxLength:2000,rows:3});
   const grid=el('div',undefined,'video-grid');card.append(grid);
   const seconds=field(grid,'Duration (s)','input','video-shot-'+i+'-duration',{type:'number',value:str(shot.duration_s),min:'2',max:'15',step:'1'}),camera=field(grid,'Camera','input','video-shot-'+i+'-camera',{value:shot.camera||'',maxLength:80}),motion=field(grid,'Motion','input','video-shot-'+i+'-motion',{value:shot.motion||'',maxLength:80});
   const voiceover=field(card,'Voice-over','textarea','video-shot-'+i+'-voiceover',{value:shot.voiceover||'',maxLength:800,placeholder:'Optional voice-over line for this shot (freeman voice)'});
   const checks=[],checklist=el('fieldset',undefined,'video-shot-inputs');checklist.append(el('legend','Inputs'));
   for(const input of inputs){const label=el('label'),box=el('input');box.type='checkbox';box.checked=arr(shot.inputs).includes(input.id);label.append(box,el('span',input.name+' · '+input.kind));checklist.append(label);checks.push({id:input.id,box});box.addEventListener('change',edited);}
   card.append(checklist,el('p',generationText(shot),'video-generation'));for(const node of [prompt,seconds,camera,motion,voiceover])node.addEventListener('input',edited);
   cards.push({prompt,duration:seconds,camera,motion,voiceover,checks});board.append(card);
  }
  dirtyLine=el('p',undefined,'video-dirty');board.append(dirtyLine);
  replanButton=button('Re-plan',()=>submitPlan(true));createButton=button('Create agent',()=>createAgent(),'new-chat');createButton.id='video-create';runButton=button('Run video agent',()=>startRun(),'new-chat');runButton.id='video-start-run';
  const actions=el('div',undefined,'video-actions');actions.append(replanButton,createButton,runButton);board.append(actions);syncControls();
 }
 function createAgent(){if(plan?.ready!==true||plan?.catalog?.live!==true)return;const body=currentStoryboard(),reason=validate(body,true);if(reason){notice.textContent=reason;return;}return mutate(async mine=>{const result=await api('video/agent',body);if(mine!==generation)return;applyPlan(result.plan);agentName=result.agent.name;notice.textContent=result.existing?agentName+' already existed for this storyboard; nothing new was created':'Created '+agentName;});}
 function stopPolling(){if(run?.timer)clearTimeout(run.timer);if(run)run.timer=null;}
 function schedule(r){stopPolling();if(run===r&&!r.done&&!r.lost&&!document.hidden)r.timer=setTimeout(()=>poll(r),3000);}
 // Closing the Agents dialog only pauses the watch (the ADK run keeps going on the service); opening the Video tab or showing the page
 // again resumes it for the current generation, like agents.js.
 function resumeRun(){if(!run||run.done||run.lost||document.hidden||!dialog.open)return;run.epoch=generation;if(run.note&&!run.stopRequested)run.note.textContent='';if(!run.inflight)void poll(run);}
 function startRun(){if(!agentName||run&&!run.done)return;const b=obj(plan.budget),body={agent:agentName,budget:{max_calls:b.max_calls,max_cost_usd:b.max_cost_usd,max_wall_s:b.max_wall_s}},snapshot=JSON.parse(JSON.stringify(plan));return mutate(async mine=>{const result=await api('video/run',body);if(mine!==generation)return;stopPolling();run={id:result.runId,agent:body.agent,plan:snapshot,epoch:mine,done:false,failures:0,timer:null,inflight:false,saved:false,stopRequested:false};renderRun(run,{status:result.status,steps:[],spent:{}});void poll(run);});}
 function finalText(steps){for(let i=steps.length-1;i>=0;i--)if(steps[i]?.kind==='final'&&typeof steps[i].data?.text==='string')return steps[i].data.text;return '';}
 function renderRun(r,data){
  const steps=arr(data.steps),proof=obj(data.proof),spent=obj(data.spent);runView.hidden=false;runView.replaceChildren(el('h3','Run '+r.id),el('p','Status: '+(data.status||'unknown')),el('p','Spent '+(spent.calls??0)+' calls, $'+(spent.cost_usd??0)+', '+(spent.wall_s??0)+' s'));
  r.note=el('p',r.stopRequested?'Stop requested; a provider call already running is not interrupted.':'','video-status');runView.append(r.note);
  if(!data.done){r.stopButton=button('Stop after this step',()=>requestStop(r));r.stopButton.disabled=r.stopRequested||r.stopping;runView.append(r.stopButton);}
  const list=el('ol',undefined,'video-steps');for(const [i,s] of steps.entries()){const row=el('li',undefined,'adk-step');row.append(el('p','#'+(s.step??i+1)+' '+str(s.kind)+' '+str(s.capability)+(s.tier!==undefined?' tier '+s.tier:'')+' '+str(s.verdict)+' '+(s.duration_ms??'?')+' ms'));
   if(s.kind==='model'){const a=obj(s.data?.answered);row.append(el('p',a.model&&a.reported!==false?'answered by '+a.model+(a.provider?' · '+a.provider:''):'model not reported'));}
   if(s.kind==='final')row.append(el('p',s.data?.text||'','adk-final'));
   if(s.verdict==='gated')row.append(el('p','Gated: needs '+(Array.isArray(s.needs)?s.needs.join(', '):str(s.needs)||'not reported')+'. How: '+(str(s.how)||'not reported'),'adk-gated'));list.append(row);
  }runView.append(list);
  const error=obj(data.error);if(error.code==='unavailable')runView.append(el('p','Provider '+(error.provider||'(not named)')+' is unavailable. No fallback provider was used.','adk-stopbox'));else if(error.code==='budget_exceeded')runView.append(el('p','Budget stop: the run stopped at its budget.'+(error.message?' '+error.message:''),'adk-stopbox'));else if(error.message)runView.append(el('p',error.message,'adk-stopbox'));
  if(proof.verdict)runView.append(el('p','Proof: '+proof.verdict,'adk-proof'));
  if(data.done){const final=el('section',undefined,'video-final');final.append(el('h3','Final artifact'),el('p',finalText(steps)||'The run finished without a final text.','adk-final'));for(const artifact of arr(proof.artifacts))final.append(el('pre',clip(artifact)));final.append(el('p','Receipts: '+arr(proof.receipts).length));r.saveNote=el('p',r.saveMessage||'Saving to the Artifact Center…');final.append(r.saveNote);runView.append(final);void saveArtifact(r,data);}
 }
 async function saveArtifact(r,data){
  if(r.saved)return;r.saved=true;const proof=obj(data.proof),p=r.plan;
  try{if(typeof window.EchoPrimeArtifacts?.register!=='function'){r.saveMessage='Artifact Center is not loaded';return;}
   await window.EchoPrimeArtifacts.register({title:'Video · '+r.agent+' · '+r.id.slice(0,8),kind:'video',content:{run_id:r.id,agent:r.agent,status:data.status,final_text:finalText(arr(data.steps)),artifacts:arr(proof.artifacts),receipts:arr(proof.receipts).length,plan_sha256:p.origin?.prompt_sha256,shots:arr(p.shots).map(s=>({id:s.id,prompt:s.prompt,duration_s:s.duration_s}))},provenance:{source:'adk',agent:r.agent,run_id:r.id,prompt:(p.brief||'').slice(0,2000),...(proof.verdict?{verdict:proof.verdict}:{}),...(proof.events_sha256?{events_sha256:proof.events_sha256}:{})}});
   r.saveMessage='Saved to the Artifact Center';
  }catch(error){r.saveMessage='Not saved to the Artifact Center: '+message(error);}finally{if(run===r&&r.epoch===generation&&r.saveNote)r.saveNote.textContent=r.saveMessage;}
 }
 async function poll(r){
  if(run!==r||r.done||r.lost||r.inflight||document.hidden)return;r.inflight=true;
  try{const data=await api('adk/runs/'+encodeURIComponent(r.id));if(run!==r||r.epoch!==generation)return;r.failures=0;r.done=data.done===true;renderRun(r,data);syncControls();}
  catch(error){if(run!==r||r.epoch!==generation||error?.name==='AbortError'||message(error)==='Request cancelled')return;r.failures++;r.lost=r.failures>=5;r.note.textContent=r.lost?'Lost contact with Echo ADK; the run may still be running':'Status check failed ('+r.failures+'/5): '+message(error);}
  finally{r.inflight=false;if(run===r&&r.epoch===generation)schedule(r);}
 }
 async function requestStop(r){if(run!==r||r.done||r.stopRequested||r.stopping)return;r.stopping=true;if(r.stopButton)r.stopButton.disabled=true;
  try{await api('adk/runs/'+encodeURIComponent(r.id)+'/stop',{});if(run!==r||r.epoch!==generation)return;r.stopRequested=true;r.note.textContent='Stop requested; a provider call already running is not interrupted.';}
  catch(error){if(run===r&&r.epoch===generation)r.note.textContent=message(error);}finally{r.stopping=false;if(run===r&&r.epoch===generation&&r.stopButton)r.stopButton.disabled=r.stopRequested||r.done;}
 }
 function unsaved(){return !!(brief.value.trim()||name.value.trim()||style.value.trim()||duration.value||aspect.value!=='16:9'||rows.length>1||rows.some(r=>r.prompt.value.trim())||inputs.length||plan);}
 async function open(prefill={}){
  if(!dialog.open){const opened=window.EchoPrimeAgents?.open?.();if(opened?.catch)opened.catch(()=>{});if(!dialog.open)dialog.showModal();}
  const existing=unsaved();if(!existing&&prefill.brief){brief.value=prefill.brief.slice(0,4000);rows[0].prompt.value=prefill.brief.slice(0,2000);}else if(!brief.value.trim()&&prefill.brief){brief.value=prefill.brief.slice(0,4000);edited();}
  for(const input of arr(prefill.inputs))addInput(input);return selectTab('video');
 }
 function studioEntry(){
  const studio=window.EchoPrimeStudio,creative=$('#creative-dialog'),category=$('#creative-category'),actions=creative?.querySelector('.creative-actions');if(!studio||!actions||!category)return;
  const entry=button('Make a video agent',async()=>{const text=$('#creative-prompt')?.value.trim()||'',chosen=arr(studio.inputs?.()).map(i=>({id:i.upload_id,kind:i.role==='audio'?'audio':i.role==='script'?'script':uploadKind(window.EchoPrimeLibrary?.uploadById?.(i.upload_id)?.kind)}));if(creative.open)creative.close();const pending=open({brief:text,inputs:chosen});notice.textContent='Prefilled from the Creative Studio';await pending;});entry.setAttribute('data-action','make-video-agent');
  const sync=()=>{entry.hidden=category.value!=='video';};category.addEventListener('change',sync);const original=studio.open;studio.open=function(...args){const result=original.apply(this,args);sync();return result;};actions.append(entry);sync();
 }
 function cancelRequests(){generation++;statusVersion++;pickerVersion++;for(const controller of controllers)controller.abort();controllers.clear();stopPolling();}
 window.addEventListener('echo-account-changed',()=>{cancelRequests();run=null;plan=null;agentName=null;dirty=false;busy=false;inputs=[];cards=[];rows=[promptRow()];brief.value='';name.value='';style.value='';duration.value='';aspect.value='16:9';picker.hidden=true;picker.replaceChildren();choose.setAttribute('aria-expanded','false');board.replaceChildren();board.hidden=true;runView.replaceChildren();runView.hidden=true;notice.textContent='';status.textContent='Video agents have not been checked.';createButton=null;runButton=null;replanButton=null;dirtyLine=null;renderChips();renderRows();selectTab('list');});
 dialog.addEventListener('close',()=>{cancelRequests();busy=false;selectTab('list');syncControls();});
 document.addEventListener('visibilitychange',()=>{if(!run)return;if(document.hidden)stopPolling();else resumeRun();});
 window.addEventListener('pagehide',cancelRequests);
 rows=[promptRow()];renderRows();selectTab('list');studioEntry();
 window.EchoPrimeVideoAgent={open,state:()=>({tab,rows:rows.length,inputs:inputs.length,plan:!!plan,agent:agentName,runId:run?.id||null}),core:{uploadKind,artifactKind,storyboardBody,requestBody}};
})();
