import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioMcp} from '../src/prime/stdio.js';
import {sdkBroker,sdkConnectionConfig} from '../src/prime/sdk.js';
import {object,unwrap,type Json} from '../src/prime/hub.js';
import {SDK_HMAC_UNCONFIGURED} from '../src/bridge/sdk-hmac.js';

const KEY='synthetic-sdk-test-key',SECRET='ab'.repeat(32),CAP='echo.synthetic.signed';
const PARAMS={nested:{z:2,a:1},command:'run',a:'é'};
// Independent Python json.dumps(...,sort_keys=True,separators=(',',':')) reference, not the signer implementation.
const SERIALIZED='{"a":"\\u00e9","command":"run","nested":{"a":1,"z":2}}';
const resources:{connection:StdioMcp;server:Server;directory:string}[]=[];
afterEach(async()=>{vi.unstubAllEnvs();while(resources.length){const r=resources.pop()!;r.connection.close();r.server.closeAllConnections();await new Promise<void>(resolve=>r.server.close(()=>resolve()));rmSync(r.directory,{recursive:true,force:true});}});

async function fixture(mode='ok',secret?:string){
 const requests:Json[]=[],nonces=new Set<string>();
 const server=createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
   const envelope=JSON.parse(Buffer.concat(chunks).toString()) as Json;requests.push(envelope);
   const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
   const challenge=(error='hmac_required_for_tier2_plus',capability=CAP)=>send(423,{detail:{error,capability}});
   if(mode==='other423')return challenge('totp_required_for_tier3');
   if(mode==='wrongcap')return challenge('hmac_required_for_tier2_plus','echo.synthetic.other');
   const auth=object(envelope.auth);
   if(!auth.hmac||mode==='challenge_again')return challenge();
   const canonical='v1|'+KEY+'|'+CAP+'|'+SERIALIZED+'|'+auth.nonce+'|'+auth.ts;
   const expected=createHmac('sha256',Buffer.from(SECRET,'hex')).update(canonical,'utf8').digest('hex');
   if(req.headers['x-echo-api-key']!==KEY||auth.hmac!==expected)return send(401,{detail:{error:'hmac_verification_failed',reason:'signature_mismatch'}});
   if(mode==='replay'||nonces.has(String(auth.nonce)))return send(401,{detail:{error:'hmac_verification_failed',reason:'nonce_replayed'}});
   nonces.add(String(auth.nonce));
   if(mode==='timeout'){res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();const timer=setTimeout(()=>res.end('{}'),2000);res.once('close',()=>clearTimeout(timer));return;}
   send(200,{run_id:'routing-test',status:'ok',result:{status_code:200,body:{ok:true,answer:'accepted',secret_echo:SECRET}}});
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,directory=mkdtempSync(join(tmpdir(),'sdk-signing-')),keyFile=join(directory,'sdk.env');
 writeFileSync(keyFile,'ECHO_PRIME_SDK_KEY='+KEY+'\n',{mode:0o600});
 vi.stubEnv('ECHO_PRIME_SDK_HMAC_SECRET',secret);
 const config=sdkConnectionConfig({command:process.execPath,args:['--import','tsx',fileURLToPath(new URL('../src/bridge/sdk-stdio.ts',import.meta.url))],cwd:fileURLToPath(new URL('..',import.meta.url)),env:{ECHO_GATE_URL:'http://127.0.0.1:'+port+'/sdk/invoke',ECHO_PRIME_SDK_KEY_FILE:keyFile}});
 const connection=await StdioMcp.connect(config,10000);resources.push({connection,server,directory});
 const broker=await sdkBroker(connection,{search:'sdk_search',read:'sdk_read',invoke:'sdk_invoke'});
 const invoke=(timeoutMs?:number)=>broker.invoke({capability:CAP,params:PARAMS,reason:'The owner requested this synthetic offline SDK signing verification.',idempotency_key:'same-operation'},timeoutMs?{timeoutMs}:undefined);
 return {requests,nonces,invoke};
}

describe('SDK HMAC pre-dispatch challenge protocol',()=>{
 it('returns an exact unconfigured blocker and never sends a second request without a valid secret',async()=>{
  for(const secret of [undefined,'invalid']){const f=await fixture('ok',secret),raw=await f.invoke();expect(()=>unwrap(raw)).toThrow(SDK_HMAC_UNCONFIGURED);expect(f.requests).toHaveLength(1);expect(f.requests[0]).not.toHaveProperty('auth');expect(JSON.stringify(raw)).toContain('hmac_signer_unconfigured');}
 });
 it('signs once after the exact challenge, keeps params/context, uses fresh nonces, and redacts the secret',async()=>{
  const f=await fixture('ok',SECRET);
  for(let i=0;i<2;i++){const raw=await f.invoke();expect(unwrap(raw)).toMatchObject({ok:true,answer:'accepted'});expect(JSON.stringify(raw)).not.toContain(SECRET);}
  expect(f.requests).toHaveLength(4);expect(f.nonces.size).toBe(2);
  for(const first of [0,2]){expect(f.requests[first]).not.toHaveProperty('auth');expect(f.requests[first+1].params).toEqual(f.requests[first].params);expect(f.requests[first+1].context).toEqual(f.requests[first].context);const auth=object(f.requests[first+1].auth);expect(auth.nonce).toMatch(/^[a-f0-9]{32}$/);expect(auth.ts).toBeTypeOf('number');expect(Math.abs(Date.now()/1000-Number(auth.ts))).toBeLessThan(5);expect(Object.keys(auth).sort()).toEqual(['hmac','nonce','ts']);}
  expect(JSON.stringify(f.requests)).not.toContain(SECRET);
 });
 it.each(['challenge_again','replay'])('does not retry after the signed request is refused: %s',async mode=>{
  const f=await fixture(mode,SECRET),raw=await f.invoke();expect(()=>unwrap(raw)).toThrow(/hmac|nonce/);expect(f.requests).toHaveLength(2);
 });
 it.each(['other423','wrongcap'])('does not sign unrelated or mismatched challenges: %s',async mode=>{
  const f=await fixture(mode,SECRET),raw=await f.invoke();expect(()=>unwrap(raw)).toThrow();expect(f.requests).toHaveLength(1);expect(f.requests[0]).not.toHaveProperty('auth');
 });
 it('returns signed-attempt timeout as an unknown outcome without retrying',async()=>{
  const f=await fixture('timeout',SECRET),raw=await f.invoke(1000);expect(()=>unwrap(raw)).toThrow('timed out; outcome unknown');expect(f.requests).toHaveLength(2);
 });
 it('preserves a failed signature refusal and never looks up or repairs credentials',async()=>{
  const f=await fixture('ok','cd'.repeat(32)),raw=await f.invoke();expect(()=>unwrap(raw)).toThrow('signature_mismatch');expect(f.requests).toHaveLength(2);expect(f.requests.every(request=>request.capability===CAP)).toBe(true);
 });
});
