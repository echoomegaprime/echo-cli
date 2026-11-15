# Production Echo Workspace on FORGE (echoomegaprime.com)

Operational reference for the production Echo Workspace backend on `FORGE` serving `https://echoomegaprime.com` as of 2026-11-04 (queue `#49859`).

## Overview

Two systemd services run on `FORGE` as `User=forge` under `/home/forge/prime-prod/`:

| Unit | Command | Port | Memory Limits | Role |
| :--- | :--- | :--- | :--- | :--- |
| `echo-prime-web.service` | `node dist/code-main.js prime --config /home/forge/prime-prod/prime.prod.json --port 8776` | `8776` | `MemoryHigh=500M` | Public web server for `https://echoomegaprime.com` behind the Cloudflare tunnel; bridges Workspace traffic over loopback. |
| `echo-workspace-web.service` | `/usr/bin/python3 -X utf8 /home/forge/prime-prod/ws/src/app.py --data /home/forge/prime-prod/ws/data --config /home/forge/prime-prod/ws/config.json --port 8775` | `8775` | `MemoryHigh=600M`, `MemoryMax=800M` | Loopback Workspace backend consumed by the Prime bridge. |

Local loopback endpoints referenced by the Workspace stack on `FORGE`:

| Endpoint | Service / Purpose |
| :--- | :--- |
| `http://127.0.0.1:8776` | `echo-prime-web.service` (Prime web server and Workspace bridge) |
| `http://127.0.0.1:8775` | `echo-workspace-web.service` (Workspace HTTP backend) |
| `http://127.0.0.1:11441` | Local model server (`model_url`) |
| `http://127.0.0.1:8239` | `echo-voice-gateway.service` on `FORGE` (QUENCH reaches this same gateway via SSH tunnel on local port `11440`) |
| `http://127.0.0.1:8000` | `FORGE_BASE` set in the `echo-workspace-web.service` systemd drop-in |

## Configuration reference

Active configuration file: `/home/forge/prime-prod/ws/config.json` (state as of 2026-11-04, queue `#49859`).

Adjacent backup files in `/home/forge/prime-prod/ws/`:
- `config.json.bak-20261104-pre49859`: Original configuration (`plugins: {}`, no `voice` key).
- `config.json.bak-20261104-pre-mission`: Snapshot taken prior to enabling `mission`.

