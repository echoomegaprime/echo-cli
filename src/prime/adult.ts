/**
 * Adult-brief policy for ECHO Prime's media paths (Commander order 2026-11-06: adult generation goes ONLY to the on-prem
 * TEMPER models through the media router, never to a cloud provider).
 *
 * What is adult: the request says so (`nsfw`, `adult`, `adult_brief`, `content_class: adult_*`, top level or inside
 * `options`), or the brief itself reads as an adult brief to the keyword classifier below. The classifier is deliberately
 * conservative in the safe direction: it fires on the router's own sexual-term list plus the common nouns, verbs and
 * inflections around it (stems such as "sexually", "nudes" and "cumming" are listed form by form, because a bare `sex\w*`
 * would also fire on "sextant" and `cum\w*` on "cumulus"), so that nothing the router would treat as adult is ever ranked
 * onto a cloud tool. It does not depend on the UI. A false positive costs the user one switch (Adult mode plus the
 * attestation) and keeps the brief on-prem; a false negative would send an adult brief to a cloud provider, which is the
 * failure this module exists to prevent. It is a term classifier, not a mood detector: "suggestive" or "bikini" alone are
 * not adult briefs.
 *
 * What is refused locally, before any call, in this order: a minor-indicating term in an adult brief; a real-person cue in
 * an adult brief (likeness words, people the user knows, any two adjacent Capitalised words, a short reviewed deny-list of
 * public figures); an audio brief (no on-prem audio tool exists); a cloud or other non-router tool; an adult brief without
 * the switch; an adult request without the attestation. The router stays the authority and refuses the same things again;
 * these checks are the belt to its braces and are wider than `mediarouter/policy_terms.json` (2026-11-06.1), whose regexes
 * miss "teenage", "underaged", spelled-out ages and every name that is not preceded by a naming word.
 *
 * Which tools are checked: every capability that makes media (the ranking table, the catalog category, or an
 * image/video/voice/music id) and every other capability unless it is on a short read-only list (search, list, status,
 * voices, backends...). The arguments are scanned wherever the brief sits (`prompt`, `input.prompt`, `items[].text`...)
 * except a negative prompt, which names what to avoid, and model/backend/sampler identifiers, which the router looks up by name.
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
export type AdultRefusalCode='minor'|'real_person'|'not_on_prem'|'no_on_prem_tool'|'needs_adult_mode'|'not_fictional';
export interface AdultDecision {adult:boolean;flagged:boolean;detected:boolean;refusal?:{code:AdultRefusalCode;message:string}}

// Sexual terms. A stem that would also fire on a harmless word ("sextant", "nudge", "cumulus", "cumin") is listed form by form.
const SEXUAL_TERMS=[
 'nsfw','nud(?:e[sd]?|ity|ists?|ism)','naked\\w*','sex(?:ual\\w*|y|ier|iest|ily|ting|ts?|less|pot|bomb|kitten|tape)?','explicit','porn\\w*','erotic\\w*',
 'nipples?','areola\\w*','genital\\w*','vagina\\w*','vulva\\w*','labia','clitor\\w*','penis(?:es)?','phall(?:us|ic)','testicles?','scrotum','anus','pubic','semen','ejaculat\\w*','erection','boner',
 'cum(?:s|ming|shots?)?','orgasm\\w*','orgy|orgies','threesomes?|foursomes?|gangbang\\w*|bukkake','blowjobs?|handjobs?|rimjobs?','anal','creampies?','dildos?|vibrators?',
 'fuck\\w*','pussy|pussies','cocks?','dicks?','tits|titties','boobs?|boobies','breasts','busty','bare-?breasted','sluts?|slutty','whor(?:e|es|ish)','horny','milfs?','kink(?:y|s)?',
 'fetish\\w*','bdsm','bondage','dominatrix','topless','lingerie','thong','g-?strings?','panties','upskirt','undress\\w*','unclothed','unclad','disrobed|disrobing','strippers?|striptease','strip clubs?','playboy',
 'intercourse','masturbat\\w*','hentai','ecchi','lewd','smut','xxx','x-?rated','rule ?34','r-?18','onlyfans','incest\\w*','rap(?:e|ed|es|ing|ist)','bestiality|zoophil\\w*','molest\\w*',
];
const SEXUAL=new RegExp('\\b(?:'+SEXUAL_TERMS.join('|')+')\\b','gi');
// Neutral contexts of the words above, removed before matching: a diploma, a novel, a roast dinner, a bird.
const NOT_SEXUAL=/\b(?:(?:(?:summa|magna|maxima)\s+)?cum\s+laude|(?:chicken|turkey|duck|goose|poultry|quail|pheasant|pigeon)\s+breasts|moby[- ]dick|dick\s+(?:tracy|cheney|van dyke|whittington)|(?:blue|great|coal|marsh|willow|crested|long-tailed|bearded)\s+tits|cock[- ]?a[- ]?doodle[- ]?doo|cock(?:'s)?[- ]?crow\w*)\b/gi;
/** One example of every term family above, inflections included. A test walks this list, so a family cannot lose its pattern
 * unnoticed; it is also the quickest way to see what the classifier reads as adult. */
