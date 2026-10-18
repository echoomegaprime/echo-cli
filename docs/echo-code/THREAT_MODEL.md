# Threat model and release holds

Assets: source files, credentials, local session contents/backups, approval intent, other concurrent work and ECHO fleet authority. Untrusted inputs: model responses, repository text, prompt content, MCP arguments and damaged state after interruption. Trusted components: operator, local OS/filesystem and Node, selected Ollama daemon/model, installed dependency provenance and the private session directory.

| Risk | Current control | Remaining limit |
|---|---|---|
| Model runs a command or deploys | No such action exists | Model prose can still suggest commands; review it |
| Automatic or stale source overwrite | Proposal-only model, separate explicit approval, before/after hashes | Same-user malicious filesystem race is outside this application boundary |
| Traversal / junction / hard-link escape | Relative path validation, parent link checks, real workspace binding, hard-link rejection | No OS sandbox; do not share the workspace with a hostile writer |
| Windows special paths | Reject absolute/UNC/drive/ADS/control characters, device names, trailing-dot/space paths | Filesystem/provider edge cases have not had independent audit |
| Credential disclosure | Deny common credential files/directories; redact common token/assignment formats before persistence/model input | Best effort, not complete secret detection; choose a source-only workspace |
| Hidden approval escalation | No approve action exposed to model or MCP | CLI caller remains responsible for real ECHO preflight and governance |
| Cloud charges or data egress | Loopback-only origins, redirect refusal, no keys/fallback/download; cloud-named models refused | A locally configured cloud proxy/alias is operator-controlled and cannot be reliably identified from its name |
| Repeated tool calls/resource use | Step/context/file/search/response/time budgets | Local model may still be slow or inaccurate |
| Outage/partial write | Flush + atomic replace, journaled applying/reverting, stale lease and hash reconciliation | Hardware/storage failure and directory-flush guarantees are not proven |
| Concurrent users/processes | Session lease and source conflict checks | Private directory permissions rely on user/OS ACLs on Windows |
| Prompt injection / hallucination | Inputs labeled untrusted; no shell; edits await approval; answers labeled unverified | No guarantee of correct or faithful model output; real smoke exposed hallucination |
| MCP abuse | Local stdio, three read-only tools, bounded file access | No remote auth/server; client interoperability and exhaustive framing conformance pending |

No exploit, credential extraction, sandbox bypass, live service mutation or deployment is part of this case. Release holds: stronger model evaluation, independent security review, admitted OS sandbox before shell tools, actual fleet scope and tool contracts, exact-SHA certification and target-specific release/rollback evidence. A missing Ops action catalog does not authorize infrastructure control.
