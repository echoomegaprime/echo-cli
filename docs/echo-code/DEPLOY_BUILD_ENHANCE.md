# Deploy: Enhance button in Echo Build (ECHO Prime)

Scope: Prime only (`echo-prime-web.service` on FORGE, `/home/forge/prime-prod/app`). No Prime config change, no new
environment variable, no secret, no new route, no dependency change (`DEPS=0`), nothing on TEMPER or in the gate. The
change adds a `build` mode to the existing `POST /api/prime/enhance` and mounts the existing Enhance control in the Echo
Build form. Design and rules: `PRIME_BUILD.md` ("Enhance the description") and `PRIME_MEDIA_ROUTER.md` sections 6 and 7.

## What ships

| File | Change |
|---|---|
| `src/prime/enhance.ts` | New mode `build` (`ENHANCE_SYSTEM.build`, `PRESERVE_BUILD`, output contract with `warnings`); build drafts and answers go through `scrubBuild` (a superset of what Echo Build `create` refuses, repeated until stable), the answer is parsed before it is scrubbed; result `warnings` (draft credential, brief credential, model notes, max 5, each saying it can be a false alarm); the system prompt fences the draft as data and bans label-colon credential words; the 4,000-character cap is checked again after the scrub (400, nothing sent, rate limit not charged); mode error message lists `build`; `prime_enhance_credentials_redacted` and `prime_enhance_refused` (`input_expanded_by_redaction`) debug events |
| `src/prime/build.ts` | Export only: `refusesCredentials` (the credential check `create` and `turn` apply, now a named function that `inputText` calls) and `inputText`. No behaviour change; Echo Build still refuses exactly what it refused before |
| `ui/echo-prime/media-router.js` | `ARTICLE.build`; `mountEnhance` options `ariaLabel`, `doneNote` and `onBusy` (defaults unchanged for the composer and Studio); `warnings` shown in the note with `enhance-warn`; `prime_enhance_mounted` debug event |
| `ui/echo-prime/build.js` | Mounts the shared control (`name: 'build'`, `mode: 'build'`) into `#build-enhance` / `#build-enhance-feedback`; both hidden unless the view's own `admitted()` is true; **Build it** is disabled (and a submit refused with a reason) while an Enhance request runs |
| `ui/echo-prime/index.html` | `#build-submit` moves into `div.build-submit-row` with `#build-enhance` before it; `#build-enhance-feedback` after the row |
| `ui/echo-prime/build.css`, `media.css` | Row layout; `.enhance-warn` colour; `.build-form .enhance-provider` restores the chip's pill look that `.build-form select` would otherwise override; `#build-submit` keeps stretching across the column |
| `tests/prime-enhance.test.ts`, `tests/prime-build-enhance-ui.test.ts` | Server tests for the build mode and the credential handling; UI tests for the Echo Build control |
| `docs/echo-code/PRIME_BUILD.md`, `PRIME_MEDIA_ROUTER.md`, `ui/echo-prime/README.md`, this file | Docs |

Base: `9410bae` (live). The change is additive. The other Enhance modes produce byte-identical requests, prompts and
responses (no `warnings` field), and the composer and Studio notes are unchanged.

## Prerequisites (check, do not change)

1. Echo Build is switched on in `/home/forge/prime-prod/prime.prod.json` (a `build` section) and the `models` section is
   configured. Enhance needs `models` only; it does not need `build`. Without `models` the route answers 503 "Prompt
   enhancement is off" and the control stays disabled with that sentence.
2. At least one Enhance provider is signed in (the chip lists them from `/api/prime/models`). Claude and GPT are checked for
   sign-in; an expired CLI login is named and skipped, as in the composer.
3. Gate green on ANVIL (never QUENCH or FORGE): `bash anvil_test.sh buildenh`.
   The gate has no browser: the UI tests run the real scripts against a stand-in DOM and apply the real stylesheets through a
   small cascade stand-in, so layout, real focus and real key presses are proven only by smoke steps 3, 9 and 10. The one
   known ANVIL-only failure, `tests/code-events.test.ts` (a file-mode assertion on the NTFS-backed scratch disk), is unrelated.

## Deploy

Same atomic swap as every Prime release (`deploy_prime.sh <worktree>`): build on ANVIL, ship `dist`, `ui/echo-prime`,
`package.json` and `package-lock.json` to `/home/forge/prime-prod/app.new`, stop `echo-prime-web`, `mv app app.bak-<stamp>`,
`mv app.new app`, start, `systemctl is-active echo-prime-web`, and record the sha in
`/home/forge/prime-prod/RELEASE_SOURCE.txt`. The script keeps the three newest `app.bak-*` directories. The browser picks up
the new `index.html`, `build.js`, `media-router.js` and CSS on the next load (hard-reload an open tab).

## Smoke steps (spend nothing but short model turns; no secret is typed except a fake one)

1. **Service and assets.** On FORGE:

   ```bash
   systemctl is-active echo-prime-web
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: echoomegaprime.com' http://127.0.0.1:8776/            # 200
   for f in index.html build.js media-router.js; do
     curl -s -H 'Host: echoomegaprime.com' http://127.0.0.1:8776/$f | grep -c -E 'id="build-enhance"|mountEnhance\(\{name:.build.|prime_enhance_mounted'
   done                                                                                                        # each prints 1 or more
   curl -s -H 'Host: echoomegaprime.com' http://127.0.0.1:8776/ | grep -o -E 'src="(media-router|build)\.js"'    # media-router.js first, then build.js
   ```

2. **Signed out.** In a private window open `https://echoomegaprime.com`, open Echo Build. Expect "Sign in as the primary owner
   to use Echo Build.", no Enhance button, no sparkle in the form, and no `/api/prime/enhance` or `/api/prime/models` request in
   the network panel.
