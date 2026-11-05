import {debuglog} from 'node:util';
import {validateEndpoint} from '../code/model.js';
import {redact} from '../code/workspace.js';
import {WorkspaceHttpError} from './workspace.js';
/**
 * Client for the ShadowGlass control relay — the Commander's OWN signed-in Chrome, driven through the
 * browser extension's loopback relay (POST <relay>/rpc, `{type, ...}` → `{ok, data?, error?}`). Prime runs on
 * FORGE and only ever talks to loopback; a reverse SSH tunnel publishes the QUENCH relay at FORGE
 * 127.0.0.1:9780 (task EchoShadowGlass-Relay-Forge). This client is subprocess-free and token-free: plain
 * fetch with 10 s timeouts, response-size caps, `redirect:'error'`, a strict allowlist of relay RPC types
 * mapped to Prime verbs, http/https-only URLs, and every returned string redacted. It never touches the
 * relay's token-gated /vault or /brain routes, never opens extra windows (it drives the owner's live Chrome),
 * and never types credentials. Owner-only is enforced by the Prime server, not here.
 */
export const BROWSER_DEFAULT_RELAY='http://127.0.0.1:9780';
export const BROWSER_TEXT_MAX=65536;          // 64 KiB cap on any owner-supplied text (type/fill)
export const BROWSER_SHOT_MAX=2*1024*1024;     // 2 MiB cap on a screenshot data URL
const RESPONSE_MAX=1048576;                    // 1 MiB cap on an ordinary relay response
const SHOT_RESPONSE_MAX=BROWSER_SHOT_MAX+65536;// a little slack so an over-cap shot is read then rejected
const MAX_SCROLL=100000;
const DATA_URL=/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const debug=debuglog('echo-prime');
/** Fixed CDP expressions for verbs the relay has no RPC for. NEVER built from caller input. */
const NAV_EXPR={back:'history.back()',forward:'history.forward()',reload:'location.reload()'} as const;
const METRICS_EXPR='JSON.stringify([innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY,document.body?document.body.scrollHeight:0])';
export type NavVerb=keyof typeof NAV_EXPR;
export interface BrowserConfig {relayUrl:string}
export const DEFAULT_BROWSER:BrowserConfig={relayUrl:BROWSER_DEFAULT_RELAY};
/** Carries an HTTP status so the Prime server answers 4xx/5xx instead of a blanket 400. */
export class BrowserError extends WorkspaceHttpError {}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const isTab=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
/** Strict, like parseSwarmConfig: unknown fields and any non-loopback origin are refused; absent section = off. */
export function parseBrowserConfig(value:unknown):BrowserConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid browser configuration: browser must be an object');
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(key!=='relayUrl')throw new Error('Invalid browser configuration: unknown field');
 let relayUrl=DEFAULT_BROWSER.relayUrl;
 if(input.relayUrl!==undefined){if(typeof input.relayUrl!=='string')throw new Error('Invalid browser configuration: relayUrl');relayUrl=input.relayUrl;}
 try{validateEndpoint(relayUrl);}catch{throw new Error('Invalid browser configuration: relayUrl must be a credential-free loopback origin');}
 return {relayUrl:new URL(relayUrl).origin};
}
/** Recursively redacts every string and bounds depth, breadth and string length before anything reaches the browser. */
export function sanitize(value:unknown,depth=0):unknown{
 if(typeof value==='string')return redact(value.length>20000?value.slice(0,20000)+'…':value);
 if(value===null||typeof value==='number'||typeof value==='boolean')return value;
 if(depth>=10)return null;
 if(Array.isArray(value))return value.slice(0,300).map(v=>sanitize(v,depth+1));
 if(typeof value==='object'){
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(value as Record<string,unknown>).slice(0,100))if(k!=='__proto__')out[redact(k.slice(0,120))]=sanitize(v,depth+1);
  return out;
 }
 return undefined;
}
/** http/https only — never file:, chrome:, javascript:, data:, about:, etc. Returns the normalized href. */
export function assertWebUrl(value:unknown):string{
 if(typeof value!=='string'||value.length>4096)throw new BrowserError(400,'A URL is required');
 let url:URL;try{url=new URL(value);}catch{throw new BrowserError(400,'Enter a valid absolute URL');}
 if(url.protocol!=='http:'&&url.protocol!=='https:')throw new BrowserError(400,'Only http:// and https:// URLs are allowed');
 return url.href;
}
function boundedText(value:unknown):string{
 if(typeof value!=='string')throw new BrowserError(400,'Text is required');
 if(value.length>BROWSER_TEXT_MAX)throw new BrowserError(400,'Text exceeds the 64 KiB limit');
 return value;
}
export interface BrowserTab {id:number;url:string;title:string;active:boolean;windowId?:number;incognito?:boolean}
export interface BrowserSnapshot {tab:number;url:string;title:string;text:string;nodes:unknown[];screenshot?:string;metrics?:Record<string,number>;screenshotReason?:string}
export class BrowserClient {
 readonly config:BrowserConfig;private origin:URL;
 constructor(config:BrowserConfig=DEFAULT_BROWSER,private timeouts={rpc:10000,shot:10000}){
  this.origin=validateEndpoint(config.relayUrl);
  this.config={relayUrl:this.origin.origin};
 }
 /** One POST to <relay>/rpc. Maps the relay's ok:false / 503 surface to HTTP statuses the server can answer. */
 private async rpc(type:string,args:Record<string,unknown>={},opts:{ms?:number;maxBytes?:number}={},signal?:AbortSignal):Promise<unknown>{
  const ms=opts.ms??this.timeouts.rpc,maxBytes=opts.maxBytes??RESPONSE_MAX;
  const url=new URL('/rpc',this.origin);
  if(url.origin!==this.origin.origin)throw new BrowserError(400,'Relay route refused');
  let response:Response;
  try{
   response=await fetch(url,{method:'POST',redirect:'error',headers:{accept:'application/json','content-type':'application/json'},
    body:JSON.stringify({type,...args}),signal:AbortSignal.any([AbortSignal.timeout(ms),...(signal?[signal]:[])])});
  }catch(error){
   if(signal?.aborted)throw new BrowserError(499,'Interrupted');
   if(error instanceof Error&&error.name==='TimeoutError')throw new BrowserError(504,'ShadowGlass relay timed out after '+Math.round(ms/1000)+' s; outcome unknown');
   throw new BrowserError(502,'ShadowGlass relay unreachable at '+this.origin.origin+' (is the EchoShadowGlass-Relay-Forge tunnel up and the side panel open?)');
  }
  const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{
   if(reader)for(;;){
    const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>maxBytes)throw new BrowserError(502,'Relay response exceeds the '+Math.round(maxBytes/1024)+' KiB limit');
    chunks.push(value);
   }
  }catch(error){if(error instanceof BrowserError)throw error;throw new BrowserError(504,'Relay response was interrupted');}
  finally{await reader?.cancel().catch(()=>undefined);}
  let parsed:unknown;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{parsed=undefined;}
  const data=obj(parsed);
  if(response.status===503||data.error==='ext_offline')throw new BrowserError(502,'ShadowGlass extension is not connected; open the side panel on the Commander\'s Chrome');
  if(!response.ok)throw new BrowserError(response.status<500?400:502,'Relay answered HTTP '+response.status);
  if(data.ok!==true){
   const raw=typeof data.error==='string'?data.error:'relay refused the action';
   if(/^refused_secret/.test(raw))throw new BrowserError(400,'The extension refused a credential-bearing field; Prime never drives secret inputs');
   throw new BrowserError(/^unknown_rpc/.test(raw)?400:502,'Relay error: '+redact(raw).slice(0,200));
  }
  return data.data;
 }
 private log(verb:string,tab:number|null,url?:string){debug('%j',{event:'prime_browser_action',verb,tab,url:url?redact(url).slice(0,300):undefined});}
 /** Relay GET /status — whether the extension's service worker is connected. Does NOT attach the debugger. */
 async health(signal?:AbortSignal):Promise<{extConnected:boolean;version?:string}>{
  const url=new URL('/status',this.origin);
  let response:Response;
  try{response=await fetch(url,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])});}
  catch(error){
   if(signal?.aborted)throw new BrowserError(499,'Interrupted');
   if(error instanceof Error&&error.name==='TimeoutError')throw new BrowserError(504,'ShadowGlass relay status timed out');
   throw new BrowserError(502,'ShadowGlass relay unreachable at '+this.origin.origin);
  }
  if(!response.ok)throw new BrowserError(502,'Relay status HTTP '+response.status);
  const data=obj(await response.json().catch(()=>undefined));
  return {extConnected:data.ext_connected===true,version:typeof data.version==='string'?redact(data.version).slice(0,40):undefined};
 }
 async tabs(signal?:AbortSignal):Promise<BrowserTab[]>{
  const rows=await this.rpc('tabs_list',{},{},signal);
  this.log('tabs',null);
  if(!Array.isArray(rows))return [];
  return rows.filter(isTabRow).map(r=>({id:r.id as number,url:redact(String(r.url??'')).slice(0,2048),title:redact(String(r.title??'')).slice(0,400),active:!!r.active,windowId:Number(r.windowId)||undefined,incognito:!!r.incognito}));
 }
 async open(url:unknown,signal?:AbortSignal):Promise<{id:number;url:string}>{
  const href=assertWebUrl(url);
  const data=obj(await this.rpc('tabs_new',{url:href,active:false},{},signal));
  this.log('open',isTab(data.id)?data.id:null,href);
  if(!isTab(data.id))throw new BrowserError(502,'Relay did not return a new tab id');
  return {id:data.id,url:redact(String(data.url??href)).slice(0,2048)};
 }
 async close(tab:unknown,signal?:AbortSignal):Promise<{closed:number}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  await this.rpc('tabs_close',{id:tab},{},signal);this.log('close',tab);return {closed:tab};
 }
 async navigate(tab:unknown,url:unknown,signal?:AbortSignal):Promise<{tab:number;url:string}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  const href=assertWebUrl(url);
  await this.rpc('navigate',{tabId:tab,url:href},{},signal);this.log('navigate',tab,href);return {tab,url:href};
 }
 /** back/forward/reload via fixed CDP expressions (the relay has no RPC for them). */
 async nav(tab:unknown,verb:NavVerb,signal?:AbortSignal):Promise<{tab:number;verb:NavVerb}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  const expression=NAV_EXPR[verb];
  if(!expression)throw new BrowserError(400,'Unknown navigation verb');
  await this.rpc('cdp_evaluate',{tabId:tab,expression},{},signal);this.log(verb,tab);return {tab,verb};
 }
 async scroll(tab:unknown,dy:unknown,signal?:AbortSignal):Promise<{tab:number;dy:number}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  if(typeof dy!=='number'||!Number.isFinite(dy))throw new BrowserError(400,'Scroll distance must be a number');
  const n=Math.max(-MAX_SCROLL,Math.min(MAX_SCROLL,Math.trunc(dy)));
  await this.rpc('cdp_evaluate',{tabId:tab,expression:`window.scrollBy(0,${n})`},{},signal);this.log('scroll',tab);return {tab,dy:n};
 }
 /** Trusted click at viewport coordinates (the UI scale-corrects image px → viewport px with the snapshot metrics). */
 async click(tab:unknown,target:{x?:unknown;y?:unknown;text?:unknown},signal?:AbortSignal):Promise<{tab:number;clicked:string}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  if(typeof target.text==='string'){
   const text=boundedText(target.text);if(!text.trim())throw new BrowserError(400,'Click text is required');
   await this.rpc('click_text',{tabId:tab,text:text.slice(0,2000)},{},signal);this.log('click',tab);return {tab,clicked:'text'};
  }
  const x=Number(target.x),y=Number(target.y);
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>20000||y>20000)throw new BrowserError(400,'Click coordinates out of range');
  await this.rpc('cdp_click_at',{tabId:tab,x:Math.round(x),y:Math.round(y)},{},signal);this.log('click',tab);return {tab,clicked:'point'};
 }
 /** Raw keystrokes into the focused element (after a click). Never credentials. */
 async type(tab:unknown,text:unknown,signal?:AbortSignal):Promise<{tab:number;typed:true}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  const value=boundedText(text);
  await this.rpc('cdp_type',{tabId:tab,text:value},{},signal);this.log('type',tab);return {tab,typed:true};
 }
 /** Fill a named field by selector (content script; refuses secret fields). */
 async fill(tab:unknown,selector:unknown,value:unknown,signal?:AbortSignal):Promise<{tab:number;filled:true}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  if(typeof selector!=='string'||!selector.trim()||selector.length>2000)throw new BrowserError(400,'A field selector is required');
  const text=boundedText(value);
  await this.rpc('fill',{tabId:tab,selector,text},{},signal);this.log('fill',tab);return {tab,filled:true};
 }
 async read(tab:unknown,selector:unknown,signal?:AbortSignal):Promise<{tab:number;value:string}>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  if(typeof selector!=='string'||!selector.trim()||selector.length>2000)throw new BrowserError(400,'A field selector is required');
  const data=obj(await this.rpc('read_field',{tabId:tab,selector},{},signal));this.log('read',tab);
  return {tab,value:redact(String(data.value??'')).slice(0,20000)};
 }
 /**
  * Live view of a tab: readable text + a11y nodes always; a full-page screenshot and viewport metrics only
  * when `withShot` (screenshots attach the debugger and can time out — then the card shows text instead).
  */
 async snapshot(tab:unknown,withShot=false,signal?:AbortSignal):Promise<BrowserSnapshot>{
  if(!isTab(tab))throw new BrowserError(400,'Invalid tab id');
  const page=obj(await this.rpc('page_content',{tabId:tab,limit:120},{},signal));this.log('snapshot',tab,String(page.url??''));
  const out:BrowserSnapshot={tab,url:redact(String(page.url??'')).slice(0,2048),title:redact(String(page.title??'')).slice(0,400),
   text:redact(String(page.body??'')).slice(0,20000),nodes:Array.isArray(page.nodes)?(sanitize(page.nodes) as unknown[]):[]};
  if(!withShot)return out;
  try{
   const shot=await this.rpc('cdp_screenshot',{tabId:tab},{ms:this.timeouts.shot,maxBytes:SHOT_RESPONSE_MAX},signal);
   const dataUrl=obj(shot).dataUrl;
   if(typeof dataUrl!=='string'||dataUrl.length>BROWSER_SHOT_MAX||!DATA_URL.test(dataUrl))out.screenshotReason='Screenshot unavailable or too large; showing readable text.';
   else out.screenshot=dataUrl; // a validated image data: URL — passed through untouched, never redacted (it is not text)
  }catch(e){if(e instanceof BrowserError&&e.status===499)throw e;out.screenshotReason=e instanceof BrowserError?e.message:'Screenshot failed; showing readable text.';}
  if(out.screenshot){
   try{
    const m=await this.rpc('cdp_evaluate',{tabId:tab,expression:METRICS_EXPR},{},signal);
    const a=JSON.parse(String(m));
    if(Array.isArray(a)&&a.length>=6&&a.every(n=>typeof n==='number'&&Number.isFinite(n)))out.metrics={innerWidth:a[0],innerHeight:a[1],dpr:a[2],scrollX:a[3],scrollY:a[4],scrollHeight:a[5]};
   }catch(e){if(e instanceof BrowserError&&e.status===499)throw e;/* no metrics → the UI will not scale-correct clicks on this frame */}
  }
  return out;
 }
}
function isTabRow(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&isTab((v as Record<string,unknown>).id);}
