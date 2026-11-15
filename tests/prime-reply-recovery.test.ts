import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// Reproduces the 2026-11-04 mobile failure (chat 6d59de98 / request f235f76d): a Workspace turn
// whose NDJSON stream ended WITHOUT a `done` event, so the client threw a dead-end and showed the
// doubled "No automatic retry was made." with no answer — even though the backend had saved the
// reply. Exercises the real activity.js + workspace-client.js + workspace.js together.
class Node {
 textContent='';value='';className='';hidden=false;disabled=false;checked=false;open=false;inert=false;isConnected=true;
 tagName:string;id='';dataset:Record<string,string>={};attributes:Record<string,string>={};children:Node[]=[];parent:Node|null=null;
 events:Record<string,((event:any)=>unknown)[]>={};files:any[]=[];
 classList={add:vi.fn(),remove:vi.fn(),toggle:vi.fn(),contains:()=>false};
 style={setProperty:vi.fn()};
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 append(...items:Node[]){for(const item of items){item.parent=this;this.children.push(item);}}
 replaceChildren(...items:Node[]){for(const child of this.children)child.isConnected=false;this.children=[];this.append(...items);}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}this.isConnected=false;}
 setAttribute(key:string,value:string){this.attributes[key]=value;if(key==='value')this.value=value;}
 getAttribute(key:string){return this.attributes[key]??null;}
 addEventListener(name:string,callback:(event:any)=>unknown){(this.events[name]??=[]).push(callback);}
 async fire(name:string,event:any={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},target:this,...event});}
 showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}
 focus(){} before(){} scrollIntoView(){} click(){return this.fire('click');}
 querySelector(){return null;}
 getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
}
function descendants(node:Node):Node[]{return node.children.flatMap(child=>[child,...descendants(child)]);}
const src=(name:string)=>readFileSync(new URL('../ui/echo-prime/'+name,import.meta.url),'utf8');

const session={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
function jsonResponse(obj:unknown){return new Response(JSON.stringify(obj),{status:200,headers:{'content-type':'application/json'}});}
function ndjsonResponse(lines:string[]){
 return new Response(new ReadableStream({start(controller){for(const line of lines)controller.enqueue(new TextEncoder().encode(line+'\n'));controller.close();}}),
  {status:200,headers:{'content-type':'application/x-ndjson'}});
}

function harness(streamLines:string[],readback:(req:string|null)=>any){
 let capturedReq:string|null=null;
 const fetch=vi.fn(async(url:string,opts:any={})=>{
  const u=String(url);
  if(u==='/api/session')return jsonResponse(session);
  if(u==='/api/workspace/state')return jsonResponse({chats:[],projects:[],library:[],preferences:[],personalities:[]});
  if(u==='/api/workspace/chats'&&opts.method==='POST')return jsonResponse({id:'c1',title:'New chat',messages:[],project_id:null});
  if(u==='/api/workspace/chat'&&opts.method==='POST'){capturedReq=JSON.parse(opts.body).request_id;return ndjsonResponse(streamLines);}
  if(u.startsWith('/api/workspace/chats/c1'))return jsonResponse(readback(capturedReq));
  return jsonResponse({});
 });
 const nodes=new Map<string,Node>();
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector)!;};
 const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
 const win:any={addEventListener:()=>{},dispatchEvent:()=>{},EchoPrimeChat:{reset(){}},EchoPrimeModels:null,fetch};
 const document:any={hidden:false,head:new Node(),querySelector:get,querySelectorAll:()=>[],createElement:(t:string)=>new Node(t),createTextNode:(t:string)=>Object.assign(new Node('text'),{textContent:t}),createElementNS:(_n:string,t:string)=>new Node(t),addEventListener:()=>{}};
 const context:any={window:win,document,localStorage:storage,matchMedia:()=>({matches:false,addEventListener(){}}),navigator:{userAgent:'fixture'},location:{protocol:'http:'},crypto:{randomUUID},
  setTimeout:(fn:()=>void)=>setTimeout(fn,0),clearTimeout,setInterval:()=>0,clearInterval:()=>{},AbortController,AbortSignal,TextEncoder,TextDecoder,URL,Blob,Response,ReadableStream,Event,Error,performance:{now:()=>Date.now()},console:{debug(){}},fetch};
 for(const file of ['activity.js','workspace-client.js','workspace.js'])runInNewContext(src(file),context);
 get('#workspace-chat-kind').value='workspace';
 return {get,win,fetch,descendants:()=>descendants,capturedReq:()=>capturedReq};
}

