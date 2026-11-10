import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readdir,readFile,rename,rm,rmdir} from 'node:fs/promises';
import {hostname} from 'node:os';
import {join,parse,relative,resolve,sep} from 'node:path';
import {WorkspaceHttpError} from './workspace.js';

export interface UploadQuota {accountBytes:number;storeBytes:number;accountItems:number;storeItems:number}
export const DEFAULT_UPLOAD_QUOTA:Readonly<UploadQuota>=Object.freeze({accountBytes:1024**3,storeBytes:8*1024**3,accountItems:1000,storeItems:10000});
const KEYS=Object.keys(DEFAULT_UPLOAD_QUOTA) as (keyof UploadQuota)[];
export const UPLOAD_QUOTA_LOCK='.quota-lock';
export const UPLOAD_QUOTA_POLICY='.quota-policy.json';
const ACCOUNT=/^[A-Za-z0-9_-]{1,80}$/;
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STAGING=new RegExp('^\\.tmp_'+UUID+'$');
const META_TEMP=new RegExp('^meta\\.json\\.'+UUID+'\\.tmp$');
const badStore=()=>new UploadQuotaError(503,'Upload storage cannot be safely accounted for; new writes are blocked');
const code=(error:unknown)=>error&&typeof error==='object'&&'code' in error?String(error.code):'';

export class UploadQuotaError extends WorkspaceHttpError {}

export function parseUploadQuota(value:unknown):UploadQuota{
 if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error('Invalid uploads configuration: quota must be an object');
 const given=(value??{}) as Record<string,unknown>;
 for(const key of Object.keys(given))if(!(KEYS as string[]).includes(key))throw new Error('Invalid uploads configuration: unknown quota field '+key);
 const quota={...DEFAULT_UPLOAD_QUOTA};
 for(const key of KEYS){
  if(given[key]===undefined)continue;
  if(typeof given[key]!=='number'||!Number.isSafeInteger(given[key])||given[key]<1)throw new Error('Invalid uploads configuration: quota.'+key+' must be a positive safe integer');
  quota[key]=given[key];
 }
 return quota;
}

/** Only ordinary directories are accepted, including every existing ancestor.
 * A local actor able to replace paths while this process runs is outside this lock's trust boundary. */
async function prepareRoot(root:string):Promise<void>{
 const absolute=resolve(root),base=parse(absolute).root;
 if(absolute===base)throw badStore();
 let current=base;
 for(const part of relative(base,absolute).split(sep)){
  current=join(current,part);
  try{await mkdir(current,{mode:0o700});}catch(error){if(code(error)!=='EEXIST')throw badStore();}
  const info=await lstat(current).catch(()=>{throw badStore();});
  if(!info.isDirectory()||info.isSymbolicLink())throw badStore();
 }
}

type Usage={bytes:number;items:number};
const empty=():Usage=>({bytes:0,items:0});
const plus=(left:number,right:number)=>{
 const sum=left+right;
 if(!Number.isSafeInteger(sum)||right<0)throw badStore();
 return sum;
};

/** One root-wide writer owns admission until all payload, metadata and rename work is done.
 * The directory is the cross-process reservation. It is never stolen, even after a crash. */
export class UploadQuotaLease {
 private released=false;
 constructor(private root:string,private account:string,private quota:UploadQuota,private total:Usage,private owned:Usage,private marker:string){}
 reserveBytes(bytes:number):void{
  if(this.released||!Number.isSafeInteger(bytes)||bytes<0)throw badStore();
  const accountBytes=plus(this.owned.bytes,bytes),storeBytes=plus(this.total.bytes,bytes);
  if(accountBytes>this.quota.accountBytes||storeBytes>this.quota.storeBytes)throw new UploadQuotaError(507,'Upload storage byte quota reached; remove existing data or review the storage quota');
  this.owned.bytes=accountBytes;this.total.bytes=storeBytes;
 }
 /** Reserve the temporary copy too. A failed replacement leaves the original intact. */
 async writeJson(target:string,value:unknown):Promise<void>{
  const accountRoot=join(this.root,this.account),rel=relative(accountRoot,target);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||parse(rel).root)throw badStore();
  const bytes=Buffer.from(JSON.stringify(value,null,2),'utf8');
  let prior=0;
  try{const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||!Number.isSafeInteger(info.size))throw badStore();prior=info.size;}
  catch(error){if(code(error)!=='ENOENT')throw error;}
  this.reserveBytes(bytes.length);
  const temp=target+'.'+randomUUID()+'.tmp';
  let committed=false;
  try{
   const file=await open(temp,'wx',0o600);
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   await rename(temp,target);committed=true;
   this.owned.bytes-=prior;this.total.bytes-=prior;
  }finally{if(!committed)await rm(temp,{force:true}).catch(()=>undefined);}
 }
 async release():Promise<void>{
  if(this.released)return;
  this.released=true;
  // Remove only this writer's unguessable marker, then remove an EMPTY lock directory.
  // Never recursively remove a lock or someone else's reservation/evidence.
  await rm(this.marker);
  await rmdir(join(this.root,UPLOAD_QUOTA_LOCK));
 }
}

