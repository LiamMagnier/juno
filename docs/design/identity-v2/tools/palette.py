# Identity v2 palette, revision 3 (30 Oct 2026, review fixes).
#   python3 palette.py [cool|warm]                 print every value and every measured pair
#   python3 palette.py [cool|warm] md              print the markdown tables embedded in TOKENS.md
#   python3 palette.py [cool|warm] css <out.css>   write the prototype's token sheet
#   python3 palette.py [cool|warm] json <out.json> write the full palette (source, hex, HSL, contrast)
# `cool` (granite, neutral hue 255) is the spec's pick; `warm` (d3's stone, hue 80) is the owner's alternative
# (IDENTITY_V2 §20). Both share every lightness, every status ink and every rule; only the neutral hue and
# chroma differ.
# Maths: OKLCH -> OKLab -> linear sRGB (Ottosson's matrices), per-channel clamp, 8-bit rounding; HSL from the
# 8-bit value (three decimals); WCAG 2.x relative luminance (same formula as contrastRatio() in
# scripts/generate-design-tokens.ts); alpha roles composited over their surface in 8-bit sRGB; APCA-W3 0.0.98G
# (simple sRGB coefficients); OKLab Euclidean distance for "how different are two colours".
import math, json, sys

def oklch_to_rgb(L, C, h):
    a = C * math.cos(math.radians(h)); b = C * math.sin(math.radians(h))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    def gam(x):
        x = min(max(x, 0), 1); return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return tuple(round(gam(v) * 255) for v in (r, g, bb))

def _lin(v):
    v /= 255; return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

def rgb_to_oklab(c):
    r, g, b = map(_lin, c)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = [x ** (1 / 3) for x in (l, m, s)]
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)

def dE(a, b): return math.dist(rgb_to_oklab(a), rgb_to_oklab(b))
def hexc(c): return '#%02x%02x%02x' % c
def hx(s): s = s.lstrip('#'); return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))

def hsl(c):
    r, g, b = [v / 255 for v in c]; mx = max(r, g, b); mn = min(r, g, b); l = (mx + mn) / 2
    if mx == mn: h = s = 0.0
    else:
        d = mx - mn; s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
        if mx == r: h = ((g - b) / d) % 6
        elif mx == g: h = (b - r) / d + 2
        else: h = (r - g) / d + 4
        h *= 60
    return f'{h:.3f} {s * 100:.3f}% {l * 100:.3f}%'

def lum(c): r, g, b = map(_lin, c); return 0.2126 * r + 0.7152 * g + 0.0722 * b
def cr(a, b):
    la, lb = lum(a), lum(b); return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
def mix(fg, bg, a): return tuple(round(fg[i] * a + bg[i] * (1 - a)) for i in range(3))

def apca(txt, bg):
    def Y(c): r, g, b = [(v / 255) ** 2.4 for v in c]; return 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    def clamp(y): return y if y > 0.022 else y + (0.022 - y) ** 1.414
    yt, yb = clamp(Y(txt)), clamp(Y(bg))
    if abs(yb - yt) < 0.0005: return 0.0
    if yb > yt:
        s = (yb ** 0.56 - yt ** 0.57) * 1.14; o = 0 if s < 0.1 else s - 0.027
    else:
        s = (yb ** 0.65 - yt ** 0.62) * 1.14; o = 0 if s > -0.1 else s + 0.027
    return o * 100

args = [a for a in sys.argv[1:]]
VARIANT = args.pop(0) if args and args[0] in ('cool', 'warm') else 'cool'
H = 255 if VARIANT == 'cool' else 80
# Neutral chroma: cool keeps today's graphite range (C 0.002-0.009, WA §2.1); warm is d3's stone.
CN = {'cool': {'base': 0.005, 'stage': 0.001, 'raised': 0.003, 'well': 0.005, 'selected': 0.005, 'line': 0.004},
      'warm': {'base': 0.006, 'stage': 0.0015, 'raised': 0.004, 'well': 0.006, 'selected': 0.006, 'line': 0.005}}[VARIANT]
def N(L, C): return (L, C, H)

