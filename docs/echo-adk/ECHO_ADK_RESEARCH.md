# ECHO ADK — Deep Research: how to make an Agent Development Kit for the Echo platform

| | |
|---|---|
| Date | 2026-11-04 |
| Order | Commander: "DEEP RESEARCH HOW TO MAKE ECHO ADK" (pasted Google ADK landing page) |
| Mission | SOL `sol-20261104062711-b0c5ba342c` (research lane) |
| Branch | `agent/echo-adk-research-20261104` from `origin/main` of `echoomegaprime/echo-cli` |
| Author seat | Claude Fable 5.1 research agent, QUENCH |
| Companion | `ECHO_ADK_SPEC_DRAFT.md` (same folder) |

**Labeling convention used throughout:** `[FACT]` = observed live on 2026-11-04 (tool output, fetched page, file read, with source); `[INFERENCE]` = my conclusion from facts; `[OPEN]` = cannot be answered by research; `[UNVERIFIED]` = claim seen only in a secondary source.

---

## 0. Method and record of the docs-first protocol

### 0.1 Echo Knowledge Forge (step 1) — what came back

All calls via `sol_cli.py ... sdk invoke` with `PYTHONIOENCODING=utf-8`; no "database is locked" retries were needed. `[FACT]`

| Cap | Query | Result (hits / relevance) |
|---|---|---|
| `echo.knowledge.search` | "Echo SDK agent framework" | 8 hits: `ECHO_SDK_v3_MEGAPROMPT_SECTIONS_13_20.md` (a 2025 build **prompt**, not shipped code), `AUTO_TAG_REPORT.json` (noise) |
| `echo.knowledge.search` | "echo_sdk EchoHarvester contract envelope" | 8 hits: `ECHO_SDK_BUILD_MEGAPROMPT_v2.md` — a prior Python "Echo SDK" design (`EchoBase`/`EchoService`/`EchoHarvester`, config CONTRACT §5). Prompt template only; no verified implementation surfaced |
| `echo.knowledge.search` | "SDK invoke envelope capability params context bypass_reason" | 8 hits: `AI_GUIDE_sdk_universal_access.md` (single door `POST /sdk/invoke`; cites the stale `.137` FORGE IP), `knowledge_docs://echo-sentinel-sdk-capability-surface`, Anthropic manual (noise) |
| `echo.knowledge.search` | "ESH governed shell agent" | 8 hits: `esh-index`, `esh-operator-setup` (relevant), master build plan v5 (noise) |
| `echo.knowledge.search` | "fleet roles builder observer skills" | 8 hits: `AI_GUIDE_FLEET_BOOTSTRAP_SETUP.md`, `github-echoomegaprime-echo-fleet-roles-readme-md`, QUENCH SolProfile closeouts (relevant) |
| `echo.knowledge.search` | "MCP plugin echo-fleet-roles" | 8 hits, none on target (MCP gateway status 2025, Hybrid Sentinels manual). **Effectively empty.** |
| `echo.knowledge.search` | "arcanum engines 5500" | 8 hits, no engine-catalog document in the captured output. **Effectively empty.** |
| `echo.knowledge.search` | "Google Agent Development Kit" | 8 hits: `GOOGLE_CLOUD/AI_ML/GEMINI/AGENT_BUILDER.md` (Vertex AI Agent Builder; names ADK and "Agent Engine"), Temporal "Google ADK integration" guides (py/ts/go), Gemini API manual |
| `echo.knowledge.search` | "ADK agents tools runners sessions" | 8 hits: the three Temporal ADK integration guides (relevant), ElevenLabs agents docs (noise) |
| `echo.docs.search` | the four main queries | ESH set is complete in Forge: `esh-index`, `esh-concepts`, `esh-tiers-and-trust`, `esh-forge-spec`, `esh-operator-setup`; ADK query returned only 3 hits (Temporal TS guide, `AGENT_BUILDER.md`, GCP index) |
| `echo.arcanum.search` | "agent development kit" / "Echo SDK agent framework" / "ADK agents tools runners sessions" | No ADK template. "Echo SDK" returns the 2025 megaprompt family (`echo-sdk-build-megaprompt-v1/v2`, `echo-sdk-v3-megaprompt-sections-13-20`, `built-echo-sdk-v31-updated-build-plan-17-additions`). Third query returned 8 `enh-auto-*` rows with empty titles (noise) |
| `echo.context.recall` | the four queries | Mostly memory-card generation prompts (noise). One relevant Commander decision, id **96492**: "inventory which Google SDKs ECHO is already authed for and integrate them all in the echo sdk, what other sdks outside of google should be added" |

Before this work: `arcanum_sdk.knowledge_docs` had **24,171** rows and **0** with `doc_id LIKE 'google-adk%'`. `[FACT]`

**Bottom line of step 1 `[INFERENCE]`:** the Forge had no first-party Google ADK documentation; it had the complete ESH doc set, the fleet-roles README, and an older Python "Echo SDK" *design prompt* that was never confirmed as shipped code. Google ADK material existed only indirectly (Vertex Agent Builder overview, Temporal integration guides).

### 0.2 Official ADK docs (step 2) — tool record

- **context7 MCP:** `resolve-library-id` failed — `MCP server "plugin:context7:context7" needs you to sign in again (run /mcp to re-authenticate)`. Not usable this session. `[FACT]`
- **WebFetch:** every `https://google.github.io/adk-docs/...` URL returned **301 → `https://adk.dev/...`**. All citations below use adk.dev. The sitemap (`https://adk.dev/sitemap.xml`) was used to get exact page paths. `/tools/` and `/tools/mcp-tools/` are redirect stubs to `/integrations/` and `/tools-custom/mcp-tools/`; `/agents/graph-workflows/` and `/components/skills/` are 404 (skills live at `/skills/`). `[FACT]`
- **Package registries:** `pypi.org/project/google-adk` HTML did not render for the fetcher; used the JSON API `https://pypi.org/pypi/google-adk/json`. `npmjs.com` returned 403; used `https://registry.npmjs.org/@google/adk`. GitHub release data via `gh api repos/<org>/<repo>/releases/latest`. `[FACT]`

### 0.3 Ingest back into the Forge (step 4) — receipts

- Task-literal path first: `echo.psql.query` with the positional `INSERT ... ON CONFLICT DO NOTHING` was **refused**: `{"status":"error","error":"psql_failed","detail":"ReadOnlySQLTransactionError: cannot execute INSERT in a read-only transaction"}` (cap is tier-0 read-only; the write tier needs a bypass envelope I did not improvise). `[FACT]`
- Used the registered write path `echo.knowledge.ingest` (tier 1; params `doc_id,title,body_md,category,source_path,tags`; upserts and queues `embedding_1024`). Six rows, each `status:"upserted", created:true, embed_queued:true`, then read back with `echo.knowledge.get {doc_id, include_body:true}`: `[FACT]`

