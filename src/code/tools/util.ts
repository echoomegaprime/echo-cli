import { createHash } from 'node:crypto';
import { redact } from '../workspace.js';
import type { ParamSpec, ToolArgs } from './types.js';
import { ToolRefused } from './types.js';

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const str = (value: unknown, max = 2000): string => typeof value === 'string' ? clip(value, max) : typeof value === 'number' ? String(value) : '';
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const over = text.length - max;
  return `${text.slice(0, max)}…[truncated ${over} chars]`;
}
export const stamp = (now: () => number) => new Date(now()).toISOString();
/** A credential-shaped argument key is refused before any tool runs; credential values are never model inputs. */
const SECRET_KEY = /(?:secret|password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|credential)/i;
export function refuseSecrets(args: ToolArgs): void {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(v => walk(v, depth + 1)); return; }
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new ToolRefused('Credential-shaped arguments are refused; credentials are never model inputs. Use the isolated Vault form.');
      walk(item, depth + 1);
    }
  };
  walk(args, 0);
}
/** Checks declared parameters only: unknown keys, wrong types and oversized strings are refused. */
export function validateArgs(params: Record<string, ParamSpec>, args: unknown): ToolArgs {
  const input = record(args);
  if (JSON.stringify(input).length > 16384) throw new ToolRefused('Tool arguments exceed 16 KB');
  for (const key of Object.keys(input)) if (!(key in params)) throw new ToolRefused(`Unknown argument "${key}"`);
  const out: ToolArgs = {};
  for (const [key, spec] of Object.entries(params)) {
    const value = input[key];
    if (value === undefined || value === null) { if (spec.required) throw new ToolRefused(`Argument "${key}" is required`); continue; }
    if (spec.type === 'string') {
      if (typeof value !== 'string' || !value.trim()) throw new ToolRefused(`Argument "${key}" must be a non-empty string`);
      if (value.length > (spec.max ?? 2000)) throw new ToolRefused(`Argument "${key}" exceeds ${spec.max ?? 2000} characters`);
      if ([...value].some(c => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t')) throw new ToolRefused(`Argument "${key}" contains control characters`);
      if (spec.enum && !spec.enum.includes(value)) throw new ToolRefused(`Argument "${key}" must be one of ${spec.enum.join(', ')}`);
      out[key] = value.trim();
    } else if (spec.type === 'integer') {
      const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < (spec.min ?? 1) || n > (spec.max ?? 100)) throw new ToolRefused(`Argument "${key}" must be an integer between ${spec.min ?? 1} and ${spec.max ?? 100}`);
      out[key] = n;
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolRefused(`Argument "${key}" must be an object`);
      if (JSON.stringify(value).length > (spec.max ?? 8192)) throw new ToolRefused(`Argument "${key}" exceeds ${spec.max ?? 8192} bytes`);
      out[key] = value;
    }
  }
  return out;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]));
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : value;
}
/** Cache / dedupe key: tool name plus the normalised arguments (whitespace folded, case folded, keys sorted). */
export const argsKey = (tool: string, args: ToolArgs): string => createHash('sha256').update(`${tool}\n${JSON.stringify(sorted(args))}`).digest('hex');
/** Keys whose values are kept verbatim when a result is compacted for the model: a source must stay citable. */
const VERBATIM = /^(?:url|source|link|href|doc_id|id|path|request_id|sha256|fetched_at|retrieved_at|provider|date)$/i;
function shrink(value: unknown, perString: number, perArray: number, depth: number): unknown {
  if (depth > 8) return '[depth limit]';
  if (typeof value === 'string') return clip(value, perString);
  if (Array.isArray(value)) {
    const items = value.slice(0, perArray).map(v => shrink(v, perString, perArray, depth + 1));
    return value.length > perArray ? [...items, `…[${value.length - perArray} more items omitted]`] : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 60)) out[key] = VERBATIM.test(key) && typeof item === 'string' ? clip(item, 2048) : shrink(item, perString, perArray, depth + 1);
    return out;
  }
  return value;
}
/** Token-budgeted rendering for the model: long strings are clipped, arrays bounded, source URLs kept verbatim. */
export function compact(value: unknown, budgetChars: number): unknown {
  let perString = Math.max(200, Math.floor(budgetChars / 2)), perArray = 20, out = shrink(value, perString, perArray, 0);
  for (let i = 0; i < 12 && JSON.stringify(out).length > budgetChars; i++) {
    perString = Math.max(80, Math.floor(perString / 2)); perArray = Math.max(3, Math.floor(perArray / 2));
    out = shrink(value, perString, perArray, 0);
  }
  if (JSON.stringify(out).length > budgetChars) return { truncated: true, excerpt: clip(JSON.stringify(out), budgetChars - 60) };
  return out;
}
/** Deep-redacts every string in a result (API keys, bearer tokens, private keys) before it is stored, shown or sent. */
export function redactDeep(value: unknown): unknown {
  return JSON.parse(redact(JSON.stringify(value ?? null)));
}
export const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : 'Tool failed').slice(0, 600);
/** Collects every `url`/`source` string in a result (for the honest end-of-turn summary). */
export function sources(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { value.forEach(v => sources(v, out, depth + 1)); return out; }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:url|source)$/i.test(key) && typeof item === 'string' && /^https?:\/\//.test(item) && !out.includes(item) && out.length < 40) out.push(item);
    else sources(item, out, depth + 1);
  }
  return out;
}
/** RFC 1918/6890 and other non-global ranges; v4-mapped and NAT64 v6 addresses are judged by the embedded v4. */
export function isGlobalIp(ip: string): boolean {
  const v4 = (text: string): number[] | null => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text); if (!m) return null; const o = m.slice(1).map(Number); return o.every(n => n <= 255) ? o : null; };
  const octets = v4(ip);
  if (octets) {
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  const text = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!text.includes(':')) return false;
  const mapped = /^(?:::ffff:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (mapped) return isGlobalIp(mapped[1]);
  const groups = expandV6(text);
  if (!groups) return false;                                // unparseable is never treated as public
  const first = parseInt(groups[0], 16), second = parseInt(groups[1], 16);
  if (first === 0) return false;                            // ::/8 incl. unspecified and loopback
  if ((first & 0xfe00) === 0xfc00) return false;            // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false;            // fe80::/10 link local
  if ((first & 0xffc0) === 0xfec0) return false;            // fec0::/10 site local (deprecated)
  if ((first & 0xff00) === 0xff00) return false;            // ff00::/8 multicast
  if (first === 0x2001 && second === 0x0db8) return false;  // 2001:db8::/32 documentation
  return true;
}
function expandV6(text: string): string[] | null {
  const parts = text.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [], tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.length === 8 && groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? groups : null;
}