SRC = {
 'light': {
  'base': N(0.950, CN['base']), 'stage': N(0.996, CN['stage']), 'raised': N(0.966, CN['raised']), 'float': N(1.0, 0),
  'well': N(0.928, CN['well']), 'selected': N(0.925, CN['selected']), 'line': N(0.905, CN['line']), 'line-strong': N(0.600, 0.006),
  'ink': N(0.205, 0.008), 'ink-2': N(0.430, 0.008), 'ink-3': N(0.620, 0.006), 'on-ink': N(0.996, CN['stage']),
  'bronze': (0.465, 0.082, 68), 'bronze-fill': (0.595, 0.106, 70),
  'signal': (0.470, 0.160, 260), 'danger': (0.480, 0.175, 27), 'danger-fill': (0.505, 0.180, 27), 'on-danger': N(1.0, 0),
  'success': (0.455, 0.100, 150), 'warning': (0.475, 0.128, 52),
 },
 'dark': {
  'base': N(0.160, 0.003), 'stage': N(0.214, 0.003), 'raised': N(0.246, 0.004), 'float': N(0.284, 0.004), 'well': N(0.182, 0.003),
  'selected': N(0.306, 0.005), 'line': N(0.330, 0.004), 'line-strong': N(0.610, 0.006),
  'ink': N(0.935, 0.004), 'ink-2': N(0.850, 0.005), 'ink-3': N(0.600, 0.005), 'on-ink': N(0.214, 0.003),
  'bronze': (0.805, 0.088, 78), 'bronze-fill': (0.765, 0.100, 76),
  'signal': (0.785, 0.110, 258), 'danger': (0.790, 0.120, 25), 'danger-fill': (0.640, 0.170, 27), 'on-danger': N(0.160, 0.003),
  'success': (0.775, 0.125, 152), 'warning': (0.795, 0.130, 60),
 },
 'hc-light': {'ink-2': N(0.370, 0.008), 'ink-3': N(0.520, 0.006), 'line': N(0.760, 0.006), 'line-strong': N(0.450, 0.008),
              'selected': N(0.900, 0.005), 'bronze': (0.415, 0.075, 66), 'bronze-fill': (0.550, 0.104, 70),
              'signal': (0.420, 0.150, 262), 'danger': (0.430, 0.160, 27), 'danger-fill': (0.450, 0.170, 27),
              'success': (0.405, 0.095, 150), 'warning': (0.430, 0.120, 50)},
 'hc-dark': {'ink-2': N(0.900, 0.004), 'ink-3': N(0.700, 0.005), 'line': N(0.440, 0.005), 'line-strong': N(0.700, 0.006),
             'selected': N(0.330, 0.005), 'bronze': (0.870, 0.075, 80), 'signal': (0.850, 0.090, 256),
             'danger': (0.850, 0.095, 25), 'success': (0.850, 0.110, 152), 'warning': (0.860, 0.110, 62)},
}
AGENT = {'coral': 40, 'amber': 85, 'sage': 135, 'juniper': 165, 'teal': 200, 'violet': 295}
for k_, h_ in AGENT.items():
    SRC['light']['agent-' + k_] = (0.860, 0.050, h_); SRC['dark']['agent-' + k_] = (0.730, 0.055, h_)
# One eye ink in both themes (AGENTS.md §4.1: "the same in both themes, so an agent is the same agent").
SRC['light']['agent-ink'] = N(0.205, 0.008); SRC['dark']['agent-ink'] = N(0.205, 0.008)
# Chart series 2-5 (series 1 is ink, series 6 is ink-2 with a dash). Four hues in the gaps between the
# status hues, each with its own lightness so every series stays >= 0.095 OKLab from every status ink.
CHART = {'chart-2': (0.565, 0.860, 0.124, 120), 'chart-3': (0.505, 0.725, 0.104, 212),
         'chart-4': (0.515, 0.840, 0.110, 302), 'chart-5': (0.475, 0.725, 0.124, 350)}
for k_, (Ll, Ld, C_, h_) in CHART.items():
    SRC['light'][k_] = (Ll, C_, h_); SRC['dark'][k_] = (Ld, C_, h_)

ALPHA = {'light': {'hover': 0.045, 'press': 0.08, 'line-soft': 0.08}, 'dark': {'hover': 0.06, 'press': 0.10, 'line-soft': 0.09},
         'hc-light': {'hover': 0.08, 'press': 0.12, 'line-soft': 0.22}, 'hc-dark': {'hover': 0.10, 'press': 0.14, 'line-soft': 0.24}}
