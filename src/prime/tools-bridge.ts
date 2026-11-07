import {randomUUID} from 'node:crypto';
import {type McpConnection,type SdkBroker,object,unwrap} from './hub.js';
import type {McpGateway,SdkInvoke} from '../code/tools/index.js';

/** Live tools reach vendors through the authenticated SDK broker (canonical flat command plus options fields). Prime never holds the vendor key. */
export function sdkToolInvoke(broker:SdkBroker):SdkInvoke{
 return async(capability,command,options)=>{
  if(!/^echo\.[A-Za-z0-9_.-]{1,180}$/.test(capability))throw new Error('Invalid capability ID');
  if(Object.prototype.hasOwnProperty.call(options,'command'))throw new Error('SDK options cannot override command');
  const raw=await broker.invoke({capability,params:{command,...options},reason:'ECHO Prime live tool call for the current chat turn (read-only knowledge lookup)',idempotency_key:randomUUID()});
  return unwrap(raw);
 };
}
/** Prime's own configured MCP connections (esh, sdk, steward, ...) as an MCP plugin gateway; the tool allow-list decides what the model may touch. */
export function connectionGateway(named:Record<string,McpConnection|undefined>,now:()=>number=Date.now):McpGateway{
 const cache=new Map<string,{at:number;tools:Awaited<ReturnType<McpConnection['listTools']>>}>();
 const tools=async(id:string,connection:McpConnection)=>{
  const hit=cache.get(id);
  if(hit&&now()-hit.at<60000)return hit.tools;
  const list=await connection.listTools();cache.set(id,{at:now(),tools:list});return list;
 };
 return {
  async list(){
   const out=[];
   for(const [id,connection] of Object.entries(named)){
    if(!connection||!/^[A-Za-z0-9_.-]{1,64}$/.test(id))continue;
    try{out.push({id,name:id,tools:(await tools(id,connection)).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}))});}
    catch{out.push({id,name:id,tools:[]});}
   }
   return out;
  },
  async call(id,tool,args){
   const connection=named[id];
   if(!connection)throw new Error('Unknown MCP connection');
   if(!(await tools(id,connection)).some(t=>t.name===tool))throw new Error('MCP tool not advertised');
   return unwrap(await connection.call(tool,object(args)));
  },
 };
}
