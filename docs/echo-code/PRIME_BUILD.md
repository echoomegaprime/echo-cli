# Echo Build

Echo Build creates runnable projects with a subscription CLI, builds them, starts their server and verifies the result. It can create a web app, API, Node or Python program, CLI, or static site. The output is a workspace containing the actual source and entry points, not a generated image or a page describing an imaginary app.

The feature is off unless the reviewed Prime configuration contains `build`:

```json
{
  "build": {
    "root": "D:\\ECHO_OMEGA_PRIME\\01_WORKSPACES\\builds",
    "engines": ["gpt", "grok", "gemini", "claude"],
    "previewBase": "http://127.0.0.1:8400",
    "maxConcurrent": 1,
    "deploy": {
      "forge": { "unitPrefix": "echo-build" },
      "vercel": true
    }
  }
}
```

`root` must be an absolute, dedicated directory. `engines` is a nonempty list with no duplicates. Unknown keys at every configuration level are refused. `maxConcurrent` defaults to 1 and accepts 1–4. Keep it at 1 on a memory-constrained host. `previewBase` is an HTTP loopback origin; its explicit port is the beginning of a 20-port pool. The default is 8400–8419. Prime always fetches previews through `127.0.0.1`, never through a remote origin. `deploy` is optional; its presence enables targets, not automatic deployment.

Start Prime using its existing `--config` mechanism. Node, npm, git, the selected engine CLI and Bash must already be installed. Windows uses Git Bash, not the Windows WSL launcher. Generated applications install their own local dependencies, including Playwright and its headless Chromium runtime for the browser gate. Missing dependencies are reported as failures; no fallback provider or fake QA success is substituted.

## Architecture and ownership

`src/prime/build.ts` owns configuration, workspaces, queueing, subprocesses, ports, metadata and the bounded preview fetch. `PrimeHub` exposes typed methods and the server applies the existing Prime session and primary-owner gates. `build.js` and `build.css` provide the owner-only view. There is no new unauthenticated worker service.

Every build has a random 32-character lowercase hex ID and lives at `<root>/<build_id>`. Records contain title, prompt, engine, status, workspace, preview port/URL, optional repository, a bounded event log, and creation/update times. Control metadata is written atomically under `<root>/.echo-build-state`, outside the generated app. A runner lock prevents two active processes from owning the same root. Links/junctions are refused for control paths. Recovery loads metadata conservatively and does not claim an old server is running or kill processes by a stale PID.

The state sequence is `queued → scaffolding → building → qa → running`. Errors become `failed`. Hibernate and Stop terminate owned process trees and retain the workspace as `hibernated`. Revive executes the existing `startup.sh`, checks HTTP and repeats browser QA. Follow-up turns use the same workspace, stop the supervised preview, re-run the selected engine, repeat `npm run build`, then launch and verify the updated server. No task is silently retried after a host restart.

The runner supplies a fresh `AGENTS.md`, a private prompt file and secret-safe `.gitignore` entries. It initializes git locally. It reuses `childEnv()` from `src/code/providers.ts` and adds only nonsecret runtime values: `PORT`, `HOST`, `ECHO_BUILD_BASE`, `CI` and `BROWSER=none`. On Windows it also sets `MSYS2_ENV_CONV_EXCL=ECHO_BUILD_BASE` so Git Bash preserves `/` as a URL base when launching native Node/Python. Parent API keys, broker tokens and other credential variables are not forwarded. Each provider uses its own official CLI login. Echo Build neither reads nor copies credential stores. CLI availability is exposed as `buildProviders` on `/api/prime/models`, with the same meanings as the existing model probes: GPT login status is `signed-in`; the other CLI version checks prove `installed` only. Results are cached for 60 seconds, and probes run sequentially.

**This is an application boundary and an engine contract, not an OS security sandbox.** Generated build scripts, startup scripts and engines execute code as the host user. The selected engine's own sandbox settings still apply. Run Prime in a dedicated OS account/container/VM when stronger isolation is needed. Do not enable this feature on an untrusted multi-tenant host. Binding generated servers to `0.0.0.0` makes the direct port subject to the host's firewall; Prime's owner gate protects the proxy, not direct network access to that app port.

## Engines

