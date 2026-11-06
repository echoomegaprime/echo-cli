# Prime voice route: Echo's own voice on every reply path

Status: built and gated on ANVIL, 2026-11-05, branch `voiceroute` (merged with `parity` 44b8a89, the PR #8 head).
Not deployed. Production Prime needs the `voice` section below before the route turns on.

Commander, 2026-11-05: **"It should speak them when spoken replies is selected."**

## Why the route exists

Echo's voice (persona `freeman`, "M Freeman", ElevenLabs `eleven_v4`) already speaks **saved Workspace
replies**. The Workspace backend synthesises those itself through `/api/voice/start|next` (see
`docs/prime/PROD_WORKSPACE_FORGE.md`, section Voice). Every other reply path in Prime produces text the Workspace
never saved, so the backend cannot reach it:

| Reply path | Announced by | Before this slice | Now |
|---|---|---|---|
| ECHO Code reply | `chat.js` event `echo-code-reply` | device voice only, behind its toggle | Echo's voice, automatic when spoken replies is on, plus a "🔊 Speak" action |
| Swarm result | `swarm.js` event `echo-result-rendered` (`source:'swarm'`) | device voice only | Echo's voice, automatic + "🔊 Speak result" |
| Agents (Echo ADK) final text | `agents.js` event `echo-result-rendered` (`source:'agents'`), new in this slice, once per finished run | not spoken | Echo's voice, automatic + "🔊 Speak result" beside the final text |
| Steward advice | `steward.js` event `echo-result-rendered` (`source:'steward'`) | device voice only | Echo's voice, automatic + "🔊 Speak advice" |

All four now go through one owner-only Prime route that calls the **same loopback voice gateway, persona and
model** the Workspace uses. Prime never holds a provider key: the gateway (`echo-voice-gateway.service` on FORGE,
`http://127.0.0.1:8239`) owns the ElevenLabs credential, and Prime sends no authorization header of any kind.

## Routes (owner-only)

Both routes sit below `workspace.requireOwner` in `src/prime/server.ts`, so on a Workspace host only the primary
owner reaches them. They also need the Prime session cookie, `x-prime-request: 1` and a same-origin `Origin` (every
`/api/*` route checks these first). The request log names the operation `voice`.

### `GET /api/prime/voice/status`

Never throws for an unconfigured or unreachable gateway; it says why.

```json
{"configured":false,"available":false,"reason":"Echo's voice route is off: add a `voice` section to the Prime config"}
```

```json
{"configured":true,"available":true,"persona":"freeman","label":"M Freeman","provider":"elevenlabs","model":"eleven_v4","format":"mp3","maxChars":4000,"maxAudioBytes":5242880}
```

`available` comes from the gateway `GET /health` (`providers.elevenlabs.up === true`), checked with a 5 s timeout
and cached for 60 s. A check the browser abandoned is answered but never cached. Unavailable reasons:
`Voice gateway unreachable at http://127.0.0.1:8239`, `Voice gateway health check timed out`,
`Voice gateway reports ElevenLabs is not available`.

### `POST /api/prime/voice/speak`

Request: JSON POST, `{"text": "...", "persona"?: "freeman"}`. Any other key is refused (400). `persona`, when sent,
must equal the configured persona: only Echo's configured voice can speak here.

Text handling, before anything reaches the gateway:
- secrets redacted with the shared `redact` rules from `src/code/workspace.ts` (`api_key=` / `access_token=` /
  `secret=` / `password=` / `authorization=` values, `sk-…`, GitHub tokens, JWTs, PEM private keys);
- zero-width characters dropped, control characters and line/paragraph separators turned into spaces, whitespace
  collapsed;
- empty after normalisation: 400 `Nothing to speak after normalisation`;
- over the cap: 400 `Text exceeds 4000 characters per call; send shorter sections` (1500 for `wav`).

Gateway call (exactly the Workspace body, `allow_fallback:false`):

```json
POST http://127.0.0.1:8239/speak
{"text":"…","persona":"freeman","provider":"elevenlabs","format":"mp3","model":"eleven_v4",
 "provider_opts":{"allow_fallback":false,"voice_settings":{"stability":0.5,"similarity_boost":0.75,"style":0.6,"use_speaker_boost":true}}}
```

then `GET http://127.0.0.1:8239/public/audio/<local_artifact_id>` for the bytes (the loopback artifact; the MinIO URL
in the gateway reply is ignored, so nothing leaves loopback).

Response: `200` with the audio itself (`Content-Type: audio/mpeg` or `audio/wav`, `Content-Length`) and the headers
`X-Echo-Voice-Provider: elevenlabs`, `X-Echo-Voice-Label` (URI-encoded), `X-Echo-Voice-Model`,
`X-Echo-Voice-Chars`. The spec allowed "audio or an audio id + `GET /api/prime/voice/audio/:id`"; the route returns
the audio inline, so there is no second route, no server-side audio store and nothing to expire.

Refusals (no silent substitute, ever):

| Status | When |
|---|---|
| 400 | not an object, unknown key, other persona, non-string / empty / over-cap text |
| 403 | no Prime session, missing `x-prime-request`, cross-origin, or not the primary owner |
| 405 | not a JSON POST |
| 429 | three syntheses already in flight (`Echo's voice is busy; try again in a moment`), or the gateway answered 429 (`ElevenLabs quota or rate limit reached`) |
| 499 | the browser abandoned the request (barge-in) |
| 502 | gateway unreachable, non-2xx (`Voice gateway answered HTTP 500: tts_failed`, detail redacted and clipped), unrecognized JSON, a provider other than `elevenlabs` (`refusing a substitute voice`), a format mismatch, no loopback artifact id, audio not valid MP3/WAV (magic bytes), audio over 5 MiB (declared or streamed), gateway JSON over 1 MiB |
| 503 | no `voice` section in the Prime config |
| 504 | synthesis timed out (`timeoutMs`, default 60 s; the audio download is capped at min(timeoutMs, 30 s)); outcome unknown |

Debug events (`NODE_DEBUG=echo-prime`), never carrying text or artifact ids:
`prime_voice_speak_requested {chars, persona, model, format}`,
`prime_voice_speak_returned {chars, bytes, contentType, durationMs}`,
`prime_voice_speak_failed {status, category: interrupted|timeout|limited|gateway, durationMs}`,
plus the server's `prime_api_request {operation:'voice', status, outcome, durationMs}`.

## Browser side (`ui/echo-prime/speech.js`)

- `refreshPrimeVoice()` reads `/api/prime/voice/status` once per identity (account epoch + owner flag) with
  `x-prime-request` and the Workspace `ownerHeaders()`; an account change clears it. An "available" verdict stays
  cached for the identity (a later synthesis failure still shows its own reason); an "off" or "unavailable" verdict
  is re-read on the next reply or Speak click after one minute, so Echo speaks again once the gateway is back
  without a reload. Anonymous visitors and
  signed-in members never call the route; they get a plain reason ("sign in to an approved account" /
  "Echo's voice for these replies is owner-only").
- `speakEcho(text, {source, key})`: the same `normalizeForSpeech` the device voice uses (markdown, URLs, code
  blocks, numbers), then `primeChunks`: a short first section (≤ 220 chars) for fast first audio, then ≤ 400-char
  sections, played through the shared `createQueue` with the next section prefetched while the current one plays.
  Brief speech keeps the opening sections up to 600 chars. Text over 30,000 chars after normalisation is refused
  with a reason. Every section is one call to the route (well under the 4000-char cap).
- Automatic speech only when spoken replies is on (`voiceOptions.spoken`), not muted, and signed in. While the tab
  is hidden the reply is deferred to "Resume Echo"; an autoplay block offers "Tap to hear Echo"; both replay that
  same text. A Swarm, Agents or Steward result re-rendered with identical text speaks once (ten-minute window).
- Barge-in (typing, Send, Stop, mic, `echo-voice-stop`) and a newer reply abort the in-flight section request and
  drop the prefetch.
- Device voice (`speechSynthesis`) speaks these replies **only** when the user turned on
  "Device voice (not Echo's)" **and** the Prime route cannot speak at all (off or unavailable). If the route is
  available, Echo's voice speaks even with the toggle on. A failed synthesis is never substituted: the dock shows
  `Echo could not speak this ECHO Code reply: <reason>. No automatic retry was made.`
- Browser debug events (`console.debug('[echo.speech]', …)`, no text): `prime_voice_status`,
  `prime_voice_unavailable`, `speech_requested {route:'prime', origin, sections, mode}`, `prime_chunk_ready`,
  `prime_chunk_failed`, `speech_finished`, `speech_failed`, `speech_cancelled`, `duplicate_suppressed`.

## The exact `prime.prod.json` `voice` section to add

Add this key to `prime.prod.json` (the production config at `/home/forge/prime-prod/prime.prod.json`). The
tool-maintainer applies this; the build slice does not edit `prime.prod.json`.

```json
"voice": {
  "gatewayUrl": "http://127.0.0.1:8239",
  "persona": "freeman",
  "label": "M Freeman",
  "provider": "elevenlabs",
  "model": "eleven_v4",
  "format": "mp3",
  "timeoutMs": 60000
}
```

It matches the Workspace `voice` block (`/home/forge/prime-prod/ws/config.json`: persona `freeman`, label
`"M Freeman"`, `elevenlabs` / `eleven_v4`, gateway `http://127.0.0.1:8239`), so the dock names the same voice on
every path. It holds no secret.

Field rules (`parseVoiceConfig`, unknown fields refused):

| Field | Default | Rule |
|---|---|---|
| `gatewayUrl` | `http://127.0.0.1:8239` | credential-free loopback origin only (`127.0.0.1`, `localhost`, `[::1]`; no path, query or userinfo) |
| `persona` | `freeman` | `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `label` | `Echo` | 1–60 chars, no control characters (set `"M Freeman"` to match the Workspace) |
| `provider` | `elevenlabs` | only `elevenlabs` is accepted |
| `model` | `eleven_v4` | `eleven_v4` or `eleven_v4_turbo` |
| `format` | `mp3` | `mp3` (4000 chars per call) or `wav` (1500) |
| `timeoutMs` | `60000` | integer 5000–120000 |

After adding it, restart `echo-prime-web.service`. Verify as the owner: `GET /api/prime/voice/status` shows
`configured:true, available:true`; then send an ECHO Code message with spoken replies on and hear M Freeman.

## Files

- `src/prime/voice.ts` (new): `parseVoiceConfig`, `normalizeSpeechText`, `VoiceClient` (`status`, `speak`), limits.
- `src/prime/hub.ts`: `voice?: VoiceClient` option, `voiceStatus`, `voiceSpeak`.
- `src/prime/server.ts`: `GET /api/prime/voice/status`, `POST /api/prime/voice/speak`, operation `voice`.
- `src/prime/commands.ts`: `voice` config section wired to `VoiceClient`.
- `ui/echo-prime/speech.js`: Prime-route speech for ECHO Code, Swarm, Agents and Steward replies.
- `ui/echo-prime/agents.js`: announces the finished run's final text (`echo-result-rendered`, `source:'agents'`).
- `tests/prime-voice-route.test.ts` (new, 25 tests) and `tests/prime-speech.test.ts` (26 new tests).

## Tests

`tests/prime-voice-route.test.ts` runs a loopback stand-in gateway (no real provider is called): config defaults
and refusals (non-loopback, credentials, paths, unknown fields, persona/model/format/timeout/provider/label),
normalisation and redaction, status off / configured / unreachable / provider down / cached, the exact Workspace
request body, inline audio with headers, WAV and its cap, session/origin/method/JSON checks before any gateway
call, persona and extra-key refusals, provider substitution refused, MinIO-only and mismatched artifacts refused,
declared and streamed 5 MiB caps, bad magic, quota mapping with redacted detail, timeout / unreachable / abort,
the in-flight limit, and debug events free of text.

`tests/prime-speech.test.ts` (fake DOM) covers: ECHO Code reply spoken through the route with owner headers and no
device voice; status read once per identity; section splitting with prefetch; Brief speech; mute and spoken
replies off (the Speak action still works); anonymous and member visitors never calling the route; route off with
the reason shown once; an unavailable verdict re-read after a minute; device voice only behind the toggle and only when the route cannot speak; route failure
shown with no retry and no substitute; non-audio and oversized responses refused; barge-in aborting the in-flight
request; a newer reply replacing the current one; Swarm, Agents and Steward speak actions and automatic speech;
duplicate suppression; Tap to hear Echo and Resume Echo replays; status failures as reasons; no reply text in
debug events.

## Not done

- No live gateway round trip from Prime: every test uses a loopback stand-in. The gateway contract (`/health`,
  `/speak` body, `local_artifact_id`, `/public/audio/:id`) follows the Workspace transport facts recorded in
  `docs/prime/PROD_WORKSPACE_FORGE.md` and was not re-observed by this slice.
- `prime.prod.json` is unchanged and nothing is deployed; the route stays off in production until the section
  above is added.
