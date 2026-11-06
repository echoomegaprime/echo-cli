# ECHO Prime — Media auto-router and Enhance prompt

> Two features added 2026-11-05 under Commander orders: "On image gen Echo should pick the best appropriate
> model or tool; all the user should do is give a prompt." and "an Enhance prompt button for chat, image,
> video, music, whatever, that Claude or GPT or Gemini or Grok can enhance." Both are owner-only, spend
> nothing by themselves, and never fall back to another provider or tool without the owner's explicit click.

## 1. Purpose

The Media auto-router (`src/prime/media.ts`) reads a prompt, classifies what the user wants created, ranks the
SDK catalog's generation capabilities, and hands back one explicit pick plus ordered alternatives — so the
user only has to type a prompt, per the first Commander order above.

Enhance prompt (`src/prime/enhance.ts`) is the second order: a button next to the composer (chat) and the
Creative Studio brief (image/video/music/sfx/voice) that asks one model of the user's choice — Claude, GPT,
Gemini (via the Argon CLI), Grok or Qwen — to rewrite the prompt as a craft improvement, never to answer it.

## 2. How Auto routing decides

`classifyPrompt` is the deterministic, no-network rules classifier. It strips negated media words (`NEGATED`:
"no music", "without vocals", "no titles", …) before scoring so they never vote for the thing they exclude,
then scores `KIND_RULES` (per medium: `image-edit`, `video`, `music`, `sfx`, `voice`, `image`) and `CHAT_RULES`
against the remaining text. `image-edit` rules require an edit verb on "this/my photo" or a reference to the
user's own picture — a bare image noun with edit verbs still means edit, but edit verbs alone without any
image noun do not. `STYLE_RULES` tag zero or more style cues (photoreal, illustration, product, portrait,
logo, anime, cinematic, 3d, pixel, watercolor, sketch, typography) and count once for `image` when no medium
noun was named. `ASPECT_RULES` and the `duration()` helper (number words included, 1–600 s) read aspect ratio
and clip/track length. The highest-scoring kind wins ties by `MEDIA_KINDS` order; confidence is
`0.55 + 0.25 * min(top score, 1.5) − 0.2 * second-best score`, clamped to `[0.35, 0.98]`. A mode tab the user
already chose (`hint`) wins outright at confidence 1 and is never second-guessed (`source: 'hint'`).

When the rules result is **not already near-certain** (`classification.confidence < 0.9`) **and** no hint was
given (`classification.source === 'rules'`), `MediaRouter.route` runs `classifyWithModel`: one short
classification turn on the configured default provider (Qwen) through the `ModelRouter`, 15 s timeout
(`classifierTimeoutMs`). The prompt is passed through `redact()` before the model ever sees it. The system
prompt (`CLASSIFY_SYSTEM`) asks for exactly one JSON action naming a kind and zero or more styles.

- **Agree**: confidence rises (`min(0.98, rules.confidence + 0.15)`), styles are unioned, kind unchanged.
- **Disagree**: the model's kind wins only if the rules confidence was below 0.75; otherwise the rules kind is
  kept, confidence set to 0.8 if the model's kind was used, or left at the rules confidence otherwise.
- **Malformed answer** (`parseModelClassification` fails) or **tool action** instead of a classification: the
  rules result is kept unchanged and `modelReason` explains why.
- **Failure** (timeout, network, etc.): caught, logged as `prime_media_classifier_failed`, rules result kept.

In every case the classification carries `source: 'rules+model'` and `model: turn.info()` once a model turn
was attempted, so the caller can show it was consulted even when its answer was discarded.

## 3. Ranking

`describeCandidate` turns one capability record into a `Candidate`: it runs the id + description through
`EXCLUDE` first (deprecated/retired markers, test-debug entries, `.stt$`/transcribe/translate, dubbing,
voice-changer/voice-design, batch/stream/status/backends plumbing, bare `echo.llm.*` outside the
together/openrouter/fireworks namespaces, and more — anything matched here is not a generation capability at
all and never appears anywhere in a route result). A surviving id is looked up in `RANKING` (first match
wins, so specific entries precede family entries); unlisted ids fall back to `KIND_HINT` regexes to guess a
kind, or are dropped if none match. `costOf` reads the ranking's own cost tier, else the capability's
description (`$0`/on-prem → free, "COSTS QUOTA" → quota, "COSTS $" → paid-low, `max`/`ultra`/`master`/`pro` in
the id → paid-mid, else paid-low).

`rankCandidates(kind, catalog, {text, styles, aspect, durationSeconds})` scores every candidate of the
requested kind:

```
fit   = 1 + min(0.3, 0.15 × matchedStyleCount)
score = fit × HEALTH_WEIGHT[health] × COST_WEIGHT[cost] × (quality / 10) × (0.85 + 0.015 × speed)
```