| doc_id | bytes | body_sha256 (prefix) |
|---|---|---|
| `google-adk-overview-packaging-20261104` | 3,272 | `8da84fd19f77` |
| `google-adk-2-0-workflow-runtime-20261104` | 2,942 | `105b4d114bc4` |
| `google-adk-models-litellm-vllm-20261104` | 2,818 | `1c3b28756386` |
| `google-adk-runtime-sessions-memory-artifacts-20261104` | 3,621 | `8d5d39c76b06` |
| `google-adk-tools-mcp-a2a-interop-20261104` | 3,854 | `ab5fe2a1296f` |
| `google-adk-skills-plugins-callbacks-safety-eval-deploy-20261104` | 4,176 | `a7e532ac4d94` |

All are own condensed summaries (not copies), `category='vendor-docs'`, tags include `google-adk, agents, docs`, `source_path` = the adk.dev URL. One body is 176 chars over the 4,000-char guidance; recorded, not hidden. The ESH `esh_forge_knowledge_ingest` MCP tool was deliberately **not** used: the frozen forge spec says it lands in a per-agent staging namespace, not the canonical corpus. `[FACT]`

---

## A. What Google ADK is (facts with citations and versions)

### A.1 Positioning and packaging `[FACT]`

- adk.dev landing: ADK is an open-source, code-first framework to "build, debug, and deploy AI agents", pitched as "Build production agents, not prototypes" and "reliable AI agents at enterprise scale". It says ADK "can work with almost any generative AI model", provides "easy access to Gemini", and offers connectors for other and locally running models; Google Cloud is one hosted option among others. Source: https://adk.dev/ . *(The Commander's pasted text, "Optimized for Gemini", is the older landing copy; the current page does not claim Gemini optimization.)*
- Languages and current versions actually observed on 2026-11-04:

| Language | Install | Version observed | Source |
|---|---|---|---|
| Python | `pip install google-adk` | **2.13.0**, uploaded 2026-10-23, `requires_python >=3.11`, ~24 hard deps (fastapi, starlette, uvicorn, google-genai, google-auth, pydantic, opentelemetry-api/sdk, authlib, aiosqlite, …) | https://pypi.org/pypi/google-adk/json ; GitHub release `v2.13.0` 2026-10-23 at https://github.com/google/adk-python (22,105 stars) |
| TypeScript | `npm install @google/adk @google/adk-devtools` | **2.4.0**, 2026-10-28 | https://registry.npmjs.org/@google/adk ; https://github.com/google/adk-js (release `integrations-v2.4.0`) |
| Go | `go get google.golang.org/adk/v2` (Go 1.25+) | **v2.7.1**, 2026-11-04 | https://github.com/google/adk-go/releases |
| Java | Maven `com.google.adk:google-adk` + `google-adk-dev` | install page shows **1.12.0** coordinates; GitHub release **v1.14.0** 2026-11-02 (docs lag) | https://adk.dev/get-started/installation/ ; https://github.com/google/adk-java/releases |
| Kotlin | `com.google.adk:google-adk-kotlin-core:1.5.0` + KSP processor (`@Tool`) | 1.5.0 | https://adk.dev/get-started/installation/ |

