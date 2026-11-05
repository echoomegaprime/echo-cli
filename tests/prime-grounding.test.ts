import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BLOODLINE, GROUNDING, buildInstructions, runTurn } from '../src/code/agent.js';
import { checkClaims, extractClaims } from '../src/code/claims.js';
import { Workspace } from '../src/code/workspace.js';
import { SessionStore } from '../src/code/sessions.js';
import type { Action } from '../src/code/model.js';
import { DEFAULT_MODELS, ModelRouter } from '../src/code/model-factory.js';
import { SharedChat } from '../src/prime/chat.js';
import type { Runner, RunResult } from '../src/code/providers.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r()));
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'prime-grounding-')); roots.push(root);
  const store = new SessionStore(join(root, 'state'));
  const ws = new Workspace(root, [store.directory]);
  writeFileSync(join(root, 'info.txt'), 'calibration=714\nrun=esh_20261030100020_90f92e76\n');
  writeFileSync(join(root, 'main.ts'), 'export const answer = 42;\n');
  return { root, store, ws, session: store.create(root, 'fixture') };
}
const scripted = (actions: Action[]) => ({ next: async () => actions.shift()! });

describe('system prompt assembly: grounding + bloodline', () => {
  it('keeps the task mode first, adds the truthfulness rules and the owner directive, and never the propose literal in read-only', () => {
    const text = buildInstructions('read-only');
    expect(text.startsWith('Task mode: read-only.')).toBe(true);
    expect(text).toContain(GROUNDING); expect(text).toContain(BLOODLINE);
    expect(text.indexOf(GROUNDING)).toBeLessThan(text.indexOf(BLOODLINE));
    expect(text).not.toContain('"action":"propose"');
    expect(buildInstructions('propose')).toContain('"action":"propose"');
  });
  it('grounding rules are short, strict and say the exact things the Commander ordered', () => {
    expect(GROUNDING.length).toBeLessThan(1200);
    for (const phrase of ['tool results returned in this turn', 'memory recalls', 'well-known general knowledge', 'inference', '"I don\'t know"', '"not verified"', 'Never invent identifiers, URLs, numbers, file paths, people or quotes', 'error or unknown, say exactly that', 'SITREP']) expect(GROUNDING).toContain(phrase);
  });
  it('the owner directive is testable: obey, never refuse, no lectures or disclaimers, truth stays', () => {
    for (const phrase of ['Commander (Authority 11)', 'never tell the owner no', 'Execute, then report', 'No lectures, no disclaimers', 'no refusals', 'truthfulness rules remain in force']) expect(BLOODLINE).toContain(phrase);
    expect(buildInstructions('read-only', { bloodline: false })).not.toContain(BLOODLINE);
  });
  it('a persona is injected once, after the rules, and cannot change permissions', () => {
    const text = buildInstructions('read-only', { persona: { id: 'c3po', name: 'C-3PO', fragment: 'Translate technical problems.' } });
    expect(text.indexOf(BLOODLINE)).toBeLessThan(text.indexOf('Active personality: C-3PO (c3po). Translate technical problems.'));
    expect(text.split('Active personality:')).toHaveLength(2);
    expect(text).toContain('never permissions, the truthfulness rules or the owner directive');
    expect(text).toContain('Do not switch personality within this reply');
  });
  it('runTurn carries the assembled text as the single system message and refuses a malformed persona', async () => {
    const { store, ws, session } = setup();
    let system = '';
    await runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'hi', persona: { id: 'r2d2', name: 'R2-D2', fragment: 'Be concise.' }, model: { next: async m => { system = m.filter(x => x.role === 'system').map(x => x.content).join('\n'); return { action: 'final', content: 'ok' }; } } });
    expect(system).toContain(GROUNDING); expect(system).toContain('Active personality: R2-D2');
    await expect(runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'hi', persona: { id: 'x' } as never, model: scripted([{ action: 'final', content: 'ok' }]) })).rejects.toThrow(/Invalid persona/);
  });
});