3. **Owner, plain draft.** Signed in as the primary owner, open Echo Build, type a Title and "a counter app with plus and minus
   buttons" in "What should it do?", press **Enhance**. Expect: the button reads "Enhancing…" and is disabled, then the text
   becomes a brief with Purpose / Platform and stack / Core features / Acceptance checks headings; the note reads "Enhanced by
   <Provider> · <model> · as a build prompt · added N things ... Nothing was sent and no build was started; review the text,
   then press Build it yourself."; **Undo enhance** appears. The builds list does not change and no `/api/prime/build/create`
   request appears. The Engine select is exactly as before. **Look at it** (nothing in the gate renders CSS): the provider chip is the small rounded pill with 10 px text that the chat composer shows, not a full-width dark field like the Engine select; **Build it** still spans the form column (it drops below the Enhance controls when the column is narrow); at a phone width the row wraps without horizontal scrolling.
4. **Undo.** Press **Undo enhance**: the original text is back exactly (including trailing spaces and line breaks) and the note
   says "Restored your original prompt."
5. **Provider choice.** Pick another provider in the chip and press Enhance again: the request body has that `provider`. The
   Engine select did not move.
6. **Credential in the draft (fake values only).** Type "a weather app, api_key=sk-FAKEFAKEFAKEFAKEFAKEFAKE12345" and press Enhance.
   Expect a "Warning: Credential-like text was removed from your draft before it went to the model ... This can be a false alarm ...
   check it for anything sensitive too ... Undo enhance restores your original text." sentence in the note, and the new text does not
   contain `FAKEFAKE` (Echo Build `create` would accept it; do not press **Build it** just for this check, because that starts
   a real engine run). **Undo enhance** brings the fake key back into the field, so remove it there. Repeat with a fake
   `redis://:fakepw123@cache:6379/0`, with `password = "fake two words"` (both words must go) and with a line
   `-----BEGIN PRIVATE KEY-----` followed by a line of made-up base64 and no END line (the header and the text after it must go).
   Check the FORGE journal for `prime_enhance_credentials_redacted` (only with `NODE_DEBUG=echo-prime`); it carries flags, never text.
   **False alarm check:** "a login page. Password: required, min 8 chars." must also produce the warning (with `Password: [REDACTED]`
   in what the model saw), and the warning must say it can be a false alarm; Undo gets the sentence back.
   **Cap check:** a draft of 400 lines of `cookie: a` (4,000 characters) answers "Prompt exceeds 4000 characters once credential-like
   text is replaced with [REDACTED] ..." and leaves the text alone.
7. **Honest failure.** If a provider is signed out, pick it and press Enhance: the sentence names it ("... Failed to
   authenticate ... no fallback was used. Your prompt was not changed."), the text is untouched, and the chip moves to the next
   available provider for the next press. Nothing is retried by itself.
8. **API shape (optional, from the signed-in browser console).**

   ```js
   await fetch('/api/prime/enhance',{method:'POST',credentials:'same-origin',
     headers:{'x-prime-request':'1','content-type':'application/json',...(await EchoPrimeWorkspace.ownerHeaders())},
     body:JSON.stringify({mode:'build',text:'a counter app with plus and minus buttons',provider:'claude'})}).then(r=>r.json())
   ```

   Expect `mode: "build"`, `text` as a structured brief, `provider`, `providerLabel`, `model`, no `warnings` for this draft. Mode
   `"deploy"` answers 400 "Invalid enhance mode; use chat, image, video, music, sfx, voice, build or auto".
9. **Build it waits.** Type a title and a description, press Enhance and, while the button reads "Enhancing…", look at **Build it**:
   it is disabled, and pressing Enter in the Title field does nothing but show "Enhance is still working. Build it is available when
   it finishes ...". When the note says "Enhanced by ...", **Build it** is enabled again and no build was started in between.
10. **Keyboard.** Tab through the form: description, Engine, **Enhance**, the provider chip, **Undo enhance** (once visible), **Build it**.
   Space and Enter on the focused Enhance button each press it; Enter in the Title field submits nothing while Enhance works and
   starts no enhancement. The focus ring is visible on each control. Paste text with Windows (CRLF) line breaks, press Enhance and then
   Undo: the field shows the same lines as before (a browser reports CRLF as LF, so the restored text is what the field showed).
11. **Other surfaces unchanged.** The composer Enhance and the Studio Enhance still work and still end their note with "Nothing was
   sent; review and press Send yourself."

Pass: steps 2 to 4 behave as stated (including the look of the chip and of Build it in step 3), step 6 shows the warning and no
credential in the result, step 7 names the provider and leaves the text alone, steps 9 and 10 behave as stated, and step 11 shows no
change.

## Rollback

`deploy_prime.sh` keeps the previous release as `app.bak-<stamp>`. To go back:

```bash
ssh forge "cd /home/forge/prime-prod && ls -d app.bak-* | sort | tail -1"   # newest backup = the pre-deploy release
ssh forge "cd /home/forge/prime-prod && sudo systemctl stop echo-prime-web && rm -rf app && mv app.bak-<stamp> app && sudo systemctl start echo-prime-web && systemctl is-active echo-prime-web"
```

Nothing is persisted by this change (the Undo state lives in the page and resets on reload and on every account change;
the server keeps only its existing per-session rate-limit counters and the per-provider failure memory in memory), so rolling
back leaves nothing behind. A page that is still open keeps running the new `build.js`; reload it. The rollback removes the
`build` mode on the server, so an old tab's Enhance press in Echo Build then answers 400 "Invalid enhance mode" and shows that
sentence without changing the text.
