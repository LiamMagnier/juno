# Crew characters, round 3: cute, premium, modeled in Blender (D-032, D-033)

The owner looked at the first character build and said it was "weird … uncanny
valley and not cute", and asked for Blender. This is the rework: a diagnosis,
the rules it led to, the characters, and the pipeline that makes the live
characters and the Cycles stills the same characters.

Renders: `design-v3/crew/stills` (before and after, Blender portraits and the
group, the live roster, sizes, tokens, states, peek, editor, create flow, light
and dark) and `design-v3/crew/motion/*.webm`. Repo copies of the Cycles stills
are in `public/crew/renders/`.

## 1. Diagnosis: why the first characters read as uncanny

Compared at the same frame with the OpenAI dots references (images 3 to 6):

1. **Small eyes, high and close together.** Eye centres sat at 50 to 60 % of
   the body height, about a third of the width apart, each eye about 6 % of the
   height. That is an adult proportion. Baby schema (Lorenz's kindchenschema)
   reads the opposite: big eyes, low on the face, wide apart.
2. **Human expression parts on a blob.** Flat brows above the eyes made several
   characters look stern or unimpressed (Mira, Tomas); a mouth and blush on top
   crowded the face. A plush toy face is two eyes and almost nothing else.
3. **Wet, realistic eyes.** Glossy domes with a large white specular smear,
   and "wide" eyes with coloured irises, are the eye parts that tip a simple
   character into the uncanny. The dots use solid dark ovals with one small,
   soft catchlight.
4. **No pile.** The shell fur was short, dense and low frequency: strands were
   sub-pixel at product sizes, so the bodies read as smooth matte plastic with
   realistic shading. A soft toy needs a visible, touchable pile: tufts, a
   frizzy silhouette, dark depth between fibres.
5. **Generic primitives with no front.** Spheres, boxes and cones without a
   face plane, standing like objects, and a three-quarter turn that hid the far
   eye. The dots read instantly because each has one strong, simple silhouette
   with a personality and faces you.
6. **Accessories too small and too fine.** At 64 px a thin flower or a wire
   antenna disappears into the fur. Toy accessories are chunky, slightly
   oversized, in felt and knit.

## 2. The rules (applied deliberately)

- **Eyes large, low, wide.** Per shape, the face data (kit-data.ts, generated
  from `crew_shapes.FACE`) maps the avatar's 0..1 eye controls onto ranges
  that never leave the cute band: centres at 34 to 56 % of the body height
  (peanut: on the head lobe), 36 to 56 % of the half-width from the middle,
  radius 8.6 to 13 % of the height. A person can move the eyes, never into the
  upper face.
- **Simple eyes.** Default eyes are solid dark ovals with one soft catchlight
  and a tiny second one. Whites and pupils exist (wide, googly) as options,
  never by default; irises are gone. Sleepy eyes are content closed strokes.
  Eyes blink by squashing (like a toy), and close into one soft stroke.
- **Almost no face.** No brows and no mouth by default; blush is optional and
  sits in the fur, under and outside the eyes.
- **One soft mass, bottom heavy, with a front.** Every body is one implicit
  surface: a little wider than deep (a face plane), sagging onto a flattened
  base, with at most one feature (ears, a curled tip, two lobes, points).
- **A real pile.** Plush is the default material: fine fleece tufts of
  different lengths that lean every which way, darker deep down, frizzing into
  a halo at the silhouette; shorter on the base, on ears and tips, and pressed
  flat wherever an accessory touches.
- **Chunky accessories.** Hats, glasses, headphones and pins are scaled 1.5 to
  2.3 times a realistic size and sit on the pile, not under it.
- **Front-facing at rest.** The resting pose keeps both eyes visible; the
  three-quarter turn is gentle.
- **Premium is craft.** Soft studio light (a big warm key, a cool fill, two
  rims, a top light), colour-true fur (the fibre colour is lifted toward white
  because dense fur deepens and saturates colour), contact shadows only (light
  linking keeps the key's long shadow off the floor), Khronos PBR Neutral so
  saturated colours stay true.

## 3. Juno's own crew

Twelve characters (tools/crew/roster.json, mirrored by fixtures.ts). None of
them is a blue cloud in a beret, a green frog with googly eyes, a yellow
triangle in round glasses and a bow tie, or a pink heart in sunglasses;
`resemblesSomeoneElse` guards "Surprise me".

| Member | Shape | Colour | Eyes | Wears |
|---|---|---|---|---|
| Mira, Accounts | pebble | marigold | oval, blush | flower pin |
| Otto, Finance operations | marshmallow | cocoa | button | round glasses |
| Scout, Research | bean | iris | oval | antenna |
| Rhea, Support | cub | mint | button, blush | headphones |
| Ines, Recruiting | drop | lilac | sleepy, blush | headband |
| Tomas, On-call engineering | kit | sky | oval | soft cap |
| Nadia, Partnerships | gumdrop | apricot | button | bucket hat |
| Bram, Release notes | peanut | lagoon | bead | square frames |
| Wren, Design review | soft star | blossom | oval, blush | bow |
| Kit, Data | mochi | moss | button, blush | sprout |
| Pia, Travel | orb | raspberry | oval | beanie |
| Sol, Legal | lop | oat | stitched, blush | monocle |

No member defaults to coral or terracotta (that reads as Claude); the thread
colour of every member keeps 4.5:1 text in both themes (theme.ts measures it).

## 4. The pipeline

Everything is reproducible from `tools/crew/blender/` with Blender 5.2 run
headless (`Blender --background --factory-startup --python <script> -- <args>`).

- `crew_shapes.py` (numpy, no bpy): the twelve bodies as implicit surfaces;
  clean quad meshes made the same way for every shape (a spherified cube
  pushed out to the surface from the core, relaxed tangentially with Newton
  steps), so all shapes share one topology; the face rules; anchors for
  accessories; per-vertex ambient occlusion and fur-length masks.
- `crew_parts.py` (numpy): the eyes, features and seventeen accessories as
  parts in canonical frames (a unit hat band, a unit rim, a unit arc, a unit
  neck ring, small things in body units).
- `crew_fit.py`: places parts on a body from its anchors, the eyes and the
  visible fur thickness. Its TypeScript twin is `fit.ts`.
- `crew_compose.py`, `crew_render.py`: Cycles characters (particle hair with
  interpolated children, about 1.3 million strands per character; colour from
  a corner colour attribute so patterns and blush are in the fibres; pile
  pressed under accessories with a k-d tree) and the stills.
- `crew_export.py`: the kit. `public/crew/models/crew-bodies.glb` (all shapes
  at two LODs: 7,500 and 1,728 triangles; one mesh per LOD whose morph targets
  are the other shapes, with `_ao_<shape>` and `_fur_<shape>` attributes),
  `crew-parts.glb`, `crew-kit.usdc` for RealityKit, `textures/fur-strands.png`,
  `manifest.json`, and the generated `kit-data.ts` with a content hash the
  loader uses for cache busting.

The live renderer (`kit.ts`, `character.ts`, `materials.ts`, `fit.ts`) loads
the kit once, bakes each shape from the morph targets, fits parts with the
same rules as Blender, and draws plush with shell texturing tuned side by side
against the Cycles portraits. Engine rules from D-031 hold: one shared WebGL
context, cached sprites up to 28 px, on-demand frames, zero GPU when idle
(measured: 0 renders in 2 s idle; about 60 fps while the pointer sweeps
twelve live characters).

## 5. Customization

Twelve shapes, six materials (plush, velvet, knit, felt, soft vinyl,
ceramic), sixteen palette colours plus any custom colour, patterns (two-tone,
belly, spots, stripes, an uploaded image), seven eye styles with size, spacing
and height inside the cute band, brows, cheeks and mouth, seventeen
accessories in five slots (head, pin, eyes, ears, neck; up to three), each in
its own colour. The editor morphs between shapes vertex for vertex because
every shape shares the kit's topology.

## 6. Motion

The contract is INTERACTION_SPEC §2.9 as amended by D-032: arrival with
squash and stretch, state poses on springs, one hop and turn when waiting, a
happy double bounce with hearts in the member's colour when thanked, pointer
gaze and event blinks at 28 px and up, slow focused loops only for thinking,
working and paused, the thread character's idle, talking bob from the voice
level, fur and springy accessories lag behind the head. What changed with the
kit: blinks squash the eye (a toy's blink), closed eyes are one soft stroke,
sleepy eyes rest closed, hearts rise from the head and fade inside the frame.
Reduce Motion keeps every pose and cross-fades.

## 7. Native (RealityKit)

- Assets: the same kit. `crew-kit.usdc` comes straight from Blender (bodies
  with blend shapes, parts in canonical frames); Reality Composer Pro or
  `usdzip` packages it as `.usdz`. Fitting is the same arithmetic as `fit.ts`
  (a small Swift port of about 300 lines), driven by `manifest.json`.
- Fur: RealityKit has no shells out of the box. Use a `LowLevelMesh` with the
  body's vertices repeated per shell (12 to 16 shells) and a ShaderGraph
  material that samples `fur-strands.png` exactly like the GLSL; at small
  sizes and on older devices fall back to the solid felt material.
- Small faces (20 to 28 pt): sprite atlases rendered by the same engine
  (states x facing x scale) and shipped with the app, so lists never spin up
  RealityKit.
- Motion: the rig is pure TypeScript and ports one to one (`Rig` and `Spring`
  use the duration + bounce form SwiftUI uses).

## 8. Critique (after, at the same frames)

See the scores at the end of the round in the handoff; every dimension is held
at 8 or above, judged light and dark.
