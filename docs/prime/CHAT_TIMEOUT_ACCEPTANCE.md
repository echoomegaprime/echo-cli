# Five-minute chat acceptance and release contract

This contract covers ordinary `echo-code prime` startup (`node dist/code-main.js prime`) and one bounded chat turn. A longer chat deadline does not enlarge a provider request, tool call, child-agent lease, spending allowance or authorization scope. Successful deterministic tests and hosted CI are engineering evidence; they are not a real-model run or production admission.

## Configuration

Merge the following reviewed settings into the host's existing configuration without replacing its model endpoint, owner identity, connections, allowlists or other budgets:

```json
{
  "chat": { "turnTimeoutMs": 300000 }
}
```

Keep the existing tool budget when it is sufficient. For a workflow that needs live tools over a longer interval, this separate bounded configuration is supported:

```json
{
  "chat": { "turnTimeoutMs": 300000 },
  "tools": {
    "budget": { "calls": 12, "wallMs": 300000, "resultChars": 6000 }
  }
}
```

The second example explicitly increases only the aggregate tool wall allowance. It retains the default call count and result length. Tool wall time starts at the first tool action and includes elapsed time between subsequent tool actions. Each actual tool call remains capped at the lesser of 30 seconds and the remaining tool allowance. The parent chat deadline can end the turn first.

For initial private qualification, explicitly select the existing local Qwen model and turn Auto off. Preserve the reviewed loopback endpoint and context size; do not replace them with an unverified example address. Optional SDK, ADK, bots, Build, uploads and public ingress should be enabled only in the profiles whose admission and acceptance are being tested. A chat section alone does not attach a model or connection.

| Control | Default | Accepted limit or behavior |
| --- | --- | --- |
| `chat.turnTimeoutMs` | 120,000 ms | Integer, 1,000–300,000 ms |
| `tools.budget.calls` | 12 | Integer, 1–30; shared owner/base tool allowance |
| `tools.budget.wallMs` | 60,000 ms | Integer, 1,000–300,000 ms; independent from chat |
| `tools.budget.resultChars` | 6,000 | Integer, 500–20,000 |
| One tool call | At most 30,000 ms | Also limited by remaining aggregate time and parent cancellation |
| Standard Qwen request | 120,000 ms | Fixed by ordinary model construction |
| CLI model request | 180,000 ms | Ordinary startup does not expose a timeout override |
| Argon CLI | `--print-timeout 150s` | Additional independent vendor limit |
| Generation steps | 10; 30 with owner bot tools | Shared across rerouting within one parent request |
| Delegation | At most six task keys per parent | Four tool calls per batch; no recursive worker spawn |
| ADK default budget | 40 calls / $0 / 900 seconds | Defaults do not replace separate hard maxima or spend admission |
| Bot default budget | 80 calls / $0 / 1,800 seconds | Defaults do not replace separate hard maxima or spend admission |

The controls above are defined in [chat configuration](../../src/prime/chat.ts), [tool configuration](../../src/code/tools/config.ts), [tool execution](../../src/code/tools/runtime.ts), [model construction](../../src/code/model-factory.ts), [provider execution](../../src/code/providers.ts), [ADK](../../src/prime/agents.ts), [bots](../../src/prime/bots.ts) and [automatic delegation](../../src/code/tools/autoagents.ts).

ADK and bot input ceilings are 120 calls, $5 and 4,800 seconds, with further authority, lease and automatic-spend checks. These are not recommendations to raise a task's limits. A five-minute parent does not give a child five minutes, stop a child automatically, or prove that an already-admitted remote operation was cancelled.

`models.cli.<provider>` accepts only `model`. Invented `enabled` or `timeoutMs` keys are rejected. Browser/model chat payloads cannot override host deadlines, select an invoker, supply credentials or grant capabilities.

## Native provider admission

The default GPT subprocess path is unavailable until its native tools, MCP, apps, plugins, hooks and nested agents have a verified model-only contract. A read-only shell sandbox alone does not enforce Prime's tool allowlist or counters over a nested vendor agent.

Native Windows CLI-provider subprocesses are unavailable until an owned Windows Job Object launcher is independently qualified, including a parent that exits before its descendants. `taskkill /T` against a vanished parent does not establish that contract. Local Qwen is not a CLI-provider subprocess and is unaffected by this guard.

Availability reports identify these cases as `execution-blocked`; they do not claim a login or installation probe passed. A pinned blocked provider fails explicitly. Auto may select an available provider only through its existing pre-call routing policy. No outage fallback or permission override is introduced. Trusted programmatic host runner injection remains distinct from normal CLI/JSON configuration.

