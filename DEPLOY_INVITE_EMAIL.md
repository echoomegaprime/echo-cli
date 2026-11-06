# Deploy: emailed member invitations, Prime side (side 3)

Scope: the **Echo Prime** half of the invite-email contract (`docs/echo-code/PRIME_MEMBERS_CONTRACT.md`, section "Emailed invitations"). Prime asks the Workspace to email the invitation and reports exactly what happened. echo-auth (side 1) sends the mail through Resend and the Workspace (side 2) calls echo-auth with the owner's session; both have their own deploy notes. Nothing here has been deployed.

## What changes at runtime

| Piece | Behavior |
|---|---|
| Members view, Invite card | New "Email the invitation" checkbox (checked by default; an owner who unticks it keeps it unticked through every reload of Members until another account signs in). Create posts `{"email","send_email":true|false}`. The answer shows "Invitation emailed to <address>" or the exact failure, always with the copy-link fallback. |
| Invite list | Every active row gets a Resend button (posts `{"invite_id"}` to `/api/workspace/auth/invite/resend`, no confirm card, shows its result in place). If the Workspace refuses the resend (404 unknown, 409 used, revoked, expired, banned or already an account) the card shows that refusal only, with no link to share, and the invite list is read again. |
| Prime proxy (`src/prime/workspace.ts`) | `/api/auth/invite/resend` is allowlisted and primary-owner-only like the other invite writes; siblings stay 404. Nothing else changes: no header is added or relayed. |
| Browser transport (`workspace-client.js`) | A `429` error carries `retryAfter` seconds from the JSON body's `retry_after` (defensive: the real Workspace reports a rate-limited mail inside a normal `200`). |

## Environment and configuration

