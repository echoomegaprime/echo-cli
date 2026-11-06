# Prime and Workspace integration candidate — 2026-11-01

This candidate brings the canonical Workspace account and saved-conversation interface into the existing Prime orb desktop. General conversations use the canonical Workspace NDJSON route and durable per-account store. The separate ECHO Code conversation remains attached only through its existing reviewed coding-owner contract.

The source is a continuation of build19147 and queue49382. The original integration worktree and its seven-file restart snapshot were preserved. Continuation branch: `agent/prime19147-resume-20261101`. The baseline is `2d245f37819e37134a8c04801f560ffb6070097c`. This document is source evidence, not a release certificate.

## Account and transport boundary

A reviewed Prime configuration may provide `workspace.baseUrl` and `workspace.ownerUid`. The backend must be a fixed loopback HTTP origin serving the canonical authenticated Workspace contract. Startup refuses an authentication-disabled owner installation. The protected owner installations on8768 and18767 are not changed by this candidate.

Only the request's named Workspace session cookie is sent to the canonical backend. No Prime cookie, shared owner cookie, SDK credential, Authorization header, arbitrary URL or client-selected tenant is forwarded. Private data reads and writes require the current canonical session and its CSRF value. Prime engineering APIs and account administration additionally require the configured primary UID, canonical owner role and approved status. Secondary administrators are not promoted into the primary owner's engineering surface.

Every non-primary private operation also requires a fresh canonical state attestation of tenant isolation, authenticated mode, matching UID and matching CSRF after the current request's CSRF check. Unisolated legacy-owner applications fail closed even after role demotion or a primary-UID configuration mismatch, including model-dispatched tools. Global plugin status and synchronization require the primary owner; per-account MCP configuration remains available to isolated members. Only the exact canonical local actions `memory_save`, `memory_forget` and `personality_select` are available to isolated members.

The route allowlist is fixed. Request bodies, responses and NDJSON events are bounded. Redirects, ambiguous cookies, invalid UTF-8, invalid event shapes, mismatched completion IDs, truncated streams and events after completion are refused. No uncertain write is automatically retried. Canonical logout can revoke the local issued session during an identity-provider outage, using that session's CSRF, without admitting any private read.

Ordinary NDJSON events are limited to256KiB; the canonical type-first done event may contain up to8MiB of saved-chat history. The complete response is limited to32MiB. This larger terminal allowance preserves retained messages after compaction without granting large ordinary token/tool events. Larger histories still require a future paginated receipt contract; unlimited transcripts are not claimed.

Metadata requests have a20-second deadline and general chat125seconds. Canonical provider operations have explicit finite budgets: voice start455seconds (three150-second helper calls plus margin), next305seconds, transcription155seconds, and code review/compaction610seconds. Compaction with multiple sequential model calls can still exceed its overall budget. A deadline cancels transport and reports uncertainty; it does not prove upstream work stopped, and never triggers an automatic provider replay.

Owner ESH actions have220seconds for connector initialization, status and one dispatch; other engineering actions have115seconds. Global synchronization has610seconds for a bounded overall attempt. Sequential connector work or lock contention can still exceed these deadlines. Local preferences retain the20-second budget.

The browser keeps appearance settings in localStorage. Private prompts and global draft/history records are not persisted there. Account changes abort pending work and clear private conversations, forms, tool tickets, voice and owner panels. Generation checks reject late responses; server-side admission remains authoritative.

### Explicit public HTTPS ingress

The reviewed Prime JSON configuration may set `publicOrigin` to `https://echoomegaprime.com` alongside the existing authenticated `workspace.baseUrl` and pinned `workspace.ownerUid`. This requires an HTTPS DNS authority with no credentials, path, query, fragment or nondefault port. Public mode refuses startup without the authenticated backend and primary-owner pin. The process continues listening only on127.0.0.1; a separately admitted TLS proxy must preserve the exact configured public Host and Origin. Forwarded headers never expand admission. An optional www host must redirect to the canonical origin at the proxy before loading the app.

Public mode sets Secure on both the HttpOnly Prime interface cookie and the rewritten canonical Workspace login/logout cookie. An unconfigured installation retains its loopback Host/Origin behavior. Real HTTP regressions cover rejected unsafe origins, missing owner/backend configuration, exact public Host/Origin, cross-origin login refusal, Secure login/logout cookies, tenant-CSRF binding and member denial from the owner hub. These source checks do not prove live TLS, DNS, proxy configuration or real identity acceptance.

Issuer failure clears identity and private admission. A separate memory-only revocation proof can be sent solely to canonical local logout; normal request headers never use it. Explicit invalidation, positive anonymous readback, and successful, rejected or uncertain logout erase that proof. The account panel shows no cached identity during an outage and reports signed out only after positive anonymous readback. A newly issued login proof supersedes an older account's cleanup proof.

## Preservation matrix

