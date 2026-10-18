# Echo CLI

ECHO Code local preview: this branch adds the separate `echo-code` entry point for local model inference, bounded repository inspection, explicitly approved edits, resumable sessions and read-only MCP tools. See [the ECHO Code guide](docs/echo-code/README.md) and its acceptance report for the tested scope and model-quality limits.

Official command-line client for Echo Prime Technologies — 45+ commands across engines,
knowledge search, the shared-brain memory system, doctrine generation, chat, unified search,
tool discovery, bot deployment, scraper orchestration, dashboards, auth, and Cloudflare Worker
deploys, all proxied through the Echo SDK Gateway.

## Install

```powershell
npm install -g @echo-omega-prime/cli
echo init <your-api-key>
```

Or from source:

```powershell
git clone https://github.com/echoomegaprime/echo-cli
cd echo-cli
npm install
npm run build
npm link
```

## Configuration

The API key and gateway URL resolve in this order:

1. `--api-key` / `--gateway` CLI flags (highest priority)
2. `ECHO_API_KEY` / `ECHO_GATEWAY_URL` environment variables
3. Stored config at `~/.echo-prime/config.json` (via `echo config set`)

```powershell
echo config set apiKey <your-key>
echo config set gatewayUrl https://your-gateway.example.com
echo status
```

## Usage

```powershell
echo engine query <engineId> "your query"
echo knowledge search "your query"
echo brain search "your query"
echo doctrine generate <domain> <topic>
echo chat "hello" --personality echo_prime
echo search "unified query"
echo tools search "your task"
echo bots list
echo scrapers run <templateId>
echo dashboard usage
echo auth whoami
echo worker call <worker> <path>
echo vault get <service>
echo deploy [path] [--dry-run]
```

Run `echo --help` or `echo <command> --help` for the full command tree.

## Output formats

`--format json|table|text` (default `text`). Set a persistent default with
`echo config set outputFormat json`.

## Development

```powershell
npm install
npm run dev -- <command>   # run from source via tsx
npm test                   # vitest
npm run lint                # eslint
npm run build                # tsc -> dist/
```

## Verify

```powershell
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
```

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability — never as a public issue. The API
key is stored in plaintext at `~/.echo-prime/config.json` (standard practice for CLI tools of
this kind, matching `gh`, `npm`, and similar); treat it like any other locally-stored credential.

## License

Proprietary — see [LICENSE](LICENSE). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
