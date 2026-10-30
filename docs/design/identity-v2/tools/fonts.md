# Font measurements (30 Oct 2026, revision 3)

fontTools 4.68.0 with brotli 1.2.1 (`tools/requirements.txt`; `pip install -r requirements.txt` into a
virtualenv, then run with `python3 -I`). The inputs are committed in `tools/fonts-src/` with their OFL
texts:

| Input (`tools/fonts-src/`) | Origin | SHA-256 |
|---|---|---|
| `InterVariable.woff2` (352,240 B) | rsms Inter 4.1 release (the file d1's prototype shipped) | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| `InterVariable-Italic.woff2` (387,976 B) | rsms Inter 4.1 release | `e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a` |
| `geologica-latin-full-normal.woff2` (48,536 B) | `@fontsource-variable/geologica@5.3.0` | `94045871535a36295865420e2e8f23b11cbd11460fb817246ea58a0a7eff3a0e` |
| `geologica-cyrillic-full-normal.woff2` | `@fontsource-variable/geologica@5.3.0` | `75f11c653f1a00be5c2c7e7bf96edd7115667c4bd4e85328d85c8496669879c2` |

```python
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

FEATURES = ["kern","liga","calt","ccmp","locl","mark","mkmk","tnum","case","cv05","cv08","ss03","frac","numr","dnom"]
LATIN = list(range(0x20, 0x7f)) + list(range(0xa0, 0x180)) + [
    0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x2032, 0x2033, 0x2039, 0x203a,
    0x20ac, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2318, 0x21e7, 0x2325, 0x23ce, 0x00d7, 0x2212,
    0x2264, 0x2265]
CYRILLIC = list(range(0x400, 0x460)) + [0x490, 0x491, 0x4b0, 0x4b1, 0x2116]
GREEK = list(range(0x370, 0x400))
VIETNAMESE = [0x102, 0x103, 0x110, 0x111, 0x128, 0x129, 0x168, 0x169, 0x1a0, 0x1a1, 0x1af, 0x1b0,
              0x300, 0x301, 0x303, 0x309, 0x323, 0x329] + list(range(0x1ea0, 0x1efa)) + [0x20ab]

def inter_subset(src, unicodes, out):           # subset, then limit wght to 350-650 (opsz kept)
    f = TTFont(src, lazy=False)
    o = subset.Options(); o.flavor = "woff2"; o.notdef_outline = True; o.layout_features = FEATURES
    s = subset.Subsetter(o); s.populate(unicodes=unicodes); s.subset(f)
    g = instancer.instantiateVariableFont(f, {"wght": (350, 650)}); g.flavor = "woff2"; g.save(out)

def geologica(src, out, flavor="woff2", wght=(400, 600)):   # pin CRSV 1, SHRP 0, slnt 0
    g = instancer.instantiateVariableFont(TTFont(src), {"CRSV": 1, "SHRP": 0, "slnt": 0, "wght": wght})
    g.flavor = flavor; g.save(out)
```

| Output | Bytes | Where it is |
|---|---|---|
| Inter Latin roman, wght 350–650 | **65,452** (two-step run: subset, save, reload, instance; the shipped `proto/fonts/inter.woff2`). The one-step function above gives 65,624 B; W0's `font-budget` test measures the committed file | `proto/fonts/inter.woff2` |
| Inter Latin italic | **70,772** | `tools/fonts-out/inter-latin-italic.woff2` |
| Inter Cyrillic roman | **24,420** | `tools/fonts-out/inter-cyrillic-roman.woff2` (also `proto/fonts/inter-cyr.woff2`) |
| Inter Greek roman | **25,544** | `tools/fonts-out/inter-greek-roman.woff2` |
| Inter Vietnamese roman | **12,728** | `tools/fonts-out/inter-vietnamese-roman.woff2` |
| Geologica Latin WOFF2, CRSV 1 / SHRP 0 / slnt 0, wght 400–600 | **23,752** | `proto/fonts/geologica.woff2` |
| Geologica Cyrillic WOFF2, same | **15,108** | `proto/fonts/geologica-cyr.woff2` |
| Geologica Latin TTF, variable 400–600 (native, `UIAppFonts`) | **69,508** | `tools/fonts-out/geologica-latin-crsv1-wght400-600.ttf` |
| Geologica Cyrillic TTF, variable 400–600 | **36,876** | `tools/fonts-out/geologica-cyrillic-crsv1-wght400-600.ttf` |
| Geologica Latin TTF, static 460 (share images via `next/og`; native fallback) | **41,380** | `tools/fonts-out/geologica-latin-crsv1-wght460-static.ttf` |
| Geologica Cyrillic TTF, static 460 | **22,756** | `tools/fonts-out/geologica-cyrillic-crsv1-wght460-static.ttf` |
| Fontsource `inter-latin-opsz-normal.woff2` (input for comparison; GSUB features: calt ccmp dnom frac locl numr pnum tnum only) | 72,920 | not used |
| JetBrains Mono Latin (repo, unchanged) | 40,404 | `src/app/fonts` |
| Today: `inter-latin-wght-normal.woff2` / `newsreader-latin-wght-normal.woff2` / italic | 48,256 / 58,084 / 64,520 | `src/app/fonts` |

Preloaded in v2: Inter roman 65,452 + Geologica Latin 23,752 = **89,204 bytes**. Everything else loads on
demand through `unicode-range` or first use.