export const ADULT_TERM_EXAMPLES:readonly string[]=[
 'nsfw','nude','nudes','nudity','nudist','naked','sexual','sexually','sexuality','sexy','sexier','sexting','sexless','explicit','porn','pornography','erotic','erotica',
 'nipples','areola','genitals','vagina','vulva','clitoris','penis','phallic','testicles','pubic','semen','ejaculation','erection','orgasm','orgy','threesome','gangbang',
 'blowjob','handjob','anal','creampie','dildo','vibrator','fuck','fucking','pussy','cock','dick','tits','boobs','breasts','busty','slut','whore','horny','milf','kinky',
 'fetish','bdsm','bondage','dominatrix','topless','lingerie','thong','g-string','panties','upskirt','undressed','unclothed','stripper','intercourse','masturbating',
 'hentai','ecchi','lewd','smut','xxx','x-rated','rule 34','r18','onlyfans','incest','rape','bestiality','molested','cum','cumming','cumshot','strip club','playboy',
];
// Minor-indicating terms: the router's minor_regex plus the spellings it leaves out (teenage, underaged, tween, schools, ages in words).
const NUM_WORD='(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)';
const MINOR_TERMS=[
 'loli(?:con|ta)?','shota(?:con)?','child\\w*','kids?','kiddo','toddlers?','infants?','babies','baby[- ]?(?:girl|boy)s?','babysit\\w*','newborns?','pre-?teen\\w*','pre-?pubescent','pubescent','puberty','teen\\w*','tweens?','adolescen\\w*',
 'juveniles?','jailbait','barely legal','youngsters?','under-?aged?','minors?','school ?(?:girl|boy|child|children|kid)s?','schoolchild\\w*','(?:little|young|small|tiny) (?:girl|boy)s?','(?:young|youthful|child|kid|baby)[- ]?(?:looking|faced?)',
 'high ?school\\w*','middle ?school\\w*','junior ?high','elementary','grade ?school\\w*','primary school','kindergarten\\w*','pre-?school\\w*','nursery school','school ?uniforms?',
 'daughters?','step-?daughters?','nieces?','nephews?','pedo\\w*','paedo\\w*','(?:under|below) (?:the age of )?(?:18|eighteen)','younger than (?:18|eighteen)',
];
const MINOR_WORDS=new RegExp('\\b(?:'+MINOR_TERMS.join('|')+')\\b','i');
const MINOR_AGES=[
 /(?<![\w.])(?:[0-9]|1[0-7])[- ]?(?:years?|yrs?)[- ]?old(?!\w)/i,
 /(?<![\w.])(?:[0-9]|1[0-7])[- ]?(?:yo|y\/o|y\.o\.?)(?!\w)/i,
 new RegExp('\\b'+NUM_WORD+'[- ]?(?:years?|yrs?)[- ]?old\\b','i'),
 new RegExp('\\b(?:aged?|ages?) (?:of )?(?:[0-9]|1[0-7]|'+NUM_WORD+')\\b','i'),
 new RegExp('\\b(?:girl|boy|child|kid)s? (?:of|aged?) (?:[0-9]|1[0-7]|'+NUM_WORD+')\\b','i'),
 new RegExp('\\b(?:looks?|looking|appears?|seems?)\\s+(?:like\\s+)?(?:about\\s+|around\\s+|only\\s+)?(?:[0-9]|1[0-7]|'+NUM_WORD+')\\b','i'),
];
const hasMinor=(text:string):boolean=>MINOR_WORDS.test(text)||MINOR_AGES.some(rx=>rx.test(text));
// Real-person cues: the router's likeness_regex widened to resemblance words, people the user knows, self-portraits and social networks.
// Family nouns are refused bare (a real relative, and an incest cue besides); acquaintances only when the brief says they are somebody the user
// knows ("my teacher", "her boss"), because "a sexy teacher" or "two friends on a beach" is an invented character, not a person.
const FAMILY='(?:sisters?|brothers?|siblings?|mom|mum|mother|mama|dad|father|papa|aunt|auntie|uncle|cousin|grand(?:ma|mother|pa|father)|step-?(?:mom|dad|mother|father|sister|brother))';
const ACQUAINTANCE='(?:(?:my|our|your|his|her|their)\\s+(?:own\\s+)?(?:ex|ex-?(?:girlfriend|boyfriend|wife|husband)|wife|husband|girlfriend|boyfriend|fianc[eé]e?|neighbou?rs?|co-?workers?|colleagues?|classmates?|teachers?|boss|roommates?|friends?|crush))';
const LIKENESS=new RegExp('\\b(?:deep ?fakes?|face ?swap\\w*|faceswap\\w*|look-?alikes?|look(?:s|ed|ing)? like|resembl\\w*|likeness|face of|(?:same|identical) face|modell?ed (?:on|after)|based on (?:a |an )?(?:real|actual)|real (?:person|people|woman|man|girl|boy)|actual person|celebrit(?:y|ies)|famous|someone i know|myself|selfie\\w*|(?:photos?|pictures?|images?|portraits?) of (?:me|him|her|them|us)|'+FAMILY+'|'+ACQUAINTANCE+'|instagram|tiktok|onlyfans|facebook|snapchat|twitter|youtube)\\b|@\\w{3,}|https?:\\/\\/','i');
// Two adjacent Capitalised words on one line read as a full name (case-sensitive on purpose; spaces and tabs only, because the fields of a
// request are joined by newlines and "Paris" + "Illustrious" in two fields is not a name). Two-letter words (An, In) do not count.
const NAMED=/\b[A-Z][a-z]{2,}[ \t]+[A-Z][a-z]{2,}\b/;
/** A short reviewed deny-list of public figures, matched in any case. It is a seed, not a census: the Capitalised-pair rule and
 * the likeness words do the general work, and an operator extends this list when a name must be refused in lower case or as
 * one word (the router's own `named_persons` list is empty today). */
