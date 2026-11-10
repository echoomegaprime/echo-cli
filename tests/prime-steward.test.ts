import {expect,it} from 'vitest';
import {connectSteward,validateStewardProposal} from '../src/prime/steward.js';
import {PrimeHub,type Json} from '../src/prime/hub.js';
import {StdioMcp} from '../src/prime/stdio.js';
import {startPrimeServer} from '../src/prime/server.js';
import {fileURLToPath} from 'node:url';
const hash='a'.repeat(64);
const now=()=>new Date().toISOString();
function node(id='fixture-node',state='shadow'){
 return {id,os:'linux',identityVerified:true,identitySha256:'b'.repeat(64),admitted:true,runtime:{state,observedAt:now(),model:'echo-steward:4b-fixture',sha256:hash},evaluation:{verdict:'FAIL'},canary:'UNKNOWN',rollbackReady:false};
}
function fixture(nodes=[node()],inventoryComplete=true){
 const calls:Array<{name:string;args:Json}>=[];
 const inventory={schemaVersion:1,observedAt:now(),inventoryComplete,nodes};
 let transform=(value:Json)=>value;
 const connection={listTools:async()=>['steward_status','steward_advisory'].map(name=>({name,inputSchema:{type:'object'}})),call:async(name:string,args:Json)=>{
  calls.push({name,args});
  return name==='steward_status'?inventory:transform({schemaVersion:1,observedAt:now(),node:args.node,mode:args.mode,requestId:args.requestId,modelSha256:hash,nodeIdentitySha256:'b'.repeat(64),executionAuthorized:false,text:'Fixture advisory only.'});
 }};
 return {connection,calls,inventory,transform:(f:typeof transform)=>{transform=f;}};
}
const tools={status:'steward_status',advisory:'steward_advisory'};
it('reports disconnected coverage instead of inventing fleet residents',async()=>{
 const hub=new PrimeHub({capabilities:[]});
 expect(await hub.stewardStatus()).toMatchObject({state:'disconnected',inventoryComplete:false,executionAvailable:false,promotionAvailable:false,nodes:[]});
 await expect(hub.stewardAsk({node:'quench',mode:'answer',text:'Status?'})).rejects.toThrow(/not connected/);
});
it('covers every owner inventory node including newly enrolled nodes and shows partial coverage',async()=>{
 const f=fixture([node(),{...node('new-node'),admitted:false,runtime:{...node().runtime,state:'unknown'}}]);
 const owner=await connectSteward(f.connection,tools);
 expect(await owner.status()).toMatchObject({state:'connected',inventoryComplete:true,coverageComplete:false,coverage:{total:2,admitted:1,available:1},executionAvailable:false,promotionAvailable:false});
 expect(f.calls).toEqual([{name:'steward_status',args:{}}]);
});
it('binds advisory to fresh admitted identity, exact request/model, and permits FAIL only in shadow',async()=>{
 const f=fixture(),owner=await connectSteward(f.connection,tools);
 expect(await owner.status()).toMatchObject({advisoryCoverageComplete:true,coverageComplete:false,coverage:{residents:0}});
 const result=await owner.ask({node:'fixture-node',mode:'answer',text:'Explain the CPU reading.'});
 expect(result).toMatchObject({node:'fixture-node',mode:'answer',modelSha256:hash,executionAuthorized:false,untrusted:true,text:'Fixture advisory only.'});
 const invocation=f.calls.find(c=>c.name==='steward_advisory')!;
 expect(invocation.args).toMatchObject({node:'fixture-node',mode:'answer',modelSha256:hash,nodeIdentitySha256:'b'.repeat(64),text:'Explain the CPU reading.'});
 expect(invocation.args.requestId).toMatch(/^[0-9a-f-]{36}$/);
 for(const change of [
  ()=>{f.inventory.observedAt='2020-01-01T00:00:00Z';},
  ()=>{f.inventory.nodes[0].runtime.observedAt='2020-01-01T00:00:00Z';},
  ()=>{f.inventory.nodes[0].admitted=false;},
  ()=>{f.inventory.nodes[0].identityVerified=false;},
  ()=>{f.inventory.nodes[0].runtime.state='resident';},
 ]){
  const bad=fixture(); change.call(null);
  const before=f.calls.length;
  await expect(owner.ask({node:'fixture-node',mode:'answer',text:'Status?'})).rejects.toThrow();
  expect(f.calls.slice(before).every(c=>c.name==='steward_status')).toBe(true);
  Object.assign(f.inventory,bad.inventory);
 }
});
it('counts resident coverage only after current PASS, canary and rollback owner readback',async()=>{
 const f=fixture([node('fixture-node','resident')]);f.inventory.nodes[0].evaluation.verdict='PASS';f.inventory.nodes[0].canary='PASS';f.inventory.nodes[0].rollbackReady=true;
 const owner=await connectSteward(f.connection,tools);
 expect(await owner.status()).toMatchObject({coverageComplete:true,coverage:{residents:1,available:1}});
 f.inventory.inventoryComplete=false;
 expect(await owner.status()).toMatchObject({coverageComplete:false,inventoryComplete:false});
});
it('rejects arbitrary node/transport/authority fields and unknown modes before owner inference',async()=>{
 const f=fixture(),owner=await connectSteward(f.connection,tools);
 for(const input of [
  {node:'missing',mode:'answer',text:'Check'},
  {node:'fixture-node',mode:'execute',text:'Check'},
  {node:'fixture-node',mode:'answer',text:'Check',url:'http://attacker'},
  {node:'fixture-node',mode:'answer',text:'Check',confirm:'EXECUTE'},
  {node:'fixture-node',mode:'proposal',text:'Check'},
 ])await expect(owner.ask(input)).rejects.toThrow();
 expect(f.calls.every(c=>c.name==='steward_status')).toBe(true);
});
it('rejects stale, forged, foreign-node, foreign-model and authority-bearing owner receipts',async()=>{
 for(const patch of [{node:'other'},{modelSha256:'b'.repeat(64)},{nodeIdentitySha256:'c'.repeat(64)},{requestId:'foreign'},{mode:'proposal'},{observedAt:'2020-01-01T00:00:00Z'},{executionAuthorized:true},{shell:'do something'}]){
  const f=fixture();f.transform(v=>({...v,...patch}));const owner=await connectSteward(f.connection,tools);
  await expect(owner.ask({node:'fixture-node',mode:'answer',text:'Check'})).rejects.toThrow();
 }
});
it('refuses invalid/duplicate identities and never exposes arbitrary owner fields',async()=>{
 const f=fixture([node(),node()]),owner=await connectSteward(f.connection,tools);
 await expect(owner.status()).rejects.toThrow(/inventory/);
 const clean=fixture();Object.assign(clean.inventory.nodes[0],{endpoint:'private-address',api_key:'hidden-fixture'});
 expect(JSON.stringify(await (await connectSteward(clean.connection,tools)).status())).not.toContain('hidden-fixture');
});
const proposal=()=>({diagnosis:'Fixture stopped service.',decision:'ACT',reason:'A specific transient fault is established.',action:{cap:'svc.control',command:'restart',options:{target:'fixture.service'}},verify:{cap:'svc.control',command:'status',options:{target:'fixture.service'},expect:'active'},rollback:'Restore the previous service state.',rollback_action:null,escalate_when:['Restart fails.']});
it('validates canonical vocabulary, derives risk, binds every target and refuses executable additions',()=>{
 expect(validateStewardProposal(proposal(),'fixture.service')).toMatchObject({action:{risk_tier:1,reversible:true}});
 for(const p of [
  {...proposal(),shell:'restart anything'},
  {...proposal(),action:{cap:'shell',command:'exec',options:{target:'fixture.service'}}},
  {...proposal(),action:{...proposal().action,risk_tier:0}},
  {...proposal(),verify:{...proposal().verify,command:'restart'}},
  {...proposal(),action:{...proposal().action,options:{target:'foreign.service'}}},
  {...proposal(),decision:'NO_ACTION'},
 ])expect(()=>validateStewardProposal(p,'fixture.service')).toThrow();
 expect(validateStewardProposal({...proposal(),decision:'ESCALATE',action:null,verify:null,rollback_action:null},'fixture.service')).toMatchObject({decision:'ESCALATE',action:null});
});
it('serves the real same-origin HTTP to stdio MCP advisory path and denies untrusted calls',async()=>{
 const connection=await StdioMcp.connect({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/steward-mcp.mjs',import.meta.url))]});
 const steward=await connectSteward(connection,tools),hub=new PrimeHub({capabilities:[],steward});
 const server=await startPrimeServer(hub,fileURLToPath(new URL('../ui/echo-prime/',import.meta.url)),0);
 try{
  expect((await fetch(server.url+'/api/steward/status')).status).toBe(403);
  const page=await fetch(server.url),cookie=page.headers.get('set-cookie')!.split(';')[0];
  const headers={cookie,'x-prime-request':'1',origin:server.url,'content-type':'application/json'};
  expect(await (await fetch(server.url+'/api/steward/status',{headers})).json()).toMatchObject({state:'connected',coverage:{total:1}});
  const payload=JSON.stringify({node:'fixture-node',mode:'answer',text:'Explain the fixture state.'});
  expect(await (await fetch(server.url+'/api/steward/ask',{method:'POST',headers,body:payload})).json()).toMatchObject({text:'MCP fixture answer.',executionAuthorized:false});
  expect((await fetch(server.url+'/api/steward/ask',{method:'POST',headers:{...headers,origin:'https://foreign.example'},body:payload})).status).toBe(403);
  for(const path of ['execute','promote','rollback'])expect((await fetch(server.url+'/api/steward/'+path,{method:'POST',headers,body:'{}'})).status).toBe(404);
  expect((await fetch(server.url+'/steward.js')).status).toBe(200);
 }finally{await server.close();connection.close();}
});
