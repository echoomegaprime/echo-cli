# Prime agents, bot controls, and delegated tasks

Updated 2026-11-07 against the current implementation. This document describes the source contract and automated test coverage. Configuration, a responding local API, catalog discovery, successful task execution, and deployment certification are separate states; none is inferred from the others.

Echo Prime exposes **19 owner-only chat tools** for discovering capabilities, creating agents and bots, managing their lifecycle, and delegating bounded independent subtasks. A parent chat turn can delegate useful work, read the child's actual run result, and use that evidence in its answer. Recurring work uses a persistent bot and a schedule. A trivial question can still be answered directly.

The main implementation is [AutoAgents](../../src/code/tools/autoagents.ts), registered in the real chat loop by [OwnerBotTools](../../src/prime/bot-tools.ts) and [SharedChat](../../src/prime/chat.ts). The browser renders returned records through [autoagents.js](../../ui/echo-prime/autoagents.js). The local service contract is [ECHO_BOTS_API_V2.md](ECHO_BOTS_API_V2.md); authenticated catalog transport is documented in [PRIME_SDK_BRIDGE.md](PRIME_SDK_BRIDGE.md).

## 1. Configuration and owner admission

The normal CLI startup path creates `AutoAgents` when the reviewed configuration supplies `adk`, `bots`, and an SDK broker. Router-based chat additionally needs `models`, and `tools.enabled: false` prevents AutoAgents from being attached to chat at startup. Direct Agents and echoBots views use their separately configured clients. See [commands.ts](../../src/prime/commands.ts).

`AutoAgents.status()` reports whether its required clients are configured; it makes no network request. `bots_status` reads the actual v2 bot health endpoint and reports `configured` separately from `available`, including returned features, connections, and budget accounting. A library host may construct `AutoAgents` with only a bot client to inspect, pause, stop, or delete existing work. Operations requiring catalog verification still refuse when ADK or SDK access is absent. The normal CLI startup requires all three clients before registering the chat service.

The [Prime server](../../src/prime/server.ts) admits the request through its session boundary and, when Workspace authentication is configured, `requireOwner`. `SharedChat` then supplies the tool context:

```ts
{owner: true, prompt, sessionId, requestId, signal}
```

These values come from the admitted host turn. Tool arguments cannot supply owner status, a parent identity, credentials, another service URL, or an approval grant. The chat request parser rejects an `owner` field. Every AutoAgents tool handler checks `ctx.owner === true` before making network or catalog requests, and `OwnerBotTools` checks admission again. A programmatic host embedding these classes must enforce its own caller admission before constructing this context.

Browser cards and the Agents/echoBots views also inspect the cached account state. Signed-out visitors and non-owner members receive an explanation instead of bot requests. UI admission is an additional check; the server remains the authorization boundary.

## 2. Exact tool catalog

All tools declare `ownerOnly: true`. The authoritative schemas and descriptions are exported by `autoagentTools(service)`.