`COST_WEIGHT` = `{free: 1, quota: 0.9, 'paid-low': 0.8, 'paid-mid': 0.7, 'paid-high': 0.6}`.
`HEALTH_WEIGHT` = `{green: 1, amber: 0.8, unknown: 0.6, 'unprobed-mutate': 0.5, red: 0, orphaned: 0,
unregistered: 0}`. Ties break on health weight, then cost weight, then quality, then capability id
(`a.id.localeCompare(b.id)`), all descending except the id compare.

A candidate is moved to `excluded` (never picked, never offered as an alternative) when:

- it is not registered (`c.registered === false`);
- its health maps to a zero `HEALTH_WEIGHT` (red, orphaned, unregistered — "the Studio refuses it at review");
- it is `echo.media.video_generate` — owner-disabled on TEMPER for RAM budget; this client never passes
  `force_video`;
- its id matches the source-image-only family (`-i2v`/`-r2v`/`kontext`/`imagen_edit`) — Auto never prepares
  these from a text-only brief;
- it is `echo.cartesia.tts` and the prompt is over Cartesia's 400-character bound.

`buildArguments` then shapes the exact Studio request per family (`echo.media.image_generate` gets
`style`/`width`/`height` from the classification; music/sfx get a duration field when one was parsed; voice
and sfx families get `{text: prompt}`; everything else modeled gets `{prompt}`); families it does not
recognise still get a best-effort shape but are flagged `argumentShape: 'unmodeled'` so the Studio review
shows "review request details" instead of a confident shape.

`MediaRouter.route` probes the **live health of the top 3 ranked candidates** (`probeCount`, default 3)
before finalising the order: it reads each id through the same SDK `read` that `PrimeHub.prepare` trusts, race
d against a 5 s timeout (`probeTimeoutMs`), cached 60 s per id (`PROBE_CACHE_MS`) so repeated routes in the same
minute do not re-probe. A read that throws or times out leaves that id's health `unknown` rather than
failing the route; `prime_media_probe_failed` logs the reason. The probed health replaces the snapshot health
and the catalog is re-ranked, so a probe can move a candidate between `candidates` and `excluded`.

### Quality table

Generated mechanically from `RANKING`, `COST_WEIGHT` and `HEALTH_WEIGHT` in `src/prime/media.ts`. Quality and
speed are operator-assigned defaults on a 1–10 scale, not benchmarks. The "Source of the claim" column says
where each number or style tag comes from: vendor tier naming (e.g. Pro > Flash > Flash-Lite, or
max > pro > flex > dev > schnell), the capability's own registry description, or fleet memory (an entry
Echo's own fleet has previously confirmed working).

