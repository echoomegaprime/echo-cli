import {Command} from 'commander';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrimeHub,type Capability,type Json} from './hub.js';
import {SharedChat,parseChatConfig} from './chat.js';
import {PersonalityForge} from './personality.js';
import {Workspace} from '../code/workspace.js';
import {SessionStore} from '../code/sessions.js';
import {ModelRouter,parseModelsConfig} from '../code/model-factory.js';
import {SwarmClient,parseSwarmConfig} from './swarm.js';
import {VoiceClient,parseVoiceConfig} from './voice.js';
import {AdkClient,parseAdkConfig} from './agents.js';
import {BotsClient,parseBotsConfig} from './bots.js';
import {BrowserClient,parseBrowserConfig} from './browser.js';
import {AutoAgents,brokerCapabilityLookup} from '../code/tools/autoagents.js';
import {UploadStore,parseUploadsConfig} from './uploads.js';
import {BuildRunner,parseBuildConfig} from './build.js';
import {StdioMcp,type StdioConfig} from './stdio.js';
import {sdkBroker,sdkConnectionConfig,type SdkTools} from './sdk.js';
import {startPrimeServer} from './server.js';
import {connectSteward,type StewardOwner,type StewardTools} from './steward.js';
import type {WorkspaceConfig} from './workspace.js';
import {ToolKit,TOOL_MODULES,parseToolsConfig} from '../code/tools/index.js';
import {connectionGateway,sdkToolInvoke} from './tools-bridge.js';
import {parseAutonomyConfig} from '../code/tools/esh.js';
import {EcfTools} from '../code/tools/ecf.js';
import {ContinuityClient} from '../code/continuity.js';
import {PrimeAutonomyHooks} from './autonomy-hooks.js';
import {FleetRoles,parseRolesConfig} from './roles.js';
import {parseMediaConfig,resolveMediaHost} from './media-collect.js';
import {MediaOutcomes,prepareOutcomesFile} from './media-outcomes.js';
interface PrimeConfig {esh?:StdioConfig;sdk?:StdioConfig&{tools:SdkTools;fixedArguments?:Json};steward?:StdioConfig&{tools:StewardTools};workspace?:WorkspaceConfig;publicOrigin?:string;models?:unknown;chat?:unknown;swarm?:unknown;voice?:unknown;adk?:unknown;bots?:unknown;browser?:unknown;uploads?:unknown;tools?:unknown;build?:unknown;autonomy?:unknown;roles?:unknown;media?:unknown}
export function registerPrimeCommands(code:Command){
 code.command('prime').description('Open the local ECHO Prime interface with explicitly configured owner connections')
 .option('--config <file>','Reviewed local MCP connection configuration; never imported automatically')
 .option('--port <number>','Loopback HTTP port','8767')
 .option('--code-workspace <path>','Directory the read-only code agent may inspect when the configuration has a models section',process.cwd())
 .option('--code-state-dir <path>','Private local session directory for the code agent',join(process.env.LOCALAPPDATA||join(homedir(),'.local','share'),'EchoCode','sessions'))
 .action(async(opts:{config?:string;port:string;codeWorkspace:string;codeStateDir:string})=>{
  const config:PrimeConfig=opts.config?JSON.parse(await readFile(opts.config,'utf8')):{};
  const chatConfig=parseChatConfig(config.chat);
  const autonomy=parseAutonomyConfig(config.autonomy),rolesConfig=parseRolesConfig(config.roles);
  // Media: call kinds the gate runs, time limits and where generated files may be read from. Outcomes of real Studio runs
  // persist beside the code sessions unless the section names another file.
  // On FORGE the generator output directories that exist become readable roots unless the section names its own; every
  // gap that leaves generated files unreadable is logged once here, so a Studio with no pictures is never a silent mystery.
  const media=resolveMediaHost(parseMediaConfig(config.media),config.media),mediaConfig=media.config;
  for(const warning of media.warnings)process.stderr.write(JSON.stringify({schemaVersion:1,event:'prime_media_config_warning',warning})+'\n');
  const outcomesFile=mediaConfig.outcomesFile??join(opts.codeStateDir,'prime-media-outcomes.json');prepareOutcomesFile(outcomesFile);
  const outcomes=new MediaOutcomes({file:outcomesFile});
  const connections:StdioMcp[]=[];
  let builds:BuildRunner|undefined;
  try{
   const ui=fileURLToPath(new URL('../../ui/echo-prime/',import.meta.url));
   const snapshot=JSON.parse(await readFile(new URL('../../ui/echo-prime/catalog.json',import.meta.url),'utf8')) as {capabilities:Capability[]};
   const esh=config.esh?await StdioMcp.connect(config.esh):undefined;if(esh)connections.push(esh);
   const sdk=config.sdk?await StdioMcp.connect(sdkConnectionConfig(config.sdk)):undefined;if(sdk)connections.push(sdk);
   const broker=sdk&&config.sdk?await sdkBroker(sdk,config.sdk.tools,config.sdk.fixedArguments):undefined;
   const ecf=new EcfTools(new ContinuityClient(broker?request=>broker.invoke({capability:request.capability,params:{...request.params},reason:request.reason,idempotency_key:request.idempotencyKey??randomUUID()}):undefined));
   const autonomyHooks=new PrimeAutonomyHooks(ecf,rolesConfig?new FleetRoles(rolesConfig):undefined);
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
   // Live tools are always on for router turns (Commander order 2026-11-04). The reviewed `tools` section only tunes them
   // (families, budget, skill roots, MCP allow-list) or turns them off; vendor keys stay on the SDK gate, never in Prime.
   const toolsConfig=parseToolsConfig(config.tools);
   const tools=router&&toolsConfig.enabled?new ToolKit(toolsConfig,{sdk:broker?sdkToolInvoke(broker):undefined,mcp:connectionGateway({esh,sdk})},TOOL_MODULES):undefined;
   const adk=config.adk!==undefined?new AdkClient(parseAdkConfig(config.adk)):undefined,bots=config.bots!==undefined?new BotsClient(parseBotsConfig(config.bots)):undefined;
   const autoagents=adk&&bots&&broker?new AutoAgents({adk,bots,caps:brokerCapabilityLookup(broker)}):undefined;
   let chat:SharedChat|undefined;
   // Personality Forge settings (off switch, pinned profile) are an owner setting kept beside the code sessions.
   if(router){const store=new SessionStore(opts.codeStateDir);chat=new SharedChat({workspace:new Workspace(opts.codeWorkspace,[store.directory]),store,models:router,tools,personality:new PersonalityForge({file:join(store.directory,'personality-settings.json')}),autonomyHooks,autoagents:toolsConfig.enabled?autoagents:undefined,turnTimeoutMs:chatConfig.turnTimeoutMs});}
   builds=config.build!==undefined?new BuildRunner(parseBuildConfig(config.build)):undefined;
   const uploads=config.uploads!==undefined?new UploadStore(parseUploadsConfig(config.uploads)):undefined;
   // The reviewed `adk` section (loopback echo-adk-api, default 127.0.0.1:8378) is opt-in like `swarm`: absent = Agents view says it is off.
   // Autonomous agent/bot creation from chat needs all three: the ADK service, echoBots and the live catalog (to verify capability ids).
   const hub=new PrimeHub({capabilities:snapshot.capabilities,esh,steward,models:router,chat,tools,build:builds,autonomy,ecf,swarm:config.swarm!==undefined?new SwarmClient(parseSwarmConfig(config.swarm)):undefined,voice:config.voice!==undefined?new VoiceClient(parseVoiceConfig(config.voice)):undefined,adk,bots,uploads,uploadsOwner:config.workspace?.ownerUid??'local',browser:config.browser!==undefined?new BrowserClient(parseBrowserConfig(config.browser)):undefined,sdk:broker,autoagents,mediaConfig,outcomes});
   const server=await startPrimeServer(hub,ui,Number(opts.port),{workspace:config.workspace,publicOrigin:config.publicOrigin,uploads});
   process.stdout.write(JSON.stringify({url:server.url,publicOrigin:config.publicOrigin??null,esh:!!esh,sdk:!!sdk,steward:!!steward,media:{localRoots:mediaConfig.localRoots.length,origins:mediaConfig.origins.length,warnings:media.warnings.length},scope:'loopback host; public ingress requires configured TLS proxy and release evidence'})+'\n');
   const close=async()=>{await server.close();await builds?.close();connections.forEach(c=>c.close());};
   process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  }catch(e){await builds?.close();connections.forEach(c=>c.close());throw e;}
 });
}
