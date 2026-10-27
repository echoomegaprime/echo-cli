# Upgrade backlog

1. **Model quality gate.** Evaluate existing larger Qwen models in an admitted compute lane on a fixed repository-task set. Measure factual read accuracy, correct patches, regression results, malformed responses and latency. Preserve the 4B model's observed failures; do not promote a single passing edit into parity.
2. **Sandboxed test runner.** Admit an OS-enforced execution boundary, workspace isolation, constrained network and exact command approval before adding shell/test execution. The present application boundary cannot substitute for it.
3. **Governed ECHO tools.** Reuse the scoped SDK broker and reviewed allowlist after mission admission; add read-only Fabric/tool-discovery contracts first. Do not pass arbitrary capabilities from model output or reuse startup-read authority for writes.
4. **Instruction/skill context.** Add hash-pinned reviewed context loading with provenance. Project content remains untrusted and must not grant authority. No arbitrary hooks or package-script execution.
5. **Review experience.** Unified diffs, larger/multiple-file transactions, explicit reject and conversation branching. Preserve original hashes, concurrency rules and recovery journal at every step.
6. **Protocol work.** Add a versioned ECHO session API if consumers require it. MSP compatibility would require its actual schema and conformance suite; do not rename the existing JSON CLI “MSP.” Test real MCP clients and current protocol versions before remote exposure.
7. **Engineering delivery.** Independent code/security review; draft PR against exact candidate; CertForge and Certification App readbacks; target-specific release preflight, staging and rollback. Nothing in this preview auto-merges or deploys.

No external paid provider, new model download or public tunnel is necessary for the tested local preview.

## October 26 progress

Read-only dispatch, complete unified review, durable rejection and the bounded 7B model gate are implemented. Broader model qualification remains open. Explicit checkpoint persistence/receipt/recall logic is implemented and tested; current write authorization and host attachment are still blocked. See CONTINUITY_2026-10-26.md and RUNTIME_ADMISSION_PROPOSAL.md before advancing shared execution.
