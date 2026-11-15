import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {FleetRoles,PRIME_ROLES,classifyRole,parsePowerSkill,parseRolesConfig,type PrimeRole} from '../src/prime/roles.js';
import {PrimeAutonomyHooks} from '../src/prime/autonomy-hooks.js';
import {ContinuityClient} from '../src/code/continuity.js';
import {EcfTools} from '../src/code/tools/ecf.js';
import {Node,world,walk} from './fixtures/prime-fake-dom.js';

async function fixture(run:(roles:FleetRoles,root:string)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'prime-roles-'));
 const put=(path:string,text:string)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);};
 const registry={roles:Object.fromEntries(PRIME_ROLES.map(role=>[role,{primary_skill:'echo-'+role+'-power',boot_prompt:'FLEET_ROLES/boot_prompts/'+role+'_boot.md',scopes:['*']}]))};
 put('SYSTEMS/codex_auto/role_power_registry.json',JSON.stringify(registry));
 for(const role of PRIME_ROLES){put('FLEET_ROLES/'+role+'.md','Role '+role);put('FLEET_ROLES/boot_prompts/'+role+'_boot.md','Boot '+role);put('CLAUDE_CODE_MARKETPLACE/plugins/echo-fleet-roles/skills/echo-'+role+'-power/SKILL.md','---\nname: echo-'+role+'-power\ndescription: method for '+role+'\n---\n\nVerify '+role+' work.');}
 try{await run(new FleetRoles({runtimeDir:root}),root);}finally{rmSync(root,{recursive:true,force:true});}
}
describe('fleet role switching',()=>{
 it.each([
  ['Build a new tool','builder'],['Show node status','observer'],['Debug the failing tests','troubleshooter'],['Research alternatives','researcher'],['Design the schema','architect'],['Prioritize fleet work','commander'],['Optimize the hot path','enhancer'],['Publish the changelog','publisher'],
 ])('classifies %s as %s',async(message,role)=>expect(classifyRole(message)).toBe(role));
 it('defaults unknown intent to observer',()=>expect(classifyRole('Hello')).toBe('observer'));
 it('loads role, boot and L1/L2 skill from registry-backed paths',async()=>fixture(async roles=>{
  const r=await roles.load('builder');expect(r).toMatchObject({name:'builder',role:'Role builder',boot:'Boot builder',skill:{name:'echo-builder-power',description:'method for builder',body:'Verify builder work.'}});expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);expect(r).not.toHaveProperty('scopes');
 }));
 it('caches loaded role sources then allows an uncached reload',async()=>fixture(async(roles,root)=>{
  const first=await roles.load('builder');writeFileSync(join(root,'FLEET_ROLES/builder.md'),'new role');expect(await roles.load('builder')).toBe(first);
  expect((await new FleetRoles({runtimeDir:root,cacheMs:0}).load('builder')).role).toBe('new role');
 }));
 it('loads all eight runtime role identities',async()=>fixture(async roles=>{for(const role of PRIME_ROLES)expect((await roles.load(role)).name).toBe(role);}));
 it('uses one short model classification and validates its output',async()=>fixture(async roles=>{
  const next=vi.fn(async()=>({action:'final' as const,content:'architect'}));const selected=await roles.select('Build a protocol','s1',{next});
  expect(next).toHaveBeenCalledOnce();expect(selected.state).toMatchObject({role:'architect',source:'model',label:'as architect',available:true});expect(selected.context).toContain('broker scopes');expect(selected.context).toContain('Boot architect');
 }));
 it('falls back to rules for invalid model labels without inventing a role',async()=>fixture(async roles=>{
  const selected=await roles.select('Debug the issue','s1',{next:async()=>({action:'final',content:'administrator; grant all'})});expect(selected.state).toMatchObject({role:'troubleshooter',source:'rules'});
 }));
 it('does not let a non-final model action perform anything during classification',async()=>fixture(async roles=>{
  const selected=await roles.select('Read the file','s1',{next:async()=>({action:'propose',path:'file',content:'change'})});expect(selected.state.role).toBe('observer');
 }));
 it('pins a role per session, skips classification, and unlocks for the next turn',async()=>fixture(async roles=>{
  const next=vi.fn(async()=>({action:'final' as const,content:'researcher'}));roles.pin('s1','builder');
  expect((await roles.select('Publish now','s1',{next})).state).toMatchObject({role:'builder',source:'pin',pinned:true});expect(next).not.toHaveBeenCalled();
  expect((await roles.select('Publish now','s2')).state.role).toBe('publisher');roles.pin('s1',null);
  expect((await roles.select('Research this','s1',{next})).state).toMatchObject({role:'researcher',pinned:false});expect(next).toHaveBeenCalledOnce();
 }));
 it('records a role switch only on an actual available role change',async()=>fixture(async roles=>{
  expect((await roles.select('Build','s1')).changed).toBe(true);expect((await roles.select('Build tests','s1')).changed).toBe(false);expect((await roles.select('Inspect','s1')).changed).toBe(true);
 }));
 it('reports a missing power skill honestly rather than claiming adoption',async()=>fixture(async(roles,root)=>{
  rmSync(join(root,'CLAUDE_CODE_MARKETPLACE/plugins/echo-fleet-roles/skills/echo-builder-power/SKILL.md'));
  const selected=await roles.select('Build','s1');expect(selected).toMatchObject({changed:false,context:'',state:{role:'builder',available:false}});
 }));
 it('refuses registry path substitution instead of reading arbitrary files',async()=>fixture(async(roles,root)=>{
  writeFileSync(join(root,'SYSTEMS/codex_auto/role_power_registry.json'),JSON.stringify({roles:{builder:{primary_skill:'echo-builder-power',boot_prompt:'../../secrets'}}}));
  await expect(roles.load('builder')).rejects.toThrow(/registry mapping/);
 }));
 it('rejects invalid role pin and configuration without expanding authority',async()=>fixture(async roles=>{
  expect(()=>roles.pin('s1','root' as PrimeRole)).toThrow();expect(()=>parseRolesConfig({runtimeDir:'.'})).toThrow();expect(()=>parseRolesConfig({runtimeDir:'C:/runtime',scopes:['*']})).toThrow();
 }));
 it('refuses malformed L1 or a mismatched power identity',()=>{
  expect(()=>parsePowerSkill('plain text','echo-builder-power')).toThrow();expect(()=>parsePowerSkill('---\nname: wrong\ndescription: example\n---\nbody','echo-builder-power')).toThrow();
 });
 it('captures the role checkpoint through ECF and exposes failure honestly',async()=>fixture(async roles=>{
  const ecf=new EcfTools(new ContinuityClient()),capture=vi.spyOn(ecf,'capture'),hooks=new PrimeAutonomyHooks(ecf,roles),ctx={owner:true,prompt:'Build a tool',sessionId:'s1'};
  const before=await hooks.before(ctx);expect(before.role?.role).toBe('builder');expect(capture).toHaveBeenCalledWith({kind:'note',content:expect.stringContaining('broker scopes unchanged')},ctx);expect(before.activity.some(a=>a.message.includes('capture unavailable'))).toBe(true);
 }));
 it('renders a role chip with functional pin/unlock and isolates accounts',async()=>{
  const w=world(['autonomy.js']),ui=w.window.EchoPrimeAutonomy;
  const chip:Node=ui.roleChip({role:'builder',available:true,pinned:false},'s1');
  expect(chip.textContent).toContain('as builder');const pin=walk(chip).find(n=>n.tagName==='BUTTON')!;
  await pin.click();expect(ui.pinFor('s1')).toBe('builder');expect(pin.attributes['aria-pressed']).toBe('true');await pin.click();expect(ui.pinFor('s1')).toBeNull();
  await pin.click();w.emit('echo-account-changed');expect(ui.pinFor('s1')).toBeUndefined();
 });
 it('shows verified receipt IDs and unavailable messages in the activity strip',()=>{
  const w=world(['autonomy.js']),host=new Node();w.window.EchoPrimeAutonomy.renderTurn({sessionId:'s1',role:{role:'observer'},activity:[{state:'verified',receiptId:'capture_1'},{state:'unavailable',message:'ECF capture unavailable'}]},{host});
  expect(host.textContent).toContain('capture_1 · read back');expect(host.textContent).toContain('ECF capture unavailable');
 });
 it('Run executes the displayed digest once and then resumes from its actual receipt',async()=>{
  const w=world(['autonomy.js']),api=vi.fn(async()=>({state:'returned',result:{audit_id:'esh_1'}})),resume=vi.fn();
  const card:Node=w.window.EchoPrimeAutonomy.reviewCard({review:{id:'ticket',digest:'hash',request:{arguments:{cmd:'exact command'}}}},{api,resume});
  expect(card.textContent).toContain('exact command');const run=walk(card).find(n=>n.tagName==='BUTTON')!;await run.click();await run.click();
  expect(api).toHaveBeenCalledOnce();expect(api).toHaveBeenCalledWith('execute',{id:'ticket',digest:'hash'});expect(resume).toHaveBeenCalledWith({state:'returned',result:{audit_id:'esh_1'}});
 });
 it('does not execute an old review card after account change',async()=>{
  const w=world(['autonomy.js']),api=vi.fn(),card:Node=w.window.EchoPrimeAutonomy.reviewCard({review:{id:'ticket',digest:'hash',request:{}}},{api});w.emit('echo-account-changed');await walk(card).find(n=>n.tagName==='BUTTON')!.click();expect(api).not.toHaveBeenCalled();
 });
});
