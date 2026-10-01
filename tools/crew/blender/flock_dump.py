"""Write the cast (and the customization variants) as JSON for the sheet composer.

  Blender --background --factory-startup --python flock_dump.py -- <out.json>
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flock_cast as C  # noqa: E402

out = sys.argv[sys.argv.index("--") + 1]
data = {}
for s, lst in C.CAST.items():
    data[s] = [dict(id=m["id"], name=m["name"], shape=m["shape"], color=m["color"], eyes=m.get("eyes", {}), acc=m.get("acc", [])) for m in lst]
    v = C.VARIANTS.get(s)
    if v:
        base = next(m for m in lst if m["id"] == v["base"])
        items = [dict(file=f"{base['id']}_34.png", title=f"{base['name']} (base)", desc=f"{base['shape']} · {base.get('eyes', {}).get('style', 'dot')} eyes · " + ", ".join(a["id"] for a in base.get("acc", [])))]
        for k, it in enumerate(v["items"]):
            items.append(dict(file=f"var_{base['id']}_{k}.png", title=it["title"], desc="same body, swapped colour, eyes and accessory"))
        data[f"{s}_variants"] = dict(name=base["name"], items=items)
json.dump(data, open(out, "w"), indent=1)
print("WROTE", out)
