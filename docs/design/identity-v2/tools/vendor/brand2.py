# Final brand geometry (variant B): symbol masters, wordmark, lockup, favicon, app icons, Icon Composer layers.
import math, sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from outline import outline
D=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEO=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','fonts-src','geologica-latin-full-normal.woff2')
def f(n): return ('%.3f'%n).rstrip('0').rstrip('.')
def se_top(cx,top,hw,hh,n,N=36,rev=False):
    pts=[]
    for i in range(N+1):
        t=math.pi-math.pi*i/N; c,s=math.cos(t),math.sin(t)
        x=hw*math.copysign(abs(c)**(2/n),c); y=hh*abs(s)**(2/n)
        pts.append((cx+x,top+hh-y))
    return pts[::-1] if rev else pts
def arch(x0,x1,top,base,leg,crown,n_out=2.8,n_in=2.6):
    cx=(x0+x1)/2; hw=(x1-x0)/2; iw=hw-leg
    pts=[(x0,base)]+se_top(cx,top,hw,hw,n_out)+[(x1,base),(cx+iw,base)]+se_top(cx,top+crown,iw,iw,n_in,rev=True)+[(cx-iw,base)]
    return "M"+"L".join(f"{f(x)} {f(y)}" for x,y in pts)+"Z"
def circle(cx,cy,r): return f"M{f(cx-r)} {f(cy)}a{f(r)} {f(r)} 0 1 0 {f(2*r)} 0a{f(r)} {f(r)} 0 1 0 {f(-2*r)} 0Z"
M={ # box, arch(x0,x1,top,base,leg,crown), stone(cx,cy,r)
 '16':(16,(2.5,13.5,1.25,14.75,3.0,2.75),(8,12.15,1.75)),
 '20':(20,(3.25,16.75,1.75,18.25,3.7,3.35),(10,15.3,2.1)),
 '24':(24,(4,20,2.25,21.75,4.4,4.0),(12,18.3,2.45)),
 'large':(100,(16,84,9,90,18.5,16.8),(50,76,10)),
}
INK={'light':'#191713','dark':'#ebe9e6'}; BRONZE={'light':'#b07e3a','dark':'#d6a866'}
def sym(key,th,mono=False,px=None,ink=None,stone=None):
    b,a,s=M[key]; px=px or (256 if key=='large' else b)
    i=ink or INK[th]; st=stone or (i if mono else BRONZE[th])
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {b} {b}" width="{px}" height="{px}"><path fill="{i}" d="{arch(*a)}"/><path fill="{st}" d="{circle(*s)}"/></svg>'
# Wordmark: Geologica wght 540, CRSV 1, tracking -0.01em, outlined. Kerning tuned by eye: A-l +0.01, v-r -0.005.
WM_AX={'wght':540,'CRSV':1,'SHRP':0,'slnt':0}
wpath,wwid,cap,xh=outline(GEO,'Alevr',WM_AX,size=100,tracking=-0.01,kern={'Al':0.012,'ev':-0.004,'vr':-0.006})
# wordmark bbox: y from -cap-ish to descender 0 (no descenders). Use viewBox 0 -cap w cap
def wordmark(th,height=None,color=None):
    c=color or INK[th]; vb=f"-1 {f(-cap-1)} {f(wwid+2)} {f(cap+2)}"
    h=height or 40; w=h*(wwid+2)/(cap+2)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{f(w)}" height="{f(h)}"><path fill="{c}" d="{wpath}"/></svg>'
