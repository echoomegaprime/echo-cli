(() => {
  'use strict';
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const storageKey='echo-prime-interface-v1';
  let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}');}catch{}
  if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
  let drafts=Array.isArray(saved.drafts)?saved.drafts.filter(d=>d&&typeof d.id==='string'&&typeof d.text==='string'&&d.text.length<=12000).slice(0,20):[];
  let palette=['prism','emerald','aurora'].includes(saved.palette)?saved.palette:'prism';
  let quality=['adaptive','high','quiet'].includes(saved.quality)?saved.quality:'adaptive';
  let mode='Chat',toastTimer,activeDraft=null;
  const orb=window.EchoPrimeOrb.mount($('#echo-orb'),{
    onFallback(){ $('#echo-orb').hidden=true;$('#orb-fallback').hidden=false; },
    onMotionChange(value){$('#motion-toggle').setAttribute('aria-checked',String(value));},
  });
  orb.setPalette(palette);orb.setQuality(quality);if(saved.motion===false)orb.setMotion(false);
  $('#motion-toggle').setAttribute('aria-checked',String(orb.motion!==false));
  $('#quality').value=quality;
  function persist(){try{localStorage.setItem(storageKey,JSON.stringify({drafts,palette,quality,motion:orb.motion}));return true;}catch{return false;}}
  function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4200);}
  const narrow=matchMedia('(max-width:800px)');
  function menu(open){const shown=narrow.matches&&open;$('#sidebar').classList.toggle('open',shown);$('#sidebar').inert=narrow.matches&&!shown;$('main').inert=shown;$('#scrim').classList.toggle('visible',shown);$('#menu').setAttribute('aria-expanded',String(shown));}
  narrow.addEventListener('change',()=>menu(false));menu(false);
  function openPanel(name){menu(false);const dialog=name==='appearance'?$('#appearance-dialog'):$('#systems-dialog');if(!dialog.open)dialog.showModal();}
  function newChat(){activeDraft=null;$('#prompt').value='';$('#conversation-title').textContent='New conversation';$('#draft-notice').hidden=true;menu(false);$('#prompt').focus();}
  function renderHistory(){const target=$('#history');target.replaceChildren();if(!drafts.length){const p=document.createElement('p');p.textContent='A little space for your next big idea.';target.append(p);return;}for(const draft of drafts){const b=document.createElement('button');b.className='history-item';b.textContent=draft.text.slice(0,70);b.title=draft.text.slice(0,120);b.addEventListener('click',()=>{activeDraft=draft.id;$('#prompt').value=draft.text;$('#conversation-title').textContent=draft.text.slice(0,38);$('#draft-notice').hidden=true;menu(false);$('#prompt').focus();});target.append(b);}}
  const systems=[
    ['FORGE','Local intelligence','i-chip','Awaiting connection'],
    ['MEMORY','Personal continuity','i-memory','Access required'],
    ['ECF','Certification Forge','i-shield','Access required'],
    ['SWARM','Shared orchestration','i-spark','Awaiting connection'],
    ['CREATIVE','Images, audio and voice','i-spark','Awaiting connection'],
    ['AGENTS','Bounded task execution','i-code','Awaiting connection'],
  ];
  for(const [name,description,icon,status] of systems){const row=document.createElement('div');row.className='system-row';row.dataset.system=name;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+icon);svg.append(use);const copy=document.createElement('div'),title=document.createElement('strong'),small=document.createElement('small'),state=document.createElement('span');title.textContent=name;small.textContent=description;copy.append(title,small);state.className='system-state';state.textContent=status;row.append(svg,copy,state);$('#systems-list').append(row);}
  function paletteUI(){$$('[data-palette]').forEach(b=>{const selected=b.dataset.palette===palette;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});}
  $$('[data-palette]').forEach(b=>b.addEventListener('click',()=>{palette=b.dataset.palette;orb.setPalette(palette);paletteUI();persist();}));
  $('#motion-toggle').addEventListener('click',()=>{const next=$('#motion-toggle').getAttribute('aria-checked')!=='true';orb.setMotion(next);$('#motion-toggle').setAttribute('aria-checked',String(next));persist();});
  $('#quality').addEventListener('change',e=>{quality=e.target.value;orb.setQuality(quality);persist();});
  $$('[data-open]').forEach(b=>b.addEventListener('click',()=>openPanel(b.dataset.open)));
  $$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
  $$('[data-system]').filter(b=>b.tagName==='BUTTON').forEach(b=>b.addEventListener('click',()=>openPanel('systems')));
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.view==='studio')openPanel('appearance');else if(b.dataset.view==='systems')openPanel('systems');else{menu(false);$('#prompt').focus();}}));
  $('#menu').addEventListener('click',()=>menu(!$('#sidebar').classList.contains('open')));
  $('#scrim').addEventListener('click',()=>menu(false));
  $('#new-chat').addEventListener('click',newChat);
  $('.brand').addEventListener('click',e=>{e.preventDefault();newChat();});
  $('#clear-history').addEventListener('click',()=>{if(!drafts.length){toast('No saved drafts to clear.');return;}if(confirm('Clear the drafts saved by this interface on this device?')){drafts=[];persist();renderHistory();newChat();}});
  $$('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('#prompt').value=b.dataset.prompt;$('#prompt').focus();}));
  const placeholders={Chat:'Message Echo Prime…',Image:'Describe what you imagine…',Music:'Describe the music you hear…','Sound FX':'Describe the sound you need…',Voice:'What would you like Echo to say?'};
  $$('.mode-tabs button').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;$$('.mode-tabs button').forEach(t=>{const selected=t===b;t.classList.toggle('selected',selected);t.setAttribute('aria-selected',String(selected));});$('#prompt').placeholder=placeholders[mode];$('#prompt').focus();}));
  $('#voice-button').addEventListener('click',()=>{openPanel('systems');toast('Connect the ECHO host to enable voice.');});
  $('#composer').addEventListener('submit',e=>{e.preventDefault();const text=$('#prompt').value.trim();if(!text){$('#prompt').focus();return;}const id=activeDraft||(crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join(''));drafts=[{id,text,mode,createdAt:new Date().toISOString()},...drafts.filter(d=>d.id!==id)].slice(0,20);activeDraft=id;const stored=persist();renderHistory();$('#conversation-title').textContent=text.slice(0,38);$('#draft-notice').textContent=stored?'Draft saved on this device. Connect the authorized ECHO host to send it.':'The host is not connected, and browser storage is unavailable. Your draft remains in the composer.';$('#draft-notice').hidden=false;toast(stored?'Draft saved. Connect ECHO to send it.':'Draft remains in the composer.');});
  $('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();newChat();}if(e.key==='Escape'&&$('#sidebar').classList.contains('open')){menu(false);$('#menu').focus();}});
  if(!navigator.userAgent.includes('Mac'))$('kbd').textContent='Ctrl K';
  window.addEventListener('pagehide',event=>{if(!event.persisted)orb.destroy();});
  paletteUI();renderHistory();
})();
