# ECHO Prime interface

Open `index.html` for the offline visual preview, or run `echo-code prime --config <reviewed-owner-config.json>` for the local connected interface. The local host supports ESH and an authenticated SDK broker. See [INTEGRATIONS.md](INTEGRATIONS.md) for setup, owner boundaries and observed limitations.

## Living orb

Native WebGL renders a procedurally shaded sphere with fluid detail, rim light, colored reflections and orbital particles. Browsers without WebGL use an animated Canvas 2D renderer with projected 3D particles and field lines. Three palettes, graphics quality and animation controls are available from the orb or Appearance settings. Motion respects the initial system reduced-motion preference and pauses in hidden tabs.

The central ECHO / OMEGA PRIME lettering uses a polished metallic gradient, cyan/violet spectral edges and a slow moving reflection. Its colors follow the orb palette; the existing animation control pauses the shimmer, including after reload. System reduced motion keeps the lettering static. The treatment works independently of WebGL.

The Canvas renderer includes a tinted solid body beneath the reflections so the emerald sphere retains its volume through the animation. This preserves the original orb composition while strengthening its center and depth.

The responsive shell follows the user-provided emerald desktop, ECHO Prime desktop and mobile references. No Muse executable, proprietary engine, reference image or external asset is included.

## Current capabilities

- Responsive sidebar, six scene nodes, twelve distinct system entries, six creation modes and appearance controls.
- Creative Studio with 183 registry capabilities and NSFW-capable model metadata, searchable by medium or provider.
- Local drafts and preferences stored only in this browser under `echo-prime-interface-v1`.
- In Chat, Enter saves the current draft. In creative modes it opens the matching studio request. Shift+Enter inserts a newline; Ctrl/Cmd+K starts a fresh composer.
- Chat remains a draft until the shared runtime is admitted. Creative requests use the attached authenticated host, exact request review and single-use submission IDs. Offline requests are refused truthfully.
- Connection and voice controls show the actual connection prerequisite. There is no API-key field and no credential storage in this frontend.

The production integration must provide a separately admitted authenticated host and the existing bounded `runSharedTurn` adapter. Do not add credentials to static files or assume that this interface grants `continuity.write` or `coding.invoke`.

## Validation (2026-10-27)

Desktop (1363 px) and mobile (390 x 844) inspected in a browser. Mobile viewport and document widths both measured 390 px with no horizontal overflow. Mobile navigation, mode placeholder switching, palette/quality/motion selection and preference persistence checked. Chrome palette synchronization, pause and persistence were also verified in the browser. JavaScript syntax checked separately. The preview browser disables WebGL, so the Canvas renderer was visually verified; the GPU renderer still needs validation on the target hardware. This UI check does not establish live generation. The separate ESH/host acceptance and remaining SDK connection limitations are recorded in INTEGRATIONS.md.
