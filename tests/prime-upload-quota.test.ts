import {afterEach,describe,expect,it} from 'vitest';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,lstat,readdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import {PrimeHub} from '../src/prime/hub.js';
import {startPrimeServer} from '../src/prime/server.js';
import {UploadStore,parseUploadsConfig} from '../src/prime/uploads.js';
import {DEFAULT_UPLOAD_QUOTA,UPLOAD_QUOTA_LOCK,UPLOAD_QUOTA_POLICY,type UploadQuota} from '../src/prime/upload-quota.js';

const dirs:string[]=[],children:ChildProcessWithoutNullStreams[]=[];
afterEach(async()=>{
 for(const child of children.splice(0)){if(child.exitCode===null&&child.signalCode===null){const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exit;}}
 for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});
});
async function temp(){const dir=await mkdtemp(join(tmpdir(),'prime-quota-'));dirs.push(dir);return dir;}
const options=(root:string,quota:Partial<UploadQuota>={})=>parseUploadsConfig({root,maxBytes:10000,quota:{accountBytes:100000,storeBytes:200000,accountItems:10,storeItems:20,...quota}});
const text=(n=20)=>({name:'note.txt',type:'text/plain',data:Buffer.alloc(n,97)});
async function bytes(path:string):Promise<number>{
 let total=0;
 for(const name of await readdir(path)){const target=join(path,name),info=await lstat(target);total+=info.isDirectory()?await bytes(target):info.size;}
 return total;
}
async function accountEntries(root:string){return readdir(join(root,'owner')).catch(()=>[]);}
async function heldChild(config:ReturnType<typeof parseUploadsConfig>){
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/upload-quota-child.mjs',import.meta.url)),JSON.stringify(config)],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'pipe'});
 children.push(child);
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Quota child did not reach the holding point')),10000);
  let output='',errors='';
  child.stderr.on('data',chunk=>{errors+=chunk;});
  child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('holding\n')){clearTimeout(timer);resolve();}});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',()=>{clearTimeout(timer);if(!output.includes('holding\n'))reject(new Error('Quota child exited before admission: '+output+errors));});
 });
 return child;
}
function png():Buffer{
 const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);let c=0xffffffff;for(const n of Buffer.concat([type,data])){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}crc.writeUInt32BE((c^0xffffffff)>>>0);return Buffer.concat([length,type,data,crc]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(200);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc(2*(200*4+1)))),chunk('IEND',Buffer.alloc(0))]);
}

