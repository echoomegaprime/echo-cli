# ECHO Node Steward in unified Prime — build 19147

The Commander added the per-node resident model to build 19147 on October 30, 2026. Every current admitted ECHO node is in scope, including future nodes discovered through the authoritative fleet inventory. Public product naming is **ECHO Node Steward**. The internal training identity is not a public brand.

## Implemented source behavior

Prime has a Node Steward panel, a configured owner MCP connection, and authenticated loopback routes `GET /api/steward/status` and `POST /api/steward/ask`. The owner tool names are supplied by the reviewed host configuration in `steward.tools.status` and `steward.tools.advisory`; the other `steward` fields use the existing `StdioConfig` contract. Nothing connects automatically, starts a service, downloads a model, claims an SDK capability exists, or changes weights.

The configured owner supplies the inventory dynamically. Prime does not freeze coverage to a historical hostname list. A missing connection means unknown coverage. Inventory and runtime evidence expire after 120 seconds, with at most 10 seconds of clock skew. Duplicate or invalid node identities are refused. Only whitelisted display fields reach the browser; endpoints, credentials and arbitrary owner metadata are excluded.

The panel distinguishes advisory availability from resident coverage. A FAIL or UNKNOWN candidate can provide explicitly requested **shadow advice** only when its physical identity, admission and runtime are current. A resident counts toward complete coverage only with current runtime identity, evaluation PASS, canary PASS and a ready rollback slot. Complete coverage also requires a complete current inventory and at least one node. These are owner readbacks, not a new certification issuer.

Requests bind the node name, physical node identity digest, exact loaded-model digest, output mode and a fresh request ID. The returned receipt must match all five and explicitly report `executionAuthorized: false`. No retry or paid-provider fallback is automatic. The input accepts only node, mode, text and an optional exact proposal target. Credentials, transport URLs and authority fields cannot be supplied by the browser.

The three modes are `answer`, `explain` and `proposal`. Text is displayed literally. Proposals are strict typed objects; unknown fields and commands are refused, risk and reversibility are derived from the canonical vocabulary, verification is read-only, and action/verification/rollback targets must equal the operator's exact target. Model risk claims are refused. A proposal never invokes ESH, SDK mutation, shell, promotion or rollback.

Debug diagnostics use `NODE_DEBUG=echo-prime-steward` and fixed structured event/category fields. Prompts, model output, node addresses and credentials are not logged by this module. Panel inputs and responses are not written to browser storage and are cleared on close; late responses are discarded.

## Owner protocol, version 1

This is the new Prime adapter contract. An installed canonical Steward owner implementing it has **not** been verified. The fixture under `tests/fixtures/` is offline transport evidence and must never be configured as a production owner.

The status tool takes an empty object and returns an object (directly or in the existing recognized MCP/SDK envelope) with `schemaVersion: 1`, an ISO `observedAt`, boolean `inventoryComplete`, and `nodes` containing at most 256 entries. Each entry contains:

| Field | Required meaning |
| --- | --- |
| `id`, `os` | Canonical lowercase node ID; `windows`, `linux` or `unknown` |
| `identityVerified`, `identitySha256` | Fresh measured physical identity; a SHA-256 digest is required when verified |
| `admitted` | Current owner admission for this node and model; not a model-generated assertion |
| `runtime` | `state` of `unknown`, `offline`, `shadow` or `resident`; ISO `observedAt`; exact `model` and loaded-weight `sha256` when available |
| `evaluation.verdict` | `PASS`, `FAIL` or `UNKNOWN` for those exact weights and frozen scorer/evaluation identities |
| `canary`, `rollbackReady` | `PASS`, `FAIL` or `UNKNOWN` canary and boolean verified rollback readiness |

The advisory tool receives `node`, `nodeIdentitySha256`, `modelSha256`, `mode`, `text`, `requestId` and, only in proposal mode, `target`. The owner must recheck the physical target and loaded weights before inference, use the canonical `steward_prompts.system_prompt(os, node, mode)`, preserve its evaluated decoding profile and resource admission, and return no executable side effect.

Its receipt contains `schemaVersion: 1`, ISO `observedAt`, the exact node/identity/model/mode/request bindings, `executionAuthorized: false`, and either nonempty bounded `text` or a raw `proposal`. No other fields are accepted. A proposal has `diagnosis`, `decision`, `reason`, `action`, `verify`, `rollback`, `rollback_action` and `escalate_when`. Abstentions have null action, verification and rollback action. ACT must be state-changing under codebook v1.2 and must have a read-only verification. This viewer imposes exact target binding without changing the training parser or scorer.

`src/prime/steward-vocabulary.ts` is generated from the canonical `proposals.py` AST without importing or executing that module. It pins the source SHA-256 and vocabulary version. Regeneration must retain parity with the canonical table and irreversible set; vocabulary changes require review and regression validation.

## Fleet rollout requirement

The canonical brief specifies Qwen3.5-4B QLoRA r16/a32, Q4_K_M, with a 2B fallback for constrained nodes. The current model configuration and artifact hashes must be measured before installation. Windows serving uses Ollama; admitted Linux serving uses the pinned CPU-only llama.cpp service `echo-node-steward.service` and candidate service `echo-node-steward-cand.service`. Preserve the unrelated FORGE `echo-steward.service`, GPU reservations and existing chat/voice services.

Historical source files mention QUENCH, HAMMER, FORGE, ANVIL, TEMPER, TONGS, CRUCIBLE and STRIKER in different lists. They are discovery leads, not a verified current complete roster. No node is silently excluded because an older deployment script omitted it. A current authoritative inventory and per-node resource/identity/admission readback must decide the rollout matrix.

Required rollout sequence: exact evaluation PASS, inactive hash-pinned slot, golden canary, governed promotion, resident re-smoke and tested previous-slot rollback. Never lower the frozen quality gates or automatically update weights. Dataset admission, model admission and executor/runbook activation remain separate. Training on TEMPER/ANVIL is a separate governed action; this integration does not start training or stop a GPU service.

The canonical brief reports historical failed candidates and an unbuilt ESH executor (build 46933). Current live candidate, slot and fleet state are unverified while SDK retrieval is unavailable. Do not promote a historical FAIL card or treat an HTTP response, catalog entry or model alias as promotion proof.

## Delivery and evidence limits

This source remains a **local interactive** Prime module. The existing random local cookie is not multi-user authentication. Before public hosting, owner-only fleet APIs must be bound to canonical authenticated tenant/role authorization; ordinary members must not receive owner node data or owner tool access. Existing global local drafts also require tenant scoping or removal in the public integration. Never proxy the owner-only Workspace at port 8768 to members.

Tests cover the real loopback HTTP-to-stdio-MCP path with a labeled offline fixture, malformed/foreign/stale identities and receipts, unknown authority fields, derived proposal risk, abstention, current resident versus shadow coverage, and UI literal rendering/late-response handling. They do not prove installed model inference, actual fleet coverage, Google acceptance, independent review, certification, production installation or echoomegaprime.com deployment.

The original owner runtimes on 8768 and 18767 and the canonical Steward training tree are protected. Source work belongs to the isolated build19147 integration branch. Registry, Fabric, exact-SHA review/certification, authentic installed owner connection and public target/rollback evidence remain separate delivery requirements.
