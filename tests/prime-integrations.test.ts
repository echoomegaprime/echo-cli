import { describe, it, expect } from 'vitest';
import { PrimeHub, unwrap } from '../src/prime/hub.js';
import { StdioMcp } from '../src/prime/stdio.js';
import { fileURLToPath } from 'node:url';

const cap={id:'echo.media.image_generate',registered:true,health:'amber',scope:'tier:1',tier:1,category:'image',description:'local image generation'};
const tool=(name:string)=>({name,inputSchema:{type:'object',properties:{}}});
describe('Prime integration boundaries',()=>{
  it('unwraps nested SDK HTTP failures as failures rather than green connections',()=>{
    expect(()=>unwrap({ok:false,sdk_result:{ok:false,error:'HTTP 403',body:'{"detail":{"error":"scope_forbidden","required":"continuity.write"}}'}})).toThrow(/continuity.write/);
    expect(()=>unwrap({sdk_result:{status:'ok',result:{status_code:503,body:{ok:false}}}})).toThrow();
  });
  it('keeps disconnected creative requests from fabricating a job',async()=>{
    const h=new PrimeHub({capabilities:[cap]});
    await expect(h.prepare({target:'sdk',name:cap.id,arguments:{command:'generate',options:{prompt:'green mountains'}}})).rejects.toThrow(/not connected/i);
  });
  it('requires review of the exact payload and never retries an uncertain mutation',async()=>{
    const calls:unknown[]=[];
    const h=new PrimeHub({capabilities:[cap],sdk:{search:async()=>[],read:async()=>({kind:'sdk_cap',registration_state:'registered',capability:{id:cap.id}}),invoke:async r=>{calls.push(r);throw new Error('network lost');}}});
    const p=await h.prepare({target:'sdk',name:cap.id,arguments:{command:'generate',options:{prompt:'green mountains'}}});
    await expect(h.execute(p.id,'wrong')).rejects.toThrow(/review/i);
    const result=await h.execute(p.id,p.digest);
    expect(result.state).toBe('uncertain');
    expect(result.requestId).toBeTruthy();
    await expect(h.execute(p.id,p.digest)).rejects.toThrow(/already submitted/i);
    expect(calls).toHaveLength(1);
  });
  it('preserves scope denials with no model or account fallback',async()=>{
    const h=new PrimeHub({capabilities:[cap],sdk:{search:async()=>[],read:async()=>({kind:'sdk_cap',registration_state:'registered',capability:{id:cap.id}}),invoke:async()=>({ok:false,error:'scope_forbidden',required:'creative.write'})}});
    const p=await h.prepare({target:'sdk',name:cap.id,arguments:{command:'generate',options:{}}});
    const result=await h.execute(p.id,p.digest);
    expect(result.state).toBe('blocked');expect(result.detail).toContain('creative.write');
  });
  it('reads ESH status before other tools and keeps an unverified exit distinct from a receipt',async()=>{
    const calls:string[]=[];
    const h=new PrimeHub({capabilities:[],esh:{listTools:async()=>[tool('esh_status'),tool('esh_ledger'),tool('esh_caps'),tool('esh_exec')],call:async(name)=>{calls.push(name);return name==='esh_status'?{ok:true,version:'0.2.0',policy_source:'signed',ledger:{ok:true,entries:4}}:{ok:true,count:0,entries:[]};}}});
    const s=await h.status();expect(calls[0]).toBe('esh_status');expect(s.esh.state).toBe('connected');
    await expect(h.prepare({target:'esh',name:'esh_exec',arguments:{argv:['git','status']}})).rejects.toThrow(/host approval/i);
  });
  it('does not accept mismatched capability identity or owner-disabled video overrides',async()=>{
    const h=new PrimeHub({capabilities:[cap],sdk:{search:async()=>[],read:async()=>({kind:'sdk_cap',registration_state:'registered',capability:{id:'echo.other'}}),invoke:async()=>({})}});
    await expect(h.prepare({target:'sdk',name:cap.id,arguments:{}})).rejects.toThrow(/identity/i);
    await expect(h.prepare({target:'sdk',name:cap.id,arguments:{options:{force_video:true}}})).rejects.toThrow(/owner/i);
  });
});

describe('ESH stdio transport',()=>{
  it('preserves standard Windows verification environment without inheriting provider secrets',async()=>{
    const old=process.env.ProgramData;process.env.ProgramData='C:\\ProgramData';process.env.PRIME_TEST_SECRET='private-fixture';
    let client:StdioMcp|undefined;
    try{client=await StdioMcp.connect({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/prime-mcp.mjs',import.meta.url))]},1000);expect(unwrap(await client.call('environment',{}))).toEqual({programData:'C:\\ProgramData',secretPresent:false});}
    finally{client?.close();if(old===undefined)delete process.env.ProgramData;else process.env.ProgramData=old;delete process.env.PRIME_TEST_SECRET;}
  });
  it('negotiates tools and reads measured status from an independent process',async()=>{
    const client=await StdioMcp.connect({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/prime-mcp.mjs',import.meta.url))]},1000);
    try {expect((await client.listTools()).map(t=>t.name)).toEqual(['esh_status']);expect(unwrap(await client.call('esh_status',{}))).toEqual({ok:true,version:'fixture'});}finally{client.close();}
  });
  it('bounds a nonresponsive server and closes pending calls',async()=>{
    const client=await StdioMcp.connect({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/prime-mcp.mjs',import.meta.url))]},300);
    try {await expect(client.call('never',{})).rejects.toThrow(/timed out/i);}finally{client.close();}
  });
});
