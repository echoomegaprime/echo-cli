# Echo Prime video agents

Commander order (2026-11-04): "Add agent building for making videos. Multiple prompts and inputs can be used."

The video agent builder turns a brief, one prompt per shot and any number of input ids into an editable storyboard, then into an
Echo ADK agent (role `producer`, name `video-<slug>`) that produces the video through governed capability calls. It lives in:

| Part | File |
|---|---|
| Planner, catalog discovery, input resolution, definition, run prompt | `src/prime/videoagent.ts` |
| Owner-only routes | `src/prime/server.ts` (`/api/prime/video/*`, operation `video`) |
| Hub wiring (catalog cache, create, run) | `src/prime/hub.ts` (`videoStatus`, `videoPlan`, `videoAgent`, `videoRun`) |
| UI: "Video agent" tab in Agents, "Make a video agent" in Studio Video mode | `ui/echo-prime/videoagent.js`, `ui/echo-prime/videoagent.css` |
| Tests | `tests/prime-videoagent.test.ts`, `tests/prime-videoagent-ui.test.ts` |

## Flow

1. **Plan.** The owner writes a brief, adds prompt rows (add, remove, reorder; 1 to 18), picks input chips from the uploads
   library and the Artifact Center, and sets style, aspect and total duration. `POST /api/prime/video/plan` returns the storyboard.
2. **Edit.** Every shot is editable: prompt, duration (2 to 15 s), camera, motion, an optional voice-over line (up to 800
   characters, narrated in the `freeman` voice) and which inputs it uses. Re-plan sends the edited storyboard (`shots`) back; the
   server recomputes capabilities, steps, budget and the hash.
3. **Create.** `POST /api/prime/video/agent` recomputes the plan from the storyboard and creates the agent through
   `AdkClient.createAgent` (`POST /agents` on `echo-adk-api`). The same storyboard twice returns the existing agent (`existing:true`,
   HTTP 200); a `video-<slug>` name already used by another storyboard is refused with 409 (nothing is renamed or replaced; set a name).
4. **Run.** `POST /api/prime/video/run {agent, budget?}` starts an ADK run with a fixed prompt (the storyboard is in the agent's
   instruction). The UI polls `GET /api/prime/adk/runs/<id>`, shows every step (capability, tier, verdict, model that answered), gated
   and unavailable steps, the Proof, and finally the delivery (final text plus Proof artifacts: every shot with its state, job id and
   output path, every narration clip, every failed step), which it saves to the Artifact Center as a `video` artifact with provenance
   `source:"adk"`.

## Routes (all owner-only, same-origin Prime session, no tokens)

| Route | Body | Answer |
|---|---|---|
| `GET /api/prime/video/status` | none | `{configured, adk, catalog, uploads, reason?}`; requests nothing |
| `POST /api/prime/video/plan` | request form `{brief, prompts[], inputs?, style?, aspect?, duration_s?, name?}` or storyboard form `{brief, inputs, style, aspect, name?, shots[]}` | `200 {plan}` |
| `POST /api/prime/video/agent` | same as plan (normally the storyboard form) | `201 {agent, plan, existing:false}` or `200 {…, existing:true}`; 503 without the live catalog or ADK; 400 when the plan is not ready or the service refuses; 409 name taken |
| `POST /api/prime/video/run` | `{agent:"video-…", budget?}` | `202 {runId, agent, status, budget}`; 400 for a non-video or non-producer agent |

