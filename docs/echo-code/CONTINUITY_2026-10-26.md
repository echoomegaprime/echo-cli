# Durable memory checkpoints ? October 26, 2026

ECHO Code now persists explicit checkpoint requests in its private session journal and
can send them through a host-supplied, already-authorized Continuity Fabric broker.
This is a client integration. The standalone CLI has no broker attached, and live
Fabric capture is currently blocked by a missing `continuity.write` scope.

## Commands and host connection

Prepare only the summary the operator intends to save:

```powershell
node dist/code-main.js memory prepare SESSION_ID "Build checkpoint" "Tests passed; release remains open." --workspace C:\source
node dist/code-main.js memory status SESSION_ID --workspace C:\source
node dist/code-main.js memory sync SESSION_ID REQUEST_ID --workspace C:\source
```

Use the request ID returned by prepare and the same private state directory used
for the session. Prepare is local only. Sync exits 2 unless independent readback
is verified. Without a host broker it reports `host_broker_not_attached`.

An existing authenticated host may inject a `ContinuityInvoker` into
`registerCodeCommands(command, { continuityInvoke })`, or call
`syncCheckpoint(store, workspace, sessionId, requestId, continuityInvoke)`.
The callback receives fixed capability names, params, reason, idempotencyKey
(for capture), and an AbortSignal. It must return the structured result from the
existing SDK invocation, directly or inside `structuredContent`. Map the
idempotency key to the SDK's `idempotency_key`; preserve owner authorization.
The client does not load tokens, choose accounts, expand scopes, construct a
second broker, or expose capture to the model/MCP workspace server.

Only two capabilities are called: `echo.continuity.capture` and
`echo.continuity.recall`. Capture params follow the registered schema directly:
kind, title, detail, requestId. Do not add command/options wrappers. Transport
HTTP 200, registry health, and service access diagnostics do not establish a save.

## Persistence and recovery contract

| State | Meaning and next explicit sync |
|---|---|
| prepared | Local request exists; no capture attempted |
| blocked | Broker or named scope unavailable; no verified save |
| uncertain | Capture may have happened; reuse exactly the same payload/request ID |
| saved | Matching receipt persisted; retry only recall |
| verified | Receipt plus independent event-ID/hash/content readback matched; no replay |
| conflict | Owner rejected request identity reuse; held for operator review |

The deterministic request ID includes the session UUID and a digest of the exact
normalized payload. Repeated preparation in the same session returns the same
checkpoint. A different session is a different request. The journal is flushed
before capture and after receiving its receipt. A crash, timeout or lost reply
therefore retains the request identity. Session recovery can clear a confirmed
dead process lease; it does not replay writes. A missing broker after a lost
reply retains the uncertain state.

Receipt validation requires service identity, saved/verified booleans, artifact
kind, nonempty opaque IDs, the exact request ID and content SHA-256. Readback
queries the exact event ID and requires ARTIFACT_REGISTERED, the same hash and
content (or the service's bounded 1200-character excerpt). The owner marks
captured assertions UNVERIFIED; verified here means persistence of matching bytes,
not truth of the summary. Receipt-only saves remain distinct from readback verification.

Titles are capped at 200 characters, details at 20000, and sessions at 20
checkpoints and the existing 4 MiB journal ceiling. Control characters and common
secret-like patterns are refused; secret detection is best effort. No source,
paths or transcript is automatically copied. Raw broker errors are not persisted.
Each call has a 15-second local deadline and best-effort abort; an upstream write
may complete later. There is no automatic retry or background scheduler.

## Actual owner evidence and blocker

The existing SDK connection returned HTTP 403 / scope_forbidden for the prepared
build checkpoint. It grants continuity.read and tier:1 but lacks continuity.write.
The request had no save receipt or event ID. We did not retry through a different
connection, call a grant/remediation capability, or claim ingestion.

Fabric status run `19f1755d-36bb-47c7-bb9a-47c012ba4c05` returned canWrite=true
under its downstream identity. That does not grant the upstream SDK scope.
Recall run `8be94fc7-28f6-4683-9b0e-586730e8a39e` returned no matching f13363d
checkpoint. The original pending request is preserved with its stable ID:
`echo-code-muse:f13363d672ef565dd847d72405e0877b396e2b4c:checkpoint:v1`.
It is a pre-adapter build checkpoint, separate from session-derived request IDs.

The required owner action is to grant continuity.write to the existing SDK
connection through its normal authorization process. It must then retry that
preserved request unchanged and verify exact receipt/readback. A later build
checkpoint needs its own request ID. Tier labels and broader plugin permission
settings are insufficient. No credential value is needed in chat or this repository.

Current registry schemas were read directly. Receipt and retry behavior were
also inspected in the installed Fabric release directory
`/home/forge/ecf-mcp/releases/6dabe274cbd7667e4c2233ecd5a58a576d19a8e4-recall5xx-20261007/`.
This locates inspected source, not a claim that its Git SHA is the active deployment.
See [sanitized evidence](evidence/continuity-contract-results.json).

## Validation and remaining acceptance

116 tests in 14 files, lint, TypeScript no-emit checking and build passed.
The new CLI command failed before implementation; the final suite includes 23
memory tests covering restarts, scope denial, receipt mismatch, replay after a
lost response, recall-only retry, conflict, excerpt matching, tampering, workspace
binding, secret-like content, session contention and a hung capture.

Success-path receipts are contract fixtures, not live write evidence. Actual
end-to-end capture/readback remains blocked by the denied scope and missing
standalone broker attachment. Shared runtime admission, independent review,
exact-SHA certification and release/rollback evidence remain separate open gates.
