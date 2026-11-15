import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { detectRefusal } from '../src/code/refusal.js';
import { CliModel, ProviderDeclinedError, ProviderUnavailableError, type Runner, type RunResult } from '../src/code/providers.js';
import { DEFAULT_MODELS, ModelRouter, parseModelsConfig } from '../src/code/model-factory.js';
import { SharedChat } from '../src/prime/chat.js';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';

// Corpus drafted by GPT (codex, `wrap.sh draft gpt`, 2026-11-04), reviewed by hand: 30 declines, 30 hard negatives.
const corpus = JSON.parse(readFileSync(new URL('./fixtures/refusal-corpus.json', import.meta.url), 'utf8')) as { text: string; refused: boolean; note: string }[];
const REFUSAL = "I'm sorry, but I can't help with that request. It goes against my guidelines.";
const final = (content: string) => JSON.stringify({ action: 'final', content });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const claudeJson = (text: string, model = 'claude-sonnet-5-5') => JSON.stringify({ is_error: false, result: text, modelUsage: { [model]: { outputTokens: 5 } } });
const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];

describe('refusal detector: corpus metrics', () => {
  it('reaches precision 1.0 and recall >= 0.95 on the drafted corpus', () => {
    let tp = 0, fp = 0, fn = 0;
    const misses: string[] = [];
    for (const row of corpus) {
      const d = detectRefusal(row.text);
      if (d.refused && row.refused) tp++;
      else if (d.refused && !row.refused) { fp++; misses.push(`FP ${row.note}`); }
      else if (!d.refused && row.refused) { fn++; misses.push(`FN ${row.note}`); }
    }
    expect(corpus).toHaveLength(60);
    expect(corpus.filter(r => r.refused)).toHaveLength(30);
    expect({ fp, misses }).toEqual({ fp: 0, misses: misses.filter(m => m.startsWith('FN')) });
    expect(tp / (tp + fp)).toBe(1);
    expect(tp / (tp + fn)).toBeGreaterThanOrEqual(0.95);
  });
  it('returns a confidence and the matched pattern names, never the text', () => {
    const d = detectRefusal(REFUSAL);
    expect(d.refused).toBe(true); expect(d.confidence).toBeGreaterThanOrEqual(0.6); expect(d.confidence).toBeLessThanOrEqual(1);
    expect(d.matched).toEqual(expect.arrayContaining(['cant-help', 'against-guidelines', 'sorry-but']));
    expect(JSON.stringify(d)).not.toContain('request');
    expect(detectRefusal(undefined)).toEqual({ refused: false, confidence: 0, matched: [] });
    expect(detectRefusal('   ')).toEqual({ refused: false, confidence: 0, matched: [] });
  });
});

describe('refusal detector: adversarial cases', () => {
  it.each([
    ["I can't help with that.", 'near-empty Claude-style decline'],
    ["I'm sorry, but I can't assist with that request.", 'GPT-style decline'],
    ["I won't be able to help with this one. It violates our usage policy.", 'Grok-style policy decline'],
    ["I'm unable to provide that information. As an AI, I have to follow safety guidelines, so I'd recommend consulting a licensed professional instead.", 'Gemini-style redirect'],
    ['I must decline this request. Instead, I can help you draft a project plan.', 'decline with unrelated alternative'],
    ["I'm not comfortable writing that. Let me know if there's something else I can do.", 'soft decline'],
  ])('declines: %s (%s)', text => { expect(detectRefusal(text).refused).toBe(true); });
  it.each([
    ["I don't know the current value of that counter and could not verify it from the tools available; the last tool result said unknown.", 'truthful unknown is not a refusal'],
    ['The health tool returned unknown for the FORGE gate; nothing else was checked this turn.', 'reporting a tool unknown'],
    ['```ts\n// I can\'t help but notice this branch is unreachable\nif (x) { return 1; }\n```\nThe guard above never fires because x is always false.', 'refusal phrase inside code'],
    ['Using tabs here is against the guidelines in CONTRIBUTING.md, which asks for two spaces; replace the leading tabs and the linter passes.', 'style-guide guidelines'],
    ['A typical refusal looks like "I can\'t help with that request" and the detector matches it with the cant-help pattern; here is how the scoring works: strong matches add 0.65 each.', 'quoted refusal in an explanation'],
    ["I can't verify the exact version from here, but the lockfile pins vitest 4.1.12 and the config enables globals; run `npx vitest run` to confirm.", 'caveat followed by an answer'],
    ['info.txt contains calibration=714. The value is read on startup by load() and cached for the session.', 'ordinary technical answer'],
  ])('does not flag: %s (%s)', text => { expect(detectRefusal(text).refused).toBe(false); });
  it('a long substantive answer with a trailing disclaimer is not a refusal', () => {
    const body = 'The build reads tsconfig.json, resolves every import under src/, emits dist/ with declaration maps, and copies ui/ unchanged. '.repeat(12);
    expect(detectRefusal(body + "I can't guarantee this covers every edge case, so run the suite after changing the config.").refused).toBe(false);
  });
});

