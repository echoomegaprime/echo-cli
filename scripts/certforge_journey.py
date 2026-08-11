r"""Critical journey for the ECHO Certification Forge.

The Forge runs this argv (declared as a top-level `journey` field in the
POST /v1/certifications request body -- NOT read from .echo/certification.json;
see [[reference-certification-forge-submit-recipe-20260810]] gotcha #8) inside
its isolated `python:3.12-alpine` sandbox, against the exact acquired commit,
with no network, no git, and no Node -- so this TypeScript CLI cannot actually
be installed, type-checked, or run there. The full behavioural suite
(eslint, tsc --noEmit, vitest, tsc build, and a live `node dist/index.js
--help` smoke check) runs in CI on this same commit; this journey proves the
artifact the Forge actually acquired is the intact, complete source -- and
that it doesn't regress the two "declared but broken tooling" bugs this
consolidation pass fixed (no test suite, no working lint config).

This repository is TypeScript-only (a Node CLI, Commander-based, no
framework beyond `commander`/`conf`/`chalk`/`table`); this journey therefore
checks structural and textual invariants using only the Python standard
library, matching what the sandbox actually has available.

Checks:
  1. The critical surfaces exist -- the CLI entrypoint, the HTTP client, the
     config module, the new test suite, and the new lint config.
  2. `src/index.ts` and `src/client.ts` have not been truncated -- a cheap,
     tokenizer-free line and byte-size floor.
  3. `tests/` still contains real test files -- regression guard for the
     'declared "test" script, zero test files' bug this pass fixed (a clean
     checkout previously failed `npm test` immediately with 'No test files
     found, exiting with code 1').
  4. `eslint.config.js` still exists -- regression guard for the 'declared
     "lint" script, no flat config' bug this pass fixed (a clean checkout
     previously failed `npm run lint` immediately with "ESLint couldn't find
     an eslint.config.js file").
  5. `src/client.ts` still keeps `request()` (authenticated) and
     `publicRequest()` (unauthenticated) as distinct methods, and only
     `request()` attaches `X-Echo-API-Key` -- a text-anchored guard against
     accidentally merging the two paths, which would either leak the API key
     on public routes or block public routes entirely.
  6. No hardcoded secret-shaped literals in the acquired source.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NoReturn

CRITICAL_SURFACES = (
    "src/index.ts",
    "src/client.ts",
    "src/config.ts",
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "tests/client.test.ts",
    "tests/config.test.ts",
)

SECRET_LITERAL_PATTERN = re.compile(
    r'(?:api_key|apikey|secret|password|token)\s*=\s*["\'][a-zA-Z0-9_\-]{16,}["\']',
    re.IGNORECASE,
)

MIN_INDEX_TS_LINES = 900
MIN_CLIENT_TS_LINES = 400


def _fail(message: str) -> NoReturn:
    print(f"ECHO_CLI_CRITICAL_JOURNEY_FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def check_critical_surfaces() -> None:
    for surface in CRITICAL_SURFACES:
        if not Path(surface).exists():
            _fail(f"missing critical surface: {surface}")


def check_not_truncated() -> None:
    index_text = Path("src/index.ts").read_text(encoding="utf-8")
    client_text = Path("src/client.ts").read_text(encoding="utf-8")
    index_lines = index_text.count("\n") + 1
    client_lines = client_text.count("\n") + 1
    if index_lines < MIN_INDEX_TS_LINES:
        _fail(f"src/index.ts has only {index_lines} lines (expected >= {MIN_INDEX_TS_LINES}) -- possible truncation")
    if client_lines < MIN_CLIENT_TS_LINES:
        _fail(f"src/client.ts has only {client_lines} lines (expected >= {MIN_CLIENT_TS_LINES}) -- possible truncation")
    if "export class EchoClient" not in client_text:
        _fail("src/client.ts is missing the EchoClient class")


def check_no_hardcoded_secrets() -> None:
    for surface in ("src/index.ts", "src/client.ts", "src/config.ts"):
        match = SECRET_LITERAL_PATTERN.search(Path(surface).read_text(encoding="utf-8"))
        if match:
            _fail(f"{surface} contains a hardcoded secret-shaped literal: {match.group(0)[:40]}...")


def check_test_suite_present() -> None:
    tests_dir = Path("tests")
    test_files = sorted(p.name for p in tests_dir.glob("*.test.ts"))
    if len(test_files) < 3:
        _fail(
            f"tests/ only contains {len(test_files)} *.test.ts file(s) ({test_files}) -- "
            "this is exactly the 'declared test script, zero test files' regression fixed "
            "in this consolidation pass"
        )


def check_lint_config_present() -> None:
    text = Path("eslint.config.js").read_text(encoding="utf-8")
    if "typescript-eslint" not in text:
        _fail(
            "eslint.config.js no longer references typescript-eslint -- this is exactly the "
            "'declared lint script, no flat config' regression fixed in this consolidation pass"
        )


def check_auth_vs_public_split() -> None:
    text = Path("src/client.ts").read_text(encoding="utf-8")
    if "async request<T = unknown>(path: string" not in text:
        _fail("src/client.ts is missing the authenticated request() method")
    if "async publicRequest<T = unknown>(path: string" not in text:
        _fail("src/client.ts is missing the unauthenticated publicRequest() method")
    request_section, _, rest = text.partition("async publicRequest<T = unknown>(path: string")
    if "X-Echo-API-Key" not in request_section.split("async request<T = unknown>(path: string", 1)[-1]:
        _fail("request() no longer attaches X-Echo-API-Key -- authenticated calls would go out unauthenticated")
    if "X-Echo-API-Key" in rest:
        _fail("publicRequest() now sends X-Echo-API-Key -- this would leak the API key on public routes")


def main() -> None:
    check_critical_surfaces()
    check_not_truncated()
    check_no_hardcoded_secrets()
    check_test_suite_present()
    check_lint_config_present()
    check_auth_vs_public_split()
    print(
        "ECHO_CLI_CRITICAL_JOURNEY_OK "
        "critical_surfaces=8 hardcoded_secrets=0 "
        "test_suite_present=1 lint_config_present=1 auth_vs_public_split=1"
    )


if __name__ == "__main__":
    main()
