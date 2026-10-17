"""Mark: polished outlines + rebuilt edge highlights; all other lighting kept as approved."""
import xml.etree.ElementTree as E
from stage1 import polished_paths
from polish_outline import to_d
from highlights import Outline, rim, crescent
NS='http://www.w3.org/2000/svg';E.register_namespace('',NS)
def el(tag,**a):return E.Element('{'+NS+'}'+tag,{k.replace('_','-'):str(v) for k,v in a.items()})
def build_mark(src='source-tailored.svg'):
    tree=E.parse(src);r=tree.getroot()
    pp=polished_paths();red=Outline(pp['ribbon0']);amb=Outline(pp['ribbon1'])
    for cid,cub in pp.items():
        p=r.find(f".//{{*}}clipPath[@id='{cid}']/{{*}}path");p.set('d',to_d(cub));p.attrib.pop('transform',None)
        p.attrib.pop('fill',None)
    g_red=r.find("{*}g[@id='red-liquid-ribbon']");g_amb=r.find("{*}g[@id='amber-liquid-ribbon']")
    def replace(group,match,new):
        for i,child in enumerate(list(group)):
            if child.get('d','').startswith(match):
                group.remove(child);group.insert(i,new);return
        raise SystemExit('missing '+match)
    # red ribbon
    replace(g_red,'M451 140',el('path',d=rim(red,(451,140),(188,360),5.5,3.0),fill='url(#red-rim)'))
    replace(g_red,'M439 323',el('path',d=crescent(red,(439,323),(354,521),8.5,skew=2.2,power=0.9),fill='url(#red-inner)'))
    replace(g_red,'M150 446',el('path',d=rim(red,(150,446),(231,606),11.0,2.2),fill='#ffad72',fill_opacity=0.55))
    # amber ribbon
    replace(g_amb,'M532 308',el('path',d=crescent(amb,(545.8,307.9),(612,420),16.0,inset=4.0,power=0.6,skew=0.7),fill='url(#tailored-shoulder-reflection)'))
    replace(g_amb,'M535 310',el('path',d=rim(amb,(535,310),(509,594),7.5,2.4),fill='url(#tailored-outer-rim)'))
    replace(g_amb,'M318 756',el('path',d=rim(amb,(332.6,756.2),(459,647),9.5,2.7),fill='url(#tailored-tip-rim)'))
    return tree
if __name__=='__main__':
    build_mark().write('stage2.svg',xml_declaration=True,encoding='utf-8')
