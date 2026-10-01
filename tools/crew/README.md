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

## Flocked crew (designer-toy pass, Oct 2026)

The plush v1 read as creepy next to OpenAI's dots (long shaggy fur, glossy bead
eyes with catchlights, dusty colours, amorphous outlines). The `flock_*` pipeline
replaces it with a flocked designer-toy finish: a clean velvet body (microfibre
sheen, fine grain) under a SHORT fine pile (~1.1% of the body height), graphic
matte eyes (dots, pills, round buttons, closed arcs, flat white stickers, opaque
shades) laid on as raised appliques, bold oversized matte accessories, a clean
saturated palette, and bold iconic silhouettes of our own. No mouth, no blush.

```sh
BL=/Applications/Blender.app/Contents/MacOS/Blender
# every render of a pass (portraits front + 3/4, icon views, lineups, variants)
bash tools/crew/flock/render_pass.sh <out_dir> A B C
# the cast as JSON, then the sheets (light/dark, icons at 20/32/64 px, dots comparison)
$BL --background --factory-startup --python tools/crew/blender/flock_dump.py -- <out_dir>/cast.json
node tools/crew/flock/compose.mjs <out_dir> <out_dir>/sheets <dots_reference.png> A,B,C
```

- `flock_sdf.py`    fields (3D primitives, 2D regions), shell decals, a surface-nets mesher (numpy)
- `flock_cast.py`   the three candidate sheets (A soft solids, B snack bar, C night sky), eyes, accessories, variants
- `flock_bpy.py`    velvet flock + pile materials, the fine fuzz, the high-key studio, cameras
- `flock_build.py`  one character into the scene; `flock_render.py` the Cycles stills
- `flock_montage.py` quick contact sheets with Blender's image API (no PIL)
