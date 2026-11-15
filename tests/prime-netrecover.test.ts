/* eslint-disable @typescript-eslint/no-explicit-any -- UI VM harness and upstream HTTP test doubles */
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {Node,walk,world} from './fixtures/prime-fake-dom.js';

const ownerSession={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'csrf-owner',user:{uid:'owner',role:'owner',status:'approved',name:'Commander'}};
const jsonResponse=(obj:unknown,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}});

function droppingStream(linesBeforeDrop:string[],dropError:()=>unknown){
 let step=0;
 return new Response(new ReadableStream({
  pull(controller){
   if(step<linesBeforeDrop.length){
    controller.enqueue(new TextEncoder().encode(linesBeforeDrop[step++]+'\n'));
    return;
   }
   throw dropError();
  }
 }),{status:200,headers:{'content-type':'application/x-ndjson'}});
}

function completeStream(lines:string[]){
 return new Response(new ReadableStream({
  start(controller){
   for(const line of lines)controller.enqueue(new TextEncoder().encode(line+'\n'));
   controller.close();
  }
 }),{status:200,headers:{'content-type':'application/x-ndjson'}});
}

class FakeAudio {
 paused=false;currentTime=0;src:string;
 private handlers:Record<string,(()=>void)[]>={};
 static instances:FakeAudio[]=[];
 constructor(src=''){this.src=src;FakeAudio.instances.push(this);}
 addEventListener(name:string,fn:()=>void){(this.handlers[name]??=[]).push(fn);}
 removeEventListener(name:string,fn:()=>void){this.handlers[name]=(this.handlers[name]||[]).filter(x=>x!==fn);}
 play(){this.paused=false;for(const fn of this.handlers.playing||[])fn();return Promise.resolve();}
 pause(){this.paused=true;}
 finish(){this.paused=true;for(const fn of this.handlers.ended||[])fn();}
}

interface TurnHarnessOptions {
 initialMessages?:any[];
 voiceConfigured?:boolean;
 loadSpeech?:boolean;
 onChatPost?:(body:{chat_id:string;content:string;request_id:string;attachments:string[]},attempt:number)=>Response|Promise<Response>;
 onChatRead?:(reqId:string|null,pollIndex:number)=>any;
 onSession?:(callIndex:number)=>Response|Promise<Response>;
}