| # | Model or tool | Matches capability ids | Kinds | Quality | Speed | Style strengths | Cost tier | Note | Source of the claim |
|---|---|---|---|---|---|---|---|---|---|
| 1 | On-prem media router (TEMPER ComfyUI / FORGE diffusers) | `^echo\.media\.image_generate$` | image | 6.5 | 6 | anime, photoreal | free | $0; picks RealVisXL (photoreal), Illustrious/NoobAI (anime), Juggernaut/SDXL on FORGE; async job | cap description (echo.media.image_generate) |
| 2 | Qwen Image on TEMPER | `^echo\.image\.qwen\.generate$` | image | 7 | 5 | typography | free | $0 on-prem exact-weight Qwen Image; needs scope image.qwen.generate (403 observed 2026-10-27) | cap description; INTEGRATIONS.md observed boundaries |
| 3 | FORGE diffusers (SDXL-class) | `^echo\.image\.generate$` | image | 5.5 | 6 | photoreal | free | $0 on-prem SDXL-class checkpoints, text-to-image only | cap description (echo.image.generate) |
| 4 | Gemini 3 Pro Image (Nano Banana Pro) | `gemini-3-pro-image` | image, image-edit | 9 | 6 | typography, product, illustration | from description | Google's top image tier; strong text rendering and editing | vendor tier naming (Pro > Flash > Flash-Lite) |
| 5 | Gemini 3.1 Flash-Lite Image (Nano Banana 2 Lite) | `gemini-3\.1-flash-lite-image\|flash-image-3\.1-lite` | image, image-edit | 7.5 | 9 | — | from description | fastest, lowest Gemini tier | vendor tier naming |
| 6 | Gemini 3.1 Flash Image (Nano Banana 2) | `gemini-3\.1-flash-image\|flash-image-3\.1` | image, image-edit | 8.5 | 8 | photoreal, product, illustration | from description | fast Gemini image tier | vendor tier naming |
| 7 | Gemini 2.5 Flash Image (Nano Banana) | `gemini-2\.5-flash-image\|flash-image-2\.5` | image, image-edit | 8 | 8 | photoreal, product, illustration | from description | verified working on the fleet Google project (2026-10, Vertex path); fast | fleet memory google-gemini-image-gen-path; vendor tier naming |
| 8 | FLUX.2 [max] (Together) | `FLUX\.2-max` | image | 9 | 5 | photoreal, cinematic, product | paid-high | BFL top tier | vendor tier naming (max > pro > flex > dev > schnell) |
| 9 | FLUX.2 [pro] (Together) | `FLUX\.2-pro` | image | 8.5 | 6 | photoreal, cinematic, product | paid-mid | BFL pro tier | vendor tier naming |
| 10 | FLUX.2 [flex] (Together) | `FLUX\.2-flex` | image | 7.5 | 7 | typography | from description | BFL flex tier (adjustable steps/guidance) | vendor tier naming |
| 11 | FLUX.2 [dev] (Together) | `FLUX\.2-dev` | image | 7 | 7 | — | from description | BFL open dev tier | vendor tier naming |
| 12 | FLUX 1.1 [pro] (Together) | `FLUX\.1\.1-pro` | image | 8 | 7 | photoreal | paid-mid | previous BFL pro tier | vendor tier naming |
| 13 | FLUX.1 Kontext [max] (Together) | `FLUX\.1-kontext-max` | image-edit | 9 | 5 | — | paid-high | editing model; needs a source image | vendor product line (Kontext = in-context editing) |
| 14 | FLUX.1 Kontext [pro] (Together) | `FLUX\.1-kontext-pro` | image-edit | 8.5 | 6 | — | paid-mid | editing model; needs a source image | vendor product line |
| 15 | FLUX.1 [schnell] | `FLUX\.1-schnell\|flux-1-schnell` | image | 6 | 10 | — | from description | BFL fast/distilled tier | vendor tier naming |
| 16 | Juggernaut Lightning Flux (Together) | `Juggernaut-Lightning-Flux` | image | 7 | 9 | photoreal, portrait | from description | RunDiffusion photoreal, lightning (few-step) | vendor model naming |
| 17 | Juggernaut Pro Flux (Together) | `Juggernaut-pro-flux` | image | 7.5 | 6 | photoreal, portrait | from description | RunDiffusion photoreal pro | vendor model naming |
| 18 | Seedream 4.0 (Together) | `Seedream-4\.0` | image, image-edit | 8.5 | 7 | photoreal, product, typography | from description | ByteDance current image tier | vendor version ordering |
| 19 | Seedream 5.0 Lite (Together) | `Seedream-5\.0-lite` | image | 8 | 8 | — | from description | ByteDance lite tier | vendor tier naming |
| 20 | Seedream 3.0 (Together) | `Seedream-3\.0` | image | 7 | 7 | — | from description | previous ByteDance tier | vendor version ordering |
| 21 | GPT Image 2 | `gpt-image-2\|gpt-5\.4-image-2` | image, image-edit | 8.5 | 5 | typography, illustration, product | paid-mid | OpenAI current image model; strong instruction following and text | vendor version ordering |
| 22 | GPT Image 1.5 | `gpt-image-1\.5\|gpt-5-image(?!-mini)` | image, image-edit | 8 | 5 | typography, illustration | paid-mid | OpenAI previous image tier | vendor version ordering |
| 23 | GPT-5 Image Mini | `gpt-5-image-mini` | image | 7 | 7 | — | from description | OpenAI small image tier | vendor tier naming |
| 24 | Imagen 4 Ultra (Together) | `imagen-4\.0-ultra` | image | 8.5 | 5 | photoreal | paid-mid | Google Imagen top tier | vendor tier naming (Ultra > standard > Fast) |
| 25 | Imagen 4 Fast (Together) | `imagen-4\.0-fast` | image | 7.5 | 9 | — | from description | Google Imagen fast tier | vendor tier naming |
| 26 | Imagen 4 (Together) | `imagen-4\.0` | image | 8 | 7 | photoreal | from description | Google Imagen standard tier | vendor tier naming |
| 27 | Ideogram 4.0 (Together) | `ideogram-4\.0` | image | 8 | 7 | logo, typography, illustration | from description | typography/logo specialist, current version | vendor positioning (text rendering); version ordering |
| 28 | Ideogram 3.0 (Together) | `ideogram-3\.0` | image | 7.5 | 7 | logo, typography, illustration | from description | typography/logo specialist, previous version | vendor positioning |
| 29 | Qwen Image 2.0 Pro (Together) | `Qwen-Image-2\.0-Pro` | image | 8 | 6 | typography | from description | Alibaba pro tier; strong text rendering | vendor tier naming |
| 30 | Qwen Image 2.0 (Together) | `Qwen-Image-2\.0` | image | 7.5 | 7 | typography | from description | Alibaba current tier | vendor version ordering |
| 31 | Qwen Image (Together) | `Qwen-Qwen-Image$` | image | 7 | 7 | — | from description | Alibaba first image model | vendor version ordering |
| 32 | Wan 2.6 Image (Together) | `Wan2\.6-image` | image | 7 | 7 | — | from description | Alibaba Wan image variant | vendor model naming |
| 33 | SDXL (Together) | `stable-diffusion-xl` | image | 5 | 8 | — | from description | 2023 open model | vendor version ordering |
| 34 | fal.ai (FLUX schnell default) | `^echo\.fal\.generate$` | image | 6 | 9 | — | paid-low | bounded $; default fal-ai/flux/schnell | cap description (echo.fal.generate) |
| 35 | DeepAI text2img | `^echo\.deepai\.image$` | image | 4 | 7 | — | paid-low | COSTS $, generic | cap description (echo.deepai.image) |
| 36 | Vertex Imagen edit | `imagen_edit` | image-edit | 7.5 | 6 | — | from description | needs base image | cap description |
| 37 | Vertex Imagen 3 | `imagen_generate` | image | 7.5 | 6 | photoreal | from description | Vertex Imagen 3 predict | cap description |
| 38 | On-prem video (Wan2.2 TI2V-5B on TEMPER) | `^echo\.media\.video_generate$` | video | 5 | 3 | — | free | $0 but owner-disabled on TEMPER (RAM budget); this client never passes force_video | cap description; INTEGRATIONS.md 2026-10-27 |
| 39 | Veo 3.1 Lite (Together) | `veo-3\.1-lite` | video | 8 | 7 | — | from description | Google current video, lite tier | vendor tier naming |
| 40 | Veo 3.1 (Together) | `veo-3\.1$` | video | 9 | 5 | cinematic, photoreal | paid-high | Google current video tier | vendor version ordering |
| 41 | Veo 3.0 Fast + Audio (Together) | `veo-3\.0-fast-audio` | video | 8 | 8 | — | from description | fast tier with audio | vendor tier naming |
| 42 | Veo 3.0 Fast (Together) | `veo-3\.0-fast` | video | 8 | 8 | — | from description | fast tier | vendor tier naming |
| 43 | Veo 3.0 + Audio (Together) | `veo-3\.0-audio` | video | 8.5 | 5 | cinematic | paid-high | standard tier with audio | vendor tier naming |
| 44 | Veo 2.0 (Together) | `veo-2\.0` | video | 7 | 6 | — | from description | previous Google video tier | vendor version ordering |
| 45 | Sora 2 Pro (Together) | `sora-2-pro` | video | 9 | 4 | cinematic, photoreal | paid-high | OpenAI pro video tier | vendor tier naming |
| 46 | Sora 2 (Together) | `sora-2$` | video | 8.5 | 5 | cinematic | paid-mid | OpenAI standard video tier | vendor tier naming |
| 47 | Kling 2.1 Master (Together) | `kling-2\.1-master` | video | 8.5 | 4 | cinematic | paid-high | Kuaishou top tier | vendor tier naming (master > pro > standard) |
| 48 | Kling 2.1 Pro (Together) | `kling-2\.1-pro` | video | 8 | 5 | — | paid-mid | Kuaishou pro tier | vendor tier naming |
| 49 | Kling 2.1 Standard (Together) | `kling-2\.1-standard` | video | 7 | 6 | — | from description | Kuaishou standard tier | vendor tier naming |
| 50 | Kling 1.6 Standard (Together) | `kling-1\.6` | video | 6.5 | 6 | — | from description | previous Kuaishou version | vendor version ordering |
| 51 | Seedance 2.0 (Together) | `Seedance-2\.0` | video | 8.5 | 5 | — | from description | ByteDance current video tier | vendor version ordering |
| 52 | Seedance 1.0 Pro (Together) | `Seedance-1\.0-pro` | video | 8 | 5 | — | paid-mid | ByteDance pro tier | vendor tier naming |
| 53 | Seedance 1.0 Lite (Together) | `Seedance-1\.0-lite` | video | 7 | 7 | — | from description | ByteDance lite tier | vendor tier naming |
| 54 | MiniMax Hailuo 02 (Together) | `hailuo-02` | video | 7.5 | 6 | — | from description | MiniMax current video | vendor version ordering |
| 55 | MiniMax 01 Director (Together) | `video-01-director` | video | 6.5 | 6 | — | from description | camera-direction variant, previous generation | vendor model naming |
| 56 | Wan 2.7 T2V (Together) | `wan2\.7-t2v` | video | 7.5 | 6 | — | from description | Alibaba current text-to-video | vendor version ordering |
| 57 | Wan 2.7 I2V/R2V (Together) | `wan2\.7-(?:i2v\|r2v)` | video | 7.5 | 6 | — | from description | needs a source image/reference; not a text-only path | vendor model naming (I2V = image-to-video) |
| 58 | Wan 2.2 T2V (Together) | `Wan2\.2-T2V` | video | 7 | 6 | — | from description | Alibaba previous text-to-video | vendor version ordering |
| 59 | Wan 2.2 I2V (Together) | `Wan2\.2-I2V` | video | 7 | 6 | — | from description | needs a source image | vendor model naming |
| 60 | Vidu Q3 Turbo (Together) | `vidu-q3-turbo` | video | 7 | 8 | — | from description | fast tier | vendor tier naming |
| 61 | Vidu Q3 (Together) | `vidu-q3` | video | 7.5 | 6 | — | from description | Vidu current tier | vendor version ordering |
| 62 | Vidu Q1 (Together) | `vidu-q1` | video | 6.5 | 6 | — | from description | previous Vidu tier | vendor version ordering |
| 63 | Vidu 2.0 (Together) | `vidu-2\.0` | video | 6 | 6 | — | from description | older Vidu tier | vendor version ordering |
| 64 | PixVerse v6 (Together) | `pixverse-v6` | video | 7.5 | 6 | — | from description | PixVerse current | vendor version ordering |
| 65 | PixVerse v5.6 (Together) | `pixverse-v5\.6` | video | 7 | 6 | — | from description | PixVerse previous | vendor version ordering |
| 66 | PixVerse v5 (Together) | `pixverse-v5$` | video | 6.5 | 6 | — | from description | PixVerse older | vendor version ordering |
| 67 | HappyHorse 1.1 T2V (Together) | `happyhorse-1\.1-t2v` | video | 7 | 6 | — | from description | Alibaba HappyHorse current text-to-video | vendor version ordering |
| 68 | HappyHorse I2V/R2V (Together) | `happyhorse-1\.[01]-(?:i2v\|r2v)` | video | 6.5 | 6 | — | from description | needs a source image/reference | vendor model naming |
| 69 | HappyHorse 1.0 T2V (Together) | `happyhorse-1\.0-t2v` | video | 6.5 | 6 | — | from description | previous HappyHorse | vendor version ordering |
| 70 | ElevenLabs Music (detailed) | `music_generation\.compose_detailed$` | music | 8 | 5 | — | quota | compose with a detailed response (metadata + audio) | cap description ([POST /v1/music/detailed]) |
| 71 | ElevenLabs Music | `music_generation\.generate$` | music | 8 | 5 | — | quota | compose music from a prompt | cap description ([POST /v1/music]) |
| 72 | ElevenLabs Music (stream) | `music_generation\.stream_compose$` | music | 7 | 6 | — | quota | streaming variant; less useful for a saved artifact | cap description |
| 73 | ElevenLabs Music (voice gateway) | `^echo\.voice\.elevenlabs\.music$` | music | 7.5 | 5 | — | quota | prompt -> music in MinIO; access-gated on some tiers | cap description |
| 74 | ElevenLabs Sound Effects | `sound_generation\.sound_generation$` | sfx | 8 | 8 | — | quota | text -> sound effect | cap description ([POST /v1/sound-generation]) |
| 75 | ElevenLabs SFX (voice gateway) | `^echo\.voice\.elevenlabs\.sfx$` | sfx | 7.5 | 8 | — | quota | text -> sound effect audio in MinIO | cap description |
| 76 | ElevenLabs TTS (premium) | `^echo\.elevenlabs\.tts$` | voice | 9 | 8 | — | quota | premium speech; the fleet default voice is freeman (M Freeman, eleven_v4) | cap description; fleet memory echo-tts-default-voice-freeman |
| 77 | Echo Voice (unified TTS; chatterbox $0 default) | `^echo\.voice\.speak$` | voice | 7.5 | 8 | — | free | chatterbox on-prem by default, ElevenLabs opt-in | cap description (echo.voice.speak) |
| 78 | Cartesia TTS | `^echo\.cartesia\.tts$` | voice | 8 | 9 | — | quota | bounded speech <= 400 chars | cap description (echo.cartesia.tts) |
| 79 | Cartesia TTS (voice gateway) | `^echo\.voice\.cartesia\.tts$` | voice | 8 | 9 | — | quota | sonic-2 / sonic-turbo | cap description |
| 80 | Cartesia Sonic 3.5 (Together) | `cartesia-sonic-3\.5` | voice | 8 | 9 | — | from description | current Sonic tier | vendor version ordering |
| 81 | Cartesia Sonic 3 (Together) | `cartesia-sonic-3$` | voice | 7.5 | 9 | — | from description | previous Sonic tier | vendor version ordering |
| 82 | Cartesia Sonic 2 (Together) | `cartesia-sonic(?:-2)?$` | voice | 7 | 9 | — | from description | older Sonic tier | vendor version ordering |
| 83 | MiniMax Speech 2.8 Turbo (Together) | `minimax-speech-2\.8` | voice | 7.5 | 8 | — | from description | current MiniMax speech | vendor version ordering |
| 84 | MiniMax Speech 2.6 Turbo (Together) | `minimax-speech-2\.6` | voice | 7 | 8 | — | from description | previous MiniMax speech | vendor version ordering |
| 85 | Rime Arcana v3 Turbo (Together) | `rime-arcana-v3-turbo` | voice | 7 | 9 | — | from description | fast tier | vendor tier naming |
| 86 | Rime Arcana v3 (Together) | `rime-arcana-v3` | voice | 7.5 | 7 | — | from description | current Rime tier | vendor version ordering |
| 87 | Rime (Together) | `rime-arcana-v2\|rime-mist` | voice | 6.5 | 8 | — | from description | previous Rime tiers | vendor version ordering |
| 88 | Deepgram Aura 2 (Together) | `deepgram-aura-2` | voice | 7 | 9 | — | from description | low-latency TTS | vendor positioning |
| 89 | Orpheus 3B (Together) | `orpheus-3b` | voice | 6.5 | 7 | — | from description | open TTS model | vendor model naming |
| 90 | Kokoro 82M (Together) | `Kokoro-82M` | voice | 6 | 10 | — | from description | tiny open TTS, fastest | vendor model naming |
| 91 | Amazon Polly | `^echo\.aws\.polly_tts$` | voice | 6.5 | 9 | — | paid-low | base64 audio | cap description |
| 92 | Azure Speech TTS | `^echo\.azure\.cognitive_speech_tts$` | voice | 7 | 9 | — | paid-low | SSML, base64 audio | cap description |
| 93 | Google Cloud TTS | `^echo\.google\.speech\.tts$` | voice | 7 | 9 | — | paid-low | Cloud TTS synthesize | cap description |
| 94 | OpenAI TTS | `^echo\.voice\.openai\.tts$` | voice | 7.5 | 8 | — | paid-low | tts-1 / gpt-4o-mini-tts | cap description |
| 95 | Deepgram Aura (voice gateway) | `^echo\.voice\.deepgram\.tts$` | voice | 7 | 9 | — | paid-low | needs a vaulted key (503 noted in description) | cap description |
| 96 | ECHO_TALK pipeline | `^echo\.echo_talk\.speak$` | voice | 6 | 6 | — | free | full ARCS -> TTS pipeline, not a plain synthesizer | cap description |
| 97 | Personality Forge voice | `^echo\.personality\.speak$` | voice | 7 | 7 | — | from description | persona-configured TTS | cap description |

