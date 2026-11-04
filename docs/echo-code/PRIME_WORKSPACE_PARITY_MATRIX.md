# Prime ↔ Workspace feature parity matrix

Status: integrated source candidate, updated 2026-11-04 in `QUENCH-prime-live-20261104` on `agent/prime-parity-live-20261104`. This replaces the initial inventory from the parity branch; it does not assert a deployed release or complete visual parity.

Reference: canonical `echoomegaprime/echo-omnipresence-runtime` source `8de99d98521787c9580c84e1645dfb5b7aadfd88`, `SYSTEMS/echo_qwen_chat`, is imported under `backend/workspace/`. `backend/workspace/SOURCE_PROVENANCE.json` records its original file hashes. Provider routing and reviewed integration changes extend that imported baseline. The older running Workspace installation is not the provenance authority for this candidate.

Terms: **implemented** means present in this source; **gated** requires the configured canonical authenticated Workspace and approved account, with primary-owner checks where specified; **different** records an intentional or remaining UX difference; **extra** is Prime-only. None of these labels proves a live provider, production deployment, screenshot comparison, or certification. Paths below are source anchors rather than unstable line numbers. WS means the imported canonical `backend/workspace/static/` interface; UI means `ui/echo-prime/`.

Admission remains canonical: `/api/session`, current account status, CSRF, primary-owner pin and tenant-isolation checks control access. The shared browser transport revalidates private requests and clears private UI on identity loss. Fleet, diagnostics, SDK, Vault and ESH remain primary-owner surfaces. Without an admitted Workspace backend, Prime retains its separate local shell, coding and creative surfaces.

## 1. Shell, header and node status

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| Six-node bar: QUENCH, FORGE, ANVIL, HAMMER, TEMPER, CRUCIBLE | Implemented, owner gated | UI `fleet.js`, `fleet.css` | `/api/workspace/fleet` observations refresh every 15 seconds while visible. Connected requires explicit fresh probe evidence; missing, stale, malformed or unavailable evidence is unknown. Inventory enrollment does not imply connectivity. |
| Node LEDs and evidence | Implemented, owner gated | `normalizeFleet`, node evidence dialog | Connected/disconnected/unknown states and probe timestamp/source/latency/identity metadata; observations older than 120 seconds become unknown. Raw probe stdout and errors are not displayed. The orb's decorative system nodes remain a separate surface. |
| FORGE model status | Implemented, owner gated | `modelState`, `/api/workspace/health` | Health refreshes at 60-second intervals and on explicit inspection. Ready requires loaded, `ok`, exclusive model and matching actual/configured context; loaded with configuration issues, connection needed and unknown remain distinct. No inference prompt is sent by this status check. |
| Systems dialog | Extra, partly static | UI `app.js`, `#systems-dialog` | Preserved systems inventory and connection controls; static labels are not fleet-health proof. |
| Page title, subtitle and branding | Different | UI `index.html`, `#conversation-title` | Prime branding and orb remain; main pages have titles/subtitles while preserving the existing conversation DOM. Exact typography and screenshot parity remain unverified. |
| Sidebar and new chat | Implemented | UI `app.js`, `workspace.js` | Existing navigation toggle, New conversation and keyboard shortcut remain. |

## 2. Navigation and content panels