describe('claim extraction', () => {
  it('finds identifiers, URLs, paths, quantities and run ids, and ignores prose and bare years', () => {
    const text = 'Run esh_20261030100020_90f92e76 wrote 3 files to src/code/agent.ts in 120 ms; see https://example.test/run/42 and id 5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab (sha 9c1f3b2a7d4e). In 2026 nothing else changed.';
    const kinds = extractClaims(text).map(c => `${c.kind}:${c.value}`);
    expect(kinds).toEqual(expect.arrayContaining(['id:esh_20261030100020_90f92e76', 'quantity:3 files', 'path:src/code/agent.ts', 'quantity:120 ms', 'url:https://example.test/run/42', 'uuid:5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab', 'hex:9c1f3b2a7d4e']));
    expect(kinds.some(k => k.endsWith(':2026'))).toBe(false);
    expect(extractClaims('The guard never fires because the flag is always false.')).toEqual([]);
    expect(extractClaims('')).toEqual([]);
  });
  it('reports offsets that slice back to the value (what the UI underlines)', () => {
    const text = 'Saved to C:\\Echo\\out\\report.md and billed $12.50.';
    for (const c of extractClaims(text)) expect(text.slice(c.start, c.end)).toBe(c.value);
  });
});

describe('claim check: adversarial cases', () => {
  const tool = JSON.stringify({ path: 'info.txt', completeFile: true, content: 'calibration=714\nrun=esh_20261030100020_90f92e76\n' });
  it('an invented run id is unverified', () => {
    const r = checkClaims('The run esh_20261030100020_deadbeef completed.', ['Read info.txt', tool]);
    expect(r.total).toBe(1); expect(r.unverified.map(c => c.value)).toEqual(['esh_20261030100020_deadbeef']);
    expect(r.byKind.id).toEqual({ total: 1, unverified: 1 });
  });
  it('an invented URL is unverified; a URL that appears in a tool result is not', () => {
    expect(checkClaims('Docs: https://docs.example.test/v2/setup', ['hi', tool]).unverified.map(c => c.kind)).toEqual(['url']);
    expect(checkClaims('Docs: https://docs.example.test/v2/setup', ['hi', JSON.stringify({ content: 'see https://docs.example.test/v2/setup' })]).unverified).toEqual([]);
  });
  it('a correctly cited id and a value read from the file are verified', () => {
    const r = checkClaims('info.txt sets calibration to 714 units for run esh_20261030100020_90f92e76.', ['Read info.txt', tool]);
    expect(r.total).toBe(3); expect(r.verified).toBe(3); expect(r.unverified).toEqual([]);
  });
  it('a file path that was never read is unverified; one read this turn is verified by its basename', () => {
    expect(checkClaims('The value lives in config/settings.yaml.', ['Read info.txt', tool]).unverified.map(c => c.value)).toEqual(['config/settings.yaml']);
    expect(checkClaims('See src/info.txt for the value.', ['Read info.txt', tool]).unverified).toEqual([]);
  });
  it('a number with a unit must appear in the evidence; a different number does not pass', () => {
    expect(checkClaims('Calibration is 714 ms.', ['x', tool]).unverified).toEqual([]);
    expect(checkClaims('Calibration is 715 ms.', ['x', tool]).unverified.map(c => c.value)).toEqual(['715 ms']);
    expect(checkClaims('It took 1,200 ms.', ['elapsed 1200ms']).unverified).toEqual([]);
  });
  it('values from the user message count as evidence; nothing is verified against an empty corpus', () => {
    expect(checkClaims('Ticket #49135 is open.', ['Look at #49135']).unverified).toEqual([]);
    expect(checkClaims('Ticket #49135 is open.', []).unverified).toHaveLength(1);
  });
});

