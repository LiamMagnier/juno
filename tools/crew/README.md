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
