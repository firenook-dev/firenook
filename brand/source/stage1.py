import numpy as np, xml.etree.ElementTree as E
from geom import *
from polish_outline import *
NS='http://www.w3.org/2000/svg';E.register_namespace('',NS)
red,amb=ribbons('source-tailored.svg')
# (point, trim radius used to discard the traced corner blob, fillet trim length)
CFG={'ribbon0':(red,[((457,132),3,0),((360,525.3),5,0),((233,613),9,7)]),
     'ribbon1':(amb,[((314.2,768),3,0),((393.8,396.8),5,0),((528.5,300.2),9,7)])}
def polished_paths(sigma=10.0,err=1.0):
    return {cid:polish2(segs,corners,sigma,err)[0] for cid,(segs,corners) in CFG.items()}
if __name__=='__main__':
    import sys
    from scipy.spatial import cKDTree
    tree=E.parse('source-tailored.svg');r=tree.getroot();sil=[]
    for cid,cub in polished_paths().items():
        p=r.find(f".//{{*}}clipPath[@id='{cid}']/{{*}}path");p.set('d',to_d(cub));p.attrib.pop('transform',None)
        sil.append(f'<path d="{to_d(cub)}" fill="#202124"/>')
        P0,_=sample(CFG[cid][0],0.2);P1,_=sample([tuple(c) for c in cub],0.2);d,_=cKDTree(P0).query(P1)
        print(cid,len(cub),'cubics; dev mean %.2f p95 %.2f max %.2f'%(d.mean(),np.percentile(d,95),d.max()))
    tree.write('stage1.svg',xml_declaration=True,encoding='utf-8')
    open('stage1-sil.svg','w').write(f'<svg xmlns="{NS}" width="560" height="700" viewBox="110 110 560 700"><rect x="110" y="110" width="560" height="700" fill="#fff"/>{"".join(sil)}</svg>')
