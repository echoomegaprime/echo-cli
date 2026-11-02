# Acceptance report — local preview

Historical baseline at 2bcfd4cce8327d950a5791332d53e2676151e886.
See [the October 26 continuation](CONTINUATION_2026-10-26.md) for newer validation and remaining gates.

Verdict: **working bounded local preview; model quality and governed release held**.

Fresh validation on Windows QUENCH: the initial 32/32 tests in five files passed; three further owner-adapter tests were added after the user's Omnipresence/Sentinel steering. Final counts and exits are in the delivered validation receipt. TypeScript build, ESLint and git diff whitespace checks passed. The production-dependency audit returned zero findings after updating the existing transitive fast-uri lock from 3.1.5 to 3.1.8. This does not establish absence of vulnerabilities. The preview's standalone entry imports Commander and Node built-ins; it does not use the legacy API-key client.

Tests cover: real temporary workspace reads; traversal/secret/metadata/device/stream/link denial; bounded inputs; staging without writes; stale approval rejection; one-time approval; revert preserving later edits; local state reload; workspace and ID binding; interrupted apply/revert reconciliation; live-lease protection; redirect and timeout refusal; a deterministic local HTTP model fixture driving the real loop; step/cancel handling; and a fresh child process performing MCP initialize/list/read with clean stdout/stderr. Existing config/client/formatter tests remain passing.

Test-first records preserve initial missing-feature failures, the recovery-journal failure and the stop-after-proposal failure. No failing scaffold remains in the implementation. The composed skill's writing-good-tests.md linked file was absent; its inlined test rules and repository tests were used rather than inventing a replacement policy.

Real model: installed QUENCH echo-steward:4b-pilot, local Ollama. Inventory succeeded. A real edit run read the fixture, staged the exact `a + b` to `a - b` change and ended pending approval. Fresh CLI processes read the complete before/after, applied the selected proposal, verified the changed file, reverted it and verified the original bytes. No model/API subscription, new account or model download was used. This test changed only a disposable fixture.

Preserved failures: the first local-model explanation invented unrelated math-package features. An earlier edit run staged a valid change but produced an invalid follow-up action. The implementation now stops immediately after successful staging and emits its own truthful pending message. A subsequent read answer still added an incorrect invocation inference and ignored the requested brevity. Therefore broad factual/model-quality acceptance is **not passed**. Do not advertise Muse Spark parity or autonomous production coding readiness.

Reference acquisition: official public SDK pinned to ae469342dfe6ccd5142947af5f7dcdd5d50ccc18; signed installed Muse 1.4.10. Offline exported stable schema is byte-identical to the public SDK stable schema. SDK implementation/source inspection supports the architecture report; paid Muse inference and sandbox internals were not tested. No performance comparison or superiority claim was attempted.

Governance: initial build preflight passed 24 required checks. Current exact-SHA build/release reports are delivered separately with the final artifact, so this source file does not assert its own future commit hash. The absent Ops action catalog blocks operational authorization, and no service/deployment operation occurred. Arcanum search and build registration returned scope_forbidden for arcanum.read and builds.write respectively; no access was expanded. Fabric status responded, but recall returned SDKError and the local mission scope was absent. Local notes are not Fabric ingestion. No build-registration or capture success is claimed. Omnipresence status is likewise scope-blocked; Sentinel health is observable but is not candidate certification. See OWNER_INTEGRATION.md.

Not verified: manual interactive TTY use, arbitrary hardware/OS combinations, model task benchmarks, hostile concurrent filesystem containment, exhaustive crash/power-loss durability, external MCP clients, full MSP compatibility, fleet SDK tool use, independent review/certification, staging, deployment and production rollback. The package is for local review and bounded use under these limits.

Evidence: the task's outputs/echo-code directory contains final validation exits/logs, preflight reports, model smoke logs, fixture approval/revert receipts, source/schema hashes, case documents, build/capture results and a manifest. Initial failures are retained alongside final results.
