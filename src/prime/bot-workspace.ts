import {BOT_WORKSPACE_CONTRACT} from './bot-workspace-contract.js';
import {WorkspaceHttpError} from './workspace.js';

type Schema={type?:string;properties?:Record<string,Schema>;required?:readonly string[];anyOf?:readonly Schema[];enum?:readonly unknown[];pattern?:string;minLength?:number;maxLength?:number;minimum?:number;maximum?:number;minItems?:number;maxItems?:number;minProperties?:number;uniqueItems?:boolean;items?:Schema};
type Spec={method:'GET'|'POST'|'PUT'|'DELETE';path:string;schema:Schema;readOnly:boolean;query:readonly string[]};
export const BOT_WORKSPACE_OPERATIONS:Readonly<Record<string,Spec>>=BOT_WORKSPACE_CONTRACT;

/** Same closed contract as the SDK adapter. The worker additionally checks
 * provider-specific inputs, bot ownership, resource boundaries and revisions. */
function validate(value:unknown,schema:Schema,depth=0):void{
 const fail=()=>{throw new WorkspaceHttpError(400,'Invalid bot workspace parameters');};
 if(depth>16)fail();
 if(schema.anyOf){for(const shape of schema.anyOf){try{validate(value,shape,depth+1);return;}catch{/* Try the next closed schema. */}}fail();}
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const data=value as Record<string,unknown>,properties=schema.properties??{};
  if(Object.keys(data).some(key=>!Object.hasOwn(properties,key))||(schema.required??[]).some(key=>!Object.hasOwn(data,key))||Object.keys(data).length<(schema.minProperties??0))fail();
  for(const [key,item] of Object.entries(data))validate(item,properties[key],depth+1);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??256))return fail();
  if(schema.uniqueItems&&new Set(value.map(item=>JSON.stringify(item))).size!==value.length)fail();
  for(const item of value)validate(item,schema.items??{},depth+1);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??12000)||(schema.pattern&&!new RegExp(schema.pattern).test(value)))fail();
 }else if(schema.type==='integer'||schema.type==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isSafeInteger(value))||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum))fail();
 }else if(schema.type==='boolean'){if(typeof value!=='boolean')fail();}
 else if(schema.type==='null'){if(value!==null)fail();}
 if(schema.enum&&!schema.enum.includes(value))fail();
}

export function botWorkspaceRequest(operation:string,input:unknown){
 if(!Object.hasOwn(BOT_WORKSPACE_OPERATIONS,operation))throw new WorkspaceHttpError(404,'Unknown bot workspace operation');
 const spec=BOT_WORKSPACE_OPERATIONS[operation];validate(input,spec.schema);
 const data=input as Record<string,unknown>;
 if(Buffer.byteLength(JSON.stringify(data),'utf8')>1048576)throw new WorkspaceHttpError(413,'Bot workspace request exceeds 1 MiB');
 const route=spec.path.includes('{bot_id}')?spec.path.replace('{bot_id}',String(data.bot_id)):spec.path;
 const query=Object.fromEntries(spec.query.filter(key=>data[key]!==undefined).map(key=>[key,String(data[key])]));
 const body=spec.method==='GET'?undefined:Object.fromEntries(Object.entries(data).filter(([key])=>key!=='bot_id'));
 return {route,method:spec.method,query,body,readOnly:spec.readOnly};
}
