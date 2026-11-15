# Deploy note: Echo controls rail (right sidebar)

Base `9410bae` (live). This change is UI only: the Workspace backend, `media.ts`, the API routes and the Content-Security-Policy are untouched. It was not deployed from the build session.

## What ships

The mode chips, model and personality pickers, voice controls and context meter move from the composer area into one right-hand rail with five collapsible cards. See "Echo controls rail" in `ui/echo-prime/README.md` for behaviour.

## Files changed

| File | Change |
|---|---|
| `ui/echo-prime/index.html` | New `#echo-rail` aside, `#rail-scrim`, `#rail-toggle` in the top bar, four icon symbols, `rail.css` link, classic `rail.js` script in `<head>`. The mode chips and "Connect Echo systems" move into the Mode card; the empty `.composer-toolbar` is gone. No card carries a static `hidden` (a failed `rail.js` cannot strand the voice controls). |
| `ui/echo-prime/rail.js` (new) | Docked or drawer visibility (docked only while the navigation leaves 520px for the conversation; sets `html.rail-squeezed` otherwise), card collapse, remembered state (try/catch storage), empty-card hiding, drawer hand-over to dialogs and the prompt. |
| `ui/echo-prime/rail.css` (new) | All rail styling, scoped to `#echo-rail`, dark and light tokens. The drawer is the base layout; docking is opt-in at 1100px and wider and every docked rule carries `:not(.rail-squeezed)`. Empty cards are hidden in CSS. |
| `ui/echo-prime/models.js`, `brain.js` | Mount into `#rail-model-slot` / `#rail-personality-slot` (old mount point kept as fallback); the Gemini caption hides with its select. The personality toggle is `role="switch"` with `aria-checked`. |
| `ui/echo-prime/composer.js` | Context meter mounts into `#rail-context-slot`; percentage clamps to 0-100; `data-level` and `aria-valuetext` on the bar; `meterLevel` exported. |
| `ui/echo-prime/voicebar.js`, `speech.js` | Mount into `#rail-voice-slot` (dock first, bar second); option checkboxes, Mute and Conversation mode are `role="switch"` with `aria-checked`; Mute keeps one name ("Mute Echo") and is on while muted; voice pill carries `data-state`. |
| `ui/echo-prime/speech.css`, `ui/echo-prime/fleet.css` | `speech.css`: fallback highlight also follows `aria-checked`. `fleet.css`: the `.composer-toolbar` rules (dead since the toolbar left the markup) are removed. |
| `src/prime/server.ts` | Two static-asset entries, `/rail.js` and `/rail.css`, in the `assets` table. Nothing else. |
| `tests/prime-rail-ui.test.ts` (new) | 27 tests: markup, mounting, collapse memory, drawer, dialog and prompt hand-over, navigation-width docking, served assets (`/rail.js`, `/rail.css` through a real `startPrimeServer`), switches, meter, contrast (tokens and the top-bar button), stylesheet structure. |
| `tests/prime-chatfix-ui.test.ts` | Four assertions now look for the pickers in the rail slots instead of `.composer-toolbar` (old location). |
| `tests/prime-speech.test.ts` | Four assertions updated for the switch semantics: Mute keeps its name and `aria-checked` carries the state; Conversation mode is `role="switch"` with `aria-checked`. |
| `tests/fixtures/prime-fake-dom.ts` | `style.getPropertyValue`, so tests can read the `--sidebar-width` custom property. |
| `ui/echo-prime/README.md`, `DEPLOY_SIDEBAR.md` | Documentation. |

The server must be rebuilt and restarted because `server.ts` changed: the static `ui/echo-prime` files alone are not enough, or `/rail.js` and `/rail.css` answer 404. If the new UI ever runs on the old `dist`, the rail shows unstyled under the conversation but every control, including Mute and Stop voice, is still on the page (no card is statically hidden); check step 1 below before anything else.

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
9. Narrow the window below 1100 px (or open on a phone): the rail becomes a drawer opened by the same button; focus moves into it, Escape closes it and focus returns to the button. In the drawer, a mode chip closes it and puts the cursor in the prompt; "Connect Echo systems" closes it and opens the dialog, and closing the dialog (Escape) puts focus on the rail button.
10. At 1100-1280 px wide, drag the navigation wider (it goes up to 480 px): once `viewport - navigation` is under 840 px the docked rail turns into a closed drawer and the conversation keeps its width; drag it back and the rail docks again.
11. Mute is a switch named "Mute Echo": it turns on (amber) while muted and the name never changes; Conversation mode and `Personality: on` are switches too.
12. Browser console: no Content-Security-Policy violation and no new errors.

## Rollback

Restore the previous release directory (the swap keeps the last three):

```
ssh forge "cd /home/forge/prime-prod && sudo systemctl stop echo-prime-web && rm -rf app && mv app.bak-<stamp> app && sudo systemctl start echo-prime-web"
```

Nothing else needs undoing. Browsers that visited the new page keep a harmless `echo-prime-rail-v1` entry in localStorage; the old page ignores it.