| Cost tier | Weight |
|---|---|
| free | 1 |
| quota | 0.9 |
| paid-low | 0.8 |
| paid-mid | 0.7 |
| paid-high | 0.6 |

| Health | Weight |
|---|---|
| green | 1 |
| amber | 0.8 |
| unknown | 0.6 |
| unprobed-mutate | 0.5 |
| red | 0 |
| orphaned | 0 |
| unregistered | 0 |

## 4. What Auto never does

- **Spend.** `MediaRouter.route` only returns a prepared `{target: 'sdk', name, arguments}` request shape; it
  never calls `prepare` or `execute`. Everything still runs through the Creative Studio's existing
  review-then-execute path, so a human reviews and submits.
- **Switch silently.** The UI never retries or substitutes a tool on its own. When a submitted pick comes back
  `blocked`, `uncertain`, `refused` or `failed`, `media-router.js` shows the failure and offers the next-best
  alternative as an explicit "Use `<label>` instead" button; nothing resubmits until the owner clicks it.
- **Prepare an image edit from a text brief.** When the classifier decides `image-edit`, `route` sets
  `picked: null` and a `reason` explaining the user needs to attach the source image in the Studio
  (Library → Use in Studio) and choose an editing-capable tool themselves; the editing tools are still listed
  so the choice is one click, not a search.
