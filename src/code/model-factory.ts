import { tmpdir } from 'node:os';
import { LocalModel, validateEndpoint, type Model } from './model.js';
import { CliModel, PROVIDER_BIN, PROVIDER_LABEL, childEnv, run, type ProviderId, type Runner } from './providers.js';

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

export interface ModelsConfig {
  default: ModelId; endpoint: string; model: string; contextTokens: number;
  cli: Partial<Record<ProviderId, { model?: string }>>;
}
/** Reviewed defaults. The endpoint is the already-running loopback tunnel; nothing here is a credential. */
export const DEFAULT_MODELS: ModelsConfig = {
  default: 'qwen', endpoint: 'http://127.0.0.1:11450', model: 'c3po-code:echo-qwen38-abliterated-256k', contextTokens: 262144, cli: {},
};
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
  only(input, ['default', 'endpoint', 'model', 'contextTokens', 'cli'], 'models');
  const config: ModelsConfig = { ...DEFAULT_MODELS, cli: {} };
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

export interface AnswerInfo { id: ModelId; label: string; requested: string | null; model: string | null; reported: boolean; answered: boolean; at?: string }
export interface ProviderStatus {
  id: ModelId; label: string; kind: 'local' | 'cli'; available: boolean; reason?: string;
  check: 'model-listed' | 'installed' | 'signed-in'; checkedAt: string; requested: string | null;
  endpoint?: string; contextTokens?: number; last: AnswerInfo | null;
}
export interface ModelsReport { default: ModelId; contextTokens: number; providers: ProviderStatus[] }
export interface RouterOptions { runner?: Runner; now?: () => number; probeTimeoutMs?: number }
interface Probe { available: boolean; reason?: string; check: ProviderStatus['check']; checkedAt: string }
const CACHE_MS = 60000;

export class ModelRouter {
  private instances = new Map<ModelId, Model>();
  private history = new Map<ModelId, AnswerInfo>();
  private probes = new Map<ModelId, { at: number; probe: Promise<Probe> }>();
  private runner: Runner; private now: () => number; private probeTimeoutMs: number;
  constructor(readonly config: ModelsConfig = DEFAULT_MODELS, options: RouterOptions = {}) {
    this.runner = options.runner ?? run; this.now = options.now ?? Date.now; this.probeTimeoutMs = options.probeTimeoutMs ?? 8000;
  }
  get defaultId(): ModelId { return this.config.default; }
  sessionModel(id: ModelId): string { if (!isModelId(id)) throw new Error('Unknown model provider'); return sessionModelName(id, this.config); }
  private requested(id: ModelId): string | null { return id === 'qwen' ? this.config.model : this.config.cli[id]?.model ?? null; }
  private instance(id: ModelId): Model {
    let model = this.instances.get(id);
    if (!model) { model = buildModel(id, this.config, { runner: this.runner }); this.instances.set(id, model); }
    return model;
  }
  /** One turn on exactly the named provider. `info()` is what answered this turn; a failed turn never inherits an older answer. */
  turn(id: ModelId): { model: Model; answered(): AnswerInfo | null; info(): AnswerInfo } {
    if (!isModelId(id)) throw new Error('Unknown model provider');
    const model = this.instance(id) as Model & { last?: unknown };
    model.last = undefined;
    const label = modelLabel(id, this.config), requested = this.requested(id);
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
    const probe = id === 'qwen' ? this.probeLocal() : this.probeCli(id);
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
      default: this.config.default, contextTokens: this.config.contextTokens,
      providers: MODEL_IDS.map((id, i) => ({
        id, label: modelLabel(id, this.config), kind: id === 'qwen' ? 'local' as const : 'cli' as const, ...probes[i],
        requested: this.requested(id), ...(id === 'qwen' ? { endpoint: this.config.endpoint, contextTokens: this.config.contextTokens } : {}),
        last: this.history.get(id) ?? null,
      })),
    };
  }
}
