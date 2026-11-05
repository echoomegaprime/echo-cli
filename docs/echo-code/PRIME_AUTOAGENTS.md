# Prime autonomous agents and bots (autoagents)

Status: built 2026-11-04 on `agent/prime-autoagents-20261104` (base f421473). Drafting: first draft by Gemini (`wrap.sh draft gemini`, `gemini-4-argon-medium`, second run after a 150 s print timeout), cross-checked against a GPT draft (`wrap.sh draft gpt`, `gpt-6-astra`), then reviewed and corrected against the code by the integrating builder. Facts below are the implemented behaviour; the real `echo-adk-api` was not called.

## 1. What it does

Autoagents implements the Commander order of 2026-11-04: "Have it so Echo autonomously makes ADKs and echoBots for tasks from the user's prompts."
Echo Prime is a local web UI and Node/TypeScript server whose chat model can call three owner-only tools from `src/code/tools/autoagents.ts`: `find_capabilities`, `make_agent` and `make_bot`.
These tools look up live capabilities through the SDK broker, create validated Echo ADK agent definitions through the loopback `echo-adk-api`, and create paused echoBots with dedicated capability leases.
Zero-cost bots using only tier 0 or tier 1 capabilities are resumed by Echo; higher-tier, untiered or non-free bots stay paused behind an approval card in the chat.
Prime runs headless with no silent fallback, never handles tokens, never shares a lease between bots, and redacts every string before it reaches the UI.

## 2. When the model uses it

`AUTOAGENTS_PROMPT_FRAGMENT` (exported from the module; the brain slice includes it in the system prompt with one line) tells the model, in substance: use the tools when the user asks for work that is ongoing, recurring, scheduled, delegated or multi-step, or explicitly asks for an agent or a bot; call `find_capabilities` first, then `make_agent`, then `make_bot`; never use them for a one-shot question or work that finishes in the current turn; use only capability ids the catalog returned and never invent or alter one; prefer the free local lane and the smallest budget; bots start paused and the tool result says whether Echo resumed it or the owner must approve; always finish by summarising what was built; when a tool refuses, say so plainly and do not retry with different ids. The exact text:

> Autonomous agents and bots (owner only). When the user asks for work that is ongoing, recurring, scheduled, delegated or multi-step (for example "every morning", "keep watching", "each time", "take over", "monitor", "report weekly") or explicitly asks for an agent or a bot, build it: call find_capabilities to see the live catalog, call make_agent (name, fleet role, purpose, exact capability ids, skills, instruction, max_steps, budget), then call make_bot for that agent (schedule, mode, instruction, daily_cost_cap_usd). Never use make_agent or make_bot for a one-shot question, a single answer or work you can finish in this turn. Use only capability ids returned by find_capabilities; never invent, guess or alter an id, and when a needed capability is not in the catalog say so instead of substituting one. Prefer the free local lane (qwen-local, cost 0) and the smallest budget that fits. Bots start paused; the make_bot result says whether Echo resumed it or whether the owner must approve it first. Always finish by summarising what you built: agent name, role, capabilities with their tiers, schedule, budget, and whether the bot is running or waiting for approval. If a tool refuses (unknown capability, not the owner, service off), tell the user plainly and do not retry with different ids.

One-shot questions never qualify and are answered directly without any autoagent tool call. The module enforces its own rules regardless of what the model does: an invented id is refused by `make_agent`, and a non-owner is refused by every tool.

## 3. Pipeline