| Group | Candidate behavior and evidence boundary |
|---|---|
| A · Desktop | Existing orb, palette, reduced motion, quality controls and separate coding/studio panels are retained. Workspace controls extend the same DOM. |
| B · Conversations | Canonical saved history, search, new/open/rename, projects, general NDJSON replies, context estimate, compact/fork and journal controls. Coding chat keeps a separate protocol and owner admission. |
| C · Durable data | Canonical chats/projects/library, attachments, text-file upload/download, journals and normalized import. Durability and cross-account isolation verified against real canonical HTTP/auth/store with a synthetic issuer/model. |
| D · Memory | Per-account preferences use the canonical owner. Connected ECF/Crystal and synchronization are explicit owner operations. Local save, pending outbox and verified remote ingestion remain different states. |
| E · Grounded tools | General tool events and saved final replies remain canonical. Tool result text does not establish an independently verified external postcondition. No extra agent engine or automatic retry is added. |
| F · ESH and fleet | Owner-gated ESH uses the existing status-before-dispatch policy and reviewed exact command. Fleet/diagnostics retain canonical owner boundaries. Layout controls do not grant shell authority. |
| G · SDK and Vault | Exact discovery and reviewed owner operations use existing connections. Vault credential entry stays isolated from chat and ordinary diagnostics. No ambient credential or account copying. |
| H · MCP | Per-account Streamable HTTP discovery/enable/disable/removal uses canonical storage and schemas. OAuth and legacy SSE onboarding remain outside that owner's current contract. |
| I · Voice/personality | Canonical profiles, saved-reply playback, optional spoken replies/brief extractive speech/auto-send, and explicit hands-free mode limited to ten captured turns. These options start off. Bounded mono16kHz PCM transcription, progressive artifacts, playback failure feedback and stop/account/page/visibility invalidation are covered by behavioral fixtures. Real provider and microphone acceptance remain separate. |
| J · Research | General agent web_search/web_read remain canonical model tools with provenance. Signed-in ShadowGlass control is not fabricated as a Workspace capability. |
| K · Coding/review | Canonical saved code-review reports from library files are integrated. Existing bounded coding pipeline and review/approval protections remain. Standalone Prime does not invent a coding owner or override an absent admitted coding profile. |
| L · Creative Studio | Existing capability discovery, preparation, execution tickets and status/error receipts remain owner-scoped. A registry match or UI panel does not prove image/video/music generation. |
| M · Accounts | Canonical password/Google routes, pending approval, primary-owner account decisions, revocation, session change clearing and per-user stores. Fixture tests do not establish live Google sign-in or email delivery. |
| N · Operations | Canonical diagnostics, truthful disconnected/stale states, bounded streams, metadata-only debug logs, and separate Node Steward admission/evaluation/coverage evidence. |

## Verification and reproducible checks

Run the repository checks with one test worker on memory-constrained QUENCH:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npx tsc --noEmit
npm test -- --maxWorkers=1
npm run build
```

Targeted suites are `tests/prime-workspace.test.ts` and `tests/prime-workspace-ui.test.ts`. They exercise real Prime HTTP, adversarial stream parsing, canonical identity/CSRF controls and browser-controller behavior. Remote identity/model responses in unit tests are explicit fixtures.

A separate local acceptance harness used the actual canonical Python candidate at `echo-omnipresence-runtime` SHA `8de99d98521787c9580c84e1645dfb5b7aadfd88`, with temporary stores and synthetic identity/model providers. Fourteen checks passed: anonymous denial; mismatched-primary legacy-owner isolation; pending denial; owner/member separation; durable chat and idempotent replay; cross-account data isolation; member engineering denial; journal/fork/import contracts; rename/search; compaction preserving originals; saved code-review readback; immediate revocation; actual browser-transport logout after issuer outage with anonymous readback; and fresh-process approval/chat durability with old-session invalidation. The public-ingress continuation adds ten regressions to the previously passing281 tests. This is local integration evidence, not a live provider canary.

Debug namespaces: `NODE_DEBUG=echo-prime-server,echo-prime-workspace,echo-prime-steward`. New server records contain operation category, generated request ID, response status/outcome and elapsed time. Browser records contain operation and outcome. Prompts, answers, credentials, session cookies and CSRF values are excluded from these debug records.

Evidence for this continuation is under:

`D:\ECHO_OMEGA_PRIME\08_ARTIFACTS\commander-sol-20261030174506-df3752f820\resume-20261101-162757`

## Release and remaining owner gates

Public hosting at echoomegaprime.com is authorized by the user, but is not performed or certified by this source increment. Release requires the exact candidate's independent review, hosted checks, CertForge and Certification Forge GitHub App results, genuine required signatures, live account/tenant/privacy acceptance, measured target capacity/TLS identity and tested rollback. The explicit no-Cloudflare instruction remains applicable to this task.

The original local Workspace is auth-disabled and cannot be used as a public account backend. A reviewed authenticated canonical owner must be configured and admitted. Real password/Google login, account emails, remote MCP execution, ECF/Knowledge ingestion, voice synthesis/transcription, creative-provider generation and coding inference require their actual owner/service evidence. Test fixtures do not satisfy these gates.

Node Steward integration already enforces fresh node/model identity, admission, passing evaluation, canary and rollback evidence before advisory availability. Advisory output never authorizes execution or promotion. A failed or missing Steward evaluation cannot be relabeled into every-node deployment. Preserve GPU holds and do not enable an unadmitted model to fill an interface status.

Rollback for this source increment is the preserved original branch/worktree and hash-bound seven-file snapshot. No protected owner data, live listener, public DNS or fleet model was changed.
