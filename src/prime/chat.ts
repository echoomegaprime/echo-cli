import {debuglog} from 'node:util';
import type {Workspace} from '../code/workspace.js';
import {redact} from '../code/workspace.js';
import type {SessionStore,Message} from '../code/sessions.js';
import {runSharedTurn,type CodingAdmission,type CodingInvoker} from '../code/shared.js';
import {runTurn,type TurnResult,type Persona} from '../code/agent.js';
import {AUTO_ID,isChatProvider,isModelId,VARIANT_ARG,type ModelId,type ModelRouter,type AnswerInfo,type RouteInfo} from '../code/model-factory.js';
import {ProviderDeclinedError} from '../code/providers.js';
import {detectRefusal,type RefusalDetection} from '../code/refusal.js';
import {checkClaims,extractClaims,type Claim} from '../code/claims.js';
import type {Model} from '../code/model.js';
import {abortable,throwIfAborted} from '../code/cancellation.js';
import type {PersonalityForge,CatalogLoader,Selection} from './personality.js';
import {DEFAULT_TOOLS,type ToolKit,type TurnExecutor} from '../code/tools/index.js';
import type {AutoAgents} from '../code/tools/autoagents.js';
import {OwnerBotTools} from './bot-tools.js';
import {PrimeAutonomyHooks,type BeforeTurn,type AutonomyActivity} from './autonomy-hooks.js';
import {isPrimeRole,type PrimeRole,type RoleState} from './roles.js';
export interface ChatConfig {turnTimeoutMs:number}
/** Reviewed host configuration only; a chat section never enables a model or owner connection. */
export function parseChatConfig(value:unknown):ChatConfig{
 const input=value===undefined?{}:value;
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='turnTimeoutMs'))throw new Error('Invalid chat configuration: only turnTimeoutMs is supported');
 const requested=(input as Record<string,unknown>).turnTimeoutMs;
 const turnTimeoutMs=requested===undefined?120000:requested;
 if(typeof turnTimeoutMs!=='number'||!Number.isInteger(turnTimeoutMs)||turnTimeoutMs<1000||turnTimeoutMs>300000)throw new Error('chat.turnTimeoutMs must be an integer between 1000 and 300000');
 return {turnTimeoutMs};
}
/** Either the authenticated host path (invoke + admission) or a reviewed model router (Qwen on loopback, or a vendor CLI). `tools` = the always-on live tools (web, Wolfram, knowledge, skills, MCP) for router turns. */
export interface SharedChatOptions {
 workspace:Workspace;store:SessionStore;invoke?:CodingInvoker;admission?:CodingAdmission;models?:ModelRouter;personality?:PersonalityForge;tools?:ToolKit;autonomyHooks?:PrimeAutonomyHooks;autoagents?:AutoAgents;
 /** Host-only turn deadline. Defaults to 120000 ms; browser/model requests cannot override it. */
 turnTimeoutMs?:number;
}
/** Per-request context the server binds: the Workspace personality catalog loader (owner cookie), never browser data. */
export interface SubmitContext {personalities?:CatalogLoader}
export interface PersonalityTag {id:string;name:string;reason:string;pinned:boolean}
export interface ChatReply extends TurnResult {requestId:string;model?:AnswerInfo;personality?:PersonalityTag;role?:RoleState;activity?:AutonomyActivity[];autoagents?:unknown[];delegatedTasks?:unknown[]}
export interface VerifiedClaim extends Claim {verified:boolean;source:string|null}
export interface VerifyReply {requestId:string;sessionId:string;answer:string;claims:VerifiedClaim[];summary:{total:number;verified:number;unverified:number};account:{text:string;model:AnswerInfo}|null;answerVerification:'unverified_model_text'}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The longest prompt one chat turn accepts, attached upload text included (hub.chat checks it before submit). */
export const CHAT_PROMPT_MAX=12000;
const debug=debuglog('echo-prime');
const TOOL_PREFIX='UNTRUSTED TOOL RESULT (';
const VERIFY_SYSTEM='You are reviewing your own previous answer for evidence. You have no tools. For each listed claim, state exactly what you relied on: quote the tool result it came from (by action and path or query) or the user\'s message, or write "no evidence: general knowledge or inference" or "no evidence: unsupported". Never invent evidence. Reply with exactly one JSON object {"action":"final","content":"<one line per claim, in order>"} and nothing else.';
/** Attached by an authenticated embedding host. Browser data cannot select an
 * invoker, admission, workspace, model name, proposal mode or credentials. When a
 * model router is configured the browser may only pick a provider id from the
 * reviewed list (or "auto" when auto mode is enabled); the model behind it comes
 * from the reviewed configuration. The one exception is Argon (Gemini via agy): the
 * browser may name a `model`, accepted only if agy currently lists it.
 *
 * Commander directives 2026-11-04: auto mode routes each turn by task class (chosen before the call);
 * a vendor that DECLINES is re-run on Qwen and the reply is labelled (never for an outage); the
 * Personality Forge picks a personality per turn; every completed reply carries a claim check. */
