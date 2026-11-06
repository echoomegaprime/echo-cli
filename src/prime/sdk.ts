import {type Capability,type Json,type McpConnection,type SdkBroker,object,unwrap} from './hub.js';
export interface SdkTools {search:string;read:string;invoke:string}
/** The authenticated host owns credentials/account selection; these are fixed per connection. */
export async function sdkBroker(connection:McpConnection,names:SdkTools,fixed:Json={}):Promise<SdkBroker>{
 const tools=await connection.listTools();
 for(const name of Object.values(names))if(!tools.some(t=>t.name===name))throw new Error('SDK tool contract missing: '+name);
 const call=async(name:string,args:Json)=>unwrap(await connection.call(name,{...fixed,...args}));
 return {
  async search(query){
   const result=object(await call(names.search,{target:'sdk_caps',query,max_results:100}));
   if(object(result.sdk_catalog).truncated===true)throw new Error('Catalog search truncated; use a narrower query');
   if(!Array.isArray(result.results))throw new Error('SDK catalog response missing');
   return result.results.map(row=>{
    const r=object(row),m=object(r.metadata);
    return {id:String(r.id??r.capability_id??''),description:String(r.description??''),registered:r.registered===true,health:String(r.health_status??'unknown'),scope:String(m.required_scope??''),tier:Number(m.danger_tier??0),category:'discovered'} satisfies Capability;
   });
  },
  read:capability=>call(names.read,{target:'sdk_cap',capability}),
  // The bridge reads `timeout_ms` as its own gate wait for this call (src/bridge/sdk-stdio.ts); it is never forwarded to the gate.
  invoke:(request,options)=>connection.call(names.invoke,{...fixed,...request,...(options?.timeoutMs?{timeout_ms:Math.round(options.timeoutMs)}:{})},options?.timeoutMs?{timeoutMs:options.timeoutMs+5000}:undefined),
 };
}
