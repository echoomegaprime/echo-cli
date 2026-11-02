// Offline transport fixture. This is not a fleet node or a trained-model acceptance.
import {createInterface} from 'node:readline';
const hash='a'.repeat(64);
for await(const line of createInterface({input:process.stdin})){
 const message=JSON.parse(line);if(!('id' in message))continue;
 let result;
 if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'steward-fixture',version:'1'}};
 else if(message.method==='tools/list')result={tools:['steward_status','steward_advisory'].map(name=>({name,inputSchema:{type:'object'}}))};
 else if(message.method==='tools/call'){
  const p=message.params.arguments,observedAt=new Date().toISOString();
  const body=message.params.name==='steward_status'?{schemaVersion:1,observedAt,inventoryComplete:true,nodes:[{id:'fixture-node',os:'linux',identityVerified:true,identitySha256:'b'.repeat(64),admitted:true,runtime:{state:'shadow',observedAt,model:'echo-steward:4b-fixture',sha256:hash},evaluation:{verdict:'FAIL'},canary:'UNKNOWN',rollbackReady:false}]}:{schemaVersion:1,observedAt,node:p.node,mode:p.mode,requestId:p.requestId,modelSha256:hash,nodeIdentitySha256:p.nodeIdentitySha256,executionAuthorized:false,text:'MCP fixture answer.'};
  result={content:[{type:'text',text:JSON.stringify(body)}]};
 }else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unknown method'}})+'\n');continue;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
}