- **Substitute another kind.** When no healthy generator exists for the classified kind, `reason` says so
  explicitly ("nothing was prepared and no other kind was substituted") rather than quietly offering a
  different medium.
- **Pass owner controls.** `buildArguments` never emits `force_video` or any other owner-gated override; the
  on-prem video capability stays excluded exactly as the registry has it configured.

## 5. API

Both routes live behind `workspace.requireOwner` like every other `/api/prime/*` route: a valid same-origin
Prime session cookie plus the `X-Prime-Request: 1` header are required, or the server answers 403 "Same-origin
Prime session required". Neither route is reachable by a member or an anonymous visitor.

### `POST /api/prime/media/route`

Request:

```json
{
  "text": "a photoreal portrait of a fox at golden hour, 16:9",
  "mode": "auto",
  "fallback": "image",
  "probe": true,
  "classifier": true
}
```

`mode` is `"auto"` or one of the `MediaKind`s (acts as a hint, confidence 1, never re-classified). `fallback`
says what an unclassifiable prompt means (`"image"` for the Studio, `"chat"` for the composer). `probe` and
`classifier` default to `true` and let tests or callers skip the live health probe / model classification turn.

Response:

```json
{
  "classification": {
    "kind": "image",
    "confidence": 0.91,
    "styles": ["photoreal"],
    "aspect": "16:9",
    "signals": ["photo-craft", "model:image"],
    "source": "rules+model",
    "model": {"id": "qwen", "label": "Qwen", "requested": null, "model": "qwen2.5", "reported": true, "answered": true}
  },
  "picked": {
    "id": "gemini-3.1-flash-image",
    "cap": "gemini-3.1-flash-image",
    "label": "Gemini 3.1 Flash Image (Nano Banana 2)",
    "provider": "unknown",
    "reason": "Picked Gemini 3.1 Flash Image (Nano Banana 2) because image + photoreal · health green (probed now) · provider charges apply · quality 8.5/10, speed 8/10",
    "health": "green",
    "healthSource": "probe",
    "cost": "paid-low",
    "costNote": "provider charges apply",
    "quality": 8.5,
    "speed": 8,
    "score": 1.173,
    "argumentShape": "unmodeled",
    "note": "fast Gemini image tier",
    "request": {"target": "sdk", "name": "gemini-3.1-flash-image", "arguments": {"command": "generate", "options": {"prompt": "a photoreal portrait of a fox at golden hour, 16:9"}}}
  },
  "alternatives": [],
  "excluded": [{"id": "echo.media.video_generate", "label": "On-prem video (Wan2.2 TI2V-5B on TEMPER)", "reason": "owner-disabled on TEMPER (RAM budget); this client never force-enables video"}],
  "probe": {"probed": ["gemini-3.1-flash-image"], "source": "live"}
}
```

