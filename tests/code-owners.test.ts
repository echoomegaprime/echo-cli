import { expect, it } from 'vitest';
import { collectOwnerReadiness, ownerContracts } from '../src/code/owners.js';

it('keeps shared runtime admission blocked when no host broker is supplied', async () => {
  const result = await collectOwnerReadiness();
  expect(result.map(r => r.state)).toEqual(['unavailable', 'unavailable']);
  expect(result.every(r => r.runtimeAdmission === 'not_established')).toBe(true);
});
it('uses only the two existing read capabilities and keeps a scope denial separate from health', async () => {
  const called: string[] = [];
  const result = await collectOwnerReadiness(async request => {
    called.push(request.capability);
    return request.capability === 'echo.omnipresence.status'
      ? { ok: false, error: 'scope_forbidden', required: 'omnipresence.read' }
      : { ok: true, sdk_result: { status: 'ok', result: { status_code: 200, body: { ok: true, service: 'echo-sentinel', version: '1.15.0-r51', continuous_running: true, scanner_availability: { semgrep: 'not_installed', bandit: 'available' }, last_scan: { defend_grade: 78 }, secret: 'NEVER RETURN THIS' } } } };
  });
  expect(called.sort()).toEqual(['echo.omnipresence.status', 'echo.sentinel.health']);
  expect(result[0]).toMatchObject({ state: 'blocked', reason: 'scope_forbidden', requiredScope: 'omnipresence.read' });
  expect(result[1]).toMatchObject({ state: 'observed', runtimeAdmission: 'not_established', version: '1.15.0-r51', continuousRunning: true });
  expect(result[1].scannerAvailability?.semgrep).toBe('not_installed');
  expect(JSON.stringify(result)).not.toContain('NEVER RETURN THIS');
});
it('does not treat transport success or an unexpected identity as accepted runtime state', async () => {
  const semantic = await collectOwnerReadiness(async () => ({ ok: true, sdk_result: { status: 'ok', result: { status_code: 200, body: { ok: false, service: 'echo-sentinel' } } } }));
  expect(semantic.every(r => r.state === 'unknown')).toBe(true);
  const wrong = await collectOwnerReadiness(async () => ({ ok: true, sdk_result: { status: 'ok', result: { status_code: 200, body: { ok: true, service: 'some-other-service' } } } }));
  expect(wrong.every(r => r.state === 'unknown')).toBe(true);
  expect(ownerContracts).toHaveLength(2);
});