export const DENIED_NAMES:readonly string[]=[
 'zendaya','beyonce','rihanna','shakira','oprah','eminem','kardashian','kylie jenner','kendall jenner','emma watson','emma stone','scarlett johansson','margot robbie','gal gadot','sydney sweeney',
 'anya taylor-joy','jennifer lawrence','jennifer aniston','taylor swift','ariana grande','billie eilish','dua lipa','selena gomez','olivia rodrigo','megan fox','lady gaga','katy perry','miley cyrus',
 'britney spears','angelina jolie','natalie portman','keira knightley','ana de armas','florence pugh','elon musk','donald trump','joe biden','barack obama','michelle obama','vladimir putin',
 'kamala harris','hillary clinton','jeff bezos','mark zuckerberg','elon','aoc','ocasio-cortez','trump','biden','obama','putin','zelensky','bezos','zuckerberg',
];
const DENIED=new RegExp('\\b(?:'+DENIED_NAMES.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/ /g,'\\s+')).join('|')+')\\b','i');
const MAX_TEXT=50000;
const AUDIO=new Set(['voice','music','sfx']);
const AUDIO_LABEL:Record<string,string>={voice:'voice',music:'music',sfx:'sound-effect'};

export const truthy=(v:unknown):boolean=>typeof v==='string'?['1','true','yes','on'].includes(v.trim().toLowerCase()):typeof v==='number'?v!==0:v===true;
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

