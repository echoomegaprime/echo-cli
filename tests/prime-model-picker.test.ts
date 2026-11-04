import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';

class Element {
 textContent='';value='';hidden=false;disabled=false;className='';id='';
 children:Element[]=[];attributes:Record<string,string>={};events:Record<string,(()=>void)[]>={};
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(...children:Element[]){this.children=children;}
 setAttribute(key:string,value:string){this.attributes[key]=value;}
 addEventListener(name:string,callback:()=>void){(this.events[name]??=[]).push(callback);}
 change(){for(const callback of this.events.change??[])callback();}
 querySelector(selector:string):Element|null{return this.children.find(child=>selector==='[data-model-identity]'&&child.attributes['data-model-identity']==='1')??null;}
 constructor(readonly tagName='div'){}
}
function fixture(){
 const controls=new Element(),kind=Object.assign(new Element(),{value:'workspace'}),articles:Element[]=[],listeners:Record<string,((event:any)=>void)[]>={};
 const chats=vi.fn(async(input:Record<string,unknown>)=>({id:input.chat_id,messages:[]}));
 class Transport {chat=chats;}
 // Real transport uses a prototype method; preserve that shape in this fixture.
 Object.defineProperty(Transport.prototype,'chat',{value:chats,writable:true});
 const session={authenticated:true,user:{uid:'member',status:'approved'}};
 const window:any={EchoPrimeWorkspaceTransport:Transport,EchoPrimeWorkspace:{session},addEventListener:(name:string,callback:(event:any)=>void)=>(listeners[name]??=[]).push(callback)};
 const document={querySelector:(selector:string)=>selector==='#workspace-conversation-controls'?controls:selector==='#workspace-chat-kind'?kind:null,
  querySelectorAll:(selector:string)=>selector==='#chat-log .chat-message.assistant'?articles:[],createElement:(tag:string)=>new Element(tag)};
 runInNewContext(readFileSync(new URL('../ui/echo-prime/models.js',import.meta.url),'utf8'),{window,document,console:{debug:vi.fn()},Error,Set,Map});
 const emit=(name:string,detail:any)=>{for(const callback of listeners[name]??[])callback({detail});};
 const select=controls.children.flatMap(child=>child.children).find(child=>child.tagName==='select')!;
 const note=controls.children.find(child=>child.id==='workspace-model-status')!;
 const catalog={default_model_provider:'qwen',model_choices:[{id:'qwen',label:'Qwen 3.8',requested_model:'c3po-code:echo-qwen38-abliterated-256k',context_length:262144},{id:'claude',label:'Claude',requested_model:'sonnet'},{id:'gpt',label:'GPT',requested_model:null},{id:'grok',label:'Grok',requested_model:null}]};
 const transport=Object.create(Transport.prototype) as {chat:(input:Record<string,unknown>,onEvent?:unknown,signal?:AbortSignal)=>Promise<unknown>};
 return {window,controls,select,note,chats,transport,emit,catalog,articles,kind,session};
}
describe('saved Workspace model picker',()=>{
 it('defaults to configured Qwen and preserves the canonical chat input, callback and cancellation signal',async()=>{
  const h=fixture();h.emit('echo-workspace-state',{state:h.catalog});
  const input={chat_id:'private-chat',request_id:'one',content:'hello',attachments:['private-file']},callback=()=>{},signal=new AbortController().signal;
  await h.transport.chat(input,callback,signal);
  expect(h.select.value).toBe('qwen');expect(h.chats).toHaveBeenCalledWith({...input,model_provider:'qwen'},callback,signal);
  expect(input).not.toHaveProperty('model_provider');expect(h.note.textContent).not.toMatch(/ready|loaded|connected/i);
 });
 it('uses only backend configured choices and never silently substitutes a failed provider',async()=>{
  const h=fixture();h.emit('echo-workspace-state',{state:h.catalog});h.select.value='gpt';h.select.change();
  h.chats.mockRejectedValueOnce(new Error('GPT unavailable; no fallback was used'));
  await expect(h.transport.chat({chat_id:'chat'})).rejects.toThrow('GPT unavailable');
  expect(h.chats).toHaveBeenCalledTimes(1);expect(h.chats.mock.calls[0][0].model_provider).toBe('gpt');expect(h.select.value).toBe('gpt');
 });
 it('resets provider choices and saved identity after an account change, refusing sends before fresh state',async()=>{
  const h=fixture();h.emit('echo-workspace-state',{state:h.catalog});h.select.value='claude';h.select.change();
  h.emit('echo-account-changed',undefined);expect(h.select.disabled).toBe(true);expect(h.note.textContent).not.toContain('Claude');
  await expect(h.transport.chat({chat_id:'old'})).rejects.toThrow(/model selection/i);expect(h.chats).not.toHaveBeenCalled();
  h.emit('echo-workspace-state',{state:h.catalog});await h.transport.chat({chat_id:'new'});expect(h.chats.mock.calls[0][0].model_provider).toBe('qwen');
 });
 it('rejects invalid and unconfigured model choices without passing caller overrides',async()=>{
  const h=fixture();h.emit('echo-workspace-state',{state:{...h.catalog,model_choices:[...h.catalog.model_choices,{id:'attacker',label:'Injected'}]}});
  expect(h.select.disabled).toBe(true);await expect(h.transport.chat({model_provider:'attacker'})).rejects.toThrow(/model selection/i);
  h.emit('echo-workspace-state',{state:{...h.catalog,model_choices:h.catalog.model_choices.slice(0,1)}});h.select.value='grok';h.select.change();
  await expect(h.transport.chat({model_provider:'grok'})).rejects.toThrow(/model selection/i);expect(h.chats).not.toHaveBeenCalled();
 });
 it('labels durable reported identities beside the matching saved reply and keeps GPT model unknown when unreported',()=>{
  const h=fixture();h.emit('echo-workspace-state',{state:h.catalog});h.articles.push(new Element(),new Element());
  h.emit('echo-workspace-chat',{chat:{messages:[{role:'assistant',request_id:'a:reply'},{role:'assistant',request_id:'b:reply'}],events:[
   {kind:'model_identity',content:JSON.stringify({request_id:'a',provider:'claude',requested:'sonnet',model:'claude-sonnet-reported',reported:true})},
   {kind:'model_identity',content:JSON.stringify({request_id:'b',provider:'gpt',requested:'gpt-requested',model:null,reported:false})}
  ]}});
  const first=h.articles[0].children[0].textContent,second=h.articles[1].children[0].textContent;
  expect(first).toContain('claude-sonnet-reported');expect(second).toContain('Model not reported');expect(second).toContain('requested gpt-requested');
  expect(second).not.toContain('Answered by gpt-requested');
 });
 it('treats malformed and unrelated identity events as unavailable and never renders model metadata as HTML',()=>{
  const h=fixture();h.articles.push(new Element());
  h.emit('echo-workspace-chat',{chat:{messages:[{role:'assistant',request_id:'a:reply'}],events:[{type:'model_identity',content:'{broken'},
   {type:'model_identity',content:JSON.stringify({request_id:'different',provider:'grok',requested:null,model:'grok-reported',reported:true})},
   {type:'model_identity',content:JSON.stringify({request_id:'a',provider:'claude',requested:null,model:'<img onerror=alert(1)>',reported:true})}]}});
  expect(h.articles[0].children[0].textContent).toContain('Model identity unavailable');
 });
});