Projects, Library, Plugins & memory, Memory, SDK, Vault, Code review, Logs and Journal use the main content area with titles, subtitles, active navigation and Back/Escape/Alt+Left. The existing conversation and draft are retained while a page is open; account changes invalidate pending navigation and receipt handles. Account, appearance, voice settings and small fleet details retain dialogs.

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| Chats, recent history and search | Implemented, gated | `renderHistory`, `openChat`, `newChat` | Canonical saved conversations, search, project association and history; Prime retains Conversation and YOUR SPACE labels and a bounded 500-row history view. |
| Projects | Implemented, gated, main page | `projects` | Create/update project instructions, list its saved chats and start a project conversation. Project conversations open in the existing chat surface. |
| Library | Implemented, gated, main page | `library`, `saveMessage`, `renderMessageBody` | Name/path search, write note/save file, upload text up to 100,000 bytes, attachment selection, read/download, linked chat and code review. Message save verifies exact readback. Code-block Save file is a local download; it is distinct from saving a whole message to the canonical library. |
| Plugins & memory | Implemented, gated, main page | `plugins`, `memory` | Combined main page includes private preferences, admitted memory connections, journal status and per-account MCP controls. Shared ECF/Crystal actions remain owner-only. |
| SDK | Implemented, owner gated, main page | `sdk` | Search registry, read catalog/schema, select a capability, review exact command/options and run that reviewed request once. A changed request requires review again. No postcondition is inferred from a receipt. |
| Vault | Implemented, owner gated, main page | `vault` | List, locate, read reference metadata and isolated put. Credential values are not returned to the UI or inserted into chats. |
| Code review | Implemented, gated, main page | `review`, library Review code | Paste up to 40,000 characters, choose project context, or review a library file; canonical result opens as a saved chat. Results become canonical saved conversations. |
| Logs & debugging | Implemented, owner gated, main page | UI `fleet.js` | Auto-load and Refresh, Mission & memory sync, bounded Recent operations metadata cards. |
| Creative, Systems, Steward, ESH, Account, Appearance | Extra/preserved | UI `index.html` and corresponding controllers | Their own connection, policy and model-admission requirements remain. Visible navigation does not prove the service is admitted. |

## 3. Logs, journal and receipts

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| Journal & ECF receipts sidebar control | Implemented, owner gated | UI `fleet.js` | Shows verified readback/pending counts from health; unavailable counters remain unavailable rather than zero. |
| Journal & ECF delivery | Implemented, owner gated, main page | `syncSummary`, `retrySync` | Exact ECF readback and remaining delivery are separate. Explicit Retry pending records runs one pass followed by an independent health read; ambiguous writes are not automatically retried. |
| Per-conversation journal | Implemented, gated | `journal`, `#workspace-journal` | Canonical journal read and download remain separate from verified remote ingestion. |
| Activity/tool receipts | Implemented, different presentation | `activityCard`, `receiptCard` | Started/returned/gated/unconfirmed cards with safe receipt details; not a claim of identical canonical thinking-panel visuals or successful external side effects. |
| NDJSON streaming | Implemented, gated | `workspace-client.js`, `workspace.ts` | Progressive tokens and bounded canonical saved-chat completion; identity changes and contradictory/truncated streams fail closed. |

## 4. Plugins, memory and personalities

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| MCP list/add/enable/remove and schema inspection | Implemented, per-account gated | `plugins`, backend `remote_mcp.py` | Streamable HTTP connections and encrypted credential entry. OAuth onboarding and legacy SSE remain unsupported by this form. |
| Connection checks | Implemented, owner gated | Plugins & memory Check connections | Crystal, ECF and ESH receipts use cards/details. Configuration and successful actions remain distinct. |
| Recall memory | Implemented, owner gated | `memory_search` action | ECF/Crystal results retain their returned provenance. |
| Store Crystal memory | Implemented, owner gated | `crystal_save` action | UI requires `readback_verified` before reporting an exact saved/readback result. This is separate from local preference storage. |
| Automatic journal hooks and delivery status | Implemented in canonical backend, surfaced in main pages | backend `workspace.py`, UI `plugins`, `fleet.js` | Local persistence, pending delivery, ECF verification and Knowledge state remain separate observations. The memory chip says automatic only when current state declares that mode. |
| Personality selection/assets and directive status | Implemented, gated; assets owner-only | `personalityControl`, `personality_assets`, `directive_loaded` | Saved personality selection is read back and must preserve permissions. The panel shows directive-loaded status; it does not reproduce the complete canonical Bloodline directive presentation. |
| ESH | Implemented, owner gated, manual review | ESH panel; backend `agent_tools.py` | The model's ESH execution path is disabled. The user reviews the exact current-chat command before one manual dispatch through the existing owner policy. No grant or shell authority is added. |
| Member isolation | Preserved | browser identity clearing, backend accounts, `workspace.ts` | Members receive their isolated account data and admitted actions; the owner's shared fleet, diagnostics, SDK, Vault, ESH and memory services are not inherited. |

