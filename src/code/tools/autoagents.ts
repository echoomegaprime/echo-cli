import {createHash} from 'node:crypto';
import {debuglog} from 'node:util';
import {ADK_CAPABILITY_ID,ADK_CREATE_NAME,ADK_DEFAULT_LANE,ADK_DEFINITION_LIMITS,AdkClient,AdkError,clampAdkBudget,type AdkAgentDefinition} from '../../prime/agents.js';
import {BOTS_LIMITS,BotsClient,BotsError} from '../../prime/bots.js';
import {object,unwrap,type Capability,type SdkBroker} from '../../prime/hub.js';
import {WorkspaceHttpError} from '../../prime/workspace.js';
import {redact} from '../workspace.js';
/**
 * Autonomous agent and bot creation (Commander order 2026-11-04: "Echo autonomously makes ADKs and echoBots for tasks from the
 * user's prompts"). When a chat prompt describes an ongoing, recurring, delegated or multi-step task, the model calls `make_agent`
 * and then `make_bot`; this module drafts the Echo ADK definition from the arguments, verifies every capability id against the live
 * catalog through the existing SDK broker (unknown ids are refused, never guessed), creates the agent through `echo-adk-api` with
 * `origin.by="echo"` and the prompt hash, creates the bot paused, and resumes it only when every capability is tier 0 or 1 and the
 * daily cap is within the configured default. Otherwise the bot stays paused and the card asks the owner to approve.
 * Owner-only: the host says who is asking (`ctx.owner`); members and visitors are refused before anything is requested. Prime never
 * crafts tokens or forwards credentials; the bot lease lists the agent's exact capability ids. There is no fallback of any kind.
 * Registration: the chat tool loop adds `...autoagentTools(service)` (or `hub.autoagentTools()`) to its tool list and includes
 * `AUTOAGENTS_PROMPT_FRAGMENT` in the system prompt; a `make_*` result is attached to the turn result under `autoagents` for the card.
 */
