import { describe, expect, it } from 'vitest';
import { PrimeHub, unwrap, type Json } from '../src/prime/hub.js';

const http = (body: unknown) => ({ status_code: 200, body });
const success = { ok: true, job_id: 'X' };
function nested(value: unknown, depth: number): unknown {
  for (let i = 0; i < depth; i++) value = http(value);
  return value;
}

describe('Prime HTTP owner-result integrity', () => {
  it.each([
    [{ ok: false, required: 'continuity.write' }, /continuity.write/],
    [{ status: 'failed', error: 'owner denied' }, /owner denied/],
    [{ status: 'error', error: 'owner failed' }, /owner failed/],
    [{ success: false, reason: 'owner declined' }, /owner declined/],
    [{ verdict: 'denied', error: 'denied by owner' }, /denied by owner/],
    [{ verdict: 'gated', required: 'creative.write' }, /creative.write/],
    [{ verdict: 'blocked', reason: 'owner blocked' }, /owner blocked/],
  ])('propagates JSON-string owner denial %j', (body, error) => {
    expect(() => unwrap(http(JSON.stringify(body)))).toThrow(error);
  });

  it('preserves a job ID from a JSON-string success body', () => {
    expect(unwrap(http(JSON.stringify(success)))).toEqual(success);
  });

  it('preserves valid object bodies', () => {
    expect(unwrap(http(success))).toEqual(success);
    expect(unwrap(http({}))).toEqual({});
  });

  it('retains explicit object-body refusal', () => {
    expect(() => unwrap(http({ ok: false, required: 'continuity.write' })))
      .toThrow(/continuity.write/);
  });

  it.each([
    ['malformed JSON', '{"ok":'],
    ['plain text', 'owner denied'],
    ['empty text', ''],
    ['whitespace', '   '],
    ['a JSON string', '"unrecognized owner response"'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['a JSON boolean', 'true'],
    ['a JSON array', '[]'],
    ['a null body', null],
    ['a missing body', undefined],
    ['a number body', 42],
    ['a boolean body', false],
    ['an array body', []],
  ])('refuses %s instead of returning an empty success', (_name, body) => {
    expect(() => unwrap(http(body))).toThrow(/Unrecognized HTTP response body/);
  });

  it('propagates nested success through MCP and SDK envelopes', () => {
    const owner = { sdk_result: { status: 'ok', result: http(JSON.stringify(success)) } };
    expect(unwrap({ content: [{ type: 'text', text: JSON.stringify(owner) }] }))
      .toEqual(success);
    expect(unwrap({ structuredContent: owner })).toEqual(success);
  });

  it('propagates nested explicit denial', () => {
    expect(() => unwrap({
      sdk_result: {
        status: 'ok',
        result: http(JSON.stringify({ status: 'failed', error: 'owner denied' })),
      },
    })).toThrow(/owner denied/);
  });

  it('retains the eight-iteration response nesting bound', () => {
    expect(unwrap(nested(success, 7))).toEqual(success);
    expect(() => unwrap(nested(success, 8))).toThrow(/Response nesting exceeds owner contract/);
  });

  it('bounds the JSON string before parsing', () => {
    const body = JSON.stringify({ ok: true, payload: 'x'.repeat(1048576) });
    expect(() => unwrap(http(body))).toThrow(/Payload exceeds bounded limit/);
  });

  it('does not copy an unrecognized body into a refusal', () => {
    expect(() => unwrap(http('owner-response-private-fixture')))
      .toThrow('Unrecognized HTTP response body');
  });
});

describe('Prime execution receipt integrity', () => {
  async function execute(body: Json) {
    const cap = { id: 'echo.fixture.run', registered: true, health: 'green',
      category: 'fixture', description: 'local-only fixture' };
    const hub = new PrimeHub({
      capabilities: [cap],
      sdk: {
        search: async () => [],
        read: async () => ({ registration_state: 'registered', capability: { id: cap.id } }),
        invoke: async () => http(JSON.stringify(body)),
      },
    });
    const ticket = await hub.prepare({ target: 'sdk', name: cap.id, arguments: {} });
    return hub.execute(ticket.id, ticket.digest);
  }

  it('retains the owner job ID and submitted state', async () => {
    expect(await execute(success)).toMatchObject({ state: 'submitted', result: success });
  });

  it('marks a JSON-string scope refusal as blocked', async () => {
    expect(await execute({ ok: false, required: 'continuity.write' }))
      .toMatchObject({ state: 'blocked', detail: 'Scope required: continuity.write' });
  });
});
