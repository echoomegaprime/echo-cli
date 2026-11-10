# CLI provider execution and containment

Prime's chat deadline, model deadline, tool budget and delegated-agent limits are independent. A longer chat deadline does not grant a vendor CLI its own unreviewed tools or unbounded child processes.

## Native admission

`providerExecutionBlock(provider, platform)` describes an unavailable native lane before it is probed or started. These restrictions apply to the default subprocess runner and are not browser or JSON configuration settings.

| Lane | Native execution |
| --- | --- |
| Local Qwen HTTP model | Unchanged; this does not use the CLI runner |
| GPT through Codex CLI | Unavailable until a model-only native-tool contract is qualified |
| Any CLI provider on Windows | Unavailable until owned Windows Job Object containment is qualified |
| Other CLI providers on POSIX | Existing provider arguments and sandbox settings, with the owned process-group lifecycle below |
| Constructor-injected runner | Trusted host integration only; the host owns its execution and containment contract |

An unavailable provider reports its specific reason. It does not execute an authentication probe, copy credentials, silently select another provider, or fall back to a less restrictive execution profile. An injected runner is supplied by application code; it is not a user prompt, browser field, or accepted startup-config option.

## POSIX process lifecycle

The native runner launches a fixed Node supervisor as the leader of a new POSIX process group. The supervisor launches the vendor with the original command and argument array, the existing filtered environment, and `shell:false`. The vendor receives the same input and no supervisory IPC descriptor. No command or prompt is interpolated into the supervisor's program.

The supervisor remains alive after the vendor exits, including when a descendant keeps its output pipes open. This anchors the group identity until cleanup and avoids scheduling a later kill against a reused vendor PID. The supervisor kills its own group if its parent disconnects.

Every terminal outcome sends one immediate `SIGKILL` to the still-live supervisor's owned group. This includes normal completion, spawn failure, Stop, model timeout and output overflow. Graceful vendor shutdown is not claimed. The runner settles once without waiting for an uncooperative process's `close` event, stops consuming output, and removes its deadline and abort listener. Normal completion is accepted only after all bounded stdout and stderr have been drained.

`CliModel` accepts output only after an explicit exit code zero. A null exit code from signal termination or any nonzero exit is rejected before parsing, attribution or refusal detection, even if the process printed valid-looking output first. The caller-death regression terminates an owned calling process and checks the recorded supervisor, vendor and descendant identities through the actual IPC-disconnect cleanup path.

An already-aborted operation creates no subprocess. `CliModel` also checks before creating its temporary directory, and rejects an answer that arrives after its signal was aborted. Such an answer cannot update the provider/model attribution.

Output and model limits remain independent. The model's stdout bound is unchanged; captured stderr is capped at 8,000 bytes. Provider arguments, environment filtering, context limits, model timeouts and vendor sandbox settings are unchanged by the process lifecycle repair.

### Scope of containment

This is cleanup of the owned POSIX process group. It is not a Linux namespace or cgroup sandbox and does not claim control over a descendant that deliberately creates a separate session/group. It also cannot undo a request already dispatched to a remote model or tool. Qualified vendor profiles must retain their separate authorization and tool-isolation requirements.

If group signalling fails or the supervisor exits unexpectedly, the runner returns the fixed safe diagnostic:

> Provider process group cleanup could not be confirmed; outcome unknown

`CliModel` preserves that reason, including during cancellation. It does not forward raw vendor error text or report that the work stopped. An operator must inspect the affected work before retrying.

## Windows restoration requirements

`taskkill /PID <parent> /T /F` is insufficient when the vendor parent has already exited but a descendant retains output pipes. The native Windows runner therefore fails before any process is spawned.

Restoration requires an independently qualified Windows launcher with an owned Job Object or an equivalent supported containment primitive. The child must be assigned before it can create uncontrolled descendants; job lifetime and breakaway policy must prevent surviving children after launcher loss. The launcher must preserve subscription authentication, the filtered environment, exact argument/input handling, byte bounds and existing vendor sandbox policy. Do not introduce a credential copy, elevation, execution-policy bypass or approval bypass to obtain containment.

Native acceptance must exercise normal completion, spawn failure, pre-abort with zero creation, resistant child, parent exits first, descendant holds pipes, output overflow, Stop, deadline, caller disconnect, late output and launcher failure. Record exact OS, Node/vendor versions, candidate identity, measured settlement times and process readback. Hosted Linux tests or a mocked `taskkill` invocation do not establish this contract.

## GPT restoration requirements

`codex exec -s read-only` does not establish a model-only provider. Native Codex may use built-in tools, configured MCP servers, app connectors, plugins, hooks and nested agents outside Prime's JSON tool execution and budget accounting. OpenAI's [agent-loop description](https://openai.com/index/unrolling-the-codex-agent-loop/) explains that Codex's shell sandbox does not sandbox MCP servers. The [configuration reference](https://developers.openai.com/codex/config-reference/) documents the separate native surfaces.

A safe configuration-only probe on Codex 0.167.0-alpha.4 showed that `-c mcp_servers={}` leaves inherited MCP servers enabled because table configuration merges. `--ignore-user-config` is available in that installed CLI while retaining authentication, but it is not by itself evidence that every native tool surface is disabled. No unverified isolation flags were added to the provider.

Restoration requires a supported, pinned Codex version and a verified model-only invocation. Use owned fixture MCP, plugin/hook, local-file/shell, app, web and nested-agent requests to prove that none can execute through the nested provider. Check the actual model-facing native tool catalogue and dynamic behavior. Verify that all allowed tools still travel through Prime's registered JSON tool path and retain its independent call, time, child and spending limits.

Authentication must remain vendor-owned, and required managed rules must remain enforced. Do not use `--ignore-rules`, sandbox bypass, approval bypass or copied tokens. An explicit unavailability reason is preferable to quietly broadening the execution boundary.

## Evidence and release

Provider fixture tests are deterministic local process tests, not real-model acceptance. They do not establish native Windows qualification, production E2E, a release attestation, or deployment permission. A source repair requires checks and acceptance on the resulting exact candidate, including actual work taking more than 120 seconds and finishing within the configured 300-second chat deadline while the independent limits remain enforced.

The separately owner-enabled Build execution profile is unchanged by these provider restrictions.
