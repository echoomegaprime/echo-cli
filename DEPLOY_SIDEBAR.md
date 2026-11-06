# Deploy note: Echo controls rail (right sidebar)

Base `9410bae` (live). This change is UI only: the Workspace backend, `media.ts`, the API routes and the Content-Security-Policy are untouched. It was not deployed from the build session.

## What ships

The mode chips, model and personality pickers, voice controls and context meter move from the composer area into one right-hand rail with five collapsible cards. See "Echo controls rail" in `ui/echo-prime/README.md` for behaviour.

## Files changed

| File | Change |
|---|---|
| `ui/echo-prime/index.html` | New `#echo-rail` aside, `#rail-scrim`, `#rail-toggle` in the top bar, four icon symbols, `rail.css` link, classic `rail.js` script in `<head>`. The mode chips and "Connect Echo systems" move into the Mode card; the empty `.composer-toolbar` is gone. |
| `ui/echo-prime/rail.js` (new) | Docked or drawer visibility, card collapse, remembered state (try/catch storage), empty-card hiding. |
| `ui/echo-prime/rail.css` (new) | All rail styling, scoped to `#echo-rail`, dark and light tokens, docked and drawer layouts. |
| `ui/echo-prime/models.js`, `brain.js` | Mount into `#rail-model-slot` / `#rail-personality-slot` (old mount point kept as fallback); the Gemini caption hides with its select. |
| `ui/echo-prime/composer.js` | Context meter mounts into `#rail-context-slot`; percentage clamps to 0-100; `data-level` and `aria-valuetext` on the bar; `meterLevel` exported. |
| `ui/echo-prime/voicebar.js`, `speech.js` | Mount into `#rail-voice-slot` (dock first, bar second); option checkboxes are `role="switch"` with `aria-checked`; voice pill carries `data-state`. |
| `src/prime/server.ts` | Two static-asset entries, `/rail.js` and `/rail.css`, in the `assets` table. Nothing else. |
| `tests/prime-rail-ui.test.ts` (new) | 18 tests: markup, mounting, collapse memory, drawer, switches, meter, contrast, stylesheet. |
| `tests/prime-chatfix-ui.test.ts` | Four assertions now look for the pickers in the rail slots instead of `.composer-toolbar` (old location). |
| `ui/echo-prime/README.md`, `DEPLOY_SIDEBAR.md` | Documentation. |

The server must be rebuilt and restarted because `server.ts` changed: the static `ui/echo-prime` files alone are not enough, or `/rail.js` and `/rail.css` answer 404.

## Deploy (when the Commander approves)

Same atomic swap as earlier Prime releases: build in the worktree, package `dist ui/echo-prime package.json package-lock.json`, unpack to `/home/forge/prime-prod/app.new`, stop `echo-prime-web`, move `app` to `app.bak-<UTC stamp>`, move `app.new` to `app`, start `echo-prime-web` (port 8776). No dependency change, so `node_modules` is copied across.

## Verify on https://echoomegaprime.com after deploy

1. `curl -sI https://echoomegaprime.com/rail.js` and `/rail.css` return `200`, with `text/javascript` and `text/css`. A `404` means the old `dist` is still running.
2. Hard-reload signed in at 1440 px wide. The rail is docked on the right with Mode, Model, Personality, Voice and Context; the conversation column is narrower; the composer is intact and the mode chips are no longer above it.
3. Mode: Auto, Chat, Image, Video, Music, Sound FX, Voice switch as before; "Connect Echo systems" opens the Echo systems dialog.
4. Model shows `Qwen (FORGE, 256K)` and its helper line; choosing Argon shows the Gemini model select; the choice persists after reload.
5. Personality shows `Personality: auto (by task)`, the `Personality: on` switch and its helper line; the switch flips auto-selection as before.
6. Voice shows `Echo's voice · M Freeman · ElevenLabs` with a green dot, Mute Echo, Device voice, Conversation mode, Interrupt & speak, Stop voice, Spoken replies, Brief speech, Send speech automatically, `Spoken: N`, the status line and the Personality Forge footer. Send a message: Echo speaks, the counter rises, Mute silences the next reply.
7. Context shows `N / 262,144 · x.x% · estimate` with a bar; it turns amber from 70% and red from 90%.
8. Click a card header: it collapses and `aria-expanded` flips. Reload: it stays collapsed. Click the top-bar rail button: the rail hides and the column widens; reload keeps it hidden.
9. Narrow the window below 1100 px (or open on a phone): the rail becomes a drawer opened by the same button; focus moves into it, Escape closes it and focus returns to the button.
10. Browser console: no Content-Security-Policy violation and no new errors.

## Rollback

Restore the previous release directory (the swap keeps the last three):

```
ssh forge "cd /home/forge/prime-prod && sudo systemctl stop echo-prime-web && rm -rf app && mv app.bak-<stamp> app && sudo systemctl start echo-prime-web"
```

Nothing else needs undoing. Browsers that visited the new page keep a harmless `echo-prime-rail-v1` entry in localStorage; the old page ignores it.
