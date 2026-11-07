# Prime SDK bridge

Gives production Prime an `sdk` connection so the SDK-backed live tools
(`src/code/tools/*`), autonomous agent/bot creation (`src/code/tools/autoagents.ts`,
which verifies capability ids through the broker) and the ECF hooks
(`src/code/tools/ecf.ts` via `ContinuityClient`) can actually act. Before this,
`prime.prod.json` had no `sdk` section, so startup reported `"sdk":false` and the
broker was never built.

## Where it sits

```
Prime chat / tools
   └─ sdkBroker            src/prime/sdk.ts      (search / read / invoke)
        └─ StdioMcp        src/prime/stdio.ts    (newline-delimited JSON-RPC over stdio)
             └─ sdk-stdio  src/bridge/sdk-stdio.ts  ← this bridge (a spawned Node process)
                  └─ POST http://127.0.0.1:8000/sdk/invoke   (Echo SDK gate, loopback only)
```

The bridge is a **zero-dependency** Node stdio MCP server: Node built-ins plus the
global `fetch`, no npm packages. It is compiled by `tsc` from
`src/bridge/sdk-stdio.ts` to `dist/bridge/sdk-stdio.js`.

## Tool contract

The bridge advertises exactly the three tools Prime's broker calls (names are
configurable; defaults below). Each result is returned as MCP text content
("untrusted data"), which Prime's `unwrap` (`src/prime/hub.ts`) decodes.

| Tool (default name) | Gate capability | Params sent to the gate | Result shape the bridge returns |
|---|---|---|---|
| `sdk_search` | `echo.caps.search` | `{command:"search",options:{q,limit}}` | `{results:[{id,description,registered,health_status,metadata:{required_scope,danger_tier}}],sdk_catalog:{truncated}}` — the row shape `sdkBroker.search` maps to `Capability` |
| `sdk_read` | `echo.caps.detail`, then `echo.caps.search` | Detail by ID, followed by an exact-ID check in the active search result | `{capability:{…cap,required_scope,metadata},registration_state,health_status,sdk_gate,registration_check}` |
| `sdk_invoke` | *the requested* `echo.*` | the caller's `params` verbatim | the gate capability `body`, plus separate `sdk_gate` routing references |

The gate answers with the envelope `{run_id,status,result:{status_code,body},trace,warnings}`.
The bridge peels it and **fails closed**: a transport error, a non-`ok` envelope
status, a non-2xx `status_code`, a `body.ok===false`, an oversized or malformed
body all come back as `{ok:false,error,required?}` so the caller's `unwrap`
surfaces the detail (scope-denied invocations carry `required`).

### Why `search` and `read` are reshaped (not passed through)

`echo.caps.search` returns `body.caps[]` with `{id,description,tier,scope,method,…}`,
but `sdkBroker.search` reads `result.results[]` with `metadata.{required_scope,danger_tier}`.
`echo.caps.detail` returns `body.cap` with `{id,scope,tier,health,params,…}`, but
`hub.ts:338` and `autoagents.ts` read `record.capability.id`,
`record.registration_state === "registered"` and `record.health_status`
(blocking `red`/`orphaned`/`unregistered`). The bridge maps the gate's fields onto
exactly those keys; without the mapping, catalog search and cap-id verification
would break.

The live search selects active registry entries; detail also returns inactive definitions.
The bridge marks a detail `registered` only after the exact ID appears in active search.
An unsuccessful or uncertain registration check yields `unknown`. Missing or invalid
danger tiers remain `null`, including when a live row replaces a snapshot. Catalog
`params` are documentation fields, not a reconstruction of the full input schema.
`sdk_gate` preserves the gate's returned run and trace references as routing evidence;
it is not signed execution certification.

The live-tool adapter sends canonical flat SDK parameters, `{command, ...fields}`.
It rejects an options field that overrides `command`. Generic bridge invocations
preserve their supplied fields, including a handler's literal shell command.

## Security properties