`reason` (top-level) is only present when nothing was picked — chat, `image-edit` without a source, or no
healthy generator for the kind. Error statuses: **400** for an invalid request shape, an empty or
over-12,000-character prompt, or an invalid `mode`/`fallback`/`probe`/`classifier` value.

### `POST /api/prime/enhance`

Request:

```json
{"mode": "image", "text": "a fox in a forest", "provider": "claude"}
```

`mode` is `"chat" | "image" | "video" | "music" | "sfx" | "voice" | "auto"` (`"auto"` runs the rules classifier
on the text and maps `image-edit` to `image`). `provider` is one of `"claude" | "gpt" | "grok" | "argon" |
"qwen"`; omitted, it uses the configured `ModelRouter` default.

Response:

```json
{
  "mode": "image",
  "text": "a fox in a sunlit forest clearing, photoreal, warm golden-hour light, shallow depth of field, 85mm lens, detailed fur texture. Negative: text, watermark, extra limbs",
  "added": ["warm golden-hour light", "shallow depth of field", "85mm lens"],
  "addedSource": "model",
  "provider": "claude",
  "providerLabel": "Claude",
  "model": {"id": "claude", "label": "Claude", "requested": null, "model": "claude-opus-4", "reported": true, "answered": true},
  "inputChars": 18,
  "outputChars": 162,
  "durationMs": 2140
}
```

