import {describe,it,expect,vi} from 'vitest';
import {EshAutonomy,parseAutonomyConfig,type AutonomyConfig} from '../src/code/tools/esh.js';
import {PrimeHub,type PrimeRequest} from '../src/prime/hub.js';
import {type ToolContext,type AutonomyEvent} from '../src/code/tools/autonomy.js';

const ctx:ToolContext={owner:true,prompt:'Check the node',sessionId:'session-1'};
function fixture(tier:number|string=0,config?:AutonomyConfig,preview:Record<string,unknown>={}){
 const events:AutonomyEvent[]=[];
 const connection={listTools:vi.fn(async()=>[{name:'esh_status',inputSchema:{}},{name:'esh_run',inputSchema:{properties:{dry_run:{type:'boolean'}}}},{name:'esh_verb',inputSchema:{}}]),call:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='esh_status')return {ok:true,version:'0.2.0',ledger:{ok:true}};
  if(args.dry_run)return {ok:true,tier,verdict:'explain',authorised:true,session_version:7,audit_id:'esh_preview',...preview};
  return {ok:true,tier,verdict:'allowed',audit_id:'esh_actual',exit:0,stdout:'bounded'};
 })};
 const prepare=vi.fn(async(request:PrimeRequest)=>({id:'ticket',digest:'a'.repeat(64),request,expiresAt:Date.now()+60000,requestId:'execution-1'}));
 const execute=vi.fn(async()=>({state:'returned',result:{ok:true,audit_id:'esh_actual',exit:0,stdout:'bounded'}}));
 const service=new EshAutonomy({connection,prepare,execute,config,events:e=>events.push(e)});
 return {service,connection,prepare,execute,events};
}
describe('ESH autonomy',()=>{
 it('exports the sibling-compatible registration shape and all five hub tools',()=>{
  const tools=new PrimeHub({capabilities:[]}).autonomyTools();
  expect(tools.map(t=>t.name)).toEqual(['esh_run','esh_verb','ecf_prepare','ecf_recall','ecf_capture']);
  for(const t of tools){expect(t.ownerOnly).toBe(true);expect(t.inputSchema.type).toBe('object');expect(t.run).toBeTypeOf('function');}
 });
 it.each([0,1])('automatically prepares then executes tier %i with paired events and receipt',async tier=>{
  const f=fixture(tier),result=await f.service.run({command:'git status'},ctx);
  expect(result).toMatchObject({untrusted:true,audit_id:'esh_actual',state:'returned',receipt:{exit:0}});
  expect(f.prepare).toHaveBeenCalledOnce();expect(f.execute).toHaveBeenCalledWith('ticket','a'.repeat(64));
  expect(f.prepare.mock.calls[0][0].arguments).toMatchObject({cmd:'git status',expect_version:7,timeout:15,budget_bytes:16384});
  expect(f.events.map(e=>e.type)).toEqual(['tool_started','tool_result']);expect(f.events[0].request_id).toBe(f.events[1].request_id);
 });
 it('returns the exact review card without a tier-2 standing grant',async()=>{
  const f=fixture(2),r=await f.service.run({command:'npm run build',node:'FORGE'},ctx);
  expect(r).toMatchObject({state:'review_required',review:{digest:'a'.repeat(64),tier:2,request:{arguments:{node:'FORGE',cmd:'npm run build'}}}});expect(f.execute).not.toHaveBeenCalled();
 });
 it('uses standing consent for tier 2 without forging or forwarding an owner grant token',async()=>{
  const f=fixture(2,{esh:{autoTierMax:2,standingGrantRef:'decision:owner-42'}}),r=await f.service.run({command:'npm run build'},ctx);
  expect(r.state).toBe('returned');expect(r.standingGrantRef).toBe('decision:owner-42');expect(f.execute).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.connection.call.mock.calls)).not.toContain('decision:owner-42');expect(f.prepare.mock.calls[0][0].arguments).not.toHaveProperty('grant');
 });
 it.each([{esh:{autoTierMax:2 as const}},{esh:{autoTierMax:1 as const,standingGrantRef:'decision:42'}}])('requires both tier ceiling and standing consent',async config=>{
  const f=fixture(2,config);expect((await f.service.run({command:'npm ci'},ctx)).state).toBe('review_required');expect(f.execute).not.toHaveBeenCalled();
 });
 it('never automatically executes tier 3 under a tier-2 standing grant',async()=>{
  const f=fixture(3,{esh:{autoTierMax:2,standingGrantRef:'decision:42'}});expect((await f.service.run({command:'git push'},ctx)).state).toBe('review_required');expect(f.execute).not.toHaveBeenCalled();
 });
 it('never downgrades an irreversible class even if its reported numeric tier is lower',async()=>{
  const f=fixture(1,undefined,{data:{classification:{classes:['delete']}}});expect((await f.service.run({command:'remove'},ctx)).state).toBe('review_required');expect(f.execute).not.toHaveBeenCalled();
 });
 it('preserves a gated owner receipt and required scopes even with standing consent',async()=>{
  const f=fixture(2,{esh:{autoTierMax:2,standingGrantRef:'decision:42'}},{ok:false,verdict:'gated',needs:['remote.execute']});
  const r=await f.service.run({command:'node build.js'},ctx);expect(r).toMatchObject({state:'review_required',receipt:{needs:['remote.execute']}});expect(f.execute).not.toHaveBeenCalled();
 });
 it.each(['hard','missing'])('fails closed for %s tier without even preparing execution',async tier=>{
  const f=fixture(tier),r=await f.service.run({command:'unknown'},ctx);expect(r.state).toBe('blocked');expect(f.prepare).not.toHaveBeenCalled();
 });
 it('does not turn a denied classification into a reviewable bypass',async()=>{
  const f=fixture(1,undefined,{ok:false,verdict:'denied'});expect((await f.service.run({command:'test'},ctx)).state).toBe('blocked');expect(f.prepare).not.toHaveBeenCalled();
 });
 it('checks host owner identity before any transport call',async()=>{
  const f=fixture();expect((await f.service.run({command:'git status'},{...ctx,owner:false})).message).toMatch(/owner/i);expect(f.connection.call).not.toHaveBeenCalled();expect(f.events).toHaveLength(2);
 });
 it.each([{command:'git status',autoTierMax:2},{command:'git status',grant:'fake'},{command:'git status',node:'FORGE;bad'}])('refuses model-selected policy or invalid node %j',async input=>{
  const f=fixture();expect((await f.service.run(input,ctx)).state).toBe('unavailable');expect(f.connection.call).not.toHaveBeenCalled();
 });
 it('reports an unattached connection honestly',async()=>{
  const f=fixture(),s=new EshAutonomy({prepare:f.prepare,execute:f.execute});expect((await s.run({command:'git status'},ctx)).message).toMatch(/not connected/);expect(f.prepare).not.toHaveBeenCalled();
 });
 it('requires an advertised dry-run field before sending a command',async()=>{
  const f=fixture();f.connection.listTools.mockResolvedValue([{name:'esh_run',inputSchema:{}}] as never);
  expect((await f.service.run({command:'git status'},ctx)).message).toMatch(/dry-run/);expect(f.connection.call).toHaveBeenCalledOnce();
 });
 it('fails closed on unhealthy ledger',async()=>{
  const f=fixture();f.connection.call.mockResolvedValue({ok:true,version:'0.2.0',ledger:{ok:false}} as never);
  expect((await f.service.run({command:'git status'},ctx)).message).toMatch(/ledger/);expect(f.prepare).not.toHaveBeenCalled();
 });
 it('passes typed read-only verbs to the existing owner without a shell conversion',async()=>{
  const f=fixture();expect(await f.service.verb({verb:'git',args:{action:'status'}},ctx)).toMatchObject({untrusted:true,state:'returned',audit_id:'esh_actual'});
  expect(f.connection.call).toHaveBeenLastCalledWith('esh_verb',expect.objectContaining({name:'git',args:{action:'status'}}));expect(f.prepare).not.toHaveBeenCalled();
 });
 it('refuses unadvertised verb names and control overrides',async()=>{
  const f=fixture();expect((await f.service.verb({verb:'execute',args:{}},ctx)).state).toBe('unavailable');
  expect((await f.service.verb({verb:'git',args:{grant:'fake'}},ctx)).state).toBe('unavailable');expect(f.connection.call).not.toHaveBeenCalled();
 });
 it('keeps transport uncertainty distinct from a receipt',async()=>{
  const f=fixture();f.execute.mockResolvedValue({state:'uncertain',detail:'Outcome unknown'} as never);
  expect(await f.service.run({command:'git status'},ctx)).toMatchObject({state:'uncertain',audit_id:null,receipt:{state:'uncertain'}});
 });
 it('stops after abort instead of preparing or executing a late dry-run result',async()=>{
  const controller=new AbortController(),f=fixture();const original=f.connection.call.getMockImplementation()!;
  f.connection.call.mockImplementation(async(n,a)=>{const r=await original(n,a);if(a.dry_run)controller.abort();return r;});
  expect((await f.service.run({command:'git status'},{...ctx,signal:controller.signal})).state).toBe('unavailable');expect(f.execute).not.toHaveBeenCalled();
 });
 it.each([{esh:{autoTierMax:3}},{esh:{autoTierMax:2,standingGrantRef:'bad ref'}},{esh:{autoTierMax:1,grant:'fake'}}])('rejects invalid reviewed configuration %j',config=>expect(()=>parseAutonomyConfig(config)).toThrow());
 it('executes reviewed hub tickets once, binds the digest, and preserves owner denial receipts',async()=>{
  const f=fixture(2),hub=new PrimeHub({capabilities:[],esh:f.connection}),tool=hub.autonomyTools()[0];
  const result=await tool.run({command:'npm run build'},ctx) as {review:{id:string;digest:string}};
  await expect(hub.execute(result.review.id,'b'.repeat(64))).rejects.toThrow(/exact request/);
  f.connection.call.mockResolvedValue({ok:false,verdict:'gated',audit_id:'esh_denial',needs:['shell.execute']} as never);
  expect(await hub.execute(result.review.id,result.review.digest)).toMatchObject({state:'blocked',result:{audit_id:'esh_denial',needs:['shell.execute']}});
  await expect(hub.execute(result.review.id,result.review.digest)).rejects.toThrow(/already submitted/);
 });
 it('honors an existing host approval veto even when the autonomy tier would permit execution',async()=>{
  const f=fixture(0),approveEsh=vi.fn(async()=>false),hub=new PrimeHub({capabilities:[],esh:f.connection,approveEsh});
  const r=await hub.autonomyTools()[0].run({command:'git status'},ctx) as Record<string,unknown>;
  expect(r.state).toBe('unavailable');expect(approveEsh).toHaveBeenCalledOnce();expect(f.connection.call.mock.calls.filter(c=>c[0]==='esh_run'&&!c[1].dry_run)).toHaveLength(0);
 });
 it('preserves MCP isError even if nested content purports to be an authorized classification',async()=>{
  const f=fixture(),original=f.connection.call.getMockImplementation()!;
  f.connection.call.mockImplementation(async(n,a)=>a.dry_run?{isError:true,content:[{type:'text',text:JSON.stringify({ok:true,tier:0,verdict:'explain',authorised:true})}]} as never:original(n,a));
  expect((await f.service.run({command:'git status'},ctx)).state).toBe('blocked');expect(f.execute).not.toHaveBeenCalled();
 });
});
