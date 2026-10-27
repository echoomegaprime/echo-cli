# Shared coding host integration

Candidate owner contract: [runtime PR #998](https://github.com/echoomegaprime/echo-omnipresence-runtime/pull/998).

`runSharedTurn` in `src/code/shared.ts` connects the existing bounded coding client
to the owner profile. It reuses runTurn, Workspace and SessionStore, including
source evidence, secret/path protection, session leases, hash-bound proposals and
separate approval. It does not introduce a new tool runner or memory store.

The authenticated host supplies `invoke`, plus `admission.contractSha256` and
`admission.admissionId` obtained from its actual approved owner release. Discovery
must match those pins before any workspace text is sent. Merely copying a
discovery response into admission does not establish release approval.

The host broker accepts the fixed capabilities echo.core.coding.contract and
echo.core.coding.step, flat params, a fixed reason and an AbortSignal. It must use
the same authorized SDK connection, preserve the returned SDK envelope and honor
cancellation. It must not retry model calls automatically or log request contents.
No API key loader, alternate-account logic or permission repair is in this adapter.

Call runSharedTurn with the existing workspace, store, sessionId, prompt, optional
read-only/propose mode, invoke callback and approved admission. The entrypoint pins
the mode and workspace digest from these trusted arguments. It supplies UUIDv4
request IDs for correlation and validates the returned contract, model, identities,
mode and no-side-effect claims before returning an action to runTurn.

The server replaces the leading runTurn system instruction with its own bounded
policy. Later system-role history is refused. Server and client enforce the
96-KiB/50-message context budget, read-only actions and fixed local model policy.
A forged scope error, stale contract, timeout, malformed response or identity
mismatch cannot trigger file tools, fallback models or a retry. Cancellation is
best effort at the provider; the host transport receives an aborted signal.

This is a programmatic host entrypoint, consistent with the existing memory
broker interface. The standalone echo-code command continues to use its local
model unless a host explicitly calls this function. No authenticated host is
attached by this commit, and the backend remains disabled until owner release.
There is no live deployment or successful Fabric save claimed.

Memory remains separate: the current SDK connection needs continuity.write from
the normal key administrator. The suggested db.read repair was denied for missing
monitor.read even with apply=false and was not applied. After permission repair,
replay the original persisted checkpoint payload and require receipt/readback;
use a new checkpoint ID for this client increment.

Validation includes real runTurn/Workspace/SessionStore fixtures with a fake SDK
broker, plus the existing complete CLI test suite. Production admission and live
owner connectivity are separate from these passing tests.
