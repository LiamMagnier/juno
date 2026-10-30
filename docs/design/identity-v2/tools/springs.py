# Same model as scripts/generate-design-tokens.ts springPosition/springTwin:
# w = 2*pi/(1.2*vd), zeta = clamp(0.05,1,1-bounce), settle = last ms with |1-x| > 0.005, +1.
import math, sys
def pos(vd,b):
    w=2*math.pi/(vd*1.2); z=min(1,max(0.05,1-b))
    if z<1:
        wd=w*math.sqrt(1-z*z); A=z*w/wd
        return lambda t: 1-math.exp(-z*w*t)*(A*math.sin(wd*t)+math.cos(wd*t))
    return lambda t: 1-math.exp(-w*t)*(1+w*t)
def info(vd,b):
    x=pos(vd,b); last=0; peak=0; t95=None
    ms=0.0
    while ms<=5000:
        v=x(ms/1000)
        if abs(1-v)>0.005: last=ms
        peak=max(peak,v)
        if t95 is None and v>=0.95: t95=ms
        ms+=0.5
    return math.floor(last)+1, max(0,peak-1)*100, t95
RUNS=[('d3 snap',0.24,0),('d3 glide',0.32,0),('d3 settle',0.36,0.10),('d3 lift',0.50,0.18),
      ('v2 snap',0.24,0),('v2 glide',0.32,0),('v2 settle',0.36,0.10),('v2 lift',0.32,0.10),
      ('lift .32/.12',0.32,0.12),('lift .32/.15',0.32,0.15),('lift .30/.12',0.30,0.12)]
for name,vd,b in RUNS:
    s,o,t95=info(vd,b)
    # overshoot in px for the two travels lift carries: the needs-you card (10 px) and the stone's rise (4 px)
    print(f'{name:14} vd={vd} b={b}: settle {s} ms, overshoot {o:.3f}% ({o/100*10:.3f} px on 10 px, {o/100*4:.3f} px on 4 px), reaches 95% at {t95} ms')
