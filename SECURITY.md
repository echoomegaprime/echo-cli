# Security policy

Echo CLI is a thin HTTP client (`src/client.ts`) for the Echo SDK Gateway. It holds no
server-side auth boundary of its own — every protected call sends `X-Echo-API-Key` to the
configured gateway, which is responsible for authorization.

## Fixed in this consolidation pass

1. **No test suite existed.** `package.json` declared `"test": "vitest run"`, but no
   `tests/` directory existed at all — a clean checkout following the CLI's own documented
   setup failed immediately with `No test files found, exiting with code 1`. Added
   `tests/{config,client,formatters}.test.ts` (17 tests) covering API-key resolution
   precedence (CLI flag > env var > stored config > empty), the auth-vs-public request split
   in `EchoClient` (only authenticated calls send `X-Echo-API-Key`), error-envelope
   unwrapping, and timeout/abort handling.
2. **No working lint config existed.** `package.json` declared `"lint": "eslint src/"` with
   `eslint@^9.0.0` as a devDependency, but no `eslint.config.js` existed — ESLint 9 requires
   the flat-config format and `npm run lint` failed immediately with "ESLint couldn't find an
   eslint.config.js file." Added a flat config using `typescript-eslint`'s current documented
   pattern (verified against upstream docs, not assumed from memory — the installed
   `typescript-eslint@8.67.0` flags the older `tseslint.config(...)` form as deprecated).
3. **Dependency vulnerabilities.** `npm audit` reported 10 findings including one CRITICAL
   (a Vitest UI dev-server arbitrary file read/execute vulnerability). Resolved 9 of 10 by
   bumping `vitest` to its current major (`4.1.10`) — safe here since the entire test suite
   was written fresh alongside this fix, so nothing existing could regress. The one remaining
   LOW finding (`esbuild`, arbitrary file read on Windows, requires the esbuild dev server to
   be actively listening) is left as accepted risk rather than chased through a further
   breaking bump of `tsx`/`vite`: it is dev-tooling only, Windows + dev-server-specific, and
   never present in the published `dist/` output this package ships (`"files": ["dist/"]`).

## Observed but out of scope for this repo

`GET /health` on the default gateway (`https://echo-sdk-gateway.bmcii1976.workers.dev`)
currently returns `500 Internal Server Error`. Every other probed route
(`/llm/providers`, `/doctrine/providers`, `/engine/domains`, `/auth/whoami`) correctly returns
`401` for an unauthenticated request, confirming the gateway itself is live and the auth layer
works — only the public, unauthenticated `/health` route is broken. This repo contains no
gateway source (it is a pure HTTP client); the fix belongs in the gateway's own repository.
Filed as build-queue item `#29636` rather than silently absorbed.

## What was verified already correct, not changed

`src/client.ts`'s `EchoClient.request()` only attaches `X-Echo-API-Key` on authenticated
calls; `publicRequest()` (used for signup/plan-catalog style routes) never sends it — verified
by test, not assumption. The one shell-out in the CLI (`deploy` command wraps `npx wrangler
deploy` via `child_process.execSync`) passes a fixed command string with the user-supplied
directory only as the `cwd` option, never interpolated into the shell command itself — no
command-injection surface.

## Supported version

Security fixes target the current `main` branch. Historical commits are retained for evidence
and are not patched in place.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Send a private report to
`security@echo-op.com` with:

- affected command/endpoint and exact revision;
- reproduction steps and expected impact;
- safe contact details for follow-up.

Never include a live API key in a report.
