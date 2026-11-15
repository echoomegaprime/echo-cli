import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, ModelRouter, parseAgyModels } from '../src/code/model-factory.js';
import type { Runner, RunResult } from '../src/code/providers.js';

const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];
const final = (content = 'done') => JSON.stringify({ action: 'final', content });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const spawnFailed = () => Object.assign(new Error('ENOENT'), { spawnFailed: true });
function runner(handler: (cmd: string, args: string[]) => RunResult | Error) {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = async (cmd, args, o) => { calls.push({ cmd, args, env: o.env }); const r = handler(cmd, args); if (r instanceof Error) throw r; return r; };
  return { calls, run };
}
const AGY_LIST = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)', 'gemini-4-argon-high\tGemini 4 Argon (High)', 'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)', 'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)', 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');
const agyRunner = (list: RunResult | Error = ok(AGY_LIST), version: RunResult | Error = ok('agy 1.0')) =>
  runner((cmd, args) => cmd !== 'agy' ? ok() : args[0] === 'models' ? list : args[0] === '--version' ? version : ok(JSON.stringify({ status: 'SUCCESS', response: final('from agy') })));
const argonRow = async (r: ReturnType<typeof runner>) => (await new ModelRouter(DEFAULT_MODELS, { runner: r.run, now: () => 1 }).report()).providers.find(p => p.id === 'argon')!;

