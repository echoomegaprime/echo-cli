# Bot continuity controls

Prime exposes the ADK's optional per-bot continuity outbox through the existing
owner-only bot workspace. The **Continuity** tab submits an explicit note,
shows durable capture history, and reconciles a selected existing capture.
Local **Memory** notes remain a separate feature. Nothing is captured on a
timer, on opening this tab, or automatically after a bot turn.

The paired ADK extension must be installed and configured before these controls
can work. It fixes each bot's canonical project on the host and requires both
the agent definition and the bot's saved lease to allow the actual
`echo.continuity.capture` and `echo.continuity.recall` capabilities. Those local
prerequisites do not establish the remote key's current authority. ECF uses
shared storage with bot/project attribution; it is not a private ECF tenant per
bot. Prime does not accept a caller-supplied project, endpoint, key, owner or
replacement lease.

## Routes and tools

| Workspace operation | Owner chat tool | Native ADK request |
| --- | --- | --- |
| `continuity.status` | `bot_continuity_status` | `GET /v2/bots/{bot_id}/continuity` |
| `continuity.capture` | `bot_continuity_capture` | `POST /v2/bots/{bot_id}/continuity/capture` |
| `continuity.reconcile` | `bot_continuity_reconcile` | `POST /v2/bots/{bot_id}/continuity/reconcile` |

The Prime prefix is `/api/prime/bots/workspace/`. Status accepts only the exact
32-hexadecimal `bot_id`. Capture additionally requires a stable `request_ref`
(1–100 characters from `A-Za-z0-9_.:-`), a nonempty title of at most 200
characters, and the explicit note in `detail` (at most 4,000 characters).
Reconciliation takes only `bot_id` and an existing 32-hexadecimal `capture_id`.
The same closed contracts are included in the new ADK SDK proposal, bringing
that paired proposal to 56 operations. The previous 53-operation release does
not implement these three routes.

Prime retains its owner session, request header and Origin checks. Mutations
cannot be invoked with GET. The three additional named tools raise the bounded
owner tool registry from 32 to 35; call budgets, turn deadlines, owner admission
and duplicate-name checks are unchanged. Capture retains within-turn mutation
deduplication. Explicit reconciliation reads fresh state and may finish the
same original request, so its result is not cached as a permanently completed
mutation.

## Receipts and uncertain outcomes

Status is local evidence. `configured` and `lease_permits_capture` describe
local prerequisites; `remote_authorization_verified` stays false. Capture
receipts distinguish `prepared`, `uncertain`, `saved`, `verified`, `blocked`
and `conflict`. Only an outer `verified: true` with state `verified` establishes
that the adapter validated the owner's persistence receipt and exact content
readback. An inner receipt, HTTP 200, or a configured host is insufficient.

Prime validates bot/capture identity, the original `request_ref`, bounded
receipt fields, state/verification consistency, and the nested request/content
hash bindings. Invalid mutation receipts report an unknown outcome and are not
replayed. No credentials are forwarded from Prime to ADK.

The UI creates one random reference for a note and keeps the same draft while
its outcome is unconfirmed. The Capture button stays disabled after submission,
including a lost response. Refresh only reads status; the returned
`request_ref` identifies the existing capture without guessing by its title or
timestamp. Reconciliation uses the returned capture ID. It may resubmit the
same original request idempotently or repeat readback, according to ADK state.
There is no automatic write retry. Starting a separate note is an explicit
action after the current capture reaches a verified, blocked or conflicted
state; earlier receipts remain in history.

A typed `invalid` HTTP 400 response that explicitly confirms no unknown
outcome is rejected before dispatch. The UI preserves that note's text and
allows an explicit correction. Missing outcome metadata, transport errors,
and every uncertain response keep the draft locked for inspection.

Only capture and reconciliation have a 55-second client transport ceiling.
Other workspace operations keep 35 seconds. The chat host's existing 30-second
per-tool limit and shared turn budget may expire earlier; that reports an
unknown outcome and does not prove the remote action was cancelled. Preserve
the original reference, read status, and reconcile its existing capture rather
than inventing a new reference for the same note.

## Validation scope

Controlled tests cover the real Prime HTTP boundary, closed schemas, mismatched
receipts, non-owner/Origin/method refusals, the shipped UI, lost acknowledgments
and explicit reconciliation. They do not establish a live ECF write, current
SDK registration, protected host configuration or production certification.
This feature must be released with the matching ADK revision and its complete
outbox/configuration recovery procedure.
