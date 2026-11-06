# Deploy: adult routing in ECHO Prime (on-prem TEMPER only)

Scope: Prime only (`echo-prime-web.service` on FORGE, `/home/forge/prime-prod/app`). No Prime config change, no new
environment variable, no secret, no router change, nothing on TEMPER. Design and rules: `PRIME_MEDIA_ROUTER.md` section 12.

## What ships

| File | Change |
|---|---|
| `src/prime/adult.ts` | New. Classifier (term families and inflections), policy, pre-route refusals (minors, real people, audio), argument scanning, capability kinds, the fields an adult request carries |
| `src/prime/media.ts` | `route` takes `adult`, `fictional`, `style`; `rankCandidates({adult})`; adult request template |
| `src/prime/hub.ts` | `prepare` gate (`adultGate`: every media tool and every non-read-only tool, every string leaf of the arguments), video-agent adult refusal, `adultMarkers` test seam |
| `src/prime/media-jobs.ts` | `used` (model, node, backend as the router named them); the router's policy and busy answers are not recorded against the tool, real failures are |
| `src/prime/enhance.ts` | Enhance refuses an adult picture/video brief and, on the new `adult` body field, anything but chat (cloud model); `auto` resolves the kind first |
| `ui/echo-prime/integrations.js` | Adult mode control, attestation gate, router-only tool list, model-used badge |
| `ui/echo-prime/media-router.js` | Route and Enhance requests carry the adult state; composer never hands an adult brief to chat; Enhance off; no next-best offer |
| `ui/echo-prime/media.css`, `index.html` | Styles; the older listing toggle relabelled "listing only" |
| `tests/prime-adult-hardening.test.ts` | The review-round tests (no test markers: real keywords through the route and the gate) |
| `docs/echo-code/PRIME_MEDIA_ROUTER.md`, this file | Docs |

Base: `9410bae` (live). The change is additive; an ordinary (non-adult) request produces byte-identical arguments.

## Prerequisites (check, do not change)

1. The v2 media router is deployed (`DEPLOY_MEDIAROUTER.md`), or the v1 router is accepted as it is. v1 ignores
   `subjects_fictional` (Prime enforces the attestation itself) and v1 supports `nsfw` and `node`.
2. `echo.media.image_generate` is registered and its health is not `red` or `orphaned`: `prepare` refuses those states
   ("Capability unavailable or unregistered") and adult mode then has nowhere to go. Check from the Studio status line or
   `echo.caps.detail`. The v2 router's `GET /backends` alias is what fixes an `orphaned` probe.
3. The gate passes `subjects_fictional` through to the router. It is not in the v2 `register_caps.sql` `input_schema_json`
   (the router reads it, and that schema, like v1, does not forbid extra properties). Smoke step 6 is what proves it; if the
   gate stripped it, the v2 router would answer 400 "an adult request must declare its subjects are fictional" and Prime would
   show that sentence verbatim. Fix by adding `subjects_fictional` (boolean) to the cap's input schema.
4. `media.localRoots` in `/home/forge/prime-prod/prime.prod.json` includes `/home/forge/echo-media/out` (the default when the
   directory is readable), so a finished file can be stored.
5. Gate green on ANVIL (never QUENCH or FORGE): `bash anvil_test.sh adult`.

## Deploy

Same atomic swap as every Prime release (`deploy_prime.sh`): build on ANVIL, ship `dist`, `ui/echo-prime`, `package.json`,
`package-lock.json` to `/home/forge/prime-prod/app.new`, stop `echo-prime-web`, `mv app app.bak-<stamp>`, `mv app.new app`,
start, `systemctl is-active echo-prime-web`. Dependencies do not change (`DEPS=0`). Record the sha in
`/home/forge/prime-prod/RELEASE_SOURCE.txt`. The browser picks up the new `integrations.js` and `media-router.js` on the next
load.

## Smoke steps (no explicit content is generated or typed)

Every step uses the neutral keyword `nsfw` (the mildest word the classifier knows) or an ordinary brief.

1. **Router listing, read-only.** On FORGE: `curl -s -m 25 http://127.0.0.1:8561/backends | jq '.backends[] | {node,up,image:[.image[]|{model,style,nsfw_capable,status}]}'`
   and `curl -s -m 25 -X POST http://127.0.0.1:8561/admission/preview -H 'content-type: application/json' -d '{}'`.
   Expect at least one `ready` model with `nsfw_capable: true` on `temper`. If there is none, adult mode will answer the
   router's plain-language "no live nsfw-capable on-prem image model … available nsfw-capable styles: …"; that is correct.
