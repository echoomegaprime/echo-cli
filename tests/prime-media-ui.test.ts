/* eslint-disable @typescript-eslint/no-explicit-any -- purpose-built browser DOM stand-in */
import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../ui/echo-prime/media-router.js',import.meta.url),'utf8');
// composer.js is a deferred script, so in the page it runs after media-router.js; the harness runs it second, the same way.
const composerSource=readFileSync(new URL('../ui/echo-prime/composer.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setTimeout(r,0));};

class TestEvent {type:string;target:any=null;detail:any;defaultPrevented=false;propagationStopped=false;immediateStopped=false;constructor(type:string,init:any={}){this.type=type;this.detail=init.detail;}preventDefault(){this.defaultPrevented=true;}stopPropagation(){this.propagationStopped=true;}stopImmediatePropagation(){this.immediateStopped=true;this.propagationStopped=true;}}
class Node {
 tagName:string;className='';hidden=false;disabled=false;value='';_text='';parent:Node|null=null;children:Node[]=[];attributes:Record<string,string>={};dataset:Record<string,string>={};listeners:Record<string,((e:any)=>unknown)[]>={};focused=false;document:any;
 constructor(tag='div',document?:any){this.tagName=tag.toUpperCase();this.document=document;}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}set textContent(v:string){this._text=String(v);this.children=[];}
 get classList(){const list=()=>this.className.split(/\s+/).filter(Boolean),put=(xs:string[])=>this.className=xs.join(' '),api={add:(x:string)=>{if(!list().includes(x))put([...list(),x]);},remove:(x:string)=>put(list().filter(y=>y!==x)),contains:(x:string)=>list().includes(x),toggle:(x:string,on?:boolean)=>{const yes=on===undefined?!list().includes(x):on;if(yes)api.add(x);else api.remove(x);return yes;}};return api;}
 append(...items:any[]){for(const item of items){if(!item)continue;const n=typeof item==='string'?Object.assign(new Node('#text',this.document),{_text:item}):item;n.parent=this;this.children.push(n);}}
 prepend(...items:Node[]){for(const item of [...items].reverse()){item.parent=this;this.children.unshift(item);}}
 replaceChildren(...items:Node[]){this.children=[];this._text='';this.append(...items);}
 before(...items:Node[]){if(!this.parent)return;const at=this.parent.children.indexOf(this);for(const item of items)item.parent=this.parent;this.parent.children.splice(at,0,...items);}
 after(...items:Node[]){if(!this.parent)return;const at=this.parent.children.indexOf(this);for(const item of items)item.parent=this.parent;this.parent.children.splice(at+1,0,...items);}
 setAttribute(k:string,v:string){this.attributes[k]=String(v);if(k==='class')this.className=String(v);if(k==='value')this.value=String(v);if(k==='id')this.attributes.id=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=String(v);}
 getAttribute(k:string){return this.attributes[k]??null;}
 addEventListener(k:string,fn:(e:any)=>unknown){(this.listeners[k]??=[]).push(fn);}
 dispatchEvent(event:any){event.target??=this;for(const fn of this.listeners[event.type]||[]){fn(event);if(event.immediateStopped)break;}return !event.defaultPrevented;}
 click(){this.dispatchEvent(new TestEvent('click'));}
 focus(){this.focused=true;}
 requestSubmit(){const e=new TestEvent('submit');e.target=this;for(const fn of this.document.capture.submit||[]){fn(e);if(e.immediateStopped)break;}if(!e.immediateStopped)for(const fn of this.listeners.submit||[]){fn(e);if(e.immediateStopped)break;}this.document.submitCalls++;}
 querySelector(s:string){return walk(this).find(n=>matches(n,s))||null;}querySelectorAll(s:string){return walk(this).filter(n=>matches(n,s));}
}
const walk=(root:Node):Node[]=>root.children.flatMap(c=>[c,...walk(c)]);
function matches(n:Node,selector:string){
 const attr=/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/.exec(selector);if(attr)return n.getAttribute(attr[1])!==null&&(attr[2]===undefined||n.getAttribute(attr[1])===attr[2]);
 if(selector.startsWith('#'))return n.getAttribute('id')===selector.slice(1);if(selector.startsWith('.'))return n.classList.contains(selector.slice(1));return n.tagName===selector.toUpperCase();
}
function select(root:Node,selector:string){const parts=selector.trim().split(/\s+/);let current=[root];for(const part of parts){current=current.flatMap(r=>walk(r).filter(n=>matches(n,part)));}return current;}

const defaultPick={id:'echo.media.image_generate',cap:'echo.media.image_generate',label:'On-prem image',provider:'TEMPER',reason:'Picked On-prem image because image',health:'green',healthSource:'probe',cost:'free',costNote:'$0 on-prem',quality:8,speed:7,argumentShape:'modeled',request:{target:'sdk',name:'echo.media.image_generate',arguments:{command:'image_generate',options:{prompt:'fox'}}}};
const alternative={...defaultPick,id:'echo.llm.together.FLUX.2-max',cap:'echo.llm.together.FLUX.2-max',label:'FLUX Max',provider:'Together AI',reason:'Picked FLUX Max because image',request:{target:'sdk',name:'echo.llm.together.FLUX.2-max',arguments:{command:'generate',options:{prompt:'fox'}}}};
const mediaResult=()=>({classification:{kind:'image',confidence:.91,styles:['photoreal']},picked:{...defaultPick},alternatives:[{...alternative}],excluded:[],probe:{probed:[],source:'none'}});

async function harness(options:any={}){
 const root=new Node('body'),capture:Record<string,((e:any)=>unknown)[]>={},windowEvents:Record<string,((e:any)=>unknown)[]>={};
 const document:any={capture,submitCalls:0,createElement:(t:string)=>new Node(t,document),createTextNode:(t:string)=>Object.assign(new Node('#text',document),{_text:t}),querySelector:(s:string)=>select(root,s)[0]||null,querySelectorAll:(s:string)=>select(root,s),addEventListener:(n:string,f:(e:any)=>unknown,c=false)=>{if(c)(capture[n]??=[]).push(f);},};
 root.document=document;
 const make=(tag:string,attrs:any={},text='')=>{const n=new Node(tag,document);for(const [k,v] of Object.entries(attrs))k==='class'?n.className=String(v):n.setAttribute(k,String(v));if(text)n.textContent=text;return n;};
 const tabs=make('div',{class:'mode-tabs'});for(const name of ['Chat','Image','Video','Music','Sound FX','Voice']){const b=make('button',{'data-mode':name,'aria-selected':name==='Chat'?'true':'false'},name);if(name==='Chat')b.className='selected';tabs.append(b);}
 const composer=make('form',{id:'composer'}),prompt=make('textarea',{id:'prompt'}),sendActions=make('div',{class:'send-actions'}),send=make('button',{class:'send'},'Send'),caption=make('p',{class:'composer-caption'});sendActions.append(send);composer.append(prompt,sendActions,caption);
 const tools=make('div',{id:'creative-tools'}),category=make('select',{id:'creative-category'});category.value='auto';const brief=make('textarea',{id:'creative-prompt'}),creativeActions=make('div',{class:'creative-actions'}),args=make('textarea',{id:'creative-arguments'});root.append(tabs,composer,tools,category,brief,creativeActions,args);
 const ownSubmit=vi.fn();composer.addEventListener('submit',ownSubmit);
 const studio={open:vi.fn(),apply:vi.fn(()=>true),merge:vi.fn(()=>0),select:vi.fn(()=>true),catalog:()=>[],selected:vi.fn(()=>({id:'echo.llm.together.google-flash-image-2.5',category:'image'}))},originalOpen=studio.open;
 const workspace={enabled:true,ready:Promise.resolve(true),session:{authenticated:true,ownerAccess:true},ownerHeaders:async()=>({}),invalidate:vi.fn(),...options.workspace};
 const window:any={EchoPrimeWorkspace:workspace,EchoPrimeStudio:studio,addEventListener:(n:string,f:(e:any)=>unknown)=>(windowEvents[n]??=[]).push(f),dispatchEvent:(e:any)=>{for(const f of windowEvents[e.type]||[])f(e);}};
 const calls:any[]=[];let enhanceResolver:any;
 const jsonResponse=(data:any,status=200)=>({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},json:async()=>data});
 const models=options.models??{configured:true,routing:true,providers:[{id:'claude',available:true},{id:'gpt',available:true},{id:'grok',available:false,reason:'not logged in'},{id:'argon',available:true},{id:'qwen',available:true}]};
 const fetch=vi.fn(async(url:string,init:any={})=>{calls.push({url,init,body:init.body?JSON.parse(init.body):undefined});if(url==='/api/prime/models')return jsonResponse(models);if(url==='/api/prime/media/route')return jsonResponse(typeof options.route==='function'?options.route():options.route??mediaResult(),options.routeStatus??200);if(url==='/api/prime/enhance'){if(options.pendingEnhance)return new Promise(resolve=>enhanceResolver=()=>resolve(jsonResponse(options.enhance??enhanced)));return jsonResponse(options.enhance??enhanced,options.enhanceStatus??200);}throw new Error(url);});
 const enhanced={mode:'image',text:'ENHANCED',added:['golden hour'],provider:'claude',providerLabel:'Claude',model:{id:'claude',label:'Claude',model:'claude-sonnet-5-5',reported:true,answered:true}};
 const context={window,document,fetch,location:{protocol:'https:'},AbortSignal,CustomEvent:class extends TestEvent{constructor(t:string,i:any){super(t,i);}},Event:TestEvent,console:{debug:vi.fn()},setTimeout,clearTimeout,Promise,JSON,Object,Array,String,Number,Math,Error,Set,Map,Boolean};
 runInNewContext(source,context);
 if(options.composerScript!==false)runInNewContext(composerSource,context);
 await window.EchoPrimeMediaRouter.ready;await tick();
 const all=()=>[root,...walk(root)],find=(attr:string,value?:string)=>all().find(n=>n.getAttribute(attr)!==null&&(value===undefined||n.getAttribute(attr)===value)),button=(text:string)=>all().find(n=>n.tagName==='BUTTON'&&n.textContent.trim()===text);
 return {root,document,window,studio,originalOpen,workspace,fetch,calls,tabs,composer,prompt,brief,category,ownSubmit,all,find,button,resolveEnhance:()=>enhanceResolver?.(),modelsCalls:()=>calls.filter(c=>c.url==='/api/prime/models')};
}