function createTurnHarness(opts:TurnHarnessOptions){
 let lastReqId:string|null=null,chatPosts=0,chatReads=0,sessionReads=0;
 const chatBodies:Array<{chat_id:string;content:string;request_id:string;attachments:string[]}>=[];
 const orbEvents:any[]=[];
 const docListeners:Record<string,((e:any)=>unknown)[]>={};

 const fetchMock=vi.fn(async(url:string,init:any={})=>{
  const path=String(url);
  if(path==='/api/session'){
   sessionReads++;
   if(opts.onSession)return opts.onSession(sessionReads);
   return jsonResponse(ownerSession);
  }
  if(path==='/api/workspace/state'){
   return jsonResponse({
    chats:[{id:'c1',title:'Mission chat'}],
    projects:[],library:[],preferences:[],personalities:[],
    voice:opts.voiceConfigured?{configured:true,provider:'elevenlabs',voice:'Echo Prime'}:{configured:false}
   });
  }
  if(path==='/api/workspace/chats'&&init.method==='POST'){
   return jsonResponse({id:'c1',title:'Mission chat',messages:opts.initialMessages?[...opts.initialMessages]:[],project_id:null});
  }
  if(path==='/api/workspace/chat'&&init.method==='POST'){
   const parsed=JSON.parse(String(init.body));
   lastReqId=parsed.request_id;
   chatBodies.push(parsed);
   chatPosts++;
   if(opts.onChatPost)return opts.onChatPost(parsed,chatPosts);
   return completeStream([]);
  }
  if(path==='/api/workspace/chats/c1'&&(!init.method||init.method==='GET')){
   chatReads++;
   const data=opts.onChatRead?await opts.onChatRead(lastReqId,chatReads):{id:'c1',title:'Mission chat',messages:[]};
   return jsonResponse(data);
  }
  if(path==='/api/workspace/voice/start'&&init.method==='POST'){
   return jsonResponse({audio_url:'/api/voice/audio/chunk0',has_more:false,session_id:'vs-1',chunk_index:0,voice:'Echo Prime',provider:'elevenlabs'});
  }
  if(path==='/api/workspace/voice/audio/chunk0'){
   return new Response(new Uint8Array([82,73,70,70,0,0,0,0]),{status:200,headers:{'content-type':'audio/wav'}});
  }
  if(path==='/api/workspace/voice/cancel'){
   return jsonResponse({stopped:true});
  }
  return jsonResponse({});
 });

 const files=['activity.js','workspace-client.js','workspace.js',...(opts.loadSpeech?['speech.js']:[])];
 const w=world(files,{
  body:(body,register)=>{
   const composer=new Node('form');composer.attributes.id='composer';
   const sendBtn=new Node('button');sendBtn.className='send';composer.append(sendBtn);
   const extras=new Node('div');extras.attributes.id='composer-extras';
   body.append(composer,extras);
   register('#composer',composer);
   register('#composer .send',sendBtn);
   register('#composer-extras',extras);
  },
  window:{
   fetch:fetchMock,
   EchoPrimeChat:{reset:vi.fn(),send:vi.fn()},
   EchoPrimeModels:null
  },
  globals:{
   fetch:fetchMock,
   Date,
   CustomEvent,
   Response,
   ReadableStream,
   Uint8Array,
   Float32Array,
   ArrayBuffer,
   DataView,
   Audio:FakeAudio as any,
   URL:{createObjectURL:()=>'blob:echo-voice',revokeObjectURL:()=>{}},
   matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
   performance:{now:()=>Date.now()},
   setInterval:(fn:()=>void,ms?:number)=>globalThis.setInterval(fn,ms),
   clearInterval:(id:any)=>globalThis.clearInterval(id),
   setTimeout:(fn:()=>void,ms?:number)=>globalThis.setTimeout(fn,ms),
   clearTimeout:(id:any)=>globalThis.clearTimeout(id)
  }
 });

 // Replace document event plumbing so removeEventListener and dispatchEvent work alongside visibilitychange and echo-orb-state tests.
 w.document.addEventListener=(name:string,fn:(e:any)=>unknown)=>{(docListeners[name]??=[]).push(fn);};
 w.document.removeEventListener=(name:string,fn:(e:any)=>unknown)=>{docListeners[name]=(docListeners[name]||[]).filter(x=>x!==fn);};
 w.document.dispatchEvent=(event:any)=>{for(const fn of [...(docListeners[event.type]||[])])fn(event);return true;};
 const fireVisibility=()=>{w.document.dispatchEvent(new Event('visibilitychange'));w.emitDocument('visibilitychange');};

 w.document.addEventListener('echo-orb-state',(e:any)=>orbEvents.push(e.detail));
 w.get('#workspace-chat-kind').value='workspace';

 return {
  w,
  fetchMock,
  orbEvents,
  fireVisibility,
  chatBodies:()=>chatBodies,
  chatPosts:()=>chatPosts,
  chatReads:()=>chatReads,
  lastReqId:()=>lastReqId,
  chatLogText:()=>walk(w.get('#chat-log')).map(n=>n._text).join(' ').replace(/\s+/g,' ').trim(),
  strip:()=>w.get('#chat-activity').children.find(c=>c.className==='activity-strip')
 };
}

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{
 FakeAudio.instances=[];
 vi.useRealTimers();
 for(const close of cleanup.splice(0).reverse())await close();
});

