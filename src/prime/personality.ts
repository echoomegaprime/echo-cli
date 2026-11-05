import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { debuglog } from 'node:util';
import type { Persona } from '../code/agent.js';

/**
 * Personality Forge auto-selection (Commander directive 2026-11-04: "Personality Forge autonomously selects
 * personalities throughout; replies depend on replies"). Before each Prime reply a deterministic scorer looks at the
 * current message and the last three turns (topic, tone, intent) and picks one of the six Workspace behaviour
 * profiles; its prompt fragment is injected once into the system text (never mid-reply).
 *
 * Catalog: the Workspace's `/api/state` `personalities` list (id, display name, registered) is loaded through the
 * authenticated bridge and cached 60 s; the prompt fragments below are Prime's mirror of the Workspace overlays in
 * `SYSTEMS/echo_qwen_chat/src/personalities.py` (`OVERLAYS`), because the Workspace does not expose a profile's
 * registered `system_prompt` over any route. Scoring cues were drafted by Gemini (agy, `wrap.sh draft gemini`,
 * 2026-11-04) and reviewed here. Settings (off switch, pinned profile) are an owner setting persisted to a JSON file.
 */
export type PersonalityId = 'echo' | 'gs343' | 'prometheus' | 'bree' | 'c3po' | 'r2d2';
export const PERSONALITY_IDS: readonly PersonalityId[] = ['echo', 'gs343', 'prometheus', 'bree', 'c3po', 'r2d2'];
export type Intent = 'technical' | 'creative' | 'operational' | 'personal' | 'crisis';
export type Tone = 'urgent' | 'playful' | 'formal' | 'casual';
interface Profile { id: PersonalityId; name: string; fragment: string; keywords: string[]; regexes: RegExp[]; intents: Record<Intent, number>; tone: Record<Tone, number> }
const PROFILES: Record<PersonalityId, Profile> = {
  echo: {
    id: 'echo', name: 'Echo Prime',
    fragment: 'Act as Echo Prime: a capable, warm, candid and decisive personal engineering partner. Be proactive within the task, remember user preferences, use dry humor naturally, and verify actions. Address the user naturally; do not repeat titles or grandiose claims. Never identify as the FORGE node.',
    keywords: ['prioritise', 'prioritize', 'roadmap', 'plan tomorrow', 'tradeoff', 'trade-off', 'what should i do', 'next step', 'next steps', 'decision', 'decide', 'strategy', 'brainstorm', 'gut check', 'sanity check', 'burnout', 'overwhelmed', 'tired', 'focus today', 'goal', 'milestone', 'schedule', 'workflow', 'advice', 'partner', 'perspective', 'weighing options', 'architecture choice', 'game plan', 'honest take'],
    regexes: [/\bwhat should i (do|focus on|prioriti[sz]e|tackle)\b/i, /\b(honest|candid) (take|opinion|advice)\b/i, /\b(sanity|gut) check\b/i, /\b(game plan|next steps?|weighing options)\b/i],
    intents: { technical: 1, creative: 1, operational: 1, personal: 2, crisis: 1 }, tone: { urgent: 1, playful: 1, formal: 1, casual: 2 },
  },
  gs343: {
    id: 'gs343', name: 'GS343',
    fragment: 'Focus on knowledge retrieval, diagnosis and verified repairs. Consult actual GS343 diagnostics and healing schemas when relevant; never claim an automatic repair without an action receipt and readback.',
    keywords: ['prove it', 'cite', 'citation', 'evidence', 'acceptance criteria', 'specification', 'certification', 'certify', 'recall', 'memory', 'verified repair', 'root cause', 'audit trail', 'compliance', 'invariant', 'postmortem', 'canonical', 'ground truth', 'precedent', 'what did we decide', 'knowledge base', 'doctrine', 'attestation', 'reproducible', 'verification', 'determinism', 'regression report', 'sla requirement', 'formal spec', 'corroborate'],
    regexes: [/\b(prove it|ground truth|acceptance criteria|audit trail)\b/i, /\b(recall|remember) what we (decided|agreed|documented)\b/i, /\bcite (it|the source|your sources|evidence)\b/i, /\b(certif(y|ied|ication)|corroborat(e|ed)|formal spec(ification)?)\b/i],
    intents: { technical: 2, creative: 0, operational: 1, personal: 0, crisis: 1 }, tone: { urgent: 1, playful: 0, formal: 2, casual: 0 },
  },
  prometheus: {
    id: 'prometheus', name: 'Prometheus',
    fragment: 'Focus on authorized cybersecurity work, defensive analysis and security labs. Verify target ownership, scope and real tool evidence before acting.',
    keywords: ['pentest', 'penetration test', 'vulnerability', 'vuln', 'exploit', 'cve', 'security audit', 'hardening', 'firewall', 'osint', 'forensics', 'incident response', 'threat model', 'attack surface', 'privilege escalation', 'privesc', 'nmap', 'payload', 'reverse shell', 'xss', 'sql injection', 'sqli', 'ssrf', 'csrf', 'zero trust', 'ioc', 'compromise', 'red team', 'blue team', 'port scan'],
    regexes: [/\bcve-\d{4}-\d{4,7}\b/i, /\b(vuln(erability)? scan|pen(etration )?test|security audit)\b/i, /\b(sql injection|ssrf|xss|csrf|priv(ilege )?esc(alation)?)\b/i, /\b(attack surface|threat model|incident forensics|firewall)\b/i],
    intents: { technical: 2, creative: 0, operational: 2, personal: 0, crisis: 2 }, tone: { urgent: 2, playful: 0, formal: 2, casual: 0 },
  },
  bree: {
    id: 'bree', name: 'Bree',
    fragment: 'Use playful wit, funny observations, consensual roasting and adult flirtation when invited. Do not present yourself as the real Bree or claim access to her private thoughts.',
    keywords: ['roast', 'joke', 'banter', 'meme', 'humour', 'humor', 'flirt', 'witty', 'sarcasm', 'pun', 'trash talk', 'tease', 'make me laugh', 'cheer me up', 'hot take', 'spicy take', 'savage', 'burn', 'clapback', 'vibe check', 'dad joke', 'one-liner', 'playful', 'hypeman', 'hype me up', 'roast me', 'funny', 'limerick', 'parody'],
    regexes: [/\broast (me|my|this|our)\b/i, /\b(dad joke|one-liner|limerick|make me laugh)\b/i, /\b(spic(y|iest)|hot) take\b/i, /\b(hype me up|banter|vibe check)\b/i],
    intents: { technical: 0, creative: 2, operational: 0, personal: 2, crisis: 0 }, tone: { urgent: 0, playful: 2, formal: 0, casual: 2 },
  },
  c3po: {
    id: 'c3po', name: 'C-3PO',
    fragment: 'Translate technical problems into concise human-readable explanations. Inspect diagnostics and code before recommending or performing fixes.',
    keywords: ['stack trace', 'traceback', 'compiler error', 'typeerror', 'syntaxerror', 'referenceerror', 'nullpointerexception', 'segfault', 'explain this error', 'what does this mean', "like i'm five", 'eli5', 'plain english', 'walk me through', 'refactor', 'typescript error', 'borrow checker', 'async await', 'race condition', 'deadlock', 'regex', 'exception', 'undefined is not', 'cannot read properties', 'lint error', 'step by step', 'code review', 'deconstruct', 'translate this code', 'why does this throw'],
    regexes: [/\bexplain (this|the) (stack ?trace|error|exception|code|regex)\b/i, /\b(like i'?m five|eli5|in plain english)\b/i, /\b(TS\d{4}|TypeError|SyntaxError|ReferenceError|KeyError|NullPointerException)\b/, /\bwhat does .{1,80}? (actually )?mean\b/i],
    intents: { technical: 2, creative: 0, operational: 0, personal: 0, crisis: 0 }, tone: { urgent: 0, playful: 0, formal: 1, casual: 1 },
  },
  r2d2: {
    id: 'r2d2', name: 'R2-D2',
    fragment: 'Be resourceful and concise. Find concrete diagnostic evidence, isolate the failure, repair within the task, and verify. Keep technical findings readable rather than answering only with beeps.',
    keywords: ['systemd', 'journalctl', 'systemctl', 'gpu', 'vram', 'nvidia-smi', 'disk full', 'iops', 'latency', 'packet loss', 'node health', 'heartbeat', 'oom', 'out of memory', 'cpu spike', 'load average', 'restart service', 'daemon', 'port listening', 'netstat', 'ss -tulpn', 'dmesg', 'thermal throttling', 'temperature', 'uptime', 'unreachable', '502 bad gateway', 'connection refused', 'raid', 'filesystem'],
    regexes: [/\bis [a-z0-9_.-]+ (up|down|online|alive|reachable)\b/i, /\b(gate|node|service|daemon|cluster|rig|box) is (down|dead|flapping|unreachable)\b/i, /\b(systemctl|journalctl|nvidia-smi|dmesg|oom killer|exit code 137)\b/i, /\b(502 bad gateway|connection refused|thermal throttling|disk (full|space))\b/i],
    intents: { technical: 2, creative: 0, operational: 2, personal: 0, crisis: 2 }, tone: { urgent: 2, playful: 0, formal: 1, casual: 1 },
  },
};
// Gemini's intent/tone lists, widened in review: the drafted lists missed the words the profiles themselves key on ("roast", "stack trace", "systemctl").
const INTENT_CUES: Record<Intent, string[]> = {
  technical: ['code', 'function', 'compile', 'compiler', 'bug', 'error', 'api', 'schema', 'query', 'algorithm', 'library', 'script', 'type', 'class', 'debug', 'interface', 'stack trace', 'traceback', 'exception', 'regex', 'typescript', 'python', 'rust', 'syntax', 'lint', 'refactor', 'test', 'explain this', 'what does this mean', 'borrow checker', 'throw'],
  creative: ['write', 'story', 'joke', 'brainstorm', 'imagine', 'riff', 'poem', 'metaphor', 'tagline', 'humour', 'humor', 'parody', 'sketch', 'invent', 'playful', 'creative', 'roast', 'funny', 'meme', 'banter', 'limerick', 'pun', 'witty', 'hype', 'one-liner', 'hot take'],
  operational: ['deploy', 'server', 'service', 'node', 'cluster', 'status', 'restart', 'health', 'monitor', 'log', 'logs', 'uptime', 'disk', 'memory', 'network', 'daemon', 'systemd', 'systemctl', 'journalctl', 'gpu', 'vram', 'latency', 'gate', 'tunnel', 'backup', 'config', 'firewall', 'audit', 'scan'],
  personal: ['tired', 'feeling', 'career', 'habit', 'motivation', 'stress', 'sleep', 'focus', 'overwhelmed', 'balance', 'goal', 'life', 'priorities', 'burnout', 'advice', 'my mom', 'my dad', 'family', 'birthday', 'schedule', 'appointment', 'i feel', 'prioritise', 'prioritize', 'tomorrow', 'my day'],
  crisis: ['down', 'outage', 'urgent', 'asap', 'broken', 'emergency', 'critical', 'sev1', 'incident', 'failing', 'crashed', 'unresponsive', 'breach', 'paged', 'offline', 'dead', 'flapping', 'unreachable', 'spiked', 'throttling', 'oom', 'died', 'on fire', '502', 'compromised'],
};
const TONE_CUES: Record<Tone, string[]> = {
  urgent: ['immediately', 'asap', 'urgent', 'hurry', 'quick', 'fast', 'emergency', 'stat', 'right now', 'before launch', 'first'],
  playful: ['lol', 'haha', 'roast', 'lmao', 'hehe', 'jk', 'banter', 'meme', 'funny', 'tease'],
  formal: ['pursuant', 'hereby', 'verify', 'certify', 'specification', 'attest', 'compliance', 'accordance', 'evidence', 'formally'],
  casual: ['hey', 'yo', 'sup', 'kinda', 'gonna', 'wanna', 'tbh', 'ngl', 'chill', 'reckon'],
};
const debug = debuglog('echo-prime');
const isPersonalityId = (v: unknown): v is PersonalityId => typeof v === 'string' && (PERSONALITY_IDS as readonly string[]).includes(v);

export interface CatalogEntry { id: PersonalityId; name: string; registered: boolean }
export type CatalogLoader = () => Promise<unknown>;
export interface Turn { role: string; content: string }
export interface PersonalitySettings { enabled: boolean; pinned: PersonalityId | null }
export interface Selection { id: PersonalityId; name: string; reason: string; fragment: string; pinned: boolean; intent: Intent | null; tone: Tone | null; scores: Record<PersonalityId, number> }
export interface Ranked { id: PersonalityId; score: number; cues: string[] }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (kw: string) => new RegExp(`(?<![\\w-])${escape(kw)}(?![\\w-])`, 'i');
function cues<K extends string>(table: Record<K, string[]>, text: string): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of Object.keys(table) as K[]) out[key] = table[key].filter(kw => phrase(kw).test(text)).length;
  return out;
}
/** Highest count wins; ties go to the earlier entry of `prefer` (a crisis outranks an operational remark, urgency outranks casual wording). */
function top<K extends string>(counts: Record<K, number>, prefer: readonly K[]): K | null {
  let best: K | null = null;
  for (const key of prefer) if (counts[key] > 0 && (best === null || counts[key] > counts[best])) best = key;
  return best;
}
const INTENT_PREFERENCE: readonly Intent[] = ['crisis', 'technical', 'operational', 'creative', 'personal'];
const TONE_PREFERENCE: readonly Tone[] = ['urgent', 'playful', 'formal', 'casual'];
/** Only the user's own words count as history: assistant JSON actions and tool results are not topic signals. */
function recentUserTurns(history: readonly Turn[], count = 3): string[] {
  return history.filter(t => t && t.role === 'user' && typeof t.content === 'string' && !t.content.startsWith('UNTRUSTED TOOL RESULT')).slice(-count).map(t => t.content.slice(0, 2000)).reverse();
}
/**
 * Deterministic scorer. Current message: keyword hit 3, regex hit 4. Each of the last three user turns: keyword hit
 * 1.5 / 1 / 0.5 (most recent first). Intent affinity x1.5 and tone affinity x1 from the current message's cues. Echo
 * Prime carries a baseline so it wins when nothing else scores, and unregistered profiles are discounted.
 */
