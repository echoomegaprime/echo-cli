# ECHO Prime interface

Open `index.html` in a modern browser. The interface is self-contained and makes no network calls. It is the visual frontend for the ECHO Prime build; an authenticated production host is not attached yet.

## Living orb

Native WebGL renders a procedurally shaded sphere with fluid detail, rim light, colored reflections and orbital particles. Browsers without WebGL use an animated Canvas 2D renderer with projected 3D particles and field lines. Three palettes, graphics quality and animation controls are available from the orb or Appearance settings. Motion respects the initial system reduced-motion preference and pauses in hidden tabs.

The responsive shell follows the user-provided emerald desktop, ECHO Prime desktop and mobile references. No Muse executable, proprietary engine, reference image or external asset is included.

## Current capabilities

- Responsive sidebar, six system cards, mode tabs, prompt starters and appearance controls.
- Local drafts and preferences stored only in this browser under `echo-prime-interface-v1`.
- Enter saves the current draft; Shift+Enter inserts a newline; Ctrl/Cmd+K starts a fresh composer.
- Send clearly reports that the host is disconnected. It does not call a model, write remote memory, generate media, or execute tools.
- Connection and voice controls show the actual connection prerequisite. There is no API-key field and no credential storage in this frontend.

The production integration must provide a separately admitted authenticated host and the existing bounded `runSharedTurn` adapter. Do not add credentials to static files or assume that this interface grants `continuity.write` or `coding.invoke`.

## Validation (2026-10-27)

Desktop (1363 px) and mobile (390 x 844) inspected in a browser. Mobile viewport and document widths both measured 390 px with no horizontal overflow. Mobile navigation, mode placeholder switching, palette/quality/motion selection and preference persistence checked. JavaScript syntax checked separately. The preview browser disables WebGL, so the Canvas renderer was visually verified; the GPU renderer still needs validation on the target hardware. No live service connection is claimed.
