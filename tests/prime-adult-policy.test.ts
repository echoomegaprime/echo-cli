import {describe, expect, it} from 'vitest';
import {ADULT_LINE, ADULT_STYLES, adultFields, adultFlagsOf, adultPolicy, classifyAdult, isRouterCap, promptOfArguments, ROUTER_CAPS} from '../src/prime/adult.js';

// Fixtures never carry explicit text: ADULT_BRIEF_MARKER stands in for an adult brief through the test-only markers seam, and the
// few real keywords used here ("nsfw", "nude") are the mildest members of the classifier's own keyword set.
const markers=['ADULT_BRIEF_MARKER'];
const router='echo.media.image_generate';
const cloud='echo.llm.together.ByteDance-Seed-Seedream-4.0';

describe('adult classifier',()=>{
 it('reads an adult brief from the keyword set, and an ordinary brief as ordinary',()=>{
  expect(classifyAdult('nsfw portrait of an invented woman')).toMatchObject({adult:true,signals:['keyword:nsfw']});
  expect(classifyAdult('a nude figure study in charcoal').adult).toBe(true);
  for(const text of ['a red fox standing in a snowy pine forest at dawn','a product shot of a ceramic mug','magna cum laude diploma on a desk','the sextant on the deck of a ship','Essex coastline at low tide','children playing in a park'])
   expect(classifyAdult(text).adult,text).toBe(false);
 });
 it('matches whole words only and ignores case',()=>{
  expect(classifyAdult('NSFW').adult).toBe(true);
  expect(classifyAdult('unsafe wording is not a keyword').adult).toBe(false);
 });
 it('treats the test-only markers as adult only when the caller supplies them',()=>{
  expect(classifyAdult('ADULT_BRIEF_MARKER at the beach').adult).toBe(false);
  expect(classifyAdult('ADULT_BRIEF_MARKER at the beach',{markers})).toMatchObject({adult:true,signals:['marker']});
 });
 it('never throws on odd input',()=>{
  expect(classifyAdult('').adult).toBe(false);
  expect(classifyAdult(undefined as unknown as string).adult).toBe(false);
  expect(classifyAdult('x'.repeat(200000)).adult).toBe(false);
 });
});

