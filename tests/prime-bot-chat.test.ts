import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SharedChat} from '../src/prime/chat.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore,type Message} from '../src/code/sessions.js';
import {DEFAULT_MODELS,ModelRouter} from '../src/code/model-factory.js';
import type {Action,Model} from '../src/code/model.js';
import {AutoAgents,type ChatTool,type DelegatedTask,type ToolContext} from '../src/code/tools/autoagents.js';
import {AdkClient,type AdkRunStatus} from '../src/prime/agents.js';

const BOT='a'.repeat(32),RUN='b'.repeat(32),MESSAGE='c'.repeat(32),HASH='d'.repeat(64);
const dirs:string[]=[];
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'prime-bot-chat-')),state=mkdtempSync(join(tmpdir(),'prime-bot-chat-state-'));dirs.push(root,state);
 return {workspace:new Workspace(root,[state]),store:new SessionStore(state)};
}

describe('owner bot tools in the real SharedChat turn loop',()=>{
 it('gathers delayed output and proof through one bounded real run-status operation before the parent final',async()=>{
  vi.useFakeTimers();
  const f=fixture(),adk=new AdkClient(),autoagents=new AutoAgents({adk}),seen:Message[][]=[],started=Date.now();
  const status=vi.spyOn(adk,'status').mockImplementation(async():Promise<AdkRunStatus>=>Date.now()-started<1250?{runId:RUN,status:'running',done:false,steps:[]}:{runId:RUN,status:'done',done:true,steps:[{kind:'final',ok:true,data:{text:'Actual delayed fixture evidence'}}],proof:{run_id:RUN,events_sha256:HASH,verdict:'PASS'}});
  const actions:Action[]=[{action:'tool',tool:'bot_run_status',args:{run_id:RUN,wait_ms:25000}},{action:'final',content:'The worker returned its evidence and proof.'}];
  const model:Model={next:vi.fn(async messages=>{seen.push(structuredClone(messages));return actions.shift()!;})};
  const router=new ModelRouter({...DEFAULT_MODELS}),info={...router.turn('qwen').info(),answered:true};
  vi.spyOn(router,'turn').mockReturnValue({model,answered:()=>info,info:()=>info});
  const chat=new SharedChat({...f,models:router,autoagents}),pending=chat.submit({requestId:randomUUID(),prompt:'Gather the existing run and report its evidence.'});
  await vi.advanceTimersByTimeAsync(1500);const result=await pending;
  expect(result).toMatchObject({status:'completed',tools:{calls:1}});expect(status).toHaveBeenCalledTimes(4);
  const evidence=seen[1].filter(message=>message.content.startsWith('UNTRUSTED TOOL RESULT')).map(message=>message.content).join('\n');
  expect(evidence).toContain('Actual delayed fixture evidence');expect(evidence).toContain(HASH);expect(evidence).toContain(RUN);
  expect(seen[0][0].content).toContain('wait_ms:25000');
  expect(result.tools?.events.filter(event=>event.type==='tool_result')).toEqual([expect.objectContaining({result:expect.objectContaining({runId:RUN,status:'done',output:'Actual delayed fixture evidence',proof:expect.objectContaining({events_sha256:HASH})})})]);
  expect(result.delegatedTasks).toEqual([]);expect(vi.getTimerCount()).toBe(0);
 });
 it('delegates, gathers actual run evidence into parent messages, and returns dedicated task receipts',async()=>{
  const f=fixture(),seen:Message[][]=[],contexts:ToolContext[]=[];
  const queued={kind:'delegated_task',tool:'delegate_task',taskKey:'release-check',task:'Check release readiness',agent:'release-scout',botId:BOT,runId:RUN,messageId:MESSAGE,eventId:'task:release-check',status:'queued',done:false,duplicate:false,untrusted:true,summary:'Queued'};
  const completed={...queued,status:'done',done:true,output:'Worker inspected release manifest: build 714 is ready.',proof:{verdict:'PASS',events_sha256:HASH},summary:'Worker returned release evidence'};
  const delegate=vi.fn(async(_args:unknown,ctx:ToolContext)=>{contexts.push(ctx);return queued;});
  const status=vi.fn(async(_args:unknown,ctx:ToolContext)=>{contexts.push(ctx);return completed;});
  const tools:ChatTool[]=[
   {name:'delegate_task',description:'Delegate a bounded task',inputSchema:{type:'object'},ownerOnly:true,run:delegate},
   {name:'bot_run_status',description:'Read the current worker result',inputSchema:{type:'object'},ownerOnly:true,readOnly:true,run:status},
  ];
  const autoagents={tools:()=>tools} as unknown as AutoAgents;
  const actions:Action[]=[{action:'tool',tool:'delegate_task',args:{task_key:'release-check',text:'Check release readiness',bot_id:BOT}},{action:'tool',tool:'bot_run_status',args:{run_id:RUN}},{action:'final',content:'Worker evidence says build 714 is ready.'}];
  const model:Model={next:vi.fn(async messages=>{seen.push(structuredClone(messages));return actions.shift()!;})};
  const router=new ModelRouter({...DEFAULT_MODELS}),info={...router.turn('qwen').info(),answered:true};
  vi.spyOn(router,'turn').mockReturnValue({model,answered:()=>info,info:()=>info});
  const chat=new SharedChat({...f,models:router,autoagents}),requestId=randomUUID(),prompt='Delegate a release check and report its actual result.';
  const result=await chat.submit({requestId,prompt});
  expect(delegate).toHaveBeenCalledOnce();expect(status).toHaveBeenCalledOnce();
  expect(contexts.every(ctx=>ctx.owner===true&&ctx.prompt===prompt&&ctx.sessionId===result.sessionId&&ctx.requestId===requestId&&ctx.signal instanceof AbortSignal)).toBe(true);
  expect(seen[0][0].content).toContain('delegate_task');
  const evidence=seen[2].filter(message=>message.role==='user'&&message.content.startsWith('UNTRUSTED TOOL RESULT')).map(message=>message.content).join('\n');
  expect(evidence).toContain('Worker inspected release manifest: build 714 is ready.');expect(evidence).toContain(HASH);expect(evidence).toContain(RUN);
  expect(result).toMatchObject({status:'completed',answer:'Worker evidence says build 714 is ready.'});
  expect(result.autoagents??[]).toEqual([]);
  expect(result.delegatedTasks).toEqual(expect.arrayContaining([expect.objectContaining({runId:RUN,status:'done',output:completed.output,proof:completed.proof})]));
  expect(f.store.get(result.sessionId).messages.some(message=>message.content.includes(completed.output))).toBe(true);
 });
 it('keeps model-supplied owner overrides out of the host context',async()=>{
  const f=fixture(),run=vi.fn(async()=>({ok:true})),autoagents={tools:()=>[{name:'list_bots',description:'Read bots',inputSchema:{type:'object'},ownerOnly:true,readOnly:true,run}]} as unknown as AutoAgents;
  const router=new ModelRouter({...DEFAULT_MODELS}),info=router.turn('qwen').info(),model:Model={next:vi.fn(async()=>({action:'final',content:'Not called'}))};
  vi.spyOn(router,'turn').mockReturnValue({model,answered:()=>info,info:()=>info});
  const chat=new SharedChat({...f,models:router,autoagents});
  await expect(chat.submit({requestId:randomUUID(),prompt:'List bots',owner:true})).rejects.toThrow('Invalid chat request');
  expect(run).not.toHaveBeenCalled();expect(model.next).not.toHaveBeenCalled();
 });
 it('returns an admitted run receipt when the owner stops the parent during resume',async()=>{
  const f=fixture(),controller=new AbortController();let admitted!:()=>void;
  const ready=new Promise<void>(resolve=>{admitted=resolve;});
  const receipt:DelegatedTask={kind:'delegated_task',tool:'delegate_task',taskKey:'release-check',task:'Check release readiness',agent:'release-scout',botId:BOT,runId:RUN,messageId:MESSAGE,eventId:'task:release-check',status:'queued',done:false,duplicate:false,untrusted:true,summary:'Queued'};
  const delegate=vi.fn(async(_args:unknown,host:ToolContext)=>{host.onDelegationAdmission?.(receipt);admitted();return await new Promise<never>(()=>{});});
  const autoagents={tools:()=>[{name:'delegate_task',description:'Delegate',inputSchema:{type:'object'},ownerOnly:true,run:delegate}]} as unknown as AutoAgents;
  const model:Model={next:vi.fn(async()=>({action:'tool',tool:'delegate_task',args:{task_key:'release-check',text:'Check release readiness',bot_id:BOT}}))};
  const router=new ModelRouter({...DEFAULT_MODELS}),info={...router.turn('qwen').info(),answered:true};
  vi.spyOn(router,'turn').mockReturnValue({model,answered:()=>info,info:()=>info});
  const chat=new SharedChat({...f,models:router,autoagents});
  const pending=chat.submit({requestId:randomUUID(),prompt:'Delegate a release check.'},controller.signal);
  await ready;controller.abort();const result=await pending;
  expect(result.status).toBe('interrupted');expect(delegate).toHaveBeenCalledOnce();
  expect(result.delegatedTasks).toEqual([expect.objectContaining({runId:RUN,messageId:MESSAGE,eventId:receipt.eventId,status:'unavailable',done:false,state:'unknown'})]);
  expect(result.delegatedTasks?.[0]).not.toHaveProperty('proof');expect(result.delegatedTasks?.[0]).not.toHaveProperty('output');
  expect(result.tools?.events.some(event=>event.type==='tool_result'&&JSON.stringify(event.result).includes(RUN))).toBe(true);
  expect(f.store.get(result.sessionId).messages.some(message=>message.content.includes(RUN))).toBe(true);
 });
});
