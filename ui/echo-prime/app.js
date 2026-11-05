(() => {
  'use strict';
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const storageKey='echo-prime-interface-v1';
  let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}');}catch{}
  if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
  let palette=['prism','emerald','aurora'].includes(saved.palette)?saved.palette:'prism';
  let quality=['adaptive','high','quiet'].includes(saved.quality)?saved.quality:'adaptive';
  let mode='Chat',toastTimer,generation=0;
  // The document root carries the same palette/motion signal as the orb wordmark so the sidebar wordmark, the Echo
  // mark and the sign-in card (nav.css) follow the active palette without each module asking the orb.
  const root=document.documentElement;
  const orb=window.EchoPrimeOrb.mount($('#echo-orb'),{
    onFallback(){ $('#echo-orb').hidden=true;$('#orb-fallback').hidden=false; },
    onMotionChange(value){motionUI(value);},
  });
  orb.setPalette(palette);orb.setQuality(quality);if(saved.motion===false)orb.setMotion(false);
  motionUI(orb.motion!==false);
  $('#quality').value=quality;
  // Persist appearance only. Legacy unscoped drafts are deliberately erased on
  // startup before admission or history rendering can expose another account.
  function persist(){try{localStorage.setItem(storageKey,JSON.stringify({palette,quality,motion:orb.motion}));return true;}catch{return false;}}
  persist();saved={};
  function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4200);}
  const narrow=matchMedia('(max-width:800px)');
  function menu(open){const shown=narrow.matches&&open;$('#sidebar').classList.toggle('open',shown);$('#sidebar').inert=narrow.matches&&!shown;$('main').inert=shown;$('#scrim').classList.toggle('visible',shown);$('#menu').setAttribute('aria-expanded',String(shown));}
  narrow.addEventListener('change',()=>menu(false));menu(false);
  function openPanel(name){menu(false);const dialog=name==='appearance'?$('#appearance-dialog'):$('#systems-dialog');if(!dialog.open)dialog.showModal();}
  async function newChat(){
    generation++;await window.EchoPrimeWorkspace?.ready;menu(false);
    try{if(await window.EchoPrimeWorkspace?.newChat())return;}catch{toast('Conversation could not be created. No automatic retry was made.');return;}
    window.EchoPrimeChat.reset();$('#prompt').value='';$('#conversation-title').textContent='New conversation';$('#draft-notice').hidden=true;$('#prompt').focus();
  }
  window.addEventListener('echo-account-changed',()=>{generation++;clearTimeout(toastTimer);$('#toast').textContent='';$('#toast').classList.remove('visible');$('#prompt').value='';$('#draft-notice').textContent='';$('#draft-notice').hidden=true;$('#history').replaceChildren();menu(false);});
  const systems=[
    ['FORGE','Local intelligence','i-chip','Awaiting connection'],
    ['CONTINUITY','Continuity Fabric memory','i-memory','Access required'],
    ['CRYSTAL','Crystal Memory','i-memory','Awaiting connection'],
    ['ESH','Echo Shell','i-code','Awaiting connection'],
    ['CERTFORGE','Certification Forge','i-shield','Access required'],
    ['SWARM','Shared orchestration','i-spark','Awaiting connection'],
    ['CREATIVE','Images, audio and voice','i-spark','Awaiting connection'],
    ['AGENTS','Bounded task execution','i-code','Awaiting connection'],
    ['NEXUS','Fleet control plane','i-chip','Awaiting connection'],
    ['SHADOWGLASS','Browser automation','i-code','Awaiting connection'],
    ['PERSONALITY','Persona and voice','i-spark','Awaiting connection'],
    ['MUSIC FORGE','Production and arrangement','i-spark','Awaiting connection'],
  ];
  for(const [name,description,icon,status] of systems){const row=document.createElement('div');row.className='system-row';row.dataset.system=name;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+icon);svg.append(use);const copy=document.createElement('div'),title=document.createElement('strong'),small=document.createElement('small'),state=document.createElement('span');title.textContent=name;small.textContent=description;copy.append(title,small);state.className='system-state';state.textContent=status;row.append(svg,copy,state);$('#systems-list').append(row);}
  function motionUI(value){$('#motion-toggle').setAttribute('aria-checked',String(value));$('.orb-wordmark').dataset.motion=value?'running':'paused';if(root?.dataset)root.dataset.motion=value?'running':'paused';}
  function paletteUI(){$('.orb-wordmark').dataset.palette=palette;if(root?.dataset)root.dataset.palette=palette;$$('button[data-palette]').forEach(b=>{const selected=b.dataset.palette===palette;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});}
  $$('button[data-palette]').forEach(b=>b.addEventListener('click',()=>{palette=b.dataset.palette;orb.setPalette(palette);paletteUI();persist();}));
  $('#motion-toggle').addEventListener('click',()=>{const next=$('#motion-toggle').getAttribute('aria-checked')!=='true';orb.setMotion(next);motionUI(next);persist();});
  $('#quality').addEventListener('change',e=>{quality=e.target.value;orb.setQuality(quality);persist();});
  $$('[data-open]').forEach(b=>b.addEventListener('click',()=>openPanel(b.dataset.open)));
  $$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
  $$('[data-system]').filter(b=>b.tagName==='BUTTON').forEach(b=>b.addEventListener('click',()=>b.dataset.system==='CREATIVE'?window.EchoPrimeStudio?.open('all'):openPanel('systems')));
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.view==='studio'){menu(false);window.EchoPrimeStudio?.open('all');}else if(b.dataset.view==='systems')openPanel('systems');else{menu(false);$('#prompt').focus();}}));
  $('#menu').addEventListener('click',()=>menu(!$('#sidebar').classList.contains('open')));
  $('#scrim').addEventListener('click',()=>menu(false));
  $('#new-chat').addEventListener('click',newChat);
  $('.brand').addEventListener('click',e=>{e.preventDefault();newChat();});
  $('#clear-history').hidden=true;
  $$('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('#prompt').value=b.dataset.prompt;$('#prompt').focus();}));
  const placeholders={Chat:'Message Echo Prime…',Image:'Describe what you imagine…',Video:'Describe the scene and motion…',Music:'Describe the music you hear…','Sound FX':'Describe the sound you need…',Voice:'What would you like Echo to say?'};
  $$('.mode-tabs button').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;$$('.mode-tabs button').forEach(t=>{const selected=t===b;t.classList.toggle('selected',selected);t.setAttribute('aria-selected',String(selected));});$('#prompt').placeholder=placeholders[mode];$('#prompt').focus();}));
  $('#voice-button').addEventListener('click',async()=>{await window.EchoPrimeWorkspace?.ready;if(window.EchoPrimeWorkspace?.enabled)return;openPanel('systems');toast('Connect the ECHO host to enable voice.');});
  $('#composer').addEventListener('submit',async e=>{
    e.preventDefault();const current=generation,text=$('#prompt').value.trim();
    await window.EchoPrimeWorkspace?.ready;if(current!==generation)return;
    if(mode!=='Chat'){window.EchoPrimeStudio?.open(({Image:'image',Video:'video',Music:'music','Sound FX':'sound',Voice:'voice'})[mode],text);return;}
    if(!text){$('#prompt').focus();return;}
    let result;
    try{result=await window.EchoPrimeWorkspace?.send(text);if(!result?.handled)result=await window.EchoPrimeChat.send(text);}
    catch{result={sent:false,detail:'Connection unavailable. No automatic retry was made.'};}
    if(current!==generation||result.cancelled)return;
    $('#draft-notice').textContent=result.detail;$('#draft-notice').hidden=false;if(result.sent&&$('#prompt').value.trim()===text)$('#prompt').value='';toast(result.sent?'Answer received.':result.detail);
  });
  $('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();newChat();}if(e.key==='Escape'&&$('#sidebar').classList.contains('open')){menu(false);$('#menu').focus();}});
  if(!navigator.userAgent.includes('Mac'))$('kbd').textContent='Ctrl K';
  window.addEventListener('pagehide',event=>{if(!event.persisted)orb.destroy();});
  paletteUI();
})();
