import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ToolKit,parseToolsConfig,mcpPlugins} from '../src/code/tools/index.js';
import {connectionGateway} from '../src/prime/tools-bridge.js';
import {SharedChat} from '../src/prime/chat.js';
import {Workspace} from '../src/code/workspace.js';
import {SessionStore} from '../src/code/sessions.js';
import {DEFAULT_MODELS,ModelRouter,parseModelsConfig} from '../src/code/model-factory.js';
import {OwnerBotTools} from '../src/prime/bot-tools.js';
import type {McpConnection,Tool as McpToolDefinition} from '../src/prime/hub.js';
import type {Action,Model} from '../src/code/model.js';
import type {ToolModule} from '../src/code/tools/types.js';
import type {ChatTool} from '../src/code/tools/autoagents.js';

// Regression journeys through real runtime/adapters with controlled external dependencies.
// No live model, SDK or MCP endpoint is called.
const roots:string[]=[];
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function slowMcp(){
 const listed=deferred<McpToolDefinition[]>(),entered=deferred<void>();
 let calls=0;
 const connection:McpConnection={listTools:async()=>{entered.resolve();return await listed.promise;},call:async()=>{calls++;return {ok:true,fixture:true};}};
 const config=parseToolsConfig({budget:{calls:8,wallMs:240000},mcp:{allow:['fixture:read_status']}});
 const tools=new ToolKit(config,{mcp:connectionGateway({fixture:connection})},[mcpPlugins]);
 const action={action:'tool' as const,tool:'mcp_plugins',args:{action:'call',connection:'fixture',tool:'read_status',arguments:{}}};
 return {tools,action,entered,release:()=>listed.resolve([{name:'read_status',description:'Controlled fixture only',inputSchema:{type:'object'}}]),calls:()=>calls};
}

it('cancellation during MCP listing prevents a subsequent tool dispatch',async()=>{
 const f=slowMcp(),controller=new AbortController(),turn=f.tools.forTurn({audience:'owner'})!;
 const pending=turn.execute(f.action,undefined,controller.signal);
 await f.entered.promise;controller.abort();f.release();await pending;
 expect(f.calls()).toBe(0);
});

it('the exact 300000ms host deadline settles chat and prevents a new MCP dispatch',async()=>{
 vi.useFakeTimers();
 const f=slowMcp(),root=mkdtempSync(join(tmpdir(),'echo-pr14-review-')),state=mkdtempSync(join(tmpdir(),'echo-pr14-state-'));roots.push(root,state);
 const router=new ModelRouter({...DEFAULT_MODELS}),info=router.turn('qwen').info();
 let step=0;
 const delays=[110000,110000,79900];
 const model:Model={next:async():Promise<Action>=>{const index=step++;await new Promise(r=>setTimeout(r,delays[index]??0));return index<2?{action:'list',path:'.'}:f.action;}};
 vi.spyOn(router,'turn').mockReturnValue({model,answered:()=>({...info,answered:true}),info:()=>({...info,answered:true})});
 const chat=new SharedChat({workspace:new Workspace(root,[state]),store:new SessionStore(state),models:router,tools:f.tools,turnTimeoutMs:300000});
 let settled=false;
 const pending=chat.submit({requestId:randomUUID(),prompt:'Controlled multi-step cancellation fixture.'}).then(r=>{settled=true;return r;});
 await vi.advanceTimersByTimeAsync(299900);await f.entered.promise;
 await vi.advanceTimersByTimeAsync(101);
 const atDeadline={settled,busy:chat.status().busy,dispatches:f.calls()};
 f.release();const result=await pending;
 expect(atDeadline).toEqual({settled:true,busy:false,dispatches:0});
 expect(f.calls()).toBe(0);expect(result.status).toBe('interrupted');expect(step).toBe(3);
});

