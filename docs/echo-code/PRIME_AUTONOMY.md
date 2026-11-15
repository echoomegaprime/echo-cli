# Prime autonomy

This slice adds owner-only ESH/ECF tool adapters, continuity hooks in `SharedChat`,
and per-conversation fleet role selection. It uses the existing ESH MCP connection
and SDK broker. It never loads credentials, creates grants, changes a SOL mission,
or expands the broker token's scopes.

The generic model tool loop is the lead integration slice's responsibility under
the Run 2 handoff. Register `hub.autonomyTools()` there; exporting these tools does
not by itself make the existing read/list/search model protocol call them. The
local `/api/chat` continuity hooks and role context are wired here. The canonical
remote Workspace backend needs the lead's corresponding tool-loop integration;
this change does not install or deploy that backend.

## ESH policy

| Owner classification | Prime behavior |
| --- | --- |
| Tier 0/1 | Automatically prepare the exact request and execute its hash-bound ticket, after successful ESH dry-run classification. ESH budgets and policy still apply. |
| Tier 2 | Automatic only with `autoTierMax: 2`, a nonempty `standingGrantRef`, and an authorized ESH dry run. Otherwise return a review card. |
| Tier 3 or higher | Return a review card. A maximum tier of 2 cannot authorize irreversible work. The ESH owner may additionally require its own scoped human grant. |
| Hard denial, missing numeric tier, unavailable owner or invalid ledger | Refuse execution and report the observed boundary. |
| Typed verb | Use the advertised read-only `esh_verb` interface; its owner validates verb arguments and returns the audit receipt. No conversion to shell text. |

`standingGrantRef` records the owner's standing consent reference; it is **not**
an ESH credential or grant token and is never forwarded as one. A configured
`approveEsh` callback still has veto authority. This preserves the distinction
between owner consent and permission held by the existing connection.

`esh_run {command, node?}` first reads ESH status and ledger integrity, checks its
advertised dry-run contract, and submits `dry_run: true` on a conversation-specific
session. Execution uses the same command, node and observed session version with
15-second/16-KiB requested bounds. Remote-node requests retain the tier returned
by ESH. No client-side command-prefix guess can lower that tier.

`esh_verb {verb, args}` supports `ls`, `cat`, `grep`, `git`, `disk`, `ps`, `ports`,
and `http_get`. Unknown verbs and model-supplied credential/control fields are
refused. Outputs remain untrusted.

Every invocation emits paired `tool_started` / `tool_result` events and returns
`{untrusted: true, audit_id, receipt, state, ...}`. `audit_id` is null when no owner
receipt exists; it is never replaced with a fabricated owner audit ID. A dry-run
receipt is classification evidence, not execution proof. A review response includes
`review: {id, digest, request, requestId, expiresAt, tier, reason}`. The existing
owner-only `/api/execute` endpoint consumes the exact ticket once. The review UI
shows the request, disables Run on submission, and resumes through its supplied
callback only after receiving the actual execution response. Uncertain outcomes
are not automatically retried. The ESH owner remains responsible for runtime
reclassification, grants, output redaction, ledger storage, and final effects.

## Continuity hooks

The adapters are `ecf_prepare {message}`, `ecf_recall {query}`, and
`ecf_capture {kind, content, project?}`. Allowed capture kinds are `decision`,
`task`, `lesson`, `correction`, and `note`. ECF's native schema has no correction
kind, so corrections use `kind: note` with a `Prime correction` title.

The existing continuity client now supports bounded Prime calls over the same
host invoker, including MCP text wrappers and JSON-encoded SDK HTTP bodies.
It verifies the continuity service identity. There is no credential lookup,
alternate-account fallback, or broker replacement.

Before every admitted owner turn, `PrimeAutonomyHooks.before` invokes prepare and
injects up to 4,000 characters of alias/project context as **untrusted records**.
An unavailable prepare is shown in activity and the turn proceeds without memory.
The local model receives this in its system-context block. The admitted shared
coding v1 contract owns its system prompt, so it receives the same bounded context
as labelled user data without changing the pinned contract.

After a completed turn, explicit `Decision:`, `Decided:`, `Task:`, `TODO:` or
`Next step:` statements are candidates for capture. Questions and tentative
statements are excluded. Automatically extracted content is labelled as an
assistant assertion, not verified fact. If the model explicitly called capture,
the hook displays that result instead of duplicating the detected decision.
Every fifth completed answer also creates a `session_summary` note consisting of
bounded recent answer excerpts. No shutdown hook or unload request is required.
`PrimeAutonomyHooks` accepts a host-supplied cadence from 1 to 50.

Capture uses a deterministic request ID derived from session, kind, content and
project. Before claiming saved, the client checks the returned receipt's kind,
request ID, saved/verified flags, and content SHA-256, then separately recalls the
exact event ID and matches its content and hash. The documented 1,200-character
recall excerpt format is accepted only with its full matching hash. Failed or
unavailable read-back stays unconfirmed. The activity strip displays a receipt ID
only after this verification. Secret-like capture text is refused before transport.
Capture verification proves persistence, not the truth of an assistant assertion.