export const FLEET_ROLES=['commander','architect','observer','builder','publisher','enhancer','researcher'] as const;
export type FleetRole=typeof FLEET_ROLES[number];
export const AUTOAGENT_LIMITS={name:63,purpose:400,instruction:ADK_DEFINITION_LIMITS.instruction,capabilities:ADK_DEFINITION_LIMITS.capabilities,skills:ADK_DEFINITION_LIMITS.skills,maxSteps:ADK_DEFINITION_LIMITS.maxSteps,defaultMaxSteps:12,autoResumeTier:1,leaseTtlS:3600,leaseMaxUses:100,searchResults:20} as const;
export const AUTOAGENTS_PROMPT_FRAGMENT=`Autonomous agents and bots (owner only). When the user asks for work that is ongoing, recurring, scheduled, delegated or multi-step (for example "every morning", "keep watching", "each time", "take over", "monitor", "report weekly") or explicitly asks for an agent or a bot, build it: call find_capabilities to see the live catalog, call make_agent (name, fleet role, purpose, exact capability ids, skills, instruction, max_steps, budget), then call make_bot for that agent (schedule, mode, instruction, daily_cost_cap_usd). Never use make_agent or make_bot for a one-shot question, a single answer or work you can finish in this turn. Use only capability ids returned by find_capabilities; never invent, guess or alter an id, and when a needed capability is not in the catalog say so instead of substituting one. Prefer the free local lane (qwen-local, cost 0) and the smallest budget that fits. Bots start paused; the make_bot result says whether Echo resumed it or whether the owner must approve it first. Always finish by summarising what you built: agent name, role, capabilities with their tiers, schedule, budget, and whether the bot is running or waiting for approval. If a tool refuses (unknown capability, not the owner, service off), tell the user plainly and do not retry with different ids.`;
const debug=debuglog('echo-prime');
/** Carries an HTTP-shaped status so a host that maps tool errors to responses keeps 403/404/503 apart from a plain 400. */
export class AutoagentError extends WorkspaceHttpError {constructor(status:number,message:string,public code:string){super(status,message);}}
export interface ToolContext {
 /** Supplied by the host from its real admission (never from model text or the browser). Anything but `true` is refused. */
 owner:boolean;
 /** The user's prompt for this turn: hashed (normalised) into `origin.prompt_sha256` and used for idempotency. */
 prompt:string;
 signal?:AbortSignal;
 sessionId?:string;
}
/** The shape every chat tool in this module takes, so the tool loop registers them with one spread. */
export interface ChatTool {name:string;description:string;inputSchema:Record<string,unknown>;ownerOnly:true;run(args:unknown,ctx:ToolContext):Promise<unknown>}
export interface ResolvedCapability {id:string;tier:number|null;scope?:string;description?:string}
/** Live catalog access through the existing SDK broker. `resolve` must return the exact id or nothing; it never substitutes a neighbour. */
export interface CapabilityLookup {resolve(id:string,signal?:AbortSignal):Promise<ResolvedCapability|undefined>;search(query:string,signal?:AbortSignal):Promise<Capability[]>}
export interface AutoAgentsOptions {adk?:AdkClient;bots?:BotsClient;caps?:CapabilityLookup;events?:(event:Record<string,unknown>)=>void;now?:()=>Date}
export interface BuiltCapability {id:string;tier:number|null;scope?:string}
export interface BuiltAgent {name:string;role:string;purpose:string;capabilities:BuiltCapability[];skills:string[];lane:{node:string;model:string;budget:{max_calls:number;max_cost_usd:number;max_wall_s:number}};maxSteps:number;instruction?:string;schedule:{every_s:number}|null;origin:{by:'echo'|'owner';prompt_sha256?:string;created_at?:string};existing:boolean}
export interface BuiltBot {botId:string;name:string;agent:string;mode:string;status:string;schedule:{every_s:number}|null;dailyCostCapUsd:number;existing:boolean;autoResumed:boolean;approval:{required:boolean;reasons:string[]}}
/** What a `make_*` call returns: the tool loop attaches it to the turn result under `autoagents` and the chat card renders it. */
export interface AutoagentBuilt {kind:'autoagent';tool:'make_agent'|'make_bot';promptSha256:string;agent:BuiltAgent;bot?:BuiltBot;summary:string}
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
const str=(v:unknown,max:number):string=>typeof v==='string'?redact(v).slice(0,max):'';
/** Normalises the prompt (trim, collapse whitespace, case kept) so re-asking the same thing hashes the same. */
export function promptSha256(prompt:string):string{return createHash('sha256').update(prompt.replace(/\s+/g,' ').trim()).digest('hex');}
/** Turns the model's suggested name into the contract slug (`^[a-z0-9][a-z0-9-]{1,62}$`), or undefined when nothing usable remains. */
export function slugName(value:unknown):string|undefined{
 if(typeof value!=='string')return undefined;
 const slug=value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-').slice(0,AUTOAGENT_LIMITS.name);
 return ADK_CREATE_NAME.test(slug)?slug:undefined;
}
/** Builds the lookup over the authenticated SDK broker. Tier comes from the cap detail (`sdk.read`), never from the search row, whose
 *  missing tier is coerced to 0 by the broker; a detail without a numeric tier resolves with `tier:null` (unknown, fail closed). */