- **Key from a file only.** The API key is read at startup from the file named by
  `ECHO_PRIME_SDK_KEY_FILE` (line `ECHO_PRIME_SDK_KEY=…`). It is never printed,
  logged, or placed in a result. A redaction pass strips the key value and obvious
  secret shapes from every stderr log line and every emitted result.
- **Loopback only.** `ECHO_GATE_URL` must name a loopback host
  (`127.0.0.0/8`, `localhost`, `::1`) without credentials, query, or fragment.
  Redirects are refused before another destination receives the API key.
- **Bounded.** The default 30 s gate deadline includes the response body and any
  permitted HMAC challenge response. Responses are capped at 1 MiB while streaming;
  requests, decoded bodies, and emitted result text are bounded too.
- **Optional trusted signer.** A separately supplied HMAC secret is read only when
  the gate issues the specific pre-dispatch challenge below. It is not logged,
  returned, or included in request context. No credential lookup is performed.
- **No silent fallback.** Any uncertain outcome is reported as a failure with a
  bounded, redacted detail; the bridge never substitutes a guess.
- **Headless, stdin/stdout only.** Structured JSON log lines go to stderr
  (`{event,…}`), which Prime's `StdioMcp` drains.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ECHO_GATE_URL` | `http://127.0.0.1:8000/sdk/invoke` | Loopback SDK gate endpoint (non-loopback refused). |
| `ECHO_PRIME_SDK_KEY_FILE` | `/home/forge/prime-prod/sdk-bridge.env` | File holding `ECHO_PRIME_SDK_KEY=…` (mode 0600, scoped key). |
| `ECHO_PRIME_SDK_HMAC_SECRET` | unset | Optional 64-hex-character signing secret corresponding to the API key; supplied by the owner's secret store through the service environment. |
| `ECHO_PRIME_SDK_MAX_TIMEOUT_MS` | `600000` | Upper bound for an explicitly requested invocation wait, clamped to 30000–900000 ms. |
| `ECHO_PRIME_SDK_TOOL_SEARCH` | `sdk_search` | Advertised search tool name. |
| `ECHO_PRIME_SDK_TOOL_READ` | `sdk_read` | Advertised read tool name. |
| `ECHO_PRIME_SDK_TOOL_INVOKE` | `sdk_invoke` | Advertised invoke tool name. |

`StdioMcp` passes the child only a whitelist of OS vars plus the connection's own
`env`, so `ECHO_GATE_URL` and `ECHO_PRIME_SDK_KEY_FILE` **must** be set in the
`sdk.env` block below — they are not inherited from the service environment.
The signer is an explicit exception: Prime's `sdkConnectionConfig` copies
`ECHO_PRIME_SDK_HMAC_SECRET` from its trusted service environment into the configured
SDK child's environment only. It does not forward it to other MCP connections,
model arguments, or fixed invocation context.

### Optional Tier 2+ HMAC signing

Have the existing secret-store/service launcher inject the per-key signing secret
as `ECHO_PRIME_SDK_HMAC_SECRET` when starting Prime. Keep the value out of source
control, the reviewed JSON configuration, shell command arguments, and transcripts.
For a standalone bridge, inject the same variable directly into that process.
The signer reads the variable for each challenge; restart the managed service after
changing its launch environment so its child receives the new value.

The protocol is deliberately narrow:

1. Send the original request without manufacturing an approval or additional scope.
2. Sign only an outer HTTP 423 response whose `detail.error` is exactly
   `hmac_required_for_tier2_plus` and whose `detail.capability` matches the request.
   The gate source issues this challenge before dispatch.
3. Use a fresh 16-byte random nonce (32 lowercase hex characters), a UTC epoch-second
   timestamp, and the same parameters and context. Retry exactly once within the
   original deadline.
4. Return the second outcome. Signature/replay rejection, TOTP or approval requests,
   other errors, and timeouts cause no further attempts. A timeout reports an unknown
   outcome and must not be treated as permission to submit the operation again.