## 5. Composer and chat controls

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| Message size | Implemented | `updateComposerLimit` | Workspace general chat accepts up to 100,000 characters; separate ECHO Code remains 12,000. |
| Attach button and chips | Implemented, gated | `renderComposer`, `updateContext` | Select canonical library files and remove attachment chips before sending. |
| Memory chip | Implemented, gated | `renderComposer` | Automatic memory or private-preference wording follows current state. Opens Plugins & memory. |
| Context percentage and bar | Implemented, bounded evidence | `updateContext` | Distinguishes estimates from matched Qwen measured prompt usage; provider-managed CLI context is labeled without inventing capacity or percentage. Failed/latest unmatched requests do not inherit another turn's measurement. |
| Project, personality, rename, compact, continue, journal | Implemented, gated | conversation toolbar and handlers | Saved personality readback, project selection and canonical chat operations; controls remain Prime's toolbar. |
| Checkpoint banner | Implemented | `#workspace-checkpoint` | Saved summary preview and full checkpoint download; original messages remain saved. |
| Copy, Save to library, Listen; code Save file | Implemented, gated where applicable | `line`, `saveMessage`, `renderMessageBody` | Actions attach to saved messages; Listen requires configured voice. Exact library readback and local file download are distinct outcomes. |
| Empty state and creative mode tabs | Different/extra | UI `index.html` | Prime's starters, orb and Image/Video/Music/SFX/Voice modes remain. |
| Tool-requested UI navigation | Implemented, restricted | `navigationIntent`, `applyNavigation` | Only recognized chat/view targets; owner admission still required for restricted views. Navigation grants no execution permission. |

## 6. Voice bar

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| Persistent voice controls | Implemented when voice configured and authenticated | `renderComposer`, `#workspace-voice-bar` | Dictate, finish/transcribe, Interrupt & speak, Stop voice, bounded conversation and provider-derived status. |
| Spoken replies, brief speech, automatic send | Implemented with intentional defaults | `voiceOptions`, `voiceToggle` | All start off for each session; no automatic restoration of microphone or spoken-reply opt-in. |
| Hands-free safety | Preserved | `startVoiceConversation`, account/page/visibility handlers | Explicit start, at most ten captured turns, and stop/identity/visibility invalidation. |
| Capture duration and transport | Implemented, different transport | `dictate`, `encodeWav` | Select 8/30/60/120 seconds, default 8. Audio is split into sequential requests of at most 8 seconds; bounded transcripts join into one draft. This is not a single 120-second upload. |
| Voice name/provider and Personality Forge footer | Different | `voiceDescription`, voice bar text | Name/provider comes from backend state; no hardcoded Freeman voice or identical canonical provider footer. Real microphone/provider acceptance remains pending. |

## 7. Models, layout and accounts

| Feature | Prime source state | Source anchor | Behavior and remaining difference |
|---|---|---|---|
| Qwen default and model picker | Implemented, configured providers only | backend `providers.py`, UI `models.js` | Default is `c3po-code:echo-qwen38-abliterated-256k` on FORGE, configured context 262,144. Claude, GPT and Grok use their reviewed official CLI subprocess configurations and their own supported logins; no token copying, metered fallback or silent provider fallback. |
| Model metadata and answer attribution | Implemented source contract; live acceptance separate | backend saved `model_identity`/usage events, UI `models.js` | Commander-supplied embedded metadata identifies Huihui-Qwen3.8, abliterated, 27,320,697,856 parameters, Q4_K_M, 262,144 context. The picker label is not independent runtime verification. Saved replies show matched reported identity; unreported CLI identity is explicitly unreported. |
| Provider cancellation | Implemented, fixture verified | backend `providers.py` | Cancellation polling can terminate the owned subprocess; timeout/nonzero/malformed/cancelled turns fail without provider replay. Live account/provider calls still need runtime acceptance. |
| Themes and orb | Extra/preserved | UI `app.js`, `orb.js`, appearance controls | Existing palettes, adaptive quality and reduced-motion behavior remain. |
| Navigation/layout | Implemented | UI `layout.js`, `layout.css` | Left/right navigation, width, dock height, floating geometry, eight edge/corner resize controls, keyboard controls, reset and appearance-only persistence. No account data or command storage in layout preferences. |
| ESH dock | Implemented | `workspace.js` ESH handlers, `layout.js` | Current-chat receipts, review/run, float/move/resize/dock. The `PS >` prompt and status badge are present. Ctrl+Enter reviews first, then executes only the unchanged, current-account reviewed command; repeated key events cannot dispatch it. |
| Import | Implemented, gated | `library`, `normalizeImport` | Source choice, selected-file import up to 1,900,000 bytes, bounded paste and selected conversation branch validation. Imports remain authorized historical copies, not provider account migration. |
| Accounts and recovery | Implemented, canonical admission | `account`, `signOut`, backend accounts | Password/Google routes, signup, owner approvals, password-recovery request, session invalidation and positive anonymous logout readback. Actual identity/email acceptance remains separate. |