- Docs map (adk.dev nav): Build Agents (get started, tutorials, agents, graph workflows, multi-agent, models) · Run Agents (runtime, deployment, observability, evaluation, safety) · Components (tools, artifacts, skills, app management, context, A2A, live/voice, grounding) · Integrations · Reference · Community · ADK 2.0.
- Samples: `google/adk-samples` (10,578 stars) is now organised as **"ADK Recipes"**: `core/` (canonical patterns), `contrib/` (vertical deployable agents, e.g. retail), `plugins/` (SKILL.md + EVAL.yaml skill plugins). Source: repo README via `gh api`. The sample names the Commander pasted (Financial Advisor, Deep Search, Software Bug Assistant) surfaced in search results for the older `python/agents` layout and forks (https://github.com/google/adk-samples , https://github.com/bz1999/adk-samples) — that path is 404 on the live repo today. "Small Business Loans" was not found anywhere I looked. `[UNVERIFIED]` for exact current sample set.

### A.2 Core primitives `[FACT]`

- **Agent / `LlmAgent`** — "a self-contained execution unit" = model + instruction + optional tools. Fields: `name`, `model`, `description`, `instruction` (supports `{state_var}` / `{artifact.name}` / `{var?}` templating), `tools` (functions auto-wrapped as `FunctionTool`, `BaseTool`s, agents via `AgentTool`), `output_key`, `output_schema`/`input_schema`, `generate_content_config`, `include_contents`, `planner` (`BuiltInPlanner`, `PlanReActPlanner`), `code_executor`. Source: https://adk.dev/agents/llm-agents/ .
- **Workflows (ADK 2.0 Workflow Runtime)** — 2.0 moved ADK "from a hierarchical agent executor to a graph-based execution engine"; agents, tools and functions are **nodes** (`BaseAgent` subclasses `BaseNode`). Three shapes: graph-based (deterministic routing), dynamic (plain code), collaborative (coordinator + subagents). The 1.x template agents `SequentialAgent`/`ParallelAgent`/`LoopAgent` are **superseded** (Python/Go) and **deprecated with a warning** (TS 2.0). GA: Python 2.0.0 **2026-05-19**, Go **2026-06-30**, TypeScript **2026-08-21**. Breaking changes: `Event` gains `node_info`/`output`; `_run_async_impl` overrides bypassed; yield events, don't append; `RetryConfig(max_attempts=3)`; pin `google-adk~=1.0` / `@google/adk@^1.6.0` / `adk@v1` to stay on 1.x. Sources: https://adk.dev/2.0/ , https://adk.dev/agents/workflow-agents/ . Press context: https://virtualizationreview.com/articles/2026/05/19/google-io-26-fills-out-enterprise-agent-stack-with-managed-agents-adk-2.0.aspx , https://developers.googleblog.com/en/announcing-adk-go-20/ .
- **Tools** — `FunctionTool` from name/docstring/type hints (typed param without default = required; return a dict with `status`); `ToolContext` injected by annotation (state, `actions.transfer_to_agent`, `save_artifact`/`load_artifact`, `function_call_id`); `LongRunningFunctionTool` (pause, resume with a later `FunctionResponse`); `AgentTool` (`skip_summarization`); action confirmation page; `BaseToolset` groupings. Source: https://adk.dev/tools-custom/function-tools/ .
- **Runner / event loop** — `Runner` is "the central coordinator for a single user invocation": append user message via `SessionService` → agent `run_async` → for each yielded `Event` commit `actions.state_delta` / `artifact_delta` through `SessionService`, forward upstream, resume. `Event`: `author`, `content`, `actions`, `partial`, `is_final_response()`. `InvocationContext` (`invocation_id`, `ctx.session.state`; dirty reads until the event is processed). Run surfaces: `adk web`, `adk run`, `adk api_server`, ambient agents; resume/cancel; `RunConfig`. Sources: https://adk.dev/runtime/ , https://adk.dev/runtime/event-loop/ .
- **Sessions / state** — `Session{id, app_name, user_id, state, events, last_update_time}`; `SessionService.create_session/append_event/delete_session` (+get/list). Implementations: `InMemorySessionService`, `DatabaseSessionService(db_url=...)` (Postgres/MySQL/SQLite via async drivers, `db` extra), `VertexAiSessionService` (needs Agent Runtime + `gcp` extra). Source: https://adk.dev/sessions/session/ .
- **Memory** — `BaseMemoryService.add_session_to_memory / add_events_to_memory / add_memory / search_memory`; `InMemoryMemoryService`, `VertexAiMemoryBankService`, `VertexAiRagMemoryService`; tools `load_memory`, `preload_memory`; wire via `Runner(memory_service=)` or `--memory_service_uri`. Source: https://adk.dev/sessions/memory/ .
- **Artifacts** — named, versioned `types.Part` blobs; `InMemoryArtifactService`, `GcsArtifactService`; `save_artifact` (returns version) / `load_artifact` / `list_artifacts`; `user:` prefix for cross-session scope. Source: https://adk.dev/artifacts/ .
- **Callbacks** — `before/after_agent`, `before/after_model`, `before/after_tool`; returning a value skips/overrides; `None` continues. Source: https://adk.dev/callbacks/ .
- **Plugins** — `BasePlugin` hooks `on_user_message_callback`, `before_run_callback`, before/after agent/model/tool, `on_*_error_callback`, `on_event_callback`, `after_run_callback`, `close()`; global, run **before** callbacks; registered on an `App` (Python; `Runner(plugins=)` deprecated) or the Runner (other languages); built-ins `LoggingPlugin`, reflect-and-retry, save-files-as-artifacts, context filter; docs recommend plugins for guardrails. Source: https://adk.dev/plugins/ .
- **Skills** — follow the open **Agent Skills specification** (https://agentskills.io/specification): a directory whose only required file is `SKILL.md` with frontmatter `name` (≤64 chars, lowercase kebab-case, dir name must match) and `description` (≤1024 chars) plus optional `references/ assets/ scripts/`; progressive disclosure L1 metadata → L2 body → L3 resources; attached via `SkillToolset(skills=[load_skill_from_dir(...)])`; experimental (Python v1.25.0+, TS v0.6.1+, Go v1.2.0+, Kotlin v0.1.0+). Source: https://adk.dev/skills/ .
- **Models** — three mechanisms: registry string (Gemini via AI Studio/Agent Platform, Claude), connectors (`LiteLlm`, `ApigeeLlm`; pages for Ollama, vLLM, LiteRT-LM), and a router function with automatic failover. `LiteLlm` needs `litellm>=1.84`; strings like `openai/gpt-4o`, `anthropic/...`; self-hosted vLLM: `LiteLlm(model="hosted_vllm/<name>", api_base="https://host/v1", api_key=... | extra_headers=...)`, server must support OpenAI tool calling (`--enable-auto-tool-choice`, `--tool-call-parser`). LiteLLM 1.82.7/1.82.8 on PyPI were compromised on 2026-03-24 (page warning). Sources: https://adk.dev/agents/models/ , https://adk.dev/agents/models/litellm/ , https://adk.dev/agents/models/vllm/ .
- **Evaluation** — `.evalset.json` / `.test.json`; criteria `tool_trajectory_avg_score` (1.0), `response_match_score` (0.8 ROUGE-1), `final_response_match_v2`, rubric metrics, `hallucinations_v1`, `safety_v1`, multi-turn metrics; `adk eval`, `AgentEvaluator.evaluate(...)` in pytest, Eval tab in `adk web`. Source: https://adk.dev/evaluate/ .
- **Safety** — agent-auth vs user-auth; in-tool guardrails via developer-set `tool_context.state` policy; callbacks/plugins for arg validation (Gemini-as-judge, Model Armor, PII redaction plugins); sandboxed code execution; eval + tracing; VPC-SC; escape model output in UIs. Source: https://adk.dev/safety/ .
- **Deploy** — Agent Runtime (managed Google Cloud; the adk.dev page does not use the name "Agent Engine" — the Forge's `AGENT_BUILDER.md` still does), Cloud Run (`adk deploy cloud_run AGENT_PATH --project --region [--service_name --app_name --with_ui --port --session_service_uri --artifact_service_uri --memory_service_uri]` or Dockerfile + FastAPI `get_fast_api_app(agents_dir, session_service_uri, allow_origins, web)` + `gcloud run deploy`), GKE, or **any container host** (Docker/Podman, offline OK). Sources: https://adk.dev/deploy/ , https://adk.dev/deploy/cloud-run/ , https://adk.dev/deploy/agent-runtime/ .
- **MCP** — client `McpToolset` (`StdioConnectionParams(server_params=StdioServerParameters(...), timeout=5)`, `SseConnectionParams`, `StreamableHTTPConnectionParams(url, headers, timeout, sse_read_timeout)`, `tool_filter`, `auth_scheme/auth_credential`, `use_mcp_resources`); server `to_mcp_server(agent)` (FastMCP, stdio documented) or a hand-built MCP `Server` with `adk_to_mcp_tool_type`. Caveats: define toolsets synchronously for production, `await toolset.close()`, explicit timeouts, connections not restored with session state. Sources: https://adk.dev/tools-custom/mcp-tools/ , https://adk.dev/tools-custom/mcp-tools/agent-as-server/ .
- **A2A (Agent2Agent protocol, experimental)** — expose: `pip install google-adk[a2a]`, `to_a2a(root_agent, port=8001)` → Starlette app, card at `/.well-known/agent-card.json`, internals `A2aAgentExecutor` (+config interceptors), `InMemoryTaskStore`, `DefaultRequestHandler`; or `adk api_server --a2a` serving folders containing `agent.json`. Consume: `RemoteA2aAgent(name, description, agent_card=<AgentCard|URL|path>)` as a `sub_agent`, `AGENT_CARD_WELL_KNOWN_PATH`, `use_legacy` defaults True. a2a-sdk 0.3.x compat, 1.x recommended (a2a-python v1.3.0, 2026-10-27; spec repo a2aproject/A2A v1.0.1, 26,416 stars). Protocol site https://a2a-protocol.org/ . Governance body not confirmed by any page fetched `[UNVERIFIED]`. Sources: https://adk.dev/a2a/ , https://adk.dev/a2a/quickstart-exposing/ , https://adk.dev/a2a/quickstart-consuming/ .

### A.3 What ADK is *not* `[INFERENCE from the above]`

ADK is a developer framework plus local dev tooling plus a Google-managed hosting option. It is not a trust layer: authorization, scoping of tool access, secret handling, release gating and audit are left to plugins, callbacks and the hosting platform. Those are exactly the pieces Echo already has (ESH, SOL broker, CertForge/Harbormaster, ECF ledger), so an Echo ADK is less about an agent loop and more about **binding a loop to Echo's governance**.

---

## B. What Echo already has, mapped onto each ADK primitive

### B.1 Ground truth corrections first `[FACT]`

1. **`echo-cli` `origin/main` is a 4-file commander CLI**, `@echo-omega-prime/cli` v3.4.1: `src/{index,client,config,formatters}.ts`; `EchoClient` posts to the gateway with `X-Echo-API-Key` and unwraps `ApiResponse{success,data,error,meta}`; commands engine/knowledge/brain/doctrine/tools/bots/scrapers/dashboard/auth/worker/forge. There is **no `src/code/` or `src/prime/` on main**.
2. **The Prime / ECHO Code agent exists only on unmerged `agent/*` branches** of echo-cli: `agent/echo-code-muse`, `agent/prime-workspace-unified-19147-20261030`, `agent/prime19147-resume-20261101`, `agent/prime-workspace-parity-20261104`, `agent/prime-parity-live-20261104`, plus local-only parity branches (`composer`, `fleet`, `gemini`, `models`, `swarm`). I read it at **`4a8d21f`** (`agent/prime-parity-swarm-20261104`, newest, "Swarm (40-seat brain) option in the model picker"): 23 files, ~175 KB — `src/code/{agent,commands,continuity,events,mcp,model-factory,model,owners,providers,review,sessions,shared,workspace}.ts` and `src/prime/{chat,commands,hub,sdk,server,stdio,steward-vocabulary,steward,swarm,workspace}.ts`. Everything in §B.2 about "Prime" cites that sha.
3. **Capability counts disagree by source:** `echo.engine.stats` → `{"sdk_capabilities": 7085}`; `SELECT count(*) FROM arcanum_sdk.sdk_capabilities` → **15,351**; `echo-sdk-catalog` README → 13,856; throne doorway text → 1,908 caps. `echo.caps.namespaces` → **476** namespaces (`composite` 3,174, `llm` 796, `elevenlabs` 178, …). I report all four; none is "the" number.
4. **`echo.esh.*` = 0 and `echo.roles.*` = 0 gate caps.** ESH is a separate CLI/MCP/daemon trust layer (repo `echo-shell`, Python, zero deps, 204 tests), not a gate namespace. Roles live in the `echo-fleet-roles` plugin and `echo.fleet.list_roles`.
5. **Echo's "A2A" is not Agent2Agent.** `echo.a2a.protocol` → `{"protocol":"echo-a2a/1.0","version":"1.1.0-perf", card at "/.well-known/agent.json", delegate/broadcast by capability-intersection scoring}`; repo `echo-a2a-protocol` (Cloudflare Worker, Hono/D1; README says the secure revision is **not yet the live Worker**). ADK speaks the Agent2Agent protocol (https://a2a-protocol.org/ , spec repo `a2aproject/A2A`, via a2a-sdk) with the card at `/.well-known/agent-card.json`; its governing body was not confirmed by any page fetched. Same acronym, different wire. `[FACT]` for both sides; the collision is the gap.
6. **SOL broker scope today:** `sol_sdk.py` `DEFAULT_BROKER_SCOPES` begins with `"*"` ("Commander directive 2026-10-06: every fleet role … gets full access") plus role specialty scopes from `role_power_registry.json`; `MissionStore.validate_broker_token` checks hash, expiry, revocation and exact-or-prefix-wildcard scope match. So "scoped broker" is currently enforced by the **gate's tier/HMAC/forbidden-op checks**, not by SOL's token scopes. `[FACT]`
7. **FORGE runtime:** `python3 --version` → **3.12.3** (`python3.11` absent). google-adk requires ≥3.11, so ADK is installable on FORGE/ANVIL/TEMPER today. `[FACT]`
8. The echo-roundtable README (Aug 2026) states `echo-sovereign-action-broker` ran with `SAB_REQUIRE_AUTH=0` and a fail-open `require_auth` (queued as #29366). **Per that README; not re-verified live.** `[UNVERIFIED-live]`

### B.2 Mapping table

| ADK primitive | Echo equivalent today | Where it lives (verified) | Gap `[INFERENCE]` |
|---|---|---|---|
| `LlmAgent` (model + instruction + tools) | Prime `runTurn` (system `INSTRUCTIONS`, `mode: read-only\|propose`, `maxSteps ≤ 30`, prompt ≤ 12,000 chars) over a `Model`; fleet role = instruction set (SKILL.md + boot prompt) | echo-cli `4a8d21f:src/code/agent.ts`; `FLEET_ROLES/*.md`; `echo.fleet.list_roles` returns `{name, tier, primary_skill, composed_skills, capability_families, boot_prompt, dispatchable, spawnable}` | No declarative Agent object; instruction/tools/model are wired per surface (Prime, Claude Code plugin, Codex powerpack). An `EchoAgent{role, skills, capabilities, model}` record is missing |
| `BaseLlm` / model connector | `Model` interface `next(messages, signal) → Action`; `LocalModel` (loopback Ollama, `validateEndpoint` refuses non-loopback or credentialed URLs); `CliModel` (claude/codex/grok/agy subprocesses); `ModelRouter` (probe, pin session to model, Argon variants); gate-side `echo.llm.call` (unified router, params provider/model/prompt\|messages/`allow_reroute?`), `echo.qwen.local.openai_chat` (OpenAI-compatible, FORGE Qwen 27B 128K route, health **amber**), 60+ `echo.llm.<provider>.<model>` caps | `src/code/model.ts`, `providers.ts`, `model-factory.ts` (defaults: `http://127.0.0.1:11450`, model `c3po-code:echo-qwen38-abliterated-256k`, 262,144 ctx); gate caps via `echo.caps.list` | Prime's model returns one JSON **Action**, not free text + tool calls; ADK wants a chat-completion `BaseLlm`. Need an adapter in either direction. `allow_reroute` on `echo.llm.call` must be pinned off for the no-silent-fallback rule |
| Tool / `FunctionTool` / `BaseToolset` | A **capability** (`arcanum_sdk.sdk_capabilities` row: id, tier, scope, `input_schema_json`, health); discovered via `echo.caps.{list,search,detail,namespaces,ask}`; invoked via `POST /sdk/invoke {envelope_version:1, capability, params, context:{bypass_reason}}` (tier ≥2 needs ≥50-char reason / HMAC); Prime `SdkBroker{search, read, invoke}` with `unwrap()` ("transport success is never proof of owner success") | CLAUDE.md § RETRIEVAL; `src/prime/hub.ts`, `src/prime/sdk.ts`; ESH `forge_registry.py` pattern (one registry → two surfaces) | Caps already carry JSON schemas → auto-generating `FunctionTool`s is mechanical. Missing: a default-deny allowlist + tier gate at the tool layer (ESH does this for shell, not for caps) |
| `ToolContext` (state, artifacts, auth, memory) | ESH envelope (`ok, exit, tier, verdict, untrusted:true, audit_id, needs/how`), SOL run_id, broker token read from env at call time | Forge docs `esh-concepts`, `esh-tiers-and-trust`; `sol_sdk.py` | No unified per-call context object across cap/shell/memory calls |
| Workflow / graph (ADK 2.0 nodes) | Build queue `echo.prompts.{add,claim,update,complete,get,list,reap,health}` with SOL leases (`reserve_work_ownership`, `lease_seconds`); fleet dispatch `echo.fleet.{dispatch,broadcast,inbox,roster}` (memory-spine episodes); lanes `echo.lanes.{list,status,scale,control}` (families on HAMMER: agentless, aider, amazon-q, amp, …); pipeline commander→architect→builder→enhancer→publisher; Maximalist 40-seat fusion (`MAXIMALIST_RECONSTRUCTED`, `historical_parity:false`) | gate caps (verified counts 8/10/4); `sol_sdk.py`; repo `maximalist-reconstructed`; Prime `swarm.ts` client (loopback `:8358`, budget clamp `max_calls≤120, max_cost_usd≤5, max_wall_s≤4800`) | Echo's "graph" is a queue + dispatch, not an in-process node graph with typed edges/state. Fine for fleet-scale; missing for a single agent's sub-steps |
| `Runner` + `Event` loop | Prime `runTurn` loop (append → model.next → act → append), `events.ts`; ESH per-call envelope + hash-chained ledger; SOL mission events | `src/code/agent.ts`, `events.ts`; ESH ledger | No yield/pause/resume event stream contract; no `partial` streaming events |
| `Session` / `SessionService` | Prime `SessionStore` (durable sessions, `lease(sessionId)`, proposals, checkpoints, workspace binding); ESH named sessions (`session_version`, single owner, `--expect-version`); throne/Prime chat sessions | `src/code/sessions.ts`; ESH docs | Equivalent for one agent; no `app_name/user_id` tenancy model. ADK's `DatabaseSessionService` on FORGE Postgres is a zero-code fit |
| `MemoryService` | **Crystal Memory** (MCP `echo-crystal-memory` v1.3.0: 149,998 crystals — 147,391 working / 1,869 episodic / 736 crystal; bge-small embeddings; OCR heartbeat live) and **ECF** (`echo.continuity.{capture,recall,status,attention}`: 27,470 events, `chainOk:true`, `canWrite:true`); Prime `continuity.ts` checkpoints with verified receipts; `echo.context.{remember,recall}`; `echo.brain.*` | `crystal_status`, `continuity_status` live; `src/code/continuity.ts` | Richer than ADK memory (ledger receipts, attention queue). Missing only the `BaseMemoryService` adapter |
| `ArtifactService` | ESH artifact handles (`esh artifact <handle> --tail/--grep/--offset`), MinIO on ANVIL (`http://anvil:9000`), build evidence in CertForge | ESH docs; CLAUDE.md fleet section | Adapter only |
| Callbacks / Plugins | ESH pipeline (kill switch → ownership → idempotency → **tiered classifier** → dead-man → grants → budgets → vault expansion → execute → ledger); fleet plugin hooks (`SessionStart`/`UserPromptSubmit` `role_context.py`, `PreToolUse` `role_adoption_gate.py`); risk-action-review plan fields; echo-cognition trust ladder | `esh-tiers-and-trust`; `echo-fleet-roles/hooks/hooks.json`; `echo-fleet-base` SKILL | Strong equivalent, host-specific (Claude Code hooks, ESH). Needs a host-neutral plugin interface |
| **Skills (Agent Skills spec)** | **Already compatible.** `echo-fleet-roles` plugin v1.2.2 ships 34 `SKILL.md` dirs (30 roles + base + switching + reconciliation + stranded) with `name`/`description` frontmatter; `echo-ai-skills` repo ships a skill pack with `skill_gateway.py` and per-host adapters | `…/CLAUDE_CODE_MARKETPLACE/plugins/echo-fleet-roles/skills/`; repo `echo-ai-skills` | Near-zero: validate names against the ≤64-char kebab rule and dir-name match; load with `SkillToolset`. Highest-leverage interop point found |
| `AgentTool` / sub-agents / transfer | fleet `dispatch`/`broadcast`; swarm council (`echo-swarm` modes Parallel/Roundtable/Debate/Conductor/Build Heavy; `echo.swarm.ask`); steward typed proposals (`validateStewardProposal`: decision ACT/NO_ACTION/ESCALATE, `risk_tier`, `reversible`) | gate caps; `src/prime/steward.ts`; repo `echo-swarm` | Cross-process only; no in-process sub-agent tree |
| MCP (client/server) | Echo **is** MCP-native: servers `esh`, `echo-sdk` (search/read/invoke), `echo-crystal-memory`, `echo-continuity-startup`, `echo-swarm`, `echo-credential-broker`, `echo-qcoder`; Prime `mcp.ts` exposes 3 read-only tools (`echo_code_list/read/search`, protocol `2024-11-05`) | this session's MCP roster; `src/code/mcp.ts` | None for consumption: ADK `McpToolset` can use every Echo MCP server today with `tool_filter`. Server-side: Echo exposes tools, not whole agents |
| A2A | `echo-a2a-protocol` (`echo-a2a/1.0`, `/.well-known/agent.json`) + `echo.a2a.{agents,health,protocol}` | gate caps; repo | **Different protocol** (see B.1.5). Needs a card/task adapter or a decision |
| Evaluation | CertForge (`echo.certforge.*` **47 caps**: submit, run, verdict, verify, evidence, deploy_gate, publish, …), Judge role, proofline verification (`Test-EchoOpsEvidence.ps1`, SHA-256-bound proof JSON), risk gate (`Test-EchoOpsRiskGate.ps1`) | gate caps; `echo-fleet-base` SKILL | Echo evaluates **releases**, not agent trajectories. No `.evalset.json`-style trajectory tests |
| Deploy | FORGE systemd units (`echo-<svc>.service`, ports 8093–8149), Harbormaster release contract (stage → canary → promote → verify → rollback, immutable evidence), Cloudflare tunnel ingress; builds registered via `echo.builds.{log,recent,search}` | CLAUDE.md fleet section; `echo-harbormaster-power` SKILL | ADK's "any container host" path maps directly. No `adk deploy` analogue; Harbormaster is the stronger gate |
| Auth / identity | SOL broker tokens (hashed, TTL, revocable, scoped `*` by default), gate `X-Echo-API-Key` + HMAC for tier ≥2, `echo-credential-broker` ("agents may USE credentials, never READ them", `vault://` handles), `echo-sovereign-action-broker` (scoped short-lived creds + approvals + hash-chain audit; auth status per B.1.8) | `sol_sdk.py`, `sol_core.py`; repos | ADK has agent-auth/user-auth guidance only. Echo is ahead; the gap is making the broker **exact-cap scoped** for ADK agents |
| Dev UI / CLI (`adk web/run/api_server/eval`) | `echo` CLI (gateway client), `sol_cli.py sdk invoke`, `esh` CLI, `qcoder`, throne room web | repos | No agent-authoring CLI (`create`/`run`/`eval` of an agent definition) |
| TS SDK surface | `echo-sdk` (public, zero-dep TS, 37 modules incl. `agent.ts` → `/agent/create` `/agent/run` with `{name, personality, domain, instructions, tools[], maxTurns, temperature}`, `swarm.ts`, `fleet.ts`, `model-host.ts`, `tools.ts`, `workflows.ts`); `echo-agent-runner` is **README-only** (one line) | `gh api` trees | `echo-sdk/agent.ts` is a remote "agent service" client, not a local kit; the server side of `/agent/*` was not located in this research `[OPEN]` |

---

## C. Three options for an Echo ADK

Each option is scored against the five hard rules: **(R1)** no token handling by agents, **(R2)** no silent fallback, **(R3)** scoped broker, **(R4)** proof gates, **(R5)** fail-closed.

### Option 1 — `echo-adk-plugin`: a thin Echo layer *for Google ADK* (Python pip package)

Shape `[INFERENCE]`: `EchoModel(BaseLlm)` → `echo.llm.call` / `echo.qwen.local.openai_chat` through the SOL broker, or `LiteLlm(model="hosted_vllm/...", api_base=<loopback /v1>)` with **no** `api_key`; `EchoToolset(BaseToolset)` generating `FunctionTool`s from `echo.caps.detail` schemas with a default-deny allowlist and tier gate; `EchoSessionService` = `DatabaseSessionService("postgresql+asyncpg://…FORGE")`; `EchoMemoryService(BaseMemoryService)` over Crystal + ECF; `EchoArtifactService` over MinIO/ESH artifacts; `EchoGovernancePlugin(BasePlugin)` (before_tool classification, after_tool redaction + `untrusted`, on_*_error no retry, after_run → ECF capture + `echo.builds.log`); deploy with `get_fast_api_app(...)` under systemd on FORGE/ANVIL instead of Agent Runtime.

- Effort: 6–8 build-prompt slices. Reuses every Echo service unchanged and all of ADK's dev UI, eval, CLI, MCP/A2A code.
- Risk: dependency weight (~24 hard deps incl. fastapi/starlette/otel pins) vs Echo's zero-dep posture; monthly 2.x releases (2.0 → 2.13 in five months) and the 2.0 break show API churn; Python-only (TS/Go/Java would each need their own plugin).
- Lock-in: ADK concepts and Google-governed release cadence; Echo data stays in Echo.
- Hard rules: R1 **pass only with a custom `BaseLlm` or key-less loopback** (stock `LiteLlm(api_key=)` fails R1); R2 requires disabling ADK's model-router failover and `RetryConfig` for model calls (pass, by configuration); R3 depends on minting exact-cap broker tokens (today `*`) — enforced at the gate, not SOL; R4 via plugin `after_run` → CertForge/ECF (pass); R5 via default-deny toolset (pass, by construction in Echo code).

### Option 2 — standalone `echo-adk` (Python + TypeScript) with Echo-native primitives

Shape `[INFERENCE]`: `Role`, `Skill`, `Capability`, `Lane`, `Lease`, `Proof` as first-class types; an `EchoRunner` whose events are ESH/SOL envelopes; `Model` = Prime's `next(messages) → Action` contract; graph of nodes mirroring ADK 2.0's `BaseNode` shape (not 1.x Sequential/Parallel/Loop); own eval and CLI.

- Effort: 15–25 slices, roughly doubled for two languages (runner, event stream, session store, eval harness, dev UI all rebuilt).
- Risk: re-inventing commodity parts; no community; maintenance debt; slower to a first useful agent.
- Lock-in: none external; strong Echo-internal coupling.
- Hard rules: all five by construction (strongest), because the only model path is the broker/loopback and the only tool path is the capability registry.
- Reuse: Prime `src/code` + `src/prime` (TS), ESH classifier/grants, SOL broker, fleet skills, `echo-sdk` module shapes.

### Option 3 — hybrid: Echo-native core + ADK / A2A / MCP / Skills adapters

Shape `[INFERENCE]`: a **small zero-dependency Echo core** (`echo_adk.core`: the six primitives + envelope + `EchoBroker` + policy = ESH tiers) that is the single source of truth, and **generated adapters**: `echo_adk.adk` (Option 1's classes, generated from the same registry — the ESH "one registry, two surfaces" rule), `echo_adk.mcp` (expose core agents/tools as MCP; Echo MCP servers consumed as-is), `echo_adk.a2a` (Agent2Agent card/task adapter over `echo-a2a-protocol`), `echo_adk.skills` (Agent Skills loader over fleet skills). TS parity later by lifting Prime's TS core.

- Effort: 8–12 slices to a deployed first agent; the core is small because governance already exists.
- Risk: two surfaces drifting — mitigated by generating the ADK surface from the core registry and a drift test (ESH already does this for verbs vs MCP tools).
- Lock-in: low; ADK is an adapter, swappable for the next framework.
- Hard rules: enforced **in the core** (R1 model path is broker/loopback only; R2 `ProviderUnavailable` semantics, `allow_reroute=false`; R3 broker tokens minted per-agent with exact cap ids; R4 `Proof` is a required output of every run and is what CertForge/Harbormaster consume; R5 default-deny registry). Adapters can only narrow.

### C.4 The three discriminators (what actually decides) `[INFERENCE from FACTS]`

1. **R1 no-token:** stock ADK model connectors assume `api_key`/env secrets in agent code; Echo's compliant paths are (a) Prime's rule — a credential-free loopback origin (`validateEndpoint`), (b) a custom `BaseLlm` that calls `echo.llm.call` through the broker, or (c) `echo-credential-broker` handles. Option 2/3 make (a)/(b) the *only* path; Option 1 relies on developers not using `LiteLlm(api_key=)`.
2. **Footprint and placement:** google-adk's dep tree is acceptable on FORGE (Python 3.12.3 present) for CPU-light agents, but it is not the zero-dep posture of `echo-shell`, `echo-sdk`, `model.ts`. Keeping the **core** zero-dep and the ADK adapter optional (extra `echo-adk[adk]`) satisfies both.
3. **Interop surface:** ADK already consumes MCP servers and exposes agents as MCP/A2A; every Echo MCP server works with ADK **today**. Echo's own A2A is a different protocol. An adapter layer is needed regardless of option — which is Option 3's premise.

---

## D. Recommendation

**Build Option 3, shipping Option 1's classes as its first adapter, in Python first.** `[INFERENCE]`

Why, in the order the evidence forces it:
1. Echo's differentiator is governance (ESH tiers/grants/ledger, SOL leases, CertForge/Harbormaster proof, ECF receipts). ADK's differentiator is the commodity loop, dev UI, eval and MCP/A2A plumbing. Option 3 keeps each where it is strongest and lets the Echo core own the five hard rules by construction (§C.4).
2. The cheapest wins are already aligned: fleet skills are Agent Skills (`SkillToolset` loads them), Echo MCP servers are consumable by `McpToolset`, FORGE Postgres fits `DatabaseSessionService`, FORGE has Python 3.12.3.
3. ADK 2.0's graph/node model is the shape to mirror; the 1.x Sequential/Parallel/Loop classes are deprecated — a standalone kit (Option 2) would otherwise copy the wrong generation, and a pure plugin (Option 1) would inherit monthly churn with no Echo-owned contract to insulate against it.
4. Python-first because the governed runtime pieces (ESH, SOL, Crystal, CertForge journeys, Qwen serving) are Python and FORGE-hosted; TS parity comes from lifting Prime's TS core, which is the only Echo code that already implements the Model/Action/Workspace contract.

**Repo name proposal:** `echoomegaprime/echo-adk` — confirmed free (`gh repo view` → "Could not resolve to a Repository"); `echo-agent-kit` also free. Start from `echo-repo-template` (ADR-0005). `[FACT]` for availability.

**Package names:** PyPI-style `echo-adk` (import `echo_adk`), extras `echo-adk[adk]` (google-adk), `echo-adk[a2a]` (a2a-sdk ≥1.x); later npm `@echo-omega-prime/adk`.

### D.1 Existing code to lift (cite exact locations)

| From | What | Into |
|---|---|---|
| echo-cli `4a8d21f:src/code/model.ts` | `Model`/`Action` contract, `validateEndpoint` (loopback-only, credential-free), `parseAction` | core model contract (port to Python; keep TS for parity) |
| `…:src/code/providers.ts` | `CliModel` (claude `-p --output-format json …`, codex `exec --json --ephemeral -s read-only`, grok `--output-format json --prompt-file`, agy `--mode plan`), `childEnv` allowlist (drops anything matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`), `ProviderUnavailableError` ("no fallback was used") | `echo_adk.models.cli` |
| `…:src/code/model-factory.ts` | `ModelRouter` (probe cache, pinned session model, Argon variant verification, "default is never substituted"), strict `parseModelsConfig` | `echo_adk.models.router` |
| `…:src/code/workspace.ts` | `Workspace` boundary (BLOCKED path regex incl. `.env`, `.ssh`, `AGENTS.md`, `CLAUDE.md`; symlink/hardlink refusal; 64 KB bound), `redact()`, `Proposal` lifecycle | `echo_adk.workspace` |
| `…:src/code/agent.ts` | `runTurn` (caller-selected `mode`, step budget, evidence hashes, `answerVerification`) | `EchoRunner` reference semantics |
| `…:src/code/continuity.ts` | checkpoint → `echo.continuity.capture` with receipt verification states (`prepared/blocked/uncertain/saved/verified/conflict`) | `EchoMemoryService` write path |
| `…:src/prime/hub.ts`, `sdk.ts` | `SdkBroker{search,read,invoke}`, `unwrap()` envelope decoding, `Refused`, payload bounds | `EchoBroker` |
| `…:src/prime/steward.ts` | typed-vocabulary proposal validation (`cap/command/options`, `risk_tier`, `reversible`, verify must be tier 0) | `Capability`/`Proposal` schema |
| `…:src/prime/swarm.ts` | `clampBudget`, loopback-only `parseSwarmConfig`, `sanitize()` | `Lane` budgets |
| `echo-shell` (`esh/forge_registry.py`, classifier, grants) | one-registry-two-surfaces generation + drift test; tiers 0/1/2/3/hard; signed grants; kill switch | `echo_adk.policy` + adapter generation |
| `Echo.SolProfile …/codex_auto/sol_sdk.py`, `sol_core.py` | `ScopedBroker`, `validate_broker_token`, queue leases (`reserve_work_ownership`, `renew_queue_lease`) | `Lease` + broker client |
| `echo-fleet-roles` (`skills/*/SKILL.md`, `config/role_power_registry.json`, `hooks/*.py`) | 34 Agent-Skills-shaped skills; role → scopes contract; adoption gate | `echo_adk.skills`, `Role` |
| `echo-ai-skills` (`scripts/skill_gateway.py`, `adapters/*.md`) | context-budgeted skill hot-load; per-host adapters | skills loader |
| `echo-sdk` (`src/agent.ts`, `client.ts`, `swarm.ts`, `fleet.ts`) | public TS SDK shapes for a future `@echo-omega-prime/adk` | TS parity |
| `echo-a2a-protocol` (`src/types.ts`, `schema.sql`) | echo-a2a card/task types | A2A adapter |

### D.2 Build-prompt-sized slices (2–4 h each; title → acceptance)

1. **echo-adk repo bootstrap** — from `echo-repo-template`; `pyproject` (py ≥3.11, zero-dep core, extras `adk`,`a2a`), CI lint+test, SECURITY.md stating the five rules. *Accept:* fresh clone → `python -m echo_adk doctor` passes; CI green; `echo.builds.log` receipt.
2. **Core primitives + envelope** — `Role, Skill, Capability, Lane, Lease, Proof` dataclasses + JSON Schema; `Capability.from_caps_detail()`. *Accept:* round-trip tests; schema validates against live `echo.caps.detail` for 20 caps across 5 namespaces.
3. **EchoBroker** — SOL token read from env at call time (never logged), `invoke(capability, command, options, idempotency_key, reason)`, `unwrap()` lifted from `hub.ts`, redaction. *Accept:* live tier-0 call (`echo.caps.list`); out-of-scope token refused; secret-shaped option refused.
4. **EchoModel (no-token)** — `BaseLlm` impl routing to `echo.qwen.local.openai_chat` / `echo.llm.call` with `allow_reroute=false`; refuses `api_key` config; `ProviderUnavailable` naming the provider. *Accept:* an ADK agent answers via FORGE Qwen; a forced provider failure yields the named error and **no** second model call (test asserts call count).
5. **EchoToolset** — `BaseToolset` generating `FunctionTool`s from `input_schema_json`; default-deny allowlist; tier ≥2 refused without a `Lease`; `ToolContext.state` carries `proof_ids`. *Accept:* `tool_filter` semantics; refused tier-2 test; 3 live tier-0 caps execute.
6. **EchoGovernancePlugin** — `before_tool` (classification/lease), `after_tool` (redact + `untrusted:true`), `on_*_error` (no silent retry), `after_run` (→ `echo.continuity.capture` + `echo.builds.log`). *Accept:* plugin test suite; live ECF receipt read back.
7. **EchoMemoryService + EchoArtifactService** — Crystal/ECF search + capture; artifact save/load via ESH handles or MinIO. *Accept:* `add_session_to_memory` then `search_memory` returns the entry; artifact version round-trip.
8. **Skills bridge** — load `echo-fleet-roles` + `echo-ai-skills` `SKILL.md` dirs into `SkillToolset`; validate against the Agent Skills constraints. *Accept:* all 34 fleet skills load; a report lists any name/length violations.
9. **MCP + A2A adapters** — `to_mcp_server` (stdio) for an echo-adk agent; `to_a2a` card at `/.well-known/agent-card.json`; translator from `echo-a2a/1.0` `agent.json`. *Accept:* `McpToolset` consumes it; `RemoteA2aAgent` consumes it; card translation test.
10. **Deploy slice** — `echo-adk-api.service` on FORGE or ANVIL running `get_fast_api_app` with `DatabaseSessionService` on FORGE Postgres, loopback bind, port registered. *Accept:* `/health` green; CertForge `submit` → `verdict`; Harbormaster manifest published; rollback drill recorded.
11. **Eval harness** — `.evalset.json` for three Echo agents (knowledge lookup, cap discovery, build-queue claim dry-run) with `tool_trajectory_avg_score`. *Accept:* `adk eval` passes in CI; an injected wrong trajectory fails.
12. **TS parity ADR** — decide `@google/adk` 2.4.0 adapter vs lifting Prime TS core; one spike test. *Accept:* ADR merged with decision and evidence.

---

## E. Open questions for the Commander (research cannot answer these)

1. **Canonical Prime branch.** The ECHO Code/Prime agent exists only on unmerged `agent/*` branches (newest `agent/prime-parity-swarm-20261104` @ `4a8d21f`). Lift from that sha now, or merge Prime to `main` first? `[OPEN]`
2. **A2A naming collision.** Keep `echo-a2a-protocol` (`echo-a2a/1.0`) as Echo's wire and adapt to Agent2Agent, adopt Agent2Agent (a2a-sdk) as the fleet's inter-agent protocol, or rename Echo's to avoid the acronym? `[OPEN]`
3. **Broker scope for kit agents.** `DEFAULT_BROKER_SCOPES` is `*` by the 2026-10-06 directive. Should `echo-adk` mint **exact-cap-id** tokens per agent by default (R3 by construction), overriding the fleet default for this surface? `[OPEN]`
4. **Google dependency in the core.** `google-adk` pulls `google-genai`/`google-auth`. Acceptable as an optional extra (recommended), or must the kit have no Google code at all (Option 2)? `[OPEN]`
5. **Hosting placement.** ADK agents are CPU-light, but FORGE is the gate + Postgres host (#31853 bans heavy inference there). Run `echo-adk-api` on FORGE or on ANVIL/TEMPER? `[OPEN]`
6. **Public vs private repo** for `echo-adk` (echo-sdk/echo-cli are public; Prime branches are not published). `[OPEN]`
7. **Lease issuer.** Is `echo-sovereign-action-broker` (reported fail-open per the roundtable README, #29366) intended to issue `Lease`s for kit agents, or SOL broker + ESH signed grants only? `[OPEN]`
8. **Language order.** Python-first (this recommendation) vs TypeScript-first (Prime, echo-sdk, echo-cli are TS; `@google/adk` 2.4.0 exists). `[OPEN]`
9. **The `/agent/*` service behind `echo-sdk/src/agent.ts`.** The public TS SDK already exposes `/agent/create` and `/agent/run` (`{name, personality, domain, instructions, tools[], maxTurns, temperature}`), but this research did not locate the server that implements them. Is it live, and should `echo-adk` become its definition format and runner, or is it legacy to be retired? `[OPEN]`

---

## Appendix — primary sources used

Official ADK: https://adk.dev/ · https://adk.dev/2.0/ · https://adk.dev/get-started/installation/ · https://adk.dev/agents/ · https://adk.dev/agents/llm-agents/ · https://adk.dev/agents/workflow-agents/ · https://adk.dev/agents/models/ · https://adk.dev/agents/models/litellm/ · https://adk.dev/agents/models/vllm/ · https://adk.dev/runtime/ · https://adk.dev/runtime/event-loop/ · https://adk.dev/sessions/ · https://adk.dev/sessions/session/ · https://adk.dev/sessions/memory/ · https://adk.dev/artifacts/ · https://adk.dev/callbacks/ · https://adk.dev/plugins/ · https://adk.dev/skills/ · https://adk.dev/safety/ · https://adk.dev/evaluate/ · https://adk.dev/deploy/ · https://adk.dev/deploy/cloud-run/ · https://adk.dev/deploy/agent-runtime/ · https://adk.dev/tools-custom/function-tools/ · https://adk.dev/tools-custom/mcp-tools/ · https://adk.dev/tools-custom/mcp-tools/agent-as-server/ · https://adk.dev/a2a/ · https://adk.dev/a2a/quickstart-exposing/ · https://adk.dev/a2a/quickstart-consuming/ · https://adk.dev/sitemap.xml

Registries / repos: https://pypi.org/pypi/google-adk/json · https://registry.npmjs.org/@google/adk · https://github.com/google/adk-python · https://github.com/google/adk-js · https://github.com/google/adk-go · https://github.com/google/adk-java · https://github.com/google/adk-samples · https://github.com/google/adk-web · https://github.com/a2aproject/A2A · https://github.com/a2aproject/a2a-python · https://a2a-protocol.org/ · https://agentskills.io/specification

Press (ADK 2.0 dates): https://virtualizationreview.com/articles/2026/05/19/google-io-26-fills-out-enterprise-agent-stack-with-managed-agents-adk-2.0.aspx · https://developers.googleblog.com/en/announcing-adk-go-20/ · https://dev.to/peytongreen_dev/google-adk-20-is-now-stable-workflow-runtimes-breaking-changes-and-how-to-migrate-4ah8

Echo (verified live or read): `echoomegaprime/echo-cli` `origin/main` and `4a8d21f`; `D:\ECHO_OMEGA_PRIME\01_WORKSPACES\active\QUENCH-ps7-sol-profile\CLAUDE.md` (§ RETRIEVAL, § FLEET ROLES, § ECHO SERVICE FLEET); `…\Echo.SolProfile\1.1.3\runtime\CLAUDE_CODE_MARKETPLACE\plugins\echo-fleet-roles\{skills,hooks,config}`; `…\runtime\SYSTEMS\codex_auto\{sol_sdk.py,sol_core.py,sol_cli.py}`; Forge docs `esh-index`, `esh-concepts`, `esh-tiers-and-trust`, `esh-forge-spec`, `GOOGLE_CLOUD/AI_ML/GEMINI/AGENT_BUILDER.md`, `github-echoomegaprime-echo-fleet-roles-readme-md`; gate caps via `echo.caps.{list,detail,namespaces}`, `echo.engine.stats`, `echo.a2a.protocol`, `echo.fleet.list_roles`, `echo.lanes.list`, `echo.psql.query`, `echo.shell.run`; MCP `crystal_status`, `continuity_status`; `gh repo list echoomegaprime` (153 repos) and READMEs of echo-sdk, echo-shell, echo-a2a-protocol, echo-agent-runner, echo-swarm, maximalist-reconstructed, echo-sovereign-action-broker, echo-credential-broker, echo-fleet-roles, echo-qcoder, echo-roundtable, echo-ai-skills, account-continuity-bridge, echo-nexus, echo-crystal-memory.
