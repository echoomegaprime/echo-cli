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
| Chats | `data-view=chats` | reduced | `index.html:29` "Conversation" | label differs |
| Projects | `app.js:209-216` | hidden, reduced | `workspace.js:188-192` | dialog only; no per-project chat list / start chat |
| Library | `app.js:237-247` | hidden, reduced | `workspace.js:193-205` | no search box, no "Write a note", no Save-to-library per code block; upload 500 KB vs 100 KB |
| Plugins & memory | `app.js:257-276` | hidden, split | `index.html:31` Memory + MCP | label does not exist |
| SDK | `app.js:277-289` | hidden, owner, reduced | `workspace.js:345-348` | search + read schema only; no `/api/catalog`, no invoke |
| Vault | `app.js:290-303` | hidden, owner, reduced | `workspace.js:349-350` | put only; no locate/get/list |
| Code review | `app.js:304-312` | hidden, reduced | `workspace.js:200` | per-file only; no paste/project pick |
| Logs & debugging | `app.js:324-330,344` | hidden, owner, **present** | `logs.js` (nav button "Logs & debugging" added to `#workspace-navigation`) | see section 3; `workspace.js` "Tools & diagnostics" raw-JSON buttons remain |
| Recent chats | `.side-label` + `#chat-list` (50) | hidden | `index.html:34-35` "YOUR SPACE" + `#history` (500) | heading differs |
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
| MCP list / add / enable / remove | `mcp.js` | hidden, present | `workspace.js:228-233` | raw schema JSON |
| Check connections (Crystal, ECF, ESH cards) | `app.js:257-275` | reduced | `workspace.js:345` | raw JSON |
| Recall a memory | card | hidden, present, owner | `workspace.js:223-225` | |
| Store a memory to Crystal (`crystal_save`) | card | **missing** | none | Prime `memory_save` is the preference store |
| Automatic journal hooks, delivery status | card | **missing** | none | |
| Personality Forge assets (`personality_assets`) | card, if `voice.configured` | **missing** | `workspace.js:335` | |
| BloodlinePrime directive | card | **missing** | none | |
| ESH action card | `app.js` | hidden, owner, present | `workspace.js:156-185,348` | Prime requires review-then-run (preserve) |
| Non-owner view | `app.js:259` | present | `workspace.js:47` | |

## 5. Composer and chat controls

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Message box | `app.js:121`, 100,000 chars | reduced | `index.html:57`, 12,000 chars | |
| Attach | `app.js:140-144` chips | reduced | `workspace.js:199` | no composer button/chips |
| Mic / "◉ Voice" | `voice.js:10-14`, `app.js:124-127` | reduced | `workspace.js:341,428` | dialog-driven, 10-turn cap (preserve) |
| "◈ Memory · automatic" chip | `app.js:~133` | **missing** | none | |
| Send, hint "Enter to send · Shift+Enter for a new line" | `app.js:~136` | reduced/present | `index.html:57-58` | |
| Context meter `7,657 / 262,144 · 2.9% · estimate` + progress bar | `app.js:81-94`, `model_usage` events | reduced | `workspace.js:60-65` | text only, no % / bar / measured path |
| Toolbar: Project, Personality, Rename, Compact, Continue, Journal | `app.js:98-110` | hidden, reduced | `index.html:72`, `workspace.js:419-423` | Personality select missing |
| Checkpoint banner | `app.js:~112` | **missing** | none | |
| Message actions Copy / Save to library / ▶ Listen; code blocks "Save file" | `app.js:57-73` | **missing** | none | |
| Empty state / starters | `app.js:113-118` | reduced | `index.html:53` | |
| Mode tabs (Image, Video, Music, SFX, Voice) | none | extra | `index.html:56` | preserve |

## 6. Voice bar

| Feature | WS ref | Prime | PR ref | Notes |
|---|---|---|---|---|
| Persistent bar under composer (only when `voice.configured`) | `voice.js:156-168` | **missing** as bar | dialog `workspace.js:333-342` | |
| Interrupt & speak | `voice.js:163` | **missing** | none | |
| Stop voice | `voice.js:163` | reduced | `workspace.js:339`, `#stop-chat` | |
| Spoken replies | `voice.js:164`, persisted `echo-spoken-replies` | reduced | `workspace.js:338` | Prime: off each session (preserve default) |
| Brief speech | `voice.js:165` | reduced | `workspace.js:338` | |
| Send speech automatically | `voice.js:166` | reduced | `workspace.js:338` | |
| Status line "M Freeman · ElevenLabs · Microphone off" | `voice.js:167-168` | reduced | `workspace.js:260,265,330,312` | Prime reports backend voice/provider, not hardcoded |
| Footer "Personality Forge · …ElevenLabs." | `voice.js:168` | **missing** | none | |
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

Actions: Prime UI calls `personality_select`, `memory_save`, `memory_forget`, `memory_search`, `esh`, `sdk`, `sdk_detail`, `vault` (put). Never called: `personality_assets`, `crystal_save`, `vault` get/locate/list, SDK invoke. `/api/catalog` unused. `/api/health` and `/api/fleet` are now polled by `fleet.js`; `/api/diagnostics` and `/api/sync` are used by `logs.js`.

## Gaps by size

1. ~~Live node bar and FORGE connection state (owner-only fleet).~~ Done 2026-11-04 (`fleet.js`); not yet exercised against a live backend.
2. First-class views: Projects (per-project chats), Library (search, note, Save file), Plugins & memory, SDK (+invoke), Vault (locate/get/list/put), Code review page.
3. Chat surface: message actions, code-block Save file, checkpoint banner, Personality select, activity cards, Memory chip, composer Attach chips, context meter with %/bar/measured.
4. Voice bar with persisted toggles and status line; longer capture.
5. ~~Logs & debugging cards; Journal & ECF receipts button and sync dialog.~~ Done 2026-11-04 (`logs.js`); not yet exercised against a live backend.
6. Layout system and ESH dock status.
7. Import source/file, password reset UI, branding strings, allowlist cleanup.

## Preserve (Prime-intentional)

ESH review-then-run, voice off by default each session, 10-turn voice cap, owner-only gating of fleet/diagnostics/SDK/Vault/ESH, orb, palettes, Steward, Creative Studio.