## 8. Route and delivery evidence

Prime proxies its fixed canonical Workspace API allowlist, not arbitrary upstream paths, static pages or `/login`. Fleet/health/diagnostics/catalog and the reviewed SDK, Vault, personality-assets, Crystal and memory actions are now used by source UI. Upstream availability is still checked per request. Allowlisted `/api/auth/refresh` and `/api/auth/verify` do not establish upstream implementation; unsupported endpoints can still return 404.

Parent verification checkpoint for this integrated source on 2026-11-04:

- The final canonical backend check passed **211 Python tests**; root Node/Vitest passed **374 tests in 30 files**; the deployment boundary suite passed **8 tests**. Canonical native browser logic and lint/build checks are recorded separately in the release receipts, with exact-candidate identity at delivery.
- New focused checks passed: 57 main-page/composer/legacy UI tests, 16 fleet tests, 74 real-HTTP account/ingress tests and 25 provider tests. Regression cases reproduced failures before their fixes.
- Real CLI canaries passed plain reply and canonical tool-proposal calls for Claude and GPT through the canonical backend adapter. Claude reported `claude-sonnet-5-5`; Codex did not report its model. Native harness tools were not executed and no login material was copied.
- One guarded Qwen load on FORGE returned the exact requested 262,144-token model with 38 healthy gate checks, followed by passing plain and canonical tool-proposal calls through the Workspace adapter. This is actual short-request inference, not a full 256K-window benchmark or long-duration stability claim.
- Grok native-hook isolation and its final installed-client acceptance remain pending. A provider that fails its configuration admission is unavailable; it never silently falls back.

The current apex and www HTTP route serves **Echo Desktop**, not this Prime candidate. A default Python User-Agent receives Cloudflare 1010/403; a browser-compatible HTTP request receives 200 with title Echo Desktop. Both verified target tunnel connectors report applied configuration version **257 with 193 rules**; the intended domains and `desktop-web.echo-op.com` share the existing FORGE 8781 origin. That service and ingress remain untouched. The opaque Cloudflare API-token broker currently returns provider errors 6003/6111 for an invalid Authorization-header format; its cause and target-account binding are unverified. No protection or credential scope was changed.

## Remaining differences and gates

1. Exact canonical branding/typography and thinking-panel visuals differ. Complete screenshot comparison and real authenticated browser workflows remain unverified.
2. Real identity/email, voice, remote memory/MCP, creative operations and Steward admission require their actual runtime evidence. Provider canaries do not establish those separate services.
3. Final exact-SHA checks, independent review, dual certification, genuine required signatures, target/TLS/configuration admission, tested rollback and public acceptance must be resolved before a production-complete claim. The runtime staging package is preparation; it does not provide certification or deployment approval.

Preserved intentionally: approved-account and primary-owner boundaries, manual ESH review with model execution disabled, voice off each session and ten-turn cap, bounded segmented audio, no automatic paid/provider fallback, original data/runtimes, orb/palettes, Steward and Creative Studio. No public cutover or release approval is created by this document.