2. **Dry-run route, spends nothing.** Signed in as the owner, in the browser console on Prime (the header and cookie are the page's own):

   ```js
   const r=(b)=>fetch('/api/prime/media/route',{method:'POST',credentials:'same-origin',headers:{'x-prime-request':'1','content-type':'application/json'},body:JSON.stringify(b)}).then(x=>x.json());
   await r({text:'nsfw portrait of an invented adult woman',mode:'image'});
   await r({text:'nsfw portrait of an invented adult woman',mode:'image',adult:true,fictional:true,style:'photoreal'});
   ```

   Expect: first answer `picked: null`, `adult.refusal: "needs_adult_mode"`, reason "Adult mode must be switched on …", and no
   cloud tool anywhere. Second: `picked.id: "echo.media.image_generate"`, `picked.request.arguments`
   `{prompt, wait:false, nsfw:true, subjects_fictional:true, style:"photoreal", node:"temper"}`, `alternatives: []`, and every
   Together/OpenRouter/fal/Vertex tool under `excluded` with "adult brief: only the on-prem media router (TEMPER) is used".
3. **Server gate, spends nothing.** `await fetch('/api/prepare',…)` is the Studio's review call; with
   `{target:'sdk',name:'echo.llm.together.ByteDance-Seed-Seedream-4.0',arguments:{command:'call',prompt:'a red fox',nsfw:true}}`
   it must answer 400 "Adult briefs run only on the on-prem media router (TEMPER)".
4. **Local refusals, spend nothing.** Same route call with `adult:true,fictional:true` and the text `nsfw child` must answer
   `adult.refusal: "minor"`; the text `nsfw photo of my ex` must answer `adult.refusal: "real_person"`. Neither reaches the
   catalog or the router.
5. **An ordinary brief through the same code path (adult mode off).** Studio, Auto, "a red fox in a snowy pine forest at
   dawn, photorealistic", Review, Run. Expect the on-prem router among the picks, a queued then done job, the PNG in Library,
   and under the image "on-prem (TEMPER)" with "Model used: <model>". Arguments contain no `nsfw`.
6. **The adult path with a neutral prompt.** Studio, Adult mode on, tick "All subjects are fictional adults", Photoreal,
   brief "a lighthouse on a cliff at dusk, painterly". Review shows `nsfw:true, subjects_fictional:true, style:"photoreal",
   node:"temper"` and only the router tool in the list. Run: the router routes to an `nsfw_capable` model on TEMPER and the
   result names it. A neutral brief produces a neutral image; the point is the route, the fields and the badge. Then untick
   the box: "Review request" is disabled again.
7. **Honest failure.** With Adult mode on, style Anime, if the router has no live anime adult model, the Studio shows the
   router's sentence verbatim ("no live nsfw-capable on-prem image model for style 'anime'; available nsfw-capable styles:
   …") and offers no other tool or style.

8. **Cloud tools of every kind are gated, spend nothing.** Same `/api/prepare` call with
   `{target:'sdk',name:'echo.ai.sdk.together.image',arguments:{prompt:'nsfw portrait of an invented adult woman'}}`, with
   `name:'echo.fal.generate',arguments:{command:'call',input:{prompt:'nsfw portrait of an invented adult woman'}}`, and with
   `name:'echo.cartesia.tts',arguments:{text:'nsfw story'}`: each must answer 400. The first two say "Adult briefs run only on
   the on-prem media router (TEMPER)", the voice one says "There is no on-prem audio tool (voice)". An ordinary brief
   (`{prompt:'a red fox'}`) on `echo.cartesia.tts` must still be reviewable.
9. **Enhance and video agent, spend nothing.** `fetch('/api/prime/enhance',{...,body:JSON.stringify({mode:'image',text:'a lighthouse at dusk',adult:true})})`
   must answer 400 "Enhance sends the text to a cloud model, so it is off for adult briefs" without a model turn;
   `POST /api/prime/video/plan` with `{brief:'nsfw beach scene',prompts:['a calm beach']}` must answer 400 "The video agent
   builds on cloud providers". An ordinary storyboard still plans.

Pass: steps 2 to 4 and 8 to 9 refuse and pick exactly as stated, 5 and 6 store an image with the model and the TEMPER badge, 7 (when it
applies) shows the router text, and no request ever reaches a cloud capability (the gate execution log shows only
`echo.media.image_generate`, `echo.media.job_status`, and catalog reads).

## Rollback

```bash
ssh forge "cd /home/forge/prime-prod && ls -d app.bak-* | sort | tail -1"   # newest backup = the pre-deploy release
ssh forge "cd /home/forge/prime-prod && sudo systemctl stop echo-prime-web && rm -rf app && mv app.bak-<stamp> app && sudo systemctl start echo-prime-web && systemctl is-active echo-prime-web"
```

No data migration, nothing persisted by this change (Adult mode lives in the page and resets on reload and on every
account change), so rolling back leaves nothing behind. Switching Adult mode off in the Studio is the instant mitigation;
the server gate then still refuses any adult brief bound for a cloud tool, which is the point of it.

## Known limits (details in `PRIME_MEDIA_ROUTER.md` section 12)

- Not covered, because they are other services or products: the Views page SDK console ("Invoke capability" posts to the
  Workspace backend, not to `prepare`), the Workspace conversation, ADK runs, autonomous agents and bots. The router refuses
  what it refuses whoever calls it.
- Adult video is left to the router: Prime ranks `echo.media.video_generate` for an attested adult brief and shows the
  router's own answer (v2: canary and admission; v1: owner-disabled on TEMPER).
- A cloud voice reading text that merely contains an adult keyword is refused (there is no on-prem audio tool). The Commander
  may relax this by narrowing `adultPolicy` back to pictures and video; the cost is that adult scripts can then reach a cloud voice.
- Router v2's `sexual_regex` has no "cum laude" exemption (router-side): a diploma brief gets a 400 from the router.