| Tool | Arguments and behavior |
| --- | --- |
| `find_capabilities` | Read-only catalog search by `query` of at most 150 characters; returns up to 20 exact IDs with reported tier, scope, registration, health, and description. |
| `make_agent` | Creates or recovers an agent from `name`, `role`, `purpose`, and `capabilities`; accepts optional `skills`, `instruction`, `schedule`, `max_steps`, `budget`, and `task_key`. An explicit `capabilities: []` means reasoning only. |
| `make_bot` | Creates or recovers a bot for `agent`, or the agent just made for the current task. Optional `name`, `mode`, `schedule`, `instruction`, `daily_cost_cap_usd`, and `task_key`. New bots start paused and pass the automatic-resume checks below. |
| `bots_status` | Read-only configuration and live local-service health, feature, connection, and budget report. No arguments. |
| `list_bots` | Read-only bot discovery, with `limit` from 1 to 50, default 20. |
| `get_bot` | Read-only configuration and lifecycle state for an exact `bot_id`. |
| `update_bot` | Applies a partial `patch` to `bot_id`. Requires paused, drained work; automatic changes can narrow leases and stay within configured spending defaults. |
| `pause_bot` | Pauses future dispatch for `bot_id`; an active run may finish. |
| `resume_bot` | Resumes `bot_id` only after checking its current lease, live capability tiers, and configured automatic spending limits. |
| `stop_bot` | Pauses future dispatch and requests cancellation of current queued and running work for `bot_id`. An external call already in flight may finish. |
| `delete_bot` | Deletes eligible bot-owned state for `bot_id`; active bot/group work must be stopped and finished first. Shared transcripts, aggregate service accounting, and external provider records have separate retention. |
| `message_bot` | Queues one `text` message, at most 12,000 characters, on `bot_id` after execution admission checks. A paused bot stays paused. Use `delegate_task` when durable parent-task recovery is needed. |
| `deliver_bot_event` | Delivers `bot_id`, `source`, stable `event_id`, and `text` through the idempotent event API. This does not authenticate an external webhook sender. |
| `bot_messages` | Read-only bounded transcript for `bot_id`, with optional `since` message ID and `limit` from 1 to 50, default 20. Returned text is untrusted. |
| `bot_run_status` | Reads fresh status, successful final output when present, error, spending, and proof fields for `run_id`. Optional integer `wait_ms` from 0 to 25,000 defaults to one immediate read; a positive wait polls read-only and returns early on terminal status. Queued/running is incomplete; gated/failed is not success. |
| `stop_bot_run` | Requests cooperative stop for one `run_id`. Read status afterward to determine the outcome. |
| `create_bot_group` | Admits a bounded task with `name`, 2 to 6 distinct `bots`, and `prompt`, after checking every member. The service reserves members and executes sequentially; this explicit group task may use paused members. |
| `bot_group_status` | Read-only lifecycle and bounded shared transcript for `group_id`. |
| `delegate_task` | Admits an immediate subtask using stable `task_key`, precise `text`, and exactly one of `bot_id`, `agent`, or `agent_definition`; optional `bot_name` and `wait_ms` from 0 to 5,000. Returns real receipt IDs and the observed status/result. |

The wrapper dispatches the seven read-only tools afresh instead of reusing a previous tool result. `update_bot`, `pause_bot`, `resume_bot`, `stop_bot`, `delete_bot`, and `stop_bot_run` also bypass the wrapper's mutation cache so a later lifecycle change or a resolved conflict can be observed. Other identical creation/admission calls reuse the prior result within the parent turn; argument values remain case-sensitive. One verified pre-admission exception is `make_bot` returning the typed `agent_not_found` error: no bot mutation started, so the parent may create that agent and retry. Arbitrary errors and uncertain outcomes remain cached.

## 3. Chat execution and bounded delegation

The parent model invokes the tools through the normal action protocol:

```json
{"action":"tool","tool":"list_bots","args":{"limit":20}}
```

It may submit a batch with `action: "tools"` and a `calls` array. `OwnerBotTools` executes at most four calls from a batch, sequentially, and reports how many were omitted. Bot operations share the existing turn's tool allowance; registering them does not create a second allowance. Defaults are 12 tool calls, 60 seconds of tool time, and 6,000 characters per model-facing result, tunable through the reviewed tools configuration. Each owner operation is also bounded by the remaining allowance and a 30-second maximum. The chat itself defaults to a 120-second deadline and permits up to 30 model steps when bot tools are attached. An embedding host may set `SharedChatOptions.turnTimeoutMs` to an integer from 1,000 to 300,000 milliseconds; this uses the existing cancellation path and cannot be overridden in browser/model requests. These are admission and observation limits, not a guarantee that child work finishes during the parent turn.