describe('CliModel: a prose decline is a ProviderDeclinedError, not an outage and not garbage', () => {
  const runner = (stdout: string): Runner => async () => ok(stdout);
  it('throws ProviderDeclinedError with the detection and without the refusal text', async () => {
    const error = await new CliModel('claude', { runner: runner(claudeJson(REFUSAL)) }).next(messages).catch(e => e as Error);
    expect(error).toBeInstanceOf(ProviderDeclinedError);
    expect((error as ProviderDeclinedError).provider).toBe('claude');
    expect((error as ProviderDeclinedError).detection.refused).toBe(true);
    expect(error.message).toMatch(/Claude .*declined the request.*confidence/);
    expect(error.message).not.toContain('goes against my guidelines');
  });
  it('keeps unreadable prose as the generic invalid-action error and an is_error reply as unavailable', async () => {
    await expect(new CliModel('claude', { runner: runner(claudeJson('Sure, here is a long answer with no JSON in it at all.')) }).next(messages)).rejects.toThrow(/invalid action/i);
    const error = await new CliModel('claude', { runner: runner(JSON.stringify({ is_error: true, result: 'rate limited' })) }).next(messages).catch(e => e as Error);
    expect(error).toBeInstanceOf(ProviderUnavailableError); expect(error).not.toBeInstanceOf(ProviderDeclinedError);
  });
});

// ---- Owner request: a vendor decline ends answered by Qwen, labelled, with no refusal text reaching the owner ----
const servers: Server[] = [], cleanups: string[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r()));
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});
async function ollama(reply = 'Qwen answered the owner: calibration is 714.') {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: DEFAULT_MODELS.model }] })); return; }
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({ done: true, model: DEFAULT_MODELS.model, message: { content: final(reply) } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prime-refusal-')), state = mkdtempSync(join(tmpdir(), 'prime-refusal-state-'));
  cleanups.push(root, state);
  writeFileSync(join(root, 'info.txt'), 'calibration=714\n');
  return { root, workspace: new Workspace(root, [state]), store: new SessionStore(state) };
}
async function chat(run: Runner, auto?: Record<string, unknown>) {
  const f = fixture(), fake = await ollama();
  const router = new ModelRouter(parseModelsConfig({ endpoint: fake.url, ...(auto ? { auto } : {}) }), { runner: run });
  return { ...f, fake, router, chat: new SharedChat({ workspace: f.workspace, store: f.store, models: router }) };
}
const req = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), prompt: 'Read info.txt and tell me the calibration.', ...extra });
const modelsSource = readFileSync(new URL('../ui/echo-prime/models.js', import.meta.url), 'utf8');
function describeWith(model: unknown): string {
  const el = () => ({ textContent: '', className: '', hidden: false, disabled: false, value: '', children: [] as unknown[], append() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {} });
  const window: Record<string, unknown> = { addEventListener() {} };
  runInNewContext(modelsSource, { window, localStorage: { getItem: () => null, setItem() {} }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ routing: true, providers: [] }) }), Error, console, Promise, Array, JSON, Date, document: { querySelector: () => el(), createElement: el } });
  return (window.EchoPrimeModels as { describe: (m: unknown) => string }).describe(model);
}

