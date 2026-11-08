import {afterEach, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {BotsClient, DEFAULT_BOTS} from '../src/prime/bots.js';

const cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

it('admits events only through the existing same-origin owner session and forwards one bounded v2 request',async()=>{
 const seen:{url:string;body:unknown}[]=[];
 const id='a'.repeat(32),run='b'.repeat(32),message='c'.repeat(32);
 const worker:Server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  seen.push({url:req.url??'',body:JSON.parse(raw||'{}')});
  res.writeHead(202,{'content-type':'application/json'});
  res.end(JSON.stringify({event_id:'push-1',message_id:message,run_id:run,duplicate:false,status:'queued'}));
 });
 await new Promise<void>(resolve=>worker.listen(0,'127.0.0.1',resolve));
 cleanup.push(()=>new Promise<void>(resolve=>{worker.closeAllConnections();worker.close(()=>resolve());}));
 const directory=mkdtempSync(join(tmpdir(),'echo-event-route-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 writeFileSync(join(directory,'index.html'),'Echo');
 const bots=new BotsClient({...DEFAULT_BOTS,baseUrl:`http://127.0.0.1:${(worker.address() as AddressInfo).port}`});
 const prime=await startPrimeServer(new PrimeHub({capabilities:[],bots}),directory,0);cleanup.push(prime.close);
 const cookie=(await fetch(prime.url)).headers.get('set-cookie')!.split(';')[0];
 const path=prime.url+'/api/prime/bots/'+id+'/events';
 const event={event_id:'push-1',source:'github',text:'Review ready'};
 const headers={cookie,'x-prime-request':'1',origin:prime.url,'content-type':'application/json'};
 const post=(over:Record<string,string>,payload:unknown=event)=>fetch(path,{method:'POST',headers:over,body:JSON.stringify(payload)});
 expect((await post({'content-type':'application/json',origin:prime.url})).status).toBe(403);
 expect((await post({...headers,origin:'https://unrelated.example'})).status).toBe(403);
 expect(seen).toHaveLength(0);
 const accepted=await post(headers);
 expect(accepted.status).toBe(202);
 expect(await accepted.json()).toMatchObject({runId:run,eventId:'push-1',duplicate:false});
 expect(seen).toEqual([{url:'/v2/bots/'+id+'/events',body:event}]);
 expect((await post(headers,{...event,lease:{scopes:['*']}})).status).toBe(400);
 expect(seen).toHaveLength(1);
});
