import {afterEach,it,expect,vi} from 'vitest';
import {sdkBroker,sdkConnectionConfig} from '../src/prime/sdk.js';
import type {Json} from '../src/prime/hub.js';
afterEach(()=>vi.unstubAllEnvs());
it('forwards the trusted signer env only through the SDK connection configuration',()=>{
 const config={command:'node',args:['sdk-stdio.js'],env:{ECHO_GATE_URL:'http://127.0.0.1:8000/sdk/invoke'}};
 vi.stubEnv('ECHO_PRIME_SDK_HMAC_SECRET','ab'.repeat(32));vi.stubEnv('UNRELATED_PRIVATE_TEST','not-forwarded');
 expect(sdkConnectionConfig(config)).toEqual({...config,env:{...config.env,ECHO_PRIME_SDK_HMAC_SECRET:'ab'.repeat(32)}});
 expect(config.env).not.toHaveProperty('ECHO_PRIME_SDK_HMAC_SECRET');expect(sdkConnectionConfig(config).env).not.toHaveProperty('UNRELATED_PRIVATE_TEST');
});
it('binds every SDK invocation to the same authenticated host account and exact request ID',async()=>{
 const received:Array<{name:string;args:Json}>=[];
 const connection={listTools:async()=>['search','read','invoke'].map(name=>({name,inputSchema:{type:'object'}})),call:async(name:string,args:Json)=>{received.push({name,args});return {ok:true};}};
 const sdk=await sdkBroker(connection,{search:'search',read:'read',invoke:'invoke'},{link_id:'fixture-intended-account'});
 await sdk.invoke({capability:'echo.media.image_generate',params:{command:'generate',options:{prompt:'mountains'}},reason:'explicit request',idempotency_key:'same-request'});
 expect(received).toEqual([{name:'invoke',args:{link_id:'fixture-intended-account',capability:'echo.media.image_generate',params:{command:'generate',options:{prompt:'mountains'}},reason:'explicit request',idempotency_key:'same-request'}}]);
});
it('keeps missing and malformed catalog tiers unknown and omits malformed capability IDs',async()=>{
 const rows=[undefined,null,'',false,'0',-1,0.5,0,2].map((danger_tier,index)=>({id:'echo.test.t'+index,registered:true,metadata:{danger_tier,required_scope:'tier:fixture'}}));
 const connection={listTools:async()=>['search','read','invoke'].map(name=>({name,inputSchema:{type:'object'}})),call:async()=>({results:[...rows,{id:'not-a-capability',metadata:{danger_tier:0}}]})};
 const sdk=await sdkBroker(connection,{search:'search',read:'read',invoke:'invoke'}),result=await sdk.search('test');
 expect(result).toHaveLength(9);expect(result.map(row=>row.tier)).toEqual([null,null,null,null,null,null,null,0,2]);
});
it('keeps the default invoke transport wait beyond the bridge deadline',async()=>{
 const call=vi.fn(async()=>({ok:true})),connection={listTools:async()=>['search','read','invoke'].map(name=>({name,inputSchema:{type:'object'}})),call};
 const sdk=await sdkBroker(connection,{search:'search',read:'read',invoke:'invoke'});
 await sdk.invoke({capability:'echo.test.one',params:{},reason:'test',idempotency_key:'same'});
 expect(call).toHaveBeenCalledWith('invoke',expect.any(Object),{timeoutMs:35000});
});
