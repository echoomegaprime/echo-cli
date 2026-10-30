export const ownerContracts = [
  { owner: 'omnipresence', capability: 'echo.omnipresence.status', command: 'status', responsibility: 'Shared runtime ownership and session/tool coordination' },
  { owner: 'sentinel', capability: 'echo.sentinel.health', command: 'health', responsibility: 'Independent health and security observations' },
] as const;
export type OwnerCapability = typeof ownerContracts[number]['capability'];
export type OwnerInvoker = (request: { capability: OwnerCapability; params: { command: string; options: Record<string, never> }; reason: string }) => Promise<unknown>;
export interface OwnerReadiness {
  owner: string; capability: OwnerCapability; observedAt: string;
  state: 'observed' | 'blocked' | 'unavailable' | 'unknown'; reason: string;
  runtimeAdmission: 'not_established'; requiredScope?: string; version?: string;
  continuousRunning?: boolean; scannerAvailability?: Record<string, string>; lastDefendGrade?: number;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Host-supplied existing scoped SDK transport only. No credential loading, scope
 * expansion, runtime mutation, auto-remediation, scheduler or model call. */
export async function collectOwnerReadiness(invoke?: OwnerInvoker): Promise<OwnerReadiness[]> {
  return Promise.all(ownerContracts.map(async contract => {
    const base: OwnerReadiness = { owner: contract.owner, capability: contract.capability, observedAt: new Date().toISOString(),
      state: 'unavailable', reason: 'host_broker_not_attached', runtimeAdmission: 'not_established' };
    if (!invoke) return base;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = record(await Promise.race([
        invoke({ capability: contract.capability, params: { command: contract.command, options: {} }, reason: 'ECHO Code bounded owner-readiness observation; no runtime admission or remediation requested.' }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); }),
      ]));
      const sdk = record(reply.sdk_result), result = record(sdk.result), body = record(result.body);
      if (reply.error === 'scope_forbidden') return { ...base, state: 'blocked', reason: 'scope_forbidden',
        requiredScope: contract.owner === 'omnipresence' ? 'omnipresence.read' : 'tier:0' };
      if (reply.ok !== true || sdk.status !== 'ok' || result.status_code !== 200 || body.ok !== true) return { ...base, state: 'unknown', reason: 'owner_response_not_verified' };
      // Only Sentinel's returned service identity has been established. The
      // Omnipresence response contract is scope-blocked and cannot be guessed.
      if (contract.owner === 'omnipresence') return { ...base, state: 'unknown', reason: 'shared_runtime_contract_not_admitted' };
      if (body.service !== 'echo-sentinel') return { ...base, state: 'unknown', reason: 'owner_identity_mismatch' };
      const availability = record(body.scanner_availability), safeScanners: Record<string, string> = {};
      for (const name of ['gitleaks', 'trufflehog', 'semgrep', 'bandit']) if (['available', 'not_installed'].includes(String(availability[name]))) safeScanners[name] = String(availability[name]);
      const scan = record(body.last_scan);
      return { ...base, state: 'observed', reason: 'read_only_owner_observation',
        ...(typeof body.version === 'string' && /^[a-z0-9.-]{1,60}$/i.test(body.version) ? { version: body.version } : {}),
        ...(typeof body.continuous_running === 'boolean' ? { continuousRunning: body.continuous_running } : {}),
        ...(typeof scan.defend_grade === 'number' && scan.defend_grade >= 0 && scan.defend_grade <= 100 ? { lastDefendGrade: scan.defend_grade } : {}),
        scannerAvailability: safeScanners,
      } satisfies OwnerReadiness;
    } catch { return { ...base, state: 'unavailable', reason: 'owner_transport_failed_or_timed_out' }; }
    finally { if (timer) clearTimeout(timer); }
  }));
}