`classified` is present only when `mode: "auto"` was requested: `{kind, confidence}` from the rules
classifier. Error statuses:

| Status | Meaning |
|---|---|
| 400 | Invalid request shape, empty or over-4,000-character text, invalid `mode`, or unknown `provider` |
| 429 | Enhance limit reached — 10 requests per 60 s per Prime session; nothing was sent to a model |
| 499 | The request was interrupted (client aborted) |
| 502 | The provider failed, returned a tool action instead of an enhancement, returned an empty answer, or returned over 6,000 characters |
| 503 | The provider is unavailable, or the reviewed Prime configuration has no `models` section at all |
| 504 | The provider did not answer within the 120 s turn timeout |

**No fallback provider, ever.** Every failure path names the provider that failed and states plainly that no
other provider was used; nothing retries automatically on a different model.

## 6. Enhance rules

`ENHANCE_SYSTEM` has one system prompt per mode (`chat`, `image`, `video`, `music`, `sfx`, `voice`), each
layered on the shared `PRESERVE` rule: keep the user's subject, constraints, names, numbers and references
exactly; **never add facts, names, brands, places, dates, statistics, quotes or claims the user did not
supply** — only craft and specificity about how the result should look, sound or read; never invent a
duration, length, count or size the user did not give (say "default length" instead); state assumptions
explicitly rather than asking questions; make only light improvements when the prompt is already complete;
write in the user's language; improve the prompt, never answer it or generate the artifact.

Per-mode coverage: `chat` clarifies intent, implied constraints and output format; `image` covers subject,
composition, lens/camera, lighting, colour/mood, style, detail level and a "Negative:" list, one paragraph
under 120 words; `video` covers shot description, motion, camera movement, duration (only if given), lighting,
pacing and style, under 120 words; `music` covers genre, tempo, key, instrumentation, structure, mood,
production and vocals/instrumental, under 120 words; `sfx` covers source, texture, attack/decay, space,
layering and looping, under 60 words; `voice` keeps the spoken words unchanged (typo fixes only) and adds
bracketed delivery notes (pace, emotion, emphasis, pauses, pronunciation) without changing meaning or adding
lines.