The authenticated `/api/status` response advertises that validated limit as `chat.turnTimeoutMs`. After its bounded status/admission check, the browser starts one response timer using the advertised host limit plus 5,000 milliseconds of transport grace. The default remains 125,000 milliseconds; a missing, non-integer, or out-of-range status value uses that default. Activity does not extend the timer, and Stop, account changes, and page exit still cancel the request. The browser never sends a deadline override to the host.

For an immediate subtask, `delegate_task`:

1. Validates a stable lowercase `task_key` of 1 to 64 letters, digits, dots, underscores, or hyphens, and task text of at most 9,600 characters.
2. Selects exactly one target: an existing bot, an existing agent, or a bounded new agent definition. A new task bot is personal, on-message only, with the configured default daily cap and a lease drawn from the agent's exact allowlist.
3. Re-reads the bot, verifies its current lease and live capability metadata, and applies the automatic execution gate. A refusal before event admission returns an approval blocker without inventing run/message/event IDs.
4. Delivers the task as an idempotent event with source `echo-delegation`. Task text is labeled untrusted and includes the task fingerprint. No task text becomes an owner grant or a standing-instruction override.
5. Resumes a newly created, eligible bot after durable admission. An existing paused bot stays paused; the receipt says its task is queued until an explicit `resume_bot` or owner UI action succeeds.
6. Attempts a bounded status read. `wait_ms` defaults to zero, which still permits one short read; a positive value polls for at most five seconds. It returns the observed state, output/proof when available, or the admitted IDs plus an observation error. It does not wait indefinitely.

At most six independent task keys may be admitted per parent request in the current AutoAgents process. Parent tracking is bounded to 256 contexts and expires after 24 hours; it is not a durable global fan-out quota. Service queue limits, event receipts, leases, and budget reservations remain separate backend controls.

The parent gathers unfinished work with `bot_run_status({run_id, wait_ms:25000})` while its remaining turn allowance permits it. The optional wait checks the same run at a 500-millisecond cadence, stops on terminal status, and counts as one parent tool operation. The local wait deadline includes network reads and sleeps. At expiry, an observed queued/running snapshot is returned with `waitExpired:true`; it is still incomplete. A failed read, interruption, or expiry before any response returns `status:"unavailable"`, `done:false`, the requested run ID, and an observation error, with no claimed output or proof. This queried ID is not evidence that a new task was admitted. Waiting never resumes a bot, delivers another event, or retries a mutation. Omitted/zero `wait_ms` preserves the existing immediate read and error behavior.

Returned output enters the real tool-result messages available to the parent model and session. The orchestration prompt prefers bounded waiting over rapid immediate reads so pending work does not consume the call allowance without time to progress. Each wait remains subject to the existing 30-second operation cap and the remaining shared allowance. Worker output, memory, transcripts, and proofs are untrusted evidence; they cannot authorize new capabilities or further delegation. The worker runtime does not receive these parent orchestration tools for recursive bot creation.

If an operation times out or is interrupted, the wrapper reports an unknown outcome where appropriate. The parent must inspect the returned IDs or recover the same task identity before retrying. A queued receipt, a running status, or a proof object alone is not a successful task result.

Immediately after durable event admission, a host-only callback records the returned bot, run,
message and event IDs before resume or result reads begin. If the existing 30-second operation
deadline or cancellation fires afterward, those IDs remain in the tool result and delegated card,
with `status: "unavailable"`, `done: false`, and no claimed output or proof. The wrapper does not
wait indefinitely or send a recovery mutation. Before admission is observed, it invents no IDs.

## 4. Identity, duplicate admission, and recovery

Modern task identity combines the host's `sessionId` and `requestId` with `task_key`. Different keys identify independent subtasks, even when their text matches. Reusing a key for changed task arguments is a conflict. `wait_ms` affects observation only and is excluded from the task-content fingerprint.