export function scorePersonalities(prompt: string, history: readonly Turn[] = [], catalog?: readonly CatalogEntry[]): { ranked: Ranked[]; intent: Intent | null; tone: Tone | null } {
  const text = typeof prompt === 'string' ? prompt.slice(0, 6000) : '';
  const lower = text.toLowerCase();
  const earlier = recentUserTurns(history), weights = [1.5, 1, 0.5];
  const intent = top(cues(INTENT_CUES, lower), INTENT_PREFERENCE), tone = top(cues(TONE_CUES, lower), TONE_PREFERENCE);
  const registered = new Map((catalog ?? []).map(e => [e.id, e.registered]));
  const ranked: Ranked[] = PERSONALITY_IDS.map(id => {
    const p = PROFILES[id], hit: string[] = [];
    let score = id === 'echo' ? 1.5 : 0;
    for (const kw of p.keywords) if (phrase(kw).test(lower)) { score += 3; hit.push(kw); }
    for (const re of p.regexes) { const m = re.exec(text); if (m) { score += 4; hit.push(m[0].toLowerCase().slice(0, 30)); } }
    earlier.forEach((turn, i) => { const l = turn.toLowerCase(); for (const kw of p.keywords) if (phrase(kw).test(l)) { score += weights[i]; } });
    if (intent) score += p.intents[intent] * 1.5;
    if (tone) score += p.tone[tone];
    if (catalog && registered.get(id) === false) score *= 0.85;
    return { id, score: Math.round(score * 100) / 100, cues: hit.slice(0, 6) };
  });
  ranked.sort((a, b) => b.score - a.score || PERSONALITY_IDS.indexOf(a.id) - PERSONALITY_IDS.indexOf(b.id));
  return { ranked, intent, tone };
}

