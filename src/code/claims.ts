/**
 * Post-reply claim check (truthfulness layer, Commander directive 2026-11-04: "hallucinations cut to a minimum").
 *
 * Finds the concrete, checkable tokens in a reply - hex ids, UUIDs, URLs, numbers with units, file paths,
 * run/job/ticket ids - and asks one question of each: does this exact value appear anywhere in what the
 * model was actually given this turn (the user's message, tool results, provided context)? A value that
 * does not is `unverified`: the UI marks it and a debug event counts it. This never proves a claim true; it
 * only flags the ones Echo could not have read from evidence. Prose is not judged.
 */
export type ClaimKind = 'uuid' | 'hex' | 'url' | 'path' | 'quantity' | 'id';
export interface Claim { kind: ClaimKind; value: string; start: number; end: number }
export interface ClaimReport { total: number; verified: number; unverified: Claim[]; byKind: Partial<Record<ClaimKind, { total: number; unverified: number }>> }

const PATTERNS: { kind: ClaimKind; re: RegExp }[] = [
  { kind: 'url', re: /\bhttps?:\/\/[^\s<>()"'`\]]+/g },
  { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: 'id', re: /\b(?:esh|run|job|req|request|incident|ticket|build|evt|op|task)[_-](?:\d{8,14}[_-])?[0-9a-z]{6,32}\b|(?<![\w/])#\d{3,7}\b/gi },
  { kind: 'hex', re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{10,64}\b/gi },
  { kind: 'path', re: /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)?(?:[\w.-]+[\\/])+[\w.-]+(?:\.\w{1,8})?\b|(?<![\w/.-])[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|kt|cs|cpp|c|h|rb|php|sh|ps1|sql|css|html|json|yaml|yml|toml|md|txt|log|service|conf|ini|env|lock|csv|xml)\b/g },
  { kind: 'quantity', re: /(?<![\w.])(?:\$|USD ?|€|£)\s?\d[\d,]*(?:\.\d+)?\b|(?<![\w.])\d[\d,]*(?:\.\d+)?\s?(?:%|ms|µs|ns|s|sec|secs|seconds?|min|mins|minutes?|h|hr|hrs|hours?|days?|weeks?|months?|years?|GB|MB|KB|TB|GiB|MiB|KiB|TiB|B|bytes?|tokens?|rows?|files?|lines?|requests?|errors?|failures?|calls?|items?|users?|nodes?|cores?|units?|GHz|MHz|fps|rpm|kg|lb|lbs|km|mi|m|cm|mm|°[CF]|USD|EUR)\b(?![\w-])/g },
];
const CONTROL = /[\u0000-\u001f\u007f]/g; // eslint-disable-line no-control-regex

export function extractClaims(text: string): Claim[] {
  if (typeof text !== 'string' || !text) return [];
  const taken: boolean[] = new Array(text.length).fill(false);
  const claims: Claim[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const value = m[0].replace(/[.,;:!?)]+$/, '');
      if (!value || value.length < 2) continue;
      const start = m.index, end = start + value.length;
      if (kind === 'quantity' && /^\d{4}$/.test(value.trim())) continue; // bare years are not quantities
      if (kind === 'path' && !/[\\/]|\.\w{1,8}$/.test(value)) continue;
      if (kind === 'path' && /^(?:e\.g|i\.e|etc|vs|v\d|\d+(?:\.\d+)+)$/i.test(value)) continue;
      let overlap = false;
      for (let i = start; i < end; i++) if (taken[i]) { overlap = true; break; }
      if (overlap) continue;
      for (let i = start; i < end; i++) taken[i] = true;
      claims.push({ kind, value, start, end });
    }
  }
  return claims.sort((a, b) => a.start - b.start);
}

const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/[.,;:!?)]+$/, '');
const digits = (s: string) => s.replace(/[^\d.]/g, '').replace(/\.$/, '');
/** Escape every regex metacharacter so an interpolated value can only ever match itself. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the claim's value can be read from the evidence corpus (case-insensitive; paths also by basename; quantities by their number). */
export function supported(claim: Claim, corpus: string): boolean {
  if (!corpus) return false;
  const value = norm(claim.value);
  if (corpus.includes(value)) return true;
  if (claim.kind === 'path') {
    const base = value.split('/').filter(Boolean).at(-1);
    return !!base && base.includes('.') && corpus.includes(base);
  }
  if (claim.kind === 'quantity') {
    const n = digits(claim.value.replace(/,/g, ''));
    if (!n) return false;
    const re = new RegExp(`(?<![\\d.])${escapeRegExp(n)}(?![\\d])`);
    return re.test(corpus.replace(/,(?=\d{3}\b)/g, ''));
  }
  if (claim.kind === 'id' && value.startsWith('#')) return corpus.includes(value) || new RegExp(`(?<![\\w])${escapeRegExp(value.slice(1))}(?![\\w])`).test(corpus);
  return false;
}

/** Checks every claim in `answer` against the texts the model was given this turn. Counts are safe to log; `unverified` carries the values for the UI only. */
export function checkClaims(answer: string, context: readonly string[]): ClaimReport {
  const corpus = context.filter(c => typeof c === 'string').join('\n').toLowerCase().replace(/\\/g, '/').replace(CONTROL, ' ');
  const claims = extractClaims(answer);
  const byKind: ClaimReport['byKind'] = {};
  const unverified: Claim[] = [];
  for (const claim of claims) {
    const entry = (byKind[claim.kind] ??= { total: 0, unverified: 0 });
    entry.total++;
    if (!supported(claim, corpus)) { entry.unverified++; unverified.push(claim); }
  }
  return { total: claims.length, verified: claims.length - unverified.length, unverified, byKind };
}
