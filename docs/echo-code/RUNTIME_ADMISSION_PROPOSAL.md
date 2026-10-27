# Proposed coding admission for the existing shared runtime

Status: reviewable contract proposal; no production owner changes or activation.
ECHO Code remains the coding client, Omnipresence the intended shared runtime owner,
Fabric the durable memory owner, and Sentinel an independent observer.

## Evidence behind the hold

The current Core router and pipeline were re-read during the October 26 continuation.
They match the earlier inspected source hashes:
- echo_core_router.py: 3d609f16e86c14af770edb559963e608762d40e2373437a0926c5cb60397fc6e
- pipeline.py: 13b6493131d9caa7482eecc25aa05bcddc2af908efda100cf39b4c6e9035880f

The answer pipeline has no admitted coding profile with the required workspace,
tool, local-only inference and cancellation contract. Its existing instructions
explicitly exclude coding assistance, and its normal path can include provider
fallback, oversight and memory writes. Supplying a different persona does not
establish coding admission. No coding task was sent through that path.

The prior Omnipresence status request is scope-blocked; a different status/health
route was not used to work around it. A registered C3PO coding route with an empty
parameter schema is likewise insufficient evidence of a complete session/tool
contract. No inference load was placed on that route.

## Required owner contract before activation

These are proposed requirements, not invented fields sent to a live endpoint.
The runtime owner must identify its canonical, versioned capability/schema first.

| Requirement | Acceptance evidence |
|---|---|
| Coding role and scope | Owner-authenticated admission binds caller, coding profile and version; denied/missing scope fails without alternate routes |
| Workspace identity | Canonical source root and session identity bound once; cross-workspace resume refused |
| Local inference policy | Admitted model and compute node, resource/time budgets, no paid fallback, no model download |
| Action allowlist | List/read/search/final by default; proposal staging only for explicit invocation mode; no arbitrary capability names |
| Approval | Exact proposal ID and before/after hashes; stale source fails; separate caller action required to apply |
| Cancellation and retry | Turn/request IDs, cancellation acknowledgement, durable outcome lookup, duplicate detection and interrupted recovery |
| Memory | Explicit summary capture only after authorized scope; immutable request and verified receipt plus readback |
| Telemetry | Fixed event metadata, no raw source/transcript/secrets; Sentinel observations distinct from permission and certification |
| Release | Exact code/contract SHA, independent review and certificates, designated target, rollback and post-release verification |

## Concrete activation sequence

1. Runtime owner supplies the actual coding admission/session/tool contract and
   required named scopes. Resolve the existing denied scopes through normal
   authorization; do not self-grant or substitute accounts.
2. Implement that contract in an isolated owner checkout with the owner doorway,
   build preflight and tests. The current source cannot be switched by a client
   persona override. No new scheduler or shared memory store is needed.
3. Attach the existing host broker to ECHO Code with only admitted capabilities.
   Exercise local-only read, rejected proposal in read-only mode, explicit staged
   edit, stale approval, restart, duplicate request and cancellation.
4. With continuity.write granted, retry the preserved checkpoint request exactly,
   verify its receipt and independent recall, and then record a new candidate checkpoint.
5. Obtain exact-SHA release evidence and target-specific rollback before any
   shared execution activation. A passing client test suite does not close these gates.

Phone entry points, personal connectors, voice and unattended background work must
use the same admitted identity/session/action boundary. They remain unimplemented;
adding another interface before this boundary is established would not complete
the personal assistant.
