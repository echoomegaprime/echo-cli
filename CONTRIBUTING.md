# Contributing

Thank you for improving Echo CLI. This is a public, proprietary infrastructure project:
contributions are welcome for review, but repository visibility does not grant a general use
or redistribution license.

## Development path

1. Open an issue describing the behavior being changed.
2. Create a focused branch from current `main`.
3. Validate before opening a pull request:

   ```powershell
   npm install
   npm run lint
   npx tsc --noEmit
   npm test
   npm run build
   ```

4. Open a pull request using the repository template and include exact command output.

## Pull-request requirements

- No secrets (API keys, gateway tokens) are included.
- No stubs, placeholders, or self-asserted readiness.
- **Any change to `src/client.ts`'s auth-vs-public request split must be called out
  explicitly** in the pull request description — `request()` (authenticated) and
  `publicRequest()` (unauthenticated) must stay distinct; accidentally merging them would
  either leak the API key on public routes or block public routes entirely.
- If you add a new command that shells out (like `deploy` wraps `wrangler`), never build the
  command string by interpolating user input — pass user-controlled values as `cwd`/`env`/args
  arrays, not string concatenation, to avoid reintroducing a command-injection surface.