it('prepends Auto without selecting it',async()=>{const w=await harness();expect(w.tabs.children[0].textContent).toBe('Auto');expect(w.tabs.children[0].getAttribute('aria-selected')).toBe('false');expect(w.tabs.children[1].classList.contains('selected')).toBe(true);});
it('clicking Auto after Image first clicks Chat then selects Auto',async()=>{const w=await harness(),chat=w.tabs.children.find(n=>n.dataset.mode==='Chat')!,image=w.tabs.children.find(n=>n.dataset.mode==='Image')!,auto=w.tabs.children[0],chatClick=vi.fn();chat.addEventListener('click',chatClick);image.click();auto.click();expect(chatClick).toHaveBeenCalledOnce();expect(auto.getAttribute('aria-selected')).toBe('true');});
it('Auto composer media submit routes to Studio and suppresses chat submit',async()=>{const w=await harness();w.tabs.children[0].click();w.prompt.value='a fox photo';w.composer.requestSubmit();await tick();expect(w.calls.find(c=>c.url==='/api/prime/media/route').body).toEqual({text:'a fox photo',mode:'auto',fallback:'chat'});expect(w.originalOpen).toHaveBeenCalledWith('auto','a fox photo',null);expect(w.window.EchoPrimeMediaRouter.lastRoute()).toMatchObject({text:'a fox photo'});expect(w.ownSubmit).not.toHaveBeenCalled();});
it('Auto chat classification passes through exactly once',async()=>{const w=await harness({route:{classification:{kind:'chat',confidence:.9},picked:null,alternatives:[]}});w.tabs.children[0].click();w.prompt.value='what is this?';w.composer.requestSubmit();await tick();expect(w.ownSubmit).toHaveBeenCalledOnce();expect(w.originalOpen).not.toHaveBeenCalled();});
it('Studio wrapper preserves inputs and does not route an empty prompt',async()=>{const w=await harness(),inputs=[{upload_id:'upl_'+'0'.repeat(32),role:'reference'}];w.fetch.mockClear();w.studio.open('image','',inputs);await tick();expect(w.originalOpen).toHaveBeenCalledWith('image','',inputs);expect(w.fetch).not.toHaveBeenCalledWith('/api/prime/media/route',expect.anything());});
it('Studio medium routes as the hint and image fallback',async()=>{const w=await harness();w.studio.open('image','a red fox');await tick();expect(w.calls.filter(c=>c.url==='/api/prime/media/route').at(-1).body).toEqual({text:'a red fox',mode:'image',fallback:'image'});});
it('Studio Auto renders and applies the pick with badges',async()=>{const w=await harness();w.studio.open('auto','fox');await tick();const panel=w.find('data-media-auto')!;expect(panel.hidden).toBe(false);expect(panel.textContent).toContain('On-prem image · TEMPER');expect(panel.textContent).toContain('Picked On-prem image');for(const text of ['image · 91% sure','health green','$0 on-prem','quality 8/10'])expect(panel.textContent).toContain(text);expect(w.studio.apply).toHaveBeenCalledWith({id:defaultPick.id,arguments:defaultPick.request.arguments});});
it('shows the alternatives beside the pick so one tap overrides it (no toggle in between)',async()=>{
 const w=await harness();w.studio.open('auto','fox');await tick();
 expect(w.find('data-media-alternatives')!.hidden).toBe(false);expect(w.find('data-media-alternatives-title')!.textContent).toContain('one tap');
 expect(w.find('data-media-alternatives-toggle')).toBeUndefined();
 w.studio.apply.mockClear();w.find('data-media-alternative',alternative.id)!.click();
 expect(w.studio.apply).toHaveBeenCalledTimes(1);expect(w.studio.apply).toHaveBeenCalledWith({id:alternative.id,arguments:alternative.request.arguments});
});
it('lists every excluded tool with its reason in a collapsed section',async()=>{
 const excluded=[{id:'echo.media.video_generate',label:'On-prem video',reason:'owner-disabled on TEMPER (RAM budget)'},{id:'echo.voice.tts',label:'voice.tts',reason:'marked RETIRED in the registry'}];
 const w=await harness({route:()=>({...mediaResult(),excluded})});w.studio.open('auto','fox');await tick();
 const box=w.find('data-media-excluded')!;expect(box.tagName).toBe('DETAILS');expect(box.hidden).toBe(false);
 expect(box.textContent).toContain('Not used for this brief (2)');for(const x of excluded)expect(box.textContent).toContain(x.label+': '+x.reason);
 const none=await harness();none.studio.open('auto','fox');await tick();expect(none.find('data-media-excluded')!.hidden).toBe(true);
});
it('composer.js mounts the chat Enhance button beside Send; media-router.js alone mounts only the Studio one',async()=>{
 const alone=await harness({composerScript:false});
 expect(alone.find('data-enhance','composer')).toBeUndefined();expect(alone.find('data-enhance','studio')).toBeTruthy();
 const w=await harness(),actions=w.all().find(n=>n.className==='send-actions')!,button=w.find('data-enhance','composer')!;
 const wrapAt=actions.children.findIndex(n=>n.children.includes(button)),sendAt=actions.children.findIndex(n=>n.className==='send');
 expect(wrapAt).toBeGreaterThanOrEqual(0);expect(wrapAt).toBeLessThan(sendAt);
 expect(w.find('data-enhance-provider','composer')!.children.map(o=>o.textContent)).toContain('Claude');
 expect(w.window.EchoPrimeMediaRouter.mountEnhance({name:'composer',textarea:()=>null,mode:()=>'chat',mount(){throw new Error('mounted twice');}}).button).toBe(button);
});
it('alternative selection applies it and reports the choice',async()=>{const w=await harness();w.studio.open('auto','fox');await tick();w.find('data-media-alternative',alternative.id)!.click();expect(w.studio.apply).toHaveBeenLastCalledWith({id:alternative.id,arguments:alternative.request.arguments});expect(w.find('data-media-auto')!.textContent).toContain('You chose FLUX Max');});
it('failed picks offer but never automatically apply the alternative',async()=>{const w=await harness();w.studio.open('auto','fox');await tick();w.studio.apply.mockClear();w.window.dispatchEvent(new (class extends TestEvent{} )('echo-studio-executed',{detail:{state:'blocked',detail:'boom',name:defaultPick.id}}));const failure=w.find('data-media-failure')!;expect(failure.hidden).toBe(false);expect(failure.textContent).toContain('Nothing was retried');expect(failure.textContent).toContain('Use FLUX Max instead');expect(w.studio.apply).not.toHaveBeenCalled();w.find('data-media-next',alternative.id)!.click();expect(w.studio.apply).toHaveBeenCalledWith({id:alternative.id,arguments:alternative.request.arguments});});
it('refused and failed trigger offers, returned does not, and uncertain warns',async()=>{for(const state of ['refused','failed','uncertain']){const w=await harness();w.studio.open('auto','fox');await tick();w.window.dispatchEvent(new TestEvent('echo-studio-executed',{detail:{state,name:defaultPick.id}}));expect(w.find('data-media-failure')!.hidden).toBe(false);if(state==='uncertain')expect(w.find('data-media-failure')!.textContent).toContain('outcome is unknown');}const w=await harness();w.studio.open('auto','fox');await tick();w.window.dispatchEvent(new TestEvent('echo-studio-executed',{detail:{state:'returned',name:defaultPick.id}}));expect(w.find('data-media-failure')!.hidden).toBe(true);});
it('composer Enhance uses Claude and replaces text without submitting',async()=>{const w=await harness();w.prompt.value='fox';w.find('data-enhance','composer')!.click();await tick();expect(w.calls.find(c=>c.url==='/api/prime/enhance').body).toEqual({mode:'chat',text:'fox',provider:'claude'});expect(w.prompt.value).toBe('ENHANCED');expect(w.find('data-enhance-added','composer')!.textContent).toContain('golden hour');const note=w.find('data-enhance-note','composer')!.textContent;expect(note).toContain('Claude');expect(note).toContain('claude-sonnet-5-5');expect(note).toContain('Nothing was sent');expect(w.ownSubmit).not.toHaveBeenCalled();});
it('Undo restores the exact original prompt',async()=>{const w=await harness();w.prompt.value='  fox exactly  ';w.find('data-enhance','composer')!.click();await tick();w.find('data-enhance-undo','composer')!.click();expect(w.prompt.value).toBe('  fox exactly  ');});
it('does not replace text changed while Enhance is pending',async()=>{const w=await harness({pendingEnhance:true});w.prompt.value='fox';w.find('data-enhance','composer')!.click();await tick();w.prompt.value='changed';w.resolveEnhance();await tick();expect(w.prompt.value).toBe('changed');expect(w.find('data-enhance-note','composer')!.textContent).toContain('changed while enhancing');});
it('lists providers and sends the selected GPT provider',async()=>{const w=await harness(),select=w.find('data-enhance-provider','composer')!;expect(select.children.map(o=>o.textContent)).toEqual(['Claude','GPT','Grok (unavailable)','Gemini (Argon)','Qwen']);expect(select.children[2].disabled).toBe(true);select.value='gpt';select.dispatchEvent(new TestEvent('change'));w.prompt.value='fox';w.find('data-enhance','composer')!.click();await tick();expect(w.calls.find(c=>c.url==='/api/prime/enhance').body.provider).toBe('gpt');});
it('applies member, signed-out, and unconfigured-model gates',async()=>{for(const config of [{workspace:{session:{authenticated:true,ownerAccess:false}},want:'owner only'},{workspace:{session:{authenticated:false,ownerAccess:false}},want:'Sign in'},{models:{configured:false,providers:[]},want:'models section'}]){const w=await harness(config),button=w.find('data-enhance','composer')!;expect(button.disabled).toBe(true);expect(w.find('data-enhance-note','composer')!.textContent).toContain(config.want);button.click();await tick();expect(w.calls.some(c=>c.url==='/api/prime/enhance')).toBe(false);}});
it('rejects Enhance text over 4000 characters locally',async()=>{const w=await harness();w.prompt.value='x'.repeat(4001);w.find('data-enhance','composer')!.click();await tick();expect(w.calls.some(c=>c.url==='/api/prime/enhance')).toBe(false);expect(w.find('data-enhance-note','composer')!.textContent).toContain('shorten');});
it('merges live-only records into the Studio before applying the pick and badges the live catalog',async()=>{
 const records=[{id:defaultPick.id,registered:true,health:'green',category:'image',description:'live only'}];
 const w=await harness({route:()=>({...mediaResult(),records,catalog:{source:'live',queries:['flux'],listed:1,failed:[],cached:false}})});
 w.studio.open('auto','fox');await tick();
 expect(w.studio.merge).toHaveBeenCalledWith(records);expect(w.studio.merge.mock.invocationCallOrder[0]).toBeLessThan(w.studio.apply.mock.invocationCallOrder[0]);
 expect(w.find('data-media-auto')!.textContent).toContain('live catalog');expect(w.find('data-media-auto')!.textContent).not.toContain('shipped snapshot');
});
it('labels a snapshot-only ranking and says why, for a pick and for no pick',async()=>{
 const catalog={source:'snapshot',queries:[],listed:0,failed:[],cached:false,reason:'The live capability catalog is not connected.'};
 const w=await harness({route:()=>({...mediaResult(),catalog})});w.studio.open('auto','fox');await tick();
 const panel=w.find('data-media-auto')!;expect(panel.textContent).toContain('shipped snapshot · not live');expect(panel.textContent).toContain('The live capability catalog is not connected.');
 const none=await harness({route:()=>({...mediaResult(),picked:null,alternatives:[],reason:'No healthy image generator is listed.',catalog:{...catalog,source:'partial',queries:['a','b'],failed:[{query:'a',reason:'x'}],reason:'1 of 2 live catalog searches failed.'}})});none.studio.open('auto','fox');await tick();
 expect(none.find('data-media-auto')!.textContent).toContain('No healthy image generator is listed. 1 of 2 live catalog searches failed.');
});
it('integrations.js merge adds a live-only tool under its medium so apply can select it',()=>{
 class El {tagName:string;value='';textContent='';className='';disabled=false;checked=false;open=false;children:El[]=[];attributes:Record<string,string>={};constructor(tag='div'){this.tagName=tag.toUpperCase();}
  append(...items:El[]){this.children.push(...items);}replaceChildren(...items:El[]){this.children=[...items];}setAttribute(k:string,v:string){this.attributes[k]=String(v);}addEventListener(){}showModal(){this.open=true;}close(){this.open=false;}focus(){}}
 const nodes=new Map<string,El>(),get=(s:string)=>{if(!nodes.has(s))nodes.set(s,new El());return nodes.get(s)!;};get('#creative-category').value='all';
 const window:any={EchoPrimeCatalog:{capabilities:[{id:'echo.media.image_generate',category:'image',description:'fixture',health:'unknown',registered:true}],models:[]},addEventListener(){}};
 runInNewContext(readFileSync(new URL('../ui/echo-prime/integrations.js',import.meta.url),'utf8'),{window,document:{querySelector:get,createElement:(t:string)=>new El(t)},location:{protocol:'https:'},AbortController,AbortSignal,console:{debug(){}},CustomEvent:class {}});
 const studio=window.EchoPrimeStudio,flux='echo.llm.together.black-forest-labs-FLUX.2-max',args={command:'generate',options:{prompt:'fox'}};
 expect(studio.apply({id:flux,arguments:args})).toBe(false);
 expect(studio.merge([{id:flux,category:'image',health:'green',registered:true,description:'live'},{id:'echo.bad id',category:'image'},{id:'echo.media.image_generate',health:'green',category:'video'}])).toBe(1);
 expect(studio.catalog().find((c:any)=>c.id===flux)).toMatchObject({category:'image',health:'green',description:'live'});
 expect(studio.catalog().find((c:any)=>c.id==='echo.media.image_generate')).toMatchObject({category:'image',health:'green',description:'fixture'});
 expect(get('#creative-tools').children).toHaveLength(2);
 expect(studio.apply({id:flux,arguments:args})).toBe(true);expect(get('#selected-tool').textContent).toBe(flux);expect(JSON.parse(get('#creative-arguments').value)).toEqual(args);
});
// The reset hides notes; the loading gate note clears itself once the models report answers (fixed after this test found it).
it('account changes reset Auto and panels and re-fetch models',async()=>{const w=await harness();w.tabs.children[0].click();w.studio.open('auto','fox');await tick();const before=w.modelsCalls().length;w.window.dispatchEvent(new TestEvent('echo-account-changed'));await tick();expect(w.tabs.children[0].getAttribute('aria-selected')).toBe('false');expect(w.find('data-media-auto')!.hidden).toBe(true);expect(w.find('data-enhance-note','composer')!.hidden).toBe(true);expect(w.find('data-enhance-note','composer')!.textContent).toBe('');expect(w.modelsCalls().length).toBeGreaterThan(before);});