See [Provider process containment](../echo-code/PROVIDER_PROCESS_CONTAINMENT.md) for the POSIX supervisor, exact scope of process-group cleanup, cleanup-unknown reporting and restoration acceptance.

## Required acceptance evidence

Every observation must record the full source commit, tree, executable/archive hash, Node version, effective configuration digest, model identity, task/session/role/catalog admission and monotonic timings. Redact credentials and session cookies. An artifact hash, target identity digest and environment identity digest have different meanings.

| Case | Required observation |
| --- | --- |
| Startup defaults | Missing/empty chat section advertises 120,000 ms through the actual authenticated HTTP status route |
| Startup maximum | Normal CLI configuration advertises 300,000 ms; a chat section alone remains disconnected |
| Invalid configuration | Reject null, arrays, booleans, strings, fractions, out-of-range values and unknown keys before connections or state files; do not echo private values |
| Real long turn | Actual model work exceeds 120 seconds, returns a verifiably correct result before 300 seconds, and retains every independent limit; no artificial delay counts as work |
| Deadline | A turn still working at the configured deadline settles as interrupted within recorded scheduling tolerance, releases the busy state, and starts no further model/tool dispatch |
| Stop | The shipped browser Stop interaction cancels the real request; measure UI acknowledgment, server settlement and backend cancellation separately |
| Disconnect | Closing the actual HTTP client connection aborts the active turn and does not commit a late final reply |
| Late result | A deliberately uncooperative transport may finish later, but must not populate the session, tool cache or answered-model receipt after cancellation |
| Tool budget | Call count, wall time, per-call deadline, four-call batching and result length remain independent; shared owner/base allowance and rerouting cannot renew them |
| Child work | Record actual admitted child/run IDs. Measure explicit child Stop and backend terminal readback; a parent's interruption alone is not a child-stop receipt |
| Negative authority | Refuse unauthenticated/cross-origin/member owner operations, forged grant/lease fields, noncatalog capabilities and spending beyond the admitted cap |
| Provider processes | Real owned process fixtures cover resistant parent, parent-exits-first descendant, deadline, Stop, output overflow, pre-abort and cleanup-unknown attribution |
| Enabled uploads | Aggregate bytes/items, simultaneous instances/processes, interrupted streams, metadata growth and restart are bounded; existing data remains readable/deletable |

Controlled transports and owned process fixtures establish deterministic boundary behavior. They must be labeled separately from real-model and real-backend observations. If cancellation cannot undo remote work, report the run ID and outcome as unknown until readback; never resubmit a mutation automatically.

## Source and dependency gates

1. Review the actual final diff and immutable head/base/tree, including the lower stack carried by PR13. The original timeout review alone did not approve all 166 lower-stack commits or 298 files.
2. Run lint, TypeScript validation, the complete test suite and build locally. Required hosted Linux CI, Windows CI, CodeQL and Release Sentinel must succeed on the exact candidate. Earlier successful heads are historical evidence.
3. Preserve PR13's callback privacy changes. Callback query removal in the Worker, HTML URL clearing, no-referrer/no-store/CSP controls and protected callback POST require their own OAuth/privacy acceptance. The edge still receives the original incoming callback URL.
4. Verify the paired ADK runtime/catalog and fixed workspace-operation schemas against the admitted deployed version. A `proposed_not_registered` source manifest is not live registration or authorization.
5. Re-freeze artifacts and repeat affected exact-source acceptance whenever executable source, dependencies or configuration changes. A merge-only commit still needs verified parents, resulting tree and its release identity.

## Production release gates

A private exact-artifact journey may precede promotion, with `execution_scope=private_exact_artifact_acceptance` and `public_deployment_verified=false`. Private qualification does not authorize production promotion.

The production attestation must come through an admitted trusted collector and bind the exact candidate, canonical target and environment identities, and deployment identity. It must include runtime/artifact execution, exact identity readback, critical journeys, negative controls, external acceptance and at least three stability probes. Its lifetime is at most 3,600 seconds. An embedded public key is not independent trust; an unsigned observer or an intake for already-signed envelopes does not supply signing authority.

Require a freshly verified `PRODUCTION_READY` certificate for the admitted identity. A complete certificate with `NOT_READY` remains a failed release gate. The current SDK caller must have the supported `certforge.deploy.read` scope for deployment and rollback readback; do not substitute another identity, copy credentials or bypass a scope denial.

Promotion requires the verified target, paired ADK compatibility, reviewed effective configuration, recovery identity, supported signed promotion procedure and post-promotion acceptance. PR13's callback Worker has a separate promotion and rollback record. Preserve protected policies, trust material and unrelated concurrent work. Stop at an unfulfilled admission or immutable release gate while retaining a concrete recoverable candidate and evidence.
