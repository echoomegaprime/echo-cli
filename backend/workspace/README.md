# Echo Qwen Workspace

A loopback-only workspace for the existing FORGE Qwen model, with saved chats,
projects, compaction, library files, code review, Echo connectors and voice.

## Run

Python 3.11+ and a current Node runtime are required. The Python web server uses
only the standard library. Existing Crystal, ESH and Personality Forge plugin
installations remain external dependencies; this module does not install or
silently replace them. The delivered launcher package contains the machine's
non-secret configuration and existing authenticated SSH routes.

```powershell
python app.py --data <private-data-directory> --config <workspace-config.json> --port 8768
```

Bind remains loopback-only. Public HTTPS hosting requires enabled identity login, pinned owner UIDs, explicit origins and validated ingress. See [AUTH.md](AUTH.md) for admission, Telegram review links and per-user memory isolation. Owner SDK actions retain their mission scope. See [MCP.md](MCP.md) for URL connections, encrypted credentials and tool receipts.

## Context and storage

- SQLite retains chats, messages, checkpoints, projects, events, library records
  and the durable ECF outbox. Markdown journals are created with each chat and
  regenerated from retained events at startup.
- Compaction creates a continuation checkpoint; it preserves original messages.
  Continue in new chat copies the history and checkpoint into a separate chat.
- Artifacts include contents, full paths and SHA-256 receipts. Generated speech
  audio is kept under `data/voice` with path/hash receipts in its chat journal.
- Raw microphone recordings are not retained locally. Their transcript and a
  recording hash are journaled. Selected audio and spoken text go to ElevenLabs.
- The default is the exact `c3po-code:echo-qwen38-abliterated-256k` profile,
  context 262144. A different loaded context or extra loaded model fails the
  readiness check. The client does not evict/load another model automatically.
- Prompt-token preflight checks the measured count against the output reserve;
  the client requests no context shifting or silent truncation. The UI's running
  token estimate is approximate. 256K configuration is not a full-window load test.
- Saved history does not mean every past message is in every prompt. Summaries
  can omit detail; searchable originals remain available. No claim of infallible
  model recall or universal secret redaction is made.

## Echo integrations

`adapters.py` uses persistent stdio MCP clients for Crystal, ESH, Continuity Fabric
and Personality Forge. SDK invocation uses the installed `sol_cli.main` through
an isolated stdin helper with the existing token and state; it does not issue or
refresh scopes. Cached active-capability metadata is searchable; live schema and
invocation remain subject to the mission and backend capability controls.

Vault put/get/list/locate are separate actions. Credential input travels through
stdin, not command arguments or temporary files, and is removed from event
payloads. Returned values are projected to metadata; the chat model does not
receive provider keys. Generic SDK input rejects credential-shaped fields and
Vault capabilities. Unknown secret formats in ordinary text may evade heuristic
redaction, so credentials belong in the Vault form.

ECF retries run while the app is open. A write and a verified readback are separate
states. Denied or unavailable capture stays pending. A local journal or SDK
context memory is never labeled Fabric ingestion. Imported ChatGPT/Claude exports
and neutral JSON/text use the same journal/outbox path; the app does not scrape or
automatically mirror other providers' chats. ChatGPT imports follow the exported
current branch rather than pretending every alternate branch is one transcript.

The configured BloodlinePrime profile is hash checked and included in model
context. It preserves compatible owner preferences within actual platform/tool
permissions; source and adapted-profile provenance remain distinct.

## Voice and Personality Forge

The selected `freeman` persona is resolved by the existing Voice Gateway to the
saved ElevenLabs **M Freeman** voice. Provider voice IDs and keys remain in that
gateway. The workspace uses Personality Forge's actual progressive-synthesis MCP
tools for text preparation, chunking and synthesis. Its installed transport module
provides bounded audio retrieval and Scribe transcription. Explicit ElevenLabs
selection is verified, with no silent provider fallback.

