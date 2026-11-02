# Behavioral specification

## Reference findings

OBSERVED in the public SDK source at the pinned commit:

- `connection/connection.ts` owns wire request/response handling. `connection/spawn.ts` launches the Muse host and classifies process termination.
- `facade/client.ts` opens and resumes sessions. `facade/session.ts` composes event folding, turns and pending commands. The SDK is a client of the engine, not the engine itself.
- `facade/approval.ts` routes decisions to the host. `pending/pending-command-set.ts` tracks client intent separately from durable server facts.
- `fold/` reconstructs views from events. `facade/gap-fill.ts` pages missing events and reconciles their overlap. `facade/host-death.ts` distinguishes durability profiles instead of assuming every session survives.
- `fingerprint.ts` pins the published stable schema and warns about runtime mismatch. The embedded installed schema exactly matches this public snapshot.
- The TypeScript package is 1.4.10, MIT, Node >=20, with no runtime dependencies in its manifest. The repository also contains a Python 1.4.10 facade requiring Python >=3.10 and exact-pinned pydantic. Python's package metadata labels it alpha; publication is not a conformance guarantee.

OBSERVED in installed help / official documentation: interactive and headless coding, project context, provider/model selection, explicit approvals, OS sandbox, skills/hooks/plugins, MCP, worktrees, resuming/exporting sessions and a versioned programmatic protocol. Feature availability varies by build/platform. Official Windows documentation marks voice and session messaging unavailable there. We did not exercise paid Muse reasoning, sandbox enforcement, parallel workflows or external connectors.

UNKNOWN: proprietary engine implementation, system prompts, model weights/training, internal scheduler, actual sandbox isolation strength, live paid-provider performance and complete production parity. These were not inferred from SDK code.

## ECHO Code 0.1 contract

Independent local agent: `echo-code run <prompt>`, `chat`, `doctor`, `sessions`, `show`, `review`, `reject`, `approve`, `revert`, `recover`, `mcp`, `memory prepare/status/sync`. Standalone entry avoids the older SDK client's credential/config initialization. It uses only the existing Commander dependency and Node built-ins.

Inference is a bounded, non-streaming Ollama JSON action loop at a credential-free loopback origin. No remote/public origin, redirect, API key, hosted fallback or model download is implemented. Cloud-named models are refused. This assumes the selected local daemon/model is operator-controlled; an operator-configured proxy or misleading alias is outside the application's trust boundary.

Default actions: directory list, bounded UTF-8 read, literal search and final answer. A proposal is permitted only when the caller explicitly selects `--mode propose` (`mode: 'propose'` in the library API); the default is `read-only`. Mode is validated before model calls, applied in the dispatcher before proposal construction, and returned in the turn result. Prompts and previous sessions cannot grant proposal permission. Chat uses its selected mode for all turns in that invocation; a new invocation defaults back to read-only. Read-only turns preserve existing pending proposals and still persist local transcripts. Read is limited to 64 KiB, directory listing to 150 entries, search to 500 visited entries / six levels / 40 hits. Context has a byte budget; model steps are 1-30, default 10; requests have timeouts and response-size limits. There is no shell or deployment action.

A successful proposal ends the turn with application-generated `pending_approval`. It never writes source. The model's final prose is explicitly labeled unverified. A separate, explicit approve invocation applies one selected proposal only if the original hash still matches. One file is staged per successful proposal turn. Parent directories must already exist; large/binary files are outside this version's scope.

Sessions: UUID IDs, real workspace binding, model binding, atomic temporary-file replacement, flush before rename, size limits and exclusive lease files. Transcripts/proposals survive process restart in local JSON. Status is idle/running/completed/pending_approval/failed/step_limit/interrupted. Proposal status is pending/applying/applied/reverting/reverted/rejected. Recovery checks owner-process liveness and content hashes; uncertain/conflicting states require manual review. This is not a guarantee against storage failure or every power-loss pattern.

Edit recovery: before/after hashes distinguish an interrupted write from an unapplied proposal; reverting is journaled too. Neither resume nor recover reruns a model-produced write. Revert preserves later user edits by refusing a changed file. File operations are synchronous and recheck before replacement; hostile concurrent filesystem races are not contained by an OS sandbox.

MCP: a local stdio server exposing only echo_code_list/read/search, initialize, ping, tools/list and tools/call; protocol profile 2024-11-05. JSON-RPC responses remain on stdout. It is not an MCP client and cannot call fleet tools. No HTTP server, remote authentication or MSP compatibility is claimed.

Project AGENTS/CLAUDE instructions are not automatically loaded as model instructions. Protected policy files remain an operator/preflight responsibility. No project hooks, plugin code, package scripts or repository commands are executed by the agent. ECHO target engineering still requires its doorway chain and current preflight; this application is not an admission controller.

Explicit checkpoints: caller-supplied summaries only, stable session-bound request IDs, atomic local pending state, existing host SDK capture, strict receipt validation and independent exact-event recall. Fixed capture/recall capabilities are never model tools. The standalone broker is absent; current live write scope is denied. Pending, uncertain, saved and verified states remain distinct; deadlines do not imply cancellation of remote effects. See CONTINUITY_2026-10-26.md for the complete contract and evidence limits.
