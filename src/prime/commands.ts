import {Command} from 'commander';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {PrimeHub,type Capability,type Json} from './hub.js';
import {SharedChat} from './chat.js';
import {Workspace} from '../code/workspace.js';
import {SessionStore} from '../code/sessions.js';
import {ModelRouter,parseModelsConfig} from '../code/model-factory.js';
import {SwarmClient,parseSwarmConfig} from './swarm.js';
import {AdkClient,parseAdkConfig} from './agents.js';
import {BotsClient,parseBotsConfig} from './bots.js';
import {UploadStore,parseUploadsConfig} from './uploads.js';
import {StdioMcp,type StdioConfig} from './stdio.js';
import {sdkBroker,type SdkTools} from './sdk.js';
import {startPrimeServer} from './server.js';
import {connectSteward,type StewardOwner,type StewardTools} from './steward.js';
import type {WorkspaceConfig} from './workspace.js';
interface PrimeConfig {esh?:StdioConfig;sdk?:StdioConfig&{tools:SdkTools;fixedArguments?:Json};steward?:StdioConfig&{tools:StewardTools};workspace?:WorkspaceConfig;publicOrigin?:string;models?:unknown;swarm?:unknown;adk?:unknown;bots?:unknown;uploads?:unknown}
export function registerPrimeCommands(code:Command){
 code.command('prime').description('Open the local ECHO Prime interface with explicitly configured owner connections')
 .option('--config <file>','Reviewed local MCP connection configuration; never imported automatically')
 .option('--port <number>','Loopback HTTP port','8767')
 .option('--code-workspace <path>','Directory the read-only code agent may inspect when the configuration has a models section',process.cwd())
 .option('--code-state-dir <path>','Private local session directory for the code agent',join(process.env.LOCALAPPDATA||join(homedir(),'.local','share'),'EchoCode','sessions'))
 .action(async(opts:{config?:string;port:string;codeWorkspace:string;codeStateDir:string})=>{
  const config:PrimeConfig=opts.config?JSON.parse(await readFile(opts.config,'utf8')):{};
  const connections:StdioMcp[]=[];
  try{
   const ui=fileURLToPath(new URL('../../ui/echo-prime/',import.meta.url));
   const snapshot=JSON.parse(await readFile(new URL('../../ui/echo-prime/catalog.json',import.meta.url),'utf8')) as {capabilities:Capability[]};
   const esh=config.esh?await StdioMcp.connect(config.esh):undefined;if(esh)connections.push(esh);
   const sdk=config.sdk?await StdioMcp.connect(config.sdk):undefined;if(sdk)connections.push(sdk);
   let steward:StewardOwner|undefined;
   if(config.steward){
    try{
     const owner=await StdioMcp.connect(config.steward,60000);connections.push(owner);
     steward=await connectSteward(owner,config.steward.tools);
    }catch{process.stderr.write(JSON.stringify({schemaVersion:1,event:'steward_owner_unavailable',category:'connection_or_contract'})+'\n');}
   }
   // The reviewed `models` section (default Qwen on a loopback endpoint) is opt-in: without it no router exists, nothing is probed
   // and the code agent is not attached, so a bare config never opens the working directory or starts a vendor CLI.
   const router=config.models!==undefined?new ModelRouter(parseModelsConfig(config.models)):undefined;
   let chat:SharedChat|undefined;
   if(router){const store=new SessionStore(opts.codeStateDir);chat=new SharedChat({workspace:new Workspace(opts.codeWorkspace,[store.directory]),store,models:router});}
   const uploads=config.uploads!==undefined?new UploadStore(parseUploadsConfig(config.uploads)):undefined;
   const hub=new PrimeHub({capabilities:snapshot.capabilities,esh,steward,models:router,chat,swarm:config.swarm!==undefined?new SwarmClient(parseSwarmConfig(config.swarm)):undefined,
    // The reviewed `adk` section (loopback echo-adk-api, default 127.0.0.1:8378) is opt-in like `swarm`: absent = Agents view says it is off.
    adk:config.adk!==undefined?new AdkClient(parseAdkConfig(config.adk)):undefined,bots:config.bots!==undefined?new BotsClient(parseBotsConfig(config.bots)):undefined,uploads,uploadsOwner:config.workspace?.ownerUid??'local',sdk:sdk&&config.sdk?await sdkBroker(sdk,config.sdk.tools,config.sdk.fixedArguments):undefined});
   const server=await startPrimeServer(hub,ui,Number(opts.port),{workspace:config.workspace,publicOrigin:config.publicOrigin,uploads});
   process.stdout.write(JSON.stringify({url:server.url,publicOrigin:config.publicOrigin??null,esh:!!esh,sdk:!!sdk,steward:!!steward,scope:'loopback host; public ingress requires configured TLS proxy and release evidence'})+'\n');
   const close=async()=>{await server.close();connections.forEach(c=>c.close());};
   process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  }catch(e){connections.forEach(c=>c.close());throw e;}
 });
}
