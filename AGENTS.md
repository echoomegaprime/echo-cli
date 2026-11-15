# Echo CLI engineering doorway

Read `C:\Users\Sovereign\.codex\policies\execution-constitution.md` and the global Codex doorway before engineering. Read `CONTRIBUTING.md` and `SECURITY.md` in this repository.

Use an isolated `agent/*` branch, preserve unrelated changes, and run the installed Echo preflight with the actual repository, task directory, SHA, session and role before engineering. A local preflight is not release or deployment authorization.

This project is proprietary ECHO code. Public reference SDKs may inform documented behavior; preserve third-party licenses when reusing their code. Do not copy the proprietary Muse executable or engine into ECHO.

For the coding-agent module, default to local inference and read-only file access. Stage edits for explicit approval, bind them to the observed original content, protect secret files and repository metadata, and keep model output untrusted. Do not add automatic paid-provider fallback, arbitrary shell execution, or deployment.

Validate with the repository lint, TypeScript build and test suite. Keep authenticated SDK calls separate from public calls. Never include credentials in evidence, diagnostics, or sessions.
