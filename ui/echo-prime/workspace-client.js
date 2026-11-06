(() => {
 'use strict';
 const eventTypes=new Set(['status','token','tool_started','tool_result','tool_evidence','answer_grounding','memory_saved','done','error']);
 const ordinaryEventBytes=256*1024,terminalEventBytes=8*1024*1024,terminalPrefix=/^\s*\{\s*"type"\s*:\s*"done"\s*,/;
 const isTypeError=error=>Boolean(error)&&(error instanceof TypeError||error.name==='TypeError');
 const protocolError=/^(?:Conversation (?:event exceeds limit|stream exceeds limit|interrupted|receipt does not match this chat|failed\.)|Malformed conversation event\.|Contradictory events after conversation completion\.|The connection closed before Echo confirmed the reply\.|Workspace (?:did not return a conversation stream|response exceeds limit|request exceeds limit|request failed\.)|Invalid Workspace route\.|Account (?:session changed|changed\.)|Sign in to an approved account first\.|Session read interrupted\.)/;
 const tagTransport=(error,signal)=>{if(isTypeError(error)&&!signal?.aborted&&error.name!=='AbortError')try{error.transport=true;}catch{}return error;};
 async function readText(response){
  const reader=response.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
  if(!reader)throw new Error('Empty Workspace response.');
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024)throw new Error('Workspace response exceeds limit.');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return text;}
  finally{await reader.cancel().catch(()=>{});}
 }
 async function readJson(response){if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Unexpected Workspace response.');return JSON.parse(await readText(response));}
 // Every transport on the page (workspace.js and fleet.js each own one) shares one /api/session readback: concurrent
 // reads join the in-flight request, and a successful readback is reused for SESSION_MEMO_MS. clear() (identity
 // invalidation, logout, an owner-only 401/403) and a successful login forget it, so a sign-in or a revocation is seen
 // on the very next read. Before 2026-11-04 an idle owner page read /api/session about nine times a minute.
 const SESSION_MEMO_MS=10000,memo={at:-Infinity,value:null,inflight:null,generation:0};
 const forget=()=>{memo.at=-Infinity;memo.value=null;memo.generation++;};
 const clock=()=>(window.EchoPrimeWorkspaceTransport.now||Date.now)();
 function readSession(fetchImpl){
  if(memo.inflight)return memo.inflight;
  if(memo.value&&clock()-memo.at<SESSION_MEMO_MS)return Promise.resolve(memo.value);
  const started=memo.generation;
  // No caller signal reaches the shared request: an aborted joiner must not interrupt the others. The read is small and
  // bounded by the host's own timeouts. A readback that arrives after forget() is returned but not kept.
  memo.inflight=(async()=>{
   let response;try{response=await fetchImpl('/api/session',{credentials:'same-origin',cache:'no-store',headers:{'x-prime-request':'1'}});}catch(error){throw tagTransport(error);}
   const value=await readJson(response);
   if(!response.ok||typeof value.workspaceConfigured!=='boolean'||typeof value.authenticated!=='boolean')throw new Error('Account admission unavailable.');
   if(value.authenticated&&(!value.user||typeof value.user.uid!=='string'||typeof value.csrf!=='string'))throw new Error('Invalid account admission.');
   return value;
  })().then(value=>{if(memo.generation===started){memo.value=value;memo.at=clock();}return value;},error=>{forget();throw error;}).finally(()=>{memo.inflight=null;});
  return memo.inflight;
 }
 window.EchoPrimeWorkspaceTransport=class {
  static now=Date.now;// clock seam for the shared session memo (tests move it; the page uses Date.now)
  static SESSION_MEMO_MS=SESSION_MEMO_MS;
  static isTransportError(error,signal){return !signal?.aborted&&isTypeError(error)&&error.name!=='AbortError'&&error.transport!==false&&!error.incomplete&&!protocolError.test(String(error.message||''))&&!/encoded data|utf-8/i.test(String(error.message||''));}
  #logoutProof=null;
  constructor(options={}){this.fetch=options.fetch||window.fetch.bind(window);this.onIdentityChange=options.onIdentityChange||(()=>{});this.session=null;this.generation=0;this.sessionEpoch=0;this.responses=new WeakMap();}
  headers(){return {'x-prime-request':'1',...(this.session?.csrf?{'x-echo-csrf':this.session.csrf}:{})};}
  get canLogout(){return !!(this.session?.csrf||this.#logoutProof);}
  clear(){forget();this.sessionEpoch++;this.generation++;this.session=null;this.#logoutProof=null;this.onIdentityChange(null);}
  async loadSession(signal){
   const epoch=++this.sessionEpoch;
   try{
   const value=await readSession(this.fetch);
   if(epoch!==this.sessionEpoch)return this.session;
   // An interrupted caller learns nothing about the account, so the identity it already holds stays as it is.
   if(signal?.aborted)throw new Error('Session read interrupted.');
   return this.#accept(value);
   }catch(error){if(epoch===this.sessionEpoch&&!signal?.aborted&&!(signal?.recovering&&error?.transport===true)){const proof=this.#logoutProof||this.session?.csrf;this.clear();this.#logoutProof=proof;}throw error;}
  }
  #accept(value){
   const changed=(this.session?.user?.uid??null)!==(value.user?.uid??null)||!!this.session?.authenticated!==!!value.authenticated||this.session?.user?.status!==value.user?.status||!!this.session?.ownerAccess!==!!value.ownerAccess;
   this.session=value;this.#logoutProof=value.authenticated?value.csrf:null;if(changed){this.generation++;this.onIdentityChange(value);}
   return value;
  }
  // A fresh /api/session read after one refused request (a 401/403 from a Prime route). It changes the page only when the
  // readback differs (signed out, another account); a failed read changes nothing, so one refusal never signs anyone out.
  async refresh(){forget();const epoch=++this.sessionEpoch,value=await readSession(this.fetch);return epoch===this.sessionEpoch?this.#accept(value):this.session;}
  async _response(path,body,signal,auth=false){
   if(typeof path!=='string'||path.length>1200||!/^\/[a-z0-9_/?=&%.+-]+$/i.test(path)||path.includes('..'))throw new Error('Invalid Workspace route.');
   const logout=path==='/auth/logout'&&body!==undefined;
   if(logout&&!this.canLogout)throw new Error('No current account session to sign out.');
   if(!auth&&!logout){
    const previous=this.session?.user?.uid;
    const session=await this.loadSession(signal);
    if(!session?.authenticated||session.user?.status!=='approved')throw new Error('Sign in to an approved account first.');
    if(previous&&previous!==session.user.uid)throw new Error('Account changed. Review your request before sending it again.');
   }
   const text=body===undefined?undefined:JSON.stringify(body);
   if(text&&new TextEncoder().encode(text).length>2_000_000)throw new Error('Workspace request exceeds limit.');
   const headers={...this.headers(),...(body===undefined?{}:{'content-type':'application/json'}),...(auth&&body!==undefined?{'x-echo-csrf':'login'}:{}),...(logout?{'x-echo-csrf':this.#logoutProof||this.session?.csrf}:{})};
   const generation=this.generation;
   let response;
   try{response=await this.fetch('/api/workspace'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers,body:text,signal});}
   catch(error){if(logout&&generation===this.generation)this.clear();throw tagTransport(error,signal);}
   if(generation!==this.generation){await response.body?.cancel().catch(()=>{});throw new Error('Account session changed; response discarded.');}
   if(!response.ok){
    let value;try{value=await readJson(response);}finally{if(logout||response.status===401||response.status===403&&!auth)this.clear();}
    // The status rides on the error, and so does the account uid a 409 names (an invite for an email that already has an
    // account), checked as Prime's own member routes check a uid, so a view can act on a conflict without parsing text.
    const error=new Error(typeof value.error==='string'?value.error.slice(0,600):'Workspace request failed. No automatic retry was made.');error.status=response.status;
    if(typeof value.uid==='string'&&/^[A-Za-z0-9_.:@+-]{1,200}$/.test(value.uid))error.uid=value.uid;
    throw error;
   }
   this.responses.set(response,generation);return response;
  }
  async request(path,body,signal){const response=await this._response(path,body,signal),generation=this.responses.get(response);try{const value=await readJson(response);if(generation!==this.generation)throw new Error('Account session changed; response discarded.');return value;}finally{if(path==='/auth/logout'&&generation===this.generation)this.clear();}}
  async text(path,signal){const response=await this._response(path,undefined,signal),generation=this.responses.get(response);if(!response.headers.get('content-type')?.startsWith('text/plain'))throw new Error('Unexpected document response.');const value=await readText(response);if(generation!==this.generation)throw new Error('Account session changed; response discarded.');return value;}
  async audio(path,signal){
   const response=await this._response(path,undefined,signal),generation=this.responses.get(response);
   if(!response.headers.get('content-type')?.startsWith('audio/wav')||!response.body)throw new Error('Expected a governed WAV artifact.');
   const reader=response.body.getReader(),parts=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32*1024*1024)throw new Error('Audio artifact exceeds limit.');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
   if(generation!==this.generation)throw new Error('Account session changed; audio discarded.');return new Blob(parts,{type:'audio/wav'});
  }
  async auth(operation,body,signal){
   if(!['config','login','signup','reset'].includes(operation))throw new Error('Unsupported sign-in operation.');
   const response=await this._response('/auth/'+operation,body,signal,true),generation=this.responses.get(response),value=await readJson(response);
   if(signal?.aborted||generation!==this.generation)throw new Error('Account session changed; response discarded.');
   // A login receipt permits cleanup only. Private admission still requires
   // the current canonical /api/session readback.
   // The next readback must see the new account, never the memoized anonymous one.
   if(operation==='login'&&value?.user&&typeof value.user.uid==='string'&&typeof value.csrf==='string'&&/^[A-Za-z0-9_-]{8,256}$/.test(value.csrf)){this.#logoutProof=value.csrf;forget();}
   return value;
  }
  async chat(input,onEvent,signal){
   const response=await this._response('/chat',input,signal),generation=this.responses.get(response);
   if(!response.headers.get('content-type')?.startsWith('application/x-ndjson')||!response.body)throw new Error('Workspace did not return a conversation stream.');
   const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',bytes=0,result=null;
   const accept=line=>{
    if(!line.trim())return;
    if(signal?.aborted||generation!==this.generation)throw new Error('Conversation interrupted.');
    const lineBytes=new TextEncoder().encode(line).length;
    if(lineBytes>terminalEventBytes)throw new Error('Conversation event exceeds limit.');
    const event=JSON.parse(line);
    if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')throw new Error('Malformed conversation event.');
    if(lineBytes>ordinaryEventBytes&&event.type!=='done')throw new Error('Conversation event exceeds limit.');
    if(event.type==='keepalive')return;
    if(result)throw new Error('Contradictory events after conversation completion.');
    if(!eventTypes.has(event.type))return;
    if(event.type==='error')throw new Error(typeof event.error==='string'?event.error.slice(0,600):'Conversation failed. Saved messages may remain.');
    if(event.type==='done'){
     if(!event.chat||event.chat.id!==input.chat_id||!Array.isArray(event.chat.messages)||event.chat.messages.length>20000)throw new Error('Conversation receipt does not match this chat.');
     result=event.chat;
    }
    onEvent(event);
   };
   try{
    for(;;){
     let chunk;try{chunk=await reader.read();}catch(error){throw tagTransport(error,signal);}
     const {done,value}=chunk;if(done)break;
     bytes+=value.byteLength;if(bytes>32*1024*1024)throw new Error('Conversation stream exceeds limit.');
     pending+=decoder.decode(value,{stream:true});let index;
     while((index=pending.indexOf('\n'))>=0){accept(pending.slice(0,index));pending=pending.slice(index+1);}
     if(pending.length>(terminalPrefix.test(pending.slice(0,128))?terminalEventBytes:ordinaryEventBytes))throw new Error('Conversation event exceeds limit.');
    }
    pending+=decoder.decode();if(pending.trim())accept(pending);
    if(signal?.aborted||generation!==this.generation)throw new Error('Account session changed or conversation interrupted.');
    if(!result){const incomplete=new Error('The connection closed before Echo confirmed the reply.');incomplete.incomplete=true;throw incomplete;}
    return result;
   }catch(error){if(error&&typeof error==='object'&&error.transport!==true)try{error.transport=false;}catch{}throw error;}finally{await reader.cancel().catch(()=>{});}
  }
 };
})();