async function policy(root:string,quota:UploadQuota):Promise<void>{
 const target=join(root,UPLOAD_QUOTA_POLICY);
 try{
  const info=await lstat(target);
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw badStore();
  const value=JSON.parse(await readFile(target,'utf8')) as Record<string,unknown>;
  if(!value||Object.keys(value).sort().join(',')!=='quota,schemaVersion'||value.schemaVersion!==1)throw badStore();
  const stored=value.quota;
  if(!stored||typeof stored!=='object'||Array.isArray(stored)||Object.keys(stored).sort().join(',')!==[...KEYS].sort().join(','))throw badStore();
  if(KEYS.some(key=>(stored as Record<string,unknown>)[key]!==quota[key]))throw new UploadQuotaError(503,'Upload quota configuration differs from the stored policy; stop all writers and review the policy before changing limits');
 }catch(error){
  if(code(error)!=='ENOENT')throw error instanceof UploadQuotaError?error:badStore();
  const file=await open(target,'wx',0o600);
  try{await file.writeFile(JSON.stringify({schemaVersion:1,quota}));await file.sync();}finally{await file.close();}
 }
}

/** Recount actual logical file bytes. No persisted counter or metadata claim is trusted.
 * Orphan staging and atomic-replacement files consume quota and are never deleted here. */
async function scan(root:string,account:string,quota:UploadQuota):Promise<{total:Usage;owned:Usage}>{
 const total=empty(),owned=empty();
 const add=(owner:string,bytes:number,items:number)=>{
  total.bytes=plus(total.bytes,bytes);total.items=plus(total.items,items);
  if(owner===account){owned.bytes=plus(owned.bytes,bytes);owned.items=plus(owned.items,items);}
  if(total.bytes>quota.storeBytes||total.items>quota.storeItems||owned.bytes>quota.accountBytes||owned.items>quota.accountItems)throw new UploadQuotaError(507,'Upload storage is already over quota; existing data remains readable and deletable');
 };
 const directory=async(path:string)=>{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw badStore();return readdir(path);};
 const item=async(owner:string,path:string,artifact:boolean)=>{
  add(owner,0,1);
  for(const name of await directory(path)){
   if(!['meta.json',...(artifact?['content']:['blob','thumb.png'])].includes(name)&&!META_TEMP.test(name))throw badStore();
   const info=await lstat(join(path,name));
   if(!info.isFile()||info.isSymbolicLink()||!Number.isSafeInteger(info.size)||info.size<0)throw badStore();
   add(owner,info.size,0);
  }
 };
 try{
  for(const owner of await directory(root)){
   if(owner===UPLOAD_QUOTA_LOCK||owner===UPLOAD_QUOTA_POLICY)continue;
   if(!ACCOUNT.test(owner))throw badStore();
   const accountRoot=join(root,owner);
   for(const name of await directory(accountRoot)){
    if(name==='_artifacts'){
     const artifacts=join(accountRoot,name);
     for(const id of await directory(artifacts)){
      if(!/^art_[0-9a-f]{32}$/.test(id)&&!STAGING.test(id))throw badStore();
      await item(owner,join(artifacts,id),true);
     }
    }else{
     if(!/^upl_[0-9a-f]{32}$/.test(name)&&!STAGING.test(name))throw badStore();
     await item(owner,join(accountRoot,name),false);
    }
   }
  }
 }catch(error){throw error instanceof UploadQuotaError?error:badStore();}
 return {total,owned};
}

export async function acquireUploadQuota(root:string,account:string,quota:UploadQuota,newItem:boolean):Promise<UploadQuotaLease>{
 if(!ACCOUNT.test(account))throw badStore();
 await prepareRoot(root);
 const lock=join(root,UPLOAD_QUOTA_LOCK);
 try{await mkdir(lock,{mode:0o700});}
 catch(error){
  if(code(error)!=='EEXIST')throw badStore();
  const info=await lstat(lock).catch(()=>{throw badStore();});
  if(!info.isDirectory()||info.isSymbolicLink())throw badStore();
  throw new UploadQuotaError(409,'Upload storage is busy or retains an interrupted writer lock; no new write was admitted');
 }
 const marker=join(lock,'owner-'+randomUUID()+'.json');
 let lease:UploadQuotaLease|undefined;
 try{
  const file=await open(marker,'wx',0o600);
  try{await file.writeFile(JSON.stringify({schemaVersion:1,pid:process.pid,host:hostname(),startedAt:new Date().toISOString()}));await file.sync();}finally{await file.close();}
  await policy(root,quota);
  const {total,owned}=await scan(root,account,quota);
  if(newItem&&(owned.items>=quota.accountItems||total.items>=quota.storeItems))throw new UploadQuotaError(507,'Upload storage item quota reached; remove existing data or review the storage quota');
  if(newItem){owned.items++;total.items++;}
  lease=new UploadQuotaLease(root,account,quota,total,owned,marker);
  return lease;
 }finally{
  if(!lease){await rm(marker,{force:true});await rmdir(lock);}
 }
}
