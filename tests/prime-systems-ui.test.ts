import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';

type Verdict={state:string;text:string;reason:string};
type Probe={ok:true;value:unknown}|{ok:false;error:string};

function load(extra:Record<string,unknown>={}){
 const window:Record<string,unknown>={...extra};
 const document={readyState:'complete',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:()=>{}};
 runInNewContext(readFileSync(join(__dirname,'..','ui','echo-prime','systems.js'),'utf8'),{window,document,console,setTimeout,clearTimeout,MutationObserver:class{observe(){}},Promise});
 return (window.EchoPrimeSystems as {verdicts:(r:Record<string,Probe>)=>Record<string,Verdict>}).verdicts;
}
const ok=(value:unknown):Probe=>({ok:true,value});
const fail=(error:string):Probe=>({ok:false,error});
const healthy={
 health:ok({model:{ok:true,model:'c3po-code:echo-qwen38-abliterated-256k',context_length:262144}}),
 plugins:ok({ecf:{ok:true,status:{eventCount:27867}},crystal:{ok:true,status:{total:12}},esh:{ok:true,status:{version:'0.2.0',policy_mode:'strict'}},personality:{ok:true,status:{service:'echo-voice-gateway'}}}),
 fleet:ok({nodes:[{id:'forge',state:'connected'},{id:'anvil',state:'connected'},{id:'crucible',state:'dormant',reason:'security node, LAN firewalled'}]}),
 swarm:ok({configured:true,available:true}),adk:ok({configured:true,available:true,service:{version:'0.1.0'}}),bots:ok({configured:true,available:true}),
 browser:ok({configured:true,available:false,reason:'ShadowGlass side panel is not connected on the Commander\'s Chrome'}),
};

describe('Echo systems panel verdicts',()=>{
 it('reports every live service with its real state instead of a static "Awaiting connection"',()=>{
  const v=load({EchoPrimeStudio:{}})(healthy);
  expect(v.FORGE).toMatchObject({state:'connected'});expect(v.FORGE.reason).toContain('256K');
  for(const name of ['CONTINUITY','CRYSTAL','ESH','PERSONALITY','SWARM','AGENTS','CREATIVE'])expect(v[name].state,name).toBe('connected');
  expect(v.CRYSTAL.reason).toBe('12 crystals');expect(v.ESH.reason).toBe('v0.2.0 · strict policy');expect(v.AGENTS.reason).toContain('echoBots on');
  expect(v.SHADOWGLASS).toMatchObject({state:'degraded'});expect(v.SHADOWGLASS.reason).toContain('side panel');
  expect(v.NEXUS).toMatchObject({state:'degraded',text:'2 of 3 nodes connected'});expect(v.NEXUS.reason).toContain('crucible: security node');
 });
 it('names the failure instead of hiding it',()=>{
  const v=load()({...healthy,health:ok({model:{ok:false,error:'FORGE must have only the configured model loaded'}}),plugins:ok({ecf:{ok:false,error:'No SOL mission scope'},crystal:{ok:true,status:{}},esh:{ok:true,status:{}}}),swarm:fail('No answer within 12 s'),adk:ok({configured:false,reason:'Echo ADK is off'})});
  expect(v.FORGE).toMatchObject({state:'degraded',text:'Model not ready'});
  expect(v.CONTINUITY).toMatchObject({state:'offline',reason:'No SOL mission scope'});
  expect(v.PERSONALITY).toMatchObject({state:'off',text:'Not configured'});
  expect(v.SWARM).toMatchObject({state:'offline',text:'Unreachable',reason:'No answer within 12 s'});
  expect(v.AGENTS).toMatchObject({state:'off',reason:'Echo ADK is off'});
  expect(v.CREATIVE.state).toBe('off');
 });
 it('never claims a connection for systems Prime has no route to',()=>{
  const v=load({EchoPrimeStudio:{}})(healthy);
  expect(v.CERTFORGE.state).toBe('off');expect(v['MUSIC FORGE'].state).toBe('off');
 });
 it('treats an unreachable Workspace backend as offline for every Workspace-backed row',()=>{
  const v=load()({...healthy,health:fail('Workspace backend is not connected'),plugins:fail('Workspace backend is not connected'),fleet:fail('Workspace backend is not connected')});
  for(const name of ['FORGE','CONTINUITY','CRYSTAL','ESH','PERSONALITY','NEXUS'])expect(v[name].state,name).toBe('offline');
 });
});
