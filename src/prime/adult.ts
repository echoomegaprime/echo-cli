/**
 * Adult-brief policy for ECHO Prime's media paths (Commander order 2026-11-06: adult generation goes ONLY to the on-prem
 * TEMPER models through the media router, never to a cloud provider).
 *
 * What is adult: the request says so (`nsfw`, `adult`, `adult_brief`, `content_class: adult_*`, top level or inside
 * `options`), or the brief itself reads as an adult brief to the keyword classifier below. The classifier is deliberately
 * conservative in the safe direction: it fires on the router's own sexual-term list (plus a few more) so that nothing the
 * router would treat as adult is ever ranked onto a cloud tool. It does not depend on the UI. A false positive costs the
 * user one switch (Adult mode plus the attestation) and keeps the brief on-prem; a false negative would send an adult
 * brief to a cloud provider, which is the failure this module exists to prevent.
 *
 * What is refused locally, before any call, in this order: a minor-indicating term in an adult brief; a likeness or
 * real-person request in an adult brief; a cloud or other non-router tool for an adult brief; an adult brief without the
 * switch; an adult request without the attestation. The router stays the authority and refuses the same things again;
 * these checks are the belt to its braces and mirror `mediarouter/policy.py` and `policy_terms.json` (2026-11-06.1).
 * There is no name or NER detector here either: a real person is recognised by what the brief says about the subject
 * (a likeness, a deepfake, a celebrity, someone the user knows) and by a title-cased full name after a naming word. The
 * router's curated `named_persons` list is empty today, so Prime ships no list of names.
 *
 * `markers` is the test-only seam: literal strings that count as an adult brief. Production never supplies any.
 */
export const ROUTER_CAPS=/^echo\.media\.(?:image|video)_generate$/;
export const ROUTER_CAP_IDS=['echo.media.image_generate','echo.media.video_generate'] as const;
export const isRouterCap=(id:string):boolean=>ROUTER_CAPS.test(id);
export const ADULT_STYLES=['photoreal','anime'] as const;
export type AdultStyle=(typeof ADULT_STYLES)[number];
export const ADULT_NODE='temper';
export const ADULT_LINE='Adult mode: fictional adult characters only. Real people and anyone under 18 are refused.';
export const ATTEST_LABEL='All subjects are fictional adults';
export type AdultRefusalCode='minor'|'real_person'|'not_on_prem'|'needs_adult_mode'|'not_fictional';
export interface AdultDecision {adult:boolean;flagged:boolean;detected:boolean;refusal?:{code:AdultRefusalCode;message:string}}