Prime needs **no new environment variables, config keys, secrets or files**. It never sees the mailer, the Resend key or any echo-auth token (the Workspace calls echo-auth server-side with the owner's own session).

What the feature depends on, set on the other sides (names only; values live in the vault or the service environment, never in this repo):

- echo-auth: `ECHO_AUTH_INVITE_SENDER_UIDS` (comma list of echo-auth uids allowed to send; must include the primary owner's uid; empty = feature off, answered as `mail_unavailable`), `ECHO_AUTH_INVITE_URL_ORIGINS` (default `https://echoomegaprime.com`), and the mailer's existing Resend API key and from-address settings (see echo-auth `mailer.py`).
- Workspace: the build that accepts `send_email` and serves `POST /api/auth/invite/resend`.

## Files (this change)

Runtime (what is shipped: `dist` built from `src`, plus `ui/echo-prime`):

- `src/prime/workspace.ts` (builds to `dist/prime/workspace.js`)
- `ui/echo-prime/workspace.js`
- `ui/echo-prime/workspace-client.js`
- `ui/echo-prime/styles.css`

Docs and tests (not shipped): `docs/echo-code/PRIME_MEMBERS_CONTRACT.md`, `DEPLOY_INVITE_EMAIL.md`, `tests/prime-members-ui.test.ts`, `tests/prime-workspace-allowlist.test.ts`, `tests/prime-workspace.test.ts`.

`package.json` and `package-lock.json` are unchanged, so the installed `node_modules` is reused.

## Deploy order

1. echo-auth (env + restart), 2. Workspace, 3. Prime (this build).

Prime can safely go first or alone: an older Workspace ignores `send_email` and has no resend route, so the card says "The Workspace did not report an email result" and offers the copy-link fallback, and Resend shows whatever refusal the old Workspace gives for an unknown route (its 404 reads as a refusal: the list is read again and nothing is sent). Nothing breaks and nothing is sent.

## Deploy (builds run on ANVIL, never on QUENCH or FORGE)

The QUENCH worktree has no `dist`; the gate builds it on ANVIL. The two shell helpers the operator uses (`deploy_prime.sh`, `deploy_tgz.sh`) are not part of this repository, so the steps they perform are written out here. They need the ANVIL build of exactly this commit.

1. In the worktree, note the commit: `SHA=$(git rev-parse --short HEAD)`. Run `anvil_test.sh inviteprime` and require lint and tsc to print nothing, `BUILD_DONE`, and a green vitest. Known ANVIL-only exception: `tests/code-events.test.ts` fails a file-mode assertion (0o755 vs 0o600) on the ANVIL scratch disk; that test is not touched by this change. The build is left in the ANVIL mirror `/mnt/anvil_scratch/prime-build/wt-inviteprime` (`dist`, `ui/echo-prime`, `package*.json`).
2. Package it on ANVIL and put the tarball on FORGE:
   ```
   ssh anvil "cd /mnt/anvil_scratch/prime-build/wt-inviteprime && tar czf - dist ui/echo-prime package.json package-lock.json" | ssh forge "cat > /tmp/prime-$SHA.tgz"
   ```
3. Note what is live now (needed for rollback), then swap atomically. Replace `<sha>` with `$SHA`:
   ```
   ssh forge "cd /home/forge/prime-prod && cat RELEASE_SOURCE.txt && ls -d app.bak-* | tail -n 3"
   ssh forge "set -e; cd /home/forge/prime-prod; STAMP=\$(date -u +%Y%m%dT%H%M%SZ); rm -rf app.new; mkdir app.new; tar xzf /tmp/prime-<sha>.tgz -C app.new; cp -a app/node_modules app.new/node_modules; sudo systemctl stop echo-prime-web; mv app app.bak-\$STAMP; mv app.new app; echo <sha> > RELEASE_SOURCE.txt; sudo systemctl start echo-prime-web; sleep 4; systemctl is-active echo-prime-web; curl -s -o /dev/null -w 'loopback GET / %{http_code}\n' -H 'Host: echoomegaprime.com' http://127.0.0.1:8776/; echo backup=app.bak-\$STAMP"
   ssh forge "cd /home/forge/prime-prod && ls -d app.bak-* | sort | head -n -3 | xargs -r rm -rf; rm -f /tmp/prime-<sha>.tgz"
   ```
   The last line keeps the three newest backups. Prime is down for the few seconds between the stop and the start; the Workspace is not touched.

## Smoke (after all three sides are live)

1. `curl -s -o /dev/null -w '%{http_code}\n' https://echoomegaprime.com/` returns 200 and `systemctl is-active echo-prime-web` says `active`.
2. Anonymous or member: `POST /api/workspace/auth/invite/resend` with `{}` is refused (401/403), never forwarded. A sibling such as `/api/workspace/auth/invite/resent` is 404.
3. Sign in as the primary owner, open Members. The Invite card shows "Email the invitation", ticked.
4. Create an invite for a **mailbox you control** with the box ticked. Expect "Invitation emailed to <address>", the link and message still shown, and the mail in the inbox (sender and link come from echo-auth; the link is `https://echoomegaprime.com/#invite`). The invite itself is fine in every failure case below; the card keeps the copy-link fallback. What the owner reads, and what to fix:

   | The card says | Cause and fix |
   |---|---|
   | Mail is not set up | echo-auth has no sender uid or no Resend key, **or** the provider failed (echo-auth answers both as `mail_unavailable`): check `GET /v1/mail/health` on echo-auth |
   | Your account is not allowed to send invitations | the owner's uid is missing from `ECHO_AUTH_INVITE_SENDER_UIDS` (Workspace reported `http_403`) |
   | Sign out and back in, then try again | the owner's Workspace session holds no echo-auth token or it expired (`session_unavailable` / `http_401`): sign out and in once |
   | The identity service did not answer; the invitation may not have been sent | the Workspace's 15 s call to echo-auth timed out (`identity_unreachable`): look in the inbox before pressing Resend |
   | The identity service refused the request (HTTP n) / had a problem (HTTP n) | echo-auth answered another status (for example 404 before side 1 is deployed) |
   | The Workspace has no invite link set up for email | the Workspace has no public origin or `invite_url_origin` configured |
   | The Workspace did not report an email result | the Workspace predates side 2: deploy it |

5. Press Resend on that row. Expect "Invitation emailed to <address>" again and a second mail. **This sends real mail.** Optional, only if you want to see the limit: press Resend twice more. The third mail to the same address is the last one allowed that day (per recipient 3 a day, per sender 20 an hour); the next press must show "Too many invitations, try again in N min" with the copy-link fallback. Doing this uses up that address's quota for 24 hours, so use a throwaway mailbox, never a real invitee's address, and skip the optional presses if you do not need to see the limit.
6. Refused resend: open Members in two tabs with an active invite showing in both. In the second tab revoke it. In the first tab (still showing it as active) press Resend. The card must show "Nothing was sent to <address>." and the Workspace's refusal (for example "This invite was revoked."), with no link or message to share, and that row's Resend button must be gone once the list is read again.
7. Untick the box, create an invite for another address you control: no mail line, the old "Share the link and message yourself." text, and no mail sent. Create a second invite and confirm the box is still unticked.
8. Existing behavior still holds: creating an invite for an address that already has an account shows the 409 text with "Open member"; Revoke still asks for confirmation.

## Rollback

Prime has no data, schema or config change, so rollback is only the code swap. Use the backup stamp printed by the deploy step (`backup=app.bak-<stamp>`) and the commit noted in step 3 of the deploy:

```
ssh forge "cd /home/forge/prime-prod && sudo systemctl stop echo-prime-web && mv app app.failed-<stamp> && mv app.bak-<stamp> app && echo <previous sha> > RELEASE_SOURCE.txt && sudo systemctl start echo-prime-web && sleep 4 && systemctl is-active echo-prime-web"
```

`app.failed-<stamp>` is kept for inspection; delete it by hand when it is no longer needed. After rollback the checkbox and Resend button disappear and the card goes back to copy-link only. Invites already created stay valid (the Workspace owns them) and still appear in the list; revoke any you do not want. An email that was already sent cannot be recalled. To switch emailing off without touching Prime, empty `ECHO_AUTH_INVITE_SENDER_UIDS` on echo-auth: the card then reports "Mail is not set up" and the copy-link fallback keeps working.

## Verification (ANVIL, `anvil_test.sh inviteprime`)

See the commit message and the return notes for the gate output (lint, tsc, vitest, build). The tests use synthetic Workspace answers only; no test reaches a real mailer or sends an email.