Missing or malformed signer configuration returns code `hmac_signer_unconfigured`
and the exact message:

> SDK HMAC signer is unconfigured: ECHO_PRIME_SDK_HMAC_SECRET must contain 64 hexadecimal characters

Canonical bytes match `routers/_auth_p4.py::_canonical_signed_form` and the installed
SOL SDK client: `v1|api_key|capability|canonical_params_json|nonce|ts`, encoded as UTF-8,
with HMAC-SHA256 using the hex-decoded secret. Parameters first pass through their
actual wire JSON representation. The canonical serializer matches Python's recursive
key sorting, ASCII escaping, and compact number formatting. It fails closed when it
cannot encode the request; no alternate signing form is tried.

The signer does not grant scopes or satisfy TOTP/other gate approvals. Offline tests
verify protocol compatibility; configuring the variable alone does not establish
that a live key, gate nonce store, or privileged handler is operational.

## The exact `prime.prod.json` `sdk` section to add

Add this key to `prime.prod.json` (the production config at
`/home/forge/prime-prod/prime.prod.json`). The tool-maintainer applies this — the
build slice does not edit `prime.prod.json`.

```json
"sdk": {
  "command": "/usr/bin/node",
  "args": ["/home/forge/prime-prod/app/dist/bridge/sdk-stdio.js"],
  "env": {
    "ECHO_GATE_URL": "http://127.0.0.1:8000/sdk/invoke",
    "ECHO_PRIME_SDK_KEY_FILE": "/home/forge/prime-prod/sdk-bridge.env"
  },
  "tools": { "search": "sdk_search", "read": "sdk_read", "invoke": "sdk_invoke" }
}
```

`fixedArguments` is optional. When present it is merged into every forwarded call
(for example a fixed account/link id): `"fixedArguments": { "link_id": "…" }`.

### Before enabling it

- Deploy the built bridge to `/home/forge/prime-prod/app/dist/bridge/sdk-stdio.js`
  (part of the normal `dist/` deploy of the Prime app).
- Confirm the service user can read the 0600 key file:
  `systemctl show echo-prime-web -p User` → that user must own (or be able to read)
  `/home/forge/prime-prod/sdk-bridge.env`.
- Restart `echo-prime-web`; startup then reports `"sdk":true`.

The broker gives ordinary invocations a 35 s MCP wait for the bridge's 30 s gate
deadline plus transport grace. Explicit longer invocation waits retain their bounded
per-call allowance. Catalog reads use the connection's ordinary read timeout.

## Live smoke (manual)

Build first, then drive the built bridge through the real broker against the real
gate with the real key file (defaults = production paths):

```bash
cd /home/forge/prime-build/wt-sdkbridge && npm run build
node --import tsx scripts/sdk_bridge_smoke.ts   # prints only counts: {results:N, readOk, id}
```

The smoke script connects via `StdioMcp` + `sdkBroker` to
`dist/bridge/sdk-stdio.js`, runs `search("knowledge")`, then `read()` on the first
result id, and prints counts only — never the key, never full bodies.

## Tests

`tests/prime-sdk-bridge.test.ts` spawns the bridge against a `node:http` stand-in
gate and a temporary fake key file (never the real key), and drives it through the
real `StdioMcp` + `sdkBroker`. It covers the search/read reshapes, invoke
pass-through and fixed-argument/context binding, every gate-failure branch
(4xx without a status field, scope-denied 403, `body.ok:false`, failed envelope,
oversized body, malformed JSON), the startup refusals (non-loopback gate, missing
key file) and secret hygiene (the key never reaches stdout/stderr).
`prime-sdk-hmac.test.ts` checks independent Python-generated canonical byte and HMAC
vectors. `prime-sdk-signing.test.ts` uses synthetic keys and an offline gate to check
the single challenge response, fresh nonces, replay/signature refusal, missing
configuration, unchanged request data, timeout behavior, and secret redaction.
