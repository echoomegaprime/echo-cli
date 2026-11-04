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
| Node bar QUENCH, FORGE, ANVIL, HAMMER, TEMPER, CRUCIBLE | `app.js:313-322`, polls `/api/fleet` every 15 s (`app.js:352`); `fleet.py` probes every 60 s | **missing** | `index.html:39-46` shows FORGE, SWARM, MEMORY, CREATIVE, CERTFORGE, AGENTS | WS state is live (QUENCH via `platform.node()`, others via SDK `echo.monitor.health.node`). Click opens an evidence modal. `/api/fleet` is owner-only upstream. |
| Node LED state | `style.css` `.fleet-node.connected/.disconnected/.unknown` | **missing** (hardcoded) | `styles.css:1` `.node-led` colours | Prime LEDs are decoration. |
| Systems dialog (12 rows) | none | extra | `app.js:32-46`, `index.html:63` | Static "Awaiting connection"; only ESH row updates. |
| FORGE connection text | `app.js:350-351` "FORGE · Model loaded" / "FORGE · Connection needed", re-poll 60 s on `/api/health` `model.loaded` | **missing** | `index.html:40-41` static labels | `/api/health` is allowlisted (`workspace.ts:60`) but never called. |
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
| Logs & debugging | `app.js:324-330,344` | hidden, owner, **nav target added** | `index.html:31` `data-view="logs"` `data-owner-only` | page itself is built in `logs.js` by another slice; the target has no handler until it lands |
| Recent chats | `.side-label` + `#chat-list` (50) | hidden, **present** (heading) | `plugins.js` `labels()` renames "YOUR SPACE" when a Workspace is configured; list `#history` (500) | |
| Chat search | `#chat-search`, 250 ms debounce | hidden, present | `workspace.js:425-426` | same endpoint |
| Creative, Systems, Steward, ESH, Account, Appearance | none | extra | `index.html:29-37` | preserve |

## 3. Logs & debugging, Journal & ECF receipts

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Logs & debugging page (Refresh, "Mission & memory sync", "Recent operations") | `app.js:324-330` | reduced | `workspace.js:343-347` | raw JSON via buttons, no cards/auto-load |
| Sidebar "Journal & ECF receipts" | `#journal-status`, `app.js:36-43` | **missing** | none | label varies: "Private journal & memories" / "Journal saved · N awaiting ECF" |
| Sync dialog "Journal & ECF delivery" | `app.js:248-256` | reduced, owner | `workspace.js:222,225` | raw JSON; no counts or "Retry pending records" |
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
| Mic / "◉ Voice" | `voice.js:10-14`, `app.js:124-127` | reduced, **◉ Voice present** | `composer.js` Voice toggle (`bridge.startConversation`, 10-turn cap kept in `workspace.js`); mic button still opens the Voice panel | hidden unless `voice.configured`; hands-free re-listen now also runs while the voice bar is visible (`workspace.js` `scheduleListening`) |
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
| Spoken replies | `voice.js:164`, persisted `echo-spoken-replies` | **present** | `voicebar.js` | WS defaults ON and persists; Prime is OFF every session and never touches browser storage (preserve) |
| Brief speech | `voice.js:165` | **present** | `voicebar.js` | off each session |
| Send speech automatically | `voice.js:166` | **present** | `voicebar.js` | off each session |
| Status line "M Freeman · ElevenLabs · Microphone off" | `voice.js:167-168` | **present** | `voicebar.js` `model` | built from the backend `voice.label` and `voice.provider`, plus Listening / Transcribing / Speaking; never hardcoded |
| Footer "Personality Forge · …ElevenLabs." | `voice.js:168` | **present** | `voicebar.js` | uses backend `provider_usage` text |
| Capture limit | 120 s chunked | reduced | 8 s cap (`workspace.js:271,328`) | |
| Endpoints | `/api/voice/*` | present | `workspace.ts:61,66` | |

## 7. Models, themes, layout, other

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Model picker | none (fixed `config['model']`, `app.py:82`) | n/a | `index.html:72` conversation select | Job 3 adds a picker in Prime; nothing to port |
| Themes | none | extra | `index.html:62`, `app.js:4-20` | preserve |
| Layout (nav side, resize, dock, 8-edge resizers, Reset, persist) | `layout.js:1-142` | reduced | `workspace.js:150-185` | |
| ESH dock (status badge, `PS >` prompt, Ctrl+Enter, receipts) | `esh-panel.js:1-122` | hidden, reduced | `workspace.js:133-185` | |
| Import chat (source select, file picker 1.9 MB) | `app.js:217-236` | hidden, reduced | `workspace.js:203-217` | |
| Accounts / approvals | `login.html`, `auth.js`, `/api/auth/*` | hidden, reduced | `workspace.js:352-403` | no password-reset button (`reset` wired, `workspace-client.js:65`) |
| Fork, compact | `app.js:~108` | hidden, present | `workspace.js:422` | |
| `ui_action` navigation after reply | `app.js:182-185` | **missing** | none | |

## 8. Route coverage

All Workspace `/api/*` routes are on Prime's allowlist (`workspace.ts:60-63`). Not proxied: static pages and `/login`. Prime allowlists `/api/auth/refresh` and `/api/auth/verify`, which the Workspace does not implement (would 404).

Actions: Prime UI calls `personality_select`, `memory_save`, `memory_forget`, `memory_search`, `esh`, `sdk`, `sdk_detail`, `vault` (put), plus (composer slice) `personality_assets` and `crystal_save` from `plugins.js`. Never called: `vault` get/locate/list, SDK invoke. `/api/catalog` unused; `/api/health` unused; `/api/fleet` only as raw JSON.

## Gaps by size

1. Live node bar and FORGE connection state (owner-only fleet).
2. First-class views: Projects (per-project chats), Library (search, note, Save file), Plugins & memory, SDK (+invoke), Vault (locate/get/list/put), Code review page.
3. Chat surface: message actions, code-block Save file, checkpoint banner, Personality select, activity cards, Memory chip, composer Attach chips, context meter with %/bar/measured.
4. Voice bar with persisted toggles and status line; longer capture.
5. Logs & debugging cards; Journal & ECF receipts button and sync dialog.
6. Layout system and ESH dock status.
7. Import source/file, password reset UI, branding strings, allowlist cleanup.

## Preserve (Prime-intentional)

ESH review-then-run, voice off by default each session, 10-turn voice cap, owner-only gating of fleet/diagnostics/SDK/Vault/ESH, orb, palettes, Steward, Creative Studio.