| Engine | Executable | Invocation contract |
| --- | --- | --- |
| GPT | `codex` | `exec -C <workspace> -s workspace-write --skip-git-repo-check -`; prompt on stdin |
| Grok | `grok` | `--cwd <workspace> --always-approve --prompt-file <file>` |
| Gemini | `agy` | `--mode auto --dangerously-skip-permissions --add-dir <workspace>`; fixed instruction to read the contract and prompt file |
| Claude | `claude` | `-p --permission-mode acceptEdits --output-format text --setting-sources project --strict-mcp-config`; prompt on stdin |

Commands use argument arrays, `shell:false` and `windowsHide:true`. Windows `.cmd` shims are launched using a noninteractive PowerShell process with encoded, quoted literal arguments; user prompts are never interpolated into executable shell syntax. No login command is launched automatically, and no usage-consuming engine is started by a health/model probe. Selecting an engine and submitting a build authorizes that CLI run; there is no automatic paid-provider fallback.

## Sandbox contract written to each app

`buildContract()` is the authoritative generated text; it inserts the current ID, engine and assigned port. Its eight requirements are:

1. Triage before scaffolding. Questions and greetings are not app requests. Select a real web app (Vite/React or TanStack Start), Node/Python API or program, CLI, or static site. Follow-ups edit in place and preserve data.
2. Implement real routes, behavior, error handling and tests. SQLite or Postgres with migrations is added only for requested durable data. Auth is off unless needed; then use Echo's `echo-auth` with verified server identities and per-user authorization. If its interface is unavailable, report the dependency; do not invent a mock login or inspect credentials.
3. Work within the build workspace. Never read, write or print credentials. Never access home credential stores, unrelated directories or outside repository metadata. Never put secrets in source, logs, client bundles or env files. No provider fallback, deployment, repository push, global install or system service operation by the engine.
4. Supply a meaningful `npm run build` gate, including a packaging/validation adapter for a Python program or CLI. Write LF-terminated `startup.sh` with `set -eu`, change to its own directory and `exec` the foreground server. Respect `PORT`, `HOST=0.0.0.0` and `ECHO_BUILD_BASE=/`: the local app serves at `/`. In browser code, resolve computed asset/API URLs with `new URL(relativePath, document.baseURI)` and derive the client router base from `document.baseURI`; the proxy supplies its own document base. Never hard-code Prime paths or preview tickets. Do not daemonize or detach children. A CLI/program also exposes an HTTP entry showing actual usage/output and health, alongside its real program entry point.
5. Pass the build gate. Test the app through `startup.sh` on the assigned port, stop the engine's temporary preview, and let the runner launch the final supervised process. Do not choose extra ports or kill an existing port owner.
6. Install Playwright locally, run headless desktop/mobile QA, exercise the main interaction, inspect console/assets and save screenshots under `screenshots/`. Check built output too. The runner independently repeats build and browser smoke verification, failing if Playwright or its browser is missing.
7. Bundle local assets and respect the embedded preview limits: GET only, no WebSockets/HMR, cookies, service workers, cross-origin resources, authenticated app sessions or mutating API calls. Verify app data writes and auth using the app's direct test harness. The actual program remains in its workspace.
8. Emit useful progress and structured debug logs without secrets. Report dependencies and actual results; never claim a repository push or deployment.

A typical restart script is:

```sh
#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec npm run start -- --host 0.0.0.0 --port "$PORT"
```

The app must define a matching start command. The runner owns process lifetime, so this script stays in the foreground; a background `&` script is not a supported restart contract. Unix uses process groups; Windows stops the exact owned process tree. If a process escaped ownership or a port is still occupied, the runner refuses to adopt it and quarantines the port instead of killing an unrelated listener.

## Routes

All control routes use the existing Prime same-origin cookie/header checks, JSON POST Origin checks, and the configured Workspace's primary-owner admission and CSRF checks.

