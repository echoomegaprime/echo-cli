(() => {
 'use strict';
 // Remove the one-use provider response before any other request or script.
 const query=new URLSearchParams(location.search),state=query.get('state'),code=query.get('code'),denied=query.has('error');
 history.replaceState(null,'',location.pathname);
 const status=document.getElementById('oauth-status');
 async function complete(){
  if(denied){status.textContent='Authorization was declined. Return to the bot’s Apps tab to connect when ready.';return;}
  if(!state||!code||query.getAll('state').length!==1||query.getAll('code').length!==1||state.length>512||code.length>4096){status.textContent='The provider response is missing or invalid. Start a new connection from the bot’s Apps tab.';return;}
  try{
   const sessionResponse=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',headers:{'x-prime-request':'1'}}),session=await sessionResponse.json();
   if(!sessionResponse.ok||(session.workspaceConfigured&&(!session.authenticated||!session.ownerAccess)))throw new Error('Sign in as the owner in Echo Prime, then start a new connection.');
   const response=await fetch('/api/prime/bots/workspace/connection.callback',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-prime-request':'1',...(session.csrf?{'x-echo-csrf':session.csrf}:{})},body:JSON.stringify({state,code})});
   if(!response.ok)throw new Error('The connection could not be completed. Refresh the bot’s Apps tab to inspect it before starting again.');
   const result=await response.json();if(result.status!=='connected')throw new Error('The provider did not confirm a connected app.');
   status.textContent='App connected to its selected bot. Return to Echo Prime and refresh the bot’s Apps tab.';
  }catch(error){status.textContent=error.message||'The connection could not be verified.';}
 }
 void complete();
})();