const toolStarted=(step:number,index:number,tool:string)=>JSON.stringify({type:'tool_started',tool,request_id:'r:tool:'+step+':'+index,arguments:{}});
const toolResult=(step:number,index:number,tool:string,status:string)=>JSON.stringify({type:'tool_result',tool,request_id:'r:tool:'+step+':'+index,result:{ok:status==='observed'},evidence:{status,action:'',potential_side_effect:status==='unknown'}});
// The exact event shape of the failed turn: three workspace tools observed, esh unknown, then EOF with NO `done`.
const droppedStream=[JSON.stringify({type:'status',text:'Echo is checking previous chats and memories…'}),
 toolStarted(0,0,'workspace'),toolResult(0,0,'workspace','observed'),
 toolStarted(0,1,'workspace'),toolResult(0,1,'workspace','observed'),
 toolStarted(0,2,'workspace'),toolResult(0,2,'workspace','observed'),
 JSON.stringify({type:'status',text:'Echo is answering…'}),
 toolStarted(1,0,'esh'),toolResult(1,0,'esh','unknown')];

const savedReply=(req:string|null)=>({id:'c1',title:'Give me a situation report',messages:[
 {id:'u',role:'user',content:'Give me a situation report',request_id:(req||'').replace(/:reply$/,'')},
 {id:'a',role:'assistant',content:'Here is your situation report (recovered).',request_id:(req||'')+':reply'}]});
const noReply=()=>({id:'c1',title:'Give me a situation report',messages:[{id:'u',role:'user',content:'Give me a situation report',request_id:'r'}]});

async function runTurn(h:ReturnType<typeof harness>){
 const ws=h.win.EchoPrimeWorkspace;await ws.ready;return ws.send('Give me a situation report');
}

it('recovers the saved reply when the stream ends without a done event (the f235f76d failure)',async()=>{
 const h=harness(droppedStream,savedReply);
 const result=await runTurn(h);
 expect(result).toMatchObject({handled:true,sent:true,verified:true});
 // The recovered assistant answer is rendered in the conversation, not lost.
 const texts=descendants(h.get('#chat-log')).map(n=>n.textContent);
 expect(texts.join(' ')).toContain('situation report (recovered)');
});

it('does not render full-width Activity chat bubbles; tool steps become compact chips in the strip',async()=>{
 const h=harness(droppedStream,savedReply);
 await runTurn(h);
 // No chat-message article is labelled "Activity" any more (the old bubbles are gone).
 const labels=h.get('#chat-log').children.flatMap(a=>a.children).filter(c=>c.tagName==='STRONG').map(c=>c.textContent);
 expect(labels).not.toContain('Activity');
 // The compact strip exists with tool chips including the esh failure.
 const strip=h.get('#chat-activity').children.find(c=>c.className==='activity-strip');
 expect(strip).toBeDefined();
 const chipText=descendants(strip!).filter(n=>n.className&&n.className.startsWith('activity-chip')).map(n=>descendants(n).map(d=>d.textContent).join('')).join(' | ');
 expect(chipText).toContain('workspace');expect(chipText).toContain('esh');expect(chipText).toContain('✗');
});

it('shows the retry-suffix exactly once (no "No automatic retry was made. No automatic retry was made.")',async()=>{
 const h=harness(droppedStream,noReply);
 const result=await runTurn(h);
 expect(result.sent).toBe(false);
 const occurrences=(String(result.detail).match(/No automatic retry was made\./g)||[]).length;
 expect(occurrences).toBe(1);
 expect(result.detail).not.toContain('No automatic retry was made. No automatic retry was made.');
});

it('names the real reason (connection closed) rather than a bare "ended without completion"',async()=>{
 const h=harness(droppedStream,noReply);
 const result=await runTurn(h);
 expect(result.detail.toLowerCase()).toContain('connection closed');
});

it('marks the strip failed and keeps the esh red chip visible when recovery finds no saved reply',async()=>{
 const h=harness(droppedStream,noReply);
 await runTurn(h);
 const strip=h.get('#chat-activity').children.find(c=>c.className==='activity-strip');
 expect(strip).toBeDefined();
 expect(strip!.dataset.state).toBe('failed');
 const chips=descendants(strip!).filter(n=>n.className&&n.className.startsWith('activity-chip'));
 expect(chips.some(c=>c.className.includes('warn')||c.className.includes('fail'))).toBe(true);
});

it('completes normally and renders the answer when a done event arrives (no regression)',async()=>{
 const doneStream=[...droppedStream.slice(0,7),JSON.stringify({type:'token',text:'All systems nominal.'}),
  JSON.stringify({type:'done',chat:{id:'c1',title:'t',messages:[{id:'u',role:'user',content:'Give me a situation report',request_id:'x'},{id:'a',role:'assistant',content:'All systems nominal.',request_id:'x:reply'}]}})];
 const h=harness(doneStream,savedReply);
 const result=await runTurn(h);
 expect(result).toMatchObject({handled:true,sent:true,verified:true});
 const strip=h.get('#chat-activity').children.find(c=>c.className==='activity-strip');
 expect(strip!.dataset.state).toBe('done');
});