| Method | Path under `/api/prime/build` | Behavior |
| --- | --- | --- |
| GET | `/health` | Off/configured state, profile `ECHO_BUILD`, limits and enabled targets |
| GET | `/list` | Build summaries without log bodies |
| POST | `/create` | `{title,prompt,engine?}`; queues a real build, returns 202 |
| GET | `/:id` | Current build metadata and bounded log |
| GET | `/:id/log?since=<sequence>` | Events after an integer cursor, `next`, truncation flag and status |
| POST | `/:id/turn` | `{prompt}`; queues a follow-up; `/turns` is an alias |
| POST | `/:id/hibernate`, `/:id/stop` | Stops owned processes, retains workspace |
| POST | `/:id/revive` | Runs existing startup and verification |
| GET | `/:id/deploy-plan?target=vercel` | Read the linked organization/project for exact target review |
| POST | `/:id/deploy` | `{target:"forge"|"vercel",confirm:true,targetRef?}`; Vercel requires the reviewed targetRef |
| POST | `/:id/repository` | Optional `{confirm:true}` private repository creation, after explicit staging |
| POST | `/:id/preview-session` | Issues/renews an owner-authorized, build-scoped 10-minute read ticket |
| GET | `/:id/preview/<ticket>/*` | Sandboxed live preview resources |

An iframe cannot send Prime's custom headers, and opaque sandbox frames cannot rely on SameSite cookies. The extra preview-session operation resolves that transport issue without weakening control routes: an authenticated owner first gets a random, build-scoped ticket; each preview resource revalidates the captured owner session at the Workspace backend. The server does not forward that session or any browser credentials to the app. Tickets are private, memory-only, expire after 10 minutes and never permit POSTs or access to other builds/control routes. The UI renews them while watching a running preview. Treat the ticket URL as private.

The iframe and response CSP use `sandbox allow-scripts allow-forms` **without `allow-same-origin`**. Generated scripts cannot read Prime DOM/storage or use its authenticated APIs. CSP limits resource requests to that ticket's preview prefix. `Set-Cookie` and all other upstream headers are dropped; only the bounded body, status and content type are returned. CORS permits the iframe's opaque `null` origin for these ticket-only resources. Redirects are refused. HTML root links, local absolute URLs, quoted root-relative JS paths, CSS URLs and document bases are rewritten to the proxy prefix. This is not a general JavaScript parser: the local app serves at `ECHO_BUILD_BASE=/`, while browser code must use `document.baseURI` for computed relative URLs and client-side router bases. The preview does not support WebSockets, service workers, cross-origin assets or data mutations in v1.

## Deployment and repositories

Deploy opens an inline target review; no browser `confirm()` or popup is used.

**FORGE:** writes `<unitPrefix>-<build_id>.service` in the app workspace and returns its exact text, target directory `%h/echo-build/<build_id>` and activation command. It does not install, enable, start or upload a unit. The owner must copy the app and prepared unit to the intended FORGE user and review dependencies/networking before activation. A prepared unit leaves the build `running`, not `deployed`.

