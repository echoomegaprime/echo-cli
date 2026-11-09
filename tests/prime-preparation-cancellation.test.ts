import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {setImmediate as nextIoTurn} from 'node:timers/promises';
import {DEFAULT_MODELS,ModelRouter,parseModelsConfig} from '../src/code/model-factory.js';
import type {Runner,RunResult} from '../src/code/providers.js';
import {PersonalityForge} from '../src/prime/personality.js';
import {PrimeAutonomyHooks} from '../src/prime/autonomy-hooks.js';
import {FleetRoles} from '../src/prime/roles.js';
import {EcfTools} from '../src/code/tools/ecf.js';
import {ContinuityClient} from '../src/code/continuity.js';
import type {TurnResult} from '../src/code/agent.js';

beforeEach(()=>{
 vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Preparation fixtures never use a real network endpoint'));
});
afterEach(()=>vi.restoreAllMocks());

function deferred<T>(){
 let resolve!:(value:T)=>void;
 return {promise:new Promise<T>(done=>{resolve=done;}),resolve:(value:T)=>resolve(value)};
}
function observe<T>(promise:Promise<T>){
 const observed:{state:'pending'|'fulfilled'|'rejected';value?:T;error?:unknown}={state:'pending'};
 void promise.then(value=>{observed.state='fulfilled';observed.value=value;},error=>{observed.state='rejected';observed.error=error;});
 return observed;
}
const successful:RunResult={code:0,stdout:'fixture status',stderr:'',timedOut:false};

describe('cancellation between parent preparation phases',()=>{
 it('cancels Argon status discovery before a later models command can start',async()=>{
  const late=deferred<RunResult>(),controller=new AbortController(),runner=vi.fn<Runner>(async()=>late.promise);
  const router=new ModelRouter({...DEFAULT_MODELS},{runner});
  const observed=observe(router.variant('argon','gemini-3-pro',controller.signal));
  expect(runner).toHaveBeenCalledOnce();expect(runner.mock.calls[0][1]).toEqual(['--version']);
  controller.abort();await nextIoTurn();const atAbort=observed.state;
  late.resolve(successful);await nextIoTurn();
  expect(atAbort).toBe('rejected');expect(observed.error).toBeInstanceOf(Error);
  expect(runner).toHaveBeenCalledOnce();expect(runner.mock.calls[0][2].signal).toBe(controller.signal);
 });

 it('cancels auto routing during an unavailable probe without probing the next provider',async()=>{
  const late=deferred<RunResult>(),controller=new AbortController(),runner=vi.fn<Runner>(async()=>late.promise);
  const router=new ModelRouter(parseModelsConfig({auto:{classifier:'rules'}}),{runner});
  const observed=observe(router.route('Refactor this TypeScript function and fix its unit tests',{signal:controller.signal}));
  expect(runner).toHaveBeenCalledOnce();expect(runner.mock.calls[0][0]).toBe('claude');
  controller.abort();await nextIoTurn();const atAbort=observed.state;
  late.resolve({...successful,code:1});await nextIoTurn();
  expect(atAbort).toBe('rejected');expect(observed.error).toBeInstanceOf(Error);
  expect(runner).toHaveBeenCalledOnce();expect(runner.mock.calls[0][2].signal).toBe(controller.signal);
 });

 it('discards a cancelled real personality loader result without updating selection or catalog cache',async()=>{
  const late=deferred<unknown>(),controller=new AbortController(),loader=vi.fn(async()=>late.promise),forge=new PersonalityForge();
  const observed=observe(forge.select({prompt:'Inspect the current status',loader,signal:controller.signal}));
  expect(loader).toHaveBeenCalledOnce();controller.abort();await nextIoTurn();const atAbort=observed.state;
  late.resolve([{id:'echo',name:'Cancelled stale catalog',registered:true}]);await nextIoTurn();
  expect(atAbort).toBe('rejected');expect(observed.error).toBeInstanceOf(Error);expect(forge.last()).toBeNull();
  const fresh=vi.fn(async()=>[{id:'echo',name:'Fresh catalog',registered:true}]);
  const result=await forge.catalog(fresh);
  expect(fresh).toHaveBeenCalledOnce();expect(result.entries).toContainEqual({id:'echo',name:'Fresh catalog',registered:true});
 });

 it('cancels continuity preparation before role selection or turn initialization can begin',async()=>{
  const late=deferred<Record<string,unknown>>(),controller=new AbortController(),ecf=new EcfTools(new ContinuityClient());
  const prepare=vi.spyOn(ecf,'prepare').mockImplementation(async()=>late.promise),begin=vi.spyOn(ecf,'begin');
  const roles=new FleetRoles({runtimeDir:process.cwd()});
  const select=vi.spyOn(roles,'select').mockResolvedValue({state:{role:'observer',pinned:false,label:'as observer',source:'rules',available:false},context:'',changed:false});
  const hooks=new PrimeAutonomyHooks(ecf,roles),ctx={owner:true,prompt:'Inspect the status',sessionId:'fixture-session',signal:controller.signal};
  const observed=observe(hooks.before(ctx));expect(prepare).toHaveBeenCalledOnce();
  controller.abort();await nextIoTurn();const atAbort=observed.state;
  late.resolve({state:'prepared',context:'Late context must not trigger another phase.'});await nextIoTurn();
  expect(atAbort).toBe('rejected');expect(observed.error).toBeInstanceOf(Error);
  expect(select).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
 });

 it('cancels the first after-turn capture before a second summary write can start',async()=>{
  const late=deferred<Record<string,unknown>>(),controller=new AbortController(),ecf=new EcfTools(new ContinuityClient());
  const capture=vi.spyOn(ecf,'capture').mockImplementation(async()=>late.promise);
  const hooks=new PrimeAutonomyHooks(ecf,undefined,undefined,1),ctx={owner:true,prompt:'Inspect the status',sessionId:'fixture-session',signal:controller.signal};
  const result:TurnResult={mode:'read-only',sessionId:ctx.sessionId,status:'completed',answer:'Decision: retain the recorded evidence.',pending:0,answerVerification:'unverified_model_text',evidence:[]};
  const observed=observe(hooks.after(ctx,result,[{role:'assistant',content:JSON.stringify({action:'final',content:result.answer})}]));
  expect(capture).toHaveBeenCalledOnce();expect(capture.mock.calls[0][0]).toMatchObject({kind:'decision'});
  controller.abort();await nextIoTurn();const atAbort=observed.state;
  late.resolve({state:'verified',saved:true,receipt:{id:'late-receipt'},message:'Late receipt'});await nextIoTurn();
  expect(atAbort).toBe('rejected');expect(observed.error).toBeInstanceOf(Error);expect(capture).toHaveBeenCalledOnce();
 });
});