## Fleet roles

`roles.runtimeDir` selects a reviewed runtime. The loader reads
`SYSTEMS/codex_auto/role_power_registry.json`, `FLEET_ROLES/<role>.md`,
`FLEET_ROLES/boot_prompts/<role>_boot.md`, and
`CLAUDE_CODE_MARKETPLACE/plugins/echo-fleet-roles/skills/echo-<role>-power/SKILL.md`.
Registry mappings and skill identities must match; resolved files must stay under
the selected runtime. Files are bounded to 256 KiB and cached for 60 seconds.
L1 frontmatter and L2 body are retained separately, with a source digest. The
injected role/boot/method context is bounded; a missing source is reported as an
unavailable method, not successful role adoption.

Rules choose among builder, observer, troubleshooter, researcher, architect,
commander, enhancer and publisher. For a configured model router, a single short
classification request to the already selected model can refine that choice;
it has a three-second local wait limit and falls back to the rules on failure or
invalid output. It cannot execute actions or choose another provider. This extra
call uses that selected provider's normal quota. The pinned shared coding v1 path
uses rules because it does not expose a generic classifier interface.

The `as <role>` chip offers a role selector and Pin/Unlock. Pins apply on the next
owner turn and are isolated by conversation; the browser clears them on account
change. They are in-memory preferences, not durable SOL role switches. Each actual
available role change is recorded as an ECF note, with honest failure reporting.
Role labels, registry scope lists and role prose never change actual broker
authority. The canonical Workspace displays received role events but leaves its
pin control disabled until the lead connects that backend's pin input.

## Reviewed configuration

Add these sections to the existing Prime configuration alongside `esh`, `sdk`,
`models`, and `workspace`:

```json
{
  "autonomy": {
    "esh": {
      "autoTierMax": 1
    }
  },
  "roles": {
    "runtimeDir": "D:\\ECHO_OMEGA_PRIME\\03_TOOLS\\powershell\\Echo.SolProfile\\1.1.3\\runtime",
    "cacheMs": 60000
  }
}
```

The safe default is tier 1. For an already authorized tier-2 standing grant, set
`autoTierMax` to `2` and `standingGrantRef` to the owner's existing decision/grant
reference. Unknown config fields and unsupported tiers fail validation. Supplying
a reference does not mint or install a grant. Do not put a token in this config.

Without `roles`, role loading and classification are off. Missing ESH/SDK
connections return unavailable results. No connection is autodiscovered from
another client. If `echo.continuity.prepare`, capture, or recall is unavailable
on the selected broker, Prime reports that layer unavailable; remote connector
availability alone does not prove this local broker has access.

## Lead integration contract

```ts
// Inside the admitted owner's tool registry:
tools.push(...hub.autonomyTools());
// Each entry: {name, description, inputSchema, ownerOnly, run(args, ctx)}.
// ctx: {owner: boolean, prompt: string, sessionId?: string, signal?: AbortSignal}.
```

Derive `ctx.owner` from authenticated host admission, never model or browser data.
Use the same `EcfTools` instance for `PrimeOptions.ecf` and `PrimeAutonomyHooks` so
explicit model captures suppress duplicate hook captures. Supply `autonomyEvents`
and the ECF/hooks event sinks to the loop's activity stream. Forward review results
to `EchoPrimeAutonomy.reviewCard` with the existing owner API and a continuation
callback. Local chat also accepts review results in its `autonomy` array. Do not
call `/api/execute` automatically for a `review_required` result.

The ordinary CLI code agent remains read/list/search/propose/final until the lead
registers the adapters in its generic tool loop. File edit approval, pinned shared
coding admission, and the SDK authenticated/public split are unchanged.

## Verification and delivery boundary

Focused stand-in tests cover tier policy, hash binding, replay refusal, owner veto,
scope/error handling, prepare injection, capture read-back, role loading,
classification, pinning, review UI and continuation. Debug output uses structured
metadata under `NODE_DEBUG=echo-prime-autonomy,echo-prime-continuity,echo-prime-roles`;
it omits prompts, commands, role bodies, credentials and captured content.

Run only these four gates on the memory-constrained worker:

```powershell
npm run lint
npx tsc --noEmit
npx vitest run --maxWorkers=1 tests/prime-esh-tools.test.ts tests/prime-ecf-hooks.test.ts tests/prime-roles.test.ts
npm run build
```

The lead runs the full suite after merge. Fixture success is not live ESH/ECF
execution, end-to-end model tool-loop acceptance, certification, or deployment.
This slice is committed locally without pushing. Roll back by reverting this
commit; no runtime credentials, policies or installed configurations are modified.