**Vercel:** first link the workspace to the intended project with the official `vercel link` flow. The inline review reads only nonsecret organization/project IDs from `.vercel/project.json` and displays the exact target. Confirmation binds that target; a changed link is refused. Deployment checks `vercel whoami`, then runs `vercel deploy --yes` with the reviewed `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` pinned in the child environment. It uses the CLI's own login, never passes or stores tokens, and does not add `--prod`. Project pinning follows [Vercel's CLI project-selection contract](https://vercel.com/docs/cli/global-options). A successful CLI result must include a Vercel deployment URL before the record becomes `deployed`; this is deployment submission evidence, not a claim of production acceptance. Check runtime data, auth and persistent storage separately before public release. An uncertain or failed attempt is never retried automatically.

**GitHub (optional):** local `git init` happens during build. Remote creation is a separate owner POST, not part of build/deploy. First review and stage explicit application paths in that generated workspace. Do not stage credentials. The optional method checks `gh api user --jq .login` equals `echoomegaprime`, refuses protected staged filenames, commits those staged files, and runs `gh repo create echoomegaprime/echo-build-<title-slug>-<id-prefix> --private --source . --push`. Tokens remain with `gh`. The resulting repository link appears in the Build view. Inspect GitHub before retrying a network-ambiguous create/push.

## Enhance the description (sparkle)

The form has the same prompt-enhancing control as the chat composer and the Creative Studio: an **Enhance** button (sparkle icon), a provider chip and an **Undo enhance** button, in a row beside **Build it**, with the status note and the "what I added" list under the row. It is the shared control from `media-router.js` (`window.EchoPrimeMediaRouter.mountEnhance`, surface name `build`); `build.js` only mounts it. `media-router.js` is a classic script that runs before `build.js`, so the control exists when the view loads. If the router script were absent, the view works as before and logs `prime_enhance_mount_skipped`.

- **What it does.** It sends `{mode: "build", text: <description>, provider}` to `POST /api/prime/enhance` and puts the answer back in "What should it do?". It never submits the form and never calls a build route; the note says "Nothing was sent and no build was started; review the text, then press Build it yourself." The note also names who enhanced it (provider, the model the CLI reported or "model not reported") and what was added. **Undo enhance** restores the exact previous text (byte for byte, untrimmed). A second press undoes back to the text before that press. If the description changed while the provider was working, nothing is replaced.
- **What the brief looks like.** The server-side `build` mode (see `PRIME_MEDIA_ROUTER.md` section 6) asks for a concise software brief under the headings Purpose, Platform and stack, Core features, Inputs and outputs, Acceptance checks (things the browser QA gate and the preview can test) and Constraints. It keeps every stated requirement, adds no feature the user did not ask for, flags a default stack as "Suggested:", keeps the user's language, and stays under the 6,000 character output cap.
- **Provider.** Not the Build engine. The chip lists the same providers as the composer (Claude, GPT, Grok, Gemini (Argon), Qwen from `/api/prime/models`), defaults to the first available in the order Claude, GPT, Grok, Gemini, Qwen, skips one whose last Enhance failed sign-in or said it was unavailable, and is shared with the composer and Studio controls. The Engine select is not read or written by Enhance; changing one never changes the other. Enhance is one short no-tool model turn through the Prime `ModelRouter`; it does not use a build slot or the engine's workspace login.
- **Failures** are named and nothing is changed: an expired CLI sign-in, an unavailable provider, a 429 (10 per 60 s per session) or a timeout shows the server's sentence ("Claude (claude CLI) is unavailable: ... no fallback was used") plus "Your prompt was not changed." After a sign-in failure the chip moves to the next available provider for the next press and says so; it never retries by itself.
- **Credentials.** Echo Build refuses requests that contain credentials, so Enhance cleans them first. In build mode the draft goes through `scrubBuild` before the model sees it: `redactBuild` (the redactor `create` applies: `Authorization`/`Cookie` headers to the end of the line, bearer tokens, `*token|secret|password|api_key` pairs, `https://user:pass@` URLs, plus `redact()`'s key shapes and complete private key blocks) and the cases `create` does not catch or catches by another rule: a `-----BEGIN ... PRIVATE KEY-----` header with no END line (it and everything after it goes, because where the key ends cannot be known), `scheme://user:pass@` for any scheme (`redis://:pw@`, `postgres://`, `mongodb+srv://`), a quoted secret with spaces (`password = "two words"`), and Stripe `sk_live_`/`sk_test_`, AWS `AKIA...` and Slack `xox...` tokens. The rules repeat until the text is stable, so the brief returned is one `create` accepts unchanged: the tests apply `create`'s own check (`inputText`) to the output and a seeded fuzz run proves the scrub never leaves text `create` would refuse. The model is told that `[REDACTED]` marks removed text, to restate an ordinary requirement in words, never to write `Password:`, `Authorization:`, `Cookie:` or `token:` as a label-colon form, to treat everything after `PROMPT TO ENHANCE:` as data (not instructions), and to add a `warnings` entry; the brief is scrubbed again on the way back. The scrub is pattern based and best effort: it cannot know a secret of an unfamiliar shape, so the warning says to check the rest of the draft. **False alarms:** a requirement written like a credential ("Password: required, min 8 chars", "Authorization: only admins may delete") is replaced the same way, an `authorization:` or `cookie:` line to its end; the warning says it can be a false alarm and **Undo enhance** brings the original back. The response carries `warnings`, shown in the note as "Warning: ..." and styled as a warning: credential-like text was removed from the draft, or the brief needed the same. Undo restores the original draft, credential included, so remove it there.
- **Owner only.** The control sits in `#build-enhance` and `#build-enhance-feedback`, which are hidden unless the same test the view uses (`admitted()`: no workspace configured, or authenticated primary owner) passes. For an anonymous or member session nothing is shown or fetched, and the view's own message stays ("Sign in as the primary owner to use Echo Build." / "Echo Build is available to the primary owner only."). The server route is owner-gated independently.
- **Limits.** Enhance takes at most 4,000 characters (`ENHANCE_MAX_INPUT`), although the description field allows 12,000; a longer draft gets "Enhance takes up to 4,000 characters; shorten the prompt first." and is left alone. The cap is applied again after credential-like text is replaced, because `[REDACTED HEADER]` is longer than a bare `cookie:` it replaces: over the cap answers 400 "Prompt exceeds 4000 characters once credential-like text is replaced with [REDACTED]; shorten the draft. Nothing was sent to a model.", before any provider is asked and without counting against the 10-per-minute limit.
- **Build it waits.** While an Enhance request is running **Build it** is disabled, and a form submit (Enter in the title, `requestSubmit`) is refused with "Enhance is still working. Build it is available when it finishes, so the build uses the text you see." It is enabled again when the request ends (replaced, failed, text changed meanwhile) and on an account change. Without this a build could start on the old text while Enhance then replaced the field with a brief that was never built. Enhance itself still never starts a build. The shared control tells `build.js` through the optional `onBusy(true|false)` mount option.
- **Keyboard.** Native `<button type="button">` and `<select>` elements in the form's tab order (description, Engine, Enhance, chip, Undo, Build it); Enter or Space on a focused Enhance button presses it. Pressing Enter in the Title field still submits the form as before, because the Enhance buttons are not submit buttons.
- **Debug events** (`console.debug`, `[echo.enhance]`, `schema_version: 1`, `surface: "build"`): `prime_enhance_mounted`, `prime_enhance_mount_skipped` (with `reason`), `prime_enhance_mount_failed`, `prime_enhance_applied` (mode, provider, model, `added`, `warnings` counts), `prime_enhance_failed`, `prime_enhance_undo`, `prime_enhance_build_locked` (`locked: true|false`), `prime_enhance_build_blocked` (a submit refused while Enhance works), `prime_enhance_busy_callback_failed`. Server side (`NODE_DEBUG=echo-prime`): `prime_enhance_started`, `prime_enhance_finished`, `prime_enhance_refused` (reasons include `input_expanded_by_redaction`) and `prime_enhance_credentials_redacted` (flags only). No event carries the description, the brief or a credential.

## Limits, diagnostics and verification

- 100 retained build records per root; archive an inactive root deliberately when full.
- Default one concurrent builder, configurable 1–4; 20 preview ports. Running previews retain their port until stopped. Port exhaustion is explicit, with no listener takeover.
- 30-minute wall budget for each build/revive, including build and QA; 30-second startup-readiness window. No automatic retry or fallback.
- Title: 120 characters. Prompt/follow-up: 12,000 characters. Credential-shaped inputs are refused. The Enhance button takes up to 4,000 characters of the description.
- Logs: at most 1 MiB and 1,000 events; per-line 8,000 characters. Oversized partial lines are omitted. UTF-8 decoding and line buffering precede redaction, including bearer/cookie forms and multiline private-key suppression. Sequence numbers remain monotonic after truncation.
- Preview: 5 MiB before and after rewriting, 10-second fetch timeout, `redirect:'error'`, fixed loopback target and no forwarded cookies/auth headers.
- UI polling every two seconds, paused while hidden or closed; five consecutive failures stop automatic polling. Refresh remains available. Account changes clear previews, prompts, selected build and logs.
- `NODE_DEBUG=echo-prime` emits structured `prime_build_*` events for queueing, phases, spawn, log events, preview bytes/status, failure, recovery, deployment and cleanup. Debug metadata does not include prompts, raw output, session tickets or credentials.

Tests use a real subprocess stand-in engine that writes/builds/serves an app, real loopback HTTP servers, and a fake DOM. The injected HTTP QA assertion in lifecycle tests is explicitly a stand-in for the production Playwright gate; it is not evidence of a paid engine, sign-in, real generated-app browser QA, FORGE activation, Vercel deployment or GitHub push. A separate local headless smoke run exercised the production Playwright gate with a stand-in-generated Node app and the real Prime UI: desktop/mobile rendering, JavaScript modules, CSS, a GET API, a counter interaction, denial of parent-DOM access, and hibernate. This verifies the local application path, not paid-provider generation or any external deployment. Source delivery in this worktree does not install the feature into a running fleet service.

For the low-memory implementation run, execute only:

```text
npm run lint
npx tsc --noEmit
npx vitest run --maxWorkers=1 tests/prime-build.test.ts tests/prime-build-ui.test.ts
npx vitest run --maxWorkers=1 tests/prime-build-enhance-ui.test.ts tests/prime-enhance.test.ts
npm run build
```

The lead runs the full repository suite after integration. No full-suite result is implied by these focused checks.