def lockup(th,key='large',scale_to_cap=True):
    # symbol height = cap height * 1.18 (the arch overshoots cap height slightly), gap = 0.36 cap
    b,a,s=M['large']; symH=cap*1.16; sc=symH/(90-9) # arch spans 9..90 in large master
    gap=cap*0.42; symW=(84-16)*sc
    tx=symW+gap
    ink=INK[th]
    g=f'<g transform="translate({f(-16*sc)},{f(-cap-((90-9)*sc-cap)+ (90-9)*sc - 90*sc + (cap*0.0))})"></g>'
    # place symbol so its base sits on the wordmark baseline (y=0)
    sym_g=f'<g transform="translate({f(-16*sc)},{f(-90*sc)}) scale({f(sc)})"><path fill="{ink}" d="{arch(*a)}"/><path fill="{BRONZE[th]}" d="{circle(*s)}"/></g>'
    W=tx+wwid; top=-(81*sc)-1
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 {f(top)} {f(W+2)} {f(-top+2)}" width="{f((W+2)*0.6)}" height="{f((-top+2)*0.6)}">{sym_g}<path fill="{ink}" transform="translate({f(tx)},0)" d="{wpath}"/></svg>', dict(sc=sc,tx=tx,W=W,top=top)
# App icon (flat render, 1024 canvas, the OS applies the mask). Layers for Icon Composer.
ICON={'default':dict(bg='#22211e',arch='#f1efea',stone='#c4914a'),
      'dark':dict(bg='#121110',arch='#e6e3dd',stone='#d6a866'),
      'light':dict(bg='#f1efea',arch='#22211e',stone='#b07e3a'),
      'tinted':dict(bg='#141414',arch='#f5f5f5',stone='#bdbdbd')}
def appicon(kind,mask=True,size=1024,layer=None):
    c=ICON[kind]; b,a,s=M['large']
    # symbol occupies 56% of the canvas width, optically centred (arch mass sits 2% high)
    sc=1024*0.56/68; tx=(1024-68*sc)/2-16*sc; ty=(1024-81*sc)/2-9*sc-1024*0.012
    sym=f'<g transform="translate({f(tx)},{f(ty)}) scale({f(sc)})">'
    if layer in (None,'arch'): sym+=f'<path fill="{c["arch"]}" d="{arch(*a)}"/>'
    if layer in (None,'stone'): sym+=f'<path fill="{c["stone"]}" d="{circle(*s)}"/>'
    sym+='</g>'
    bg='' if layer in ('arch','stone') else (f'<rect width="1024" height="1024" rx="230" fill="{c["bg"]}"/>' if mask else f'<rect width="1024" height="1024" fill="{c["bg"]}"/>')
    if layer=='ground': sym=''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="{size}" height="{size}">{bg}{sym}</svg>'
if __name__=='__main__':
    out=D+'/brand'; os.makedirs(out,exist_ok=True)
    for fn in os.listdir(out):
        if fn.endswith('.svg'): os.remove(os.path.join(out,fn))
    for k in M:
        for th in ('light','dark'): open(f'{out}/symbol-{k}-{th}.svg','w').write(sym(k,th))
    open(f'{out}/symbol-mono.svg','w').write(sym('large','light',mono=True,ink='currentColor'))
    for th in ('light','dark'):
        open(f'{out}/wordmark-{th}.svg','w').write(wordmark(th,height=64))
        open(f'{out}/lockup-{th}.svg','w').write(lockup(th)[0])
    # favicon: 16 master, adapts to colour scheme
    b,a,s=M['16']
    fav=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>.a{{fill:#191713}}.s{{fill:#b07e3a}}@media (prefers-color-scheme:dark){{.a{{fill:#ebe9e6}}.s{{fill:#d6a866}}}}</style><path class="a" d="{arch(*a)}"/><path class="s" d="{circle(*s)}"/></svg>'
    open(f'{out}/favicon.svg','w').write(fav)
    for k in ICON: open(f'{out}/app-icon-{k}.svg','w').write(appicon(k))
    open(f'{out}/app-icon-layer-ground.svg','w').write(appicon('default',layer='ground',mask=False))
    open(f'{out}/app-icon-layer-arch.svg','w').write(appicon('default',layer='arch'))
    open(f'{out}/app-icon-layer-stone.svg','w').write(appicon('default',layer='stone'))
    # data for the prototype
    data={'masters':{k:{'box':v[0],'arch':arch(*v[1]),'stone':circle(*v[2])} for k,v in M.items()},
          'wordmark':{'d':wpath,'w':wwid,'cap':cap}, 'lockup':lockup('light')[1]}
    open(D+'/proto/brand-data.js','w').write('window.D3B='+json.dumps(data)+';')
    json.dump({k:{'box':v[0],'arch':v[1],'stone':v[2]} for k,v in M.items()},open(D+'/brand/geometry.json','w'),indent=1)
    print('ok', wwid, cap)
