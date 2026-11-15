# Accounts and private workspaces

The server remains bound to loopback. Public hosting requires enabled authentication, exact HTTPS public_origins and a configured proxy or named tunnel. Public origins with authentication disabled fail startup.

Canonical https://auth.echo-op.com handles passwords, email verification, recovery and Google identity verification. Workspace keeps no passwords. Upstream access and refresh tokens remain in RAM; opaque HttpOnly SameSite=Lax cookies identify local sessions. Public cookies also require Secure. Restarting logs users out without deleting accounts or memories.

Pin verified owner UIDs in auth.owner_uids. Submitted emails, roles, UIDs and OAuth hints cannot grant ownership. All other verified identities start pending. Approval and denial require an authenticated owner and a CSRF-protected POST. Every protected request verifies its access token through the existing IdentityClient `/v1/verify` path, even when token expiry is far in the future, then rereads local approval/denial. The upstream service must enforce signature, issuer, audience, verified email, and current enabled/existing canonical user state. There is no positive admission cache. Established user IDs can be used in the login identifier field; canonical password verification still applies.

Canonical rejection or a missing/mismatched/unverified identity revokes the local session and returns 401 for protected API requests (pages redirect to login). An issuer/transport outage returns a generic 503 and admits no request. If no refresh was attempted, the in-memory session remains available for a later fresh verification. Once a near-expiry refresh is attempted, a transport error or a failure verifying its returned access token makes rotation ambiguous: the issuer may already have consumed the one-use old refresh token. This case returns a bounded 503 and invalidates the local session, requiring fresh sign-in. It never retries the consumed old token or admits private data. A successful verified refresh keeps only the returned replacement refresh token; if none is supplied, later expiry requires sign-in rather than reusing the old token. No raw issuer response or driver error is returned.

Near-expiry refresh and verification serialize only within the same session; other accounts are not locked behind network I/O. Logout or local expiry wins over a late issuer response, and a local denial is never overwritten by verification. Each check emits structured `session_verify` status, HTTP status and duration, with bounded `refresh_unconfirmed` or `issuer_unavailable` categories for outages, without tokens, cookies, emails, UIDs or provider text. Public login/privacy assets retain their existing safe allowlist and remain available during issuer outages.

POST `/api/auth/logout` is a local revocation capability: it requires the existing local opaque session, matching session CSRF value, allowed Origin and normal bounded JSON framing, but does not call the canonical verifier. The session is removed before best-effort upstream logout, and a successful local logout returns 200 with an expired cookie even if upstream logout fails. A wrong Origin or CSRF is rejected without revoking an active session. Unknown, expired or already-revoked sessions return a bounded 401; no session material or user data is returned. Old cookies stay denied after issuer recovery. This exception applies only to logout and grants no private-data, account-administration or global-action access from stale admission.

Google requires an existing verified canonical ECHO account and registration of the exact browser origin in the Google client configuration. To use a workspace-specific client, set auth.google_client_id to its public client ID and register that same ID in the canonical identity service's ECHO_AUTH_GOOGLE_ADDITIONAL_CLIENT_IDS allowlist. Deploy and verify the identity service first: GET /v1/client-config?client_id=<registered-id> must return that exact ID. Unknown clients fail closed, and the workspace rejects an unexpected default client. Omitting auth.google_client_id preserves the canonical default. No OAuth client secret belongs in workspace configuration. The workspace does not offer Facebook sign-in. Offline tests do not prove a production provider login.

## User separation

Set `auth.legacy_data_owner_uid` to the one verified UID that owns the existing legacy data root. It must be a member of `auth.owner_uids`. With exactly one pinned owner and this property absent, that one UID retains the existing root for compatibility. With multiple owners, an absent, empty, mistyped or unpinned mapping fails private application selection with a generic 503. Owner ordering, email, account similarity and submitted hints never choose a legacy owner. Account login, public assets and verified-owner account administration remain separate from this storage-policy failure.

