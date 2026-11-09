# Prime live tools (always on)

## 1. Purpose

Per Commander order 2026-11-04, every model turn routed by ECHO Prime has live internet access, corporate and computational knowledge APIs (such as Wolfram|Alpha), Echo knowledge and memory retrieval, local Agent Skills, and allow-listed MCP plugins enabled by default.

Prime never holds a vendor API key:

- `web_search`, `wolfram`, `echo_knowledge`, and `echo_memory` invoke Echo SDK gate capabilities through the authenticated `SdkBroker` (`sdkToolInvoke` in `src/prime/tools-bridge.ts`). Vendor credentials remain vaulted for the gate.
- `web_fetch` performs a direct, bounded public HTTP/HTTPS read with no credential.
- `skills` reads local `SKILL.md` and `references/` files from owner-configured directories on disk.
- `mcp_plugins` calls Prime's own configured stdio MCP connections (`connectionGateway` in `src/prime/tools-bridge.ts`, wired to `esh` and `sdk` in `src/prime/commands.ts`) behind an explicit allow-list.

All tool outputs are treated as untrusted data: redacted, size-bounded, and wrapped before being returned to the model.

---

## 2. Tool catalogue

Registry order in `TOOL_MODULES` (`src/code/tools/index.ts`):

| Tool | Family | Audience | Backing capability / mechanism | Cache TTL | Live status (2026-11-05) |
|---|---|---|---|---|---|
| `web_search` | `web` | owner, member | Gate `echo.websearch.query` (`command: "query"`) | 10 min (`600000` ms) | LIVE (Tavily) |
| `web_fetch` | `web` | owner, member | Direct `node:http` / `node:https` `GET` + `dns.lookup` | 60 min (`3600000` ms) | LIVE |
| `wolfram` | `wolfram` | owner, member | Gate `echo.wolfram.llm` (`command: "llm"`) | 24 h (`86400000` ms) | LIVE |
| `echo_knowledge` | `knowledge` | owner, member | Gate `echo.knowledge.search` / `echo.knowledge.get` | 5 min (`300000` ms) | LIVE |
| `echo_memory` | `knowledge` | owner, member | Gate `echo.context.recall` (+ optional `echo.crystal.search`) | 5 min (`300000` ms) | LIVE (`crystal` off by default) |
| `skills` | `skills` | owner only | Local filesystem scan (`SKILL.md` + `references/`) | 10 min (`600000` ms) | NEEDS CONFIG (`tools.skills.roots`) |
| `mcp_plugins` | `mcp` | owner only | `connectionGateway` over Prime's `esh` / `sdk` MCP connections | Off (`0` ms) | NEEDS CONFIG (`tools.mcp.allow`) |

Common input guards (`src/code/tools/util.ts`) apply before any module runs: total serialised arguments must not exceed 16 KB (`16384` bytes), unknown argument names are refused, strings are trimmed and rejected if empty or containing control characters other than `\n` and `\t`, and any argument key matching `secret`, `password`, `passphrase`, `api[_-]?key`, `access[_-]?token`, `refresh[_-]?token`, `private[_-]?key`, `authorization`, or `credential` (to depth 6) throws `ToolRefused`.

### `web_search`

- **Family**: `web`.
- **Arguments (`spec.params`)**:
  - `query` (`string`, required, max `400`): Plain search query.
  - `max_results` (`integer`, optional, min `1`, max `10`, default `5` in `run`): Number of ranked results.
- **Calls**: SDK gate `echo.websearch.query` (`command: "query"`, options `{ query, max_results }`).
- **Result shape**:
  - Success: `{ ok: true, provider, query, retrieved_at, answer, results }`, where `provider` is `"Echo web search (Tavily via SDK gate echo.websearch.query)"`, `answer` is `string | null` (clipped to 1,500 chars), and `results` contains `{ rank, title, url, snippet, date, score }` items with non-null `url`.
  - Empty response: `{ ok: false, provider, query, error, retrieved_at }`.