describe('Echo Prime chat stream transport recovery and keepalives',()=>{
 it.each([
  ['Chrome','network error'],
  ['Safari','Load failed'],
  ['Firefox','NetworkError when attempting to fetch resource.']
 ])('recovers a %s reader.read() TypeError (%s), polls every 3s, renders as done, and speaks the reply',async(_browser,rawBrowserMessage)=>{
  vi.useFakeTimers();
  FakeAudio.instances=[];
  const h=createTurnHarness({
   voiceConfigured:true,
   loadSpeech:true,
   onChatPost:()=>droppingStream(
    [JSON.stringify({type:'status',text:'Echo is thinking…'}),JSON.stringify({type:'token',text:'Partial '})],
    ()=>new TypeError(rawBrowserMessage)
   ),
   onChatRead:(reqId,pollIndex)=>{
    if(pollIndex<3){
     // User message saved, assistant still generating during polls 1 (0s) and 2 (3s)
     return {id:'c1',title:'Mission chat',messages:[{id:'u-1',role:'user',content:'Status report',request_id:reqId}]};
    }
    // Saved on poll 3 (6s) with the exact same request_id as the user message (production shape)
    return {
     id:'c1',
     title:'Mission chat',
     messages:[
      {id:'u-1',role:'user',content:'Status report',request_id:reqId},
      {id:'a-1',role:'assistant',content:'All fleet nodes are nominal and verified.',request_id:reqId}
     ]
    };
   }
  });

  const ws=h.w.window.EchoPrimeWorkspace;
  await ws.ready;
  // Wait for speech.js startup IIFE to bind echo-reply-saved
  await vi.advanceTimersByTimeAsync(0);

  const turnPromise=ws.send('Status report');
  await vi.advanceTimersByTimeAsync(0);

  // Poll 1 happened immediately on drop; inline status is shown with NO raw browser error text
  expect(h.chatReads()).toBe(1);
  expect(h.chatLogText()).toContain("Connection dropped. Checking for Echo's reply...");
  expect(h.chatLogText()).not.toContain(rawBrowserMessage);
  expect(h.strip()?.dataset.state).toBe('running');
  expect(walk(h.strip()!).map(n=>n._text).join(' ')).toContain("Connection dropped. Checking for Echo's reply...");

  // After 3 seconds -> poll 2 (still pending)
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.chatReads()).toBe(2);
  expect(h.chatLogText()).toContain("Connection dropped. Checking for Echo's reply...");

  // After another 3 seconds (6s total) -> poll 3 finds the saved reply!
  await vi.advanceTimersByTimeAsync(3000);
  const outcome=await turnPromise;

  expect(outcome).toMatchObject({handled:true,sent:true,verified:true});
  expect(h.chatReads()).toBe(3);
  expect(h.chatLogText()).toContain('All fleet nodes are nominal and verified.');
  expect(h.chatLogText()).not.toContain("Connection dropped. Checking for Echo's reply...");
  expect(h.chatLogText()).not.toContain(rawBrowserMessage);
  expect(h.strip()?.dataset.state).toBe('done');

  // Spoken reply & orb state triggered just like a normal `done`
  await vi.advanceTimersByTimeAsync(50);
  expect(FakeAudio.instances.length).toBe(1);
  expect(h.orbEvents.some(e=>e?.mode==='speaking')).toBe(true);
  FakeAudio.instances[0].finish();
  await vi.advanceTimersByTimeAsync(10);
  expect(h.orbEvents.at(-1)).toMatchObject({mode:'idle',source:'speech'});
 });

 it('matches by position (first assistant message after this turn user message) when request_id is absent or mismatched, even with repeated prompts and expired session memo',async()=>{
  vi.useFakeTimers({now:1_000_000});
  const priorHistory=[
   {id:'u-old',role:'user',content:'Ping'},
   {id:'a-old',role:'assistant',content:'Old reply from previous turn'}
  ];
  let networkDown=false;
  const h=createTurnHarness({
   initialMessages:priorHistory,
   onSession:()=>{
    if(networkDown)throw new TypeError('network error');
    return jsonResponse(ownerSession);
   },
   onChatPost:async()=>{
    return droppingStream([JSON.stringify({type:'status',text:'Working…'})],()=>{
     // Simulate clock having passed SESSION_MEMO_MS (10s) when the connection drops
     vi.setSystemTime(Date.now()+15_000);
     networkDown=true;
     return new TypeError('network error');
    });
   },
   onChatRead:(_reqId,pollIndex)=>{
    if(networkDown)throw new TypeError('network error');
    if(pollIndex===1){
     // User message saved WITHOUT request_id; new assistant reply not saved yet. Must NOT match a-old!
     return {id:'c1',title:'Mission chat',messages:[...priorHistory,{id:'u-new',role:'user',content:'Ping'}]};
    }
    return {
     id:'c1',
     title:'Mission chat',
     messages:[
      ...priorHistory,
      {id:'u-new',role:'user',content:'Ping',request_id:'backend-other-id'},
      {id:'a-new',role:'assistant',content:'Fresh reply for second Ping',request_id:'backend-reply-id'},
      {id:'a-trailing',role:'assistant',content:'Later assistant note'}
     ]
    };
   }
  });

  const ws=h.w.window.EchoPrimeWorkspace;
  await ws.ready;
  await ws.newChat();

  const turnPromise=ws.send('Ping');
  await vi.advanceTimersByTimeAsync(0);

  // Poll at t=0 failed with transient offline TypeError on /api/session WITHOUT clearing the user's session!
  expect(ws.session).toMatchObject({authenticated:true});
  expect(h.chatReads()).toBe(0);
  expect(h.chatLogText()).toContain("Connection dropped. Checking for Echo's reply...");

  // Network recovers; next 3s tick checks chat: sees only u-new (ignores a-old!), then next 3s tick sees a-new!
  networkDown=false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.chatReads()).toBe(1);
  expect(h.chatLogText()).not.toContain('Fresh reply for second Ping');

  await vi.advanceTimersByTimeAsync(3000);
  const outcome=await turnPromise;
  expect(outcome).toMatchObject({handled:true,sent:true,verified:true});
  expect(h.chatLogText()).toContain('Fresh reply for second Ping');
 });

 it('times out after 180s (every 3s) and renders Retry, which re-sends the exact same prompt',async()=>{
  vi.useFakeTimers();
  let retried=false;
  const h=createTurnHarness({
   onChatPost:(body,attempt)=>{
    if(attempt===1)return Promise.reject(new TypeError('Failed to fetch'));
    retried=true;
    return completeStream([
     JSON.stringify({type:'token',text:'Recovered on explicit retry.'}),
     JSON.stringify({
      type:'done',
      chat:{
       id:'c1',
       title:'Mission chat',
       messages:[
        {id:'u-2',role:'user',content:body.content,request_id:body.request_id},
        {id:'a-2',role:'assistant',content:'Recovered on explicit retry.',request_id:body.request_id}
       ]
      }
     })
    ]);
   },
   onChatRead:(reqId)=>retried?{
    id:'c1',
    title:'Mission chat',
    messages:[
     {id:'u-2',role:'user',content:'Generate deployment checklist',request_id:reqId},
     {id:'a-2',role:'assistant',content:'Recovered on explicit retry.',request_id:reqId}
    ]
   }:{
    id:'c1',
    title:'Mission chat',
    messages:[{id:'u-1',role:'user',content:'Generate deployment checklist',request_id:reqId}]
   }
  });

  const ws=h.w.window.EchoPrimeWorkspace;
  await ws.ready;
  h.w.get('#prompt').value='Generate deployment checklist';

  const firstTurn=ws.send('Generate deployment checklist');
  await vi.advanceTimersByTimeAsync(0);
  expect(h.chatLogText()).toContain("Connection dropped. Checking for Echo's reply...");
  expect(h.chatLogText()).not.toContain('Failed to fetch');

  // At 177s (59 intervals -> 60 reads: 0s..177s), still polling
  await vi.advanceTimersByTimeAsync(177_000);
  expect(h.chatReads()).toBe(60);
  expect(h.chatLogText()).toContain("Connection dropped. Checking for Echo's reply...");

  // At 180s (60th 3s interval -> 61st read), recovery times out
  await vi.advanceTimersByTimeAsync(3_000);
  const timedOut=await firstTurn;

  expect(h.chatReads()).toBe(61);
  expect(timedOut).toEqual({
   handled:true,
   sent:false,
   verified:false,
   detail:"Echo's reply did not arrive. Your message was saved."
  });
  expect(h.chatLogText()).toContain("Echo's reply did not arrive. Your message was saved.");
  expect(h.chatLogText()).not.toContain('Failed to fetch');
  expect(h.strip()?.dataset.state).toBe('failed');

  const retryButton=walk(h.w.get('#chat-log')).find(n=>n.tagName==='BUTTON'&&n.textContent==='Retry');
  expect(retryButton).toBeDefined();

  // Clicking Retry re-sends the exact same prompt
  await retryButton!.click();
  await vi.advanceTimersByTimeAsync(0);

  expect(h.chatPosts()).toBe(2);
  expect(h.chatBodies()[1].content).toBe('Generate deployment checklist');
  expect(h.chatBodies()[1].request_id).not.toBe(h.chatBodies()[0].request_id);
  expect(h.chatLogText()).toContain('Recovered on explicit retry.');
  expect(h.chatLogText()).not.toContain("Echo's reply did not arrive. Your message was saved.");
  expect(h.w.get('#prompt').value).toBe('');
 });

 it.each([
  ['malformed event shape',()=>completeStream(['"not-an-object"']),/Malformed conversation event\./],
  ['oversized ordinary event',()=>completeStream([JSON.stringify({type:'token',text:'x'.repeat(260*1024)})]),/Conversation event exceeds limit\./],
  ['mismatched chat receipt',()=>completeStream([JSON.stringify({type:'done',chat:{id:'wrong-chat',messages:[]}})]),/Conversation receipt does not match this chat\./],
  ['invalid UTF-8 stream bytes',()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([0xff,0xfe]));}}),{status:200,headers:{'content-type':'application/x-ndjson'}}),/encoded data|utf-8|Conversation failed/i]
 ])('does not recover protocol/validation error: %s',async(_label,makeResponse,expectedPattern)=>{
  vi.useFakeTimers();
  const h=createTurnHarness({
   onChatPost:()=>makeResponse(),
   onChatRead:(reqId)=>({
    id:'c1',
    title:'Mission chat',
    messages:[
     {id:'u-1',role:'user',content:'Test protocol',request_id:reqId},
     {id:'a-1',role:'assistant',content:'Should never be polled',request_id:reqId}
    ]
   })
  });

  const ws=h.w.window.EchoPrimeWorkspace;
  await ws.ready;
  const outcome=await ws.send('Test protocol');

  expect(outcome.sent).toBe(false);
  expect(outcome.verified).toBe(false);
  expect(outcome.detail).toMatch(expectedPattern);
  expect(h.chatReads()).toBe(0);
  expect(h.chatLogText()).not.toContain("Connection dropped. Checking for Echo's reply...");
 });

 it('does not recover on user abort during streaming, and stops an active recovery on abort or chat switch',async()=>{
  vi.useFakeTimers();
  let releaseStream!:()=>void;
  const h1=createTurnHarness({
   onChatPost:(_body)=>new Response(new ReadableStream({
    pull(){
     return new Promise<void>((_,reject)=>{
      releaseStream=()=>reject(new TypeError('network error'));
     });
    }
   }),{status:200,headers:{'content-type':'application/x-ndjson'}}),
   onChatRead:()=>({id:'c1',title:'Mission chat',messages:[]})
  });

  const ws1=h1.w.window.EchoPrimeWorkspace;
  await ws1.ready;
  const abortedTurn=ws1.send('Cancel me');
  await vi.advanceTimersByTimeAsync(0);

  // User clicks Stop, then the underlying reader rejects with a TypeError
  await h1.w.get('#stop-chat').click();
  releaseStream();
  const abortedOutcome=await abortedTurn;
  expect(abortedOutcome.sent).toBe(false);
  expect(abortedOutcome.detail).toContain('Stopped displaying this turn.');
  expect(h1.chatReads()).toBe(0);

  // Now verify switching chats mid-recovery stops polling immediately
  const h2=createTurnHarness({
   onChatPost:()=>Promise.reject(new TypeError('network error')),
   onChatRead:()=>({id:'c1',title:'Mission chat',messages:[]})
  });
  const ws2=h2.w.window.EchoPrimeWorkspace;
  await ws2.ready;
  const recoveringTurn=ws2.send('Switch away mid-recovery');
  await vi.advanceTimersByTimeAsync(3000);
  expect(h2.chatReads()).toBe(2);

  // User starts a new chat -> increments epoch & aborts turn
  await ws2.newChat();
  const switchedOutcome=await recoveringTurn;
  expect(switchedOutcome).toMatchObject({handled:true,cancelled:true});
  const readsAtSwitch=h2.chatReads();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h2.chatReads()).toBe(readsAtSwitch);
 });

 it('defers recovery while document.hidden is true until visibilitychange or online, and never runs two recoveries for one turn',async()=>{
  vi.useFakeTimers();
  const h=createTurnHarness({
   onChatPost:()=>droppingStream([JSON.stringify({type:'status',text:'Thinking…'})],()=>new TypeError('Load failed')),
   onChatRead:(reqId,pollIndex)=>{
    if(pollIndex<2)return {id:'c1',title:'Mission chat',messages:[{id:'u-1',role:'user',content:'Mobile prompt',request_id:reqId}]};
    return {
     id:'c1',
     title:'Mission chat',
     messages:[
      {id:'u-1',role:'user',content:'Mobile prompt',request_id:reqId},
      {id:'a-1',role:'assistant',content:'Reply waiting after backgrounding.',request_id:reqId}
     ]
    };
   }
  });

  const ws=h.w.window.EchoPrimeWorkspace;
  await ws.ready;

  // Phone backgrounds tab BEFORE transport failure lands
  h.w.document.hidden=true;
  h.fireVisibility();

  const turnPromise=ws.send('Mobile prompt');
  await vi.advanceTimersByTimeAsync(0);

  // Inline status is ready, but ZERO recovery polls happen while hidden, even across 45s
  expect(h.chatLogText()).toContain("Connection dropped. Checking for Echo's reply...");
  expect(h.chatReads()).toBe(0);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(h.chatReads()).toBe(0);

  // visibilitychange while still hidden still does not start recovery
  h.fireVisibility();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(h.chatReads()).toBe(0);

  // Tab becomes visible AND online fires right beside it -> only ONE recovery loop runs!
  h.w.document.hidden=false;
  h.fireVisibility();
  h.w.emit('online');
  h.fireVisibility();
  await vi.advanceTimersByTimeAsync(0);
  // First poll at resume + at most one online wakeup if sleeping; let's check single-loop behaviour:
  expect(h.chatReads()).toBe(1);

  // 3s later -> poll 2 recovers the reply cleanly
  await vi.advanceTimersByTimeAsync(3_000);
  const outcome=await turnPromise;
  expect(outcome).toMatchObject({handled:true,sent:true,verified:true});
  expect(h.chatReads()).toBe(2);
  expect(h.chatLogText()).toContain('Reply waiting after backgrounding.');

  // Also verify `online` alone starts deferred recovery when hidden at failure time
  const hOnline=createTurnHarness({
   onChatPost:()=>Promise.reject(new TypeError('network error')),
   onChatRead:(reqId)=>({
    id:'c1',
    title:'Mission chat',
    messages:[
     {id:'u-2',role:'user',content:'Online wake prompt',request_id:reqId},
     {id:'a-2',role:'assistant',content:'Recovered on online event.',request_id:reqId}
    ]
   })
  });
  await hOnline.w.window.EchoPrimeWorkspace.ready;
  hOnline.w.document.hidden=true;
  const onlineTurn=hOnline.w.window.EchoPrimeWorkspace.send('Online wake prompt');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(hOnline.chatReads()).toBe(0);

  hOnline.w.emit('online');
  const onlineOutcome=await onlineTurn;
  expect(onlineOutcome).toMatchObject({handled:true,sent:true,verified:true});
  expect(hOnline.chatReads()).toBe(1);
  expect(hOnline.chatLogText()).toContain('Recovered on online event.');
 });

 it('passes keepalive NDJSON lines through Prime unchanged and ignores them in the UI, including right before done and after done',async()=>{
  const sessionToken=randomBytes(32).toString('hex');
  const upstream=createServer(async(req,res)=>{
   const url=new URL(req.url??'/','http://127.0.0.1');
   const authed=(req.headers.cookie??'')===`echo_workspace_session=${sessionToken}`;
   const json=(code:number,body:unknown)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
   if(url.pathname==='/api/auth/session'){
    json(200,{authenticated:authed,user:authed?{uid:'owner',role:'owner',status:'approved',name:'Commander'}:null,csrf:authed?'csrf-owner':null});
    return;
   }
   if(url.pathname==='/api/auth/login'&&req.method==='POST'){
    res.setHeader('set-cookie',`echo_workspace_session=${sessionToken}; HttpOnly; Path=/; SameSite=Lax`);
    json(200,{user:{uid:'owner',role:'owner'},csrf:'csrf-owner'});
    return;
   }
   if(!authed){json(401,{error:'Sign in required'});return;}
   if(url.pathname==='/api/state'){
    json(200,{auth_enabled:true,tenant_isolation:true,user:{uid:'owner'},csrf:'csrf-owner',chats:[{id:'c-keep',title:'Keepalive chat'}],projects:[],library:[],preferences:[],personalities:[]});
    return;
   }
   if(url.pathname==='/api/chats'&&req.method==='POST'){
    json(200,{id:'c-keep',title:'Keepalive chat',messages:[],project_id:null});
    return;
   }
   if(url.pathname==='/api/chats/c-keep'){
    json(200,{id:'c-keep',title:'Keepalive chat',messages:[{id:'u1',role:'user',content:'Hello'},{id:'a1',role:'assistant',content:'Steady stream reply.'}]});
    return;
   }
   if(url.pathname==='/api/chat'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    const parsed=JSON.parse(body) as {chat_id:string;request_id:string;content:string};
    res.writeHead(200,{'content-type':'application/x-ndjson'});
    res.write('{"type":"keepalive","t":1762400000}\n');
    res.write(JSON.stringify({type:'status',text:'Thinking…'})+'\n');
    res.write('{"type":"keepalive","t":1762400015}\n');
    res.write(JSON.stringify({type:'token',text:'Steady stream '})+'\n');
    res.write(JSON.stringify({type:'token',text:'reply.'})+'\n');
    res.write('{"type":"keepalive","t":1762400030}\n');
    res.write(JSON.stringify({
     type:'done',
     chat:{
      id:parsed.chat_id,
      title:'Keepalive chat',
      messages:[
       {id:'u1',role:'user',content:parsed.content,request_id:parsed.request_id},
       {id:'a1',role:'assistant',content:'Steady stream reply.',request_id:parsed.request_id}
      ]
     }
    })+'\n');
    res.end('{"type":"keepalive","t":1762400045}\n');
    return;
   }
   json(404,{error:'Not found'});
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise<void>((resolve,reject)=>{upstream.close(e=>e?reject(e):resolve());upstream.closeAllConnections();}));
  const upstreamAddr=upstream.address();
  if(!upstreamAddr||typeof upstreamAddr==='string')throw new Error('Missing upstream port');

  const uiDir=fileURLToPath(new URL('../ui/echo-prime/',import.meta.url));
  const prime=await startPrimeServer(new PrimeHub({capabilities:[]}),uiDir,0,{workspace:{baseUrl:`http://127.0.0.1:${upstreamAddr.port}`,ownerUid:'owner'}});
  cleanup.push(prime.close);

  const root=await fetch(prime.url);
  const primeCookie=(root.headers.get('set-cookie')??'').split(';')[0];
  const loginRes=await fetch(prime.url+'/api/workspace/auth/login',{
   method:'POST',
   headers:{'x-prime-request':'1',cookie:primeCookie,origin:prime.url,'content-type':'application/json','x-echo-csrf':'login'},
   body:JSON.stringify({})
  });
  const wsCookie=(loginRes.headers.get('set-cookie')??'').split(';')[0];
  const combinedCookie=`${primeCookie}; ${wsCookie}`;

  // (a) Verify Prime passes keepalive lines through byte-for-byte unchanged
  const rawRes=await fetch(prime.url+'/api/workspace/chat',{
   method:'POST',
   headers:{'x-prime-request':'1',cookie:combinedCookie,origin:prime.url,'content-type':'application/json','x-echo-csrf':'csrf-owner'},
   body:JSON.stringify({chat_id:'c-keep',content:'Hello',request_id:randomUUID(),attachments:[]})
  });
  expect(rawRes.status).toBe(200);
  const rawLines=(await rawRes.text()).trim().split('\n');
  expect(rawLines[0]).toBe('{"type":"keepalive","t":1762400000}');
  expect(rawLines[2]).toBe('{"type":"keepalive","t":1762400015}');
  expect(rawLines[5]).toBe('{"type":"keepalive","t":1762400030}');
  expect(rawLines[7]).toBe('{"type":"keepalive","t":1762400045}');

  // (b) Verify workspace-client.js and workspace.js silently ignore all keepalives (including right before & after done)
  const primeFetch:typeof fetch=(path,init)=>fetch(prime.url+String(path),{
   ...init,
   headers:{...(init?.headers as Record<string,string>|undefined),cookie:combinedCookie,origin:prime.url}
  });
  const vmWin:Record<string,any>={};
  runInNewContext(await readFile(new URL('../ui/echo-prime/workspace-client.js',import.meta.url),'utf8'),{window:vmWin,TextDecoder,TextEncoder,AbortController,Uint8Array,fetch:primeFetch});
  const client=new vmWin.EchoPrimeWorkspaceTransport({fetch:primeFetch});
  const observedTypes:string[]=[];
  const chatResult=await client.chat({chat_id:'c-keep',content:'Hello',request_id:randomUUID(),attachments:[]},(ev:{type:string})=>observedTypes.push(ev.type));
  expect(observedTypes).toEqual(['status','token','token','done']);
  expect(chatResult.messages.at(-1).content).toBe('Steady stream reply.');

  // Full workspace.js UI turn against Prime with keepalives before and after done
  const uiWorld=world(['activity.js','workspace-client.js','workspace.js'],{
   window:{fetch:primeFetch,EchoPrimeChat:{reset:vi.fn(),send:vi.fn()},EchoPrimeModels:null},
   globals:{fetch:primeFetch,Response,ReadableStream,Uint8Array}
  });
  uiWorld.get('#workspace-chat-kind').value='workspace';
  await uiWorld.window.EchoPrimeWorkspace.ready;
  const uiOutcome=await uiWorld.window.EchoPrimeWorkspace.send('Hello');
  expect(uiOutcome).toMatchObject({handled:true,sent:true,verified:true});
  const rendered=walk(uiWorld.get('#chat-log')).map(n=>n._text).join(' ');
  expect(rendered).toContain('Steady stream reply.');
  expect(rendered).not.toContain('keepalive');
 });
});
