"""Set a word in a real font with HarfBuzz and export the font's own Bézier outlines."""
import numpy as np
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb
def shaped(path,text,features=None):
    font=TTFont(path);gs=font.getGlyphSet();order=font.getGlyphOrder()
    face=hb.Face(open(path,'rb').read());f=hb.Font(face)
    buf=hb.Buffer();buf.add_str(text);buf.guess_segment_properties()
    hb.shape(f,buf,features or {'kern':True,'liga':False,'calt':True})
    out=[];cur=0
    for info,pos in zip(buf.glyph_infos,buf.glyph_positions):
        name=order[info.codepoint];bp=BoundsPen(gs);gs[name].draw(bp)
        out.append(dict(name=name,x=cur+pos.x_offset,y=pos.y_offset,adv=pos.x_advance,bounds=bp.bounds))
        cur+=pos.x_advance
    return font,gs,out
# The earlier wordmark's letters: their ink height (the tallest ascender to
# the lowest overshoot) is what the wordmark's size is matched to, and a
# glyph's height does not depend on its neighbours, so their order is free.
EARLIER_LETTERS='defirs'
def layout(path,text,x_left,baseline,ref_height,ref_text=EARLIER_LETTERS,tracking_em=-0.02,pair_adjust=None):
    """Scale so ref_text's ink height equals ref_height (keeps the earlier wordmark's size); returns SVG group + ink box."""
    font,gs,ref=shaped(path,ref_text)
    bo=min(g['bounds'][1] for g in ref if g['bounds']);t=max(g['bounds'][3] for g in ref if g['bounds'])
    s=ref_height/(t-bo);upm=font['head'].unitsPerEm
    _,_,gl=shaped(path,text)
    shift=0;placed=[]
    for i,g in enumerate(gl):
        if i>0:shift+=tracking_em*upm
        if pair_adjust and i>0:shift+=pair_adjust.get(text[i-1]+text[i],0)*upm
        placed.append((g,g['x']+shift))
    l=min(x+g['bounds'][0] for g,x in placed if g['bounds']);r=max(x+g['bounds'][2] for g,x in placed if g['bounds'])
    top=max(g['bounds'][3] for g,x in placed if g['bounds']);bot=min(g['bounds'][1] for g,x in placed if g['bounds'])
    tx=x_left-l*s;ty=baseline
    paths=[]
    for g,x in placed:
        pen=SVGPathPen(gs,ntos=lambda v:('%.2f'%v).rstrip('0').rstrip('.'))
        gs[g['name']].draw(TransformPen(pen,(s,0,0,-s,tx+x*s,ty)))
        paths.append(pen.getCommands())
    box=(x_left,ty-top*s,tx+r*s,ty-bot*s)
    return paths,box,s
