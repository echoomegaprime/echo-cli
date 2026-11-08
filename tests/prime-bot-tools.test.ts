import {describe,expect,it,vi} from 'vitest';
import {OwnerBotTools} from '../src/prime/bot-tools.js';
import {DEFAULT_TOOLS,ToolKit,type ToolModule} from '../src/code/tools/index.js';
import {AutoagentError,type ChatTool,type DelegatedTask,type ToolContext} from '../src/code/tools/autoagents.js';

const ctx:ToolContext={owner:true,prompt:'Manage my worker',sessionId:'parent-session',requestId:'parent-request'};
const action=(tool:string,args:Record<string,unknown>={})=>({action:'tool' as const,tool,args});
const definition=(name:string,run:ChatTool['run'],readOnly=false):ChatTool=>({name,description:name,inputSchema:{type:'object'},ownerOnly:true,readOnly,run});
const admittedTask=():DelegatedTask=>({kind:'delegated_task',tool:'delegate_task',taskKey:'catalog-task',task:'Inspect one catalog entry',agent:'catalog-reader',botId:'a'.repeat(32),runId:'b'.repeat(32),messageId:'c'.repeat(32),eventId:'delegate-original',status:'queued',botStatus:'paused',done:false,duplicate:false,untrusted:true,summary:'Task was admitted.'});