it('mixed owner/base tools abort at the shared 240000ms wall budget',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 const entered=deferred<void>(),released=deferred<unknown>();let seen:AbortSignal|undefined;
 const module:ToolModule={spec:{name:'base_fixture',family:'knowledge',cacheTtlMs:0,description:'Controlled fixture',params:{}},available:()=>({available:true}),run:async(_a,_e,signal)=>{seen=signal;entered.resolve();return await released.promise;}};
 const config=parseToolsConfig({budget:{calls:8,wallMs:240000}});
 const base=new ToolKit(config,{},[module]).forTurn({audience:'owner'})!;
 const auto={tools:():ChatTool[]=>[{name:'owner_fixture',description:'Controlled owner fixture',inputSchema:{type:'object'},ownerOnly:true,readOnly:true,run:async()=>({ok:true})}]};
 const wrapper=new OwnerBotTools(auto,{owner:true,prompt:'fixture',sessionId:randomUUID(),requestId:randomUUID()},base,config.budget);
 await wrapper.execute({action:'tool',tool:'owner_fixture',args:{}});
 await vi.advanceTimersByTimeAsync(239999);
 const pending=wrapper.execute({action:'tool',tool:'base_fixture',args:{}});await entered.promise;
 await vi.advanceTimersByTimeAsync(1);
 const abortedAtBudget=seen?.aborted;
 await vi.advanceTimersByTimeAsync(5000);
 const abortedFiveSecondsLate=seen?.aborted;
 const result=await pending;
 expect(result.result).toMatchObject({ok:false,state:'unknown'});
 released.resolve({ok:true});await Promise.resolve();
 expect(abortedAtBudget).toBe(true);expect(abortedFiveSecondsLate).toBe(true);expect(wrapper.used).toBe(2);
 expect(wrapper.budgetExhausted).toBe(true);
});

it('documented tool budget preserves eight real calls and counts gaps after first tool',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);let calls=0;
 const module:ToolModule={spec:{name:'read_fixture',family:'knowledge',cacheTtlMs:0,description:'Controlled fixture',params:{key:{type:'string',required:true}}},available:()=>({available:true}),run:async()=>{calls++;return {ok:true};}};
 const config=parseToolsConfig({budget:{calls:8,wallMs:240000}});
 expect(config.budget).toEqual({calls:8,wallMs:240000,resultChars:6000});
 const kit=new ToolKit(config,{},[module]);
 const limited=kit.forTurn({audience:'owner'})!;
 for(let n=0;n<9;n++)await limited.execute({action:'tool',tool:'read_fixture',args:{key:String(n)}});
 expect(calls).toBe(8);expect(limited.budgetExhausted).toBe(true);
 const gap=kit.forTurn({audience:'owner'})!;
 await gap.execute({action:'tool',tool:'read_fixture',args:{key:'first'}});
 await vi.advanceTimersByTimeAsync(240000);
 await gap.execute({action:'tool',tool:'read_fixture',args:{key:'after_gap'}});
 expect(calls).toBe(9);expect(gap.budgetExhausted).toBe(true);
});

it('model timeout knobs remain absent from the reviewed models config',()=>{
 expect(()=>parseModelsConfig({timeoutMs:300000})).toThrow(/unknown models field/);
 expect(()=>parseModelsConfig({cli:{gpt:{timeoutMs:300000}}})).toThrow(/unknown cli.gpt field/);
});

it('a non-cooperative base tool settles at its existing 30-second cap without caching late success or replaying',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 const late=deferred<unknown>();let dispatches=0,seen:AbortSignal|undefined;
 const module:ToolModule={spec:{name:'cache_fixture',family:'knowledge',cacheTtlMs:60000,description:'Deferred read',params:{}},available:()=>({available:true}),run:async(_args,_env,signal)=>{dispatches++;seen=signal;return late.promise;}};
 const kit=new ToolKit(parseToolsConfig({budget:{calls:8,wallMs:240000}}),{},[module]),turn=kit.forTurn({audience:'owner'})!;
 const action={action:'tool' as const,tool:'cache_fixture',args:{}};
 let settled=false;const pending=turn.execute(action).then(value=>{settled=true;return value;});
 await vi.advanceTimersByTimeAsync(29999);expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);expect(seen?.aborted).toBe(true);
 expect((await pending).result).toMatchObject({ok:false,state:'unknown'});
 late.resolve({ok:true,answer:'late read'});await vi.advanceTimersByTimeAsync(0);
 expect(kit.report().cache.entries).toBe(0);
 expect(turn.events.filter(event=>event.type==='tool_result')).toEqual([expect.objectContaining({evidence:{status:'failed'}})]);
 expect((await turn.execute(action)).result).toMatchObject({ok:false,state:'unknown',deduplicated:true});
 expect(dispatches).toBe(1);
});

it('an already-cancelled base tool action consumes no calls and emits no successful evidence',async()=>{
 const run=vi.fn(async()=>({ok:true}));
 const module:ToolModule={spec:{name:'read_fixture',family:'knowledge',cacheTtlMs:60000,description:'Read',params:{}},available:()=>({available:true}),run};
 const turn=new ToolKit(parseToolsConfig(),{},[module]).forTurn({audience:'owner'})!;
 const controller=new AbortController();controller.abort();
 await expect(turn.execute({action:'tool',tool:'read_fixture',args:{}},undefined,controller.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(run).not.toHaveBeenCalled();expect(turn.used).toBe(0);expect(turn.events).toEqual([]);
});
