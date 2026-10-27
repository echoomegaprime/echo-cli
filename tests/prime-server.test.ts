import {it,expect} from 'vitest';
import {startPrimeServer} from '../src/prime/server.js';
import {PrimeHub} from '../src/prime/hub.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {get} from 'node:http';
it('serves only named assets and refuses unauthenticated, cross-origin and rebinding API requests',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prime-'));writeFileSync(join(dir,'index.html'),'<html>Prime</html>');writeFileSync(join(dir,'secret.txt'),'private');
 const s=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0);
 try{
  const page=await fetch(s.url);expect(await page.text()).toContain('Prime');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const cookie=page.headers.get('set-cookie')!.split(';')[0];
  expect((await fetch(s.url+'/api/status')).status).toBe(403);
  expect((await fetch(s.url+'/secret.txt')).status).toBe(404);
  expect((await fetch(s.url+'/api/status',{headers:{cookie,'x-prime-request':'1'}})).status).toBe(200);
  expect((await fetch(s.url+'/api/search',{method:'POST',headers:{cookie,origin:'https://attacker.example','content-type':'application/json','x-prime-request':'1'},body:'{"query":"image"}'})).status).toBe(403);
  const rebound=await new Promise<number|undefined>((resolve,reject)=>{get(s.url+'/api/status',{headers:{cookie,host:'attacker.example','x-prime-request':'1'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
  expect(rebound).toBe(403);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});
