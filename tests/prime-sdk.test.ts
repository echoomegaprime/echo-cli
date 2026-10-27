import {it,expect} from 'vitest';
import {sdkBroker} from '../src/prime/sdk.js';
import type {Json} from '../src/prime/hub.js';
it('binds every SDK invocation to the same authenticated host account and exact request ID',async()=>{
 const received:Array<{name:string;args:Json}>=[];
 const connection={listTools:async()=>['search','read','invoke'].map(name=>({name,inputSchema:{type:'object'}})),call:async(name:string,args:Json)=>{received.push({name,args});return {ok:true};}};
 const sdk=await sdkBroker(connection,{search:'search',read:'read',invoke:'invoke'},{link_id:'fixture-intended-account'});
 await sdk.invoke({capability:'echo.media.image_generate',params:{command:'generate',options:{prompt:'mountains'}},reason:'explicit request',idempotency_key:'same-request'});
 expect(received).toEqual([{name:'invoke',args:{link_id:'fixture-intended-account',capability:'echo.media.image_generate',params:{command:'generate',options:{prompt:'mountains'}},reason:'explicit request',idempotency_key:'same-request'}}]);
});