THEMES = ('light', 'dark', 'hc-light', 'hc-dark')

def build():
    out = {}
    for th in ('light', 'dark'): out[th] = {k: oklch_to_rgb(*v) for k, v in SRC[th].items()}
    for th, base in (('hc-light', 'light'), ('hc-dark', 'dark')):
        c = dict(out[base]); c.update({k: oklch_to_rgb(*v) for k, v in SRC[th].items()}); out[th] = c
    for th in THEMES: out[th]['chart-1'] = out[th]['ink']; out[th]['chart-6'] = out[th]['ink-2']
    return out
P = build()

GROUNDS = ['base', 'stage', 'raised', 'float', 'well', 'selected']
REST = ['base', 'stage', 'raised', 'float']
# A selected row never stacks hover or press (COMPONENTS §1.3, §7), so these are every state fill there is.
STATES = ['hover/base', 'hover/stage', 'hover/raised', 'hover/float', 'hover/well', 'press/base', 'press/stage', 'press/raised', 'press/float']
TEXT = ['ink', 'ink-2', 'bronze', 'signal', 'danger', 'success', 'warning']
STATUS = ['bronze', 'signal', 'danger', 'success', 'warning']

def comp(th):
    c = dict(P[th]); a = ALPHA[th]; ink = c['ink']
    for s in ('base', 'stage', 'raised', 'float', 'well'): c['hover/' + s] = mix(ink, c[s], a['hover'])
    for s in ('base', 'stage', 'raised', 'float'): c['press/' + s] = mix(ink, c[s], a['press'])
    return c

def minstate(c, t):
    v = min((cr(c[t], c[s]), s) for s in STATES); return v

def L(th, k):
    s = SRC[th].get(k) if th in SRC else None
    if th.startswith('hc'): s = SRC[th].get(k) or SRC[th.split('-')[1]][k]
    return f'{s[0]:.3f} {s[1]:.4g} {s[2]:g}'

USE = {'base': 'Window ground, sidebar, landing page', 'stage': 'The content sheet (chat, pages); reading ground',
 'raised': 'In-flow tonal surface on the stage: user turn, code block, tiles, draft preview',
 'float': 'Menus, popovers, dialogs, sheets, toasts, the composer when lifted',
 'well': 'Fields and tracks sitting on the base (sidebar search, segmented track)',
 'selected': 'Selected row (sidebar, list, palette), segmented thumb in dark',
 'line': 'Hairlines, table row rules, card edges (decorative; see the boundary rule in §1.4)',
 'line-strong': 'Field edges, switch-off ring, segmented thumb edge, table head rule, every HC boundary (non-text 3:1)',
 'ink': 'Primary text, glyphs on hover/selected, primary button fill, focus ring',
 'ink-2': 'Every secondary text: placeholders, timestamps, hints, captions, counts, shortcut hints, resting glyphs',
 'ink-3': 'Decorative only: disabled glyphs, bullets, rails. Never text', 'on-ink': 'Label on the ink primary and the send disc',
 'bronze': 'Live label text ("Working", "Reading sources")',
 'bronze-fill': 'The stone: brand mark, live dot, writing point, live rule, the working face\'s orbit',
 'signal': 'Needs you: word, dot, badge, step marker. Nothing else', 'danger': 'Destructive and failed text, destructive menu items',
 'danger-fill': 'The danger button (destructive confirm only)', 'on-danger': 'Label on the danger button',
 'success': 'Completed (rare; always with glyph and word)', 'warning': 'Quota, degraded service (rare; always with glyph and word)'}