describe('aggregate upload storage admission',()=>{
 it('defaults to finite limits and rejects malformed or unbounded quota configuration',async()=>{
  const root=await temp();expect(parseUploadsConfig({root}).quota).toEqual(DEFAULT_UPLOAD_QUOTA);
  expect(parseUploadsConfig({root,quota:{accountItems:2}}).quota).toEqual({...DEFAULT_UPLOAD_QUOTA,accountItems:2});
  for(const quota of [null,[],1,{unknown:1},{accountBytes:0},{storeBytes:-1},{accountItems:1.5},{storeItems:Infinity},{accountBytes:Number.MAX_SAFE_INTEGER+1},{storeBytes:'100'}])expect(()=>parseUploadsConfig({root,quota})).toThrow(/quota/);
 });
 it('shares account and store item limits across uploads and linked artifacts without deleting existing data',async()=>{
  const root=await temp(),store=new UploadStore(options(root,{accountItems:2,storeItems:3}));
  const upload=await store.ingest('owner',text());
  const artifact=await store.registerArtifact('owner',{title:'Linked note',upload_id:upload.id,provenance:{source:'library'}});
  await expect(store.ingest('owner',text())).rejects.toMatchObject({status:507});
  await store.ingest('member',text());
  await expect(store.registerArtifact('other',{title:'Too many',content:'text',provenance:{source:'other'}})).rejects.toMatchObject({status:507});
  expect(await store.get('owner',upload.id)).toMatchObject({sha256:upload.sha256});
  await store.removeArtifact('owner',artifact.id);
  await expect(store.ingest('owner',text())).resolves.toMatchObject({bytes:20});
 });
 it('enforces account byte limits across requests, including persisted metadata, after a clean restart',async()=>{
  const root=await temp(),config=options(root,{accountBytes:3000}),first=new UploadStore(config);
  await first.ingest('owner',text(2200));
  const restarted=new UploadStore(config);
  await expect(restarted.ingest('owner',text(1000))).rejects.toMatchObject({status:507});
  expect(await restarted.usage('owner')).toEqual({count:1,bytes:2200});
  expect(await bytes(join(root,'owner'))).toBeLessThanOrEqual(3000);
  expect(await accountEntries(root)).toHaveLength(1);
 });
 it('enforces the global byte cap even when each account is within its own allowance',async()=>{
  const root=await temp(),store=new UploadStore(options(root,{accountBytes:10000,storeBytes:3300}));
  await store.ingest('owner',text(2200));
  await expect(store.ingest('member',text(1000))).rejects.toMatchObject({status:507});
  expect(await store.list('member')).toEqual([]);
  expect(await store.usage('owner')).toEqual({count:1,bytes:2200});
 });
 it('accounts for metadata and thumbnails, and refuses an inline artifact before exceeding the cap',async()=>{
  const root=await temp(),config=options(root),store=new UploadStore(config),data=png();
  const upload=await store.ingest('owner',{name:'image.png',type:'image/png',data});
  expect(upload.thumb).toBe(true);
  const actual=await bytes(join(root,'owner'));
  expect(actual).toBeGreaterThan(data.length+(await lstat(join(root,'owner',upload.id,'meta.json'))).size);
  const limitedRoot=await temp(),limited=new UploadStore(options(limitedRoot,{accountBytes:actual-1}));
  await expect(limited.ingest('owner',{name:'image.png',type:'image/png',data})).rejects.toMatchObject({status:507});
  expect(await accountEntries(limitedRoot)).toEqual([]);
  const artifactsRoot=await temp(),artifacts=new UploadStore(options(artifactsRoot,{accountBytes:1100}));
  await expect(artifacts.registerArtifact('owner',{title:'Inline',content:'x'.repeat(1000),provenance:{source:'other'}})).rejects.toMatchObject({status:507});
  expect(await artifacts.listArtifacts('owner')).toEqual([]);
  expect(await bytes(join(artifactsRoot,'owner'))).toBe(0);
 });
 it('reserves metadata replacement bytes and leaves the original unchanged on quota rejection',async()=>{
  const root=await temp(),store=new UploadStore(options(root,{accountBytes:1000,accountItems:1}));
  const upload=await store.ingest('owner',text(200)),path=join(root,'owner',upload.id,'meta.json'),before=await readFile(path);
  await expect(store.update('owner',upload.id,{tags:Array.from({length:20},(_,i)=>String(i).padStart(2,'0')+'x'.repeat(38))})).rejects.toMatchObject({status:507});
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(join(root,'owner',upload.id))).toEqual(expect.arrayContaining(['blob','meta.json']));
  expect((await readdir(join(root,'owner',upload.id))).some(name=>name.endsWith('.tmp'))).toBe(false);
  await expect(store.update('owner',upload.id,{name:'new.txt'})).resolves.toMatchObject({name:'new.txt'});
 });
 it('checks streaming growth before each disk write and cleans rejected staging bytes',async()=>{
  const root=await temp(),store=new UploadStore(options(root,{accountBytes:1500}));let observed=0;
  await expect(store.ingestStream('owner',{name:'stream.txt',type:'text/plain',chunks:(async function*(){yield Buffer.alloc(1000,97);observed=await bytes(join(root,'owner'));yield Buffer.alloc(1000,98);})()})).rejects.toMatchObject({status:507});
  expect(observed).toBe(1000);expect(await accountEntries(root)).toEqual([]);
  await expect(store.ingest('owner',text())).resolves.toMatchObject({bytes:20});
 });
 it('cleans only the failed writer data and preserves abandoned staging from a different operation',async()=>{
  const root=await temp(),orphan=join(root,'owner','.tmp_'+randomUUID());await mkdir(orphan,{recursive:true});await writeFile(join(orphan,'blob'),'foreign staging');
  const store=new UploadStore(options(root));
  await expect(store.ingestStream('owner',{name:'failed.txt',type:'text/plain',chunks:(async function*(){yield Buffer.alloc(100,97);throw new Error('fixture stream interrupted');})()})).rejects.toThrow('fixture stream interrupted');
  expect(await readFile(join(orphan,'blob'),'utf8')).toBe('foreign staging');
  expect(await accountEntries(root)).toEqual([orphan.split(/[\\/]/).at(-1)]);
  await expect(store.ingest('owner',text())).resolves.toMatchObject({bytes:20});
 });
 it('releases admission when an iterator factory throws or return rejects or never settles',async()=>{
  const root=await temp(),store=new UploadStore(options(root,{accountBytes:1000}));
  await expect(store.ingestStream('owner',{name:'bad.txt',type:'text/plain',chunks:{[Symbol.asyncIterator](){throw new Error('fixture factory');}}})).rejects.toThrow();
  for(const mode of ['reject','pending']){
   const chunks:AsyncIterable<Buffer>={[Symbol.asyncIterator](){return {next:async()=>({done:false,value:Buffer.alloc(1001,97)}),return:()=>mode==='reject'?Promise.reject(new Error('fixture cleanup refused')):new Promise(()=>{})};}};
   await expect(store.ingestStream('owner',{name:'bad.txt',type:'text/plain',chunks})).rejects.toMatchObject({status:507});
  }
  await expect(store.ingest('owner',text())).resolves.toMatchObject({bytes:20});
 });
 it('serializes different instances and distinguishes contention from quota exhaustion',async()=>{
  const root=await temp(),config=options(root,{accountItems:1});let unblock!:()=>void,entered!:()=>void;
  const hold=new Promise<void>(resolve=>{unblock=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  const writing=new UploadStore(config).ingestStream('owner',{name:'first.txt',type:'text/plain',chunks:(async function*(){yield Buffer.from('first');entered();await hold;yield Buffer.from('last');})()});
  await ready;
  await expect(new UploadStore(config).ingest('owner',text())).rejects.toMatchObject({status:409});
  unblock();await writing;
  await expect(new UploadStore(config).ingest('owner',text())).rejects.toMatchObject({status:507});
 });
 it('preserves quota rejection and releases owned files when the iterator return accessor throws',async()=>{
  const root=await temp(),store=new UploadStore(options(root,{accountBytes:1000,accountItems:1}));
  const chunks:AsyncIterable<Buffer>={[Symbol.asyncIterator](){return {next:async()=>({done:false,value:Buffer.alloc(1001,97)}),get return(){throw new Error('fixture return accessor');}};}};
  await expect(store.ingestStream('owner',{name:'failed.txt',type:'text/plain',chunks})).rejects.toMatchObject({status:507,message:expect.stringContaining('quota')});
  expect(await accountEntries(root)).toEqual([]);
  await expect(lstat(join(root,UPLOAD_QUOTA_LOCK))).rejects.toMatchObject({code:'ENOENT'});
  await expect(store.ingest('owner',text())).resolves.toMatchObject({bytes:20});
 });
 it('holds admission across separate OS processes until the first writer finishes',async()=>{
  const root=await temp(),config=options(root,{accountItems:1}),child=await heldChild(config);
  await expect(new UploadStore(config).ingest('member',text())).rejects.toMatchObject({status:409});
  const exit=new Promise<number|null>(resolve=>child.once('exit',resolve));child.stdin.write('\n');expect(await exit).toBe(0);
  expect(await new UploadStore(config).usage('owner')).toEqual({count:1,bytes:1028});
  await expect(new UploadStore(config).ingest('owner',text())).rejects.toMatchObject({status:507});
 });
 it('fails closed after a crashed process, retains its lock and staging, then recounts orphan bytes after explicit offline recovery',async()=>{
  const root=await temp(),config=options(root,{accountBytes:1200}),child=await heldChild(config);
  const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exit;
  const names=await accountEntries(root),staging=join(root,'owner',names[0]),before=await readFile(join(staging,'blob'));
  const restarted=new UploadStore(config);
  await expect(restarted.ingest('owner',text())).rejects.toMatchObject({status:409});
  expect(await readFile(join(staging,'blob'))).toEqual(before);expect(before.length).toBe(1024);
  expect((await readdir(join(root,UPLOAD_QUOTA_LOCK))).length).toBe(1);
  // The test owns this crashed process and has observed its exit. This is an
  // explicit offline operator recovery, not application stale-lock stealing.
  await rm(join(root,UPLOAD_QUOTA_LOCK),{recursive:true});
  await expect(new UploadStore(config).ingest('owner',text(200))).rejects.toMatchObject({status:507});
  expect(await readFile(join(staging,'blob'))).toEqual(before);
  expect(await accountEntries(root)).toEqual(names);
 });
 it('keeps legacy over-quota data readable and deletable and charges orphan metadata copies',async()=>{
  const root=await temp(),config=options(root,{accountBytes:1000}),store=new UploadStore(config),upload=await store.ingest('owner',text(20));
  const orphan=join(root,'owner',upload.id,'meta.json.'+randomUUID()+'.tmp');await writeFile(orphan,Buffer.alloc(1001,97));
  const restarted=new UploadStore(config);
  expect(await restarted.get('owner',upload.id)).toMatchObject({id:upload.id});
  await expect(restarted.ingest('owner',text())).rejects.toMatchObject({status:507});
  await restarted.remove('owner',upload.id);
  await expect(restarted.ingest('owner',text())).resolves.toMatchObject({bytes:20});
 });
 it('does not let another instance select a larger policy for the same root',async()=>{
  const root=await temp(),first=new UploadStore(options(root,{accountItems:1})),upload=await first.ingest('owner',text());
  const second=new UploadStore(options(root,{accountItems:100}));
  await expect(second.ingest('owner',text())).rejects.toMatchObject({status:503,message:expect.stringContaining('stored policy')});
  expect(await second.get('owner',upload.id)).toMatchObject({id:upload.id});
  expect(JSON.parse(await readFile(join(root,UPLOAD_QUOTA_POLICY),'utf8')).quota.accountItems).toBe(1);
 });
 it('refuses symlink roots, unexpected entries and malformed policy without removing foreign data',async()=>{
  const parent=await temp(),target=join(parent,'real'),root=join(parent,'link');await mkdir(target);await symlink(target,root,'junction');
  await expect(new UploadStore(options(root)).ingest('owner',text())).rejects.toMatchObject({status:503});
  expect(await readdir(target)).toEqual([]);
  const foreign=await temp();await writeFile(join(foreign,'unrelated.txt'),'retain');
  await expect(new UploadStore(options(foreign)).ingest('owner',text())).rejects.toMatchObject({status:503});
  expect(await readFile(join(foreign,'unrelated.txt'),'utf8')).toBe('retain');
  const malformed=await temp();await writeFile(join(malformed,UPLOAD_QUOTA_POLICY),'{}');
  await expect(new UploadStore(options(malformed)).ingest('owner',text())).rejects.toMatchObject({status:503});
  expect(await readFile(join(malformed,UPLOAD_QUOTA_POLICY),'utf8')).toBe('{}');
 });
 it('returns quota exhaustion through actual HTTP for uploads and artifacts while deletion remains available',async()=>{
  const root=await temp(),ui=await temp();await writeFile(join(ui,'index.html'),'<html>quota fixture</html>');
  const store=new UploadStore(options(root,{accountItems:1,storeItems:1})),server=await startPrimeServer(new PrimeHub({capabilities:[],uploads:store}),ui,0);
  try{
   const cookie=(await fetch(server.url)).headers.get('set-cookie')!.split(';')[0],headers={cookie,origin:server.url,'x-prime-request':'1','content-type':'text/plain','x-upload-filename':'note.txt'};
   const first=await fetch(server.url+'/api/prime/uploads',{method:'POST',headers,body:'first'});expect(first.status).toBe(201);const upload=await first.json();
   const artifact=()=>fetch(server.url+'/api/prime/artifacts',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({title:'Report',content:'retained',provenance:{source:'other'}})});
   const full=await artifact();expect(full.status).toBe(507);expect(await full.json()).toMatchObject({error:expect.stringContaining('quota')});
   expect((await fetch(server.url+'/api/prime/uploads/'+upload.id+'/delete',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status).toBe(200);
   expect((await artifact()).status).toBe(201);
   const count=await fetch(server.url+'/api/prime/artifacts',{headers});expect((await count.json()).artifacts).toHaveLength(1);
  }finally{await server.close();}
 });
});