| Key | Purpose | Current Value |
| :--- | :--- | :--- |
| `model_url` | Model inference base URL | `http://127.0.0.1:11441` |
| `model` | Model identifier | `c3po-code:echo-qwen38-abliterated-256k` |
| `context_length` | Maximum model context window | `262144` |
| `public_origins` | Allowed public browser origins | `["https://echoomegaprime.com"]` |
| `catalog_path` | Path to Workspace catalog file | Host path configured in `ws/config.json` |
| `directive_path` | Path to BloodlinePrime directive profile | Host path configured in `ws/config.json` |
| `directive_sha256` | SHA-256 digest pinning the BloodlinePrime profile | Hex digest configured in `ws/config.json` |
| `auth` | Authentication and approval settings (`issuer`, `owner_uids`, `google_client_id`, `telegram_chat_id`) | `issuer`: `https://auth.echo-op.com`; `telegram_chat_id`: `8890692789`; `owner_uids` and `google_client_id` set on host |
| `plugins` | Stdio MCP server map | `{esh, crystal, ecf, personality}` |
| `voice` | TTS/STT persona and voice gateway settings | Persona `freeman` (`"M Freeman"`), `elevenlabs` / `eleven_v4`, `elevenlabs-scribe`, `http://127.0.0.1:8239` (see [Voice](#voice)) |
| `python` | Python interpreter used for SOL CLI dispatch | `/usr/bin/python3` |
| `sol_cli` | Path to `sol_cli.py` for SDK invocation | `/home/forge/prime-prod/ws/plugins/sol-runtime/SYSTEMS/codex_auto/sol_cli.py` |
| `mission` | Owner-authorized SOL mission configuration | `{enabled: true, state: "/home/forge/prime-prod/ws/data/sol/sol.db", role: "builder", workspace: "/home/forge/prime-prod/ws/mission-workspace", owner_session: "echoomegaprime-prod-49859"}` |
| `agents_paths` | Operating instruction files injected into every turn (64000-byte per-file limit) | `["/home/forge/prime-prod/ws/src/launchers/Workspace.AGENTS.md"]` |
| `max_tool_rounds` | Tool-execution round cap per turn (code clamps to `1..4`, default `3`) | `4` |

`auth.telegram_chat_id` (`8890692789`) is the fleet approval chat shared with `approval_gate.py` (one verification message was delivered). `ApprovalNotifier` dispatches account-approval links via the `echo.social.telegram_post` SDK capability, which requires the SOL mission.

## Plugin runtimes

Workspace plugins are stdio MCP servers spawned lazily on first use by `adapters.Stdio` with environment `{**os.environ, **plugin.env}`. Child processes remain inside the `echo-workspace-web.service` cgroup and count toward `MemoryHigh=600M` and `MemoryMax=800M`. Measured cgroup peak with all four plugins spawned plus one voice synthesis: `281 MB`.

### esh

- **Path / cwd**: `/home/forge/echo-shell`
- **Command**: `/usr/bin/python3 -X utf8 -m esh mcp`
- **Environment**:
  - `PYTHONPATH=/home/forge/echo-shell`
  - `ESH_HOME=/home/forge/.echo/esh`
  - `ESH_CLIENT=echo-qwen-workspace`
- **Talks to**: Local `esh` package at `/home/forge/echo-shell` and state directory `/home/forge/.echo/esh`.
- **Known limits**: Shares the `echo-workspace-web.service` cgroup memory ceiling (`600M` high / `800M` max).

### crystal

- **Path**: `/home/forge/prime-prod/ws/plugins/crystal` (files copied from the QUENCH repo `echo-crystal-memory-server`; `.venv` contains `mcp 2.3.0` only, without `fastembed`)
- **Command**: `/home/forge/prime-prod/ws/plugins/crystal/.venv/bin/python -X utf8 /home/forge/prime-prod/ws/plugins/crystal/crystal_cli.py serve`
- **Environment**:
  - `ECHO_CRYSTAL_DB=/home/forge/.echo/crystal_memory.db`
  - `ECHO_CRYSTAL_FASTEMBED=0`
- **Talks to**: Local SQLite store `/home/forge/.echo/crystal_memory.db` on `FORGE`.
- **Known limits**: Fresh, empty store on `FORGE` supporting FTS recall only (no `fastembed` vector embeddings). Separate from the QUENCH Crystal store.

### ecf

- **Path**: `/home/forge/prime-prod/ws/plugins/ecf-stdio.sh`
- **Command**: `/home/forge/prime-prod/ws/plugins/ecf-stdio.sh` (wrapper script that sources `/home/forge/ecf-mcp/ecf-mcp.env` with mode `0600` and `exec`s the `ecf-mcp.mjs` release used by `echo-ecf-mcp` with `--stdio`; pinned fallback release `3f56150d...-binding-checks-20261031`)
- **Environment**: `{**os.environ, **plugin.env}` plus variables sourced from `/home/forge/ecf-mcp/ecf-mcp.env` (`0600`).
- **Talks to**: Echo Continuity Fabric via `ecf-mcp.mjs --stdio` when stdio transport is selected.
- **Known limits**: Not used while `sol_cli` is configured. When `sol_cli` is set in `ws/config.json`, the Workspace routes `ecf` operations through the SOL mission (`echo.continuity.*` SDK capabilities) instead of spawning `ecf-stdio.sh`.

### personality

- **Path**: `/home/forge/prime-prod/ws/plugins/echo-personality-forge` (copied from the QUENCH Codex plugin cache, `27 MB`)
- **Command**: `/usr/bin/node /home/forge/prime-prod/ws/plugins/echo-personality-forge/mcp-server/dist/index.js`
- **Environment**:
  - `ECHO_VOICE_GATEWAY_BASE=http://127.0.0.1:8239`
  - `ECHO_VOICE_GATEWAY_TRANSPORT=http`
  - `ECHO_AUDIO_ALLOWED_HOSTS=127.0.0.1:8239`
  - `ECHO_PERSONALITY_FORGE_HOME=/home/forge/prime-prod/ws/data/personality-forge`
- **Talks to**: `echo-voice-gateway.service` at `http://127.0.0.1:8239` and state directory `/home/forge/prime-prod/ws/data/personality-forge`.
- **Known limits**: Audio host allowlist restricted to `127.0.0.1:8239`; static `27 MB` copy from QUENCH cache; shares the `echo-workspace-web.service` cgroup limits.

## Voice

`voice` block in `/home/forge/prime-prod/ws/config.json`:

| Field | Value |
| :--- | :--- |
| `plugin_root` | `/home/forge/prime-prod/ws/plugins/echo-personality-forge` |
| `node` | `/usr/bin/node` |
| `persona` | `freeman` |
| `label` | `"M Freeman"` |
| `provider` | `elevenlabs` |
| `model` | `eleven_v4` |
| `stt_provider` | `elevenlabs-scribe` |
| `gateway_base` | `http://127.0.0.1:8239` |

`gateway_base` points to `echo-voice-gateway.service` running locally on `FORGE` (`http://127.0.0.1:8239`); QUENCH reaches the same gateway over an SSH tunnel on local port `11440`. Production verification completed one speak and audio round trip (`2.24 s` WAV).

## SOL mission

The Workspace runs an owner-authorized SOL mission providing scoped SDK capabilities (`echo.continuity.*`, `echo.social.telegram_post`, and other `builder`-role SDK calls). The runtime was copied from QUENCH `Echo.SolProfile 1.1.3` to `/home/forge/prime-prod/ws/plugins/sol-runtime/`, containing `SYSTEMS/codex_auto/sol_*.py`, `skill_gateway`, `role_power_registry.json`, `FLEET_ROLES/`, and `AGENTS.md`.

### How it works and token renewal

1. `mission.py` initializes the mission once on startup using `python` (`/usr/bin/python3`) and `sol_cli` (`/home/forge/prime-prod/ws/plugins/sol-runtime/SYSTEMS/codex_auto/sol_cli.py`).
2. `mission.py` records mission metadata in `/home/forge/prime-prod/ws/data/sol-mission.json` (`data/sol-mission.json`), storing the token hash only (never the raw broker token), and renews 120-minute broker tokens automatically.
3. `sdk_dispatch.py` executes `sol_cli sdk invoke` with the active broker token in memory.
4. `sol_sdk.py` retrieves the sovereign gate key by executing `ssh forge "awk ... /home/forge/.echo_sovereign_key"`. To authorize this local SSH hop, `forge`'s own `id_ed25519.pub` was appended to `forge`'s `authorized_keys` (pre-change backup: `authorized_keys.bak-20261104-pre49859`).

### Preflight requirements

SOL preflight fails unless all four conditions hold:
- `/home/forge/prime-prod/ws/mission-workspace` contains git metadata (initialized git scope directory containing only a `README`).
- An executable named `python` exists on `PATH` (provided via symlink `/home/forge/prime-prod/ws/plugins/bin/python` -> `/usr/bin/python3` and exposed by `zz-echo.conf`).
- `/home/forge/prime-prod/ws/plugins/sol-runtime/FLEET_ROLES/builder.md` is present.
- `/home/forge/prime-prod/ws/plugins/sol-runtime/FLEET_ROLES/AUTONOMY_DOCTRINE.md` is present.

### Identity and state storage

- **Mission SQLite state**: `/home/forge/prime-prod/ws/data/sol/sol.db` (`mission.state`)
- **Mission state file**: `/home/forge/prime-prod/ws/data/sol-mission.json` (token hash only)
- **Owner session and role**: `owner_session = "echoomegaprime-prod-49859"`, `role = "builder"`
- **Scope workspace**: `/home/forge/prime-prod/ws/mission-workspace`
- **Gate key**: `/home/forge/.echo_sovereign_key` (accessed over `ssh forge` via `id_ed25519.pub` in `authorized_keys`)

## systemd drop-ins

### `echo-workspace-web.service`

Path: `/etc/systemd/system/echo-workspace-web.service.d/zz-echo.conf`

```ini
[Service]
Environment=PATH=/home/forge/prime-prod/ws/plugins/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
Environment=FORGE_BASE=http://127.0.0.1:8000
Environment=PYTHONUTF8=1
EnvironmentFile=-/home/forge/prime-prod/ws/env/workspace.env
```

`/home/forge/prime-prod/ws/env/workspace.env` has mode `0600` and is reserved for vault-backed secrets (none are required today). Never place secrets directly in unit or drop-in files.

### `echo-prime-web.service`

Diagnostics drop-in `zz-debug.conf`:
- Sets `Environment=NODE_DEBUG=echo-prime*`.
- Causes Node `util.debuglog` namespaces `echo-prime`, `echo-prime-server`, `echo-prime-workspace`, and `echo-prime-steward` to emit JSON lines to the systemd journal.
- Remove `zz-debug.conf` (then `systemctl daemon-reload` and restart `echo-prime-web`) to silence debug output.

## Verification

`/api/health`, `/api/catalog`, and `/api/plugins` on port `8775` are owner-gated and return HTTP `401` without an authenticated owner session. Do not treat `401` on those routes as a service failure.

1. **Offline direct-import verification inside a transient unit matching service limits** (the script lives in the repo at `scripts/ops/verify_prod_workspace.py` and on FORGE at `/home/forge/prime-prod/ws/plugins/verify_prod_workspace.py`; add `--send-telegram` to deliver one verification message to the approval chat):
   ```bash
   sudo systemd-run --uid=forge --gid=forge \
     -p MemoryHigh=600M -p MemoryMax=800M \
     -p ProtectSystem=full -p NoNewPrivileges=true \
     -p WorkingDirectory=/home/forge/prime-prod/ws \
     --wait --pipe --collect --quiet \
     env -i PATH=/home/forge/prime-prod/ws/plugins/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin \
       HOME=/home/forge LANG=en_US.UTF-8 USER=forge LOGNAME=forge \
       FORGE_BASE=http://127.0.0.1:8000 PYTHONUTF8=1 \
       /usr/bin/python3 -X utf8 /home/forge/prime-prod/ws/plugins/verify_prod_workspace.py
   ```
   Expected: exits `0` and ends with `passed 12 failed 0 skipped 0` (or `skipped 1` without `--send-telegram`) across mission, SDK health, web search, the four connectors, voice, `agents_paths` (`<= 64000` bytes), `max_tool_rounds`, Telegram and cgroup memory. Result on 2026-11-04: `passed 12 failed 0 skipped 0`, mission `ready: true`, Telegram `message_id` 185500, cgroup `memory.peak` 184 MB.

2. **Service logs and cgroup memory**:
   ```bash
   journalctl -u echo-workspace-web -n 100 --no-pager
   systemctl show echo-workspace-web -p MemoryCurrent
   ```
   Expected: no unhandled tracebacks in journal; `MemoryCurrent` well below `MemoryHigh=600M` / `MemoryMax=800M` (reference peak with 4 plugins + 1 voice synthesis: `281 MB`).

3. **Workspace loopback session probe**:
   ```bash
   curl -sS -i http://127.0.0.1:8775/api/auth/session
   ```
   Expected: HTTP `200` with anonymous session JSON.

4. **Prime bridge session probe**:
   ```bash
   curl -sS -c /tmp/prime.cookies -H "Host: echoomegaprime.com" http://127.0.0.1:8776/ >/dev/null
   curl -sS -i -b /tmp/prime.cookies \
     -H "Host: echoomegaprime.com" \
     -H "x-prime-request: 1" \
     http://127.0.0.1:8776/api/session
   rm -f /tmp/prime.cookies
   ```
   Expected: `GET /` issues the `echo_prime` cookie; `GET /api/session` with `Host: echoomegaprime.com`, `echo_prime`, and `x-prime-request: 1` returns a valid bridge session response.

## Rollback

To revert `echo-workspace-web.service` to a prior configuration:

1. Restore `/home/forge/prime-prod/ws/config.json` from the target backup:
   - Full pre-49859 rollback (`plugins: {}`, no `voice`): `cp -p /home/forge/prime-prod/ws/config.json.bak-20261104-pre49859 /home/forge/prime-prod/ws/config.json`
   - Pre-mission rollback: `cp -p /home/forge/prime-prod/ws/config.json.bak-20261104-pre-mission /home/forge/prime-prod/ws/config.json`
2. Remove `/etc/systemd/system/echo-workspace-web.service.d/zz-echo.conf`.
3. Reload systemd and restart the Workspace unit:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart echo-workspace-web
   ```
4. Re-run `curl -sS -i http://127.0.0.1:8775/api/auth/session` and `systemctl show echo-workspace-web -p MemoryCurrent`.

Rollback notes:
- Directories under `/home/forge/prime-prod/ws/plugins` can remain on disk; they are inert when unreferenced by `ws/config.json`.
- If rolling back the self-SSH change as well, restore `authorized_keys` from `authorized_keys.bak-20261104-pre49859` only after disabling `mission` / `sol_cli`.
- Removing `zz-debug.conf` on `echo-prime-web.service` is independent of Workspace rollback.

## Known limits and follow-ups

- **Crystal store empty on FORGE**: `/home/forge/.echo/crystal_memory.db` is a fresh, empty SQLite store using FTS recall only (`ECHO_CRYSTAL_FASTEMBED=0`; `.venv` installs `mcp 2.3.0` without `fastembed`). It is not synced with the QUENCH Crystal store.
- **ECF routed via SDK when `sol_cli` is set**: With `sol_cli` configured, Workspace dispatches `ecf` calls through the SOL mission (`echo.continuity.*` SDK capabilities) rather than spawning `/home/forge/prime-prod/ws/plugins/ecf-stdio.sh`.
- **Telegram approval destination**: `auth.telegram_chat_id` is set to `8890692789` (the fleet approval chat used by `approval_gate.py`). `ApprovalNotifier` requires a working SOL mission to invoke `echo.social.telegram_post`.
- **Owner-gated HTTP routes**: `/api/health`, `/api/catalog`, and `/api/plugins` return `401` without an owner session; unauthenticated monitoring must use `/api/auth/session` (`200`) or `scripts/ops/verify_prod_workspace.py`.
- **SOL probe state**: the two state databases used while bringing the mission up (`sol-probe-49859.db`, `sol-probe113-49859.db`) were moved to `/home/forge/prime-prod/ws/data/sol/probes/`; the live mission uses `/home/forge/prime-prod/ws/data/sol/sol.db` only.
- **Vendor CLIs on FORGE**: `claude` (2.1.280) and `codex` (0.149.1) are installed and signed in; `grok` and `agy` are not installed, so the Prime model picker lists Grok and Argon as unavailable by design.
- **Drafting provenance**: this document was first drafted by Gemini (`wrap.sh draft gemini`) and `scripts/ops/verify_prod_workspace.py` by Codex (`wrap.sh draft gpt`); both were reviewed, corrected and verified by the operator before commit.

## Change log

| Date | Queue | Tag | Summary |
| :--- | :--- | :--- | :--- |
| `2026-11-04` | `#49859` | `AUTO476-ops` | Enabled the MCP plugins (`esh`, `crystal`, `ecf`, `personality`), the `freeman` voice via `echo-voice-gateway.service` (`:8239`), the `builder` SOL mission (`echoomegaprime-prod-49859`), the `zz-echo.conf` systemd drop-in, `agents_paths` (`Workspace.AGENTS.md`), `max_tool_rounds: 4` and Telegram approval delivery (`8890692789`); verified 12/12 with `verify_prod_workspace.py`. Same day: Cloudflare Web Analytics RUM set to Disable for echoomegaprime.com and the redirect rule `*://www.echoomegaprime.com/*` -> `https://echoomegaprime.com/${2}` (301) deployed. |
