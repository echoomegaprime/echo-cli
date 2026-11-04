# Grounded answers: Builder candidate

This change reduces specific ways Echo can turn incomplete evidence into an
operational success claim. It does not eliminate hallucinations or independently
validate every fact in a model answer.

## Concrete behavior

- Tool results carry application-generated tool/request/time/status metadata next
  to the unchanged untrusted payload, and `tool_evidence` persists that metadata.
- Envelope classification respects explicit failures, nested SDK/MCP results,
  MCP JSON-text errors, contradictory success/exit fields, normalized denied or
  pending statuses, malformed fields, and ESH stdout/stderr truncation mappings.
- Provider/transport success is `reported`, not independent verification.
  A zero command exit supports command completion only. Local file and preference
  receipts support their particular local operations, not ECF/cloud readback.
- An unknown side-effect outcome stops remaining calls in the batch and all
  later tool rounds for this turn. The final reply path has no tools available.
- A bounded English claim check rejects recognizable unsupported first-person
  action/capability claims and some generic completion claims. It checks operation
  kind and explicit fleet targets instead of accepting an unrelated good result.
  Unsupported sentences are removed; separate useful explanation is preserved
  alongside a deterministic uncertainty/receipt-status explanation.
- Quoted text, code, blockquotes, and recognizable hypothetical examples are
  excluded from that check. A valid local-save report can coexist with a separate
  failed-node explanation. Negative/uncertain explanations remain usable.
- `answer_grounding` records intervention reasons, receipt count/statuses and
  request ID, without duplicating the draft model answer or tool arguments.
- Retrieved memories distinguish source timestamp from retrieval timestamp,
  retain original roles and conflicting statements, and explicitly require fresh
  evidence for current state. Missing source timestamps remain unknown.
- Model-generated checkpoints are untrusted user-reference messages, no longer
  system-authority messages. The source journal and original messages remain.
- Malformed model messages and tool-call shapes end with a verbal fallback rather
  than an uncaught type error. Existing idempotency and round limits remain.
- `adapters.unpack` now rejects outer MCP `isError:true` before decoding a
  success-looking JSON payload. This closes a separately reproduced error-loss bug.

No permission scopes, credentials, account boundaries, tool definitions, model
routing or owner data/configuration are changed. Member memories remain private.

## Validation

Run from `SYSTEMS/echo_qwen_chat` with that directory and `tests` on Python's
module path:

```text
python -B -m unittest discover -s tests -p test_grounding.py
python -B -m pytest tests -q -p no:cacheprovider --confcutdir . --basetemp <new-task-owned-directory>
```

Fresh local result: 30 grounding cases pass; full Workspace suite 132 tests and
30 subtests pass. Regression negatives were observed before their respective
fixes. The suite is also registered in `.echo/certforge_suites.json` as a stdlib
journey input; registration does not mean independent certification passed.

Evidence receipts:

- Task-bound Builder preflight: `esh_20261030100020_90f92e76`, all 25 required
  checks pass. External release checks remain separate.
- Initial missing protections: `esh_20261030100407_886c5c68`.
- Cross-target/malformed/envelope negatives: `esh_20261030100937_2f820ba5`.
- Quote, partial-success and provider-control negatives:
  `esh_20261030101213_5d931add`.
- ESH truncation/status casing/explanation negatives:
  `esh_20261030101309_4dc4377e` (test failures; ESH's generic classifier labelled
  the transcript network-related because it contained timeout wording).
- Terminal status failure/timeout negatives: `esh_20261030101751_ec47a145`.
- Final full suite: `esh_20261030101810_2428bd0a`.
- Bundled CertForge testkit: `esh_20261030101829_5566756a`, 30 passing
  grounding tests, zero skipped tests or stubbed modules. This is a local suite
  run, not an independent certificate.

## Practical limits and next checks

The claim check is a conservative English heuristic. Unrecognized wording,
passive claims, other languages, and semantic errors in an otherwise ordinary
answer can still pass. Some true claims may be withheld without the narrowly
recognized receipt. A quote can contain a false assertion; excluding it does not
verify it. This layer is evidence framing and a bounded action-claim check, not a
second model judge or a universal truth detector.

Memory framing does not semantically reconcile all contradictory documents or
calculate a domain-specific TTL. Fresh operational probes and source review are
still required. No memories are deleted or silently rewritten by this change.

The tool loop has bounded rounds and stops uncertain side effects. Existing
individual model/transport timeouts remain; this change does not provide a hard
end-to-end wall-clock deadline or prove live model responsiveness.

Before installation, independently run the exact committed tests and isolated
preview, including real model responses for failed actions, unrelated receipts,
malicious retrieved instructions, stale/conflicting node reports, quoted examples
and ordinary conversation. No live provider evaluation, production deployment,
zero-hallucination guarantee, or exact-candidate certification is claimed here.

## Scope and rollback

Builder owns `grounding.py`, its tests, the narrow app/workspace/adapters wiring,
this document, the capability-guide update and the appended CertForge suite entry.
The candidate branches from Workspace `003fcce4dd` and inherits Workspace PR1008;
the live-auth overlay remains separate PR1009. The original worktree is preserved.

Hypothesis: explicit receipt/status checks plus lower-trust memory framing reduce
unsupported action claims without suppressing ordinary final replies. Failed
regressions, unsupported target reuse, altered tenant boundaries or loss of verbal
fallback falsify the candidate. Only local source/test artifacts are affected.
The authorized action is building/committing a separate review candidate, not
production mutation. Rollback is the prior source artifact; there is no database
migration or data rewrite. The parent delivery owner handles registry attachment,
independent review, certification, isolated preview and any installation.
