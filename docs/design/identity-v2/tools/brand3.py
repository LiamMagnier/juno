# Identity v2 final brand assets: d3's Arch (tools/brand2.py) with revised small masters and a two-cut wordmark.
import sys, os, json, math
HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE+'/vendor')  # outline.py, brand2.py (d3); fontTools 4.68.0 + brotli from tools/requirements.txt
from outline import outline
from brand2 import arch, circle, f, se_top
GEO=HERE+'/fonts-src/geologica-latin-full-normal.woff2'
OUT=sys.argv[1]
# box, arch(x0,x1,top,base,leg,crown), stone(cx,cy,r)
M={
 '16':(16,(2,14,1,14,3.0,3.0),(8,11,2.0)),                # pixel-fitted at 1x: opening 6, stone 4 (6..10 x 9..13), 1 px clear each side, lift 1 px
 '20':(20,(3,17,1.5,18,3.5,3.5),(10,14.5,2.5)),           # fitted to 0.5 (2x): opening 7, stone 5, 1 clear, lift 1
 '24':(24,(4,20,2,21.5,4,4),(12,17.5,3.0)),               # fitted to 0.5 (2x): opening 8, stone 6, 1 clear, lift 1
 'large':(100,(16,84,9,90,18.5,16.8),(50,76,10)),           # unchanged from d3
}
INK={'light':'#15171b','dark':'#e8eaec'}; BRONZE={'light':'#a7722e','dark':'#d7aa67'}  # palette.py cool (rev 3): --ink, --bronze-fill
def sym(key,th,mono=False,px=None,ink=None,stone=None):
    b,a,s=M[key]; px=px or (256 if key=='large' else b)
    i=ink or INK[th]; st=stone or (i if mono else BRONZE[th])
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {b} {b}" width="{px}" height="{px}"><path fill="{i}" d="{arch(*a)}"/><path fill="{st}" d="{circle(*s)}"/></svg>'
CUTS={ # wordmark cuts: large (>= 32 px rendered cap-to-baseline lockups) and small (<= 24 px)
 'large':dict(axes={'wght':450,'CRSV':1,'SHRP':0,'slnt':0},tracking=-0.012,kern={'Al':0.020,'ev':-0.004,'vr':-0.008}),
 'small':dict(axes={'wght':520,'CRSV':1,'SHRP':0,'slnt':0},tracking=0.010,kern={'Al':0.030,'ev':0.0,'vr':-0.004}),
}
WM={}
for k,c in CUTS.items():
    p,w,cap,xh=outline(GEO,'Alevr',c['axes'],size=100,tracking=c['tracking'],kern=c['kern']); WM[k]=(p,w,cap)
def wordmark(cut,th,height=64,color=None):
    p,w,cap=WM[cut]; c=color or INK[th]; vb=f"-1 {f(-cap-1)} {f(w+2)} {f(cap+2)}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{f(height*(w+2)/(cap+2))}" height="{f(height)}"><path fill="{c}" d="{p}"/></svg>'
def lockup(cut,th):
    p,w,cap=WM[cut]; b,a,s=M['large']; sc=cap*1.16/81; gap=cap*0.42; tx=68*sc+gap; W=tx+w; top=-(81*sc)-1
    g=f'<g transform="translate({f(-16*sc)},{f(-90*sc)}) scale({f(sc)})"><path fill="{INK[th]}" d="{arch(*a)}"/><path fill="{BRONZE[th]}" d="{circle(*s)}"/></g>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 {f(top)} {f(W+2)} {f(-top+2)}" width="{f((W+2)*0.6)}" height="{f((-top+2)*0.6)}">{g}<path fill="{INK[th]}" transform="translate({f(tx)},0)" d="{p}"/></svg>'
# basalt = OKLCH 0.250 0.006 255, dark ground 0.170 0.005 255, arch 0.955 / 0.925 0.004 255 (cool granite, rev 3)
ICON={'default':dict(bg='#202225',arch='#eef0f3',stone='#c4914a'),'dark':dict(bg='#0e1012',arch='#e4e6e9',stone='#d6a866'),
      'light':dict(bg='#eef0f3',arch='#202225',stone='#a7722e'),'tinted':dict(bg='#141414',arch='#f5f5f5',stone='#bdbdbd')}
def appicon(kind,layer=None,mask=True):
    c=ICON[kind]; b,a,s=M['large']; sc=1024*0.56/68; tx=(1024-68*sc)/2-16*sc; ty=(1024-81*sc)/2-9*sc-1024*0.012
    g=f'<g transform="translate({f(tx)},{f(ty)}) scale({f(sc)})">'
    if layer in (None,'arch'): g+=f'<path fill="{c["arch"]}" d="{arch(*a)}"/>'
    if layer in (None,'stone'): g+=f'<path fill="{c["stone"]}" d="{circle(*s)}"/>'
    g+='</g>'
    bg='' if layer in ('arch','stone') else (f'<rect width="1024" height="1024" rx="230" fill="{c["bg"]}"/>' if mask else f'<rect width="1024" height="1024" fill="{c["bg"]}"/>')
    if layer=='ground': g=''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">{bg}{g}</svg>'
os.makedirs(OUT,exist_ok=True)
W=lambda n,s: open(os.path.join(OUT,n),'w').write(s)
for k in M:
    for th in ('light','dark'): W(f'symbol-{k}-{th}.svg',sym(k,th))
    W(f'symbol-{k}-mono.svg',sym(k,'light',mono=True,ink='currentColor'))
for cut in CUTS:
    for th in ('light','dark'): W(f'wordmark-{cut}-{th}.svg',wordmark(cut,th,height=64 if cut=='large' else 24))
for th in ('light','dark'): W(f'lockup-{th}.svg',lockup('large',th)); W(f'lockup-small-{th}.svg',lockup('small',th))
b,a,s=M['16']
W('favicon.svg',f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>.a{{fill:#15171b}}.s{{fill:#a7722e}}@media (prefers-color-scheme:dark){{.a{{fill:#e8eaec}}.s{{fill:#d7aa67}}}}</style><path class="a" d="{arch(*a)}"/><path class="s" d="{circle(*s)}"/></svg>')
W('favicon-mono.svg',sym('16','light',mono=True,ink='currentColor'))
for k in ICON: W(f'app-icon-{k}.svg',appicon(k))
W('app-icon-layer-ground.svg',appicon('default',layer='ground',mask=False))
W('app-icon-layer-arch.svg',appicon('default',layer='arch'))
W('app-icon-layer-stone.svg',appicon('default',layer='stone'))
json.dump({'masters':{k:{'box':v[0],'arch':dict(zip(['x0','x1','top','base','leg','crown'],v[1])),'stone':dict(zip(['cx','cy','r'],v[2])),
  'opening':round(v[1][1]-v[1][0]-2*v[1][4],3),'clearance':round((v[1][1]-v[1][0]-2*v[1][4]-2*v[2][2])/2,3),'lift':round(v[1][3]-v[2][1]-v[2][2],3)} for k,v in M.items()},
  'shoulders':{'n_outer':2.8,'n_inner':2.6},
  'wordmark':{k:{**CUTS[k],'advance':round(WM[k][1],3),'cap':round(WM[k][2],3)} for k in CUTS},
  'colors':{'ink':INK,'bronze':BRONZE,'appIcon':ICON}},open(os.path.join(OUT,'geometry.json'),'w'),indent=1)
print('ok', {k:(round(WM[k][1],2),round(WM[k][2],2)) for k in WM})