The verified gateway is FORGE loopback `8239`, reached through an owned SSH
forward at local `11440`. The plugin's historical default `8265` serves a different
application in this estate; workspace configuration explicitly selects the
measured endpoint without modifying the global plugin.

The browser microphone is off at startup. Dictate requests microphone permission,
captures the same stream with requested echo cancellation/noise suppression/gain
control, and stops after two seconds of silence following detected speech. Actual
processing depends on browser/device support; no RNNoise claim is made. Clips are
split into at most 7.5-second mono 16 kHz PCM pieces to respect gateway limits.
Raw audio stays in memory and is not added to the local library.

Dictation fills the composer by default. Optional automatic sending and spoken
replies are explicit controls. Stop pauses playback, closes the microphone and
discards late responses; provider work already in flight may still finish and be
billed. One next speech section may be prepared during playback. TTS begins after
the chat answer has been persisted; token-level model-to-voice streaming is not
claimed. Browser autoplay may require the user to press Play.

## Verification

```powershell
python -m unittest discover -s tests
node --test tests/voice_browser.test.mjs tests/esh_panel.test.mjs
node --check static/app.js
node --check static/voice.js
```

Tests exercise history retention, idempotency, traversal protection, CSRF/origin,
credential isolation, failed ECF delivery, context mismatch, progressive voice
ownership/cancellation, ambiguous paid retries, bounded PCM and browser hearing.
Live acceptance receipts are delivered separately from source tests. A passing
local candidate is not external CertForge certification or a hosted release.


## Bottom ESH panel

Click the ESH strip at the bottom to open or close the dock. Expand gives the
output more room; the panel remembers its open state in this browser. Run submits
the command through the existing local ESH connector (Ctrl+Enter also submits).
The current chat owns the persistent shell session and its journal receipts.

Echo's native esh tool feeds the same panel. Started and completed calls include
the command, source, real output, exit status, and expandable ESH audit receipt.
Commands that fail or need authorization retain their receipts and are not marked
successful. Interrupted calls without a final receipt remain unconfirmed and
are not retried automatically. Output is rendered as text.

This dock controls the local QUENCH ESH session. Fleet command access uses the
separate scoped node SDK adapter; a healthy fleet light does not prove ESH remote
execution. The local workspace's current ESH remote executor is not configured.

When starting through ESH, foreground child processes are cleaned up and
background jobs have an explicit timeout. A persistent deployment should use an
OS-managed service or task. The installed local candidate uses the on-demand
hidden user task Echo-Qwen-Workspace-8768 with pythonw.exe, no stored credential,
no public listener, and no automatic logon trigger. Its process name and creation
time are recorded in logs/app-process.json. The stop launcher accepts the recorded
pythonw process while preserving the existing PID-reuse check.


## Panel layout and capability context

Drag the ESH grip to float the shell; resize floating edges/corners or the dock divider. Float/Dock returns it to the bottom; Reset restores defaults. Drag navigation to either side and its divider to resize. Arrow keys on the handles offer the same control. Layout is saved in this browser and clamped to the current viewport on restore. Structured layout debug events contain geometry only.

CAPABILITIES.md plus the generated native-tool manifest and full SDK namespace inventory are injected into every chat turn, including new and compacted chats. The capabilities tool rereads that current guide with a journal receipt. The context event records the guide SHA and active native tool names. Catalog presence is distinguished from authorization and live execution. ShadowGlass Chrome control remains unintegrated: its local extension relay and CDP endpoint were both unreachable during this update; no browser control or credential access was enabled.

Validation: 60 Python tests; 12 JavaScript tests (including geometry persistence, viewport bounds and storage recovery).

The response loop now ends duplicate calls, defaults to three tool rounds, and forces a natural-language response with tools disabled. Blank or failed final generation produces an honest saved fallback rather than silently ending after receipts. Verbal-response requests use the direct-answer path. Interrupted playback clears stale Speaking status. Structured tool_loop_summary events record finish reason, tool count and duration.
