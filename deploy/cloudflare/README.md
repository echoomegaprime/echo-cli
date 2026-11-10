# Echo Prime public proxy

`echoprime-proxy.js` is the standalone module for the existing Cloudflare Worker
`echoprime-proxy`. It is maintained here so the edge code and the Prime callback
can be verified together. Uploading this module is separate from deploying the
CLI or Prime service.

## Callback query handling

For GET and HEAD requests to the exact `/bots-oauth-callback.html` path, the
Worker fetches the static page from the existing UI origin with an empty query.
The browser retains the original callback URL. The callback script reads its
code and state, clears the browser URL, checks the owner session, and posts the
provider response to the protected callback API. The edge does not inspect or
store the code, state, cookies or response body.

Other paths and methods retain their existing routing and query behavior. Login
routing, the agent API prefix, JavaScript origin rewriting, response headers,
status codes and separate Set-Cookie headers are unchanged.

The JavaScript response rewriter directly replaces complete quoted origin
literals. It does not need a preliminary substring condition, and it does not
use response text to validate or choose request destinations.

This limits exposure in tunnel and origin request URLs. Cloudflare receives the
original incoming URL before this code executes, so Worker invocation logs and
zone logging need separate verification. This change does not establish provider
consent or make an undeployed callback page available.

## Source provenance and verification

The regression fixture `tests/fixtures/echoprime-proxy-2bb0c38f.js` is the exact
2778-byte module read from the running Worker on 2026-11-08. Its SHA-256 is
`8ec551552bcb0d72ee92e944fa55a2fe47fa6661b9dbefca233af7fe895a511a`.
The observed deployment was `cc4790a2-4297-4b36-aa14-97f2f857ee70`, serving version
`2bb0c38f-4956-4a95-9515-c1161327431d` at 100 percent. Re-read this identity before
any release; the snapshot is not a promise that production remains unchanged.

Run `npx vitest run tests/prime/cloudflare-proxy.test.ts`. The tests exercise the
actual Worker module, verify its downstream URL and unmodified browser URL,
execute the actual callback script through session and POST completion, and
compare unrelated behavior against the deployed baseline. Provider values in
tests are synthetic.

## Versioned release and recovery

Use the existing owner-authorized Cloudflare CLI identity. Do not export its
credentials into files or diagnostics. Before upload, verify the live deployment,
module digest, empty bindings and runtime settings against the reviewed package.
Retain compatibility date `2024-11-01` and the existing empty compatibility flags.
Do not change routes, bindings, secrets or logging settings as part of this patch.

Upload a version through the documented Worker Versions API, inspect its returned
version and runtime metadata, and confirm the active deployment is unchanged.
After the normal release admission and independent source review, create a new
deployment selecting that exact version at 100 percent. Independently read back
the active version, downloaded module digest and unchanged settings; run harmless
public route probes and verify the callback behavior without real OAuth values.

If verification fails after a confirmed deployment, first reconcile the current
identity. Restore the prior version with a new 100-percent deployment only if the
current deployment is still the one created by this operation. If another actor
has changed it or an operation has an unknown outcome, stop mutations and read
back the state. Do not overwrite concurrent changes or blindly repeat writes.