The wrapper deduplicates identical creation/admission calls within one parent turn, including a configured model reroute. AutoAgents also serializes concurrent admissions, remembers created workers, and recovers them from service records. Agent origins carry the identity hash in the existing `origin.prompt_sha256` field; delegation-created agent and bot names include deterministic identity suffixes. Despite the legacy field name, the modern hash includes the parent/task context, not just the prompt text. Older programmatic calls without session/request IDs or a task key retain normalized-prompt identity: whitespace is collapsed, case is preserved, and SHA-256 is applied.

Delegated event IDs are `delegate-<task identity hash>`. The service scopes idempotency to `(bot_id, source, event_id)` and checks the canonical content hash. An identical replay returns the same message/run IDs and current status; changed content returns 409. This also allows a fresh AutoAgents instance to recover an admitted task when it has the same host identity and arguments. If status reading fails after admission, the receipt remains useful; another task must not be created to compensate for a missing read.

**A new parent request or session changes the identity.** In a later chat turn, inspect a known run with `bot_run_status`; merely reusing a task key under a new request does not recover the old task. Retention is bounded: the v2 service retains receipts for at least 24 hours and while their run is unfinished, subject to its documented capacity and pruning rules. A receipt whose run was removed reports `unavailable`. This is durable recovery within that contract, not permanent global exactly-once execution. See [event delivery and recovery](ECHO_BOTS_API_V2.md).

`make_agent` and `make_bot` also recover matching definitions instead of blindly creating duplicates. Existing agents are matched through remembered identity or origin; a name collision belonging to another task returns 409. Existing bots are matched through remembered identity or the applicable agent/name relationship. Returning an existing bot does not implicitly resume, pause, or reconfigure it. Use explicit task keys to pair an agent and bot when several independent definitions are created in the same parent request.

## 5. Capabilities, reasoning workers, and execution gates

Nonempty capability lists must contain exact IDs discovered through the live SDK catalog. Before granting them, `brokerCapabilityLookup` reads each exact ID, requires verified registration, and refuses red/orphaned/unregistered health. The SDK bridge verifies registration using detail plus an exact match in the active search result: detail alone can describe inactive entries. Missing, malformed, or invalid tiers remain `null`; they are never coerced to tier 0. `resolveAll` accepts integer tiers 0 through 3 and treats anything else as unknown.

One `delegate_task` invocation reuses that verified metadata across its agent creation and admission
checks; each entry expires 30 seconds after lookup starts. The snapshot is private to that invocation
and is never supplied by model arguments or reused by a later operation. Bot state, agent allowlists,
leases and spend are read again before admission, and the worker's SDK gate independently validates
each actual capability call. This removes repeated catalog latency without granting execution scope.

The paired current ADK service can resolve a capability missing from its local registry through its authenticated `GateBroker`: it verifies exact active membership and metadata, then registers that definition locally. Absence from the builtin registry is therefore not an unconditional refusal for a verified SDK capability. Unknown, inactive, unhealthy, conflicting, or incomplete metadata still fails closed. Catalog discovery does not prove that the configured credential has execution scope or that a downstream handler/provider works. It does not register new global SDK capabilities or manufacture scope names.

An explicit `capabilities: []` is supported for a pure reasoning worker, with `lease.scopes: []`. Such a worker can use its configured model and supplied context but cannot call external capabilities. This is not a substitute when the requested task requires an unavailable external tool: that missing capability must be reported. An empty list still needs a working model provider and remains subject to run and spend budgets.

New bots start paused. `make_bot` requests automatic resume only when all declared capabilities have verified numeric tier 0 or 1 and the daily cap does not exceed `bots.defaultBudget.max_cost_usd`, which defaults to zero. Unknown or higher tiers, or a larger daily cap, produce approval reasons. A refused resume is reported; it does not trigger a fallback.

