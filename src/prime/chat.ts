import {debuglog} from 'node:util';
import type {Workspace} from '../code/workspace.js';
import type {SessionStore} from '../code/sessions.js';
import {runSharedTurn,type CodingAdmission,type CodingInvoker} from '../code/shared.js';
import {runTurn,type TurnResult} from '../code/agent.js';
import {isModelId,type ModelId,type ModelRouter,type AnswerInfo} from '../code/model-factory.js';
/** Either the authenticated host path (invoke + admission) or a reviewed model router (Qwen on loopback, or a vendor CLI). */
export interface SharedChatOptions {workspace:Workspace;store:SessionStore;invoke?:CodingInvoker;admission?:CodingAdmission;models?:ModelRouter}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const debug=debuglog('echo-prime');
/** Attached by an authenticated embedding host. Browser data cannot select an
 * invoker, admission, workspace, model name, proposal mode or credentials. When a
 * model router is configured the browser may only pick a provider id from the
 * reviewed list; the model behind it comes from the reviewed configuration. */
export class SharedChat {
 private busy=false;private used=new Set<string>();private options:SharedChatOptions;
 constructor(options:SharedChatOptions){
  if(!options.models&&!(typeof options.invoke==='function'&&options.admission))throw new Error('Shared chat needs a model router or an authenticated host invoker with owner admission');
  this.options={...options,...(options.admission?{admission:{...options.admission}}:{})};
 }
 status(){
  const models=this.options.models;
  if(models)return {state:'attached',busy:this.busy,mode:'read-only',routing:true,defaultProvider:models.defaultId,detail:'Model router attached; the selected provider answers and no other provider is used as a fallback'};
  return {state:'attached',busy:this.busy,mode:'read-only',routing:false,detail:'Host attached; pinned owner contract and coding.invoke are checked on every turn'};
 }
 async submit(input:unknown,signal?:AbortSignal):Promise<TurnResult&{requestId:string;model?:AnswerInfo}>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid chat request');
  const data=input as Record<string,unknown>;
  if(Object.keys(data).some(k=>!['requestId','prompt','sessionId','provider'].includes(k))||
   typeof data.requestId!=='string'||!uuid.test(data.requestId)||typeof data.prompt!=='string'||
   !data.prompt.trim()||data.prompt.length>12000||
   (data.sessionId!==undefined&&(typeof data.sessionId!=='string'||!uuid.test(data.sessionId))))throw new Error('Invalid chat request');
  const {requestId,prompt}=data;
  const router=this.options.models;
  if(data.provider!==undefined){
   if(!isModelId(data.provider))throw new Error('Invalid chat request');
   if(!router)throw new Error('Model selection is not configured; this host answers with its pinned model');
  }
  const provider:ModelId|undefined=router?(data.provider===undefined?router.defaultId:data.provider as ModelId):undefined;
  if(this.used.has(requestId))throw new Error('Chat request already submitted; no automatic replay');
  if(this.busy)throw new Error('Chat is busy; wait for the current turn');
  if(this.used.size>=1000)throw new Error('Chat host request limit reached');
  if(signal?.aborted)throw new Error('Interrupted');
  const {workspace,store,invoke,admission}=this.options;
  const sessionModel=router&&provider?router.sessionModel(provider):'qwen2.5-coder:7b';
  const session=data.sessionId?store.get(data.sessionId as string):store.create(workspace.root,sessionModel);
  if(session.workspace!==workspace.root)throw new Error('Chat session workspace/model mismatch');
  if(session.model!==sessionModel)throw new Error(router?'This conversation was started with a different model; start a new conversation to switch models':'Chat session workspace/model mismatch');
  if(session.proposals.some(p=>p.status==='pending'||p.status==='applying'||p.status==='reverting'))throw new Error('Review existing session proposals before browser chat');
  this.busy=true;this.used.add(requestId);
  const started=performance.now(),controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,120000);
  debug('%j',{event:'prime_chat_started',requestId,sessionId:session.id,mode:'read-only'});
  try{
   if(router&&provider){
    const turn=router.turn(provider);
    const result=await runTurn({workspace,store,model:turn.model,sessionId:session.id,prompt,mode:'read-only',maxSteps:10,signal:controller.signal});
    turn.answered();
    debug('%j',{event:'prime_chat_finished',requestId,sessionId:session.id,provider,status:result.status,durationMs:Math.round(performance.now()-started)});
    return {...result,requestId,model:turn.info()};
   }
   const result=await runSharedTurn({workspace,store,invoke:invoke!,admission:admission!,sessionId:session.id,prompt,
    mode:'read-only',maxSteps:10,signal:controller.signal});
   debug('%j',{event:'prime_chat_finished',requestId,sessionId:session.id,status:result.status,durationMs:Math.round(performance.now()-started)});
   return {...result,requestId};
  }catch(error){debug('%j',{event:'prime_chat_refused',requestId,durationMs:Math.round(performance.now()-started)});throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.busy=false;}
 }
}
