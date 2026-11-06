# Echo Prime member management: contract (v1, 2026-11-06; v1.1 adds emailed invitations, see the last section)

The owner (the site's primary owner, `auth.owner_uids` in the Workspace config and `workspace.ownerUid` in Prime) gets a **Members** view to select and view members, see each member's usage, and Kick, Ban, Unban, Approve, Deny or Invite. Everything is owner-only, CSRF-checked and audited. No route returns or logs message, chat, upload or transcript content, tokens or cookies.

## Statuses (Workspace `users.status`)

| Status | Meaning | Sign-in | Requests |
|---|---|---|---|
| `pending` | signed up, waiting for the owner | session created | 403 except `/api/auth/*` (unchanged) |
| `approved` | member | session created | allowed (own tenant only) |
| `denied` | application refused (unchanged) | session created | 403 except `/api/auth/*` (unchanged) |
| `banned` | **new.** Removed by the owner | **refused before any session is created**: `403 {"error":"Workspace access is unavailable."}` | any surviving session is dropped and refused (401) |

Owners are immune: every decision on an owner uid, or on the acting owner's own uid, is `400 {"error":"Owner accounts cannot be changed here."}`.

## Workspace backend (ws-src, Python stdlib)

New tables in `identity/accounts.sqlite3` (CREATE TABLE IF NOT EXISTS; the `users` table is not altered):
- `bans(uid TEXT PRIMARY KEY, email_sha256 TEXT NOT NULL, created REAL NOT NULL, actor TEXT NOT NULL)`. `email_sha256` = sha256 hex of the casefolded, stripped email; `actor` = `Accounts.key(owner uid)`.
- `invites(id TEXT PRIMARY KEY, email_lower TEXT NOT NULL, email_sha256 TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, actor TEXT NOT NULL, used_at REAL, used_tenant TEXT, revoked_at REAL)`. `id` = `secrets.token_urlsafe(16)`. Expiry 14 days.
- `activity(uid TEXT PRIMARY KEY, last_login REAL, last_seen REAL, login_count INTEGER NOT NULL DEFAULT 0)`.

Admission (`admit_identity`, before the existing INSERT OR IGNORE):
1. If the uid is in `bans`, or the verified email's sha256 is in `bans`, the row is (inserted as or set to) `banned`, and `login()` raises `AuthError('Workspace access is unavailable.', 403)` before a session exists. Audit `login` / `rejected` / `admission='banned'` (no email, no uid).
2. Otherwise, for a non-owner whose row is new or still `pending`, an active invite (not used, not revoked, not expired) whose `email_sha256` equals the verified email's sha256 sets status `approved`, marks the invite used (`used_at`, `used_tenant`) in the same transaction, and audits `operation='account_decision', status='approved', via='invite'`. An invite never sets a role and never overrides a ban, a `denied` status or an `approved` status.
3. `login()` success bumps `activity.last_login` and `login_count`. `resolve()` success bumps `activity.last_seen`, throttled to one write per uid per 60 s.
4. `resolve()` drops and refuses (returns None) a session whose row is `banned` (defense in depth).

`Accounts.revoke_user(uid) -> int`: under the lock, pop every `self.sessions` entry whose uid matches; outside the lock call `self.provider.logout(session)` best-effort for each (revokes that session's echo-auth refresh token). Returns the count.

Routes (all owner-only exactly like today's `/api/auth/accounts` and `/api/auth/decide`: session required, owner re-read and approved, Origin + CSRF on POST). Business refusals are 400/404/409, never 403 (a 403 clears the owner's page identity in Prime's client).

- `GET /api/auth/accounts` (existing, extended). Response `{"accounts":[row...], "counts":{"pending":n,"approved":n,"denied":n,"banned":n}, "truncated":bool}`. Every non-owner account, newest first, limit 500. Each row keeps today's fields (`uid, tenant, email, role, status, created`) and adds `updated, active_sessions (int, live RAM sessions), last_login (number|null), last_seen (number|null), login_count (int), banned_at (number|null), via_invite (bool)`.
- `POST /api/auth/decide` (existing, extended) body `{"uid":"...","decision":"approve"|"deny"|"kick"|"ban"|"unban"}`.
  - `approve` / `deny`: unchanged, except a `banned` target is `400 {"error":"Unban this account first."}`.
  - `kick`: `revoke_user(uid)`; status unchanged (the member can sign in again). Response `{"user":{...},"revoked":n}`. Audit `account_decision` / `kicked` / `count=n`.
  - `ban`: in one transaction set status `banned` and insert the `bans` row; then `revoke_user(uid)`; also consume that uid's open Telegram notices. Response `{"user":{...status:"banned"},"revoked":n}`. Audit `account_decision` / `banned` / `count=n`. Banning an already banned account is `409 {"error":"This account is already banned."}`.
  - `unban`: delete the `bans` row and set status `approved`. A non-banned target is `409 {"error":"This account is not banned."}`. Response `{"user":{...}}`. Audit `account_decision` / `unbanned`.
  - Unknown uid: `404 {"error":"Account not found."}`. Unknown decision: `400`.
- `POST /api/auth/usage` body `{"uid":"..."}` -> aggregates only, cached 60 s per uid:
  ```json
  {"uid":"...","generated_at":1730000000,"cached":false,
   "sign_in":{"first_seen":..,"last_login":..|null,"last_seen":..|null,"login_count":n,"active_sessions":n},
   "workspace":{"exists":true,"chats":n,"projects":n,"messages_sent":n,"chars_sent":n,"replies":n,"reply_chars":n,
     "imported_messages":n,"library_items":n,"tool_calls":{"<tool>":n},"answer_seconds":n,
     "model_prompt_tokens":n,"model_completion_tokens":n,"tokens_approximate":true,"last_activity":..|null,"storage_bytes":n},
   "unavailable":["voice","media","swarm","agents","bots","build","sdk","web_search","esh"]}
  ```
  Read the member's store at `data/users/<tenant>/workspace.sqlite3` with `?mode=ro`, only if it exists (`"exists":false` and zeros otherwise). Never instantiate `Application`/`Store` for this (that creates empty tenant roots). Never read message text into the response: use `count`, `length()` and `json_extract` on numeric fields only. `tool_calls` = top 10 by count. `storage_bytes` = on-disk size of `data/users/<tenant>/` (0 if absent).
- `GET /api/auth/invites` -> `{"invites":[{"id","email","status":"active"|"used"|"expired"|"revoked","created","expires","used_at"|null}]}` newest first, limit 200.
- `POST /api/auth/invite` body `{"email":"..."}` -> `201 {"invite":{...},"existing":false}`. A valid email is required (`400 {"error":"Enter a valid email address."}`). If an active invite for that email exists, return it with `200 ... "existing":true`. If an account with that email already exists: `409 {"error":"That email already has an account (<status>).","uid":"..."}` so the UI can jump to it. A banned email is `409 {"error":"That email is banned. Unban the account first."}`. Audit `invite` / `created` (hashed fields only).
- `POST /api/auth/invite/revoke` body `{"id":"..."}` -> `{"invite":{...status:"revoked"}}`; unknown id 404; already used 409. Audit `invite` / `revoked`.

Telegram (`telegram_decisions.py`): `resolve()` treats `banned` like `approved`/`denied` (already decided, `already:true`, no change). Banned users are never offered in `claim()` (they are not `pending`).

Audit (`audit.py` `_fields`): add any new key you use (for example `via` already exists, `count` exists). Never email, uid, token.

## Echo Prime (echo-cli: src/prime + ui/echo-prime)

- `src/prime/workspace.ts`: add `/api/auth/invites` to `reads`; add `/api/auth/usage`, `/api/auth/invite`, `/api/auth/invite/resend` (v1.1), `/api/auth/invite/revoke` to `authWrites`; add all five to the primary-owner-only list next to `/api/auth/accounts` and `/api/auth/decide`. Unknown sibling paths must still 404.
- New owner-only Prime route `POST /api/prime/members/uploads` body `{"uid":"..."}` -> `{"count":n,"bytes":n}` computed by the existing UploadStore for that account (same key derivation the store already uses; no file contents). Classified `owner` in `server.ts` like the other `/api/prime/*` owner routes.
- UI (`ui/echo-prime/workspace.js` view `members`, styles in the existing CSS files, compact single-line style, `element()` helper, `textContent` only, never `innerHTML`):
  - Owner-only side-panel item **Members** (`data-workspace-view="members"`, `data-owner-only`) in the bottom Account group next to Account, plus a NAV_GROUPS entry. Hidden for members and anonymous visitors, who never call any members route.
  - Members view: counts bar (Pending, Approved, Denied, Banned); a **member drop-down** (`<select>`) plus a search box that filters it client-side and status filter chips; selecting a member shows a detail card: email, status badge, role, joined, last sign-in, last active, active sessions, and a Usage card loaded with one `POST /auth/usage` (+ one `POST /api/prime/members/uploads`) for the selected member only (never one request per member). Usage labels: "Chats", "Messages sent", "Replies", "Characters sent", "Projects", "Library items", "Top tools", "Model tokens (approx.)", "Storage", "Uploads", and a line "Not available for members: voice, media, ...".
  - Actions on the detail card, each behind a confirm card that states the member's email and the exact consequence, with Confirm and Cancel: Approve / Deny (pending only), **Kick** ("Signs them out everywhere now. They can sign in again."), **Ban** ("Signs them out and blocks this account and email from signing in."), **Unban** (banned only, "Restores access as an approved member."). After an action, reload the list and keep the member selected; show the result line (for example "Signed out 2 sessions.").
  - **Invite** card: email input + an "Email the invitation" checkbox (checked by default, v1.1) + "Create invite"; on success show the invite link `https://<public origin>/#invite` with a Copy button and a ready-to-copy message: "You're invited to Echo Prime. Create an account at <link> with <email>, then confirm the verification email. Google sign-in works only if you already have an Echo account." Below, the invite list (status, created, expires) with Revoke on active ones. A 409 for an existing account offers "Open member". Emailing, Resend and every mail outcome are specified under "Emailed invitations" below.
  - Account view: keep the pending approvals section exactly as today (tests and Telegram rely on approve/deny) and add a "Manage members" button that opens Members.
  - `#invite` in the URL on load opens the sign-up panel with a short "You've been invited" note. The fragment carries no data and is removed from the address bar after reading.
  - Phone (max-width 640px): the picker, detail and actions stack; buttons are full width; no horizontal scroll.
- Tests (vitest, existing harness patterns): nav gating; owner opens Members and sees the list; no action request before Confirm; exact POST bodies; member/anonymous never call members routes; identity change discards late responses; usage rendering incl. `exists:false`; invite create/existing/409 flows; workspace.ts allowlist + owner-only tests for the four routes; the uploads route owner-only and counting.

## Emailed invitations (v1.1, 2026-11-06)

Until v1.1 the owner copied the invite link and message and sent them by hand. Now the Members view can email the invitation. Three sides share one contract and none may deviate: echo-auth sends the mail (Resend), the Workspace calls echo-auth with the owner's own session, and Prime asks and reports. A mail failure never fails or rolls back an invite.

```
Prime Members view --POST /api/workspace/auth/invite {email, send_email}--> Workspace --POST /v1/invites/send (owner's echo-auth bearer)--> echo-auth --> Resend
```

### echo-auth (side 1, for reference)

`POST /v1/invites/send` with `Authorization: Bearer <echo-auth access token>` whose uid is in `ECHO_AUTH_INVITE_SENDER_UIDS` (empty = feature off). Body `{"to","invite_url","inviter_name"?,"note"?}`; `invite_url` must be https on an origin in `ECHO_AUTH_INVITE_URL_ORIGINS` (default `https://echoomegaprime.com`). Answers: `202 {"sent":true,"message_id"}`; `400 invalid_recipient|invalid_invite_url`; `401/403` missing, invalid or non-sender token; `429 too_many_attempts` with `Retry-After` (per sender 20/hour, per recipient 3/day); `503 {"error":"mail_unavailable"}` when the mailer is unconfigured or the provider fails. `GET /v1/mail/health` (same bearer and sender gate) returns `{"configured","provider":"resend","from","domain_verified"}`.

### Workspace (side 2, what Prime depends on)

- `POST /api/auth/invite` also accepts `"send_email": true|false`. When it is true the Workspace creates the invite, then calls echo-auth server-side with the owner's session access token (RAM session only, never logged) and adds `"email":{"sent":bool,"message_id"?:str,"error"?:str,"retry_after"?:int}` to the normal invite object. `error` is the echo-auth code (`mail_unavailable`, `too_many_attempts`, `invalid_recipient`, `invalid_invite_url`) or other short text. When `send_email` is false or absent there is no `email` key. Business refusals keep their codes (the 409 with `uid` is unchanged); a mail failure is never a non-2xx on create.
- New owner-only `POST /api/auth/invite/resend` body `{"invite_id": "..."}` (or `{"email": "..."}`), for an existing unexpired unused invite, same rate limits. Answer: `200 {"invite":{...},"email":{...}}` with the same `email` object. Refusals: `404` unknown invite, `409` not active (used, revoked or expired), `429` with `retry_after` (body) and `Retry-After` (header). Business refusals are never 401/403 (a 403 clears the owner's page identity in Prime's client).
- Assumption to confirm with the Workspace build: Prime reads only `email` from a resend answer and tolerates a missing `invite`; a missing `email` is shown as "The Workspace did not report an email result".

### Prime (side 3)

- `src/prime/workspace.ts` allowlists and owner-gates `POST /api/auth/invite/resend` exactly like the other invite writes (anonymous 401, member 403, siblings 404, owner needs the session CSRF). The body and the Workspace's answer pass through untouched. On a `429` the proxy also relays `Retry-After`, only when it is plain seconds.
- `ui/echo-prime/workspace-client.js`: on a `429` the thrown error carries `retryAfter` (whole seconds): the body's `retry_after` (top level, or inside an `email` result), else a numeric `Retry-After` header. Missing, non-numeric, non-positive or over-a-week values carry no `retryAfter`.
- Members view, Invite card: an **Email the invitation** checkbox, checked by default; the request body is exactly `{"email","send_email":true|false}`. After the answer the card always shows the invite line ("Invite created for <address>." or "An active invite for <address> already exists."), the mail line, and the copy-link fallback (link field, Copy link, message, Copy message) as before. With the box unticked the text is the old "Share the link and message yourself." and no mail line is shown.
- Mail line, in the same words for create and resend (`mail.state`): sent -> **Invitation emailed to <address>**. Failed -> an error line, then "The invite was created; share the link and message yourself." (create), "Share the same link and message yourself." (existing invite) or "Nothing was sent; share the link and message yourself." (resend). No `email` object although one was asked for -> "The Workspace did not report an email result" plus the matching fallback line ("The invite was created; ..." or, for an existing invite or a resend, "Share the same link and message yourself.").

| `email.error` (or refusal) | Shown |
|---|---|
| `mail_unavailable` | Mail is not set up |
| `too_many_attempts` (+ `retry_after` seconds) | Too many invitations, try again in N min (N = seconds / 60 rounded up, at least 1); without a usable wait: Too many invitations, try again later |
| `invalid_recipient` | That email address cannot receive an invitation |
| `invalid_invite_url` | The invite link is not allowed in email |
| any other lowercase code (for example `forbidden`) | Invitation email failed (forbidden) |
| any other text (a provider message) | the text as given, capped at 300 characters, rendered as text only |
| `sent:false` with no error | The email was not sent |

- Invite list: every `active` row gets **Resend** next to Revoke (used, expired and revoked rows get neither). Resend has no confirm card (nothing is destroyed), posts exactly `{"invite_id": "<id>"}`, is disabled while in flight (no double send), and shows its result in the Invite card (and the panel status line) without reloading the list. A resend refused with 429 shows the same "Too many invitations" line from `retryAfter`; any other refusal shows the Workspace's own message. The copy-link fallback (link and message for that invite's address) is shown after every resend, sent or not. An answer that arrives after the owner's account or panel changed is discarded.
- The 409 "Open member" handling for an email that already has an account is unchanged.
- Tests (vitest): `prime-members-ui.test.ts` (checkbox default and body, every outcome row above for create and resend, fallback present in every outcome, Resend on active rows only with exact body, double-click guard, late-answer discard, transport `retryAfter`, no innerHTML), `prime-workspace-allowlist.test.ts` and `prime-workspace.test.ts` (five routes, owner-only, pass-through of `send_email`, `invite_id` and `email`, `Retry-After` relay). No test reaches a real mailer.
