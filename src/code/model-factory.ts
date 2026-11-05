import { tmpdir } from 'node:os';
import { debuglog } from 'node:util';
import { LocalModel, validateEndpoint, type Model } from './model.js';
import { CliModel, PROVIDER_BIN, PROVIDER_LABEL, childEnv, run, type ProviderId, type Runner } from './providers.js';
import { TASK_CLASSES, classifyTask, type TaskClass } from './task-classifier.js';

/**
 * The one place a Model is built from a provider id.
 * qwen = LocalModel on a loopback Ollama endpoint (an SSH tunnel to FORGE in the default config).
 * claude / gpt / grok / argon = CliModel, each vendor's own CLI as a subprocess; Prime never touches a token.
 * There is no fallback: an id that is unknown, or a provider that fails, fails the turn and says so.
 */
export type ModelId = 'qwen' | ProviderId;
export const MODEL_IDS: readonly ModelId[] = ['qwen', 'claude', 'gpt', 'grok', 'argon'];
const CLI_IDS: readonly ProviderId[] = ['claude', 'gpt', 'grok', 'argon'];
export const isModelId = (value: unknown): value is ModelId => typeof value === 'string' && (MODEL_IDS as readonly string[]).includes(value);

/**
 * Auto model mode ("Auto (Echo decides)", Commander directive 2026-11-04). Opt-in `models.auto` section:
 *   enabled     - offer the picker entry and accept provider "auto" (default true when the section is present)
 *   classifier  - "rules" or "rules+qwen" (one short Qwen call when the rules are not confident)
 *   research    - which vendor answers web-research turns, grok or gpt
 *   declineTo   - "qwen" re-runs a turn a vendor declined on Qwen (labelled); "none" leaves it a failed turn
 * `declineTo` applies even when auto mode itself is off: a decline is re-routed in any vendor-pinned conversation.
 */
export interface AutoConfig { enabled: boolean; classifier: 'rules' | 'rules+qwen'; research: 'grok' | 'gpt'; declineTo: 'qwen' | 'none' }
export const DEFAULT_AUTO: AutoConfig = { enabled: true, classifier: 'rules+qwen', research: 'grok', declineTo: 'qwen' };
export interface ModelsConfig {
  default: ModelId; endpoint: string; model: string; contextTokens: number;
  cli: Partial<Record<ProviderId, { model?: string }>>;
  /** Absent = auto mode off; declines still re-route to Qwen (DEFAULT_AUTO.declineTo). */
  auto?: AutoConfig;
}
/** Reviewed defaults. The endpoint is the already-running loopback tunnel; nothing here is a credential. */
export const DEFAULT_MODELS: ModelsConfig = {
  default: 'qwen', endpoint: 'http://127.0.0.1:11450', model: 'c3po-code:echo-qwen38-abliterated-256k', contextTokens: 262144, cli: {},
};
/** The id the browser sends to let Echo decide; not a ModelId, accepted only when the router's auto mode is enabled. */
export const AUTO_ID = 'auto';
export const isChatProvider = (value: unknown): value is ModelId | 'auto' => value === AUTO_ID || isModelId(value);
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
function plain(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid models configuration: ${what} must be an object`);
  return value as Record<string, unknown>;
}
function only(object: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Invalid models configuration: unknown ${what} field`);
}
/** Strict: unknown fields, non-loopback endpoints, cloud model names and anything credential-shaped are refused. */
export function parseModelsConfig(value: unknown): ModelsConfig {
  if (value === undefined) return { ...DEFAULT_MODELS, cli: {} };
  const input = plain(value, 'models');
  only(input, ['default', 'endpoint', 'model', 'contextTokens', 'cli', 'auto'], 'models');
  const config: ModelsConfig = { ...DEFAULT_MODELS, cli: {} };
  if (input.auto !== undefined) {
    const auto = plain(input.auto, 'auto');
    only(auto, ['enabled', 'classifier', 'research', 'declineTo'], 'auto');
    const parsed: AutoConfig = { ...DEFAULT_AUTO };
    if (auto.enabled !== undefined) { if (typeof auto.enabled !== 'boolean') throw new Error('Invalid models configuration: auto.enabled'); parsed.enabled = auto.enabled; }
    if (auto.classifier !== undefined) { if (auto.classifier !== 'rules' && auto.classifier !== 'rules+qwen') throw new Error('Invalid models configuration: auto.classifier must be rules or rules+qwen'); parsed.classifier = auto.classifier; }
    if (auto.research !== undefined) { if (auto.research !== 'grok' && auto.research !== 'gpt') throw new Error('Invalid models configuration: auto.research must be grok or gpt'); parsed.research = auto.research; }
    if (auto.declineTo !== undefined) { if (auto.declineTo !== 'qwen' && auto.declineTo !== 'none') throw new Error('Invalid models configuration: auto.declineTo must be qwen or none'); parsed.declineTo = auto.declineTo; }
    config.auto = parsed;
  }
  if (input.default !== undefined) { if (!isModelId(input.default)) throw new Error('Invalid models configuration: default must be qwen, claude, gpt, grok or argon'); config.default = input.default; }
  if (input.endpoint !== undefined) { if (typeof input.endpoint !== 'string') throw new Error('Invalid models configuration: endpoint'); config.endpoint = input.endpoint; }
  if (input.model !== undefined) { if (typeof input.model !== 'string') throw new Error('Invalid models configuration: model'); config.model = input.model; }
  if (input.contextTokens !== undefined) {
    if (typeof input.contextTokens !== 'number' || !Number.isInteger(input.contextTokens) || input.contextTokens < 1024 || input.contextTokens > 1048576) throw new Error('Invalid models configuration: contextTokens');
    config.contextTokens = input.contextTokens;
  }
  validateEndpoint(config.endpoint);
  new LocalModel(config.endpoint, config.model, 1000, config.contextTokens); // reuses the cloud/invalid-name rules
  if (input.cli !== undefined) {
    const cli = plain(input.cli, 'cli');
    only(cli, [...CLI_IDS], 'cli provider');
    for (const id of CLI_IDS) {
      if (cli[id] === undefined) continue;
      const entry = plain(cli[id], `cli.${id}`);
      only(entry, ['model'], `cli.${id}`);
      if (entry.model === undefined) { config.cli[id] = {}; continue; }
      if (typeof entry.model !== 'string' || !CLI_MODEL.test(entry.model)) throw new Error(`Invalid models configuration: cli.${id}.model`);
      config.cli[id] = { model: entry.model };
    }
  }
  return config;
}

