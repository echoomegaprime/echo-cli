# Deploy: adult routing in ECHO Prime (on-prem TEMPER only)

Scope: Prime only (`echo-prime-web.service` on FORGE, `/home/forge/prime-prod/app`). No Prime config change, no new
environment variable, no secret, no router change, nothing on TEMPER. Design and rules: `PRIME_MEDIA_ROUTER.md` section 12.

## What ships

| File | Change |
|---|---|
| `src/prime/adult.ts` | New. Classifier, policy, pre-route refusals, the fields an adult request carries |
| `src/prime/media.ts` | `route` takes `adult`, `fictional`, `style`; `rankCandidates({adult})`; adult request template |
| `src/prime/hub.ts` | `prepare` gate (`adultGate`), `adultMarkers` test seam |
| `src/prime/media-jobs.ts` | `used` (model, node, backend as the router named them); adult refusals not recorded against the tool |
| `src/prime/enhance.ts` | Enhance refuses an adult picture/video brief (cloud model) |
| `ui/echo-prime/integrations.js` | Adult mode control, attestation gate, router-only tool list, model-used badge |
| `ui/echo-prime/media-router.js` | Route request carries the adult state; composer never hands an adult brief to chat; Enhance off; no next-best offer |
| `ui/echo-prime/media.css`, `index.html` | Styles; the older listing toggle relabelled "listing only" |
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

Pass: steps 2 to 4 refuse and pick exactly as stated, 5 and 6 store an image with the model and the TEMPER badge, 7 (when it
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