1. `find_capabilities({query})` returns live catalog rows (id, tier as the catalog reports it, scope, registered, health, description) through the SDK broker so the model selects real `echo.*` ids. Read-only; up to 20 rows; the query is at most 150 characters (the broker's own limit).
2. `make_agent({name, role, purpose, capabilities[], skills?, schedule?, instruction?, max_steps?, budget?})` resolves every capability through `brokerCapabilityLookup(sdk)` (`sdk.read` of the exact id), applies the drafting rules below, checks idempotency, and creates the agent with `POST /agents` (or returns the existing one).
3. `make_bot({agent?, name?, mode?, schedule?, instruction?, daily_cost_cap_usd?})` verifies the agent with `GET /agents/{name}`, re-resolves its capabilities, creates the bot with `POST /bots` (paused by contract, lease = exactly the agent's capability ids) and applies the auto-resume gate; it resumes the bot with `POST /bots/{id}/resume` only when the gate allows.
4. Each `make_*` call returns an `AutoagentBuilt` record (`{kind:"autoagent", tool, promptSha256, agent, bot?, summary}`). The tool loop attaches these to the chat turn result under `autoagents` (an array); `chat.js` then calls `window.EchoPrimeAutoagents.render(result)` and one card is appended per record. The `summary` is plain text the model can relay.

## 4. Drafting rules

| Field | Rule |
| --- | --- |
| `name` (agent) | Slugified by `slugName`: NFKD, lowercase, non-alphanumerics to `-`, trimmed, at most 63 characters; must then match `^[a-z0-9][a-z0-9-]{1,62}$` or the call is refused. `"Queue Scout!"` becomes `queue-scout`. |
| `role` | Required; one of `FLEET_ROLES`: `commander`, `architect`, `observer`, `builder`, `publisher`, `enhancer`, `researcher`. |
| `purpose` | Required, at most 400 characters. Folded into the agent `instruction` as `Purpose: <purpose>`, a blank line, then the optional `instruction` (the `EchoAgent` contract has no purpose field and the service refuses unknown keys). The card shows it as "Purpose". |
| `capabilities` | 1 to 64 exact ids matching `^echo\.[a-z0-9_.]+$`, deduplicated. Each is resolved with `sdk.read`: the detail must answer for the same id, be `registration_state: "registered"`, and its health must not be `red`, `orphaned` or `unregistered`; the tier is read from the detail (`tier` or `danger_tier` on the capability, its metadata, the record or the record metadata), never from the search row, whose missing tier the broker coerces to 0. Any unknown id refuses the whole call with `Unknown capability id: <ids>. Only ids present in the live catalog can be granted; nothing was created.` A malformed id is refused before the catalog is asked. |
| `skills` | Optional; at most 32 strings matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` (Agent-Skills directory names), deduplicated. |
| `schedule` (agent) | Optional: `null`, `{every_s >= 60}` or a whole number of minutes. Not an `EchoAgent` field, so it is never sent to the service; it is carried on the built record (the card shows it) and becomes the default schedule of `make_bot` for the same prompt. |
| `instruction` (agent) | Optional text; with the purpose prefix the total is at most 12000 characters. |
| `lane` | Always `{node: "forge", model: "qwen-local"}`: the free local lane, cost 0 by default. |
| `budget` | `{max_calls, max_cost_usd, max_wall_s}` clamped by `clampAdkBudget` to the service caps 120 calls, 5 USD, 4800 s; missing keys take the `adk` config defaults (40, 0, 900). A non-numeric value is refused, not guessed. |
| `max_steps` | Clamped to 1..24; default 12. |
| `origin` | `{by: "echo", prompt_sha256: <normalised prompt hash>, created_at: <ISO time>}`. |
| `agent` (bot) | Defaults to the agent `make_agent` created for this prompt; must match the slug regex; `GET /agents/{name}` must succeed (a 404 refuses with "create it with make_agent first", code `agent_not_found`). An agent with no capabilities is refused (no lease can be drafted). |
| `name` (bot) | Defaults to the agent name; at most 64 characters. |
| `mode` (bot) | `personal` or `team`; default `personal`. |
| `schedule` (bot) | `null`, `{every_s >= 60}` or a whole number of minutes (60 means every hour); when omitted, the schedule given to `make_agent` for this prompt applies, else `null` (on message only). |
| `daily_cost_cap_usd` | Defaults to the `bots` config `defaultBudget.max_cost_usd` (0 unless raised); must be between 0 and 5. |
| `lease` (bot) | `{scopes: <exactly the agent's capability ids>, ttl_s: 3600, max_uses: 100}`; each bot owns its own lease (spec invariant R3). The model cannot supply a lease: `lease` is an unknown argument for both tools. |
| `instruction` (bot) | Optional, at most 12000 characters, forwarded as the bot's standing instruction. |

Service facts honoured (echoomegaprime/echo-adk PR #1, head 1056da9): a capability must already be in the service's default-deny registry; when the catalog knows an id the registry lacks, the service answers 4xx `invalid` and Prime passes that refusal through (`AdkError.detail.http` keeps the raw status) without substituting anything. `gated` is only a run status, never an HTTP error code. `PUT /agents/{name}` answers 404 for a missing agent and never creates one. `DELETE /agents/{name}` answers 409 `invalid` while a bot references the agent. An unknown agent on `POST /runs` answers 404.

## 5. Gating policy

Every bot is created paused by the service contract.
Auto-resume is requested only when every capability of the agent reports a numeric tier of at most 1 (`AUTOAGENT_LIMITS.autoResumeTier`) and `daily_cost_cap_usd` is at most the configured bots default (`defaultBudget.max_cost_usd`, 0 unless the reviewed config raises it, so by default only free bots are resumed by Echo).
The gate fails closed: a capability with no reported tier counts as not auto-approvable; a tier of 2 or higher, or a cap above the default, keeps the bot paused.
A paused result carries `bot.approval = {required: true, reasons: [...]}` with one reason per cause, for example `echo.shell.run is tier 2 (auto-resume allows tier 0 or 1)`, `echo.odd.cap has no reported tier (treated as not auto-approvable)`, `daily cost cap $1.50 exceeds the configured default of $0.00`. The card renders these in an approval box with an "Approve and resume" button; resuming from the card is the owner's explicit approval and goes through the normal owner-only bot route.
If the service refuses the resume, the bot stays paused, the refusal is recorded as a reason (`resume was refused: ... (the bot stays paused)`) and nothing is retried.
An existing bot returned by a re-ask is never resumed or paused by the tool; its current status is reported.

## 6. Idempotency

`promptSha256(prompt)` trims the prompt and collapses whitespace runs to one space (case kept), then hashes with SHA-256; a re-ask with different spacing hashes the same, a re-worded prompt does not.
`make_agent` first consults an in-memory map (prompt hash to `{agent, botId, schedule}`) for the process, then scans `GET /agents` for a definition with `origin.by === "echo"` and `origin.prompt_sha256` equal to the hash; a match is returned with `existing: true` and no `POST /agents` is made, even when the model proposed another name.
When `POST /agents` answers 409 (the name exists), the named agent is returned as existing only if its `origin.prompt_sha256` equals this hash; otherwise the call refuses with code `name_taken` ("An agent named X already exists and was not made from this request; choose another name.") rather than inventing a variant.
`make_bot` returns the bot remembered for the prompt, else any listed bot whose `agent` equals the agent name (the `Bot` contract has no origin field), with `existing: true` and no second `POST /bots`.

## 7. Owner-only and admission

All three tools declare `ownerOnly: true`. The host passes `ctx = {owner, prompt, signal?}` where `owner` comes from its real admission (the `/api/chat` route already sits behind `requireOwner`; the tool checks again), never from model text or the browser.
When `ctx.owner !== true` the call refuses before anything is requested: HTTP-shaped 403, code `owner_only`, message "Only the owner can create agents and bots. Ask the primary owner to create this for you."
When the Prime config lacks `adk`, `bots` or `sdk`, `status()` names the missing sections and every tool refuses with 503, code `off`; the hub offers no tools at all.
In the UI a signed-in member or a visitor never sees a card: `render()` appends one explanation ("Agents and bots are owner-only ... Nothing was created for your account") and fetches nothing. The Agents and echoBots views keep their own owner gating.

## 8. Routes and client methods

| Component | Method or route | Contract |
| --- | --- | --- |
| `AutoAgents` (`src/code/tools/autoagents.ts`) | `findCapabilities`, `makeAgent`, `makeBot`, `tools()`, `status()` | The tool operations, the `ChatTool[]` in registration shape, and config readiness. Options: `adk`, `bots`, `caps` (a `CapabilityLookup`), `events` (sink for tests), `now`. |
| `AdkClient` (`src/prime/agents.ts`) | `createAgent(def)` | `POST /agents` (201). Validated by `parseAgentDefinition` (name regex, cap-id regex, skills, lane, budget clamp, `max_steps` clamp, origin). The reply must answer for the same name. |
| `AdkClient` | `updateAgent(name, def)` | `PUT /agents/{name}` (200); the body name must equal the path name; 404 when missing, never creates. |
| `AdkClient` | `deleteAgent(name)` | `DELETE /agents/{name}`; requires `{name, deleted: true}`; 409 `invalid` while a bot references the agent is passed through. |
| `AdkError.detail.http` | | The service's raw status (409, 422, ...) next to the mapped Prime status (400/404/502) and the contract code. |
| `PrimeHub` (`src/prime/hub.ts`) | `adkCreateAgent`, `adkUpdateAgent`, `adkDeleteAgent`, `autoagentTools()`, `autoagentsStatus()` | Facade; `autoagentTools()` is `[]` when the feature is off. |
| Server (`src/prime/server.ts`) | `POST /api/prime/adk/agents` | Owner-only JSON POST, 201. |
| Server | `POST /api/prime/adk/agents/:name/update` | Owner-only JSON POST, 200. |
| Server | `POST /api/prime/adk/agents/:name/delete` | Owner-only JSON POST, 200 (a POST, like bots, so the Origin check applies; `GET` on these paths is 405). |
| `commands.ts` | | Builds `AutoAgents` only when `adk`, `bots` and the SDK broker all exist. |

## 9. UI

`ui/echo-prime/autoagents.js` and `autoagents.css` render the cards; `chat.js` calls `window.EchoPrimeAutoagents.render(result)` after the assistant line when `result.autoagents` is an array (one additive line).
Card titles: "Echo built an agent and a bot for this", "Echo built an agent for this", "Echo already had an agent and a bot for this", "Echo already had an agent for this", and after a delete "Echo removed this agent (and its bot)".
A card shows the agent name, role, purpose, capabilities with tier badges (`tier 0` ... `tier 3`, `tier unknown`), lane, budget, max steps, schedule, the bot name, mode, status badge (`paused`, `idle`, `running`, `error`), daily cap, and the approval box with its reasons when the gate kept the bot paused. The "Echo-made from your prompt" badge appears when `origin.by === "echo"`.
Buttons: Resume (labelled "Approve and resume" when the gate paused it) or Pause, Open in echoBots (writes `localStorage` `echo-prime-bot-v1` and calls `EchoPrimeBots.open()`, which reopens the remembered bot), Open agent (`EchoPrimeAgents.open()`), Delete (inline two-step: "Confirm delete" / "Cancel", no `window.confirm`; the bot is deleted first, then the agent definition; a failure reports how far it got and makes no retry). Every request carries the Prime headers and the owner's CSRF header; a 401/403 invalidates only a session that claimed owner.
`agents.js` (agent cards) and `bots.js` (bot cards) show "Echo-made from your prompt" when a record carries `origin.by === "echo"` (one additive line each).
`echo-orb-satellites` is dispatched on `window` as a `CustomEvent` (a plain `Event` with `detail` when `CustomEvent` is absent) with `{source, action: created|resume|pause|delete, botId, status}` when a newly created bot is rendered, when the echoBots create form creates one, and on resume, pause and delete; the orb module may listen for it.

## 10. Examples

### Example 1: recurring morning report (free bot, auto-resumed)

Prompt: "Every morning at 7 check the FORGE build queue and summarise what is stuck." `echo.knowledge.search` and `echo.context.recall` stand for registered ids that the catalog reports as tier 0 and tier 1.

```json
[
  { "tool": "find_capabilities", "args": { "query": "build queue" } },
  { "tool": "make_agent", "args": { "name": "Queue Scout", "role": "observer", "purpose": "Watch the FORGE build queue each morning", "capabilities": ["echo.knowledge.search", "echo.context.recall"], "skills": ["echo-observer-power"], "schedule": 1440, "instruction": "Report stuck builds only." } },
  { "tool": "make_bot", "args": { "name": "Queue scout" } }
]
```

Outcome: agent `queue-scout` (lane `qwen-local` on `forge`, budget 40 calls / $0.00 / 15 min, 12 steps, `origin.by: "echo"`) is created; the bot is created paused with lease scopes exactly those two ids, every tier is at most 1 and the cap ($0.00) is within the default, so Echo resumes it: status `idle`, every 1440 min. The card says "Echo built an agent and a bot for this" with a Pause button.

### Example 2: a task that needs `echo.shell.run` (tier 2, paused for approval)

Prompt: "Run the nightly shell cleanup." The catalog reports `echo.shell.run` as tier 2.

```json
[
  { "tool": "find_capabilities", "args": { "query": "shell" } },
  { "tool": "make_agent", "args": { "name": "shell-scout", "role": "builder", "purpose": "Clean stale temporary build directories nightly", "capabilities": ["echo.knowledge.search", "echo.shell.run"] } },
  { "tool": "make_bot", "args": { "schedule": { "every_s": 86400 } } }
]
```

Outcome: agent and bot are created; the bot stays `paused` with `approval: {required: true, reasons: ["echo.shell.run is tier 2 (auto-resume allows tier 0 or 1)"]}` and no resume is requested. The card shows the approval box and "Approve and resume"; the owner's click is the approval.

### Example 3: a one-shot question (no tool call)

Prompt: "How does Echo Prime clamp agent budgets?"

```json
[]
```

Outcome: no autoagent tool runs, `result.autoagents` is absent, no card is rendered; the model answers in plain chat text.

## 11. Debug events

With `NODE_DEBUG=echo-prime` (or the injectable `events` sink used by the tests), the module logs:

- `prime_autoagent_agent_created` (`name`, `role`, `capabilities`, `tiers`, `promptSha256`)
- `prime_autoagent_agent_existing`
- `prime_autoagent_bot_created` (`botId`, `agent`, `scheduled`, `dailyCapUsd`, `status`)
- `prime_autoagent_bot_resumed`
- `prime_autoagent_bot_paused_for_approval` (`reasons`)
- `prime_autoagent_bot_existing`
- `prime_autoagent_refused` (`reason`: `owner_only`, `off`, `unknown_capability`, `name_taken`, `agent_not_found`)

The client adds `prime_adk_agent_creating`, `prime_adk_agent_created`, `prime_adk_agent_updated`, `prime_adk_agent_deleted`. The UI logs `[echo.autoagents]` debug entries (`render`, `resume`, `pause`, `delete`, `satellites`, `invalidated`).

## 12. Integration contract and what is not done here

Exports of `src/code/tools/autoagents.ts`: class `AutoAgents` (`makeAgent`, `makeBot`, `findCapabilities`, `tools()`, `status()`), `autoagentTools(service)` returning `ChatTool[]` (`{name, description, inputSchema, ownerOnly: true, run(args, ctx)}`), `AUTOAGENTS_PROMPT_FRAGMENT`, `FLEET_ROLES`, `AUTOAGENT_LIMITS`, `promptSha256`, `slugName`, `brokerCapabilityLookup`, `AutoagentError`, and the types `ToolContext`, `ChatTool`, `CapabilityLookup`, `AutoagentBuilt`.

For the tool loop and the brain slice (one line each):

1. Tools: `tools.push(...hub.autoagentTools())` (or `...service.tools()`).
2. Prompt: include `AUTOAGENTS_PROMPT_FRAGMENT` in the system prompt.
3. Context: call `run(args, {owner, prompt, signal})` with `owner` from the host's real admission and `prompt` as the user's turn text.
4. Result: append each `make_*` return value to the turn result's `autoagents` array; tool errors (`AutoagentError`, `AdkError`, `BotsError`) carry a plain message for the model and an HTTP-shaped `status` for hosts that map them.

Not done here: the turn-loop wiring in `src/code/agent.ts` (the `Action` set and the local model's JSON schema still know only list/read/search/propose/final) and the system-prompt assembly in `src/prime/chat.ts` belong to the sibling tools and brain slices; until they land, the card cannot appear in a live chat, although every route, client method, view badge and the card itself work. The real `echo-adk-api` was not called; the tier source in the capability detail (`tier` / `danger_tier`) was inferred from the broker and `hub.prepare`, so a detail without either field resolves to `tier: null` and keeps the bot paused.

## 13. Tests

- `tests/prime-autoagents.test.ts` (25 tests): definition validation and clamps; `createAgent` / `updateAgent` / `deleteAgent` against a stateful stand-in echo-adk-api with the real service's shapes (409 on an existing name, 422 `invalid` for an id outside the default-deny registry, PUT 404 never creating, DELETE 409 while a bot references the agent); Prime routes (201/200, 405 on GET, 503 when off, CSRF refusals forward nothing, assets served); tools, status and the prompt fragment; owner-only refusal; drafting (slug, role, purpose folding, lane, clamps, origin); unknown and malformed capability ids; role/purpose/argument refusals; idempotency in-process and from the listing; 409 handling (existing vs name taken); redaction; auto-resume with an exact lease; tier 2 and unreported tier paused with reasons; cap above the default; bot idempotency and schedule carry-over; unknown agent and bad arguments; refused resume; `find_capabilities`; `brokerCapabilityLookup` tier source and fail-closed cases; the service registry refusal passed through.
- `tests/prime-autoagents-ui.test.ts` (14 tests): card contents and tier badges; approval box; agent-only, existing and paused variants; Resume/Pause requests, headers, status and orb events; refused resume; two-step delete (bot then agent, Cancel, partial failure, agent-only); Open in echoBots / Open agent and the missing-view notes; orb event on created bots only and without `CustomEvent`; member and visitor explanation; malformed payloads ignored; `badge()`; the badge in `agents.js` and `bots.js` and the orb call from the echoBots create form.

Gates on 2026-11-04: `npm run lint` 0 · `npx tsc --noEmit` 0 · `npx vitest run --maxWorkers=1` all files passed · `npm run build` 0. The real `echo-adk-api` was not called.
