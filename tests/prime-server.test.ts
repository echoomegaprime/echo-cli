import {it,expect} from 'vitest';
import {startPrimeServer} from '../src/prime/server.js';
import {PrimeHub} from '../src/prime/hub.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {get} from 'node:http';
import {spawnSync} from 'node:child_process';
it('serves only named assets and refuses unauthenticated, cross-origin and rebinding API requests',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prime-'));writeFileSync(join(dir,'index.html'),'<html>Prime</html>');writeFileSync(join(dir,'secret.txt'),'private');
 const s=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0);
 try{
  const page=await fetch(s.url);expect(await page.text()).toContain('Prime');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('content-security-policy')).not.toContain('cloudflareinsights');// a loopback host never allows the Cloudflare beacon
  const cookie=page.headers.get('set-cookie')!.split(';')[0];
  expect((await fetch(s.url+'/api/status')).status).toBe(403);
  expect((await fetch(s.url+'/secret.txt')).status).toBe(404);
  expect((await fetch(s.url+'/api/status',{headers:{cookie,'x-prime-request':'1'}})).status).toBe(200);
  expect((await fetch(s.url+'/api/search',{method:'POST',headers:{cookie,origin:'https://attacker.example','content-type':'application/json','x-prime-request':'1'},body:'{"query":"image"}'})).status).toBe(403);
  const rebound=await new Promise<number|undefined>((resolve,reject)=>{get(s.url+'/api/status',{headers:{cookie,host:'attacker.example','x-prime-request':'1'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
  expect(rebound).toBe(403);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});
it('serves the Echo orb favicon at both icon paths and answers HEAD for static assets like GET without a body',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prime-icon-'));
 const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="22"/></svg>';
 writeFileSync(join(dir,'index.html'),'<html>Prime</html>');writeFileSync(join(dir,'favicon.svg'),svg);
 const s=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0);
 try{
  for(const path of ['/favicon.svg','/favicon.ico']){
   const got=await fetch(s.url+path);
   expect(got.status,path).toBe(200);expect(got.headers.get('content-type'),path).toBe('image/svg+xml');expect(got.headers.get('content-length'),path).toBe(String(Buffer.byteLength(svg)));expect(await got.text()).toBe(svg);
   const head=await fetch(s.url+path,{method:'HEAD'});
   expect(head.status,'HEAD '+path).toBe(200);expect(head.headers.get('content-type')).toBe('image/svg+xml');expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(svg)));expect(await head.text()).toBe('');
  }
  const page=await fetch(s.url,{method:'HEAD'});
  expect(page.status).toBe(200);expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');expect(page.headers.get('content-length')).toBe(String(Buffer.byteLength('<html>Prime</html>')));
  expect(page.headers.get('set-cookie')).toMatch(/^echo_prime=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);expect(await page.text()).toBe('');
  expect((await fetch(s.url+'/favicon.png',{method:'HEAD'})).status).toBe(404);// HEAD only reaches named assets
  expect((await fetch(s.url+'/favicon.svg',{method:'POST'})).status).toBe(404);
  expect((await fetch(s.url+'/api/session',{method:'HEAD'})).status).toBe(403);// the API keeps its own method and session rules
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});
it('refuses malformed cookie bytes without terminating the HTTP process',()=>{
 const serverModule=new URL('../src/prime/server.ts',import.meta.url).href;
 const hubModule=new URL('../src/prime/hub.ts',import.meta.url).href;
 const script=`
  import {startPrimeServer} from ${JSON.stringify(serverModule)};
  import {PrimeHub} from ${JSON.stringify(hubModule)};
  import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
  import {tmpdir} from 'node:os';import {join} from 'node:path';import {get} from 'node:http';
  const dir=mkdtempSync(join(tmpdir(),'prime-cookie-'));writeFileSync(join(dir,'index.html'),'Prime');
  const server=await startPrimeServer(new PrimeHub({capabilities:[]}),dir,0);
  try{
   const codes=[];
   for(const value of ['é'.repeat(64),'é'.repeat(32),'f'.repeat(63),'f'.repeat(65)]){
    codes.push(await new Promise((resolve,reject)=>{
     const request=get(server.url+'/api/status',{headers:{cookie:'echo_prime='+value,'x-prime-request':'1'}},r=>{r.resume();resolve(r.statusCode);});
     request.on('error',reject);request.setTimeout(2000,()=>request.destroy(new Error('Cookie check did not respond')));
    }));
   }
   const page=await fetch(server.url),cookie=page.headers.get('set-cookie').split(';')[0];
   const alive=await fetch(server.url+'/api/status',{headers:{cookie,'x-prime-request':'1'}});
   console.log(JSON.stringify({codes,authenticatedStatus:alive.status}));
  }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
 `;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',timeout:10000,windowsHide:true});
 expect({exit:child.status,diagnostic:child.stderr}).toEqual({exit:0,diagnostic:''});
 expect(JSON.parse(child.stdout.trim())).toEqual({codes:[403,403,403,403],authenticatedStatus:200});
});
