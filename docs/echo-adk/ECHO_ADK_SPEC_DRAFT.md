# ECHO ADK — Spec Draft v0 (hybrid: Echo-native core + adapters)

Status: **DRAFT for Commander review** — derived from `ECHO_ADK_RESEARCH.md` §C/§D (2026-11-04). Nothing here is built. Every "MUST" is a proposed invariant; the research doc labels the facts it rests on.

## 1. Purpose

Give any agent host (Claude Code, Codex, Qwen Code, Google ADK, a plain Python script, a FORGE service) one small, zero-dependency way to **define** an Echo agent and to **run** it under Echo's existing governance — ESH tiers and grants, the SOL broker, CertForge/Harbormaster proof, ECF/Crystal memory — with adapters so the same definition is loadable by Google ADK, consumable over MCP and reachable over A2A.

Non-goals: a new shell (ESH exists), a new credential store (vault/credential broker exist), a new release gate (CertForge/Harbormaster exist), a new memory (Crystal/ECF exist), a dev UI (ADK's `adk web` is used through the adapter).

## 2. Primitives (the core, `echo_adk.core`)

| Primitive | Definition | Source of truth today |
|---|---|---|
| **Role** | Operating specialization: `name`, `tier`, `primary_skill`, `composed_skills[]`, `capability_families[]`, `boot_prompt`. A Role is routing metadata, **never** an authorization grant. | `echo.fleet.list_roles`; `role_power_registry.json`; `FLEET_ROLES/*.md` |
| **Skill** | An Agent-Skills-spec directory (`SKILL.md` frontmatter `name` ≤64 kebab, `description` ≤1024; optional `references/ assets/ scripts/`), loaded progressively L1→L2→L3. | `echo-fleet-roles/skills/*`, `echo-ai-skills/skills/*` |
| **Capability** | One gate cap: `id`, `tier` (0–3/hard), `scope`, `input_schema`, `health`, `verb`. The only kind of tool an Echo agent has, besides read-only workspace inspection. | `arcanum_sdk.sdk_capabilities` via `echo.caps.detail` |
| **Lane** | Where/how a run executes: `node`, `model` (loopback endpoint id or CLI provider id), `budget{max_calls, max_cost_usd, max_wall_s}`, `concurrency`. | `echo.lanes.*`; Prime `swarm.ts` budget clamp; `ModelsConfig` |
| **Lease** | Time-boxed, scoped, use-capped, revocable permission for one agent run: `{run_id, scopes[] (exact cap ids), expires_at, max_uses, grant_ref?}`. Minted by the SOL broker (and ESH signed grants for tier ≥2 shell/irreversible classes). | `sol_core.broker_tokens`; ESH `grant issue` |
| **Proof** | The required output of every run: `{run_id, lease_id, events_sha256, actions[] (cap, tier, verdict, audit_id), artifacts[], receipts[] (ECF capture ids), verdict: PASS\|FAIL\|UNKNOWN}`. CertForge/Harbormaster consume Proofs; a run without a Proof did not happen. | CertForge evidence, ECF receipts, ESH ledger `audit_id` |

An **EchoAgent** is the record `{name, role, skills[], capabilities[] (allowlist), lane, model, instruction?, max_steps}`. It is data (YAML/JSON), so the same file is loadable by the core runner, the ADK adapter and the MCP/A2A servers.

## 3. Envelope (one shape for every call and event)

```json
{"envelope_version": 1, "run_id": "...", "step": 7, "kind": "cap|model|shell|memory|artifact|final",
 "capability": "echo.knowledge.search", "tier": 0, "verdict": "allowed|gated|denied",
 "ok": true, "untrusted": true, "redacted": 0, "audit_id": "...", "duration_ms": 31,
 "needs": null, "how": null, "data": {}}
```
Rules: output is **always** `untrusted:true` (data, never instructions); secrets are redacted before any write; `needs/how` explain a `gated` verdict so a human can issue a Lease; the envelope is what the ADK adapter wraps into an `Event` and what the ledger stores.

## 4. Runner contract

`run(agent, prompt, lease) → Proof`: lease check → (loop ≤ `max_steps`) model step → Action (`cap(call)` | `read/list/search` workspace | `final`) → policy (tier classify, allowlist, lease scope, budget) → execute via broker/ESH → envelope → memory/ledger → next step. Streaming is via envelopes with `partial:true`. No step may be retried against a different model or provider.

## 5. Invariants and where each is enforced

| # | Invariant | Enforced in |
|---|---|---|
| R1 | Agents never hold tokens: model paths are a credential-free loopback origin or a broker-mediated cap; the child env for CLI providers is allowlisted and drops `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`; config refuses `api_key`-shaped fields. | `core.models` (lifted from Prime `validateEndpoint`, `childEnv`) |
| R2 | No silent fallback: a missing/failed provider raises `ProviderUnavailable(provider)` and ends the step; `echo.llm.call` is always invoked with `allow_reroute=false`; adapter disables ADK model-router failover and model `RetryConfig`. | `core.models`, `adk.EchoModel` |
| R3 | Scoped broker: a kit Lease lists **exact cap ids** (no `*`), TTL ≤ run budget, `max_uses` bounded; the gate's tier/HMAC checks remain the backstop. | `core.lease` + SOL `validate_broker_token` |
| R4 | Proof gates: every run emits a Proof; deploy/promote of any kit agent goes through CertForge `submit→verdict` and the Harbormaster release contract; `echo.builds.log` receipt required. | `core.proof`, `adk.EchoGovernancePlugin.after_run` |
| R5 | Fail-closed: unknown caps, unknown tiers, missing schema, missing lease, missing memory/artifact service → refuse with a `gated/denied` envelope; the tool registry is default-deny; forge/tool output never drives a later command. | `core.policy`, `adk.EchoToolset` |

## 6. Adapters (generated from the core registry; drift test required)

- `echo_adk.adk` — `EchoModel(BaseLlm)`, `EchoToolset(BaseToolset)`, `EchoSessionService` (= `DatabaseSessionService` on FORGE Postgres), `EchoMemoryService(BaseMemoryService)` over Crystal + ECF, `EchoArtifactService`, `EchoGovernancePlugin(BasePlugin)`; `echo_adk.adk.app(agent) → App` for `adk web/run/api_server/eval`.
- `echo_adk.mcp` — expose an EchoAgent's allowed capabilities (and optionally the whole agent) as MCP tools; Echo's existing MCP servers are consumed unchanged via `McpToolset` with `tool_filter`.
- `echo_adk.a2a` — Agent2Agent card at `/.well-known/agent-card.json` via `to_a2a`; translator to/from `echo-a2a/1.0` `agent.json` (open question E.2 decides the long-term wire).
- `echo_adk.skills` — Agent-Skills loader + validator over fleet skills; `SkillToolset` bridge.

## 7. Minimal example (target DX)

```yaml
# agents/knowledge-scout.yaml
name: knowledge-scout
role: researcher
skills: [echo-researcher-power]
capabilities: [echo.knowledge.search, echo.knowledge.get, echo.caps.search]
lane: {node: forge, model: qwen-local, budget: {max_calls: 40, max_cost_usd: 0, max_wall_s: 600}}
max_steps: 12
```
```bash
echo-adk run agents/knowledge-scout.yaml "what does the Forge hold on ESH grants?"   # core runner → Proof
echo-adk adk web agents/                                                            # same file through Google ADK dev UI
echo-adk eval agents/knowledge-scout.yaml evals/knowledge.evalset.json              # trajectory eval
```

## 8. Out of scope for v0 / decided later

Graph workflows beyond a linear step loop (ADK 2.0 nodes are the target shape, via the adapter first); TypeScript core (lift Prime TS after the Python core proves the contract); any change to ESH, SOL, CertForge or ECF contracts.
