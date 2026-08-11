# Changelog

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