Inputs are ids only: `upl_<32 hex>` (uploads), `art_<32 hex>` (Artifact Center) or a Workspace library id. Bytes, data URIs,
long base64 runs, URLs, paths and credential-shaped strings are refused anywhere in a request. Kinds come from the stored metadata
(the browser's kind is ignored for uploads and artifacts): image, video → `clip`, audio, document → `script`, other → `reference`.

## Capabilities: live catalog only

Capability ids are chosen from the live catalog through the SDK broker, never from a hardcoded fallback:

- Discovery reads the exact candidates `echo.media.video_generate`, `echo.media.job_status`, `echo.voice.speak`, `echo.elevenlabs.tts`
  and runs bounded searches (`video_generate`, `job_status`, `text to speech`, `ffmpeg`, `stitch`, `concat`); relevant search hits are
  read too (12 reads at most, 8 s timeout each phase). Only ids that read back `registered`, not red/orphaned/retired, and inside the
  service's id grammar (`^echo\.[a-z0-9_]+(\.[a-z0-9_]+)*$`) are kept, so `echo.llm.together.Wan-AI-…` style ids are never chosen.
  The verified set is cached for 60 s.
- Routing picks the best id per role: video generation, job polling (when the generator is an `echo.media.*` job), narration (only
  when a shot has a voice-over line; `echo.voice.speak` is preferred because it resolves the `freeman` persona voice) and stitching.
- A role the catalog cannot fill is listed in `plan.missing` and the plan is `ready:false`; Create is refused with that list.
- Without an SDK broker (`sdk` section absent) the storyboard still plans, `catalog.live` is false, no capability is chosen and Create
  answers 503 with the reason.
- No stitch or concat capability exists in the live catalog today (2026-11-05). The plan says so and the agent delivers every shot in
  order (job ids and output paths) plus each narration clip; it is told never to claim a joined video.

Shot modes: `text_to_video` (prompt only), `image_to_video` (an Artifact Center image made by `echo.media.image_generate`: its stored
router `job_id` becomes `image_job_id`; the routed capability animates router-generated images only, so uploaded images are listed as
references and the shot is generated from its prompt, with a warning) and `clip` (an uploaded or artifact video used as-is, no
capability).

## Definition, budget and limits

- `name` `video-<slug>` (slug of the name, else the brief, at most 40 characters), `role` `producer`, `skills`
  `storyboard, generate, narrate, stitch, qc, deliver`, `capabilities` the routed live ids in step order.
- Lane `forge` / `qwen-local`. Echo ADK counts lane-model cost only, which is 0 on `qwen-local`, so `max_cost_usd` is 0. Provider quota
  (for example ElevenLabs behind `echo.voice.speak`) is charged by the provider, not by the ADK budget.
- `max_calls` = shots×8+6 and `max_wall_s` = shots×300+120, clamped to the service caps (120 calls, 4800 s); `budget.clamped` says so.
- `max_steps` = shots×3+6, at most 60 (the service allows 64). `AdkClient.createAgent` takes a per-call `maxSteps` ceiling for this;
  every other caller keeps the 24-step clamp.
- Every ADK step is one model turn with at most one capability call, and `echo.media.video_generate` is asynchronous (`wait false`,
  returns a `job_id`). The instruction therefore orders the work: submit every shot, narrate, then check each job with
  `echo.media.job_status` in shot order and re-check only the jobs still running. `plan.estimate.status_checks` is what the step budget
  leaves for those checks (max_steps − submissions − narrations − stitch − 1 final step); 2 shots get 9 checks, 18 silent shots 41,
  18 narrated shots 23. Below two checks per shot the plan warns. A shot still rendering when the checks run out is delivered as
  "still rendering" with its job id (the router job keeps running and can be checked later); the agent never waits in a loop and never
  resubmits a shot.
- `origin` `{by:"echo", prompt_sha256}` where the hash covers the brief, style, aspect, name, input ids and every shot field. On the
  wire the origin carries only `by` and `prompt_sha256`: the service stamps `created_at` and refuses anything else.
- The instruction holds the whole storyboard (resolution in multiples of 32, 24 fps, frames 4n+1 per shot, camera, motion, inputs,
  voice-over lines and the exact parameters to pass). When 18 long prompts do not fit the 12000-character limit, each prompt is
  shortened evenly and the plan lists the shortened shots; the full prompts stay on the storyboard.

## Production state (2026-11-05)

The code is complete and tested against stand-ins (fake live catalog, fake owner store, a fake `echo-adk-api` that enforces the real
service's create rules, and a fake DOM). It does not make a video in production yet, for three reasons outside this code. Each is
named in the UI when it applies; nothing is silently substituted.

1. **No live catalog in production Prime.** `/home/forge/prime-prod/prime.prod.json` has no `sdk` section, so `GET /api/prime/video/status`
   reports `catalog:false`, storyboards plan with `ready:false` and Create answers 503. Remedy: deploy the SDK bridge
   (`dist/bridge/sdk-stdio.js`, see `PRIME_SDK_BRIDGE.md` on the sdk-bridge branch) and add its `sdk` block to the config:

   ```json
   "sdk": {
     "command": "/usr/bin/node",
     "args": ["/home/forge/prime-prod/app/dist/bridge/sdk-stdio.js"],
     "env": {"ECHO_GATE_URL": "http://127.0.0.1:8000/sdk/invoke", "ECHO_PRIME_SDK_KEY_FILE": "/home/forge/prime-prod/sdk-bridge.env"},
     "tools": {"search": "sdk_search", "read": "sdk_read", "invoke": "sdk_invoke"}
   }
   ```

   then restart `echo-prime-web`; startup reports `"sdk":true`.
2. **echo-adk-api 0.1.0 is default-deny.** Its registry holds only the builtin ids (knowledge, caps, context, monitor, shell, builds), so
   `POST /agents` with the media and voice ids is refused with `400 invalid` (capabilities not in the registry), shown verbatim in the UI.
   Remedy: a capabilities file in the `{"caps":[<echo.caps.detail cap objects>]}` form that `CapabilityRegistry.load_json` accepts,
   holding `echo.media.video_generate`, `echo.media.job_status`, `echo.voice.speak` and `echo.elevenlabs.tts` exactly as
   `echo.caps.detail` returns them (tier and scope come from the gate, never typed by hand). Put it at `ECHO_ADK_CAPS_FILE` or
   `<state dir>/capabilities.json` (`/var/lib/echo/echo-adk/capabilities.json` per the echo-adk deploy README; confirm with
   `systemctl show echo-adk-api -p Environment`), then restart `echo-adk-api`; its `capabilities_loaded` log event (with the file path and `count` 4) confirms it.
3. **TEMPER video is disabled by default** according to the `echo.media.video_generate` description. A run then ends each generate step
   with that capability's own refusal, named in the run view, and nothing reroutes to another provider. Enabling it is a media-router
   setting outside Prime.

This build ran on ANVIL because FORGE was unreachable (Tailscale `forge-2` offline, no LAN answer) for the whole session, so none of the
three remedies could be applied or checked live.
