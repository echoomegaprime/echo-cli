import {afterEach,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotsClient,DEFAULT_BOTS,parseBotSchedule} from '../src/prime/bots.js';
import {botWorkspaceRequest} from '../src/prime/bot-workspace.js';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {AutoAgents} from '../src/code/tools/autoagents.js';

const BOT='a'.repeat(32),OTHER='b'.repeat(32),CONNECTION='c'.repeat(32),servers:Server[]=[],dirs:string[]=[];
const CAPTURE='d'.repeat(32),CONTENT='e'.repeat(64),REQUEST='bot-continuity-request';
const continuityReceipt=(verified=false)=>({bot_id:BOT,capture_id:CAPTURE,request_ref:'note-1',title:'Review note',project_id:'test-project',request_id:REQUEST,content_sha256:CONTENT,state:verified?'verified':'uncertain',reason:null,saved:verified,verified,receipt:verified?{id:'note_1',eventId:'event_1',kind:'note',requestId:REQUEST,saved:true,verified:true,receiptState:'capture_verified',duplicate:false,contentSha256:CONTENT}:null,attempts:1,routing_ids:['route_1'],untrusted:true,shared_remote_ledger:true});
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function backend(override?:()=>Record<string,unknown>,status=200){
 const seen:{method:string;path:string;body:unknown;headers:Record<string,unknown>}[]=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks),body=bytes.length?JSON.parse(bytes.toString()):null;
  seen.push({method:req.method!,path:req.url!,body,headers:req.headers});
  const response=override?override():req.url?.endsWith('/marketplace')?{providers:[],configured:false}:req.url?.endsWith('/memory')?{bot_id:BOT,scope:'bot:'+BOT,revision:1,text:'A bounded note',untrusted:true}:{bot_id:BOT,action:body?.action,status:'ready',untrusted:true};
  res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(response));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
 const address=server.address();if(!address||typeof address==='string')throw new Error('port unavailable');
 return {client:new BotsClient({...DEFAULT_BOTS,baseUrl:'http://127.0.0.1:'+address.port}),seen};
}
describe('bot resource contract and owner boundary',()=>{
 it('projects continuity through fixed owner routes and refuses authority overrides before network access',async()=>{
  const input={bot_id:BOT,request_ref:'note-1',title:'Review note',detail:'Explicit note only'};
  expect(botWorkspaceRequest('continuity.capture',input)).toMatchObject({route:'/v2/bots/'+BOT+'/continuity/capture',method:'POST',readOnly:false,body:{request_ref:'note-1',title:'Review note',detail:'Explicit note only'}});
  for(const extra of [{project_id:'other'},{owner:'other'},{scopes:['continuity.write']},{endpoint:'http://other'},{request_ref:'bad key'},{detail:''},{detail:'x'.repeat(4001)}])expect(()=>botWorkspaceRequest('continuity.capture',{...input,...extra})).toThrow();
  expect(()=>botWorkspaceRequest('continuity.reconcile',{bot_id:BOT,capture_id:'../other'})).toThrow();
  let response:Record<string,unknown>=continuityReceipt();const {client,seen}=await backend(()=>response);
  expect(await client.workspace('continuity.capture',input)).toMatchObject({state:'uncertain',saved:false,verified:false,request_ref:'note-1'});
  response=continuityReceipt(true);expect(await client.workspace('continuity.reconcile',{bot_id:BOT,capture_id:CAPTURE})).toMatchObject({verified:true});
  expect(seen.map(row=>[row.method,row.path])).toEqual([['POST','/v2/bots/'+BOT+'/continuity/capture'],['POST','/v2/bots/'+BOT+'/continuity/reconcile']]);
  expect(seen[0].body).toEqual({request_ref:'note-1',title:'Review note',detail:'Explicit note only'});
  expect(seen.every(row=>!row.headers.authorization&&!row.headers['x-echo-api-key']&&!row.headers.origin)).toBe(true);
 });
 it('rejects mismatched or falsely verified continuity receipts without repeating the write',async()=>{
  let reply:Record<string,unknown>=continuityReceipt(true);const {client,seen}=await backend(()=>reply);
  const input={bot_id:BOT,request_ref:'note-1',title:'Review note',detail:'Explicit note only'};
  for(const override of [{request_ref:'another-request'},{receipt:null},{state:'uncertain'},{verified:false},{saved:false},{content_sha256:'0'.repeat(64)},{bot_id:OTHER}]){
   reply={...continuityReceipt(true),...override};
   await expect(client.workspace('continuity.capture',input)).rejects.toMatchObject({status:502,code:'invalid_receipt',outcomeUnknown:true});
  }
  expect(seen).toHaveLength(7);
  for(const malformed of [{...continuityReceipt(),state:'saved'},{...continuityReceipt(true),state:'saved',saved:false,verified:false}]){
   reply=malformed;await expect(client.workspace('continuity.capture',input)).rejects.toMatchObject({status:502,code:'invalid_receipt',outcomeUnknown:true});
  }
  reply={...continuityReceipt(true),state:'saved',verified:false};
  expect(await client.workspace('continuity.capture',input)).toMatchObject({state:'saved',saved:true,verified:false});
  reply={...continuityReceipt(),capture_id:OTHER};
  await expect(client.workspace('continuity.reconcile',{bot_id:BOT,capture_id:CAPTURE})).rejects.toMatchObject({code:'invalid_receipt',outcomeUnknown:true});
 });
 it('keeps status local evidence and enforces owner admission and POST for capture',async()=>{
  let reply:Record<string,unknown>={bot_id:BOT,configured:true,lease_permits_capture:true,remote_authorization_verified:false,shared_remote_ledger:true,untrusted:true,captures:[continuityReceipt()]};
  const {client,seen}=await backend(()=>reply);
  expect(await client.workspace('continuity.status',{bot_id:BOT})).toMatchObject({remote_authorization_verified:false,captures:[{verified:false}]});
  reply={...reply,remote_authorization_verified:true};await expect(client.workspace('continuity.status',{bot_id:BOT})).rejects.toMatchObject({code:'invalid_receipt',outcomeUnknown:false});
  reply={...reply,remote_authorization_verified:false,captures:[continuityReceipt(),continuityReceipt()]};await expect(client.workspace('continuity.status',{bot_id:BOT})).rejects.toMatchObject({code:'invalid_receipt'});
  const dir=mkdtempSync(join(tmpdir(),'echo-continuity-owner-'));dirs.push(dir);writeFileSync(join(dir,'index.html'),'<h1>Owner test</h1>');
  const prime=await startPrimeServer(new PrimeHub({capabilities:[],bots:client}),dir,0);
  try{
   const cookie=(await fetch(prime.url)).headers.get('set-cookie')!.split(';')[0],route=prime.url+'/api/prime/bots/workspace/continuity.capture';
   const headers={cookie,'x-prime-request':'1','content-type':'application/json'},before=seen.length;
   expect((await fetch(route+'?bot_id='+BOT,{headers})).status).toBe(405);
   expect((await fetch(route,{method:'POST',headers:{...headers,origin:'https://untrusted.invalid'},body:JSON.stringify({bot_id:BOT,request_ref:'note-1',title:'Note',detail:'Text'})})).status).toBe(403);
   expect(seen).toHaveLength(before);
  }finally{await prime.close();}
 });
 it('preserves missing capture outcome metadata as unknown through the actual owner HTTP boundary',async()=>{
  let reply:Record<string,unknown>={error:'invalid',message:'Validation refused'};
  const {client,seen}=await backend(()=>reply,400),dir=mkdtempSync(join(tmpdir(),'echo-continuity-refusal-'));dirs.push(dir);writeFileSync(join(dir,'index.html'),'<h1>Owner test</h1>');
  const prime=await startPrimeServer(new PrimeHub({capabilities:[],bots:client}),dir,0);
  try{
   const cookie=(await fetch(prime.url)).headers.get('set-cookie')!.split(';')[0],route=prime.url+'/api/prime/bots/workspace/continuity.capture';
   const options={method:'POST',headers:{cookie,'x-prime-request':'1','content-type':'application/json',origin:prime.url},body:JSON.stringify({bot_id:BOT,request_ref:'note-1',title:'Note',detail:'Text'})};
   const unknown=await fetch(route,options);expect(unknown.status).toBe(400);expect(await unknown.json()).toMatchObject({source:'bot_service',code:'invalid',outcome_unknown:true});
   reply={...reply,outcome_unknown:false};const refused=await fetch(route,options);expect(refused.status).toBe(400);expect(await refused.json()).toMatchObject({source:'bot_service',code:'invalid',outcome_unknown:false});
   expect(seen).toHaveLength(2);
  }finally{await prime.close();}
 });
 it('validates fixed per-bot routes before network access and rejects host/owner/credential overrides',()=>{
  expect(botWorkspaceRequest('browser.act',{bot_id:BOT,action:'navigate',url:'https://example.org'})).toMatchObject({route:'/v2/bots/'+BOT+'/browser/actions',method:'POST',body:{action:'navigate',url:'https://example.org'}});
  for(const payload of [{bot_id:'../../other',action:'snapshot'},{bot_id:BOT,action:'evaluate',script:'1+1'},{bot_id:BOT,action:'snapshot',owner:true},{bot_id:BOT,action:'snapshot',token:'secret'},{bot_id:BOT,action:'snapshot',endpoint:'https://attacker.example'},{bot_id:BOT,action:'snapshot',timeout_ms:30001}])expect(()=>botWorkspaceRequest('browser.act',payload)).toThrow();
  expect(()=>botWorkspaceRequest('__proto__',{})).toThrow();
  expect(()=>botWorkspaceRequest('connection.invoke',{bot_id:BOT,connection_id:CONNECTION,operation_id:'profile',input_json:'{}',url:'https://attacker.example'})).toThrow();
  expect(()=>botWorkspaceRequest('team.import',{bundle_json:'{}'})).toThrow();
 });
 it('projects real local HTTP requests without forwarding credentials and rejects a different bot response',async()=>{
  const {client,seen}=await backend();
  expect(await client.workspace('memory.read',{bot_id:BOT})).toMatchObject({bot_id:BOT,revision:1});
  expect(await client.workspace('browser.act',{bot_id:BOT,action:'snapshot'})).toMatchObject({action:'snapshot'});
  expect(seen.map(row=>[row.method,row.path])).toEqual([['GET','/v2/bots/'+BOT+'/memory'],['POST','/v2/bots/'+BOT+'/browser/actions']]);
  expect(seen[1].body).toEqual({action:'snapshot'});expect(seen.every(row=>!row.headers.authorization&&!row.headers['x-echo-api-key']&&!row.headers.origin)).toBe(true);
  await expect(client.workspace('memory.read',{bot_id:OTHER})).rejects.toThrow('different bot');
 });
 it('refuses mutation through GET and requires the existing owner-cookie/custom-header/Origin admission',async()=>{
  const {client,seen}=await backend(),dir=mkdtempSync(join(tmpdir(),'echo-workspace-ui-'));dirs.push(dir);writeFileSync(join(dir,'index.html'),'<h1>Owner test</h1>');
  const prime=await startPrimeServer(new PrimeHub({capabilities:[],bots:client}),dir,0);
  try{
   const cookie=(await fetch(prime.url)).headers.get('set-cookie')!.split(';')[0],headers={cookie,'x-prime-request':'1'},route=prime.url+'/api/prime/bots/workspace/';
   expect((await fetch(route+'browser.act?bot_id='+BOT+'&action=snapshot',{headers})).status).toBe(405);expect(seen).toHaveLength(0);
   expect((await fetch(route+'marketplace',{headers:{cookie}})).status).toBe(403);expect(seen).toHaveLength(0);
   expect((await fetch(route+'browser.act',{method:'POST',headers:{...headers,'content-type':'application/json',origin:'https://attacker.example'},body:JSON.stringify({bot_id:BOT,action:'snapshot'})})).status).toBe(403);expect(seen).toHaveLength(0);
   const result=await fetch(route+'browser.act',{method:'POST',headers:{...headers,'content-type':'application/json',origin:prime.url},body:JSON.stringify({bot_id:BOT,action:'snapshot'})});expect(result.status).toBe(200);expect(seen).toHaveLength(1);
   expect((await fetch(route+'marketplace',{headers})).status).toBe(200);
  }finally{await prime.close();}
 });
 it('offers resource tools to the owner without exposing OAuth callback, authorization URL, reset or arbitrary destinations to models',async()=>{
  const {client,seen}=await backend(),auto=new AutoAgents({bots:client}),tools=auto.tools(),names=tools.map(tool=>tool.name);
  expect(names).toContain('bot_browser_action');expect(names).toContain('bot_connection_invoke');expect(names.some(name=>/callback|authorize|reset/.test(name))).toBe(false);expect(new Set(names).size).toBe(names.length);expect(names.length).toBeLessThanOrEqual(35);
  const tool=tools.find(item=>item.name==='bot_browser_action')!;
  await expect(tool.run({bot_id:BOT,action:'snapshot'},{owner:false,prompt:'read a page'})).rejects.toThrow('Only the owner');expect(seen).toHaveLength(0);
  expect(await tool.run({bot_id:BOT,action:'snapshot'},{owner:true,prompt:'read a page'})).toMatchObject({untrusted:true,data:{bot_id:BOT,action:'snapshot'}});
 });
 it('accepts new schedule shapes while rejecting mixed calendar fields and unknown timezones',()=>{
  const longCron=Array.from({length:60},(_,i)=>i).join(',')+' '+Array.from({length:24},(_,i)=>i).join(',')+' * * *';
  expect(longCron.length).toBeGreaterThan(200);expect(parseBotSchedule({cron:longCron,tz:'UTC'})).toMatchObject({cron:longCron,tz:'UTC'});
  for(const schedule of [{once_at:'2026-11-09T09:00',tz:'America/Chicago'},{at:'09:00',tz:'UTC',monthdays:[1,15]},{at:'09:00',tz:'UTC',monthdays:[5],months:[1,12]},{cron:'0 9 * * 1-5',tz:'UTC'}])expect(parseBotSchedule(schedule)).toMatchObject({...schedule,missed:'skip'});
  for(const schedule of [{cron:'* *',tz:'UTC'},{once_at:'2026-11-09T09:00',tz:'Unknown/Zone'},{at:'09:00',tz:'UTC',monthdays:[0]},{at:'09:00',tz:'UTC',monthdays:[1],months:[13]},{cron:'0 9 * * 1',tz:'UTC',weekdays:[1]}])expect(()=>parseBotSchedule(schedule)).toThrow();
 });
 it('preserves bounded screenshot and export bytes past generic text limits and refuses corrupted receipts',async()=>{
  const artifact='d'.repeat(32),png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(80000,7)]),base64=png.toString('base64');
  let reply:Record<string,unknown>={bot_id:BOT,artifact_id:artifact,mime_type:'image/png',base64,bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')};
  const {client}=await backend(()=>reply);
  expect((await client.workspace('browser.artifact',{bot_id:BOT,artifact_id:artifact})).base64).toBe(base64);
  reply={...reply,sha256:'0'.repeat(64)};
  await expect(client.workspace('browser.artifact',{bot_id:BOT,artifact_id:artifact})).rejects.toThrow('digest');
  const bundle=JSON.stringify({format:'echo-bots-portable',notes:'Portable notes. '.repeat(6000)});
  reply={bundle_json:bundle,sha256:createHash('sha256').update(bundle).digest('hex')};
  expect((await client.workspace('team.export',{bot_ids:[BOT],name:'Export',kind:'department'})).bundle_json).toBe(bundle);
  reply={...reply,bundle_json:bundle+' '};
  await expect(client.workspace('team.export',{bot_ids:[BOT],name:'Export',kind:'department'})).rejects.toThrow('integrity');
 });
 it('preserves provider timeout uncertainty and typed refusal through the owner HTTP boundary',async()=>{
  const {client}=await backend(()=>({error:'provider_timeout',message:'Provider request timed out',outcome_unknown:true}),504);
  const params={bot_id:BOT,connection_id:CONNECTION,operation_id:'profile',input_json:'{}'};
  await expect(client.workspace('connection.invoke',params)).rejects.toMatchObject({status:504,code:'provider_timeout',outcomeUnknown:true,message:expect.stringContaining('outcome unknown')});
  const dir=mkdtempSync(join(tmpdir(),'echo-workspace-errors-'));dirs.push(dir);writeFileSync(join(dir,'index.html'),'<h1>Owner test</h1>');
  const prime=await startPrimeServer(new PrimeHub({capabilities:[],bots:client}),dir,0);
  try{
   const cookie=(await fetch(prime.url)).headers.get('set-cookie')!.split(';')[0];
   const response=await fetch(prime.url+'/api/prime/bots/workspace/connection.invoke',{method:'POST',headers:{cookie,'x-prime-request':'1','content-type':'application/json',origin:prime.url},body:JSON.stringify(params)});
   expect(response.status).toBe(504);expect(await response.json()).toMatchObject({source:'bot_service',code:'provider_timeout',outcome_unknown:true});
  }finally{await prime.close();}
  const denied=await backend(()=>({error:'policy_denied',message:'Origin is not allowed'}),403);
  await expect(denied.client.workspace('browser.act',{bot_id:BOT,action:'snapshot'})).rejects.toMatchObject({status:403,code:'policy_denied',outcomeUnknown:false});
  const wrong=await backend(()=>({bot_id:OTHER,status:'ready',action:'snapshot',untrusted:true}));
  await expect(wrong.client.workspace('browser.act',{bot_id:BOT,action:'snapshot'})).rejects.toMatchObject({status:502,code:'invalid_receipt',outcomeUnknown:true});
  const unknown=await backend(()=>({error:'unavailable',message:'Internal failure'}),500);
  await expect(unknown.client.workspace('connection.invoke',params)).rejects.toMatchObject({status:500,outcomeUnknown:true});
  const tooLarge=await backend(()=>({data:'x'.repeat(1048576)}));
  await expect(tooLarge.client.workspace('connection.invoke',params)).rejects.toMatchObject({status:502,code:'invalid_receipt',outcomeUnknown:true});
 });
});