// The router's sexual terms (policy_terms.json sexual_regex) plus a few common ones the router leaves to its flags.
const SEXUAL=/\b(?:nsfw|nude|naked|nudity|sex(?:ual|y)?|explicit|porn\w*|erotic\w*|nipples?|genital\w*|vagina|penis|cum|orgasm|topless|lingerie|fetish|hentai|bdsm|intercourse|masturbat\w*|xxx|smut|lewd|ecchi|bondage|striptease)\b/gi;
const NOT_SEXUAL=/\b(?:(?:summa|magna|maxima)\s+)?cum\s+laude\b/gi;
// The router's minor_regex (policy_terms.json) plus the usual spellings of "young" that regex leaves out.
const MINOR=/\b(?:loli(?:con)?|shota(?:con)?|child(?:ren)?|kids?|toddlers?|infants?|pre-?teens?|under-?age|minors?|school ?(?:girl|boy)s?|teen(?:ager)?s?|juvenile|jailbait|barely legal|(?:little|young|small) (?:girl|boy)s?|(?:[0-9]|1[0-7])[- ]?(?:year|yr)s?[- ]?old|aged? (?:[0-9]|1[0-7]))\b/i;
// The router's likeness_regex, widened to the people an adult brief most often means, and to "a real/famous person".
const LIKENESS=/\b(?:deep ?fakes?|face ?swap(?:ped|ping)?|faceswap\w*|look-?alikes?|likeness of|in the likeness|real (?:person|people|woman|man|girl|boy)|actual person|celebrit(?:y|ies)|famous|someone i know|(?:photos?|pictures?|images?) of my (?:ex\b|girlfriend|boyfriend|wife|husband|partner|coworker|co-worker|colleague|neighbou?r|classmate|teacher|boss|friend|sister|brother|cousin|crush)|my (?:ex|ex-girlfriend|ex-boyfriend|girlfriend|boyfriend|wife|husband|coworker|co-worker|colleague|neighbou?r|classmate|teacher|boss|crush)|(?:instagram|tiktok|onlyfans|facebook|snapchat)\b)|@\w{3,}/i;
// "of Firstname Lastname": a title-cased full name after a naming word reads as a named person (case-sensitive on purpose).
const NAMED=/\b(?:of|with|featuring|starring|resembling|named|called)\s+[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/;
const MAX_TEXT=50000;
const VISUAL=new Set(['image','image-edit','video']);

export const truthy=(v:unknown):boolean=>typeof v==='string'?['1','true','yes','on'].includes(v.trim().toLowerCase()):typeof v==='number'?v!==0:v===true;
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

/** Does this brief read as an adult brief? `signals` names what fired (never the brief itself). */
export function classifyAdult(text:string,options:{markers?:readonly string[]}={}):{adult:boolean;signals:string[]}{
 if(typeof text!=='string'||!text)return {adult:false,signals:[]};
 const body=text.slice(0,MAX_TEXT);
 if(options.markers?.some(m=>m&&body.includes(m)))return {adult:true,signals:['marker']};
 const hits=[...new Set([...body.replace(NOT_SEXUAL,' ').matchAll(SEXUAL)].map(m=>m[0].toLowerCase()))];
 return hits.length?{adult:true,signals:hits.slice(0,5).map(h=>'keyword:'+h)}:{adult:false,signals:[]};
}
/** The fields a request carries to be an adult request the router accepts, pinned to TEMPER. `style` is the user's choice. */
export function adultFields(style?:AdultStyle):Record<string,unknown>{
 return {nsfw:true,subjects_fictional:true,...(style?{style}:{}),node:ADULT_NODE};
}
/** The adult flag and the attestation a request carries, read the way the router reads them (top level and `options`). */
export function adultFlagsOf(args:unknown):{flagged:boolean;fictional:boolean}{
 const a=obj(args),o=obj(a.options),pick=(k:string)=>truthy(a[k])||truthy(o[k]);
 const cc=[a.content_class,o.content_class].some(v=>typeof v==='string'&&v.trim().toLowerCase().startsWith('adult'));
 return {flagged:pick('nsfw')||pick('adult')||pick('adult_brief')||cc,fictional:pick('subjects_fictional')||pick('fictional')};
}
/** The brief inside a request, wherever its shape keeps it. */
export function promptOfArguments(args:unknown):string{
 const a=obj(args),o=obj(a.options);
 for(const v of [a.prompt,a.text,o.prompt,o.text])if(typeof v==='string'&&v.trim())return v.trim();
 return '';
}
const refuse=(code:AdultRefusalCode,message:string)=>({code,message});
export const REFUSALS={
 minor:'Refused: this brief mentions someone under 18 or uses a minor-indicating term. Adult mode only covers fictional adults, and nothing was sent anywhere.',
 real_person:'Refused: this brief looks like it names or imitates a real person (a likeness, a deepfake, a celebrity, or someone you know). Real people are never generated, and nothing was sent anywhere.',
 needs_adult_mode:'Adult mode must be switched on and "'+ATTEST_LABEL+'" ticked before this brief can be sent anywhere. Nothing was sent.',
 not_fictional:'Tick "'+ATTEST_LABEL+'" before an adult request can be sent. Nothing was sent.',
} as const;
export const notOnPrem=(capability:string)=>'Adult briefs run only on the on-prem media router (TEMPER). '+capability+' is a cloud or other provider tool, so nothing was sent. Switch on Adult mode in the Creative Studio (and tick "'+ATTEST_LABEL+'") to use echo.media.image_generate or echo.media.video_generate.';

/**
 * The decision for one request. `flagged` is the request's own adult flag (Adult mode on), `fictional` its attestation,
 * `kind` the medium (the keyword classifier only decides for pictures: a voice or music script that happens to contain one
 * of the words is not an adult picture), `capability` the tool it is bound for (absent while routing).
 */
export function adultPolicy(input:{text:string;flagged?:boolean;fictional?:boolean;kind?:string;capability?:string;markers?:readonly string[]}):AdultDecision{
 const flagged=input.flagged===true,detected=(input.kind===undefined||VISUAL.has(input.kind))&&classifyAdult(input.text,{markers:input.markers}).adult;
 if(!flagged&&!detected)return {adult:false,flagged:false,detected:false};
 const base={adult:true,flagged,detected},text=typeof input.text==='string'?input.text.slice(0,MAX_TEXT):'';
 if(MINOR.test(text))return {...base,refusal:refuse('minor',REFUSALS.minor)};
 if(LIKENESS.test(text)||NAMED.test(text))return {...base,refusal:refuse('real_person',REFUSALS.real_person)};
 if(input.capability!==undefined&&!isRouterCap(input.capability))return {...base,refusal:refuse('not_on_prem',notOnPrem(input.capability))};
 if(!flagged)return {...base,refusal:refuse('needs_adult_mode',REFUSALS.needs_adult_mode)};
 if(input.fictional!==true)return {...base,refusal:refuse('not_fictional',REFUSALS.not_fictional)};
 return base;
}
