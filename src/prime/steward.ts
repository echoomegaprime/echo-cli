import {randomUUID} from 'node:crypto';
import {debuglog} from 'node:util';
import {object,unwrap,type Json,type McpConnection} from './hub.js';
import {redact} from '../code/workspace.js';
import {stewardVocabulary,stewardIrreversible,stewardVocabularySource} from './steward-vocabulary.js';

const debug=debuglog('echo-prime-steward');
const nodeId=/^[a-z][a-z0-9-]{0,62}$/;
const sha=/^[0-9a-f]{64}$/;
const verdicts=new Set(['PASS','FAIL','UNKNOWN']);
export interface StewardTools {status:string;advisory:string}
export interface StewardOwner {status():Promise<Json>;ask(input:unknown):Promise<Json>}
export function disconnectedSteward(){
 return {state:'disconnected',detail:'Node Steward owner not connected; fleet coverage is unknown.',inventoryComplete:false,coverageComplete:false,nodes:[],executionAvailable:false,promotionAvailable:false};
}
function refuse(category:string):never{
 debug('%j',{schemaVersion:1,event:'steward_refused',category});
 throw new Error('Node Steward refused: '+category);
}
function fresh(value:unknown){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value))return false;
 const age=Date.now()-Date.parse(value);return Number.isFinite(age)&&age>=-10000&&age<=120000;
}
function text(value:unknown,max:number){
 if(typeof value!=='string'||!value.trim()||value.length>max)refuse('invalid text');
 return redact(value);
}
function keys(value:Json,allowed:string[]){if(Object.keys(value).some(k=>!allowed.includes(k)))refuse('unexpected fields');}
function proposalCall(value:unknown,target:string,verify=false){
 const v=object(value);keys(v,verify?['cap','command','options','expect']:['cap','command','options']);
 const cap=String(v.cap??''),command=String(v.command??'');
 if(!Object.hasOwn(stewardVocabulary,cap)||!Object.hasOwn(stewardVocabulary[cap],command))refuse('unknown typed action');
 const tier=stewardVocabulary[cap][command],options=object(v.options);
 if(options.target!==target||Object.keys(options).length>16)refuse('proposal target mismatch');
 for(const [key,value] of Object.entries(options)){
  if(!/^[a-z][a-z0-9_]{0,39}$/i.test(key)||/^(shell|exec|script|code|authorization|api_key|token|grant|confirm)$/i.test(key)||!['string','number','boolean'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value))||(typeof value==='string'&&(value.length>1000||redact(value)!==value)))refuse('invalid typed options');
 }
 if(verify&&tier!==0)refuse('verification must be read-only');
 return {cap,command,options:{...options},risk_tier:tier,reversible:!stewardIrreversible.has(cap+'/'+command),...(verify?{expect:text(v.expect,600)}:{})};
}
/** A strict viewer for the canonical vocabulary. Validation never grants execution authority. */
export function validateStewardProposal(value:unknown,target:string){
 if(!target||target.length>240)refuse('exact target required');
 const p=object(value);keys(p,['diagnosis','decision','reason','action','verify','rollback','rollback_action','escalate_when']);
 if(!['ACT','NO_ACTION','ESCALATE'].includes(String(p.decision)))refuse('invalid decision');
 const diagnosis=text(p.diagnosis,600),reason=text(p.reason,400),rollback=text(p.rollback,600);
 if(!Array.isArray(p.escalate_when)||p.escalate_when.length>3)refuse('invalid escalation conditions');
 const escalate_when=p.escalate_when.map(v=>text(v,240));
 if(p.decision!=='ACT'){
  if(p.action!==null||p.verify!==null||p.rollback_action!==null)refuse('abstention includes action');
  return {diagnosis,decision:p.decision,reason,action:null,verify:null,rollback,rollback_action:null,escalate_when};
 }
 const action=proposalCall(p.action,target),verify=proposalCall(p.verify,target,true);
 if(action.risk_tier===0)refuse('ACT must perform a remedy');
 const rollback_action=p.rollback_action===null?null:proposalCall(p.rollback_action,target);
 return {diagnosis,decision:p.decision,reason,action,verify,rollback,rollback_action,escalate_when};
}
export async function connectSteward(connection:McpConnection,tools:StewardTools):Promise<StewardOwner>{
 if(!tools||typeof tools.status!=='string'||typeof tools.advisory!=='string'||tools.status===tools.advisory)refuse('owner tool contract missing');
 const advertised=await connection.listTools();
 if(![tools.status,tools.advisory].every(name=>advertised.some(t=>t.name===name)))refuse('owner tool contract missing');
 async function status():Promise<Json>{
  const r=object(unwrap(await connection.call(tools.status,{})));
  if(r.schemaVersion!==1||typeof r.inventoryComplete!=='boolean'||!Array.isArray(r.nodes)||r.nodes.length>256||typeof r.observedAt!=='string')refuse('invalid owner inventory');
  const ids=new Set<string>();
  const nodes=r.nodes.map(value=>{
   const n=object(value),runtime=object(n.runtime),evaluation=object(n.evaluation);
   if(typeof n.id!=='string'||!nodeId.test(n.id)||ids.has(n.id)||!['windows','linux','unknown'].includes(String(n.os))||typeof n.identityVerified!=='boolean'||typeof n.admitted!=='boolean'||!['unknown','offline','shadow','resident'].includes(String(runtime.state))||typeof runtime.observedAt!=='string'||!verdicts.has(String(evaluation.verdict))||!verdicts.has(String(n.canary))||typeof n.rollbackReady!=='boolean')refuse('invalid owner inventory');
   ids.add(n.id);
   const identitySha256=typeof n.identitySha256==='string'&&sha.test(n.identitySha256)?n.identitySha256:undefined;
   if(n.identityVerified&&!identitySha256)refuse('verified node identity missing');
   const model=typeof runtime.model==='string'?text(runtime.model,180):undefined;
   const digest=typeof runtime.sha256==='string'&&sha.test(runtime.sha256)?runtime.sha256:undefined;
   const current=fresh(r.observedAt)&&fresh(runtime.observedAt);
   const eligible=n.identityVerified&&n.admitted&&current&&model&&digest&&(runtime.state==='shadow'||(runtime.state==='resident'&&evaluation.verdict==='PASS'&&n.canary==='PASS'&&n.rollbackReady));
   return {id:n.id,os:n.os,identityVerified:n.identityVerified,identitySha256,admitted:n.admitted,runtime:{state:runtime.state,observedAt:runtime.observedAt,model,sha256:digest,current},evaluation:{verdict:evaluation.verdict},canary:n.canary,rollbackReady:n.rollbackReady,advisoryAvailable:!!eligible,residentReady:!!eligible&&runtime.state==='resident'};
  });
  const current=fresh(r.observedAt),available=nodes.filter(n=>n.advisoryAvailable).length;
  const residents=nodes.filter(n=>n.residentReady).length;
  return {state:current?'connected':'stale',observedAt:r.observedAt,inventoryComplete:current&&r.inventoryComplete,coverageComplete:current&&r.inventoryComplete&&nodes.length>0&&residents===nodes.length,advisoryCoverageComplete:current&&r.inventoryComplete&&nodes.length>0&&available===nodes.length,coverage:{total:nodes.length,admitted:nodes.filter(n=>n.admitted).length,available,residents},nodes,executionAvailable:false,promotionAvailable:false,vocabulary:stewardVocabularySource};
 }
 let busy=false;
 return {status,async ask(input){
  const data=object(input);keys(data,['node','mode','text','target']);
  if(typeof data.node!=='string'||!nodeId.test(data.node)||!['answer','explain','proposal'].includes(String(data.mode)))refuse('invalid advisory request');
  const userText=text(data.text,8000);if(userText!==data.text)refuse('credential-like input');
  if(data.mode==='proposal'&&(typeof data.target!=='string'||!data.target.trim()||data.target.length>240||redact(data.target)!==data.target))refuse('exact target required');
  if(data.mode!=='proposal'&&data.target!==undefined)refuse('target only applies to proposals');
  if(busy)refuse('advisory already pending');busy=true;
  try{
   const inventory=await status(),node=(inventory.nodes as Json[]).find(n=>n.id===data.node);
   if(!node||!node.advisoryAvailable)refuse('node identity, admission or runtime unavailable');
   const modelSha256=object(node.runtime).sha256,nodeIdentitySha256=node.identitySha256,requestId=randomUUID();
   const response=object(unwrap(await connection.call(tools.advisory,{node:data.node,mode:data.mode,text:userText,...(data.mode==='proposal'?{target:data.target}:{}),modelSha256,nodeIdentitySha256,requestId})));
   keys(response,['schemaVersion','observedAt','node','mode','requestId','modelSha256','nodeIdentitySha256','executionAuthorized','text','proposal']);
   if(response.schemaVersion!==1||!fresh(response.observedAt)||response.node!==data.node||response.mode!==data.mode||response.requestId!==requestId||response.modelSha256!==modelSha256||response.nodeIdentitySha256!==nodeIdentitySha256||response.executionAuthorized!==false)refuse('advisory receipt identity mismatch');
   const content=data.mode==='proposal'?{proposal:validateStewardProposal(response.proposal,data.target as string)}:{text:text(response.text,16000)};
   debug('%j',{schemaVersion:1,event:'steward_advisory_returned',mode:data.mode});
   return {node:data.node,mode:data.mode,requestId,modelSha256,nodeIdentitySha256,observedAt:response.observedAt,...content,executionAuthorized:false,untrusted:true};
  }finally{busy=false;}
 }};
}
