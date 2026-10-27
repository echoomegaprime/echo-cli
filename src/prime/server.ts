import {createServer,type IncomingMessage} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {PrimeHub,object,type PrimeRequest} from './hub.js';
import {redact} from '../code/workspace.js';
const assets:Record<string,string>={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/orb.js':'orb.js','/app.js':'app.js','/integrations.js':'integrations.js','/catalog.js':'catalog.js'};
async function body(req:IncomingMessage){
 let size=0;const chunks:Buffer[]=[];
 for await(const part of req){size+=part.length;if(size>131072)throw new Error('Request exceeds 128 KiB');chunks.push(part);}
 return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export async function startPrimeServer(hub:PrimeHub,uiDirectory:string,port=8767){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
 const token=randomBytes(32).toString('hex');let url='',active=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  if(req.headers.host!==new URL(url).host){send(403,{error:'Unrecognized host'});return;}
  const path=new URL(req.url??'/',url).pathname;
  if(path.startsWith('/api/')){
   const supplied=(req.headers.cookie??'').split(';').map(c=>c.trim()).find(c=>c.startsWith('echo_prime='))?.slice(11)??'';
   const allowed=supplied.length===token.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
   if(!allowed||req.headers['x-prime-request']!=='1'||req.headers['sec-fetch-site']==='cross-site'||(req.method==='POST'&&req.headers.origin!==url)){send(403,{error:'Same-origin Prime session required'});return;}
   if(active>=8){send(429,{error:'Too many requests'});return;}active++;
   try{
    if(path==='/api/status'&&req.method==='GET'){send(200,await hub.status());return;}
    if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){send(405,{error:'JSON POST required'});return;}
    const data=await body(req);
    if(path==='/api/search')send(200,{capabilities:await hub.refresh(String(data.query??''))});
    else if(path==='/api/prepare')send(200,await hub.prepare(data as unknown as PrimeRequest));
    else if(path==='/api/execute')send(200,await hub.execute(String(data.id??''),String(data.digest??'')));
    else send(404,{error:'Unknown route'});
   }catch(e){send(400,{error:redact(e instanceof Error?e.message:'Request failed').slice(0,600)});}
   finally{active--;}
   return;
  }
  if(req.method!=='GET'||!assets[path]){send(404,{error:'Not found'});return;}
  try{
   const data=await readFile(join(uiDirectory,assets[path]));
   if(path==='/'||path==='/index.html')res.setHeader('Set-Cookie','echo_prime='+token+'; HttpOnly; SameSite=Strict; Path=/');
   res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(data);
  }catch{send(404,{error:'Asset unavailable'});}
 });
 server.requestTimeout=25000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string'){reject(new Error('Local listener unavailable'));return;}url='http://127.0.0.1:'+a.port;resolve();});});
 return {url,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
