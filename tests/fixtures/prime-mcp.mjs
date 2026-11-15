import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 const r=JSON.parse(line);if(r.id===undefined)continue;
 if(r.params?.name==='environment'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify({programData:process.env.ProgramData||null,secretPresent:!!process.env.PRIME_TEST_SECRET})}]}})+'\n');continue;}
 if(r.params?.name==='never')continue;
 const result=r.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}}:r.method==='tools/list'?{tools:[{name:'esh_status',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({ok:true,version:'fixture'})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');
}
