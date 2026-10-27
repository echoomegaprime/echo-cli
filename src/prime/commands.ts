import {Command} from 'commander';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PrimeHub,type Capability,type Json} from './hub.js';
import {StdioMcp,type StdioConfig} from './stdio.js';
import {sdkBroker,type SdkTools} from './sdk.js';
import {startPrimeServer} from './server.js';
interface PrimeConfig {esh?:StdioConfig;sdk?:StdioConfig&{tools:SdkTools;fixedArguments?:Json}}
export function registerPrimeCommands(code:Command){
 code.command('prime').description('Open the local ECHO Prime interface with explicitly configured owner connections')
 .option('--config <file>','Reviewed local MCP connection configuration; never imported automatically')
 .option('--port <number>','Loopback HTTP port','8767')
 .action(async(opts:{config?:string;port:string})=>{
  const config:PrimeConfig=opts.config?JSON.parse(await readFile(opts.config,'utf8')):{};
  const connections:StdioMcp[]=[];
  try{
   const ui=fileURLToPath(new URL('../../ui/echo-prime/',import.meta.url));
   const snapshot=JSON.parse(await readFile(new URL('../../ui/echo-prime/catalog.json',import.meta.url),'utf8')) as {capabilities:Capability[]};
   const esh=config.esh?await StdioMcp.connect(config.esh):undefined;if(esh)connections.push(esh);
   const sdk=config.sdk?await StdioMcp.connect(config.sdk):undefined;if(sdk)connections.push(sdk);
   const hub=new PrimeHub({capabilities:snapshot.capabilities,esh,sdk:sdk&&config.sdk?await sdkBroker(sdk,config.sdk.tools,config.sdk.fixedArguments):undefined});
   const server=await startPrimeServer(hub,ui,Number(opts.port));
   process.stdout.write(JSON.stringify({url:server.url,esh:!!esh,sdk:!!sdk,scope:'local interactive host; no release or cloud deployment'})+'\n');
   const close=async()=>{await server.close();connections.forEach(c=>c.close());};
   process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  }catch(e){connections.forEach(c=>c.close());throw e;}
 });
}