const statusNode=(w:any)=>w.all().find((n:any)=>n.className==='media-status');
it('a 403 from the router re-reads the session and shows the refusal; it never signs the owner out',async()=>{
 const recheck=vi.fn(async()=>({authenticated:true}));
 const w=await harness({routeStatus:403,route:{error:'Same-origin Prime session required'},workspace:{recheck}});
 w.studio.open('image','a red fox');await tick();
 expect(recheck).toHaveBeenCalledOnce();expect(w.workspace.invalidate).not.toHaveBeenCalled();
 expect(statusNode(w).textContent).toBe('Same-origin Prime session required. Pick a tool from the list below instead.');
});
it('Enhance skips a provider whose last enhance failed sign-in when it picks the default, and says so',async()=>{
 const w=await harness({models:{configured:true,providers:[{id:'claude',available:true},{id:'gpt',available:true}],enhance:{failures:{claude:{category:'auth',reason:'OAuth session expired',at:'2026-11-06T09:00:00Z'}}}}});
 const select=w.find('data-enhance-provider','composer')!;expect(select.value).toBe('gpt');
 expect((w.find('data-enhance','composer') as any).title).toContain('Skipped Claude: its last enhance could not sign in.');
 w.prompt.value='fox';w.find('data-enhance','composer')!.click();await tick();
 expect(w.calls.find(c=>c.url==='/api/prime/enhance').body.provider).toBe('gpt');
});
it('an Enhance sign-in failure keeps the prompt, punctuates the sentence and moves the next press to the next provider',async()=>{
 const w=await harness({enhanceStatus:503,enhance:{error:'Claude (claude CLI) is unavailable: Failed to authenticate: OAuth session expired and could not be refreshed; no fallback was used'}});
 w.prompt.value='fox';w.find('data-enhance','composer')!.click();await tick();
 expect(w.prompt.value).toBe('fox');
 expect(w.find('data-enhance-note','composer')!.textContent).toBe('Claude (claude CLI) is unavailable: Failed to authenticate: OAuth session expired and could not be refreshed; no fallback was used. Your prompt was not changed. GPT is selected for your next try; press Enhance again to use it.');
 expect(w.find('data-enhance-provider','composer')!.value).toBe('gpt');
});
it('names the enhanced mode with the right article',async()=>{
 const w=await harness();w.prompt.value='fox';w.find('data-enhance','composer')!.click();await tick();
 expect(w.find('data-enhance-note','composer')!.textContent).toContain('as an image prompt');
});
it('shows the provider message on a failed pick, not the raw provider JSON',async()=>{
 const w=await harness();w.studio.open('auto','fox');await tick();
 w.window.dispatchEvent(new TestEvent('echo-studio-executed',{detail:{state:'blocked',name:defaultPick.id,detail:'HTTP 402: {"error":{"message":"Insufficient credits. This account never purchased credits.","code":402}}'}}));
 const text=w.find('data-media-failure')!.textContent;
 expect(text).toContain('did not complete (blocked): HTTP 402: Insufficient credits. This account never purchased credits. Nothing was retried.');
 expect(text).not.toContain('{"error"');
});
it('an account change clears the router status line',async()=>{
 const w=await harness();w.studio.open('auto','fox');await tick();expect(statusNode(w).textContent).not.toBe('');
 w.window.dispatchEvent(new TestEvent('echo-account-changed'));await tick();expect(statusNode(w).textContent).toBe('');
});
it('badges a snapshot-only pick under a live catalog honestly and marks a demoted alternative',async()=>{
 const w=await harness({route:()=>({...mediaResult(),picked:{...defaultPick,catalogSource:'snapshot'},alternatives:[{...alternative,demoted:{category:'billing',reason:'OpenRouter refused for billing'},reason:'Picked FLUX Max because image · ranked lower: OpenRouter refused for billing'}],catalog:{source:'live',queries:['flux'],listed:1,failed:[],cached:false}})});
 w.studio.open('auto','fox');await tick();
 const panel=w.find('data-media-auto')!.textContent;
 expect(panel).toContain('live catalog searched · this tool from the snapshot');
 expect(w.find('data-media-alternative',alternative.id)!.textContent).toContain('last run: billing');
 expect(w.find('data-media-alternative',alternative.id)!.textContent).toContain('ranked lower: OpenRouter refused for billing');
});
it('applies the pick with its template and the length the route read from the brief',async()=>{
 const template={envelope:'llm',verb:'call',textKey:'prompt',fixed:{},duration:{key:'seconds',unit:'s-string',min:1,max:10},modeled:true,source:'family'};
 const w=await harness({route:()=>({...mediaResult(),classification:{kind:'video',confidence:1,styles:[],durationSeconds:5},picked:{...defaultPick,template}})});
 w.studio.open('video','a boat, 5 seconds');await tick();
 expect(w.studio.apply).toHaveBeenLastCalledWith({id:defaultPick.id,arguments:defaultPick.request.arguments,template,durationSeconds:5});
});