export interface BuildOptions { runner?: Runner }
export function buildModel(id: ModelId, config: ModelsConfig, options: BuildOptions = {}): Model {
  if (!isModelId(id)) throw new Error('Unknown model provider');
  if (id === 'qwen') return new LocalModel(config.endpoint, config.model, 120000, config.contextTokens);
  return new CliModel(id, { model: config.cli[id]?.model, runner: options.runner });
}
/** Stored on the session; a session is pinned to the model that started it. */
export function sessionModelName(id: ModelId, config: ModelsConfig): string {
  if (id === 'qwen') return config.model;
  const requested = config.cli[id]?.model;
  return requested ? `${id}:${requested}` : id;
}
export const modelLabel = (id: ModelId, config: ModelsConfig): string =>
  id === 'qwen' ? `Qwen (FORGE, ${Math.round(config.contextTokens / 1024)}K)` : PROVIDER_LABEL[id];

/** A model id agy offers for Argon. Only ids starting with gemini- are ever exposed; agy also lists claude-* and gpt-oss ids that belong to other providers. */
export interface Variant { id: string; label: string }
const VARIANT_ID = /^gemini-[a-z0-9.-]+$/;
/** Shape a caller-supplied variant id must have before it is even compared with the discovered list. */
export const VARIANT_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_VARIANTS = 32;
const debug = debuglog('echo-prime');
/** Parses `agy models` ("<id>\t<label>" per line, progress noise ignored). Never returns raw output: ids are matched strictly and labels are stripped of control characters. */
export function parseAgyModels(stdout: string): Variant[] {
  const out: Variant[] = [], seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t'), id = (tab < 0 ? line : line.slice(0, tab)).trim();
    if (id.length > 100 || !VARIANT_ID.test(id) || seen.has(id)) continue;
    // eslint-disable-next-line no-control-regex
    const label = (tab < 0 ? '' : line.slice(tab + 1)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || id;
    seen.add(id); out.push({ id, label });
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

/** Why auto mode picked a provider for one turn. `considered` lists every provider in the task's chain with its probe result; nothing is invented. */
export interface RouteInfo { task: TaskClass; reason: string; classifier: 'rules' | 'qwen'; confidence: number; considered: { id: ModelId; available: boolean; reason?: string }[] }
export interface AnswerInfo {
  id: ModelId; label: string; requested: string | null; model: string | null; reported: boolean; answered: boolean; at?: string;
  /** Set when a vendor declined and the same turn was re-run on Qwen (the reply is labelled "<vendor> declined; answered by Qwen"). */
  declinedBy?: ModelId; declinedLabel?: string;
  /** Set when auto mode chose this provider for the turn ("routed to Claude (coding)"). */
  routed?: RouteInfo;
}
export interface ProviderStatus {
  id: ModelId; label: string; kind: 'local' | 'cli'; available: boolean; reason?: string;
  check: 'model-listed' | 'installed' | 'signed-in'; checkedAt: string; requested: string | null;
  /** Argon only: the Gemini ids agy offers right now (empty with a reason when listing failed; never invented). */
  variants?: Variant[]; variantsReason?: string;
  endpoint?: string; contextTokens?: number; last: AnswerInfo | null;
}
export interface ModelsReport { default: ModelId; contextTokens: number; providers: ProviderStatus[]; auto: AutoConfig & { chains: Record<TaskClass, ModelId[]> } }
export interface RouterOptions { runner?: Runner; now?: () => number; probeTimeoutMs?: number }
export interface RouteOptions { signal?: AbortSignal; /** Characters of conversation history already in the session (argon has an argv cap). */ historyChars?: number }
export interface Route { id: ModelId; info: RouteInfo }
/** Argon (agy) takes the prompt on its command line: render() of the whole history must fit under 28000 characters (providers.ts). Leave headroom for the system text. */
const ARGON_PROMPT_BUDGET = 24000;
/** Preference chains per task class. General/personal turns never leave the local model: when Qwen is down they fail plainly instead of going to a vendor. */
export function routingChains(auto: AutoConfig): Record<TaskClass, ModelId[]> {
  const other: ModelId = auto.research === 'grok' ? 'gpt' : 'grok';
  return { coding: ['claude', 'gpt', 'qwen'], long_context: ['argon', 'claude', 'qwen'], research: [auto.research, other, 'qwen'], general: ['qwen'] };
}
interface Probe { available: boolean; reason?: string; check: ProviderStatus['check']; checkedAt: string; variants?: Variant[]; variantsReason?: string }
const withVariant = (config: ModelsConfig, id: ProviderId, variant: string): ModelsConfig => ({ ...config, cli: { ...config.cli, [id]: { model: variant } } });
const CACHE_MS = 60000;

export class ModelRouter {
  private instances = new Map<string, Model>();
  private history = new Map<ModelId, AnswerInfo>();
  private probes = new Map<ModelId, { at: number; probe: Promise<Probe> }>();
  private runner: Runner; private now: () => number; private probeTimeoutMs: number;
  constructor(readonly config: ModelsConfig = DEFAULT_MODELS, options: RouterOptions = {}) {
    this.runner = options.runner ?? run; this.now = options.now ?? Date.now; this.probeTimeoutMs = options.probeTimeoutMs ?? 8000;
  }
  get defaultId(): ModelId { return this.config.default; }
  /** Effective auto settings: the parsed section, or auto off with declines still re-routed to Qwen. */
  get auto(): AutoConfig { return this.config.auto ?? { ...DEFAULT_AUTO, enabled: false }; }
  /** Current probe result for one provider (cached 60 s like the report). */
  async available(id: ModelId): Promise<{ available: boolean; reason?: string }> {
    if (!isModelId(id)) throw new Error('Unknown model provider');
    const probe = await this.probe(id);
    return probe.available ? { available: true } : { available: false, reason: probe.reason };
  }
  /**
   * Auto mode: classify the turn (rules, then one short Qwen call when the rules are unsure and Qwen is up),
   * then pick the first provider in the class's chain whose probe says it is available. The choice is made
   * before any call; a provider that then fails still fails the turn (no fallback for outages).
   */
  async route(prompt: string, options: RouteOptions = {}): Promise<Route> {
    if (!this.auto.enabled) throw new Error('Auto model mode is not enabled in the reviewed models configuration');
    const rules = classifyTask(prompt);
    let task = rules.task, classifier: RouteInfo['classifier'] = 'rules', confidence = rules.confidence;
    let reason = rules.reasons.length ? `${task} (rules: ${rules.reasons.map(r => r.split(': ')[1]).join(', ')})` : `${task} (rules: no strong cue, default)`;
    if (this.auto.classifier === 'rules+qwen' && rules.confidence < 0.6 && (await this.probe('qwen')).available) {
      try {
        const label = await new LocalModel(this.config.endpoint, this.config.model, 8000, Math.min(this.config.contextTokens, 8192)).classify(prompt, TASK_CLASSES, options.signal);
        if ((TASK_CLASSES as readonly string[]).includes(label)) { task = label as TaskClass; classifier = 'qwen'; confidence = 0.75; reason = `${task} (qwen classifier; rules said ${rules.task} at ${rules.confidence})`; }
      } catch (error) { debug('%j', { event: 'prime_auto_classifier_failed', reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown' }); }
    }
    const considered: RouteInfo['considered'] = [];
    const promptChars = (options.historyChars ?? 0) + prompt.length;
    for (const id of routingChains(this.auto)[task]) {
      if (id === 'argon' && promptChars > ARGON_PROMPT_BUDGET) { considered.push({ id, available: false, reason: `the conversation (${promptChars} characters) exceeds agy's command-line prompt cap` }); continue; }
      const probe = await this.probe(id);
      considered.push({ id, available: probe.available, ...(probe.reason ? { reason: probe.reason } : {}) });
      if (probe.available) {
        const info: RouteInfo = { task, reason, classifier, confidence, considered };
        debug('%j', { event: 'prime_model_routed', task, provider: id, classifier, confidence, skipped: considered.filter(c => !c.available).map(c => c.id) });
        return { id, info };
      }
    }
    throw new Error(`Auto routing found no available provider for a ${task} turn: ${considered.map(c => `${c.id} (${c.reason ?? 'unavailable'})`).join('; ')}; no other provider was used`);
  }
  /** A conversation is pinned to this name; a chosen Argon variant becomes part of it (argon:<id>). */
  sessionModel(id: ModelId, variant?: string): string {
    if (!isModelId(id)) throw new Error('Unknown model provider');
    return sessionModelName(id, variant === undefined || id === 'qwen' ? this.config : withVariant(this.config, id, variant));
  }
  private requested(id: ModelId, variant?: string): string | null { return variant ?? (id === 'qwen' ? this.config.model : this.config.cli[id]?.model ?? null); }
  private instance(id: ModelId, variant?: string): Model {
    const key = variant === undefined ? id : `${id}:${variant}`;
    let model = this.instances.get(key);
    if (!model) { model = buildModel(id, variant === undefined || id === 'qwen' ? this.config : withVariant(this.config, id, variant), { runner: this.runner }); this.instances.set(key, model); }
    return model;
  }
  /** Checks a requested Argon model against what agy lists right now. Unknown or unverifiable ids are refused; the default is never substituted. */
  async variant(id: ModelId, model: string): Promise<string> {
    if (id !== 'argon') throw new Error('A model variant is only for Argon (Gemini); other providers use their configured model');
    if (typeof model !== 'string' || !VARIANT_ARG.test(model)) { debug('%j', { event: 'prime_argon_variant_rejected', reason: 'invalid' }); throw new Error('Invalid Argon model id'); }
    const probe = await this.probe('argon'), listed = probe.variants ?? [];
    if (listed.some(v => v.id === model)) return model;
    if (!listed.length) {
      debug('%j', { event: 'prime_argon_variant_rejected', reason: 'unverifiable' });
      throw new Error(`Argon model "${model}" cannot be verified: ${probe.variantsReason ?? 'agy listed no Gemini models'}; no default model was used`);
    }
    debug('%j', { event: 'prime_argon_variant_rejected', reason: 'unknown' });
    throw new Error(`Unknown Argon model "${model}"; agy lists: ${listed.map(v => v.id).join(', ')}`);
  }
  /** One turn on exactly the named provider. `info()` is what answered this turn; a failed turn never inherits an older answer. */
  turn(id: ModelId, variant?: string): { model: Model; answered(): AnswerInfo | null; info(): AnswerInfo } {
    if (!isModelId(id)) throw new Error('Unknown model provider');
    if (variant !== undefined && id !== 'argon') throw new Error('A model variant is only for Argon (Gemini); other providers use their configured model');
    const model = this.instance(id, variant) as Model & { last?: unknown };
    model.last = undefined;
    const label = modelLabel(id, this.config), requested = this.requested(id, variant);
    const read = (): AnswerInfo | null => {
      const last = model.last as { requested?: string | null; model: string | null; reported: boolean } | undefined;
      return last ? { id, label, requested: last.requested ?? requested, model: last.model, reported: last.reported, answered: true } : null;
    };
    return {
      model: model as Model,
      answered: () => { const a = read(); if (a) this.history.set(id, { ...a, at: new Date(this.now()).toISOString() }); return a; },
      info: () => read() ?? { id, label, requested, model: null, reported: false, answered: false },
    };
  }
  private probe(id: ModelId): Promise<Probe> {
    const cached = this.probes.get(id), now = this.now();
    if (cached && now - cached.at < CACHE_MS) return cached.probe;
    const probe = id === 'qwen' ? this.probeLocal() : id === 'argon' ? this.probeArgon() : this.probeCli(id);
    this.probes.set(id, { at: now, probe });
    return probe;
  }
  private stamp(): string { return new Date(this.now()).toISOString(); }
  private async probeLocal(): Promise<Probe> {
    const base = { check: 'model-listed' as const, checkedAt: this.stamp() };
    try {
      const names = await new LocalModel(this.config.endpoint, this.config.model, 5000, this.config.contextTokens).models();
      return names.includes(this.config.model) ? { ...base, available: true }
        : { ...base, available: false, reason: `model "${this.config.model}" is not installed on the local endpoint` };
    } catch { return { ...base, available: false, reason: 'local model endpoint is unreachable or returned an invalid response' }; }
  }
  // Status commands only. Output is never returned: it can carry account details.
  // Argon also lists the Gemini ids agy offers: same Runner and minimal env; the listing is parsed, never returned raw.
  private async probeArgon(): Promise<Probe> {
    const bin = PROVIDER_BIN.argon, probe = await this.probeCli('argon');
    if (!probe.available) return { ...probe, variants: [], variantsReason: `"${bin}" is not available` };
    let result: Pick<Probe, 'variants' | 'variantsReason'>;
    try {
      const r = await this.runner(bin, ['models'], { cwd: tmpdir(), env: childEnv(), timeoutMs: this.probeTimeoutMs, maxBytes: 64000 });
      const variants = r.timedOut || r.code ? [] : parseAgyModels(r.stdout);
      result = r.timedOut ? { variants, variantsReason: `"${bin} models" timed out or returned too much output` }
        : r.code ? { variants, variantsReason: `"${bin} models" exited with code ${r.code}` }
        : variants.length ? { variants } : { variants, variantsReason: `"${bin} models" listed no Gemini models` };
    } catch (error) {
      result = { variants: [], variantsReason: (error as { spawnFailed?: boolean }).spawnFailed ? `could not start "${bin}"` : `could not run "${bin} models"` };
    }
    debug('%j', { event: 'prime_argon_variants', count: result.variants!.length, reason: result.variantsReason });
    return { ...probe, ...result };
  }
  private async probeCli(id: ProviderId): Promise<Probe> {
    const bin = PROVIDER_BIN[id], signedIn = id === 'gpt';
    const base = { check: (signedIn ? 'signed-in' : 'installed') as ProviderStatus['check'], checkedAt: this.stamp() };
    try {
      const result = await this.runner(bin, signedIn ? ['login', 'status'] : ['--version'], { cwd: tmpdir(), env: childEnv(), timeoutMs: this.probeTimeoutMs, maxBytes: 20000 });
      if (result.timedOut) return { ...base, available: false, reason: `"${bin}" timed out` };
      if (result.code) return { ...base, available: false, reason: signedIn ? `not signed in ("${bin} login status" exited with code ${result.code})` : `"${bin}" exited with code ${result.code}` };
      return { ...base, available: true };
    } catch (error) {
      return { ...base, available: false, reason: (error as { spawnFailed?: boolean }).spawnFailed ? `could not start "${bin}" (not installed or not on PATH)` : `could not run "${bin}"` };
    }
  }
  async report(): Promise<ModelsReport> {
    const probes = await Promise.all(MODEL_IDS.map(id => this.probe(id)));
    return {
      default: this.config.default, contextTokens: this.config.contextTokens, auto: { ...this.auto, chains: routingChains(this.auto) },
      providers: MODEL_IDS.map((id, i) => ({
        id, label: modelLabel(id, this.config), kind: id === 'qwen' ? 'local' as const : 'cli' as const, ...probes[i],
        requested: this.requested(id), ...(id === 'qwen' ? { endpoint: this.config.endpoint, contextTokens: this.config.contextTokens } : {}),
        last: this.history.get(id) ?? null,
      })),
    };
  }
}