def md():
    print('| Role | Use | Light OKLCH | Light hex | Light HSL triplet | Dark OKLCH | Dark hex | Dark HSL triplet |')
    print('|---|---|---|---|---|---|---|---|')
    for k in USE:
        print(f"| `--{k}` | {USE[k]} | {L('light', k)} | `{hexc(P['light'][k])}` | `{hsl(P['light'][k])}` | {L('dark', k)} | `{hexc(P['dark'][k])}` | `{hsl(P['dark'][k])}` |")
    print('\nHC_TABLE')
    print('| Role | HC light OKLCH | HC light hex | HC light HSL | HC dark OKLCH | HC dark hex | HC dark HSL |')
    print('|---|---|---|---|---|---|---|')
    for k in ['ink-2', 'ink-3', 'line', 'line-strong', 'selected', 'bronze', 'bronze-fill', 'signal', 'danger', 'danger-fill', 'success', 'warning']:
        print(f"| `--{k}` | {L('hc-light', k)} | `{hexc(P['hc-light'][k])}` | `{hsl(P['hc-light'][k])}` | {L('hc-dark', k)} | `{hexc(P['hc-dark'][k])}` | `{hsl(P['hc-dark'][k])}` |")
    print('\nAGENTS')
    print('| Tone id (stored, unchanged) | OKLCH light | Light hex | OKLCH dark | Dark hex | Eye ink on body light / dark | Working orbit (`--bronze-fill`) on body light / dark |')
    print('|---|---|---|---|---|---|---|')
    for k in AGENT:
        a = 'agent-' + k
        print(f"| `{k}` | {L('light', a)} | `{hexc(P['light'][a])}` | {L('dark', a)} | `{hexc(P['dark'][a])}` | {cr(P['light']['agent-ink'], P['light'][a]):.2f} / {cr(P['dark']['agent-ink'], P['dark'][a]):.2f} | {cr(P['light']['bronze-fill'], P['light'][a]):.2f} / {cr(P['dark']['bronze-fill'], P['dark'][a]):.2f} |")
    print('\nORBIT on grounds: ' + '; '.join(f"{th} " + ', '.join(f"{s} {cr(P[th]['bronze-fill'], comp(th)[s]):.2f}" for s in ['base', 'stage', 'raised', 'selected', 'hover/base']) for th in ('light', 'dark')))
    print('\nCHART')
    print('| Series | Hue | Light | on stage / raised | Dark | on stage / raised | Nearest status ink (OKLab, light / dark) |')
    print('|---|---|---|---|---|---|---|')
    for k in ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6']:
        hue = {'chart-1': '(ink)', 'chart-6': '(ink-2, dashed)'}.get(k) or str(CHART[k][3])
        near = []
        for th in ('light', 'dark'):
            c = P[th]; near.append(min((dE(c[k], c[s]), s) for s in ['danger', 'danger-fill', 'warning', 'success', 'signal', 'bronze', 'bronze-fill']))
        ns = ' / '.join(f'{d:.3f} ({s})' for d, s in near) if k not in ('chart-1', 'chart-6') else 'neutral'
        print(f"| `--{k}` | {hue} | `{hexc(P['light'][k])}` | {cr(P['light'][k], P['light']['stage']):.2f} / {cr(P['light'][k], P['light']['raised']):.2f} | `{hexc(P['dark'][k])}` | {cr(P['dark'][k], P['dark']['stage']):.2f} / {cr(P['dark'][k], P['dark']['raised']):.2f} | {ns} |")
    pair = min(dE(P[th][a], P[th][b]) for th in ('light', 'dark') for i, a in enumerate(['chart-2', 'chart-3', 'chart-4', 'chart-5']) for b in ['chart-2', 'chart-3', 'chart-4', 'chart-5'][i + 1:])
    print(f'closest pair of coloured series: {pair:.3f}')
    print('\nCONTRAST')
    for th in THEMES:
        c = comp(th)
        print(f'\n**{th}**\n')
        print('| Foreground | ' + ' | '.join(GROUNDS) + ' | lowest state fill |'); print('|---|' + '---|' * (len(GROUNDS) + 1))
        for t in TEXT + ['ink-3']:
            v, s = minstate(c, t)
            print(f'| `{t}` | ' + ' | '.join(f'{cr(c[t], c[g]):.2f}' for g in GROUNDS) + f' | {v:.2f} ({s}) |')
        for t in ['line-strong', 'bronze-fill', 'signal']:
            v, s = minstate(c, t)
            print(f'| non-text `{t}` | ' + ' | '.join(f'{cr(c[t], c[g]):.2f}' for g in GROUNDS) + f' | {v:.2f} ({s}) |')
        print(f"\nOther pairs ({th}): `on-ink` on `ink` {cr(c['on-ink'], c['ink']):.2f}; `on-danger` on `danger-fill` {cr(c['on-danger'], c['danger-fill']):.2f}; focus ring `ink` lowest {min(cr(c['ink'], c[s]) for s in GROUNDS + STATES):.2f}; `line` on `stage` {cr(c['line'], c['stage']):.2f} (decorative); `ink-3` on `float` {cr(c['ink-3'], c['float']):.2f}.")
        print(f"Surface steps ({th}): stage/base {cr(c['stage'], c['base']):.3f}; raised/stage {cr(c['raised'], c['stage']):.3f}; float/stage {cr(c['float'], c['stage']):.3f}; selected/base {cr(c['selected'], c['base']):.3f}; well/base {cr(c['well'], c['base']):.3f}.")
    print('\nAPCA (Lc; negative = light text on dark)')
    print('| Appearance | Text | base | stage | raised | float | selected | press/float |'); print('|---|---|---|---|---|---|---|---|')
    for th in ('dark', 'hc-dark', 'light'):
        c = comp(th)
        for t in TEXT:
            print(f"| {th} | `{t}` | " + ' | '.join(f'{apca(c[t], c[s]):.1f}' for s in ['base', 'stage', 'raised', 'float', 'selected', 'press/float']) + ' |')

