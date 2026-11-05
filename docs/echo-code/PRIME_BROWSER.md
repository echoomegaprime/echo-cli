# ECHO Prime — In-chat browser (ShadowGlass)

> An owner-only, dockable in-chat browser panel in the Echo Prime workspace (served from FORGE at
> `echoomegaprime.com`) that drives the **Commander's own signed-in Chrome** through the ShadowGlass
> browser extension's loopback control relay. Added 2026-11-04 (Commander order: "ADD AN IN-CHAT BROWSER
> WITH SHADOW GLASS EXTENSION"). Opt-in, loopback-only, owner-only; nothing runs by Echo without an
> explicit Approve.

## 1. Topology / transport

```
Prime UI (echoomegaprime.com)                 QUENCH (the Commander's PC)
  └─ GET/POST /api/prime/browser/*            ShadowGlass extension (service worker)
        │ owner-only, same-origin                   ▲ connects OUT (WS /ext)
        ▼                                            │
  Prime server (FORGE)  ── BrowserClient ──►  relay esh_control_server.mjs  (127.0.0.1:9780)
        fetch to 127.0.0.1:9780/rpc  ◄── reverse SSH tunnel ──┘
```

Prime runs on FORGE and, by contract, only ever talks to **loopback**. The ShadowGlass relay runs on
QUENCH (where the Commander's Chrome is). A hidden reverse-SSH tunnel publishes the QUENCH relay at FORGE
loopback so `BrowserClient` can reach it without Prime ever opening a non-loopback socket:

```
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R 127.0.0.1:9780:127.0.0.1:9780 forge
```

The `-R 127.0.0.1:9780:…` binds **loopback** on FORGE (so FORGE `sshd` `GatewayPorts no` is irrelevant;
`AllowTcpForwarding yes` is all that is required — both confirmed on FORGE). The extension connects *out* to
the relay; the relay is a tiny localhost broker. **No tokens or secrets pass through Prime** — `BrowserClient`
never touches the relay's token-gated `/vault` or `/brain` routes.

### Starting / stopping the relay tunnel

Scripts live in the **main checkout** (not the Prime worktree), at
`SYSTEMS/echo_shadowglass_relay_forge/` of `echo-omnipresence-runtime`:

| File | Purpose |
|---|---|
| `relay_tunnel.ps1` | Wrapper loop: runs the `ssh -N -R …` tunnel, relaunches on any exit (clean or not), logs every exit code to `logs/relay_tunnel.log`, bounds the log. |
| `register_task.ps1` | Registers/re-registers the hidden scheduled task (idempotent). |

```powershell
# register + start (hidden, runs as the signed-in Commander, Interactive logon so the `Host forge` ssh alias resolves)
powershell -File SYSTEMS\echo_shadowglass_relay_forge\register_task.ps1

# manual control
Start-ScheduledTask  -TaskName EchoShadowGlass-Relay-Forge
Stop-ScheduledTask   -TaskName EchoShadowGlass-Relay-Forge
Get-ScheduledTask    -TaskName EchoShadowGlass-Relay-Forge | Select State
```

The task mirrors `EchoNexus-QUENCH-Outbound-v2`: `MultipleInstances=IgnoreNew`, `RestartCount=999`,
`RestartInterval=PT1M`, `ExecutionTimeLimit=0` (infinite), `StartWhenAvailable`, an at-logon trigger **and** a
PT1M repeating trigger. The repeating + `IgnoreNew` trigger is the belt-and-braces restart if the wrapper is
ever killed (Windows Task Scheduler does **not** restart a process that exits cleanly, so the wrapper also loops
itself — memory #43963). The ShadowGlass **side panel must be open** on the Commander's Chrome so the
extension's service worker is connected to the relay (`GET /status` → `ext_connected:true`).

Verify from FORGE:

```bash
ssh forge "curl -s 127.0.0.1:9780/status"
# {"ok":true,"ext_connected":true,"pending":0,"port":9780,"brain":"echo.aiorchestrator.chat","sol":true}
```

> **After a QUENCH-side crash**, FORGE `sshd` holds the stale forward until `ClientAlive` expires
> (`ServerAliveInterval 300 × 3 ≈ 15 min` on FORGE); `ExitOnForwardFailure` makes the wrapper loop until the
> stale bind is released. This is expected; the tunnel self-heals.

## 2. Configuration (opt-in)

Add a reviewed `browser` section to the Prime config passed to `code prime --config`:

```json
{ "browser": { "relayUrl": "http://127.0.0.1:9780" } }
```

- `relayUrl` must be a credential-free **loopback** origin (default `http://127.0.0.1:9780`). A non-loopback
  host, embedded credentials, a path/query, or any unknown key is refused (`parseBrowserConfig`).
- **Absent `browser` section = feature off.** The panel then shows an off-explainer and makes no request.

## 3. RPC allowlist (Prime verb → relay `type`)

`BrowserClient` only ever POSTs these relay RPC types; everything else the relay exposes
(`cdp_navigate`, `agent_spawn`, `cap`, `direct`, `brain_chat`, `privacy_*`, …) is **not reachable from Prime**.

| Prime verb | relay RPC | Notes |
|---|---|---|
| `tabs()` | `tabs_list` | ids + redacted url/title |
| `open(url)` | `tabs_new {url, active:false}` | http/https only; never focuses the tab |
| `close(tab)` | `tabs_close {id}` | |
| `navigate(tab,url)` | `navigate {tabId,url}` | content-script nav (no debugger infobar); http/https only |
| `nav(tab,back\|forward\|reload)` | `cdp_evaluate` | **fixed** expressions `history.back()` / `history.forward()` / `location.reload()` — never built from caller input |
| `scroll(tab,dy)` | `cdp_evaluate` | `window.scrollBy(0,<int>)`; `dy` clamped to ±100000 and `Math.trunc`'d — a Number, so the expression is digits only |
| `snapshot(tab,withShot)` | `page_content` (+ `cdp_screenshot` + `cdp_evaluate` metrics when `withShot`) | text + a11y nodes always; screenshot + viewport metrics only on request |
| `click(tab,{x,y})` | `cdp_click_at {tabId,x,y}` | viewport coords (UI scale-corrects image px → viewport px with the snapshot metrics) |
| `click(tab,{text})` | `click_text {tabId,text}` | click by accessible name |
| `type(tab,text)` | `cdp_type {tabId,text}` | raw keystrokes into the focused element |
| `fill(tab,selector,value)` | `fill {tabId,selector,text}` | content-script; the extension **refuses secret fields** |
| `read(tab,selector)` | `read_field {tabId,selector}` | non-secret value only |

Guards on every call: `tabId` is always sent explicitly and validated as a **positive safe integer** (Chrome tab
ids are ints, *not* 32-hex); URLs are http/https only; owner-supplied text is capped at **64 KiB**; a screenshot
`dataUrl` must match `^data:image/(png|jpeg);base64,…$` and be **≤ 2 MiB** or it is dropped (text fallback);
responses are size-capped (1 MiB ordinary / ~2 MiB screenshot); 10 s timeouts; `redirect:'error'`; every
returned string run through `redact()`; each action logged as a `prime_browser_action` debug event with
`verb`/`tab`/`url` (never field values). The relay returns HTTP 200 with `ok:false` for most errors (only
`ext_offline` is 503); `BrowserError` maps `refused_secret_*` → 400 "extension refused", `ext_offline` → 502
"not connected", `unknown_rpc` → 400, timeouts → 504 "outcome unknown", everything else → 502.

## 4. Routes (owner-only)

All under `/api/prime/browser/`, behind the server's `requireOwner` gate and the same-origin Prime session:

- `GET  /status` — `{configured, available, relayUrl, reason?}` (uses the relay `GET /status`; does **not** attach the debugger).
- `GET  /tabs` — `{tabs:[…]}`.
- `GET  /snapshot/:tab?shot=1` — text + nodes (+ screenshot + metrics when `shot=1`).
- `POST /act {verb, …}` — every mutating verb (open/close/navigate/back/forward/reload/scroll/click/type/fill/read).

## 5. Live view & screenshots (honest limitation)

The relay's `cdp_screenshot` attaches `chrome.debugger` (Chrome shows an unavoidable "is debugging" infobar) and
on this setup **reliably times out** — `Page.captureScreenshot {captureBeyondViewport:true}` did not return
within the relay's 60 s RPC window on either an inactive tab *or* the currently active tab (both measured
2026-11-04; `cdp_evaluate` on the same tabs returned instantly, so it is the full-page capture that hangs, not
debugger attach or tab backgrounding). Because of that, **the live view defaults to text** (`page_content`
readable text + the interactive-element list) — the normal, reliable path — and a screenshot is attempted only
when the owner switches to Image view. Prime aborts the screenshot at 10 s and falls back to text with a reason.
When a screenshot *does* arrive, click-on-screenshot is scale-corrected using the page's `devicePixelRatio` and
scroll offset (from the metrics the snapshot fetches); a click below the current fold needs a scroll first.
Polling pauses when the panel is hidden or collapsed, and each `cdp_*` call briefly flashes the "is debugging"
infobar, which is why Image mode is opt-in.

## 6. Approval model — "Let Echo drive"

The browser is driven by the **owner**. When an assistant reply contains a fenced block:

````
```browser
open https://example.com
click Sign in
read #status
```
````

the panel renders an **Approve / Skip** card in the chat. **Nothing runs until the owner clicks Approve**;
Skip runs nothing. On Approve the actions run sequentially through `/api/prime/browser/act` and results are
posted back as a system card; a failure stops the remaining actions. Supported drive verbs:
`open · navigate · click · type · read` (capped at 20 per block).

The `/browse <url>` chat command opens the panel and the URL directly (owner action, not an Echo-driven batch).

> Note: the "already run" set is in-memory and empty on page load, so reopening a saved conversation that still
> contains a ```` ```browser ```` block re-proposes it as a fresh Approve/Skip card. This is harmless (it still
> requires an explicit Approve and runs nothing on its own) but can surprise.

## 7. Security boundary & known exposure

- **Owner-only.** Every route is behind `requireOwner`; the panel is never shown to members and never available
  to bots. On an open host (no authenticated Workspace) the Prime cookie alone is the owner, consistent with the
  rest of Prime.
- **Loopback-only, token-free.** Prime never handles the relay's token; it never calls `/vault` or `/brain`.
- **Never types credentials.** The extension refuses secret fields in `fill`; Prime never drives secret inputs.
- **No extra windows.** It drives the Commander's *live* tabs (`tabs_new` opens inactive; it never focuses or
  creates windows) — that is the feature.
- **⚠ Unauthenticated relay.** The relay's `/rpc` has **no auth** (loopback-scoped by design). Once the reverse
  tunnel is up, *any* process on FORGE (the ~42 services, the gate's `echo.shell.run`) can reach
  `127.0.0.1:9780/rpc` and drive the Commander's Chrome directly — including `cdp_evaluate` (arbitrary JS),
  `cap`, `direct`, `agent_spawn`. Prime being owner-only does **not** close that FORGE-side exposure. Follow-up
  **queued as build-prompt #49902 (`shadowglass-relay-auth-shim`)**: add an auth shim on the relay (require an
  `X-SG-Token` on `/rpc`, not just on `/vault`+`/brain`), or switch the transport to a `-R /path.sock`
  streamlocal forward so only the socket-holder can reach it.

## 8. Tests

- `tests/prime-browser.test.ts` (20) — config, URL-scheme allowlist, verb→RPC mapping, fixed nav/scroll
  expressions (no caller text), tab-id validation, text/screenshot caps, redaction, error mapping,
  ext-offline/timeout/abort, off-state, and the owner-only server routes + assets.
- `tests/prime-browser-ui.test.ts` (10) — fenced-block parsing, admission, no-fetch-while-anonymous, panel
  open/close + poll pause, the Approve/Skip gate (nothing runs until Approve), and the `/browse` intercept.

Verified only against a stand-in relay and a fake DOM. The real extension relay was reached once live to confirm
`ping`, `tabs_list`, `page_content`, `cdp_evaluate`, and that `cdp_screenshot` times out.