describe('OwnerBotTools public execution contract',()=>{
 it('deduplicates identical mutations while preserving case-sensitive arguments',async()=>{
  const run=vi.fn(async(input:unknown)=>({updated:input})),tools=new OwnerBotTools({tools:()=>[definition('update_bot',run)]},ctx);
  await tools.execute(action('update_bot',{bot_id:'a'.repeat(32),instruction:'Keep Case'}));
  await tools.execute(action('update_bot',{instruction:'Keep Case',bot_id:'a'.repeat(32)}));
  await tools.execute(action('update_bot',{bot_id:'a'.repeat(32),instruction:'keep case'}));
  expect(run).toHaveBeenCalledTimes(2);expect(run.mock.calls.map(call=>call[0])).toEqual([{bot_id:'a'.repeat(32),instruction:'Keep Case'},{bot_id:'a'.repeat(32),instruction:'keep case'}]);
 });
 it('fetches read-only status afresh and does not cache a running result as final',async()=>{
  let count=0;const run=vi.fn(async()=>({status:++count===1?'running':'done'})),tools=new OwnerBotTools({tools:()=>[definition('bot_run_status',run,true)]},ctx);
  expect(JSON.stringify((await tools.execute(action('bot_run_status',{run_id:'b'.repeat(32)}))).result)).toContain('running');
  expect(JSON.stringify((await tools.execute(action('bot_run_status',{run_id:'b'.repeat(32)}))).result)).toContain('done');
  expect(run).toHaveBeenCalledTimes(2);
 });
 it('keeps uncertain admission failures cached even when their text resembles a missing agent',async()=>{
  for(const error of [new Error('agent_not_found'),new AutoagentError(502,'agent_not_found','agent_not_found')]){
   const run=vi.fn(async()=>{throw error;}),tools=new OwnerBotTools({tools:()=>[definition('make_bot',run)]},ctx);
   await tools.execute(action('make_bot',{agent:'queue-scout'}));
   expect((await tools.execute(action('make_bot',{agent:'queue-scout'}))).result).toMatchObject({ok:false,deduplicated:true});
   expect(run).toHaveBeenCalledOnce();
  }
 });
 it('repeats state controls after intervening changes instead of returning a stale receipt',async()=>{
  let status='idle';
  const pause=vi.fn(async()=>({status:status='paused'})),resume=vi.fn(async()=>({status:status='idle'}));
  const tools=new OwnerBotTools({tools:()=>[
   {...definition('pause_bot',pause),deduplicate:false},
   {...definition('resume_bot',resume),deduplicate:false},
  ]},ctx);
  const args={bot_id:'a'.repeat(32)};
  await tools.execute(action('pause_bot',args));await tools.execute(action('resume_bot',args));await tools.execute(action('pause_bot',args));
  expect(status).toBe('paused');expect(pause).toHaveBeenCalledTimes(2);expect(resume).toHaveBeenCalledOnce();
 });
 it('allows a refused state update to succeed after the conflicting work is stopped',async()=>{
  let busy=true;
  const update=vi.fn(async()=>{if(busy)throw new Error('Stop active work before editing');return {name:'Updated'};});
  const tools=new OwnerBotTools({tools:()=>[
   {...definition('update_bot',update),deduplicate:false},
   {...definition('stop_bot',async()=>{busy=false;return {stopRequested:true};}),deduplicate:false},
  ]},ctx);
  const args={bot_id:'a'.repeat(32),name:'Updated'};
  expect((await tools.execute(action('update_bot',args))).result).toMatchObject({ok:false});
  await tools.execute(action('stop_bot',{bot_id:args.bot_id}));
  expect((await tools.execute(action('update_bot',args))).result).toMatchObject({name:'Updated'});
  expect(update).toHaveBeenCalledTimes(2);
 });
 it('refuses owner tools before mutation when the host context does not admit the owner',async()=>{
  const run=vi.fn(async()=>({ok:true})),tools=new OwnerBotTools({tools:()=>[definition('delete_bot',run)]},{...ctx,owner:false});
  const result=await tools.execute(action('delete_bot',{bot_id:'a'.repeat(32)}));expect(run).not.toHaveBeenCalled();expect(JSON.stringify(result.result)).toMatch(/owner/i);
 });
 it('executes at most four batch calls sequentially so lifecycle actions cannot race',async()=>{
  const order:string[]=[],run=vi.fn(async(input:unknown)=>{const n=(input as {n:number}).n;order.push('start'+n);await Promise.resolve();order.push('end'+n);return {n};});
  const tools=new OwnerBotTools({tools:()=>[definition('update_bot',run)]},ctx);
  const result=await tools.execute({action:'tools',calls:[0,1,2,3,4].map(n=>({tool:'update_bot',args:{n}}))});
  expect(run).toHaveBeenCalledTimes(4);expect(order).toEqual(['start0','end0','start1','end1','start2','end2','start3','end3']);expect(result.result).toMatchObject({omitted:1});
 });
 it('shares the call budget with existing tools instead of granting a second allowance',async()=>{
  const baseRun=vi.fn(async()=>({source:'base'})),ownerRun=vi.fn(async()=>({source:'bot'}));
  const module:ToolModule={spec:{name:'fixture_read',family:'web',description:'Offline fixture',params:{},cacheTtlMs:0},available:()=>({available:true}),run:baseRun};
  const base=new ToolKit(DEFAULT_TOOLS,{},[module]).forTurn({audience:'owner'});
  const tools=new OwnerBotTools({tools:()=>[definition('list_bots',ownerRun,true)]},ctx,base,{calls:2,wallMs:10000,resultChars:6000});
  await tools.execute(action('fixture_read'));await tools.execute(action('list_bots'));const exhausted=await tools.execute(action('list_bots'));
  expect(baseRun).toHaveBeenCalledOnce();expect(ownerRun).toHaveBeenCalledOnce();expect(tools.used).toBe(2);expect(tools.budgetExhausted).toBe(true);expect(JSON.stringify(exhausted.result)).toMatch(/budget/i);
 });
 it('preserves durable admission IDs at the 30-second boundary without waiting or replaying the mutation',async()=>{
  vi.useFakeTimers();
  try{
   const receipt=admittedTask();let admittedSignal:AbortSignal|undefined;
   const run=vi.fn(async(_input:unknown,host:ToolContext)=>{
    admittedSignal=host.signal;host.onDelegationAdmission?.(receipt);
    receipt.runId='d'.repeat(32);receipt.summary='Later mutation must not replace the captured receipt';
    return await new Promise<never>(()=>{});
   });
   const tools=new OwnerBotTools({tools:()=>[definition('delegate_task',run)]},ctx,undefined,{calls:8,wallMs:90000,resultChars:12000});
   const args={task_key:'catalog-task',text:'Inspect one catalog entry',agent:'catalog-reader'};
   const pending=tools.execute(action('delegate_task',args));
   await vi.advanceTimersByTimeAsync(30001);
   const result=(await pending).result;
   expect(result).toMatchObject({kind:'delegated_task',taskKey:'catalog-task',runId:'b'.repeat(32),messageId:'c'.repeat(32),eventId:'delegate-original',status:'unavailable',done:false,botStatus:'unknown',state:'unknown',error:{code:'status_unavailable'}});
   expect(result).not.toHaveProperty('output');expect(result).not.toHaveProperty('proof');
   expect(admittedSignal?.aborted).toBe(true);expect(tools.delegatedTasks).toEqual([result]);
   expect((await tools.execute(action('delegate_task',args))).result).toMatchObject({runId:'b'.repeat(32),deduplicated:true});
   expect(run).toHaveBeenCalledOnce();expect(tools.used).toBe(1);
  }finally{vi.useRealTimers();}
 });
 it('returns recorded admission after owner cancellation while leaving the current run outcome unknown',async()=>{
  const controller=new AbortController();let publish:(receipt:DelegatedTask)=>void=()=>{};
  const run=vi.fn(async(_input:unknown,host:ToolContext)=>{publish=host.onDelegationAdmission??(()=>{});publish(admittedTask());return await new Promise<never>(()=>{});});
  const tools=new OwnerBotTools({tools:()=>[definition('delegate_task',run)]},ctx);
  const pending=tools.execute(action('delegate_task',{task_key:'catalog-task'}),undefined,controller.signal);
  controller.abort();
  expect((await pending).result).toMatchObject({kind:'delegated_task',runId:'b'.repeat(32),status:'unavailable',done:false,state:'unknown'});
  const snapshot=JSON.stringify(tools.delegatedTasks);
  publish({...admittedTask(),status:'done',done:true,output:'Late callback'});
  expect(JSON.stringify(tools.delegatedTasks)).toBe(snapshot);
  expect(run).toHaveBeenCalledOnce();
 });
 it('does not invent admission IDs when cancellation wins before any receipt was published',async()=>{
  const controller=new AbortController();let publish:(receipt:DelegatedTask)=>void=()=>{};
  const run=vi.fn(async(_input:unknown,host:ToolContext)=>{publish=host.onDelegationAdmission??(()=>{});return await new Promise<never>(()=>{});});
  const tools=new OwnerBotTools({tools:()=>[definition('delegate_task',run)]},ctx);
  const pending=tools.execute(action('delegate_task',{task_key:'catalog-task'}),undefined,controller.signal);controller.abort();
  const result=(await pending).result;
  expect(result).toMatchObject({ok:false,state:'unknown'});expect(result).not.toHaveProperty('runId');
  publish(admittedTask());expect(tools.delegatedTasks).toEqual([]);expect(run).toHaveBeenCalledOnce();
 });
 it('rejects a callback receipt for a different task instead of presenting false recovery evidence',async()=>{
  const run=vi.fn(async(_input:unknown,host:ToolContext)=>{host.onDelegationAdmission?.({...admittedTask(),taskKey:'another-task'});throw new Error('Admission failed');});
  const tools=new OwnerBotTools({tools:()=>[definition('delegate_task',run)]},ctx);
  const result=(await tools.execute(action('delegate_task',{task_key:'catalog-task'}))).result;
  expect(result).toMatchObject({ok:false,state:'failed'});expect(result).not.toHaveProperty('runId');expect(tools.delegatedTasks).toEqual([]);
 });
 it('keeps a normal terminal result and its proof when the tool completes inside the deadline',async()=>{
  const proof={events_sha256:'e'.repeat(64),verdict:'PASS'};
  const run=vi.fn(async(_input:unknown,host:ToolContext)=>{host.onDelegationAdmission?.(admittedTask());return {...admittedTask(),status:'done',done:true,output:'Actual worker output',proof};});
  const tools=new OwnerBotTools({tools:()=>[definition('delegate_task',run)]},ctx);
  const result=(await tools.execute(action('delegate_task',{task_key:'catalog-task'}))).result;
  expect(result).toMatchObject({status:'done',done:true,output:'Actual worker output',proof});expect(tools.delegatedTasks).toEqual([result]);
 });
});
