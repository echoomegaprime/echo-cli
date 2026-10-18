# Parity and intentional limits

The reference column describes observed documentation/source/help, not verified paid-provider behavior. ECHO entries refer to this local preview's tests and smoke evidence. No blanket parity claim is made.

| Capability | Muse reference | ECHO 0.1 result |
|---|---|---|
| Terminal task loop | CLI docs/help | Implemented; real local-model read and edit smoke |
| Headless use | exec | run returns structured JSON; tested |
| Interactive conversation | terminal UI | Basic line-oriented chat; no rich TUI; TTY/manual acceptance pending |
| Inspect repository | coding agent | Bounded list/read/literal search; tests and real read |
| Edit files | agent edits with approvals | One staged full-file edit per proposal turn; separate approval and conflict checks |
| Undo | session rewind differs from file restore | ECHO reverts its own unchanged approved edit; no conversation branching |
| Resume / outage recovery | MSP durability and session resume | Local JSON recovery; fresh-store/process checks and interrupted edit reconciliation |
| Programmatic control | MSP, TypeScript/Python SDK | ECHO library functions and JSON CLI; not MSP compatible |
| MCP | extensibility/client configuration | Local read-only MCP server; fresh-process handshake/list/read tested; no client |
| Local model route | installed help exposes local option | Actual QUENCH Ollama tested; no Meta plan/API use |
| Hosted model quality | Muse Spark | Not reproduced; installed 4B model showed hallucinations and format failure |
| OS sandbox / shell tools | official safety docs | Absent; shell execution absent; application path checks are not a sandbox |
| Worktrees / subagents / workflows | build/platform dependent | Not implemented; isolated engineering branch prepared by this task |
| Skills, hooks, plugins, context rules | documented extensibility | No arbitrary loading/execution; governed catalog integration is future work |
| Voice/session messaging on Windows | official docs mark unavailable | Not implemented |
| Fleet tools / Fabric writes | integration-dependent | Not wired into model; current scope missing; no ingestion claimed |
| Billing / identity | Meta account or API setup | No new account, key or subscription required for installed local model |

Tests do not establish model reasoning equivalence, superior performance, production readiness, authentication to remote Muse, or full MCP ecosystem conformance.
