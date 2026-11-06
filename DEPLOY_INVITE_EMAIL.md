# Deploy: emailed member invitations, Prime side (side 3)

Scope: the **Echo Prime** half of the invite-email contract (`docs/echo-code/PRIME_MEMBERS_CONTRACT.md`, section "Emailed invitations"). Prime asks the Workspace to email the invitation and reports exactly what happened. echo-auth (side 1) sends the mail through Resend and the Workspace (side 2) calls echo-auth with the owner's session; both have their own deploy notes. Nothing here has been deployed.

## What changes at runtime

| Piece | Behavior |
|---|---|
| Members view, Invite card | New "Email the invitation" checkbox (checked by default). Create posts `{"email","send_email":true|false}`. The answer shows "Invitation emailed to <address>" or the exact failure, always with the copy-link fallback. |
| Invite list | Every active row gets a Resend button (posts `{"invite_id"}` to `/api/workspace/auth/invite/resend`, no confirm card, shows its result in place). |
| Prime proxy (`src/prime/workspace.ts`) | `/api/auth/invite/resend` is allowlisted and primary-owner-only like the other invite writes; siblings stay 404. A Workspace `429` also relays `Retry-After` (plain seconds only). |
| Browser transport (`workspace-client.js`) | A `429` error carries `retryAfter` seconds (body `retry_after`, else the `Retry-After` header). |

## Environment and configuration

Prime needs **no new environment variables, config keys, secrets or files**. It never sees the mailer, the Resend key or any echo-auth token (the Workspace calls echo-auth server-side with the owner's own session).

What the feature depends on, set on the other sides (names only; values live in the vault or the service environment, never in this repo):

- echo-auth: `ECHO_AUTH_INVITE_SENDER_UIDS` (comma list of echo-auth uids allowed to send; must include the primary owner's uid; empty = feature off, answered as `mail_unavailable`), `ECHO_AUTH_INVITE_URL_ORIGINS` (default `https://echoomegaprime.com`), and the mailer's existing Resend API key and from-address settings (see echo-auth `mailer.py`).
- Workspace: the build that accepts `send_email` and serves `POST /api/auth/invite/resend`.

## Files (this change)

Runtime (what `deploy_prime.sh` ships: `dist` built from `src`, plus `ui/echo-prime`):

- `src/prime/workspace.ts` (builds to `dist/prime/workspace.js`)
- `ui/echo-prime/workspace.js`
- `ui/echo-prime/workspace-client.js`
- `ui/echo-prime/styles.css`

Docs and tests (not shipped): `docs/echo-code/PRIME_MEMBERS_CONTRACT.md`, `DEPLOY_INVITE_EMAIL.md`, `tests/prime-members-ui.test.ts`, `tests/prime-workspace-allowlist.test.ts`, `tests/prime-workspace.test.ts`.

## Deploy order

1. echo-auth (env + restart), 2. Workspace, 3. Prime (this build).

Prime can safely go first or alone: an older Workspace ignores `send_email` and has no resend route, so the card says "The Workspace did not report an email result" and offers the copy-link fallback, and Resend shows whatever refusal the old Workspace gives for an unknown route. Nothing breaks and nothing is sent.

Deploy with the existing atomic swap (needs `npm run build` green):

```
bash deploy_prime.sh <prime worktree>     # stops echo-prime-web, swaps /home/forge/prime-prod/app, keeps 3 app.bak-<stamp>
```

## Smoke (after all three sides are live)

1. `curl -s -o /dev/null -w '%{http_code}\n' https://echoomegaprime.com/` returns 200 and `systemctl is-active echo-prime-web` says `active`.
2. Anonymous or member: `POST /api/workspace/auth/invite/resend` with `{}` is refused (401/403), never forwarded. A sibling such as `/api/workspace/auth/invite/resent` is 404.
3. Sign in as the primary owner, open Members. The Invite card shows "Email the invitation", ticked.
4. Create an invite for a mailbox you control with the box ticked. Expect "Invitation emailed to <address>", the link and message still shown, and the mail in the inbox (sender and link come from echo-auth; the link is `https://echoomegaprime.com/#invite`). If you see "Mail is not set up", echo-auth has no sender uid or no Resend key: fix there, the invite itself is fine.
5. Press Resend on that row. Expect "Invitation emailed to <address>" again and a second mail. Repeating past the limits (20 per hour per sender, 3 per day per recipient) must show "Too many invitations, try again in N min" with the copy-link fallback.
6. Untick the box, create an invite for another address: no mail line, the old "Share the link and message yourself." text, and no mail sent.
7. Existing behavior still holds: creating an invite for an address that already has an account shows the 409 text with "Open member"; Revoke still asks for confirmation.

## Rollback

Prime has no data, schema or config change, so rollback is only the code swap:

```
ssh forge "cd /home/forge/prime-prod && sudo systemctl stop echo-prime-web && rm -rf app && mv app.bak-<stamp> app && sudo systemctl start echo-prime-web"
```

After rollback the checkbox and Resend button disappear and the card goes back to copy-link only. Invites already created stay valid (the Workspace owns them) and still appear in the list; revoke any you do not want. An email that was already sent cannot be recalled. To switch emailing off without touching Prime, empty `ECHO_AUTH_INVITE_SENDER_UIDS` on echo-auth: the card then reports "Mail is not set up" and the copy-link fallback keeps working.

## Verification (ANVIL, `anvil_test.sh inviteprime`)

See the commit message and the return notes for the gate output (lint, tsc, vitest, build). The tests use synthetic Workspace answers only; no test reaches a real mailer or sends an email.