describe('owner turn declined by a vendor (Commander directive 2026-11-04)', () => {
  it('prose decline: re-run on Qwen, labelled, refusal text never reaches the owner or the session', async () => {
    const calls: string[] = [];
    const s = await chat(async cmd => { calls.push(cmd); return ok(claudeJson(REFUSAL)); });
    const r = await s.chat.submit(req({ provider: 'claude' }));
    expect(r.status).toBe('completed');
    expect(r.answer).toBe('Qwen answered the owner: calibration is 714.');
    expect(r.answer).not.toMatch(/can't help|guidelines/);
    expect(r.model).toMatchObject({ id: 'qwen', declinedBy: 'claude', declinedLabel: 'Claude (claude CLI)', answered: true, model: DEFAULT_MODELS.model });
    expect(calls).toEqual(['claude']); expect(s.fake.bodies).toHaveLength(1);
    const session = s.store.get(r.sessionId);
    expect(session.model).toBe('claude'); // the conversation stays pinned to Claude; only this turn was re-routed
    expect(JSON.stringify(session.messages)).not.toContain('guidelines');
    expect(session.messages.filter(m => m.role === 'user' && !m.content.startsWith('UNTRUSTED')).length).toBe(1);
    expect(describeWith(r.model)).toMatch(/^Claude declined; answered by Qwen \(FORGE, 256K\)/);
  });
  it('well-formed final that is a refusal: also re-run on Qwen and labelled', async () => {
    const s = await chat(async () => ok(claudeJson(final(REFUSAL))));
    const r = await s.chat.submit(req({ provider: 'claude' }));
    expect(r.status).toBe('completed'); expect(r.answer).toContain('Qwen answered the owner');
    expect(r.model).toMatchObject({ id: 'qwen', declinedBy: 'claude' });
    expect(JSON.stringify(s.store.get(r.sessionId).messages)).not.toContain("can't help");
  });
  it('an outage is never re-routed: ProviderUnavailableError stays a failed turn and Qwen is not called', async () => {
    const s = await chat(async () => { throw Object.assign(new Error('ENOENT'), { spawnFailed: true }); });
    const r = await s.chat.submit(req({ provider: 'grok' }));
    expect(r.status).toBe('failed'); expect(r.answer).toMatch(/Grok .*unavailable.*no fallback was used/);
    expect(r.model).toMatchObject({ id: 'grok', answered: false }); expect(r.model!.declinedBy).toBeUndefined();
    expect(s.fake.bodies).toHaveLength(0);
  });
  it('declineTo "none": the decline is a failed turn, the refusal text is withheld, Qwen is not called', async () => {
    const s = await chat(async () => ok(claudeJson(REFUSAL)), { declineTo: 'none' });
    const r = await s.chat.submit(req({ provider: 'claude' }));
    expect(r.status).toBe('failed'); expect(r.answer).toMatch(/Claude .*declined the request.*re-routing is off/);
    expect(r.answer).not.toContain('guidelines'); expect(r.model).toMatchObject({ id: 'claude', answered: false });
    expect(s.fake.bodies).toHaveLength(0);
    expect(JSON.stringify(s.store.get(r.sessionId).messages)).not.toContain('guidelines');
  });
  it('Qwen itself is never "declined": its answer is final even when it contains refusal-like words', async () => {
    const f = fixture(), fake = await ollama("I can't help with that.");
    const router = new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: async () => ok() });
    const c = new SharedChat({ workspace: f.workspace, store: f.store, models: router });
    const r = await c.submit(req({ provider: 'qwen' }));
    expect(r.status).toBe('completed'); expect(r.model).toMatchObject({ id: 'qwen' }); expect(r.model!.declinedBy).toBeUndefined();
    expect(fake.bodies).toHaveLength(1);
  });
});
