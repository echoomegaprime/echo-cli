import {afterEach,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPrimeServer} from '../src/prime/server.js';
import {PrimeHub} from '../src/prime/hub.js';

// Route allowlist hygiene: Prime proxies exactly the account routes the Workspace implements
// (accounts_http.py). `/api/auth/refresh` and `/api/auth/verify` were allowlisted although the
// Workspace never served them; they must now fail at Prime's own router before any upstream call.
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function upstream(){
 const calls:string[]=[];
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url??'/','http://localhost').pathname;calls.push(req.method+' '+path);
  const json=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/api/auth/session'){json(200,{authenticated:false,user:null,csrf:null});return;}
  if(path==='/api/auth/reset'&&req.method==='POST'){for await(const _chunk of req){/* drain */}json(200,{message:'Recovery requested.'});return;}
  json(404,{error:'Not found'});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 cleanup.push(()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 const address=server.address();if(!address||typeof address==='string')throw new Error('fixture address');
 return {baseUrl:`http://127.0.0.1:${address.port}`,calls};
}
async function prime(baseUrl?:string){
 const dir=mkdtempSync(join(tmpdir(),'prime-allowlist-'));
 for(const name of ['index.html','layout.js','esh-dock.js','chat-actions.js','styles.css'])writeFileSync(join(dir,name),'/* '+name+' */');
 const server=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0,baseUrl?{workspace:{baseUrl,ownerUid:'owner'}}:{});
 cleanup.push(async()=>{await server.close();rmSync(dir,{recursive:true,force:true});});
 const root=await fetch(server.url),cookie=(root.headers.get('set-cookie')??'').split(';')[0];
 const headers={'x-prime-request':'1',cookie,origin:server.url,'content-type':'application/json','x-echo-csrf':'login'};
 return {url:server.url,cookie,headers};
}
it.each(['refresh','verify'])('refuses POST /api/workspace/auth/%s at the router without contacting the Workspace',async operation=>{
 const up=await upstream(),p=await prime(up.baseUrl);
 const before=up.calls.length;
 const response=await fetch(p.url+'/api/workspace/auth/'+operation,{method:'POST',headers:p.headers,body:'{}'});
 expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'Unknown Workspace route'});
 expect(up.calls.slice(before)).toEqual([]);
 expect(up.calls.some(c=>c.includes('/api/auth/'+operation))).toBe(false);
 expect((await fetch(p.url+'/api/workspace/auth/'+operation,{headers:p.headers})).status).toBe(404);
});
it('still forwards the account routes the Workspace implements',async()=>{
 const up=await upstream(),p=await prime(up.baseUrl);
 const reset=await fetch(p.url+'/api/workspace/auth/reset',{method:'POST',headers:p.headers,body:JSON.stringify({email:'owner@example.test'})});
 expect(reset.status).toBe(200);expect(await reset.json()).toEqual({message:'Recovery requested.'});
 expect(up.calls).toContain('POST /api/auth/reset');
 const session=await fetch(p.url+'/api/workspace/auth/session',{headers:p.headers});expect(session.status).toBe(200);
 expect(up.calls.filter(c=>c==='GET /api/auth/session').length).toBeGreaterThanOrEqual(2);// startup validation + this read
});
// Member management (PRIME_MEMBERS_CONTRACT.md): one GET and three POSTs join the allowlist. An anonymous request to a
// known route is refused at sign-in (401); a sibling path is still unknown (404) and never reaches the Workspace.
it('allowlists exactly the four member-management account routes and keeps their siblings unknown',async()=>{
 const up=await upstream(),p=await prime(up.baseUrl);
 const before=up.calls.length;
 const get=(path:string)=>fetch(p.url+'/api/workspace/auth/'+path,{headers:p.headers});
 const post=(path:string)=>fetch(p.url+'/api/workspace/auth/'+path,{method:'POST',headers:p.headers,body:'{}'});
 expect((await get('invites')).status).toBe(401);
 for(const path of ['usage','invite','invite/revoke'])expect((await post(path)).status,path).toBe(401);
 expect(up.calls.slice(before).every(c=>c==='GET /api/auth/session')).toBe(true);// only the admission read
 const known=up.calls.length;
 for(const path of ['invites/x','invites2','usage/x','invite/x','invite/revoked','invites/revoke'])expect((await get(path)).status,'GET '+path).toBe(404);
 for(const path of ['invites','usage2','usage/x','invite/x','invite/revoke/x','invites/revoke'])expect((await post(path)).status,'POST '+path).toBe(404);
 for(const path of ['usage','invite','invite/revoke'])expect((await get(path)).status,'GET '+path).toBe(404);
 expect(up.calls.slice(known)).toEqual([]);
});
it('serves the layout, ESH dock and chat-actions modules from the asset allowlist only',async()=>{
 const p=await prime();
 for(const name of ['layout.js','esh-dock.js','chat-actions.js']){const r=await fetch(p.url+'/'+name,{headers:{cookie:p.cookie}});expect(r.status).toBe(200);expect(await r.text()).toContain(name);}
 expect((await fetch(p.url+'/layout-private.js',{headers:{cookie:p.cookie}})).status).toBe(404);
});
