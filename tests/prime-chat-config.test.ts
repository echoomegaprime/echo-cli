import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Command} from 'commander';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerPrimeCommands} from '../src/prime/commands.js';
import * as serverModule from '../src/prime/server.js';
import {StdioMcp} from '../src/prime/stdio.js';
import {ModelRouter} from '../src/code/model-factory.js';

const roots:string[]=[];
const servers:Awaited<ReturnType<typeof serverModule.startPrimeServer>>[]=[];
const signals=['SIGINT','SIGTERM'] as const;
let originalListeners:Map<(typeof signals)[number],Set<(...args:unknown[])=>void>>;

beforeEach(()=>{
 originalListeners=new Map(signals.map(name=>[name,new Set(process.listeners(name))]));
 // Keep the real server, hub, chat and authenticated HTTP paths. The wrapper
 // only records the handle so this command-level test can close its listener.
 const realStart=serverModule.startPrimeServer;
 vi.spyOn(serverModule,'startPrimeServer').mockImplementation(async(...args)=>{
  const server=await realStart(...args);servers.push(server);return server;
 });
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
});
afterEach(async()=>{
 for(const server of servers.splice(0))await server.close();
 for(const name of signals)for(const listener of process.listeners(name)){
  if(!originalListeners.get(name)!.has(listener))process.removeListener(name,listener);
 }
 vi.restoreAllMocks();
 roots.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}));
});

function fixture(config?:Record<string,unknown>){
 const root=mkdtempSync(join(tmpdir(),'prime-chat-config-'));roots.push(root);
 const workspace=join(root,'workspace'),state=join(root,'state'),file=join(root,'prime.json');
 mkdirSync(workspace);if(config!==undefined)writeFileSync(file,JSON.stringify(config));
 const command=new Command().exitOverride();registerPrimeCommands(command);
 return {root,state,run:()=>command.parseAsync(['prime',...(config===undefined?[]:['--config',file]),'--port','0',
  '--code-workspace',workspace,'--code-state-dir',state],{from:'user'})};
}

async function status(){
 expect(servers).toHaveLength(1);
 const url=servers[0].url;
 expect((await fetch(url+'/api/status')).status).toBe(403);
 const page=await fetch(url),cookie=page.headers.get('set-cookie')!.split(';')[0];
 await page.arrayBuffer();
 const response=await fetch(url+'/api/status',{headers:{cookie,origin:url,'x-prime-request':'1'}});
 expect(response.status).toBe(200);
 return response.json();
}

it.each([
 ['omitted',undefined,120000],['empty',{},120000],['explicit default',{turnTimeoutMs:120000},120000],['minimum',{turnTimeoutMs:1000},1000],
 ['longer',{turnTimeoutMs:180000},180000],['maximum',{turnTimeoutMs:300000},300000],
])('ordinary CLI startup advertises the %s reviewed deadline through real authenticated HTTP',async(_name,chat,expected)=>{
 const model=vi.spyOn(ModelRouter.prototype,'turn');
 const connect=vi.spyOn(StdioMcp,'connect');
 const f=fixture({models:{},chat});await f.run();
 expect((await status()).chat).toMatchObject({state:'attached',routing:true,turnTimeoutMs:expected});
 expect(model).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});

it('ordinary CLI startup without --config stays disconnected and makes no owner or model connection',async()=>{
 const model=vi.spyOn(ModelRouter.prototype,'turn'),connect=vi.spyOn(StdioMcp,'connect');
 await fixture().run();
 expect((await status()).chat).toMatchObject({state:'disconnected'});
 expect(model).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});

it('a valid chat section alone does not attach a model router or owner connection',async()=>{
 const model=vi.spyOn(ModelRouter.prototype,'turn'),connect=vi.spyOn(StdioMcp,'connect');
 await fixture({chat:{turnTimeoutMs:300000}}).run();
 expect((await status()).chat.state).toBe('disconnected');
 expect(model).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});

it.each([
 null,false,300000,'300000',[],{turnTimeoutMs:null},{turnTimeoutMs:'300000'},
 {turnTimeoutMs:0},{turnTimeoutMs:999},{turnTimeoutMs:1000.5},{turnTimeoutMs:300001},
 {turnTimeoutMs:1e100},{timeoutMs:300000},{turnTimeoutMs:300000,enabled:true},
].map(chat=>[chat]))('invalid chat configuration %j refuses ordinary startup before connections or state files',async chat=>{
 const connect=vi.spyOn(StdioMcp,'connect').mockRejectedValue(new Error('MCP connection was attempted'));
 const model=vi.spyOn(ModelRouter.prototype,'turn');
 const f=fixture({models:{},chat,esh:{command:process.execPath,args:['-e','process.exit(17)']}});
 await expect(f.run()).rejects.toThrow(/chat.*configuration|chat\.turnTimeoutMs/i);
 expect(connect).not.toHaveBeenCalled();expect(model).not.toHaveBeenCalled();
 expect(serverModule.startPrimeServer).not.toHaveBeenCalled();expect(existsSync(f.state)).toBe(false);
});

it('refuses an invalid deadline even without models and does not echo unknown field values',async()=>{
 const marker='fixture-private-config-value-must-not-be-echoed';
 const f=fixture({chat:{turnTimeoutMs:300000,credential:marker}});
 let failure:unknown;
 try{await f.run();}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toMatch(/chat.*configuration/i);
 expect((failure as Error).message).not.toContain(marker);
 expect(serverModule.startPrimeServer).not.toHaveBeenCalled();expect(existsSync(f.state)).toBe(false);
});