describe('parseAgyModels', () => {
  it('keeps only gemini ids, takes labels from agy and ignores progress noise, duplicates and unsafe ids', () => {
    expect(parseAgyModels(AGY_LIST).map(v => v.id)).toEqual(['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']);
    expect(parseAgyModels(AGY_LIST)[0]).toEqual({ id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' });
    expect(parseAgyModels('gemini-a\tA\ngemini-a\tA again\ngemini-b')).toEqual([{ id: 'gemini-a', label: 'A' }, { id: 'gemini-b', label: 'gemini-b' }]);
    expect(parseAgyModels('Gemini-Up\tx\ngemini-x; rm -rf\ty\n gemini-ok \tOK\u0007\n--model\tz\ngemini-\t')).toEqual([{ id: 'gemini-ok', label: 'OK' }]);
    expect(parseAgyModels('gemini-x\t' + 'L'.repeat(500))[0].label).toHaveLength(80);
    expect(parseAgyModels(Array.from({ length: 80 }, (_, i) => `gemini-m${i}\tM`).join('\n'))).toHaveLength(32);
  });
});

describe('Argon (Gemini) variant discovery', () => {
  it('lists the Gemini variants through the same minimal-env runner and never exposes claude/gpt ids or raw output', async () => {
    process.env.FAKE_API_TOKEN = 'must-not-pass';
    const r = agyRunner();
    let row;
    try { row = await argonRow(r); } finally { delete process.env.FAKE_API_TOKEN; }
    expect(row.available).toBe(true);
    expect(row.variants).toHaveLength(6); expect(row.variants![0]).toEqual({ id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' });
    expect(row.variantsReason).toBeUndefined();
    expect(JSON.stringify(row)).not.toMatch(/claude-|gpt-oss|Fetching/);
    expect(r.calls.find(c => c.cmd === 'agy' && c.args[0] === 'models')!.args).toEqual(['models']);
    expect(r.calls.every(c => !Object.keys(c.env).some(k => /KEY|TOKEN|SECRET/i.test(k)))).toBe(true);
  });
  it('other providers carry no variants', async () => {
    const report = await new ModelRouter(DEFAULT_MODELS, { runner: agyRunner().run }).report();
    for (const p of report.providers.filter(p => p.id !== 'argon')) { expect(p.variants).toBeUndefined(); expect(p.variantsReason).toBeUndefined(); }
  });
  it.each([
    ['exits non-zero', { code: 3, stdout: 'gemini-4-argon-low\tx', stderr: 'e', timedOut: false }, /exited with code 3/],
    ['times out', { code: null, stdout: '', stderr: '', timedOut: true }, /timed out/],
    ['lists no Gemini id', ok('Fetching...\nclaude-opus-5-5-low\tC'), /no Gemini/i],
    ['cannot be started', spawnFailed(), /could not (run|start)/],
  ])('reports variants: [] with a reason and invents nothing when listing %s', async (_name, list, reason) => {
    const row = await argonRow(agyRunner(list as RunResult | Error));
    expect(row.variants).toEqual([]); expect(row.variantsReason).toMatch(reason);
    expect(row.available).toBe(true);
  });
  it('does not list when agy itself is unavailable', async () => {
    const r = agyRunner(ok(AGY_LIST), spawnFailed());
    const row = await argonRow(r);
    expect(row).toMatchObject({ available: false, variants: [] }); expect(row.variantsReason).toMatch(/not available/i);
    expect(r.calls.some(c => c.args[0] === 'models')).toBe(false);
  });
  it('turn() passes a discovered variant to agy and reports it as requested; the model is never claimed as reported', async () => {
    const r = agyRunner(), router = new ModelRouter(DEFAULT_MODELS, { runner: r.run });
    const id = await router.variant('argon', 'gemini-3.8-flash-high');
    expect(id).toBe('gemini-3.8-flash-high');
    const turn = router.turn('argon', id);
    expect(await turn.model.next(messages)).toEqual({ action: 'final', content: 'from agy' });
    expect(turn.answered()).toMatchObject({ id: 'argon', requested: 'gemini-3.8-flash-high', model: null, reported: false, answered: true });
    expect(r.calls.find(c => c.args.includes('--output-format'))!.args).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash-high', '--mode', 'plan']));
    expect(router.sessionModel('argon', id)).toBe('argon:gemini-3.8-flash-high');
    expect(router.sessionModel('argon')).toBe('argon');
  });
  it('without a variant it keeps the default Argon model; two variants never share an instance', async () => {
    const r = agyRunner(), router = new ModelRouter(DEFAULT_MODELS, { runner: r.run });
    await router.turn('argon').model.next(messages);
    await router.turn('argon', 'gemini-4-argon-high').model.next(messages);
    await router.turn('argon').model.next(messages);
    const used = r.calls.filter(c => c.args.includes('--output-format')).map(c => c.args[c.args.indexOf('--model') + 1]);
    expect(used).toEqual(['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-medium']);
  });
  it('rejects an unknown variant with the available ids and never defaults', async () => {
    const r = agyRunner(), router = new ModelRouter(DEFAULT_MODELS, { runner: r.run });
    await expect(router.variant('argon', 'gemini-9-nope')).rejects.toThrow(/Unknown Argon model "gemini-9-nope".*gemini-4-argon-medium/);
    await expect(router.variant('argon', 'claude-opus-5-5-low')).rejects.toThrow(/Unknown Argon model/);
    await expect(router.variant('argon', 'gemini-4-argon-high; rm')).rejects.toThrow(/Invalid Argon model/);
    await expect(router.variant('claude' as never, 'gemini-4-argon-high')).rejects.toThrow(/only for Argon/i);
    expect(r.calls.some(c => c.args.includes('--output-format'))).toBe(false);
  });
  it('rejects a variant it cannot verify (listing failed) instead of falling back to the default', async () => {
    const router = new ModelRouter(DEFAULT_MODELS, { runner: agyRunner({ code: 1, stdout: '', stderr: '', timedOut: false }).run });
    await expect(router.variant('argon', 'gemini-4-argon-high')).rejects.toThrow(/cannot be verified.*exited with code 1.*no default/i);
  });
  it('turn() refuses a variant on a provider that has none', () => {
    const router = new ModelRouter(DEFAULT_MODELS, { runner: agyRunner().run });
    expect(() => router.turn('claude', 'gemini-4-argon-high')).toThrow(/only for Argon/i);
  });
});
