// Owned, controlled quota test writer. No provider, model or external network.
import {UploadStore,parseUploadsConfig} from '../../src/prime/uploads.ts';
const config=JSON.parse(process.argv[2]);
const store=new UploadStore(parseUploadsConfig(config));
try{
 const result=await store.ingestStream('owner',{name:'child.txt',type:'text/plain',chunks:(async function*(){
  yield Buffer.alloc(1024,97);
  process.stdout.write('holding\n');
  await new Promise(resolve=>process.stdin.once('data',resolve));
  yield Buffer.from('done');
 })()});
 process.stdout.write(JSON.stringify({id:result.id})+'\n');
}catch(error){process.stdout.write(JSON.stringify({error:error.message,status:error.status})+'\n');process.exitCode=1;}
process.stdin.destroy();