Automatic message/event admission, delegation, `resume_bot`, and group admission additionally inspect the current bot lease and agent run allowance. Lease scopes must be inside the agent allowlist; the daily cap and effective run-cost allowance must fit the configured automatic defaults. A proposed delegated agent's run budget is checked before creation. Model-generated grants, tier claims, or approval flags are not accepted. With an empty capability list there is no capability-tier blocker, but the same cost and service checks still apply.

Owner UI actions use the normal protected control routes. An approval button requests an owner action; it does not override the backend's policy, credential scopes, HMAC requirements, provider authorization, or budget enforcement. Trusted SDK signing is configured separately as described in [PRIME_SDK_BRIDGE.md](PRIME_SDK_BRIDGE.md), never supplied through tool arguments.

## 6. Definition, schedule, and budget limits

| Field | Current behavior |
| --- | --- |
| Agent name | Normalized to a lowercase slug of 2 to 63 characters. Delegation adds a deterministic identity suffix to generated worker names. |
| Role | `commander`, `architect`, `observer`, `builder`, `publisher`, `enhancer`, `researcher`; delegation defaults to `researcher`. |
| Purpose/instruction | Purpose is at most 400 characters and is folded into the agent instruction. Combined instruction is at most 12,000 characters. |
| Capabilities/skills | 0 to 64 exact capability IDs, deduplicated; skill names are bounded to 32 and validated by the ADK client. Installed skill availability is a separate service configuration. |
| Lane | New agents use `forge` / `qwen-local`. There is no automatic paid-model fallback. |
| Run budget | Uses configured ADK defaults, initially 40 calls, $0, and 900 seconds; service/client ceilings are 120 calls, $5, and 4,800 seconds. Numeric values are clamped; malformed values are refused. |
| Steps | Default 12, bounded to 1 through 24 for these tools. |
| Bot name/mode | Name at most 64 characters; mode `personal` or `team`. |
| Bot daily cap | $0 through $5, defaulting to the configured bots allowance. Automatic tools apply the stricter configured-spend checks above. |
| Initial bot lease | Exact agent capability IDs, TTL 3,600 seconds, and maximum 100 uses; an empty list grants no capabilities. The model cannot supply arbitrary creation grants. |

Schedules support on-message only (`null`), intervals of 60 through 604,800 seconds, or an IANA local-time calendar:

```json
{"at":"09:00","tz":"America/Chicago","weekdays":[1,2,3,4,5],"missed":"skip"}
```

Weekdays are ISO Monday 1 through Sunday 7. `missed` is `skip` or `once`; calendar schedules default to `skip`. The backend skips nonexistent daylight-saving local times and runs an ambiguous local time once. `make_agent` and `make_bot` additionally accept an integer number of minutes, 1 through 10,080, as interval shorthand. The agent's schedule is planning metadata retained for the paired `make_bot`; it is not sent as an unsupported agent-definition field. Bot update requests use the validated schedule object or `null`. See [the v2 schedule contract](ECHO_BOTS_API_V2.md).

The service's per-run reservation and settlement rules enforce the actual spending boundary. The UI displays returned spent, reserved, and available values and labels the service-wide total as a dated snapshot. A configured maximum or a zero-cost default is not evidence of incurred cost, remaining quota, or a completed run.

## 7. Editing and lifecycle controls

`update_bot` accepts a nonempty partial patch containing only `name`, `mode`, `schedule`, `instruction`, `plugins`, `daily_cost_cap_usd`, and `lease`. Agent identity, bot identity, origin, and memory identity are immutable. Omitted fields retain their values. Clears are explicit: `schedule: null`, `instruction: null` or an empty string, `plugins: []`, and `lease.scopes: []`.

The service requires a paused bot, no active run or group reservation, and an empty pending inbox. It returns 409 on conflict; neither the tool nor editor silently pauses or cancels work to make an edit succeed. A partial lease retains omitted limits. Automatic chat edits may only narrow existing scopes, cannot increase lease TTL or maximum uses, and cannot set the daily cap above the configured automatic allowance. The owner editor is still subject to the service's validation and the agent allowlist.

