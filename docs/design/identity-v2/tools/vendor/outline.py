# Outline a word from a variable font instance to an SVG path (units: font units, y-up flipped).
import sys  # needs fontTools 4.68.0 + brotli (tools/requirements.txt)
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
def outline(fontpath, text, axes, size=100, tracking=0.0, kern=None):
    f=TTFont(fontpath)
    inst=instancer.instantiateVariableFont(f, axes, inplace=False)
    gs=inst.getGlyphSet(); cmap=inst.getBestCmap(); upm=inst['head'].unitsPerEm
    sc=size/upm; x=0; paths=[]
    hmtx=inst['hmtx']
    asc=inst['OS/2'].sCapHeight if hasattr(inst['OS/2'],'sCapHeight') else 700
    xh=inst['OS/2'].sxHeight
    for i,ch in enumerate(text):
        g=cmap[ord(ch)]
        pen=SVGPathPen(gs)
        tp=TransformPen(pen,(sc,0,0,-sc,x,0))
        gs[g].draw(tp)
        paths.append(pen.getCommands())
        adv=hmtx[g][0]*sc + tracking*size
        if kern and i < len(text)-1: adv += kern.get(text[i:i+2],0)*size
        x+=adv
    return ''.join(paths), x, asc*sc, xh*sc
if __name__=='__main__':
    p,w,cap,xh=outline(sys.argv[1], sys.argv[2], {'wght':float(sys.argv[3]),'CRSV':float(sys.argv[4]),'SHRP':0,'slnt':0})
    print(w,cap,xh); print(p[:200])