/** Validates what the Workspace `/api/state` reports as `personalities` (the `auto` row is not a profile). Anything malformed is dropped, never guessed. */
export function parseCatalog(value: unknown): CatalogEntry[] {
  const list = Array.isArray(value) ? value : (value && typeof value === 'object' && Array.isArray((value as { personalities?: unknown }).personalities)) ? (value as { personalities: unknown[] }).personalities : [];
  const out: CatalogEntry[] = [], seen = new Set<string>();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (!isPersonalityId(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    // eslint-disable-next-line no-control-regex
    const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
    out.push({ id: r.id, name: name || PROFILES[r.id].name, registered: r.registered === true });
  }
  return out;
}
export const builtinCatalog = (): CatalogEntry[] => PERSONALITY_IDS.map(id => ({ id, name: PROFILES[id].name, registered: false }));
export const personaFor = (id: PersonalityId, name?: string): Persona => ({ id, name: name || PROFILES[id].name, fragment: PROFILES[id].fragment });

const CACHE_MS = 60000;
export interface ForgeOptions { file?: string; now?: () => number }
export class PersonalityForge {
  private state: PersonalitySettings = { enabled: true, pinned: null };
  private cache: { at: number; entries: CatalogEntry[]; source: 'workspace' | 'builtin' } | null = null;
  private lastSelection: (Selection & { at: string }) | null = null;
  private now: () => number;
  constructor(private options: ForgeOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.file && existsSync(options.file)) {
      try {
        const v = JSON.parse(readFileSync(options.file, 'utf8')) as Record<string, unknown>;
        this.state = { enabled: v.enabled !== false, pinned: isPersonalityId(v.pinned) ? v.pinned : null };
      } catch { this.state = { enabled: true, pinned: null }; }
    }
  }
  settings(): PersonalitySettings { return { ...this.state }; }
  /** Owner setting. `enabled:false` turns auto-selection off (no persona in the system text); `pinned` locks one profile. Persisted atomically when a file is configured. */
  update(patch: unknown): PersonalitySettings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid personality settings');
    const p = patch as Record<string, unknown>;
    for (const key of Object.keys(p)) if (!['enabled', 'pinned'].includes(key)) throw new Error('Invalid personality settings');
    const next = { ...this.state };
    if (p.enabled !== undefined) { if (typeof p.enabled !== 'boolean') throw new Error('Invalid personality settings: enabled'); next.enabled = p.enabled; }
    if (p.pinned !== undefined) { if (p.pinned !== null && !isPersonalityId(p.pinned)) throw new Error('Invalid personality settings: pinned must be one of ' + PERSONALITY_IDS.join(', ')); next.pinned = p.pinned; }
    this.state = next;
    if (this.options.file) {
      mkdirSync(dirname(this.options.file), { recursive: true });
      const temp = `${this.options.file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(temp, this.options.file);
    }
    debug('%j', { event: 'prime_personality_settings', ...this.state });
    return this.settings();
  }
  /** The Workspace catalog through the supplied loader, cached 60 s; the built-in list (nothing marked registered) when there is no loader or it fails. */
  async catalog(loader?: CatalogLoader): Promise<{ entries: CatalogEntry[]; source: 'workspace' | 'builtin'; reason?: string }> {
    const now = this.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return { entries: this.cache.entries, source: this.cache.source };
    if (!loader) return { entries: builtinCatalog(), source: 'builtin', reason: 'no Workspace catalog loader' };
    try {
      const entries = parseCatalog(await loader());
      if (!entries.length) throw new Error('the Workspace listed no personalities');
      this.cache = { at: now, entries, source: 'workspace' };
      return { entries, source: 'workspace' };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'Workspace catalog unavailable';
      debug('%j', { event: 'prime_personality_catalog_failed', reason });
      return { entries: builtinCatalog(), source: 'builtin', reason };
    }
  }
  /** Picks the personality for one turn: null when auto-selection is off; the pinned profile when one is locked; otherwise the scorer's best. */
  async select(input: { prompt: string; history?: readonly Turn[]; loader?: CatalogLoader }): Promise<Selection | null> {
    if (!this.state.enabled) return null;
    const { entries } = await this.catalog(input.loader);
    const names = new Map(entries.map(e => [e.id, e.name]));
    const { ranked, intent, tone } = scorePersonalities(input.prompt, input.history ?? [], entries);
    const scores = Object.fromEntries(ranked.map(r => [r.id, r.score])) as Record<PersonalityId, number>;
    let selection: Selection;
    if (this.state.pinned) {
      selection = { id: this.state.pinned, name: names.get(this.state.pinned) ?? PROFILES[this.state.pinned].name, reason: 'pinned by the owner', fragment: PROFILES[this.state.pinned].fragment, pinned: true, intent, tone, scores };
    } else {
      const best = ranked[0];
      const why = [intent ? `${intent} intent` : 'no clear intent', tone ? `${tone} tone` : null, best.cues.length ? `cues: ${best.cues.map(c => `'${c}'`).join(', ')}` : (best.id === 'echo' ? 'default' : null)].filter(Boolean).join('; ');
      selection = { id: best.id, name: names.get(best.id) ?? PROFILES[best.id].name, reason: why, fragment: PROFILES[best.id].fragment, pinned: false, intent, tone, scores };
    }
    this.lastSelection = { ...selection, at: new Date(this.now()).toISOString() };
    debug('%j', { event: 'prime_personality_selected', id: selection.id, pinned: selection.pinned, intent, tone });
    return selection;
  }
  last(): { id: PersonalityId; name: string; reason: string; pinned: boolean; at: string } | null {
    const l = this.lastSelection;
    return l ? { id: l.id, name: l.name, reason: l.reason, pinned: l.pinned, at: l.at } : null;
  }
}