Input is capped at 4,000 characters (`ENHANCE_MAX_INPUT`) and output at 6,000 (`ENHANCE_MAX_OUTPUT`). The
model answers under a fixed JSON `OUTPUT_CONTRACT`: `{"text": "<improved prompt>", "added": ["<short phrase>",
...]}`. `PromptEnhancer.admit` enforces a sliding window of 10 requests per 60 s per session key; the key is a
SHA-256 hash of the Prime session cookie (`createHash('sha256').update(supplied).digest('hex')` in
`server.ts`) — the raw cookie is never used as the key and never logged. Input, the model's output and every
entry of `added` are passed through `redact()` before being returned or logged.

"What I added" is the model's own `added` list when it gives one (`addedSource: 'model'`); when it gives none,
`derivedAdditions(original, enhanced)` walks the enhanced text split on punctuation/brackets and keeps phrases
that do not appear (case- and punctuation-normalised) in the original, up to 12 phrases (`addedSource:
'derived'`) — an honest diff rather than an invented explanation.

The answering model is reported via `turn.info(): AnswerInfo` — the model id when the CLI reports one
(`reported: true`), otherwise the UI shows "model not reported by `<provider>`".

## 7. UI

**Composer**: an "Auto" tab is prepended to the mode tabs (`ui/echo-prime/media-router.js`). Selecting it
changes the prompt placeholder and, on submit, intercepts the composer's own submit handler (capture phase) to
call `POST /api/prime/media/route` with `mode: 'auto', fallback: 'chat'` instead of sending a chat message; a
`chat` classification falls through to a normal chat send, anything else opens the Creative Studio
(`EchoPrimeStudio.open('auto', text, null, route)`) with the route already attached so it is not re-fetched.
An "Enhance" control (the page's own `#i-spark` sparkle icon, a provider `<select>`, and an "Undo enhance"
button) sits in the composer's send-actions row.

**Creative Studio**: `"Auto · Echo picks the tool"` is the first `<option>` in the medium `<select>`
(`#creative-category`) and is what the Studio opens to from the sidebar/nav entry (`studio.open('all', …)` is
treated as `'auto'` by the wrapped `open`). Choosing a specific medium (Images, Video, Music & songs, Sound
effects, Voice) still routes Auto, just scoped to that one kind (`HINT_OF_CATEGORY`). The Auto panel shows the
pick's label/provider, its reason, and badges for classification confidence + styles, health, cost note, and
quality/speed; an unmodeled argument shape gets an extra "review request details" badge. `studio.apply()`
pre-selects the picked capability and writes its exact prepared arguments into the request-details textarea.

**Override**: "Use a different tool (`N`)" expands a list of every ranked alternative (label, provider,
health, cost, quality/10) plus the excluded tools and why; clicking one calls `studio.apply()` with that
candidate instead — an explicit, one-click override, never automatic.

**Failure offer**: `window.addEventListener('echo-studio-executed', …)` watches for the Studio's own
`blocked`/`uncertain`/`refused`/`failed` states on the exact capability Auto picked. It shows what happened and,
if another untried alternative exists, a single "Use `<label>` instead" button; clicking it is the only thing
that moves the pick forward — nothing resubmits by itself.

**Undo**: Enhance records the textarea's previous value before replacing it; "Undo enhance" restores it and
clears the "what I added" list.

**Provider chip**: a `<select>` next to each Enhance button lists the providers the reviewed `models` section
has configured (`claude`, `gpt`, `grok`, `argon` as "Gemini (Argon)", `qwen`), disabling unavailable ones;
the chosen provider persists across both the composer and Studio Enhance controls for the session.

**Never auto-send**: Enhance only replaces the prompt textarea's text and dispatches an `input` event; it never
calls `form.requestSubmit()` or any execute path. Auto routing only prepares a request for review; the Studio's
existing "Review request" → "Run this exact request" buttons are still the only way anything is submitted.

## 8. Known gaps

- Image edits are never auto-prepared: the user must attach a reference in the Studio and pick an
  editing-capable tool themselves. Whether a given editing capability actually consumes the Studio's upload
  ids once attached (`inputs: [{upload_id, role}]`) has not been verified end to end.
- Quality and speed in `RANKING` are operator-assigned defaults for ordering purposes, not measured
  benchmarks; treat the numbers as relative, not absolute.
- Argument shapes for capability families `buildArguments` does not model are flagged `argumentShape:
  'unmodeled'` and surfaced in the UI as "review request details" rather than guessed at silently.
- The optional Qwen classification turn (15 s timeout) and the live health probes (5 s timeout each, up to 3
  per route) both add latency to a route call; `probe: false` / `classifier: false` exist for callers that
  need to skip them.
- The ranking is static: nothing here learns from which picks actually succeeded or failed over time.

## 9. Tests

`tests/prime-media.test.ts`, `tests/prime-enhance.test.ts`, `tests/prime-media-ui.test.ts`.

## 10. Logging

`debuglog('echo-prime')` (`NODE_DEBUG=echo-prime`) events: `prime_media_routed`, `prime_media_classifier_failed`,
`prime_media_probe_failed`, `prime_enhance_started`, `prime_enhance_finished`, `prime_enhance_refused`. None of
these log the prompt text itself.
