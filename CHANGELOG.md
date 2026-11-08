# Changelog

## Unreleased -- bot autonomy hardening (2026-11-07)

### Fixed

- Advertise the host's validated chat deadline to the browser, which adds five seconds of transport
  grace after its status check. Longer configured turns are no longer cancelled by the old fixed
  125-second browser timer; Stop and account-change cancellation remain immediate.
- Let a parent wait up to 25 seconds for a run's terminal output/proof in one read-only status
  operation. Expiry remains incomplete; interrupted queries retain only the requested run ID.
  Polling cannot resume or resubmit work and remains within the existing 30-second operation cap.
- Allow an embedding host to configure the chat turn deadline from 1 to 300 seconds, retaining
  the 120-second default and existing cancellation path. Browser/model requests cannot override it.
- Reuse verified capability metadata within one delegation, with a 30-second expiry, to avoid
  exhausting admission time on repeated catalog reads. Later operations re-read the catalog;
  current bot state, leases, spending limits and the worker's SDK authorization still apply.
- Preserve durable bot/run/message/event IDs when resume or result observation times out or is
  cancelled. Unknown outcomes remain deduplicated and never claim completed output or proof.
- A retained event whose run has been removed now reports `unavailable` with `done: false`;
  it does not resume or resubmit the task.

## Unreleased -- consolidation pass (2026-08-11)

### Fixed
- **No test suite existed** despite a declared `"test": "vitest run"` script -- `npm test`
  failed immediately on a clean checkout. Added `tests/{config,client,formatters}.test.ts`
  (17 tests).
- **No working lint config existed** despite a declared `"lint": "eslint src/"` script --
  ESLint 9 requires flat config and `npm run lint` failed immediately. Added
  `eslint.config.js` using `typescript-eslint`'s current documented pattern.
- `npm audit`: resolved 9 of 10 findings (including 1 CRITICAL) by bumping `vitest` to
  `4.1.10`. One LOW finding (`esbuild`, Windows dev-server-only, never shipped) documented as
  accepted risk in SECURITY.md.
- Full governance set added: README (none existed before), LICENSE (proprietary, matching
  `package.json`'s existing `"license": "Proprietary"` field), SECURITY.md, CONTRIBUTING.md,
  CODE_OF_CONDUCT.md, `.github/` issue/PR templates and CI.

### Observed, filed, not fixed here (out of scope for this repo)
- The default gateway's `GET /health` returns 500 (build-queue `#29636`) -- confirmed the
  gateway itself is live and auth-protected routes correctly 401; only the public health
  route is broken. This repo ships no gateway source.

## 3.4.1 -- prior release

Echo SDK Gateway CLI: 45+ commands across engines, knowledge search, the shared-brain memory
system, doctrine generation, chat (14 personalities), unified search, tool discovery, bot
deployment, scraper orchestration, dashboards, auth key management, and a `deploy` command
wrapping `wrangler`.
