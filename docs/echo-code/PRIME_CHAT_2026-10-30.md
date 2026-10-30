# Prime shared chat connection

The Prime composer can send a read-only coding turn through an explicitly attached
shared coding host. It uses the existing `runSharedTurn`, workspace protections,
session journal and evidence collection. It does not create a second agent engine.

An authenticated embedding host constructs `SharedChat` from its existing
`Workspace`, `SessionStore`, `CodingInvoker` and real `CodingAdmission`, then passes
it as `chat` to `PrimeHub`. The invocation adapter must honor the supplied
`AbortSignal` on its actual transport. The contract and `coding.invoke` scope are
checked before prompt or workspace content is sent. The admission pins, model,
workspace and invoker never come from browser requests.

The same-origin `/api/chat` JSON route accepts only a fresh UUID `requestId`, a
nonempty prompt of at most 12,000 characters and an optional existing UUID
`sessionId`. Browser policy overrides are refused. The existing cookie, Host,
Origin, fetch-header, request-size and concurrency guards apply. Each host allows
one active turn, at most 1,000 submitted request IDs, ten inference steps per turn,
and a two-minute turn deadline. Request replay protection is process-local; a host
restart does not provide exactly-once execution. There is no automatic retry.

The browser displays literal answer text, an explicit unverified-model-text label,
turn status, session ID and source hashes. It retains its current session across
turns. New conversation resets the browser's session binding; durable sessions
remain in the host's existing store. The interface's sidebar continues to hold
local prompt drafts, rather than claiming to be a durable transcript browser.
Disconnected or failed requests preserve the draft. Stop, new conversation,
page exit and an HTTP disconnect propagate cancellation. Provider cancellation
remains best effort; abandoning a response is not proof that inference stopped.

Set `NODE_DEBUG=echo-prime` for structured lifecycle metadata. Debug output omits
prompts, answers, workspace paths, provider bodies and credentials.

## Validation and live boundary

The local integration suite uses the real HTTP server, adapter, shared turn loop,
workspace and session store, with only the remote owner/inference boundary replaced
by an explicit test fixture. It checks an actual read with hash evidence, durable
resume, authenticated/cross-origin behavior, strict browser inputs, scope denial
before prompt transmission, replay, overlapping turns and actual HTTP disconnect
cancellation. Browser-module tests check literal rendering, session continuation,
disconnected drafts and stale-response suppression. Fixture admission values are
test-only and confer no live authority.

The standalone `echo-code prime` command still attaches only its reviewed ESH and
SDK connections. It does not synthesize coding admission from an SDK attachment or
silently fall back to local Ollama. The live shared coding profile remains
unregistered as of this work; the standalone preview therefore reports chat
disconnected. Source wiring and fixture acceptance do not establish live owner
admission, production certification, deployment, general model competence, voice,
phone support or public availability.