COMP = {'claude': {'light': {'bg-secondary #F5F4ED': '#F5F4ED', 'bg-tertiary #FAF9F5': '#FAF9F5', 'text #141413': '#141413', 'text-2 #3D3D3A': '#3D3D3A'},
                   'dark': {'bg #30302E': '#30302E', 'bg-2 #262624': '#262624', 'bg-3 #141413': '#141413', 'text #FAF9F5': '#FAF9F5', 'text-2 #C2C0B6': '#C2C0B6'}}}

def distinct():
    for th, roles in (('light', ['base', 'stage', 'ink', 'ink-2']), ('dark', ['base', 'stage', 'float', 'ink', 'ink-2'])):
        for r in roles:
            Lb, a, b = rgb_to_oklab(P[th][r])
            near = min((dE(P[th][r], hx(v)) * 100, n) for n, v in COMP['claude'][th].items())
            print(f'{VARIANT} {th} {r} {hexc(P[th][r])}: OKLCH C {math.hypot(a, b):.4f} h {math.degrees(math.atan2(b, a)) % 360:.0f}; nearest Claude token {near[1]} at {near[0]:.2f} (x100)')

if __name__ == '__main__':
    cmd = args[0] if args else 'print'
    if cmd == 'md': md()
    elif cmd == 'distinct': distinct()
    elif cmd == 'css':
        out = []
        for sel, th in ((':root', 'light'), ('[data-theme="dark"]', 'dark')):
            c = P[th]; a = ALPHA[th]; ink = c['ink']; sh = (0, 0, 0) if th == 'dark' else P['light']['ink']
            ln = [f'  --{k}: {hexc(v)};' for k, v in c.items()]
            ln += [f'  --hover: rgb({ink[0]} {ink[1]} {ink[2]} / {a["hover"]});', f'  --press: rgb({ink[0]} {ink[1]} {ink[2]} / {a["press"]});',
                   f'  --line-soft: rgb({ink[0]} {ink[1]} {ink[2]} / {a["line-soft"]});', f'  --shadow-rgb: {sh[0]} {sh[1]} {sh[2]};',
                   f'  --ring-rgb: {"255 255 255" if th == "dark" else f"{ink[0]} {ink[1]} {ink[2]}"};']
            out.append(sel + '{\n' + '\n'.join(ln) + '\n}\n')
        open(args[1], 'w').write(f'/* generated by tools/palette.py {VARIANT} css */\n' + ''.join(out))
    elif cmd == 'json':
        data = {'variant': VARIANT, 'source': {th: {k: list(v) for k, v in SRC[th].items()} for th in SRC}, 'alpha': ALPHA, 'hex': {}, 'hsl': {}}
        for th in THEMES:
            data['hex'][th] = {k: hexc(v) for k, v in P[th].items()}; data['hsl'][th] = {k: hsl(v) for k, v in P[th].items()}
        json.dump(data, open(args[1], 'w'), indent=1)
    else:
        for th in THEMES:
            c = comp(th); print('=====', VARIANT, th)
            for k in USE: print(f'  {k:12} {hexc(c[k])}  {hsl(c[k])}')
            for t in TEXT + ['ink-3']:
                v, s = minstate(c, t)
                print(f'  {t:8} rest>={min(cr(c[t], c[g]) for g in REST):.2f} selected {cr(c[t], c["selected"]):.2f} lowest state {v:.2f} ({s})')