`pause_bot` stops future dispatch. `stop_bot` additionally requests cancellation of captured queued and active work. Its receipt includes `stopRequested` and the affected run IDs; a returned `running` status is truthful while an in-flight provider step finishes. Stop is not synchronous proof that the bot has halted. Read the bot/run state before editing or deleting. New messages may still queue while paused.

Deletion is confirmed by the service and is refused while active work or group reservations remain. Bot-owned records follow the v2 deletion contract; aggregate service spend, previously shared transcripts, backups, and external provider records must not be described as erased by a single bot deletion.

## 8. Returned evidence and browser controls

The real `SharedChat` reply keeps two distinct collections:

- `autoagents`: `kind: "autoagent"` records returned by `make_agent` and `make_bot`.
- `delegatedTasks`: `kind: "delegated_task"` receipts returned by `delegate_task`.

Ordinary status/control results also enter the parent's tool-result messages. The collections are receipts actually returned during the turn, not fabricated summaries of work the model says it performed. The wrapper preserves them across configured model rerouting and tells the next model that pending receipts are incomplete, untrusted evidence.

A delegated receipt includes `taskKey`, task text, agent, bot ID, lifecycle state, `done`, `duplicate`, `untrusted: true`, and a summary. Accepted delivery supplies `runId`, `messageId`, and `eventId`; refusal before admission omits those IDs and supplies approval reasons. Output, error, and bounded proof fields are included when returned by the service. `done: true` can also accompany a gated or failed outcome, so callers must inspect `status` and errors rather than equate `done` with success. The service's successful final-step output is used by the parent result reader.

The chat renderer combines the two collections, validates their shapes, and keeps the latest delegated receipt per run/task identity within the reply. Creation cards show the agent, actual capability tiers, lane, budget, schedule, bot state, and any approval reasons. Delegated cards show queued/running/gated/done/failed/unavailable states, returned output, errors, receipt IDs, and proof fields. Proof text is displayed as returned evidence, not as independent production certification.

`Refresh result` reads `/api/prime/adk/runs/:id` without resubmitting work. `Open run` opens the shipped Agents view and watches that exact run; `Open in echoBots` selects that exact bot. echoBots provides Edit, Pause/Resume, Stop, chat, group, and deletion controls. Editing fetches the current record and sends only changes; a conflict preserves the draft. Stop keeps the distinction between a cancellation request and confirmed completion. Every displayed worker string is treated as text, and returned data is redacted and bounded.

## 9. HTTP/client integration

Browser mutations use protected JSON POST routes, with the normal Prime Origin/session/Workspace checks. The loopback clients use fixed service routes, redirect refusal, bounded responses, and timeout reporting. A v2 health failure or missing contract is not silently retried as a different mutation.

| Prime route | Local service operation |
| --- | --- |
| `GET /api/prime/bots/health` | `GET /v2/health` with contract version 2 verification |
| `GET /api/prime/bots/list`, `GET /api/prime/bots/:id` | `GET /v2/bots`, `GET /v2/bots/:id` |
| `POST /api/prime/bots/create` | `POST /v2/bots` |
| `POST /api/prime/bots/:id/update` | `PUT /v2/bots/:id` |
| `POST /api/prime/bots/:id/stop` | `POST /v2/bots/:id/stop` |
| `POST /api/prime/bots/:id/events` | `POST /v2/bots/:id/events` |
| `POST /api/prime/bots/:id/pause`, `/resume` | Corresponding v2 bot transition |
| `POST /api/prime/bots/:id/message`, `GET /api/prime/bots/:id/messages` | Existing bot message/transcript routes |
| `POST /api/prime/bots/:id/delete` | `DELETE /bots/:id` |
| `POST /api/prime/adk/agents` | `POST /agents` |
| `POST /api/prime/adk/agents/:name/update`, `/delete` | `PUT /agents/:name`, `DELETE /agents/:name` |
| `GET /api/prime/adk/runs/:id`, `POST /api/prime/adk/runs/:id/stop` | `GET /runs/:id`, `POST /runs/:id/stop` |

