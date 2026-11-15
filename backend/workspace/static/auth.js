'use strict';
(async () => {
  const form = document.querySelector('#auth-form');
  if (!form) {
    const r = await fetch('/api/auth/session'); if (!r.ok) return;
    const s = await r.json(); if (!s.authenticated) return;
    const header = document.querySelector('header');
    const link = document.createElement('a'); link.href='/login?manage=1'; link.className='quiet'; link.textContent='Account'; header?.append(link);
    if(s.user.role !== 'owner'){
      document.querySelectorAll('[data-view="sdk"],[data-view="vault"]').forEach(x=>x.hidden=true);
    }
    return;
  }
  const $ = id => document.getElementById(id);
  let mode='login', session=null, busy=false;
  const say = text => { $('auth-status').textContent=text; };
  async function request(path, body, csrf='login') {
    const response=await fetch('/api/auth/'+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Echo-CSRF':csrf},body:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed.');return data;
  }
  async function guarded(fn) { if(busy)return;busy=true;$('submit').disabled=true;try{await fn();}catch(e){say(e.message);}finally{busy=false;$('submit').disabled=false;} }
  async function renderSession() {
    session=await request('session');
    if(!session.authenticated)return;
    $('login-content').hidden=true;$('account-content').hidden=false;
    $('account-heading').textContent=session.user.role==='owner'?'Workspace accounts':'Your private Workspace';
    const approved=session.user.status==='approved';
    $('account-status').textContent=approved?'Signed in as '+session.user.email:session.user.status==='pending'?'Your account is waiting for the owner’s approval. Your workspace stays private.':'This account does not currently have Workspace access.';
    $('open-workspace').hidden=!approved;
    if(approved && !new URLSearchParams(location.search).has('manage')){location.replace('/');return;}
    if(session.user.role==='owner'){
      const data=await request('accounts');$('approvals').replaceChildren();
      for(const user of data.accounts){
        const row=document.createElement('article'), label=document.createElement('div');
        label.textContent=user.email+' · '+user.status;row.append(label);
        const query=new URLSearchParams(location.search);
        if(query.get('review')===user.tenant){const note=document.createElement('p');note.textContent='Telegram request: confirm '+(query.get('decision')==='deny'?'deny':'approve')+' for this account below.';row.append(note);}
        for(const [decision,title] of [['approve','Approve'],['deny','Deny']]){
          const button=document.createElement('button');button.textContent=title;
          button.addEventListener('click',()=>guarded(async()=>{await request('decide',{uid:user.uid,decision},session.csrf);say('Account '+(decision==='approve'?'approved.':'denied.'));await renderSession();}));
          row.append(button);
        }
        $('approvals').append(row);
      }
    }
  }
  form.addEventListener('submit',event=>{event.preventDefault();guarded(async()=>{
    const body={email:$('identifier').value.trim(),password:$('password').value};
    if(mode==='signup')body.display_name=$('display-name').value.trim();
    try{
      const data=await request(mode,body);
      if(mode==='signup'){say(data.message);setMode('login');}
      else await renderSession();
    }finally{$('password').value='';}
  });});
  function setMode(next){mode=next;$('name-field').hidden=mode!=='signup';$('password').autocomplete=mode==='signup'?'new-password':'current-password';$('submit').textContent=mode==='signup'?'Create account':'Sign in';$('switch-mode').textContent=mode==='signup'?'Back to sign in':'Create an account';}
  $('switch-mode').addEventListener('click',()=>setMode(mode==='login'?'signup':'login'));
  $('reset-password').addEventListener('click',()=>guarded(async()=>{const email=$('identifier').value.trim();if(!email.includes('@'))throw new Error('Enter your email address first.');say((await request('reset',{email})).message);}));
  $('sign-out').addEventListener('click',()=>guarded(async()=>{await request('logout',{},session.csrf);location.replace('/login');}));
  await guarded(renderSession);
  if(!session?.authenticated){
    try{
      const config=await request('config');
      if(config.google_login_enabled && config.google_client_id){
        const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
        script.onload=()=>{google.accounts.id.initialize({client_id:config.google_client_id,auto_select:false,callback:result=>guarded(async()=>{await request('login',{provider:'google',id_token:result.credential});await renderSession();})});google.accounts.id.renderButton($('google-button'),{theme:'filled_black',size:'large',width:300});};
        script.onerror=()=>console.info('[echo.auth]',{event:'provider_script_unavailable',provider:'google'});document.head.append(script);
      }
    }catch(e){console.info('[echo.auth]',{event:'provider_config_unavailable'});}
  }
})();