- **Cache TTL**: 10 minutes (`600000` ms).
- **Limits and refusals**: Unavailable when `env.sdk` is not attached; rows without `url`/`link` are dropped; `title` is clipped to 300 chars, `url` to 2,048, `snippet` to 600, and `date` to 60.
- **Live status**: **LIVE** — Tavily behind `echo.websearch.query`, probed 2026-11-05.

### `web_fetch`

- **Family**: `web`.
- **Arguments (`spec.params`)**:
  - `url` (`string`, required, max `2048`): Absolute public HTTP(S) URL.
- **Calls**: `publicTarget` + `dnsLookup` (`dns.lookup(host, { all: true })`) + `nodeTransport` (`node:http` / `node:https` `GET`, `Accept-Encoding: identity`, `User-Agent: EchoPrime/1.0 (+web_fetch)`). Always reports `available: true`.
- **Result shape**: `{ ok: true, url, requested_url, redirects, http_status, content_type, title, text, fetched_at, bytes, truncated, sha256, javascript_executed }` (`http_status` is `200`, `javascript_executed` is `false`, `sha256` hashes the raw body bytes).
- **Cache TTL**: 60 minutes (`3600000` ms).
- **Limits and refusals**:
  - URL length <= 2,048 chars with no ASCII control or space bytes (`< 33`); schemes `http:` and `https:` only (`file:`, `data:`, etc. refused); embedded `username`/`password` refused; ports `80` and `443` only.
  - Hostnames matching `localhost` or ending in `.localhost`, `.local`, `.internal`, `.lan`, `.home`, `.arpa`, `.test`, `.example`, or `.invalid` are refused.
  - Literal IPs and **every** DNS-resolved address must satisfy `isGlobalIp` (`src/code/tools/util.ts`), refusing unspecified/loopback (`0.0.0.0/8`, `127.0.0.0/8`, `::/8`), RFC 1918 private (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`, `fe80::/10`), unique/site-local (`fc00::/7`, `fec0::/10`), multicast, documentation/benchmark ranges, and IPv4-mapped (`::ffff:`) or NAT64 (`64:ff9b::`) non-global addresses.
  - Up to `3` redirects (`301`, `302`, `303`, `307`, `308`); > 3 redirects throw `ToolRefused`; missing `Location` or non-200 final status fails. Every hop re-runs `publicTarget` DNS validation and pins the validated IP via the request `lookup` callback (`15000` ms hop timeout).
  - Body capped at `256` KiB (`262144` bytes; excess bytes set `truncated: true` and destroy the stream). `Content-Type` must match `text/*` or `application/{json,xml,xhtml+xml,rss+xml,atom+xml,ld+json}` and body must contain no NUL bytes (`ToolRefused` otherwise).
  - HTML processing (`pageText`): strips comments and `<script>`, `<style>`, `<noscript>`, `<template>`, `<svg>`, and `<head>` elements (after extracting `<title>` up to 300 chars), converts block tags to newlines, strips remaining tags, decodes HTML entities, and clips `text` to `20000` chars.
- **Live status**: **LIVE**.

### `wolfram`

- **Family**: `wolfram`.
- **Arguments (`spec.params`)**:
  - `query` (`string`, required, max `400`): Short English keyword or mathematical query.
- **Calls**: SDK gate `echo.wolfram.llm` (`command: "llm"`, options `{ query }`).
- **Result shape**:
  - Success: `{ ok: true, provider, query, result, source, retrieved_at }` (`result` clipped to 8,000 chars; `source` is `https://www.wolframalpha.com/input?i=<encoded>`).
  - Missing/invalid AppID or HTTP 401/403: `{ ok: false, provider, query, error, signup }` (`signup` is `"https://developer.wolframalpha.com/"`).
  - Uninterpretable/empty answer: `{ ok: false, provider, query, error, source }`.
- **Cache TTL**: 24 hours (`86400000` ms).
- **Limits and refusals**: Unavailable without `env.sdk`; non-credential gate failures throw and record status `failed`.
- **Live status**: **LIVE** — `echo.wolfram.health` reported `appid_present: true`, and `echo.wolfram.llm` answered `"integrate x^2 from 0 to 3"` = `9`.

### `echo_knowledge`

- **Family**: `knowledge`.
- **Arguments (`spec.params`)**:
  - `query` (`string`, optional, max `500`): Hybrid search text (omit when reading `doc_id`).
  - `doc_id` (`string`, optional, max `200`): Exact `knowledge_docs` identifier to read in full.
  - `limit` (`integer`, optional, min `1`, max `10`, default `5` in `run`): Maximum search hits.
- **Calls**:
  - With `doc_id`: gate `echo.knowledge.get` (`command: "get"`, `{ doc_id, include_body: true }`).
  - With `query`: gate `echo.knowledge.search` (`command: "search"`, `{ query, limit, snippet_chars: 400 }`).
- **Result shape**:
  - Search: `{ ok: true, source: "echo.knowledge.search", retrieved_at, query, hit_count, hits }` (`hits` items: `{ rank, title, doc_id, path, corpus_id, snippet, score, modes }`).
  - Document read: `{ ok: true, source: "echo.knowledge.get", retrieved_at, doc_id, title, body_sha256, body }` (`body` clipped to 12,000 chars), or `{ ok: false, source, doc_id, error }` if absent.
- **Cache TTL**: 5 minutes (`300000` ms).
- **Limits and refusals**: Unavailable without `env.sdk`; `doc_id` must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/` (`ToolRefused`); calling with neither `doc_id` nor `query` throws `ToolRefused`.
- **Live status**: **LIVE** (`echo.knowledge.search` and `echo.knowledge.get`).

### `echo_memory`

- **Family**: `knowledge`.
- **Arguments (`spec.params`)**:
  - `query` (`string`, required, max `500`): Recall query.
  - `limit` (`integer`, optional, min `1`, max `10`, default `5` in `run`): Memories per source.
  - `kind` (`string`, optional, max `40`): Optional kind filter (e.g. `decision`, `fact`, `lesson`).
- **Calls**: SDK gate `echo.context.recall` (`command: "recall"`, `{ query, limit, kind? }`). When `tools.memory.crystal` is `true`, also calls `echo.crystal.search` (`command: "search"`, `{ query, limit }`).
- **Result shape**: `{ ok: true, source: "echo.context.recall", retrieved_at, query, count, memories, notice }`, where `memories` items carry `{ id, kind, importance, content, created_at, tags }` and `notice` marks the output as historical, unverified reference data. When `crystal` is enabled, adds `crystal` (`{ id, kind, summary, created_at }[]`) or `crystal_error` on failure.
- **Cache TTL**: 5 minutes (`300000` ms).
- **Limits and refusals**: Unavailable without `env.sdk`; `content` clipped to 1,200 chars and `tags` to 8 entries.
- **Live status**: **LIVE** on `echo.context.recall`. Crystal is **off by default** (`tools.memory.crystal: false`) because `echo.crystal.search` ignores its `query` parameter and `echo.crystal.similar` returns HTTP 409 `vector_dimension_mismatch`.

### `skills`

- **Family**: `skills` (owner only).
- **Arguments (`spec.params`)**:
  - `action` (`string`, required, enum `list | load | reference`).
  - `name` (`string`, optional, max `81`): Skill name (required for `load` and `reference`).
  - `file` (`string`, optional, max `130`): File inside the skill's `references/` folder (required for `reference`).
- **Calls**: Local read-only scan (`scanSkills` in `src/code/tools/skills.ts`) across `tools.skills.roots`.
- **Result shape**:
  - `list`: `{ ok: true, level: 1, notice, retrieved_at, count, skills }` (`{ name, description, path }[]`).
  - `load`: `{ ok: true, level: 2, notice, retrieved_at, name, description, path, instructions, references }`.
  - `reference`: `{ ok: true, level: 3, notice, retrieved_at, name, file, path, content }`.
- **Cache TTL**: 10 minutes (`600000` ms).
- **Limits and refusals**: Unavailable when `tools.skills.roots` is empty. Walks up to depth `3` and `200` skills; skips dot-entries, `node_modules`, `references` (during discovery), and all symlinks; requires valid UTF-8 with no NUL bytes and file size <= `48` KiB (`49152` bytes). `name` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/`; `file` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:md|txt|json|ya?ml)$/i` (up to 50 listed) and exist in that skill's `references/` directory (`ToolRefused` otherwise).
- **Live status**: **NEEDS CONFIG** (`tools.skills.roots` defaults to `[]`).

### `mcp_plugins`

- **Family**: `mcp` (owner only).
- **Arguments (`spec.params`)**:
  - `action` (`string`, required, enum `list | schema | call`).
  - `connection` (`string`, optional, max `64`): Connection ID from `list`.
  - `tool` (`string`, optional, max `100`): Tool name from `list`.
  - `arguments` (`object`, optional, max `8192` bytes): JSON arguments for `call`.
- **Calls**: `connectionGateway` (`src/prime/tools-bridge.ts`), which caches each connection's `listTools()` for 60 s, checks that the tool is still advertised, invokes `connection.call(tool, object(args))`, and decodes the response with `unwrap()`.
- **Result shape**:
  - `list`: `{ ok: true, retrieved_at, connections }` (`{ id, name, tools: { name, description }[] }[]`, filtered to allow-listed tools).
  - `schema`: `{ ok: true, retrieved_at, connection, tool, description, input_schema }` (`input_schema` compacted to 6,000 chars).
  - `call`: `{ ok: true, retrieved_at, connection, tool, result, untrusted: true }`.
- **Cache TTL**: `0` (cross-turn caching disabled; within-turn identical-call deduplication still applies).
- **Limits and refusals**: Unavailable when no `McpGateway` is attached or `tools.mcp.allow` is empty; calling or inspecting any `<connection>:<tool>` not both advertised and allow-listed throws `ToolRefused`.
- **Live status**: **NEEDS CONFIG** (`tools.mcp.allow` defaults to `[]`).

---

## 3. How a turn uses tools

1. **System instructions**: When `options.tools` is supplied to `runTurn` (`src/code/agent.ts`), `TurnTools.instructions()` is appended to the `[system]` message. It lists only the tools enabled and currently available for the turn's audience (`- <name> [<family>]: <description> Args: ...`), states the per-turn call and wall-clock budget, defines the two action shapes, marks tool results as untrusted data, and instructs the model to cite URLs verbatim and finish with `final` once the budget is spent.
2. **Action shapes**:
   - Single call: `{"action":"tool","tool":"<name>","args":{...}}` (`tool` must match `/^[a-z][a-z0-9_]{1,40}$/`; omitted `args` defaults to `{}`).
   - Parallel batch: `{"action":"tools","calls":[{"tool":"<name>","args":{...}},...]}` (`1` to `4` calls enforced by `parseAction` in `src/code/model.ts`; `TurnTools.execute` slices to `4`, deduplicates identical calls inside the batch, and runs them concurrently with `Promise.all`).
3. **Result message format**: `runTurn` serialises, redacts, and appends the outcome as a `user` message:
   ```text
   UNTRUSTED TOOL RESULT (tool <name>):
   <json>
   ```
   (For a parallel batch, the label is `tools` and `<json>` is `{"results":[{"tool":"...","status":"...","result":...}]}`.) This conversation history is fed identically to local Qwen (`LocalModel` in `src/code/model.ts` using Ollama structured output `ACTION_FORMAT`) and to CLI providers (`CliModel` in `src/code/providers.ts`, where `render()` formats the `ACTIONS` schema line followed by `<conversation>` blocks `[system]`, `[user]`, and `[assistant]`).
4. **Redaction and compaction**:
   - `redactDeep` scrubs secret assignments, `sk-*` / `gh*_*` tokens, JWTs, and PEM private keys before caching, source extraction, event emission, or model delivery.
   - `compact` (`src/code/tools/util.ts`) shrinks strings and arrays iteratively (up to 12 passes, depth limit 8, max 60 keys per object) to fit `budget.resultChars` (default `6000`; divided across batch items down to a `500`-char floor). Keys matching `url`, `source`, `link`, `href`, `doc_id`, `id`, `path`, `request_id`, `sha256`, `fetched_at`, `retrieved_at`, `provider`, or `date` are kept verbatim up to `2048` chars so sources remain citable.
5. **Within-turn deduplication and cross-turn cache**:
   - `argsKey` hashes `tool + "\n" + JSON.stringify(sorted(args))` (`SHA-256`, with strings trimmed, whitespace-folded, and lowercased).
   - Repeating the same `argsKey` within a turn returns the earlier result with `deduplicated: true` (`evidence.status: "deduplicated"`) at zero budget cost.
   - Otherwise, `ToolCache` (`CACHE_MAX = 500`, process-wide LRU in `ToolKit`) is checked against `spec.cacheTtlMs`. Hits emit `cache_hit: true` (`evidence.status: "cached"`) at zero budget cost; only fresh `"returned"` calls populate the cache.
6. **Budget and per-call timeout**:
   - Default budget: `12` live calls or `60000` ms (`60` s) elapsed from the turn's first tool action, whichever is reached first. Elapsed time includes model generation and gaps between tool actions; it is not accumulated handler time. With owner bot tools attached, ordinary and bot tools consume the same count and deadline, including across a configured provider reroute. Switching to an ordinary tool late in the turn does not restart the clock.
   - Each live invocation gets an `AbortController` timeout of `Math.min(30000, Math.max(1, budget.wallMs - elapsed()))` (30 s per-call cap), further bounded by the shared owner-tool deadline when wrapped. There is no one-second minimum that permits a call to overrun the remaining allowance. A timeout returns an error with `state: "unknown"`; the host stops waiting even when a handler does not cooperate with cancellation. Late results are not cached, exposed as successful results, or accepted as completed parent answers. Cancellation does not prove a remote side effect stopped, and no automatic retry is made.
   - When `calls >= budget.calls` or `elapsed() >= budget.wallMs`, `exhausted` latches and the call returns a `"budget"` error instructing the model to reply with `{"action":"final"}`. If the model continues calling tools after the exhaustion notice (`warned` latch in `TurnTools.execute`), `execute` returns `stop: true` and `runTurn` terminates the turn with `status: "step_limit"`, `answer: tools.summary()`, and `answerVerification: "application_generated"` (also used if `maxSteps` expires after at least one live tool call).
7. **Events and `TurnResult.tools`**:
   - Every call emits `tool_started` (`type`, `tool`, `request_id`, `sha256`, `at`, `arguments?`) and `tool_result` (`type`, `tool`, `request_id`, `sha256`, `at`, `result`, `cache_hit`, `deduplicated`, `duration_ms`, `evidence: { status }` where `status` is `returned | failed | cached | deduplicated | budget | refused`).
   - When `tools` is passed to `runTurn`, `TurnResult.tools` contains `{ calls, exhausted, events, sources }` (up to 40 `http(s)://` `url`/`source` strings gathered from `"returned"` and `"cached"` results).

---

## 4. Configuration

`parseToolsConfig` (`src/code/tools/config.ts`) validates the optional `tools` block of the Prime `--config` JSON file. Tools are **on by default** whenever a `models` section is present (`src/prime/commands.ts`); without `models`, neither `ModelRouter` nor `ToolKit` is created. Unknown keys at any level, wrong types, out-of-range integers, relative paths, and disallowed ESH entries throw at startup.

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `tools.enabled` | `boolean` | `true` | Master switch for `ToolKit` creation and turn attachment. |
| `tools.families.{web,wolfram,knowledge,skills,mcp}` | `boolean` each | `true` | Per-family enable flags. |
| `tools.budget.calls` | `integer` `1..30` | `12` | Live calls per turn (deduped/cached calls do not count). |
| `tools.budget.wallMs` | `integer` `1000..300000` | `60000` | Shared wall-clock ms from the first tool action, including later model/tool gaps. |
| `tools.budget.resultChars` | `integer` `500..20000` | `6000` | Compaction target (characters) per tool action. |
| `tools.skills.roots` | `string[]` (`0..8` items) | `[]` | Absolute directory paths (`<= 1000` chars, no control chars). |
| `tools.mcp.allow` | `string[]` (`0..64` items) | `[]` | Exact `<connection>:<tool>` (`[A-Za-z0-9_.-]`); wildcards rejected by config parser. |
| `tools.memory.crystal` | `boolean` | `false` | Appends `echo.crystal.search` inside `echo_memory`. |

- **ESH allow-list rule**: For `esh:<tool>`, only read tools in `ESH_READS` (`esh_status`, `esh_caps`, `esh_ledger`, `esh_session`) may be allow-listed. Any other `esh:*` entry is refused so ESH actions cannot bypass `hub.prepare` / `hub.execute`.
- **Owner vs member families**: `owner` turns receive all five families (`TOOL_FAMILIES`); `member` turns receive `MEMBER_FAMILIES` (`web`, `wolfram`, `knowledge`), keeping `skills` and `mcp` owner-only.
- **Owner runtime toggle and Plugins & memory**: `GET /api/prime/tools` (`hub.liveTools()`) returns `{ configured, enabled, budget, memberFamilies, families, cache, note }` and `POST /api/prime/tools` (`hub.liveToolsUpdate()`) accepts `{ enabled: boolean }` or `{ family: ToolFamily, enabled: boolean }`. Both routes require the same-origin Prime cookie, `X-Prime-Request: 1`, and (when Workspace is configured) `workspace.requireOwner` admission (`src/prime/server.ts`). Runtime toggles apply in memory until Prime restarts. The **Plugins & memory** dialog (`ui/echo-prime/plugins.js`, `liveToolsCard`) shows the owner a "Live tools · always on" card: the budget line, an all-tools checkbox, one checkbox per family and each tool's Live / Unavailable state with the reason (e.g. "SDK gate not attached", "No skill roots configured"); every toggle POSTs to `/api/prime/tools` and re-reads the report. Members see a static card naming the families that apply to their turns.

The parent chat deadline is configured separately with `chat.turnTimeoutMs`: an integer from `1000` to `300000`, default `120000`. The ordinary CLI validates it before connecting owner services and advertises it through authenticated `/api/status`. The browser uses that value plus `5000` ms of response grace after its bounded status check. Raising it does not change `tools.budget`, the fixed 120-second local model request timeout, the default 180-second vendor CLI request timeout, or a delegated child's independent run budgets. The parent signal and whichever operation deadline arrives first limit the host wait. Stop and a disconnected client propagate cancellation to active parent work; they do not automatically cancel previously admitted child runs or prove remote termination. See [the complete parent and child limit contract](PRIME_AUTOAGENTS.md#3-chat-execution-and-bounded-delegation).

### Integration points the brain agent must keep

Two additive lines connect the registry to the loop; everything else lives under `src/code/tools/`:

- `src/code/agent.ts`, inside the `instructions` template: `${INSTRUCTIONS}${tools ? '\n' + tools.instructions() : ''}` plus the `case 'tool': case 'tools':` branch that calls `tools.execute(action, options.onToolEvent, signal)`.
- `src/prime/chat.ts`, in the router `runTurn(...)` call: `tools:this.options.tools?.forTurn({audience:'owner'})`.

Adding a tool = one module under `src/code/tools/` plus one entry in `TOOL_MODULES` (`src/code/tools/index.ts`).

---

## 5. Keys and funding

Vendor keys are funded by the Commander and stored in Vault for the SDK gate; they are never placed in Prime config files, passed to vendor CLIs (`childEnv` in `src/code/providers.ts`), or accepted from model arguments.

| Vendor | Gate status today | Vault service(s) on gate | Used by Prime tool | Signup URL |
|---|---|---|---|---|
| Wolfram|Alpha | Present | `Wolfram_Alpha`, `wolfram::WOLFRAM_FULL_API_KEY` | `wolfram` (`echo.wolfram.llm`) | https://developer.wolframalpha.com/ |
| Tavily | Present | `tavily` | `web_search` (`echo.websearch.query`) | https://app.tavily.com/ |
| NewsAPI | Present | On gate | None yet | — |
| OpenWeather | Present | On gate | None yet | — |
| Brave Search | Absent (`brave`) | — | — | https://brave.com/search/api/ |
| Exa | Absent (`exa`) | — | — | https://exa.ai/ |
| Serper | Absent (`serper`) | — | — | https://serper.dev/ |
| Bing / Alpha Vantage / Google CSE | Absent (`bing`, `alphavantage`, `google_cse`) | — | — | — |

---

## 6. Limitations and follow-ups

- **Member family split not yet reachable**: `/api/chat` sits behind `workspace.requireOwner` in `src/prime/server.ts`, and `SharedChat.submit` (`src/prime/chat.ts`) requests `tools.forTurn({ audience: "owner" })`. `MEMBER_FAMILIES` is enforced in `ToolKit.forTurn`, but no member-facing Prime chat route reaches it yet.
- **FORGE-hosted `echo-core` coding path cannot call tools**: When `SharedChat` runs without a `ModelRouter`, it delegates to `runSharedTurn` (`src/code/shared.ts`), which strips `messages[0]` (the Prime `[system]` prompt), omits `tools`, and restricts `body.action` to `list`, `read`, `search`, `final`, and `propose`.
- **Model steps and tool calls are separate limits**: An ordinary parent chat has 10 generation steps; attaching owner bot tools permits 30. The original provider and any configured decline reroute share this one allowance, and a decline consumes its step. A final answer also needs a step. Sequential single-tool actions can therefore hit the model-step ceiling before exhausting the 12-call tool allowance, while a batch can spend several calls in one step. Provider discovery and classification remain separately bounded.
- **Workspace URL MCP plugins are not reachable server-side**: Per-account Streamable HTTP MCP servers configured in Plugins & memory (`/api/workspace/mcp`) expose only list/manage and `/api/mcp/tools/:id` schema routes over HTTP (`src/prime/workspace.ts`); their tool calls run only inside Workspace's own conversation engine, not Prime's `mcp_plugins`.
- **DNS rebinding and redirects**: Mitigated in `web_fetch` by resolving all records per hop, rejecting any non-global address, and pinning the validated IP via the socket `lookup` option while keeping TLS hostname verification.
- **No JavaScript execution**: `web_fetch` never executes scripts (`javascript_executed: false`); client-rendered pages that require browser JS yield only static HTML text.

---

## 7. Tests

`tests/prime-tools.test.ts` (stand-ins only: an injected `SdkInvoke`, injected `lookup`/`transport` for `web_fetch`, a `Runner` stub for the CLI model and a test-owned Ollama HTTP server on 127.0.0.1; `globalThis.fetch` is stubbed so any other socket fails the test) covers:

- `parseToolsConfig` defaults, budget range bounds, unknown-field rejection, absolute `skills.roots` validation, `<connection>:<tool>` `mcp.allow` parsing, refusal of non-read `esh:*` tools and copy semantics against `DEFAULT_TOOLS`.
- Utilities: `isGlobalIp` (IPv4, IPv6, mapped and NAT64 addresses), `argsKey` normalisation, `compact` with verbatim URLs, `refuseSecrets`, `validateArgs` (unknown keys, types, sizes, integer ranges, enums).
- `ToolCache` / `TurnTools`: TTL hits across turns with `cache_hit`, expiry on the injected clock, LRU eviction, within-turn dedupe at zero budget, call-count and wall-clock budget stops (one notice, then `stop`), the honest `summary()`, three parallel calls, the four-call batch cap with `omitted`, unknown-tool refusal, failed-tool continuation, correlated `tool_started`/`tool_result` pairs, deep redaction of an `sk-` token, and compaction of a 50 KB result.
- Audiences and toggles: owner vs member families, `setFamily`, `setEnabled`, and `report()` reasons when no gate is attached.
- All seven modules: `web_search` (Tavily shape, `max_results`, empty result), `web_fetch` (eight refusals before any lookup or transport, private DNS answer, three redirects with per-hop re-validation and pinned address, fourth redirect refused, redirect to loopback refused, script/style stripping with title and ISO `fetched_at`, truncation flag, PDF refusal, `pageText`), `wolfram` (configured, missing AppID, thrown AppID error, unavailable), `echo_knowledge` (search mapping, `doc_id` read, invalid id, missing arguments), `echo_memory` (recall mapping with `kind`, Crystal off by default, Crystal on request), `skills` (L1 list with directory-name fallback, L2 load with references and notice, L3 reference, traversal and unlisted names refused, unknown skill, 48 KB skip, unavailable without roots), `mcp_plugins` (allow-list filtering, schema, refused call never reaches the gateway, allowed call marked untrusted, unavailable with an empty allow-list).
- Model contract: `parseAction` for `tool` / `tools` (names, args, call counts) and `ACTION_FORMAT`.
- Loop: a Qwen stand-in and a CLI stand-in both receive the catalogue and the `UNTRUSTED TOOL RESULT (tool web_search)` message; a model that keeps calling tools ends `step_limit` with the application-generated budget summary.
- Bridge: `sdkToolInvoke` envelope and capability-id refusal; `connectionGateway` listing, unadvertised-tool refusal and unwrapped call.

`tests/prime-tools-ui.test.ts` runs the shipped `plugins.js` against a DOM stand-in: `toolRows` / `budgetText`, the owner card rendered from `GET /api/prime/tools`, the exact `{family, enabled}` POST on a toggle and the re-paint, the unconfigured reason without toggles, the member note without any owner-route read, and a failed status read reported once.

`tests/prime-long-workflow-acceptance.test.ts` starts the ordinary CLI with a reviewed local model endpoint, reads authenticated status, and submits through the shipped chat browser script (DOM stand-in), real HTTP, `SharedChat`, `ModelRouter`, and `LocalModel`. Three controlled model steps span 150 virtual seconds: the 120-second parent interrupts and the 300-second parent completes; each model request remains below its independent timeout. The suite also checks actual local transport closure after browser Stop/client disconnect and a single 10/30-step allowance across a late provider decline. Responses come from a test-owned loopback server, not production inference. Socket closure establishes cancellation of this fixture transport; it does not establish hard termination of remote work or completion of an admitted child.

`tests/prime-preparation-cancellation.test.ts` checks cancellation between routing, catalog, and continuity phases using the real public implementations and deferred test dependencies. Late probe, catalog, or preparation results cannot start the next provider, update the personality cache/selection, initialize role work, or initiate a second continuity write. The acceptance suite separately verifies host settlement when a model or personality phase ignores cancellation.