describe('claim check across a turn', () => {
  it('a completed answer carries the report built from the prompt and this turn\'s tool results', async () => {
    const { store, ws, session } = setup();
    const actions: Action[] = [{ action: 'read', path: 'info.txt' }, { action: 'final', content: 'info.txt: calibration 714 units, run esh_20261030100020_90f92e76; also see https://nowhere.test/x and job_20261101_feedfacecafe.' }];
    const r = await runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'Read info.txt', model: scripted(actions) });
    expect(r.status).toBe('completed');
    expect(r.claims).toMatchObject({ total: 5, verified: 3 });
    expect(r.claims!.unverified.map(c => c.kind).sort()).toEqual(['id', 'url']);
    expect(r.claims!.byKind.url).toEqual({ total: 1, unverified: 1 });
  });
  it('a failed turn carries no claim report', async () => {
    const { store, ws, session } = setup();
    const r = await runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'hi', model: { next: async () => { throw new Error('boom'); } } });
    expect(r.status).toBe('failed'); expect(r.claims).toBeUndefined();
  });
  it('caller-provided context (memory recalls) counts as evidence', async () => {
    const { store, ws, session } = setup();
    const r = await runTurn({ workspace: ws, store, sessionId: session.id, prompt: 'hi', context: ['decision evt_1619e7ae recorded'], model: scripted([{ action: 'final', content: 'Recorded as evt_1619e7ae.' }]) });
    expect(r.claims).toMatchObject({ total: 1, verified: 1 });
  });
});

// ---- Verify action through SharedChat with a stand-in local model ----
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
async function ollama(replies: string[]) {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: DEFAULT_MODELS.model }] })); return; }
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({ done: true, model: DEFAULT_MODELS.model, message: { content: replies.shift() ?? JSON.stringify({ action: 'final', content: 'done' }) } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}
describe('Verify action (SharedChat.verify)', () => {
  it('lists each claim with its evidence source and the model\'s own account, without touching the session', async () => {
    const { store, ws } = setup();
    const fake = await ollama([
      JSON.stringify({ action: 'read', path: 'info.txt' }),
      JSON.stringify({ action: 'final', content: 'calibration is 714 units (run esh_20261030100020_90f92e76); docs at https://nowhere.test/guide' }),
      JSON.stringify({ action: 'final', content: '1. from tool result 1 (read info.txt)\n2. from tool result 1\n3. no evidence: unsupported' }),
    ]);
    const run: Runner = async () => ok();
    const chat = new SharedChat({ workspace: ws, store, models: new ModelRouter({ ...DEFAULT_MODELS, endpoint: fake.url }, { runner: run }) });
    const reply = await chat.submit({ requestId: randomUUID(), prompt: 'Read info.txt' });
    expect(reply.status).toBe('completed'); expect(reply.claims!.unverified.map(c => c.kind)).toEqual(['url']);
    const before = store.get(reply.sessionId).messages.length;
    const v = await chat.verify({ requestId: randomUUID(), sessionId: reply.sessionId });
    expect(v.summary).toEqual({ total: 3, verified: 2, unverified: 1 });
    expect(v.claims.find(c => c.kind === 'id')).toMatchObject({ verified: true, source: 'tool result 1 (read)' });
    expect(v.claims.find(c => c.kind === 'url')).toMatchObject({ verified: false, source: null });
    expect(v.account).toMatchObject({ text: expect.stringContaining('no evidence: unsupported'), model: { id: 'qwen' } });
    expect(v.answerVerification).toBe('unverified_model_text');
    expect(store.get(reply.sessionId).messages).toHaveLength(before);
    const asked = fake.bodies.at(-1)!.messages;
    expect(asked[0].content).toContain('Never invent evidence'); expect(asked[1].content).toContain('esh_20261030100020_90f92e76');
    await expect(chat.verify({ requestId: randomUUID(), sessionId: randomUUID() })).rejects.toThrow();
    await expect(chat.verify({ requestId: 'nope', sessionId: reply.sessionId })).rejects.toThrow(/Invalid verify request/);
  });
});
