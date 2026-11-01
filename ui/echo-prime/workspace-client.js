(() => {
 'use strict';
 const eventTypes=new Set(['status','token','tool_started','tool_result','tool_evidence','answer_grounding','memory_saved','done','error']);
 const ordinaryEventBytes=256*1024,terminalEventBytes=8*1024*1024,terminalPrefix=/^\s*\{\s*"type"\s*:\s*"done"\s*,/;
 async function readText(response){
  const reader=response.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
  if(!reader)throw new Error('Empty Workspace response.');
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024)throw new Error('Workspace response exceeds limit.');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return text;}
  finally{await reader.cancel().catch(()=>{});}
 }
 async function readJson(response){if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Unexpected Workspace response.');return JSON.parse(await readText(response));}
 window.EchoPrimeWorkspaceTransport=class {
  #logoutProof=null;
  constructor(options={}){this.fetch=options.fetch||window.fetch.bind(window);this.onIdentityChange=options.onIdentityChange||(()=>{});this.session=null;this.generation=0;this.sessionEpoch=0;this.responses=new WeakMap();}
  headers(){return {'x-prime-request':'1',...(this.session?.csrf?{'x-echo-csrf':this.session.csrf}:{})};}
  get canLogout(){return !!(this.session?.csrf||this.#logoutProof);}
  clear(){this.sessionEpoch++;this.generation++;this.session=null;this.#logoutProof=null;this.onIdentityChange(null);}
  async loadSession(signal){
   const epoch=++this.sessionEpoch;
   try{
   const response=await this.fetch('/api/session',{credentials:'same-origin',cache:'no-store',headers:{'x-prime-request':'1'},signal});
   const value=await readJson(response);
   if(!response.ok||typeof value.workspaceConfigured!=='boolean'||typeof value.authenticated!=='boolean')throw new Error('Account admission unavailable.');
   if(value.authenticated&&(!value.user||typeof value.user.uid!=='string'||typeof value.csrf!=='string'))throw new Error('Invalid account admission.');
   if(epoch!==this.sessionEpoch)return this.session;
   const changed=(this.session?.user?.uid??null)!==(value.user?.uid??null)||!!this.session?.authenticated!==!!value.authenticated||this.session?.user?.status!==value.user?.status||!!this.session?.ownerAccess!==!!value.ownerAccess;
   this.session=value;this.#logoutProof=value.authenticated?value.csrf:null;if(changed){this.generation++;this.onIdentityChange(value);}
   return value;
   }catch(error){if(epoch===this.sessionEpoch){const proof=this.#logoutProof||this.session?.csrf;this.clear();this.#logoutProof=proof;}throw error;}
  }
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
   catch(error){if(logout&&generation===this.generation)this.clear();throw error;}
   if(generation!==this.generation){await response.body?.cancel().catch(()=>{});throw new Error('Account session changed; response discarded.');}
   if(!response.ok){
    let value;try{value=await readJson(response);}finally{if(logout||response.status===401||response.status===403&&!auth)this.clear();}
    throw new Error(typeof value.error==='string'?value.error.slice(0,600):'Workspace request failed. No automatic retry was made.');
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
   if(operation==='login'&&value?.user&&typeof value.user.uid==='string'&&typeof value.csrf==='string'&&/^[A-Za-z0-9_-]{8,256}$/.test(value.csrf))this.#logoutProof=value.csrf;
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
     const {done,value}=await reader.read();if(done)break;
     bytes+=value.byteLength;if(bytes>32*1024*1024)throw new Error('Conversation stream exceeds limit.');
     pending+=decoder.decode(value,{stream:true});let index;
     while((index=pending.indexOf('\n'))>=0){accept(pending.slice(0,index));pending=pending.slice(index+1);}
     if(pending.length>(terminalPrefix.test(pending.slice(0,128))?terminalEventBytes:ordinaryEventBytes))throw new Error('Conversation event exceeds limit.');
    }
    pending+=decoder.decode();if(pending.trim())accept(pending);
    if(signal?.aborted||generation!==this.generation)throw new Error('Account session changed or conversation interrupted.');
    if(!result)throw new Error('Conversation ended without completion. No automatic retry was made.');
    return result;
   }finally{await reader.cancel().catch(()=>{});}
  }
 };
})();