Only that explicit legacy owner selects the existing data root. Every other verified UID, including another pinned owner/admin, uses data/users/<SHA256 of verified UID> with separate SQLite, journals, library, memories, voice artifacts, preferences and MCP connections. The root is derived on the server from the verified UID and is stable across restart. Private applications receive only the model connection/context configuration, their server-derived tenant ID and the isolation flag; they inherit no primary-owner plugins, credentials, directive paths, voice configuration, mission or catalog. Request parameters never select a tenant root. The model request state is also separate.

Private applications do not inherit the legacy owner's Vault, ESH, nodes, SDK or shared ECF/Crystal/Arcanum/Knowledge credentials. Owner-only application routes and actions fail closed for those applications, including secondary owners. A secondary owner keeps its verified `owner` role and may still list, approve or deny pending members through the CSRF-protected account administration routes. Account-administration authority does not grant access to the primary owner's history, credentials or global tools. Private memories persist locally and are retrieved automatically only within their own account. Remote shared-memory ingestion remains disabled until a tenant-aware transport exists. This is application isolation; the host administrator retains filesystem access.

This policy performs no data copy, migration, deletion, UID reassignment or role change. Before adopting a multi-owner configuration, verify and set the explicit legacy mapping in that target's config. Existing primary data stays in place; other owners start with their own empty private stores. Rollback uses the previously reviewed source/config and retains every data directory. Review the former shared-owner behavior before running older source against multiple owners. This source change does not edit production configuration or deploy itself.

## Ingress configuration

Set public_origins to the exact https://echoomegaprime.com and https://www.echoomegaprime.com origins. Set auth.enabled=true, auth.issuer=https://auth.echo-op.com, auth.owner_uids to verified identities and auth.trusted_proxy_ips to the measured proxy peers (127.0.0.1 for the local tunnel).

The proxy must preserve public Host. Only pinned TCP peers on configured public hosts can supply one valid CF-Connecting-IP. Loopback Host ignores forwarding headers. Login, signup and recovery forward that server-derived visitor IP to canonical authentication's existing X-Forwarded-For contract. Verify the deployed upstream ingress preserves this identity. HTTP concurrency and request read time are bounded; provider configuration is cached.

## Telegram review links

Set auth.telegram_chat_id only after verifying the owner's destination. Pending accounts notify through the existing echo.social.telegram_post transport. Approve and Deny links open the signed-in owner's account page for confirmation. GET links and previews never mutate admission. This is an authenticated review-link flow, not a Telegram callback-button implementation; no second bot poller is started.

A returned message ID confirms delivery. Ambiguous failures remain uncertain without automatic resend or access grants. The Account page lists pending users even if notifications fail. Verify actual bot destination and delivery separately before reporting Telegram as live.

## Validation and release

Run python -m unittest discover -s tests and node --test tests/*.test.mjs. HTTP tests use isolated temporary stores and an explicit offline identity provider. Before public cutover, verify exact-source release requirements, actual ingress headers, public cookies, a real owner session and two separate approved accounts. Preserve old origin routing and application/config backups for rollback.

Structured audit logs contain status, hashed actor/tenant IDs and error categories, never passwords or raw provider responses.


Workspace Google Cloud registration (created 2026-10-30 under echoomegaprime@gmail.com):
- Project: `project-43be0620-2780-449d-9c4`
- Client: `326447303587-rdt0chiu2fo9tgu72plh3095p25p4v0i.apps.googleusercontent.com`
- JavaScript origins: `https://echoomegaprime.com`, `https://www.echoomegaprime.com`, `http://127.0.0.1:8768`, `http://localhost:8768`.
This records Google registration only; it does not assert deployed server allowlist,
public routing, or successful end-to-end sign-in.

## Session-cookie isolation (2026-10-30 candidate)

Session extraction reads only the exact unquoted echo_workspace_session name/value.
Unrelated browser cookies, including JSON-style Google state, do not invalidate it.
Headers over 8192 characters, multiple Cookie header lines, duplicate own cookies,
malformed own names and non-URL-safe values are refused. The extracted value still
requires Accounts.resolve, current canonical admission, expiry and revocation;
cookie shape does not authenticate. Debug events contain only fixed rejection
categories. Real HTTP regressions are in tests/test_cookie_isolation.py.
This source repair does not establish the real Google browser journey, installation
or public release acceptance.
