# ECHO Prime owner connections

ECHO Prime now has a local interface host, an ESH stdio connection, and a host-injected authenticated SDK broker. The creative catalog contains 183 registry capabilities across image, video, music, sound, voice and production tools. This is registry coverage, not 183 verified generation services.

The source snapshot includes NSFW-capable model metadata for Illustrious XL, NoobAI XL, Juggernaut and Wan2.2 TI2V-5B. Model listings are visible by default. No generation, provider purchase, policy change or NSFW content generation was performed during integration.

## Start

```sh
npm run build
node dist/code-main.js prime --config /absolute/path/to/reviewed-prime-config.json
```

Without `--config`, the interface runs with its saved catalog and disconnected owner status. It binds only to `127.0.0.1`. The HTML file remains an offline preview. The CLI does not read global provider configurations, copy OAuth sessions, extract credentials or register MCP servers automatically.

An explicit local configuration has `esh` and/or `sdk` entries containing a reviewed MCP stdio `command`, `args`, optional `cwd` and optional environment values. Do not put credentials in source control. A `sdk` connection additionally names its exact advertised `search`, `read`, and `invoke` tools under `tools`; optional `fixedArguments` binds the account identifier supplied by its authenticated host. ESH needs no SDK account.

An embedding application can supply its existing authenticated broker through `PrimeHub({capabilities, sdk, esh, approveEsh})` and `startPrimeServer`. The `sdkBroker` adapter verifies advertised tools and maps search/read/invoke without altering the CLI's existing authenticated/public HTTP split. It is not an OAuth implementation. A hosted OAuth connection has to be supplied through its supported host; a URL alone is not sufficient.

## Behavior

- Creative Studio searches the snapshot by medium, model or capability, includes video mode, and exposes owner request details for routes whose schema needs additional fields.
- Every submission first reads the exact capability record. Registration, identity, owner denial and health errors remain distinct. The UI reviews the exact payload, scope and cost notice before the single-use request is submitted.
- Submissions carry stable request IDs. Ambiguous responses are `uncertain`, without retries or account/model fallback. A returned job is `submitted`, not proof of a completed artifact. Use the registered owner job-status capability to inspect it.
- SDK capability discovery can also find other ECHO families. It does not grant scopes or activate a runtime. Continuity Fabric, Crystal Memory and Certification Forge remain separate owners.
- ESH status is read first. Tool schemas come from the connected owner. The standalone host exposes status/capability/session/ledger inspection. Mutating ESH tools require the embedding host's existing explicit approval callback and ESH's own policy. No grant issuance, trust changes, kill-switch reset or arbitrary ungoverned shell route is added.
- HTTP requests require the local session cookie and same-origin request header. POSTs require an exact origin. Assets are allowlisted; executables and connection configuration cannot be supplied through the browser. Owner output remains untrusted and is rendered as text.

## Observed boundaries on 2026-10-27

- Local ESH 0.2.0: 24 advertised tools, signed workspace policy, trust root present, kill inactive, ledger integrity verified by a read-only isolated process. The new local Prime host also completed status and a session-filtered ledger read over its actual HTTP API. Standard Windows process environment is preserved for signature verification; provider secrets are not inherited.
- Continuity recall and Crystal searches succeeded. Crystal found the existing Echo Music Forge project and Continuity located the existing TTS handover.
- Media backend inventory returned an internal server error twice; installed model availability remains unknown.
- Qwen Image status returned HTTP 403 requiring `image.qwen.read`. Continuity capture previously returned HTTP 403 requiring `continuity.write`. Neither scope was modified or bypassed.
- TEMPER video is disabled by owner default because of the recorded RAM budget issue. This client refuses force-enable parameters.
- The shared ESH package names `https://esh.echoomegaprime.com/mcp`, but no shared ESH tools were exposed in this chat. Package installation is not live functional acceptance.
- Shared coding remains behind the existing Omnipresence contract/admission. These integrations do not activate or certify it.

Release remains a draft. Live media generation, remote OAuth host attachment, all-owner functional acceptance, and production activation are not established by unit tests or registry metadata.