describe('adult policy',()=>{
 const ok={flagged:true,fictional:true,markers};
 it('lets an ordinary brief through untouched, whatever the capability',()=>{
  expect(adultPolicy({text:'a red fox',capability:cloud})).toEqual({adult:false,flagged:false,detected:false});
  expect(adultPolicy({text:'children playing in a park',capability:cloud}).adult).toBe(false);
 });
 it('allows an attested adult brief only on the router capabilities',()=>{
  for(const capability of ['echo.media.image_generate','echo.media.video_generate'])
   expect(adultPolicy({text:'ADULT_BRIEF_MARKER a woman at the beach',capability,...ok})).toMatchObject({adult:true,flagged:true,detected:true});
  expect(adultPolicy({text:'ADULT_BRIEF_MARKER a woman at the beach',capability:cloud,...ok}).refusal).toMatchObject({code:'not_on_prem',message:expect.stringContaining('on-prem media router')});
 });
 it('says adult mode must be switched on when the classifier fires without the flag, and sends nothing',()=>{
  const d=adultPolicy({text:'ADULT_BRIEF_MARKER a woman at the beach',capability:router,markers});
  expect(d.refusal).toMatchObject({code:'needs_adult_mode'});
  expect(d.refusal!.message).toContain('Adult mode must be switched on');
  expect(d.refusal!.message).toContain('All subjects are fictional adults');
 });
 it('asks for the attestation when the flag is on without it',()=>{
  const d=adultPolicy({text:'a quiet beach',flagged:true,capability:router});
  expect(d.adult).toBe(true);
  expect(d.refusal).toMatchObject({code:'not_fictional'});
  expect(d.refusal!.message).toContain('All subjects are fictional adults');
 });
 it('refuses minors and likeness requests before it asks for anything else',()=>{
  expect(adultPolicy({text:'ADULT_BRIEF_MARKER a child at the beach',capability:router,markers}).refusal).toMatchObject({code:'minor'});
  expect(adultPolicy({text:'ADULT_BRIEF_MARKER a child at the beach',capability:cloud,...ok}).refusal).toMatchObject({code:'minor'});
  for(const text of ['ADULT_BRIEF_MARKER a 17 year old at the beach','ADULT_BRIEF_MARKER a schoolgirl','ADULT_BRIEF_MARKER a teenager','ADULT_BRIEF_MARKER a 12-year-old'])
   expect(adultPolicy({text,capability:router,...ok}).refusal?.code,text).toBe('minor');
  expect(adultPolicy({text:'ADULT_BRIEF_MARKER a 18 year old woman',capability:router,...ok}).refusal).toBeUndefined();
  for(const text of ['ADULT_BRIEF_MARKER a deepfake of someone','ADULT_BRIEF_MARKER face swap onto the figure','ADULT_BRIEF_MARKER photo of my ex','ADULT_BRIEF_MARKER a famous celebrity','ADULT_BRIEF_MARKER a real person I know','ADULT_BRIEF_MARKER in the likeness of an actress','ADULT_BRIEF_MARKER a photo of Zorblax Quimby'])
   expect(adultPolicy({text,capability:router,...ok}).refusal?.code,text).toBe('real_person');
  expect(adultPolicy({text:'ADULT_BRIEF_MARKER an invented elven queen in a Gothic cathedral',capability:router,...ok}).refusal).toBeUndefined();
 });
 it('reads the flag from nsfw, adult and an adult content class, top level or inside options',()=>{
  expect(adultFlagsOf({prompt:'x'})).toEqual({flagged:false,fictional:false});
  expect(adultFlagsOf({nsfw:true,subjects_fictional:true})).toEqual({flagged:true,fictional:true});
  expect(adultFlagsOf({adult:'true'})).toEqual({flagged:true,fictional:false});
  expect(adultFlagsOf({content_class:'adult_explicit'}).flagged).toBe(true);
  expect(adultFlagsOf({options:{nsfw:true,subjects_fictional:true}})).toEqual({flagged:true,fictional:true});
  expect(adultFlagsOf({nsfw:false,options:{adult:1}}).flagged).toBe(true);
 });
 it('finds the prompt wherever the request shape keeps it',()=>{
  expect(promptOfArguments({prompt:' a '})).toBe('a');
  expect(promptOfArguments({text:'b'})).toBe('b');
  expect(promptOfArguments({command:'x',options:{prompt:'c'}})).toBe('c');
  expect(promptOfArguments({})).toBe('');
 });
});

describe('adult request fields',()=>{
 it('are exactly what the router needs, pinned to TEMPER',()=>{
  expect(adultFields('anime')).toEqual({nsfw:true,subjects_fictional:true,style:'anime',node:'temper'});
  expect(adultFields()).toEqual({nsfw:true,subjects_fictional:true,node:'temper'});
  expect([...ADULT_STYLES]).toEqual(['photoreal','anime']);
 });
 it('name the two router capabilities and nothing else',()=>{
  expect(isRouterCap('echo.media.image_generate')).toBe(true);
  expect(isRouterCap('echo.media.video_generate')).toBe(true);
  for(const id of ['echo.media.job_status','echo.media.backends','echo.image.generate','echo.image.qwen.generate',cloud,'echo.media.image_generate.extra'])expect(isRouterCap(id),id).toBe(false);
  expect(ROUTER_CAPS.test('echo.media.video_generate')).toBe(true);
 });
 it('carry the copy the Studio shows',()=>{
  expect(ADULT_LINE).toBe('Adult mode: fictional adult characters only. Real people and anyone under 18 are refused.');
 });
});
