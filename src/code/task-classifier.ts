/**
 * Task classifier for auto model routing (rules side). One turn is one of four classes:
 *   coding        - write/refactor/debug/review/explain code, stack traces, tests, build errors
 *   long_context  - whole documents, transcripts, PDFs, images or other large/multimodal input
 *   research      - current events, "latest"/"today", prices, anything that needs the live web
 *   general       - conversation, SITREPs about Echo's own fleet, Echo-internal operations, anything personal
 * The router maps a class to a provider chain (src/code/model-factory.ts). When the rules are not
 * confident, the router may ask Qwen one short question; this module stays deterministic.
 */
export type TaskClass = 'coding' | 'long_context' | 'research' | 'general';
export const TASK_CLASSES: readonly TaskClass[] = ['coding', 'long_context', 'research', 'general'];
export interface TaskClassification { task: TaskClass; confidence: number; reasons: string[]; scores: Record<TaskClass, number> }

interface Rule { name: string; weight: number; re: RegExp }
const CODE_FENCE = /```[\s\S]*?```/g;
const RULES: Record<TaskClass, Rule[]> = {
  coding: [
    { name: 'code fence', weight: 3, re: /```/ },
    { name: 'stack trace', weight: 3, re: /\b(?:Traceback \(most recent call last\)|at [\w$.<>]+ \([^)]*:\d+:\d+\)|Exception in thread|error TS\d{4}|\bE\d{4}\b|panic:|segmentation fault|NullPointerException|TypeError:|ReferenceError:|SyntaxError:|ModuleNotFoundError|npm ERR!|\bexit code \d+)/i },
    { name: 'code verb', weight: 2, re: /\b(?:refactor|debug|implement|fix (?:the|this|my|a) (?:bug|test|build|error|function|code|lint)|write (?:a|the|some|me) (?:function|class|script|test|unit test|module|component|regex|query|migration)|add (?:a |the )?(?:test|unit test|type|types|typing)s?\b|unit tests?|code review|review (?:this|my|the) (?:pr|pull request|diff|patch|code)|lint(?:ing|er)?|compile|compiler|typecheck|type-?check|stack ?trace|exception|null pointer|segfault|merge conflict|rebase|git (?:bisect|blame|cherry-pick|diff)|pull request|why does this throw|regression test|failing test|build (?:fails|failure|is failing|broke)|broken build)\b/i },
    { name: 'code noun', weight: 1.5, re: /\b(?:function|class|method|variable|interface|typescript|javascript|python|rust|golang|\bgo\b|java|c\+\+|c#|kotlin|swift|bash|powershell|sql|regex|json|yaml|dockerfile|docker-compose|kubernetes|react|vue|svelte|node\.?js|npm|pnpm|yarn|pip|cargo|vitest|jest|pytest|mypy|ruff|eslint|tsc|webpack|vite|api endpoint|unit test|integration test|dependency|package\.json|tsconfig|pyproject|requirements\.txt|makefile|cmake|middleware|diff|patch|snippet)\b/i },
    { name: 'code path', weight: 2, re: /(?:^|[\s"'(`])(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|cs|cpp|cc|c|h|hpp|rb|php|sh|ps1|sql|css|scss|html|vue|svelte|toml|yaml|yml)\b/ },
    { name: 'error message', weight: 1.5, re: /\b(?:error|failing|fails|failed|broken|crash(?:es|ed|ing)?)\b.{0,40}\b(?:test|build|compile|import|module|function|script|deploy|ci)\b/i },
    // Grok draft (wrap.sh, 2026-11-04): "fix/debug/refactor/implement ... function/class/bug/error/test", and inline code (an assignment or a call).
    { name: 'fix target', weight: 2.5, re: /\b(?:fix|debug|refactor|implement|patch)\b.{0,48}\b(?:function|class|bug|error|test|build|module|handler|endpoint)s?\b/i },
    { name: 'inline code', weight: 3, re: /\b(?:const|let|var|def|fn|func|import|return|await|async)\s+[\w$]+\b|[\w$]+\.[\w$]+\([^)]*\)|=>\s*[{(]|\bnull\b.{0,12}\.[\w$]+\(|;\s*[\w$]+\.[\w$]+\(/ },
  ],
  long_context: [
    { name: 'document', weight: 3, re: /\b(?:this|the|these|those|both|two|attached|following|whole|entire|full|long|\d+[- ]page)\s+(?:[\w-]+\s+){0,2}(?:documents?|docs?|pdfs?|papers?|reports?|transcripts?|contracts?|spreadsheets?|books?|chapters?|articles?|essays?|manuscripts?|theses|thesis|whitepapers?|rfcs?|spec(?:ification)?s?|log files?|datasets?|invoices?|receipts?|statements?|drafts?|attachments?|slide ?decks?)\b/i },
    { name: 'summarise', weight: 2, re: /\b(?:summari[sz]e|summary of|condense|digest|tl;?dr|extract (?:the |all |every )?(?:key|main|action|table|figure|date|name|clause|requirement|line item|signature)s?|compare (?:these|the two|both|those) (?:\w+ )?(?:documents?|versions?|drafts?|contracts?|files?|reports?|papers?|transcripts?)|translate (?:this|the) (?:document|pdf|transcript|chapter)|chapter by chapter|differing clauses)\b/i },
    { name: 'multimodal', weight: 3, re: /\b(?:image|photo|picture|screenshot|diagram|chart|figure|scan|pdf|slide ?deck|slides|presentation|video|audio recording|transcript)\b.{0,40}\b(?:attached|below|here|this|enclosed|uploaded)\b|\b(?:attached|uploaded|enclosed|here is|here's|see|pasted)\b.{0,30}\b(?:image|photo|picture|screenshot|diagram|chart|pdf|scan|slides|video|recording|transcript|document|file)\b|\b(?:what(?:'s| is) in (?:this|the) (?:image|photo|picture|screenshot)|describe (?:this|the) (?:image|photo|picture|screenshot|diagram)|(?:read|ocr|transcribe|scan) (?:this|the|these) (?:image|photo|screenshot|scan|page)s?|this (?:screenshot|image|photo|pdf|scan|diagram))\b|\bocr\b/i },
    { name: 'bulk input', weight: 2, re: /\b(?:thousands? of|hundreds? of|\d{3,} (?:lines|pages|rows|entries|messages|emails)|pasted below|document dump)\b/i },
  ],
  research: [
    { name: 'currency', weight: 3, re: /\b(?:latest|newest|most recent|current|up[- ]to[- ]date|breaking|right now|as of (?:today|now|this week)|this (?:week|morning|month|year)|today'?s?|yesterday|tonight|recently announced|just (?:released|announced|published))\b/i },
    { name: 'news', weight: 3, re: /\b(?:news|headlines?|what happened (?:with|to|in)|announce(?:d|ment)|press release|election|stock price|share price|market (?:cap|price)|exchange rate|price of|how much (?:is|does|do) .{1,40}\b(?:cost|sell for)|weather|forecast|score|standings|box office|trending)\b/i },
    { name: 'web', weight: 3, re: /\b(?:search (?:the )?(?:web|internet|online)|look (?:it |this |that )?up online|google (?:it|this)|find (?:me )?(?:a |the )?(?:source|citation|link|article|website)s?|cite (?:a |your )?sources?|fact[- ]check|is it true that|verify online|what (?:does|do) the (?:docs|documentation|internet|web) say)\b/i },
    { name: 'version check', weight: 2, re: /\b(?:latest|current|newest) (?:version|release|stable)\b|\bwhat version (?:is|of)\b.{0,30}\b(?:latest|current|out|released)\b|\brelease (?:notes|date)\b|\bchangelog for\b/i },
    { name: 'who-is', weight: 1.5, re: /\b(?:who (?:is|was|won|owns|runs|leads)|when (?:did|does|will)|where (?:is|was)) \b/i },
  ],
  general: [
    // A node name alone is a weak cue (2.5): "debug the build on QUENCH" is coding, "price of a GPU for HAMMER" is research; "how is FORGE doing" adds the status cue below.
    { name: 'fleet', weight: 2.5, re: /\b(?:quench|forge|anvil|temper|hammer|crucible)\b/i },
    { name: 'echo-internal', weight: 3, re: /\b(?:sitrep|situation report|status report|fleet status|node status|cluster health|esh\b|sdk cap(?:abilit(?:y|ies))?|echo\.[a-z]+\.[a-z_.]+|crystal memory|crystal_|continuity fabric|\becf\b|arcanum|knowledge forge|echo prime|echo omega|throne room|personality forge|steward|sol gate|sovereign key|build queue|prompts\.(?:add|claim))\b/i },
    { name: 'status question', weight: 2, re: /\b(?:how (?:is|are|'s) (?:the |our |my )?(?:fleet|cluster|nodes?|gate|tunnel|services?|backups?|disk|gpu|memory|quench|forge|anvil|temper|hammer|crucible|everything|things)\b.{0,24}\b(?:doing|looking|today|right now|holding|going|tonight|this morning)|what(?:'s| is) (?:running|down|up|broken|pending|queued)|is (?:\w+ )?(?:up|down|online|offline|alive|healthy)\b|anything (?:on fire|broken|pending|urgent)|what happened overnight|where (?:are we|do we stand) (?:on|with))\b/i },
    // Operations on our own systems ("what happened to the deploy on ANVIL") are fleet questions, not web news.
    { name: 'own operation', weight: 3, re: /\b(?:what happened (?:to|with|on|during)|status of|how did) (?:the |our |my |last night's |this morning's )?(?:deploy(?:ment)?|build|gate|tunnel|services?|nodes?|jobs?|runs?|backups?|sync|migration|restart|cutover|release|rollout|canary)\b/i },
    { name: 'personal', weight: 3, re: /\b(?:my (?:mom|mother|dad|father|wife|husband|son|daughter|kids?|children|family|friend|brother|sister|birthday|anniversary|health|doctor|therapist|medication|diagnosis|mortgage|rent|salary|paycheck|taxes|bank|savings|debt|budget|spending|schedule|calendar|appointment|feelings?|mood|sleep|diet|weight|workout))\b|\b(?:i(?:'m| am) (?:tired|exhausted|stressed|anxious|worried|sad|angry|frustrated|happy|excited|burnt out|overwhelmed|sick|unwell)|remind me|don'?t let me forget|i feel|i'm feeling|love you|miss you|proud of|how are you|good (?:morning|night|evening)|thank you|thanks echo|hey echo|(?:did|do|have) i spen[dt]|i spent|groceries|my (?:health )?appointment)\b/i },
    { name: 'conversation', weight: 1, re: /\b(?:what do you think|your opinion|tell me about yourself|who are you|can you|should i|let's talk|chat|advice|recommend|suggest|plan (?:my|our|the) (?:day|week|trip|evening)|brainstorm|idea)\b/i },
  ],
};

/** Deterministic rule scoring. Code fences are blanked before the word rules so fenced code does not trigger research/personal cues. */
export function classifyTask(prompt: unknown): TaskClassification {
  const text = typeof prompt === 'string' ? prompt : '';
  const fenced = CODE_FENCE.test(text); CODE_FENCE.lastIndex = 0;
  const scan = text.replace(CODE_FENCE, ' ```code``` ');
  const scores: Record<TaskClass, number> = { coding: 0, long_context: 0, research: 0, general: 0 };
  const reasons: string[] = [];
  for (const task of TASK_CLASSES) {
    for (const rule of RULES[task]) {
      const target = rule.name === 'code fence' ? text : scan;
      if (!rule.re.test(target)) continue;
      scores[task] += rule.weight; reasons.push(`${task}: ${rule.name}`);
    }
  }
  if (fenced) scores.coding += 1;
  // Very long input is long-context on its own, unless it is code (a pasted file belongs to coding).
  if (text.length > 6000) { scores.long_context += fenced || scores.coding >= 3 ? 0.5 : 3; reasons.push(`long_context: ${text.length} characters`); }
  // Echo-internal and personal cues win over web cues: "latest FORGE gate status" is a fleet question, not news.
  if (scores.general >= 3 && scores.research > 0 && !/\b(?:news|headlines?|stock|price|weather|election|release notes?)\b/i.test(scan)) { scores.research = Math.min(scores.research, scores.general - 1); }
  const order: TaskClass[] = ['general', 'coding', 'long_context', 'research']; // tie-break: the private local model wins ties
  let best: TaskClass = 'general';
  for (const task of order) if (scores[task] > scores[best]) best = task;
  const sorted = [...TASK_CLASSES].map(t => scores[t]).sort((a, b) => b - a);
  const top = sorted[0], second = sorted[1] ?? 0;
  const confidence = top <= 0 ? 0.35 : Math.min(1, Math.round(((top - second) / (top + 1) + (top >= 3 ? 0.35 : 0.15)) * 100) / 100);
  return { task: best, confidence, reasons: reasons.filter(r => r.startsWith(best)), scores };
}