export function brokerCapabilityLookup(sdk:SdkBroker):CapabilityLookup{
 const tierOf=(...sources:Record<string,unknown>[])=>{for(const s of sources)for(const key of ['tier','danger_tier'])if(num(s[key])!==null)return s[key] as number;return null;};
 return {
  async resolve(id){
   if(!ADK_CAPABILITY_ID.test(id))return undefined;
   let record:Record<string,unknown>;
   try{record=object(unwrap(await sdk.read(id)));}catch{return undefined;}
   const c=object(record.capability);
   if(c.id!==id)return undefined;
   if(record.registration_state!=='registered'||['red','orphaned','unregistered'].includes(String(record.health_status)))return undefined;
   const tier=tierOf(c,object(c.metadata),record,object(record.metadata));
   return {id,tier,...(typeof c.required_scope==='string'?{scope:c.required_scope.slice(0,80)}:{}),...(typeof c.description==='string'?{description:redact(c.description).slice(0,300)}:{})};
  },
  async search(query){
   const rows=await sdk.search(query);
   return Array.isArray(rows)?rows.filter(r=>typeof r.id==='string'&&ADK_CAPABILITY_ID.test(r.id)).slice(0,AUTOAGENT_LIMITS.searchResults):[];
  },
 };
}
function schedule(value:unknown,what:string):{every_s:number}|null{
 if(value===undefined||value===null)return null;
 if(typeof value==='number'){// minutes, the way a model naturally says "every 15"
  if(!Number.isFinite(value)||value<1)throw new AutoagentError(400,'Invalid '+what+': minutes must be at least 1','invalid');
  return {every_s:Math.floor(value)*60};
 }
 const s=object(value);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(s).some(k=>k!=='every_s'))throw new AutoagentError(400,'Invalid '+what+': use {every_s} or null','invalid');
 if(typeof s.every_s!=='number'||!Number.isSafeInteger(s.every_s)||s.every_s<BOTS_LIMITS.everyS)throw new AutoagentError(400,'Invalid '+what+': every_s must be an integer of at least '+BOTS_LIMITS.everyS,'invalid');
 return {every_s:s.every_s};
}
export class AutoAgents {
 /** prompt hash → what this process built for it (and the schedule make_agent was given), so a re-ask in the same session never hits the service twice. */
 private built=new Map<string,{agent?:string;botId?:string;schedule?:{every_s:number}|null}>();
 constructor(private options:AutoAgentsOptions){}
 /** The three chat tools bound to this service, in registration shape (`tools.push(...service.tools())`). */
 tools():ChatTool[]{return autoagentTools(this);}
 /** Never throws: says whether the feature can work and why not. */
 status(){
  const missing:string[]=[];
  if(!this.options.adk)missing.push('adk');if(!this.options.bots)missing.push('bots');if(!this.options.caps)missing.push('sdk');
  return missing.length?{configured:false,reason:'Autonomous agents are off: the Prime config needs '+missing.join(', ')+' configured'}:{configured:true};
 }
 private emit(event:string,detail:Record<string,unknown>){const row={event:'prime_autoagent_'+event,...detail};debug('%j',row);this.options.events?.(row);}
 private require(ctx:ToolContext){
  if(!ctx||typeof ctx!=='object')throw new AutoagentError(400,'Tool context required','invalid');
  if(ctx.owner!==true){this.emit('refused',{reason:'owner_only'});throw new AutoagentError(403,'Only the owner can create agents and bots. Ask the primary owner to create this for you.','owner_only');}
  const s=this.status();
  if(!s.configured){this.emit('refused',{reason:'off'});throw new AutoagentError(503,s.reason!,'off');}
  if(typeof ctx.prompt!=='string'||!ctx.prompt.trim())throw new AutoagentError(400,'Tool context needs the user prompt','invalid');
  return {adk:this.options.adk!,bots:this.options.bots!,caps:this.options.caps!,hash:promptSha256(ctx.prompt)};
 }
 /** Every id must be an exact, registered catalog id. Unknown ids are listed in the refusal so the model can say so instead of guessing. */
 private async resolveAll(caps:CapabilityLookup,ids:string[],signal?:AbortSignal):Promise<BuiltCapability[]>{
  const out:BuiltCapability[]=[],unknown:string[]=[];
  for(const id of ids){
   const found=await caps.resolve(id,signal);
   if(!found||found.id!==id){unknown.push(id);continue;}
   out.push({id,tier:found.tier,...(found.scope?{scope:found.scope}:{})});
  }
  if(unknown.length){this.emit('refused',{reason:'unknown_capability',ids:unknown});throw new AutoagentError(400,'Unknown capability id'+(unknown.length>1?'s':'')+': '+unknown.join(', ')+'. Only ids present in the live catalog can be granted; nothing was created.','unknown_capability');}
  return out;
 }
 private gate(capabilities:BuiltCapability[],dailyCapUsd:number,defaultCapUsd:number){
  const reasons:string[]=[];
  for(const c of capabilities){
   if(c.tier===null)reasons.push(c.id+' has no reported tier (treated as not auto-approvable)');
   else if(c.tier>AUTOAGENT_LIMITS.autoResumeTier)reasons.push(c.id+' is tier '+c.tier+' (auto-resume allows tier 0 or 1)');
  }
  if(dailyCapUsd>defaultCapUsd)reasons.push('daily cost cap $'+dailyCapUsd.toFixed(2)+' exceeds the configured default of $'+defaultCapUsd.toFixed(2));
  return {required:reasons.length>0,reasons};
 }
 private fromAgent(record:Record<string,unknown>,capabilities:BuiltCapability[],purpose:string,schedule:{every_s:number}|null,existing:boolean):BuiltAgent{
  const lane=object(record.lane),budget=object(lane.budget),origin=object(record.origin);
  return {name:str(record.name,AUTOAGENT_LIMITS.name),role:str(record.role,80),purpose,capabilities,skills:Array.isArray(record.skills)?record.skills.filter((s):s is string=>typeof s==='string').slice(0,AUTOAGENT_LIMITS.skills):[],
   lane:{node:str(lane.node,80)||ADK_DEFAULT_LANE.node,model:str(lane.model,80)||ADK_DEFAULT_LANE.model,budget:{max_calls:num(budget.max_calls)??0,max_cost_usd:num(budget.max_cost_usd)??0,max_wall_s:num(budget.max_wall_s)??0}},
   maxSteps:num(record.max_steps)??AUTOAGENT_LIMITS.defaultMaxSteps,...(typeof record.instruction==='string'?{instruction:str(record.instruction,AUTOAGENT_LIMITS.instruction)}:{}),schedule,
   origin:{by:origin.by==='echo'?'echo':'owner',...(typeof origin.prompt_sha256==='string'?{prompt_sha256:origin.prompt_sha256.slice(0,64)}:{}),...(typeof origin.created_at==='string'?{created_at:origin.created_at.slice(0,40)}:{})},existing};
 }
 private async existingAgentFor(adk:AdkClient,hash:string,name:string|undefined,signal?:AbortSignal):Promise<Record<string,unknown>|undefined>{
  const remembered=this.built.get(hash)?.agent;
  const listed=(await adk.agents(signal)).agents.map(a=>object(a));
  return listed.find(a=>a.name===remembered)??listed.find(a=>object(a.origin).by==='echo'&&object(a.origin).prompt_sha256===hash)??(name!==undefined?listed.find(a=>a.name===name&&object(a.origin).prompt_sha256===hash):undefined);
 }
 /** `make_agent`: drafts and creates the Echo ADK definition for the prompt (or returns the one this prompt already produced). */
 async makeAgent(input:unknown,ctx:ToolContext):Promise<AutoagentBuilt>{
  const {adk,caps,hash}=this.require(ctx),args=object(input);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AutoagentError(400,'make_agent needs an object of arguments','invalid');
  for(const key of Object.keys(args))if(!['name','role','purpose','capabilities','skills','schedule','instruction','max_steps','budget'].includes(key))throw new AutoagentError(400,'make_agent: unknown argument '+redact(key).slice(0,40),'invalid');
  const name=slugName(args.name);
  if(!name)throw new AutoagentError(400,'make_agent: name must reduce to 2 to 63 lowercase letters, digits or hyphens','invalid');
  if(typeof args.role!=='string'||!(FLEET_ROLES as readonly string[]).includes(args.role))throw new AutoagentError(400,'make_agent: role must be one of '+FLEET_ROLES.join(', '),'invalid');
  if(typeof args.purpose!=='string'||!args.purpose.trim()||args.purpose.length>AUTOAGENT_LIMITS.purpose)throw new AutoagentError(400,'make_agent: purpose is required (up to '+AUTOAGENT_LIMITS.purpose+' characters)','invalid');
  if(!Array.isArray(args.capabilities)||!args.capabilities.length||args.capabilities.length>AUTOAGENT_LIMITS.capabilities||args.capabilities.some(c=>typeof c!=='string'||!ADK_CAPABILITY_ID.test(c)))throw new AutoagentError(400,'make_agent: capabilities must be 1 to '+AUTOAGENT_LIMITS.capabilities+' exact echo.* ids','invalid');
  const ids=[...new Set(args.capabilities as string[])],when=schedule(args.schedule,'make_agent schedule');
  if(args.schedule!==undefined)this.built.set(hash,{...this.built.get(hash),schedule:when});// make_bot for this prompt defaults to it
  const purpose=args.purpose.trim();
  let instruction='Purpose: '+purpose;
  if(args.instruction!==undefined){if(typeof args.instruction!=='string')throw new AutoagentError(400,'make_agent: instruction must be text','invalid');if(args.instruction.trim())instruction+='\n\n'+args.instruction.trim();}
  if(instruction.length>AUTOAGENT_LIMITS.instruction)throw new AutoagentError(400,'make_agent: instruction exceeds '+AUTOAGENT_LIMITS.instruction+' characters','invalid');
  const existing=await this.existingAgentFor(adk,hash,name,ctx.signal);
  if(existing){
   const capabilities=await this.resolveAll(caps,Array.isArray(existing.capabilities)?existing.capabilities.filter((c):c is string=>typeof c==='string'):ids,ctx.signal);
   this.built.set(hash,{...this.built.get(hash),agent:String(existing.name)});
   this.emit('agent_existing',{name:existing.name,promptSha256:hash});
   const agent=this.fromAgent(existing,capabilities,purpose,when,true);
   return {kind:'autoagent',tool:'make_agent',promptSha256:hash,agent,summary:'Agent '+agent.name+' already exists for this request (role '+agent.role+', '+capabilities.length+' capabilities); nothing new was created.'};
  }
  const capabilities=await this.resolveAll(caps,ids,ctx.signal);
  let budget;try{budget=clampAdkBudget(args.budget,adk.config.defaultBudget);}catch(e){throw new AutoagentError(400,'make_agent: '+(e instanceof Error?e.message:'invalid budget'),'invalid');}
  const maxSteps=args.max_steps===undefined?AUTOAGENT_LIMITS.defaultMaxSteps:num(args.max_steps);
  if(maxSteps===null)throw new AutoagentError(400,'make_agent: max_steps must be a number','invalid');
  const definition:AdkAgentDefinition={name,role:args.role,skills:Array.isArray(args.skills)?[...new Set(args.skills.filter((s):s is string=>typeof s==='string'))].slice(0,AUTOAGENT_LIMITS.skills):[],capabilities:ids,
   lane:{node:ADK_DEFAULT_LANE.node,model:ADK_DEFAULT_LANE.model,budget},max_steps:Math.min(AUTOAGENT_LIMITS.maxSteps,Math.max(1,Math.floor(maxSteps))),instruction,
   origin:{by:'echo',prompt_sha256:hash,created_at:(this.options.now?.()??new Date()).toISOString()}};
  let record:Record<string,unknown>;
  try{record=await adk.createAgent(definition,ctx.signal);}
  catch(error){
   if(error instanceof AdkError&&error.detail.http===409){
    // The name exists: it is "ours" only if its origin carries this prompt's hash; otherwise refuse rather than invent a variant.
    const taken=object(await adk.agent(name,ctx.signal).catch(()=>undefined));
    if(object(taken.origin).prompt_sha256===hash){this.built.set(hash,{...this.built.get(hash),agent:name});this.emit('agent_existing',{name,promptSha256:hash});const agent=this.fromAgent(taken,capabilities,purpose,when,true);return {kind:'autoagent',tool:'make_agent',promptSha256:hash,agent,summary:'Agent '+name+' already exists for this request; nothing new was created.'};}
    this.emit('refused',{reason:'name_taken',name});
    throw new AutoagentError(409,'An agent named '+name+' already exists and was not made from this request; choose another name.','name_taken');
   }
   throw error;
  }
  this.built.set(hash,{...this.built.get(hash),agent:name});
  this.emit('agent_created',{name,role:args.role,capabilities:ids.length,tiers:capabilities.map(c=>c.tier),promptSha256:hash});
  const agent=this.fromAgent(record,capabilities,purpose,when,false);
  return {kind:'autoagent',tool:'make_agent',promptSha256:hash,agent,summary:'Created agent '+agent.name+' (role '+agent.role+', lane '+agent.lane.model+' on '+agent.lane.node+', up to '+agent.maxSteps+' steps, budget '+agent.lane.budget.max_calls+' calls / $'+agent.lane.budget.max_cost_usd.toFixed(2)+') with capabilities '+capabilities.map(c=>c.id+' (tier '+(c.tier===null?'unknown':c.tier)+')').join(', ')+'.'};
 }
 /** `make_bot`: creates the always-on bot for an agent (paused by contract), then resumes it only when the gate allows. */
 async makeBot(input:unknown,ctx:ToolContext):Promise<AutoagentBuilt>{
  const {adk,bots,caps,hash}=this.require(ctx),args=object(input);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AutoagentError(400,'make_bot needs an object of arguments','invalid');
  for(const key of Object.keys(args))if(!['agent','name','mode','schedule','instruction','daily_cost_cap_usd'].includes(key))throw new AutoagentError(400,'make_bot: unknown argument '+redact(key).slice(0,40),'invalid');
  const agentName=typeof args.agent==='string'?args.agent:this.built.get(hash)?.agent;
  if(typeof agentName!=='string'||!ADK_CREATE_NAME.test(agentName))throw new AutoagentError(400,'make_bot: agent must name an agent created with make_agent','invalid');
  const name=typeof args.name==='string'&&args.name.trim()?args.name.trim():agentName;
  if(name.length>BOTS_LIMITS.name)throw new AutoagentError(400,'make_bot: name exceeds '+BOTS_LIMITS.name+' characters','invalid');
  const mode=args.mode===undefined?'personal':args.mode;
  if(mode!=='personal'&&mode!=='team')throw new AutoagentError(400,'make_bot: mode must be personal or team','invalid');
  const remembered=this.built.get(hash);
  const when=args.schedule===undefined&&remembered?.schedule!==undefined?remembered.schedule:schedule(args.schedule,'make_bot schedule');
  const defaultCap=bots.config.defaultBudget.max_cost_usd;
  const cap=args.daily_cost_cap_usd===undefined?defaultCap:args.daily_cost_cap_usd;
  if(typeof cap!=='number'||!Number.isFinite(cap)||cap<0||cap>BOTS_LIMITS.dailyCapUsd)throw new AutoagentError(400,'make_bot: daily_cost_cap_usd must be between 0 and '+BOTS_LIMITS.dailyCapUsd,'invalid');
  if(args.instruction!==undefined&&(typeof args.instruction!=='string'||args.instruction.length>BOTS_LIMITS.text))throw new AutoagentError(400,'make_bot: instruction must be text of at most '+BOTS_LIMITS.text+' characters','invalid');
  let record:Record<string,unknown>;
  try{record=await adk.agent(agentName,ctx.signal);}
  catch(error){if(error instanceof AdkError&&error.status===404){this.emit('refused',{reason:'agent_not_found',name:agentName});throw new AutoagentError(404,'make_bot: Echo ADK has no agent named '+agentName+'; create it with make_agent first.','agent_not_found');}throw error;}
  const ids=Array.isArray(record.capabilities)?record.capabilities.filter((c):c is string=>typeof c==='string'&&ADK_CAPABILITY_ID.test(c)):[];
  if(!ids.length)throw new AutoagentError(400,'make_bot: agent '+agentName+' lists no capabilities, so no lease can be drafted','invalid');
  const capabilities=await this.resolveAll(caps,ids,ctx.signal);
  const purpose=typeof record.instruction==='string'?(/^Purpose:\s*(.+)$/m.exec(record.instruction)?.[1]??'').slice(0,AUTOAGENT_LIMITS.purpose):'';
  const agent=this.fromAgent(record,capabilities,purpose,when,true);
  const rememberedBot=this.built.get(hash)?.botId;
  const listed=(await bots.list(ctx.signal)).bots.map(b=>object(b));
  let bot=listed.find(b=>b.bot_id===rememberedBot)??listed.find(b=>b.agent===agentName);
  let existing=true,autoResumed=false;
  const approval=this.gate(capabilities,Math.round(cap*100)/100,defaultCap);
  if(!bot){
   existing=false;
   const body:Record<string,unknown>={name,agent:agentName,mode,schedule:when,daily_cost_cap_usd:Math.round(cap*100)/100,lease:{scopes:ids,ttl_s:AUTOAGENT_LIMITS.leaseTtlS,max_uses:AUTOAGENT_LIMITS.leaseMaxUses}};
   if(typeof args.instruction==='string'&&args.instruction.trim())body.instruction=args.instruction;
   bot=await bots.create(body,ctx.signal);
   this.emit('bot_created',{botId:bot.bot_id,agent:agentName,scheduled:!!when,dailyCapUsd:body.daily_cost_cap_usd,status:bot.status});
   if(!approval.required){
    try{bot=await bots.resume(String(bot.bot_id),ctx.signal);autoResumed=true;this.emit('bot_resumed',{botId:bot.bot_id,status:bot.status});}
    catch(error){approval.required=true;approval.reasons.push('resume was refused: '+(error instanceof BotsError?redact(error.message).slice(0,200):'request failed')+' (the bot stays paused)');this.emit('bot_paused_for_approval',{botId:bot.bot_id,reasons:approval.reasons});}
   }else this.emit('bot_paused_for_approval',{botId:bot.bot_id,reasons:approval.reasons});
  }else this.emit('bot_existing',{botId:bot.bot_id,agent:agentName});
  this.built.set(hash,{...this.built.get(hash),agent:agentName,botId:String(bot.bot_id)});
  const sched=object(bot.schedule);
  const built:BuiltBot={botId:String(bot.bot_id),name:str(bot.name,BOTS_LIMITS.name)||name,agent:agentName,mode:str(bot.mode,20)||mode,status:str(bot.status,20)||'unknown',schedule:num(sched.every_s)!==null?{every_s:sched.every_s as number}:null,dailyCostCapUsd:num(bot.daily_cost_cap_usd)??Math.round(cap*100)/100,existing,autoResumed,approval:existing?{required:false,reasons:[]}:approval};
  const cadence=built.schedule?'every '+(built.schedule.every_s%60===0?built.schedule.every_s/60+' min':built.schedule.every_s+' s'):'on message only';
  const summary=existing?'Bot '+built.name+' already exists for agent '+agentName+' (status '+built.status+'); nothing new was created.'
   :'Created bot '+built.name+' for agent '+agentName+' ('+built.mode+', '+cadence+', daily cap $'+built.dailyCostCapUsd.toFixed(2)+'). '+(autoResumed?'Every capability is tier 0 or 1 and the cap is within the default, so Echo resumed it: status '+built.status+'.':'It stays paused until the owner approves: '+approval.reasons.join('; ')+'.');
  return {kind:'autoagent',tool:'make_bot',promptSha256:hash,agent,bot:built,summary};
 }
 /** `find_capabilities`: the live catalog rows for a query (ids, tiers as the catalog reports them, descriptions). Read-only. */
 async findCapabilities(input:unknown,ctx:ToolContext){
  const {caps}=this.require(ctx),args=object(input);
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>150)throw new AutoagentError(400,'find_capabilities: query is required (up to 150 characters)','invalid');
  let rows:Capability[];
  try{rows=await caps.search(args.query.trim(),ctx.signal);}catch(error){throw new AutoagentError(502,'find_capabilities: catalog search failed: '+(error instanceof Error?redact(error.message).slice(0,200):'request failed'),'catalog_unavailable');}
  return {query:args.query.trim(),capabilities:rows.slice(0,AUTOAGENT_LIMITS.searchResults).map(r=>({id:r.id,tier:num(r.tier),scope:str(r.scope,80)||undefined,registered:r.registered===true,health:str(r.health,20),description:str(r.description,300)})),note:'Use these ids exactly as listed; make_agent refuses ids that are not in the catalog.'};
 }
}
const budgetSchema={type:'object',additionalProperties:false,properties:{max_calls:{type:'integer',minimum:1,maximum:120},max_cost_usd:{type:'number',minimum:0,maximum:5},max_wall_s:{type:'integer',minimum:30,maximum:4800}}};
const scheduleSchema={description:'null for on-message only, {every_s} (>= 60) or a whole number of minutes',anyOf:[{type:'null'},{type:'integer',minimum:1},{type:'object',additionalProperties:false,required:['every_s'],properties:{every_s:{type:'integer',minimum:60}}}]};
/** The chat tools in registration shape: `tools.push(...autoagentTools(service))`. All three are owner-only. */
export function autoagentTools(service:AutoAgents):ChatTool[]{
 return [
  {name:'find_capabilities',ownerOnly:true,description:'Search the live Echo capability catalog (read-only) for exact echo.* ids, their tiers and descriptions. Call this before make_agent so every capability id is real.',
   inputSchema:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string',maxLength:150}}},run:(args,ctx)=>service.findCapabilities(args,ctx)},
  {name:'make_agent',ownerOnly:true,description:'Create an Echo ADK agent definition for an ongoing, recurring, delegated or multi-step task the user described (owner only; never for one-shot questions). Capability ids must come from find_capabilities. Idempotent per prompt.',
   inputSchema:{type:'object',additionalProperties:false,required:['name','role','purpose','capabilities'],properties:{name:{type:'string',maxLength:63},role:{type:'string',enum:[...FLEET_ROLES]},purpose:{type:'string',maxLength:AUTOAGENT_LIMITS.purpose},capabilities:{type:'array',minItems:1,maxItems:AUTOAGENT_LIMITS.capabilities,items:{type:'string',pattern:ADK_CAPABILITY_ID.source}},skills:{type:'array',maxItems:AUTOAGENT_LIMITS.skills,items:{type:'string'}},schedule:scheduleSchema,instruction:{type:'string',maxLength:AUTOAGENT_LIMITS.instruction},max_steps:{type:'integer',minimum:1,maximum:AUTOAGENT_LIMITS.maxSteps},budget:budgetSchema}},
   run:(args,ctx)=>service.makeAgent(args,ctx)},
  {name:'make_bot',ownerOnly:true,description:'Create the always-on echoBot for an agent made with make_agent. The bot starts paused; it is resumed automatically only when every capability is tier 0 or 1 and the daily cap is within the configured default, otherwise the owner approves it from the card.',
   inputSchema:{type:'object',additionalProperties:false,properties:{agent:{type:'string',pattern:ADK_CREATE_NAME.source},name:{type:'string',maxLength:BOTS_LIMITS.name},mode:{type:'string',enum:['personal','team']},schedule:scheduleSchema,instruction:{type:'string',maxLength:BOTS_LIMITS.text},daily_cost_cap_usd:{type:'number',minimum:0,maximum:BOTS_LIMITS.dailyCapUsd}}},
   run:(args,ctx)=>service.makeBot(args,ctx)},
 ];
}
