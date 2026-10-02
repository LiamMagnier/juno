# Crew kit tools

The crew characters are modeled in Blender 5.2 from these scripts (headless, reproducible).
Design notes: `src/app/dev/design/juno/crew/RATIONALE.md`.

```sh
BL=/Applications/Blender.app/Contents/MacOS/Blender
cd tools/crew/blender

# The kit for the live renderers: public/crew/{models,textures,manifest.json} and crew/kit-data.ts
$BL --background --factory-startup --python crew_export.py -- "$(git rev-parse --show-toplevel)"

# Cycles stills of the roster (tools/crew/roster.json): portraits, the group, the shape sheet
RES=1024 SPP=128 $BL --background --factory-startup --python crew_render.py -- portraits <out_dir>
RES=1100 SPP=128 $BL --background --factory-startup --python crew_render.py -- group <out_dir>
RES=900  SPP=96  $BL --background --factory-startup --python crew_render.py -- sheet <out_dir>
FORMAT=WEBP RES=640 $BL --background --factory-startup --python crew_render.py -- portraits ../../../public/crew/renders

# A quick silhouette check of every shape (Eevee)
$BL --background --factory-startup --python crew_preview.py -- /tmp/shapes.png
```

- `crew_shapes.py`  bodies as implicit surfaces, shared-topology quad meshes, face rules, anchors, AO, fur masks (numpy only)
- `crew_parts.py`   eyes, features and accessory parts in canonical frames (numpy only)
- `crew_fit.py`     places parts on a body; mirrored by `src/app/dev/design/juno/crew/fit.ts`
- `crew_bpy.py`     Blender helpers: meshes, materials, particle-hair fur, the studio, cameras
- `crew_compose.py` one character in Blender from an avatar config
- `crew_render.py`  Cycles stills; `crew_export.py` the kit; `crew_furtest.py` fur look-development

## Alevr Orbit agents: flocked designer toys (Oct 2026)

User-facing these are Alevr Orbit **agents** (never "crew"); `crew/` stays as the
stable technical path. The plush v1 read as creepy next to OpenAI's dots (long
shaggy fur, glossy bead eyes with catchlights, dusty colours, amorphous outlines).
The `flock_*` pipeline replaces it with a flocked designer-toy finish:

- **Velvet flock**: a clean body (microfibre sheen tinted toward the body colour,
  fine grain) under a SHORT, dense, UPRIGHT pile (fibre ~1.2% of the body height,
  65k/unit², 14% direction spread). Upright fibres are seen end-on on the face, so
  the surface reads as smooth velvet with a soft fuzzy rim instead of terry towel.
- **Graphic eyes, big**: matte dots, pills, round buttons, closed arcs, white
  stickers with a black pupil, opaque one-piece shades, raised as appliques.
  `EYE_SCALE` 1.65; line-like styles scale less (`STYLE_SCALE`) so arcs never
  merge into a brow or a moustache. No catchlight, iris, mouth or blush.
- **Bold silhouettes and accessories** of our own; a clean saturated palette.
- **Key art** like the dots composition: `lineup` with `PPU` (fixed scale) and
  `EYEUP` (every eye line the same height above the bottom edge; bodies sink).
- Agents never become planets (the C sheet's planet became Volt, a bolt).

```sh
BL=/Applications/Blender.app/Contents/MacOS/Blender
# every render of a pass (portraits front + 3/4, icon views, lineups, variants)
RES=800 SPP=160 PPU=350 EYEUP=0.24 OVERLAP=0.16 bash tools/crew/flock/render_pass.sh <out_dir> A B C
# the cast as JSON, then the sheets (light/dark, icons at 20/32/64 px, dots comparison)
$BL --background --factory-startup --python tools/crew/blender/flock_dump.py -- <out_dir>/cast.json
SMALL_DIR=public/crew/renders node tools/crew/flock/compose.mjs <out_dir> <out_dir>/sheets <dots_reference.png> A,B,C
```

- `flock_sdf.py`    fields (3D primitives, 2D regions), shell decals, a surface-nets mesher (numpy)
- `flock_cast.py`   the three candidate sheets (A soft solids, B snack bar, C soft symbols), eyes, accessories, variants, lineup order
- `flock_bpy.py`    velvet flock + pile materials, the fine fuzz, the high-key studio, cameras
- `flock_build.py`  one character into the scene; `flock_render.py` the Cycles stills
- `flock_montage.py` quick contact sheets with Blender's image API (no PIL)
- Look-dev knobs (env): `FUZZ_LEN FUZZ_DENSITY FUZZ_SPREAD FUZZ_ROOT FUZZ_SHEEN FUZZ_TIP SHEEN_LIFT KEY FILL EYE_SCALE`
- Agent states: `flock_render.py -- states <out> <sheet>` renders Ready, Thinking, Working,
  Needs your answer, Blocked, Finished on one character (`STATES` in `flock_cast.py`): a brief
  eye/pose change only; the words always sit beside it.

### Memory (the owner's Mac has 24 GB; a guard kills Blender above 10 GB)

Measured on the M4 Pro with Blender 5.2 (per-process footprint, `top -pid`):
- Cycles on Metal with MetalRT (hardware ray tracing, the default) holds ~7 GB for any scene,
  and its curve acceleration structures grow with the fibre count; a 3.5M-fibre portrait peaks
  at ~9 GB. `METALRT=OFF` keeps a portrait at ~3.5 GB but renders curves 10x slower.
- Fibres are only grown where the camera sees them (`FUZZ_VIEW`, on by default; the back of a
  character held half the hair and none of the look), `HAIR_BUDGET` (3.6M) caps a render by
  thinning children, `FUZZ_FACE` < 1 thins camera-facing fibres and keeps the silhouette band.
- Denoising runs on the CPU (`DENOISE_GPU=1` to override); `DEVICE=CPU`, `TILE`, `KOL` exist for
  experiments. Wrap heavy runs in the machine gate (`GATE=... render_pass.sh`).
