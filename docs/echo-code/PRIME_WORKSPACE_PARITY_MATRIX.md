# Prime ↔ Workspace feature parity matrix

Status: living document. Created 2026-11-04 on `agent/prime-workspace-parity-20261104` (base 8672697, PR #6).
Reference Workspace source: `echo-omnipresence-runtime` @ `8de99d98521787c9580c84e1645dfb5b7aadfd88`, `SYSTEMS/echo_qwen_chat` (the running 8768 copy is identical except older `accounts.py`, `accounts_http.py`, `AUTH.md`).

Terms: **present** same label and behaviour · **hidden** exists but only shown once a Workspace backend is configured and the account is approved · **reduced** partly there · **missing** absent · **extra** Prime-only.
Refs: WS = `SYSTEMS/echo_qwen_chat` (`static/index.html` and `style.css` are minified, so refs are element ids). PR = this repo; `ui/` = `ui/echo-prime/`.

Gating: `workspace.js:434-435` enables Workspace features only when `/api/session` reports `workspaceConfigured:true` and the account is approved; owner-only items use `[data-owner-only]` (`workspace.js:47-52`). Without a backend Prime is the older ECHO Code / Creative Studio shell.

Update this file as each row lands. Visual comparison (screenshots) is tracked in `docs/echo-code/parity/` once captured.

## 1. Shell, header, node status

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Node bar QUENCH, FORGE, ANVIL, HAMMER, TEMPER, CRUCIBLE | `app.js:313-322`, polls `/api/fleet` every 15 s (`app.js:352`); `fleet.py` probes every 60 s | **present** (2026-11-04, synthetic-tested) | `fleet.js` (bar, 15 s poll, evidence dialog), `fleet.css`; the six hardcoded scene nodes and their connector SVG were removed from `index.html` | Live from `/api/fleet`, owner-only: a member, a signed-out visitor, an unconfigured backend or a failed request shows every node **unknown** with the reason in the evidence view, never green. A probe older than five minutes is shown unknown. Click opens an evidence dialog (connection, evidence, role, latency, host, addresses, probe output as inert text, raw record). Tests: `tests/prime-fleet-ui.test.ts`. Creative Studio stays reachable from the sidebar and mode tabs. |
| Node LED state | `style.css` `.fleet-node.connected/.disconnected/.unknown` | **present** | `fleet.css` `.fleet-node.*` | Green connected, red disconnected, grey unknown. Only the literal strings `connected` and `disconnected` are honoured. |
| Systems dialog (12 rows) | none | extra | `app.js:32-46`, `index.html:63` | Static "Awaiting connection"; only ESH row updates. |
| FORGE connection text | `app.js:350-351` "FORGE · Model loaded" / "FORGE · Connection needed", re-poll 60 s on `/api/health` `model.loaded` | **present** | `fleet.js` `#forge-connection` | Re-polled every 60 s for any approved account. Extra honest states: "FORGE · Not connected" (no backend or not signed in), "FORGE · Status unknown" (failed or malformed reply). |
| Page title/subtitle | `app.js:96` e.g. "Echo Prime · 256K context · Automatic memory" | reduced | `index.html:6`, `#conversation-title` | No per-view subtitle. |
| Brand | "ECHO / YOUR PRIVATE WORKSPACE" + badge | reduced | `index.html:27` | |
| Sidebar toggle, New chat | `#menu`, "＋ New chat" | present | `index.html:28,39`, `app.js:57,78` | Prime: "New conversation", Ctrl/Cmd+K. |

## 2. Navigation

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Chats | `data-view=chats` | **present** (label) | `plugins.js` `labels()` renames "Conversation" when a Workspace is configured | Offline Prime keeps its own label |
| Projects | `app.js:209-216` | hidden, reduced | `workspace.js:188-192` | dialog only; no per-project chat list / start chat |
| Library | `app.js:237-247` | hidden, reduced | nav label `index.html:31`; Save-to-library per message/code block `composer.js` `saveDialog` | no search box, no "Write a note" page; upload 500 KB vs 100 KB. Page not in this slice |
| Plugins & memory | `app.js:257-276` | **present** (hidden until Workspace) | `plugins.js` (unified view), nav `index.html:31` `#workspace-open-plugins` | MCP + private preferences for every approved account; owner cards in section 4. Replaces the separate Memory and MCP connections nav entries |
| SDK | `app.js:277-289` | hidden, owner, **nav entry first-class** | nav `index.html:31` (opens existing `operations` view `workspace.js:345-348`) | page still search + read schema only; no `/api/catalog`, no invoke (not this slice) |
| Vault | `app.js:290-303` | hidden, owner, **nav entry first-class** | nav `index.html:31` (opens existing `operations` view `workspace.js:349-350`) | put only; no locate/get/list (not this slice) |
| Code review | `app.js:304-312` | hidden, **nav entry first-class** | nav `index.html:31` (opens Library view, `workspace.js:200` per-file review) | no paste/project pick page (not this slice) |
| Logs & debugging | `app.js:324-330,344` | hidden, owner, **present** | `logs.js` (nav button "Logs & debugging" added to `#workspace-navigation`) | see section 3; `workspace.js` "Tools & diagnostics" raw-JSON buttons remain |
| Recent chats | `.side-label` + `#chat-list` (50) | hidden, **present** (heading) | `plugins.js` `labels()` renames "YOUR SPACE" when a Workspace is configured; list `#history` (500) | |
| Chat search | `#chat-search`, 250 ms debounce | hidden, present | `workspace.js:425-426` | same endpoint |
| Creative, Systems, Steward, ESH, Account, Appearance | none | extra | `index.html:29-37` | preserve |

## 3. Logs & debugging, Journal & ECF receipts

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Logs & debugging page (Refresh, "Mission & memory sync", "Recent operations") | `app.js:324-330` | **present**, owner-only (synthetic-tested) | `logs.js`, `fleet.css` `.logs-*` | Loads `/api/diagnostics` on open, Refresh re-reads. Mission and sync as labelled rows, operations as readable cards (newest first, status tone, UTC time, capability, HTTP, duration, error category). Empty, error (no auto retry) and late-response-after-account-change states covered by tests. |
| Sidebar "Journal & ECF receipts" | `#journal-status`, `app.js:36-43` | **present** | `logs.js` (button inserted above `.sidebar-bottom`) | Same three labels, refreshed by the 60 s `/api/health` poll; hidden when no approved account. |
| Sync dialog "Journal & ECF delivery" | `app.js:248-256` | **present** (synthetic-tested) | `logs.js` | Verified / awaiting counts, per-state breakdown, latest issue; owner gets "Retry pending records" (POST `/api/sync`, then `/api/health` readback; a failed retry is reported, never retried automatically). Members get the "Your private memories" text and no retry. |
| Journal link | `app.js:~111` | reduced | `workspace.js:187` | |
| Activity/tool cards, thinking panel | `app.js:145-208` | reduced | `workspace.js:111-115` | plain status lines |
| Streaming | NDJSON | present | `workspace-client.js:73-107` | Prime renders tokens progressively |

## 4. Plugins & memory

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| MCP list / add / enable / remove | `mcp.js` | hidden, **present** | `plugins.js` `mcpCards`, `toolSummary` | tool schemas shown as name — description; credential field cleared after every add |
| Check connections (Crystal, ECF, ESH cards) | `app.js:257-275` | hidden, owner, **present** | `plugins.js` `connectionCards` (`/api/plugins`) | cards show Readable / Unavailable / Not checked with the backend error text |
| Recall a memory | card | hidden, owner, **present** | `plugins.js` `ownerCards` (`memory_search`, ecf/crystal) | |
| Store a memory to Crystal (`crystal_save`) | card | hidden, owner, **present** | `plugins.js` `ownerCards` | empty input refused client-side; receipt shown with a "confirm readback" notice, never "saved" on its own. Prime `memory_save` stays in Private preferences |
| Automatic journal hooks, delivery status | card | hidden, owner, **present** (status) | `plugins.js` `syncSummary` | reads saved sync counts; the "Retry pending records" button belongs to the journal slice |
| Personality Forge assets (`personality_assets`) | card, if `voice.configured` | hidden, owner, **present** | `plugins.js` `ownerCards` | card text uses the backend voice label, not a hardcoded name |
| BloodlinePrime directive | card | hidden, owner, **present** | `plugins.js` `ownerCards` "Directive profile" | |
| ESH action card | `app.js` | hidden, owner, present | `workspace.js:156-185,348`; `plugins.js` button opens the dock | Prime requires review-then-run (preserve) |
| Non-owner view | `app.js:259` | **present** | `plugins.js` `render` (MCP + private preferences only; owner actions revalidate admission at click time) | |

## 5. Composer and chat controls

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Message box | `app.js:121`, 100,000 chars | reduced | `index.html:57`, 12,000 chars | |
| Attach | `app.js:140-144` chips | **present** | `composer.js` `attachDialog`, `renderChips` | shares `state.attachments` with the Library view |
| Mic / "◉ Voice" | `voice.js:10-14`, `app.js:124-127` | reduced, **◉ Voice present** | `composer.js` Voice toggle → `speech.js` continuous conversation mode when loaded (AnalyserNode VAD, auto-send on end of speech, barge-in aware, no turn cap), else `bridge.startConversation` (ten-turn cap removed 2026-11-04); the mic button is push-to-talk `bridge.dictate` through `speech.js` (opens the Voice panel only without it) | hidden unless `voice.configured`; hands-free re-listen now also runs while the voice bar is visible (`workspace.js` `scheduleListening`) |
| "◈ Memory · automatic" chip | `app.js:~133` | **present** | `composer.js` `build` | |
| Send, hint "Enter to send · Shift+Enter for a new line" | `app.js:~136` | **present** (Workspace mode) | `composer.js` sets `.keyboard-hint` | |
| Context meter `7,657 / 262,144 · 2.9% · estimate` + progress bar | `app.js:81-94`, `model_usage` events | **present** | `composer.js` `contextMeter`, `composer.css` | measured from the last saved `model_usage` event after the final checkpoint (same arithmetic as WS), otherwise an estimate labelled as such. Reads the saved chat readback; live-stream `model_usage` events are still dropped by `workspace-client.js` |
| Toolbar: Project, Personality, Rename, Compact, Continue, Journal | `app.js:98-110` | hidden, **present** | `index.html:72` controls + Personality select `composer.js` `syncPersonality` (`personality_select`) | |
| Checkpoint banner | `app.js:~112` | **present** | `composer.js` `syncCheckpoint` | |
| Message actions Copy / Save to library / ▶ Listen; code blocks "Save file" | `app.js:57-73` | **present** | `composer.js` `decorate`, `messageActions`, `splitBlocks` | applied to saved messages after each readback; streaming text is decorated once saved. Listen only when `voice.configured` |
| Empty state / starters | `app.js:113-118` | reduced | `index.html:53` | |
| Mode tabs (Image, Video, Music, SFX, Voice) | none | extra | `index.html:56` | preserve |

## 6. Voice bar

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Persistent bar under composer (only when `voice.configured`) | `voice.js:156-168` | **present** | `voicebar.js` | shown only when the backend reports `configured === true` |
| Interrupt & speak | `voice.js:163` | **present** | `voicebar.js`, `workspace.js` `bridge.interrupt` | |
| Stop voice | `voice.js:163` | **present** | `voicebar.js`, `workspace.js` `bridge.stopVoice` | also ends a hands-free conversation and cancels the provider session |
| Spoken replies | `voice.js:164`, persisted `echo-spoken-replies` | **present** | `voicebar.js` toggle; default and persisted mute in `speech.js` | **Commander directive 2026-11-04 ("ECHO SHOULD TALK REPLIES, USE ALL SPEAKING LOGIC THAT'S KNOWN, CONVO AI STYLE"):** ON by default for signed-in approved accounts, OFF for anonymous visitors; Mute/Unmute persisted in `localStorage` (`echo-prime-speech-v1`, try/catch) from the composer dock and the voice bar. Supersedes the earlier "off every session" preserve note; `voicebar.js` itself still stores nothing |
| Brief speech | `voice.js:165` | **present** | `voicebar.js` | off each session |
| Send speech automatically | `voice.js:166` | **present** | `voicebar.js` | off each session |
| Status line "M Freeman · ElevenLabs · Microphone off" | `voice.js:167-168` | **present** | `voicebar.js` `model` | built from the backend `voice.label` and `voice.provider`, plus Listening / Transcribing / Speaking; never hardcoded |
| Footer "Personality Forge · …ElevenLabs." | `voice.js:168` | **present** | `voicebar.js` | uses backend `provider_usage` text |
| Capture limit | 120 s chunked | reduced | 8 s cap (`workspace.js:271,328`) | |
| Endpoints | `/api/voice/*` | present | `workspace.ts:61,66` | |

### 6a. Spoken replies — ConvAI pipeline (`speech.js`, Commander directive 2026-11-04)

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Echo's voice speaks each saved reply | `voice.js` `afterReply` → `/api/voice/start`, one section prepared ahead | **present** | `speech.js` `speakMessage`; `workspace.js` announces `echo-reply-saved` on the stream's `done` event (Echo starts two round trips before the readback finishes) and `echo-voice-stop` from `stopAudio` | ordered playback queue with the next chunk (`/api/voice/next` + governed WAV via `bridge.audio`) prefetched while the current one plays; `request_id` reused on replay so the backend's idempotent start is honoured; duplicate suppression per saved message id; `state.speech` set so the voice bar shows Speaking and Stop voice cancels the same session |
| Barge-in | `stopSpeech` on dictate | **present** | `speech.js` `stop`: typing in the composer, Send, Stop, the mic button, `echo-voice-stop` | pauses playback, drops the prefetch and cancels the provider session (`/api/voice/cancel {chat_id, session_id}`) |
| Hidden tab | `visibilitychange` stops | **present** | `speech.js` | stops speaking when the tab is hidden and offers "Resume Echo"; never resumes by itself |
| Autoplay policy | visible audio element | **present** | `speech.js` `unlock`, "Tap to hear Echo" chip | first gesture resumes the AudioContext and primes a silent blob WAV (CSP `media-src blob:`); a `NotAllowedError` never throws |
| Voice name chip, Stop, spoken-turn counter | none | extra | `speech.js` dock under the composer | chip reads `voice.label` / `voice.provider` from the backend (no hardcoded name); when `configured !== true` it states the reason and nothing else speaks (no silent fallback) |
| Device voice | none | extra, explicit | `speech.js` checkbox "Device voice (not Echo's)", persisted | the only path that can speak ECHO Code replies, Swarm results and Steward advice, because the backend synthesises saved Workspace replies only; labelled, never substituted silently |
| Text normalisation + sentence chunking | `prepareSpeech` server side (420 chars) | **present** (client) | `speech.js` `normalizeForSpeech`, `createChunker`, `detectLanguage` | markdown stripped, URLs read as "link", code blocks as "code block omitted", tables summarised, numbers / dates / times / currency / ordinals expanded, identifiers and paths hidden, language detected for passthrough; speaking sentence 1 while the rest streams applies to the device voice (Echo's own voice starts at `done` until the backend grows a free-text route) |
| Conversation mode | `toggleConversation` (ScriptProcessor RMS, 120 s) | **present** | `speech.js` `conversation`: AnalyserNode VAD with adaptive noise floor, end of turn after 1.5 s of silence (or the backend's `end_of_turn_ms`), ≤ 7.5 s parts to `/api/voice/transcribe`, auto-send, interrupt Echo by speaking over it | off by default, visible toggle (also the composer's ◉ Voice); needs `voice.configured` for transcription |
| Speak result / Speak advice | none | extra | `swarm.js` and `steward.js` announce `echo-result-rendered`; `speech.js` adds the speak/stop button | device voice or a plain reason |
| Orb sync | none | extra | `speech.js` dispatches `echo-orb-state` on `document` ({mode:'speaking', amplitude 0–1, source:'speech'} at ~20 Hz, {mode:'listening'}, {mode:'idle'}) | the `orb.js` listener belongs to the orb slice |
| Latency instrumentation | none | extra | `console.debug('[echo.speech]', …)` | `first_audio` with `ttfa_ms` and `lang`, queue and chunk counts, duplicate / cancel / failure outcomes; never message text or transcripts |

## 7. Models, themes, layout, other

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Model picker | none (fixed `config['model']`, `app.py:82`) | **present** (Job 3) | `ui/echo-prime/models.js`; `GET /api/prime/models` (`server.ts`, `hub.ts`); `src/code/model-factory.ts`; `chat.ts` | Default Qwen 3.8 256K (`c3po-code:echo-qwen38-abliterated-256k`) via the loopback tunnel `http://127.0.0.1:11450`, set in a reviewed `models` section of the Prime config (opt-in: no `models` section means no router, no probes, no code agent) (`default`, `endpoint`, `model`, `contextTokens` 262144, optional `cli.<claude\|gpt\|grok>.model`; no secrets, unknown keys refused). Claude, GPT and Grok run through their own CLIs (`CliModel`); one factory builds the Model from a provider id for `code run`/`chat --provider` and the Prime chat. Picker persists the id in `localStorage` (try/catch), shows per-reply `answered by <model>` or `model not reported by <CLI> (requested: X)`, and an explicit unavailable message; availability is a `--version` / `codex login status` probe through the minimal-env Runner, cached 60 s. No fallback anywhere: a failed provider fails the turn. A conversation is pinned to the model that started it. The code agent is attached by `prime` only when the config has a `models` section (`--code-workspace`, `--code-state-dir`). **Gemini (Argon via `agy`)**: the router's 60 s Argon probe also runs `agy models` through the same minimal-env Runner (8 s timeout, 64 KB cap) and reports `variants: [{id,label}]` (only ids matching `^gemini-[a-z0-9.-]+$`, max 32; `claude-*`/`gpt-oss` ids agy also lists are dropped; raw output never returned) or `variants: []` plus `variantsReason` when listing fails (nothing invented). A chat turn / `code run --provider argon --model <id>` may name one of those ids (`ModelRouter.variant`, `SharedChat` `model` field, Argon only; unknown or unverifiable ids are refused with a clear error, never defaulted); the conversation is pinned to `argon:<id>`. The picker shows a second select with agy's labels while Argon is selected, persists it in `localStorage` (`echo-prime-argon-model-v1`, try/catch), and prints `model not reported by agy (requested: <id>)` because agy does not say which model answered. Structured debug events: `prime_argon_variants`, `prime_argon_variant_rejected` (`NODE_DEBUG=echo-prime`). Verified by stand-in `agy` runners only (tests `argon-variants`, `prime-models`); real `agy models` was run once to confirm the line format. Not covered: the Workspace-backed chat (`/api/workspace/...`) still uses the Workspace backend's own model |
| Swarm (40-seat brain) | none | **extra** (2026-11-04, stand-in tested) | `src/prime/swarm.ts`; `hub.ts` `swarmHealth/swarmRun/swarmStatus`; `server.ts` routes `GET /api/prime/swarm/health`, `POST /api/prime/swarm/run`, `GET /api/prime/swarm/runs/:id` and assets `swarm.js`/`swarm.css`; `commands.ts` `swarm` config; `ui/echo-prime/swarm.js`, `swarm.css`, `models.js` (`setSwarm`, `swarm()`), `index.html` | Selectable entry in the model picker that runs the next message through the Maximalist Swarm Fusion Brain (`echoomegaprime/maximalist-reconstructed`, FORGE systemd `echo-fusion-worker-v05`, loopback `127.0.0.1:8358`): independent first pass by 40 seats, finding bus, preserved dissent, evidence-weighted arbitration, separate 3-seat Trinity fusion, verification. Opt-in like `models`: a reviewed `swarm` config section (`baseUrl` loopback origin, default `http://127.0.0.1:8358`; `defaultBudget`; unknown keys and non-loopback origins refused); without it the picker shows the entry as unavailable and says the feature is off. Server side is subprocess-free: plain `fetch` (`redirect:'error'`, 5/15/10 s timeouts, 1 MiB cap) to exactly three worker routes, run ids must be 32 hex characters, objective <= 12000 chars, budget clamped to the worker maxima (`max_calls` 120, `max_cost_usd` 5, `max_wall_s` 4800; default cost 1 USD), idempotency key made on the server, every string redacted. The worker must report profile `MAXIMALIST_RECONSTRUCTED` or it is refused. UI: submit, poll every 3 s (paused while the tab is hidden), elapsed time and budget, then fused answer, confidence, major findings, preserved dissent, unresolved uncertainty, provenance and the badge `MAXIMALIST_RECONSTRUCTED · historical_parity: false` (a reconstruction, not the historical original; read from the result, flagged if it differs). Stop only stops waiting (the worker has no cancel; the card says so). Worker down, budget stop, timeout (wall budget + 120 s) or lost contact are explicit; there is never a fallback to another model. Scope: picker entry needs the `models` section too; the Workspace conversation path (`EchoPrimeWorkspace.send` in `app.js`) still answers first, so swarm applies to the Prime/ECHO Code chat path. Verified only against a stand-in HTTP worker and a fake DOM (tests `prime-swarm`, `prime-swarm-ui`); the real worker was not called. |
| Themes | none | extra | `index.html:62`, `app.js:4-20` | preserve |
| Layout (nav side, resize, dock, 8-edge resizers, Reset, persist) | `layout.js:1-142` | reduced | `workspace.js:150-185` | |
| ESH dock (status badge, `PS >` prompt, Ctrl+Enter, receipts) | `esh-panel.js:1-122` | hidden, reduced | `workspace.js:133-185` | |
| Import chat (source select, file picker 1.9 MB) | `app.js:217-236` | hidden, reduced | `workspace.js:203-217` | |
| Accounts / approvals | `login.html`, `auth.js`, `/api/auth/*` | hidden, reduced | `workspace.js:352-403` | no password-reset button (`reset` wired, `workspace-client.js:65`) |
| Fork, compact | `app.js:~108` | hidden, present | `workspace.js:422` | |
| `ui_action` navigation after reply | `app.js:182-185` | **missing** | none | |

## 8. Route coverage

All Workspace `/api/*` routes are on Prime's allowlist (`workspace.ts:60-63`). Not proxied: static pages and `/login`. Prime allowlists `/api/auth/refresh` and `/api/auth/verify`, which the Workspace does not implement (would 404).

Actions: Prime UI calls `personality_select`, `memory_save`, `memory_forget`, `memory_search`, `esh`, `sdk`, `sdk_detail`, `vault` (put), plus (composer slice) `personality_assets` and `crystal_save` from `plugins.js`. Never called: `vault` get/locate/list, SDK invoke. `/api/catalog` unused; `/api/health` and `/api/fleet` are now polled by `fleet.js`; `/api/diagnostics` and `/api/sync` are used by `logs.js`.

## Gaps by size

1. ~~Live node bar and FORGE connection state (owner-only fleet).~~ Done 2026-11-04 (`fleet.js`); not yet exercised against a live backend.
2. First-class views: Projects (per-project chats), Library (search, note, Save file), Plugins & memory, SDK (+invoke), Vault (locate/get/list/put), Code review page.
3. Chat surface: message actions, code-block Save file, checkpoint banner, Personality select, activity cards, Memory chip, composer Attach chips, context meter with %/bar/measured.
4. ~~Voice bar with persisted toggles and status line; longer capture.~~ Spoken replies on by default, persisted mute, ConvAI queue/prefetch, barge-in and conversation mode done 2026-11-04 (`speech.js`); capture is still bounded by the backend's 8 s clip (long utterances are chunked by `speech.js`).
5. ~~Logs & debugging cards; Journal & ECF receipts button and sync dialog.~~ Done 2026-11-04 (`logs.js`); not yet exercised against a live backend.
6. Layout system and ESH dock status.
7. Import source/file, password reset UI, branding strings, allowlist cleanup.

## Preserve (Prime-intentional)

ESH review-then-run, ~~voice off by default each session, 10-turn voice cap~~ (superseded 2026-11-04 by the Commander directive "ECHO SHOULD TALK REPLIES, USE ALL SPEAKING LOGIC THAT'S KNOWN, CONVO AI STYLE": spoken replies ON for signed-in approved accounts, OFF for anonymous visitors, persistent mute, no turn cap — `speech.js`), owner-only gating of fleet/diagnostics/SDK/Vault/ESH, orb, palettes, Steward, Creative Studio.