export class SharedChat {
 private busy=false;private used=new Set<string>();private options:SharedChatOptions;private readonly turnTimeoutMs:number;
 constructor(options:SharedChatOptions){
  if(!options.models&&!(typeof options.invoke==='function'&&options.admission))throw new Error('Shared chat needs a model router or an authenticated host invoker with owner admission');
  this.turnTimeoutMs=parseChatConfig({turnTimeoutMs:options.turnTimeoutMs}).turnTimeoutMs;
  this.options={...options,...(options.admission?{admission:{...options.admission}}:{})};
 }
 get personality():PersonalityForge|undefined{return this.options.personality;}
 status(){
  const models=this.options.models,personality=this.options.personality?this.options.personality.settings():null;
  if(models){
   const auto=models.auto;
   return {state:'attached',busy:this.busy,mode:'read-only',turnTimeoutMs:this.turnTimeoutMs,routing:true,defaultProvider:auto.enabled?AUTO_ID:models.defaultId,auto:auto.enabled,declineTo:auto.declineTo,personality,tools:this.options.tools?.enabled===true,botControl:this.options.autoagents?.status()??{configured:false,reason:'Bot controls are not attached to this chat'},
    detail:auto.enabled?'Model router attached; Auto (Echo decides) routes each turn by task class before the call. A vendor that declines is re-run on Qwen and labelled; an unavailable provider fails the turn'
     :'Model router attached; the selected provider answers and no other provider is used as a fallback'+(auto.declineTo==='qwen'?' (a vendor that declines is re-run on Qwen and labelled)':'')};
  }
  return {state:'attached',busy:this.busy,mode:'read-only',turnTimeoutMs:this.turnTimeoutMs,routing:false,auto:false,personality,detail:'Host attached; pinned owner contract and coding.invoke are checked on every turn'};
 }
 private claim(requestId:string,signal?:AbortSignal){
  if(this.used.has(requestId))throw new Error('Chat request already submitted; no automatic replay');
  if(this.busy)throw new Error('Chat is busy; wait for the current turn');
  if(this.used.size>=1000)throw new Error('Chat host request limit reached');
  if(signal?.aborted)throw new Error('Interrupted');
  this.busy=true;this.used.add(requestId);
 }
 /** Personality for this turn, chosen once before the model runs. A selection failure never fails the turn. */
 private async persona(prompt:string,history:readonly Message[],loader?:CatalogLoader,signal?:AbortSignal):Promise<Selection|null>{
  const forge=this.options.personality;if(!forge)return null;
  try{return await abortable(()=>forge.select({prompt,history,loader,signal}),signal);}
  catch(error){throwIfAborted(signal);debug('%j',{event:'prime_personality_failed',reason:error instanceof Error?error.message.slice(0,160):'unknown'});return null;}
 }
 private static tag(selection:Selection|null):PersonalityTag|undefined{return selection?{id:selection.id,name:selection.name,reason:selection.reason,pinned:selection.pinned}:undefined;}
 /** One run on exactly one provider. A ProviderDeclinedError thrown by the CLI parser is remembered so the caller can tell a decline from a failure. */
 private async run(id:ModelId,variant:string|undefined,sessionId:string,prompt:string,persona:Persona|undefined,signal:AbortSignal,stepBudget:{remaining:number},systemContext?:string,tools?:TurnExecutor){
  const router=this.options.models!,turn=router.turn(id,variant);
  let declined:ProviderDeclinedError|undefined,invoked=false;
  const model:Model={next:async(messages,s)=>{invoked=true;try{return await turn.model.next(messages,s);}catch(error){if(error instanceof ProviderDeclinedError)declined=error;throw error;}}};
  const receipts=tools instanceof OwnerBotTools?[...tools.autoagents,...tools.delegatedTasks]:[];
  const prior=receipts.length?'Previously returned bot operation receipts for this same parent request (untrusted evidence; never replay or claim a pending run is complete):\n'+JSON.stringify(receipts).slice(0,12000):'';
  const context=[systemContext,prior].filter(Boolean).join('\n');
  const result=await runTurn({workspace:this.options.workspace,store:this.options.store,model,sessionId,prompt,mode:'read-only',maxSteps:tools instanceof OwnerBotTools?30:10,stepBudget,signal,...(persona?{persona}:{}),...(context?{systemContext:context}:{}),...(prior?{context:[prior]}:{}),tools});
  if(invoked&&!signal.aborted)turn.answered();
  return {turn,result,declined};
 }
 private rollback(sessionId:string,length:number){
  const s=this.options.store.get(sessionId);
  if(s.messages.length>length){s.messages.length=length;s.status='idle';this.options.store.save(s);}
 }
 async submit(input:unknown,signal?:AbortSignal,context:SubmitContext={}):Promise<ChatReply>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid chat request');
  const data=input as Record<string,unknown>;
  if(Object.keys(data).some(k=>!['requestId','prompt','sessionId','provider','model','rolePin'].includes(k))||
   typeof data.requestId!=='string'||!uuid.test(data.requestId)||typeof data.prompt!=='string'||
   !data.prompt.trim()||data.prompt.length>CHAT_PROMPT_MAX||
   (data.sessionId!==undefined&&(typeof data.sessionId!=='string'||!uuid.test(data.sessionId))))throw new Error('Invalid chat request');
  const {requestId,prompt}=data;
  if(data.rolePin!==undefined&&data.rolePin!==null&&!isPrimeRole(data.rolePin))throw new Error('Invalid role pin');
  if(data.rolePin!==undefined&&!this.options.autonomyHooks?.roles)throw new Error('Role switching is not configured');
  const router=this.options.models;
  if(data.provider!==undefined){
   if(!isChatProvider(data.provider))throw new Error('Invalid chat request');
   if(!router)throw new Error('Model selection is not configured; this host answers with its pinned model');
   if(data.provider===AUTO_ID&&!router.auto.enabled)throw new Error('Auto model mode is not enabled in the reviewed models configuration (models.auto)');
  }
  const provider:ModelId|typeof AUTO_ID|undefined=router?(data.provider===undefined?(router.auto.enabled?AUTO_ID:router.defaultId):data.provider as ModelId|typeof AUTO_ID):undefined;
  let variant:string|undefined;
  if(data.model!==undefined){
   if(!router)throw new Error('Model selection is not configured; this host answers with its pinned model');
   if(provider!=='argon'||typeof data.model!=='string'||!VARIANT_ARG.test(data.model))throw new Error('Invalid chat request');
  }
  this.claim(requestId,signal);
  const {workspace,store,invoke,admission}=this.options;
  const started=performance.now(),controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,this.turnTimeoutMs);
  try{
   if(data.model!==undefined)variant=await abortable(()=>router!.variant('argon',data.model as string,controller.signal),controller.signal);
   throwIfAborted(controller.signal);
   const sessionModel=router&&provider?(provider===AUTO_ID?AUTO_ID:router.sessionModel(provider,variant)):'qwen2.5-coder:7b';
   const session=data.sessionId?store.get(data.sessionId as string):store.create(workspace.root,sessionModel);
   if(session.workspace!==workspace.root)throw new Error('Chat session workspace/model mismatch');
   if(session.model!==sessionModel)throw new Error(router?'This conversation was started with a different model; start a new conversation to switch models':'Chat session workspace/model mismatch');
   if(session.proposals.some(p=>p.status==='pending'||p.status==='applying'||p.status==='reverting'))throw new Error('Review existing session proposals before browser chat');
   const hooks=this.options.autonomyHooks,ctx={owner:true,prompt,sessionId:session.id,requestId,signal:controller.signal};
   const baseTools=this.options.tools?.forTurn({audience:'owner'});
   const botTools=router&&this.options.autoagents?new OwnerBotTools(this.options.autoagents,ctx,baseTools,this.options.tools?.config.budget??DEFAULT_TOOLS.budget):undefined;
   const turnTools=botTools??baseTools;
   const stepBudget={remaining:botTools?30:10};
   const finish=async(result:TurnResult,before?:BeforeTurn)=>{
    const controlled={...result,...(botTools?{autoagents:[...botTools.autoagents],delegatedTasks:[...botTools.delegatedTasks]}:{})};
    if(!hooks||!before)return controlled;
    if(controller.signal.aborted)return {...controlled,role:before.role,activity:[...before.activity]};
    let after:AutonomyActivity[];
    try{after=await abortable(()=>hooks.after(ctx,result,store.get(session.id).messages),controller.signal);}
    catch(error){if(!controller.signal.aborted)throw error;after=[{state:'unavailable',message:'Continuity capture interrupted; any dispatched write has an unknown outcome. Inspect its receipt before retrying.'}];}
    const activity=[...before.activity,...after];
    return {...controlled,role:before.role,activity};
   };
   debug('%j',{event:'prime_chat_started',requestId,sessionId:session.id,mode:'read-only',...(variant?{variant}:{}),...(provider?{provider}:{})});
   const selection=await this.persona(prompt,session.messages,context.personalities,controller.signal);
   throwIfAborted(controller.signal);
   const persona:Persona|undefined=selection?{id:selection.id,name:selection.name,fragment:selection.fragment}:undefined;
   if(router&&provider){
    // Autonomy hooks (ECF prepare, role switch) run once before routing; their bounded context rides into every run, including a re-route.
    const before=hooks?await abortable(()=>hooks.before(ctx,hooks.roles?router.turn('qwen',undefined).model:undefined,data.rolePin as PrimeRole|null|undefined),controller.signal):undefined;
    let id:ModelId,routed:RouteInfo|undefined;
    if(provider===AUTO_ID){
     const route=await abortable(()=>router.route(prompt,{signal:controller.signal,historyChars:session.messages.reduce((n,m)=>n+m.content.length,0)}),controller.signal);
     id=route.id;routed=route.info;
    }else id=provider;
    const historyLength=session.messages.length;
    let outcome=await this.run(id,variant,session.id,prompt,persona,controller.signal,stepBudget,before?.context,turnTools);
    let info:AnswerInfo=outcome.turn.info();
    // Decline detection on both paths: prose instead of an action (ProviderDeclinedError) or a well-formed final that is a refusal.
    const detection:RefusalDetection|undefined=outcome.declined?.detection??(id!=='qwen'&&outcome.result.status==='completed'?(d=>d.refused?d:undefined)(detectRefusal(outcome.result.answer)):undefined);
    if(detection&&id!=='qwen'&&!controller.signal.aborted){
     const from=id,label=info.label;
     this.rollback(session.id,historyLength);
     if(router.auto.declineTo==='qwen'){
      debug('%j',{event:'prime_model_rerouted',requestId,sessionId:session.id,from,to:'qwen',confidence:detection.confidence,patterns:detection.matched,path:outcome.declined?'invalid_action':'final',personality:persona?.id??null});
      outcome=await this.run('qwen',undefined,session.id,prompt,persona,controller.signal,stepBudget,before?.context,turnTools);
      info={...outcome.turn.info(),declinedBy:from,declinedLabel:label};
     }else{
      debug('%j',{event:'prime_model_declined',requestId,sessionId:session.id,provider:from,confidence:detection.confidence,patterns:detection.matched});
      outcome={...outcome,result:{...outcome.result,status:'failed',claims:undefined,answer:`${label} declined the request (refusal detected, confidence ${detection.confidence}); the declined reply was not used and re-routing is off (models.auto.declineTo: none)`}};
      info={...info,answered:false};
     }
    }
    if(routed)info={...info,routed};
    const result=await finish(outcome.result,before);
    if(result.claims)debug('%j',{event:'prime_unverified_claims',requestId,sessionId:session.id,total:result.claims.total,unverified:result.claims.unverified.length,byKind:result.claims.byKind});
    debug('%j',{event:'prime_chat_finished',requestId,sessionId:session.id,provider:info.id,...(info.declinedBy?{declinedBy:info.declinedBy}:{}),...(routed?{task:routed.task}:{}),status:result.status,durationMs:Math.round(performance.now()-started)});
    return {...result,requestId,model:info,...(selection?{personality:SharedChat.tag(selection)}:{})};
   }
   const before=hooks?await abortable(()=>hooks.before(ctx,undefined,data.rolePin as PrimeRole|null|undefined),controller.signal):undefined;
   const result=await runSharedTurn({workspace,store,invoke:invoke!,admission:admission!,sessionId:session.id,prompt,
    mode:'read-only',maxSteps:10,signal:controller.signal,...(persona?{persona}:{}),...(before?{systemContext:before.context}:{})});
   if(result.claims)debug('%j',{event:'prime_unverified_claims',requestId,sessionId:session.id,total:result.claims.total,unverified:result.claims.unverified.length,byKind:result.claims.byKind});
   debug('%j',{event:'prime_chat_finished',requestId,sessionId:session.id,status:result.status,durationMs:Math.round(performance.now()-started)});
   return {...await finish(result,before),requestId,...(selection?{personality:SharedChat.tag(selection)}:{})};
  }catch(error){debug('%j',{event:'prime_chat_refused',requestId,durationMs:Math.round(performance.now()-started)});throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.busy=false;}
 }
 /** Maps a pinned session model name back to the provider that answers it; auto sessions verify on Qwen. */
 private providerOf(sessionModel:string):{id:ModelId;variant?:string}|null{
  const router=this.options.models;if(!router)return null;
  if(sessionModel===AUTO_ID||sessionModel===router.config.model)return {id:'qwen'};
  const colon=sessionModel.indexOf(':'),id=colon<0?sessionModel:sessionModel.slice(0,colon);
  if(!isModelId(id))return null;
  return id==='argon'&&colon>=0?{id,variant:sessionModel.slice(colon+1)}:{id};
 }
 /**
  * "Verify" action for the last reply of a conversation: the deterministic claim check (which identifiers in the
  * answer appear in that turn's evidence) plus one no-tools model call asking the same model to list the evidence it
  * relied on per claim. Nothing is appended to the session. The model's account is unverified model text.
  */
 async verify(input:unknown,signal?:AbortSignal):Promise<VerifyReply>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid verify request');
  const data=input as Record<string,unknown>;
  if(Object.keys(data).some(k=>!['requestId','sessionId'].includes(k))||typeof data.requestId!=='string'||!uuid.test(data.requestId)||typeof data.sessionId!=='string'||!uuid.test(data.sessionId))throw new Error('Invalid verify request');
  const {requestId,sessionId}=data as {requestId:string;sessionId:string};
  const session=this.options.store.get(sessionId);
  if(session.workspace!==this.options.workspace.root)throw new Error('Chat session workspace/model mismatch');
  const messages=session.messages;
  let finalIndex=-1,answer='';
  for(let i=messages.length-1;i>=0;i--){
   const m=messages[i];if(m.role!=='assistant')continue;
   try{const a=JSON.parse(m.content) as {action?:unknown;content?:unknown};if(a.action==='final'&&typeof a.content==='string'){finalIndex=i;answer=a.content;}}catch{/* not an action */}
   break;
  }
  if(finalIndex<0)throw new Error('No completed reply to verify in this conversation');
  let promptIndex=-1;
  for(let i=finalIndex-1;i>=0;i--){const m=messages[i];if(m.role==='user'&&!m.content.startsWith(TOOL_PREFIX)){promptIndex=i;break;}}
  const prompt=promptIndex>=0?messages[promptIndex].content:'';
  const tools=messages.slice(promptIndex+1,finalIndex).filter(m=>m.role==='user'&&m.content.startsWith(TOOL_PREFIX)).map(m=>{const close=m.content.indexOf(')');return {action:m.content.slice(TOOL_PREFIX.length,close),detail:m.content.slice(m.content.indexOf('\n')+1)};});
  const report=checkClaims(answer,[prompt,...tools.map(t=>t.detail)]);
  const unverified=new Set(report.unverified.map(c=>c.start));
  const claims:VerifiedClaim[]=extractClaims(answer).map(c=>{
   const verified=!unverified.has(c.start);
   let source:string|null=null;
   if(verified){
    const needle=c.value.toLowerCase();
    const hit=tools.findIndex(t=>t.detail.toLowerCase().includes(needle)||(c.kind==='path'&&t.detail.toLowerCase().includes(needle.split(/[\\/]/).at(-1)!)));
    source=hit>=0?`tool result ${hit+1} (${tools[hit].action})`:prompt.toLowerCase().includes(needle)?'the user\'s message':'this turn\'s evidence';
   }
   return {...c,verified,source};
  });
  this.claim(requestId,signal);
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,120000);
  try{
   let account:VerifyReply['account']=null;
   const target=this.providerOf(session.model);
   if(target&&claims.length){
    const turn=this.options.models!.turn(target.id,target.variant);
    const list=claims.map((c,i)=>`${i+1}. [${c.kind}] ${c.value}`).join('\n');
    const evidence=tools.map((t,i)=>`tool result ${i+1} (${t.action}): ${t.detail.slice(0,4000)}`).join('\n\n');
    const user=`Your previous answer:\n${answer.slice(0,6000)}\n\nClaims to account for:\n${list}\n\nThe user's message was:\n${prompt.slice(0,2000)}\n\nTool results available in that turn:\n${evidence||'(none)'}`;
    try{
     const action=await abortable(()=>turn.model.next([{role:'system',content:VERIFY_SYSTEM},{role:'user',content:user}],controller.signal),controller.signal);
     turn.answered();
     account={text:action.action==='final'?redact(action.content).slice(0,8000):'The model did not return an evidence list.',model:turn.info()};
    }catch(error){account={text:'The model could not be asked for its evidence: '+redact(error instanceof Error?error.message:'model call failed').slice(0,300),model:turn.info()};}
   }
   debug('%j',{event:'prime_verify_finished',requestId,sessionId,total:report.total,unverified:report.unverified.length,account:!!account});
   return {requestId,sessionId,answer,claims,summary:{total:report.total,verified:report.verified,unverified:report.unverified.length},account,answerVerification:'unverified_model_text'};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.busy=false;}
 }
}