The [BotsClient](../../src/prime/bots.ts) and [AdkClient](../../src/prime/agents.ts) validate request bodies and receipt identities. They preserve upstream 409 conflicts; `AdkError.detail.http` also retains the raw upstream status. Requests do not smuggle model-supplied tokens or grants into the bot service. SDK transport credentials are configured separately on the host.

## 10. Examples

### Immediate reasoning subtask

For a useful independent review of information already supplied by the owner, the model can submit:

```json
{
  "action": "tool",
  "tool": "delegate_task",
  "args": {
    "task_key": "review-schedule-assumptions",
    "text": "Review the supplied schedule assumptions for contradictions. Use only the information in this task; list unresolved questions.",
    "agent_definition": {
      "name": "schedule-reviewer",
      "role": "researcher",
      "purpose": "Review supplied schedule assumptions without external tools",
      "capabilities": [],
      "budget": {"max_calls": 4, "max_cost_usd": 0, "max_wall_s": 120}
    },
    "wait_ms": 1000
  }
}
```

The host supplies owner and parent identity. The result may be queued, running, terminal, or blocked. The parent uses the returned `runId` with `bot_run_status` before relying on completion. This example grants no network, shell, browsing, or other external capability and assumes a working configured local model.

### Recurring work with real capabilities

First call `find_capabilities` with the task's needs and inspect the returned exact IDs. Create an agent with those verified IDs and a stable task key. Create its bot using the same task key and a calendar such as `09:00 America/Chicago` on weekdays. Do not substitute example names for real catalog IDs, infer a tier from an ID, or replace a missing required capability with an empty list. The returned bot record determines whether automatic resume succeeded or owner review is required.

### Stop, verify, then edit

Read `get_bot`, call `stop_bot` if current work must be cancelled, and inspect the affected runs until the service confirms the bot is paused and drained. Then use `update_bot` with only the intended patch, for example `{"instruction":null,"lease":{"scopes":[]}}`. A 409 means outstanding work still prevents editing. No automatic retry, permission expansion, or paid fallback is implied.

## 11. Evidence and remaining boundaries

Automated coverage includes [delegation and lifecycle HTTP fixtures](../../tests/prime-delegation.test.ts), [the real parent chat loop](../../tests/prime-bot-chat.test.ts), [owner wrapper budgets and duplicate handling](../../tests/prime-bot-tools.test.ts), [bot client validation](../../tests/prime-bots.test.ts), and the [bot](../../tests/prime-bots-ui.test.ts) and [delegated-card](../../tests/prime-autoagents-ui.test.ts) UI suites. These verify returned evidence propagation, owner refusal before network access, stable task recovery across AutoAgents instances, explicit empty capabilities, spend/tier blockers, state controls, and no duplicate admission after failed observation. SDK contract and signer tests are documented separately in [PRIME_SDK_BRIDGE.md](PRIME_SDK_BRIDGE.md).

Fixture success does not establish that a live API key has the necessary scopes, a local model is installed and healthy, privileged handlers are usable, or a deployed service is running this revision. `configured: true` establishes attached clients; v2 health reports the local service's own state. Runtime operation receipts and separate deployment evidence are needed for stronger claims. Local memory readiness does not establish shared Crystal/ECF delivery, and the bot service does not create a per-bot browser or OS sandbox. Installed skills require their own host configuration and do not automatically execute bundled scripts.

This implementation has no measured quality ranking against Grok Bots or another product. Such a comparison needs a defined task set, matched permissions/resources, recorded outcomes, cost/latency measurements, and a reproducible evaluation. No deployment, live privileged execution, or comparative benchmark is certified by this document.