/** Does this brief read as an adult brief? `signals` names what fired (never the brief itself). */
export function classifyAdult(text:string,options:{markers?:readonly string[]}={}):{adult:boolean;signals:string[]}{
 if(typeof text!=='string'||!text)return {adult:false,signals:[]};
 const body=text.slice(0,MAX_TEXT).normalize('NFD').replace(/\p{M}/gu,'');
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
/** The brief inside a request, wherever its common shapes keep it (the job title and provenance use this one). */
export function promptOfArguments(args:unknown):string{
 const a=obj(args),o=obj(a.options);
 for(const v of [a.prompt,a.text,o.prompt,o.text])if(typeof v==='string'&&v.trim())return v.trim();
 return '';
}
// Not read as the brief: a negative prompt names what the picture must NOT show ("nsfw, nude, lowres" is what a safe prompt carries), and
// the model, backend, sampler and similar identifiers are looked up by name by the router (an unknown one is a 404), so a Capitalised
// "Euler Ancestral" or "Illustrious" there is never a person's name and never a brief.
const SKIPPED_KEYS=new Set(['negativeprompt','negativeprompts','negprompt','negative','model','modelid','node','backend','sampler','scheduler','checkpoint','lora','vae','workflow']);
/** Every string in a request, at any depth and in any field (`input.prompt`, `items[].text`, `brief`...), joined by newlines and
 * bounded in size, so a brief cannot hide in a field the gate did not know to read. Negative prompts are skipped. */
export function textOfArguments(args:unknown,maxChars=MAX_TEXT):string{
 const parts:string[]=[],stack:unknown[]=[args];
 let chars=0,nodes=0;
 while(stack.length&&nodes<20000&&chars<maxChars){
  const v=stack.pop();nodes++;
  if(typeof v==='string'){const t=v.trim();if(t){parts.push(t.slice(0,maxChars-chars));chars+=Math.min(t.length,maxChars-chars)+1;}}
  else if(Array.isArray(v)){for(let i=v.length-1;i>=0;i--)stack.push(v[i]);}
  else if(v&&typeof v==='object'){const e=Object.entries(v as Record<string,unknown>);for(let i=e.length-1;i>=0;i--)if(!SKIPPED_KEYS.has(e[i][0].toLowerCase().replace(/[^a-z]/g,'')))stack.push(e[i][1]);}
 }
 return parts.join('\n').slice(0,maxChars);
}

export type AdultKind='image'|'image-edit'|'video'|'music'|'sfx'|'voice'|'other'|'unlisted';
// Capabilities that only read or look something up take no brief. Everything else is checked.
const READ_ONLY=/(?:^|[._-])(?:search|list|lists|status|detail|details|info|get|read|health|schema|describe|voices|personas|backends|job_status|artifacts?|exports|history|stt|transcribe|speech_to_text|retrieve|poll|ping|whoami|stats|metrics|manifest)(?=$|[._-])/i;
/** Does this id look like a read-only tool (search, list, status, voices, backends...)? Such a tool takes no brief. */
export const isReadOnlyCapability=(id:string):boolean=>READ_ONLY.test(id);
const CATEGORY_KIND:Record<string,AdultKind>={image:'image',video:'video',voice:'voice',audio:'voice',music:'music',sound:'sfx'};
const ID_KIND:[AdultKind,RegExp][]=[
 ['video',/(?:^|[._-])(?:video|sora|veo|kling|t2v|i2v|r2v)(?=$|[._-])/i],['music',/(?:^|[._-])(?:music|song)(?=$|[._-])/i],['sfx',/(?:^|[._-])(?:sfx|sound)(?=$|[._-])/i],
 ['voice',/(?:^|[._-])(?:tts|speech|speak|voice|audio)(?=$|[._-])/i],['image',/(?:^|[._-])(?:image|img|imagen|flux|seedream|diffusion|txt2img|text2img|photo|picture|avatar)(?=$|[._-])/i],
];
/** What the adult gate treats a capability as. `described` is the media kind the ranking table or the id hints give it (or
 * 'other'); the catalog `category` and the id catch the generators the table does not know ("echo.ai.sdk.together.image").
 * 'other' = read-only, never checked; 'unlisted' = anything else, which is checked like a picture tool. */
export function adultKindOf(id:string,described:string,category?:string):AdultKind{
 if(described&&described!=='other'&&described!=='chat')return described as AdultKind;
 if(READ_ONLY.test(id))return 'other';
 const byCategory=CATEGORY_KIND[String(category??'').toLowerCase()];
 if(byCategory)return byCategory;
 return ID_KIND.find(([,rx])=>rx.test(id))?.[0]??'unlisted';
}
/** True for the media router's own policy and busy answers (a 400/404/409 or "busy, try again"): they say nothing about whether
 * the tool works, so they are not recorded against it. An out-of-memory or execution error is not one of them. */
const ROUTER_POLICY=/\b(?:busy, try again|try again in ~?\d+\s?s|refused:|must declare|subjects_fictional|real identifiable|no live (?:nsfw-capable |on-prem )|no available \w+ backend|not auto-routed|larger than its canary|re-canary|canary=true|operator-only|does not support image->video|accepts only images generated|unknown model|prompt required)/i;
export const isRouterPolicyRefusal=(text:string):boolean=>typeof text==='string'&&ROUTER_POLICY.test(text);

const refuse=(code:AdultRefusalCode,message:string)=>({code,message});
export const REFUSALS={
 minor:'Refused: this brief mentions someone under 18 or uses a minor-indicating term. Adult mode only covers fictional adults, and nothing was sent anywhere.',
 real_person:'Refused: this brief looks like it names or imitates a real person (a likeness, a deepfake, a celebrity, a full name, or someone you know). Real people are never generated, and nothing was sent anywhere. Describe an invented character instead.',
 needs_adult_mode:'Adult mode must be switched on and "'+ATTEST_LABEL+'" ticked before this brief can be sent anywhere. Nothing was sent.',
 not_fictional:'Tick "'+ATTEST_LABEL+'" before an adult request can be sent. Nothing was sent.',
} as const;
export const notOnPrem=(capability:string)=>'Adult briefs run only on the on-prem media router (TEMPER). '+capability+' is a cloud or other provider tool, so nothing was sent. Switch on Adult mode in the Creative Studio (and tick "'+ATTEST_LABEL+'") to use echo.media.image_generate or echo.media.video_generate.';
export const noOnPremTool=(kind:string,capability?:string)=>'Adult briefs run only on the on-prem media router (TEMPER), which makes images and video. There is no on-prem audio tool ('+(AUDIO_LABEL[kind]??kind)+'), so '+(capability?capability+' was not called and ':'')+'nothing was sent to any provider.';
export const VIDEO_AGENT_ADULT='The video agent builds on cloud providers (video and voice-over), so an adult brief cannot go through it. Nothing was planned or created. Use the Creative Studio with Adult mode (on-prem TEMPER only) for adult video.';

/**
 * The decision for one request. `flagged` is the request's own adult flag (Adult mode on), `fictional` its attestation,
 * `kind` the medium or 'other' for a read-only tool (the keyword classifier decides for everything except 'other': an adult
 * script read aloud by a cloud voice is as much an adult brief as a picture), `capability` the tool it is bound for (absent
 * while routing).
 */
export function adultPolicy(input:{text:string;flagged?:boolean;fictional?:boolean;kind?:string;capability?:string;markers?:readonly string[]}):AdultDecision{
 const flagged=input.flagged===true,detected=input.kind!=='other'&&classifyAdult(input.text,{markers:input.markers}).adult;
 if(!flagged&&!detected)return {adult:false,flagged:false,detected:false};
 // Accents are folded away so "Beyoncé" meets the deny-list and an accented spelling is not a way round the checks below.
 const base={adult:true,flagged,detected},text=typeof input.text==='string'?input.text.slice(0,MAX_TEXT).normalize('NFD').replace(/\p{M}/gu,''):'';
 if(hasMinor(text))return {...base,refusal:refuse('minor',REFUSALS.minor)};
 if(LIKENESS.test(text)||NAMED.test(text)||DENIED.test(text))return {...base,refusal:refuse('real_person',REFUSALS.real_person)};
 if(input.kind!==undefined&&AUDIO.has(input.kind))return {...base,refusal:refuse('no_on_prem_tool',noOnPremTool(input.kind,input.capability))};
 if(input.capability!==undefined&&!isRouterCap(input.capability))return {...base,refusal:refuse('not_on_prem',notOnPrem(input.capability))};
 if(!flagged)return {...base,refusal:refuse('needs_adult_mode',REFUSALS.needs_adult_mode)};
 if(input.fictional!==true)return {...base,refusal:refuse('not_fictional',REFUSALS.not_fictional)};
 return base;
}
