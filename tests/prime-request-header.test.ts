import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-11-06 live E2E: integrations.js, media-router.js and steward.js spread the shared owner headers
// (workspace-client.js headers(), lowercase 'x-prime-request') after their own capitalized 'X-Prime-Request'.
// Plain-object keys are case-sensitive, so fetch received both and sent "x-prime-request: 1, 1".
// server.ts accepts only the exact value "1", answered 403, and the client treated that 403 as a sign-out.
const UI = join(__dirname, '..', 'ui', 'echo-prime');
const modules = readdirSync(UI).filter(name => name.endsWith('.js'));

describe('x-prime-request header', () => {
  it('every UI module spells the Prime request header in lowercase, so a spread of the shared owner headers overrides it instead of duplicating it', () => {
    const offenders = modules.filter(name => /['"]X-Prime-Request['"]/.test(readFileSync(join(UI, name), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('merging a module header object with the shared owner headers leaves exactly one request header value', () => {
    const owner = { 'x-prime-request': '1', 'x-echo-csrf': 'csrf-token-value' };
    const sent = new Headers({ 'x-prime-request': '1', ...owner, 'content-type': 'application/json' });
    expect(sent.get('x-prime-request')).toBe('1');
    const duplicated = new Headers({ 'X-Prime-Request': '1', ...owner } as Record<string, string>);
    expect(duplicated.get('x-prime-request')).toBe('1, 1');
  });
});
