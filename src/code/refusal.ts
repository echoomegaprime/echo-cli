/**
 * Refusal detector: did a vendor model decline the request instead of answering it?
 *
 * Commander directive 2026-11-04: when Claude, GPT, Grok or Argon decline because of their
 * classifiers, the same turn is re-run on Qwen and the reply is labelled. This module only
 * decides whether a text is a decline; the re-route itself lives in src/prime/chat.ts.
 *
 * It is a tuned pattern list with a confidence score, not a model call. A ProviderUnavailableError
 * (outage, sign-out, timeout) is never a refusal and is never passed through here by callers.
 */
export interface RefusalDetection { refused: boolean; confidence: number; matched: string[] }

interface Pattern { name: string; weight: number; re: RegExp }
/** Strong first-person declines. One of these near the start of a short reply is a refusal on its own. */
const STRONG: Pattern[] = [
  { name: 'unable-to-help', weight: 0.65, re: /\bI(?:['’]m| am) (?:unable|not able) to (?:help|assist|provide|comply|do that|continue|complete|fulfill|write|create|generate|produce|answer)\b/i },
  { name: 'cant-help', weight: 0.65, re: /\bI (?:can(?:['’]t|not)|won(?:['’]t|ʼt)|will not|cannot) (?:help|assist|provide|comply|continue|create|generate|write|produce|answer|complete|fulfill|support|engage)\b(?! but)/i },
  { name: 'cant-do-that', weight: 0.6, re: /\bI (?:can(?:['’]t|not)|cannot|won(?:['’]t)) do that\b/i },
  // A possessive ("my guidelines") or a policy qualifier ("the usage policy") is required: "against the guidelines in the style guide" is a coding remark, not a decline.
  { name: 'against-guidelines', weight: 0.7, re: /\b(?:against|violat(?:e|es|ing)|contrary to|conflicts? with|not (?:in line|consistent) with|prohibited by|restricted by|blocked by) (?:(?:my|our|its) (?:content |usage |safety |ethical |community )?|(?:the |applicable )?(?:content|usage|safety|ethical|community|platform|acceptable[- ]use) )(?:guidelines|polic(?:y|ies)|principles|rules|constraints|restrictions|settings|terms of (?:use|service))\b/i },
  { name: 'wont-take-action', weight: 0.65, re: /\bI (?:won(?:['’]t)|will not|can(?:['’]t|not)|cannot) (?:take|perform|carry out|execute|do) (?:that|this|the|those) (?:actions?|requests?|tasks?|steps?)\b/i },
  { name: 'dont-provide-kind', weight: 0.65, re: /\bI (?:don(?:['’]t)|do not) (?:provide|offer|give|write|generate|create|produce|share|assist with) (?:\w+ ){0,3}?(?:of that kind|of this kind|like that|like this|on that topic|for that purpose|in that area)\b/i },
  { name: 'cant-give-requested', weight: 0.6, re: /\b(?:can(?:['’]t|not)|cannot|won(?:['’]t)|unable to) (?:\w+ ){0,8}?(?:provide|give|share|offer|supply|produce) (?:you )?(?:the |that |this |those )?requested\b/i },
  { name: 'must-decline', weight: 0.7, re: /\bI (?:must|have to|need to|am going to|['’]ll have to|will have to|respectfully) (?:decline|refuse)\b/i },
  { name: 'not-something-i-can', weight: 0.65, re: /\bnot (?:something|a request|a task) (?:that )?I(?:['’]m| am)? (?:can|able to|willing to|comfortable) (?:help|assist|do|support|provide)\b/i },
  { name: 'not-comfortable', weight: 0.6, re: /\bI(?:['’]m| am) not (?:comfortable|willing|permitted|allowed|able) (?:to|with|doing|providing|helping|writing|generating)\b/i },
  { name: 'cant-fulfill', weight: 0.7, re: /\bI (?:can(?:['’]t|not)|cannot|am unable to|won(?:['’]t)) (?:fulfill|fulfil|complete|process|accommodate|honou?r) (?:this|that|your|the) request\b/i },
  { name: 'cant-provide-this', weight: 0.6, re: /\bI (?:can(?:['’]t|not)|cannot|won(?:['’]t)) (?:provide|offer|give|share) (?:that|this|the|any|such|those|you with)\b/i },
  { name: 'cannot-assist-with', weight: 0.65, re: /\b(?:cannot|can(?:['’]t)|unable to) (?:assist|help) (?:you )?with (?:that|this|requests?|creating|generating|writing|anything)\b/i },
  { name: 'declined-explicit', weight: 0.7, re: /\bI(?:['’]m| am) (?:declining|going to decline|refusing)\b/i },
];
/** Policy / safety vocabulary. Alone it is weak; together with a strong match it is conclusive. */
const SUPPORT: Pattern[] = [
  { name: 'as-an-ai', weight: 0.3, re: /\bas an AI(?: (?:language )?model| assistant)?\b/i },
  { name: 'safety', weight: 0.3, re: /\bsafety (?:guidelines|reasons|concerns|polic(?:y|ies)|standards|rules|constraints|restrictions|settings|filters|limits|boundaries)\b/i },
  { name: 'rules-out', weight: 0.3, re: /\b(?:rules? out|prohibits?|precludes?|prevents? me from|forbids?|does not (?:allow|permit)) (?:\w+ ){0,3}?(?:assistance|request|help|content|response|that|this)\b/i },
  { name: 'content-policy', weight: 0.35, re: /\bcontent (?:polic(?:y|ies)|filters?|guidelines|restrictions)\b/i },
  { name: 'usage-policy', weight: 0.35, re: /\busage polic(?:y|ies)\b/i },
  { name: 'harmful', weight: 0.25, re: /\b(?:potentially )?(?:harmful|dangerous|illegal|unethical|inappropriate|malicious|unsafe)\b/i },
  { name: 'sorry-but', weight: 0.3, re: /\bI(?:['’]m| am) sorry,? but\b/i },
  { name: 'apologize-but', weight: 0.3, re: /\bI apologi[sz]e,? but\b/i },
  { name: 'unfortunately-i', weight: 0.25, re: /\bunfortunately,? I (?:can|am|must|won|will)/i },
  { name: 'designed-to', weight: 0.25, re: /\bI(?:['’]m| am) (?:designed|programmed|built|trained) to (?:be|avoid|not|decline|refuse|promote)\b/i },
  { name: 'instead-offer', weight: 0.2, re: /\b(?:instead|however|alternatively),? (?:I can|I(?:['’]d| would) be (?:happy|glad) to|I(?:['’]m| am) happy to|let me|here(?:['’]s| is) what I can)\b/i },
  { name: 'professional', weight: 0.25, re: /\b(?:consult|contact|reach out to|speak (?:with|to)|seek (?:help from)?) (?:a |an |your )?(?:licensed |qualified |medical |mental health |legal )?(?:professional|attorney|lawyer|doctor|physician|therapist|counsel(?:or|lor)|authorities|law enforcement)\b/i },
  { name: 'ethical', weight: 0.25, re: /\bethical (?:guidelines|concerns|reasons|standards|boundaries)\b/i },
  { name: 'cannot-engage', weight: 0.3, re: /\b(?:cannot|can(?:['’]t)|won(?:['’]t)|will not) (?:engage|participate|take part) (?:in|with)\b/i },
  { name: 'hard-limit', weight: 0.3, re: /\b(?:this|that) (?:request|topic|content) (?:is|falls) (?:outside|beyond) (?:of )?(?:what I|my) (?:can|scope|boundaries|abilities)\b/i },
];
const QUOTE_OR_CODE = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]{4,}"|“[^”\n]{4,}”|^\s*>.*$/gm;
const REPORTED_SPEECH = /\b(?:you (?:said|wrote|asked|mentioned)|the (?:model|assistant|provider|vendor|bot|reply|response|phrase|pattern|string|regex|text) (?:said|says|returned|contains?|matches|like)|for example|e\.g\.|such as|detect(?:s|ing|or|ion)?|pattern|regex|refusal)\b/i;

/** Blanks quoted or fenced spans while keeping offsets, so a quoted refusal is not counted. */
function blankQuoted(text: string): string {
  return text.replace(QUOTE_OR_CODE, m => m.replace(/[^\n]/g, ' '));
}
function nearStart(text: string, index: number): boolean { return index <= Math.max(300, Math.floor(text.length * 0.2)); }

/**
 * Scores a reply. `refused` is true when the confidence reaches 0.6. The score rises with strong
 * first-person declines and policy vocabulary, and falls when the text goes on to deliver substance
 * (code, long content after the decline) or is clearly talking about refusals rather than refusing.
 */
export function detectRefusal(text: unknown): RefusalDetection {
  if (typeof text !== 'string') return { refused: false, confidence: 0, matched: [] };
  const trimmed = text.trim();
  if (!trimmed) return { refused: false, confidence: 0, matched: [] };
  const scan = blankQuoted(trimmed);
  const matched: string[] = [];
  let strong = 0, support = 0, firstStrong = -1;
  for (const p of STRONG) {
    const m = p.re.exec(scan);
    if (!m) continue;
    matched.push(p.name);
    strong += nearStart(scan, m.index) ? p.weight : p.weight * 0.5;
    if (firstStrong < 0 || m.index < firstStrong) firstStrong = m.index;
  }
  for (const p of SUPPORT) { if (p.re.test(scan)) { matched.push(p.name); support += p.weight; } }
  let confidence = strong + Math.min(support, 0.5);
  // Substance after the decline: a long answer that keeps going is an answer with a caveat, not a refusal.
  const hasCode = /```/.test(trimmed);
  const tail = firstStrong >= 0 ? scan.length - firstStrong : 0;
  if (strong > 0 && tail > 900) confidence *= 0.55;
  if (hasCode) confidence *= 0.4;
  if (strong > 0 && REPORTED_SPEECH.test(scan)) confidence *= 0.6;
  // A short reply made only of policy vocabulary (a preamble with nothing after it) is a decline.
  if (strong === 0 && support >= 0.5 && trimmed.length < 220) confidence = Math.max(confidence, 0.6);
  // Hard refusal with no supporting vocabulary in a short reply still counts.
  if (strong >= 0.6 && trimmed.length < 400 && !hasCode) confidence = Math.max(confidence, 0.6);
  confidence = Math.min(1, Math.round(confidence * 100) / 100);
  return { refused: confidence >= 0.6, confidence, matched };
}
