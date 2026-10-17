import re, numpy as np, xml.etree.ElementTree as E
def parse_cubics(d, transform):
    tx,ty=map(float,re.findall(r'-?\d*\.?\d+',transform)) if transform else (0,0)
    toks=re.findall(r'[MCLZ]|-?\d*\.?\d+(?:e-?\d+)?',d)
    segs=[];i=0;cur=None;start=None;cmd=None
    while i<len(toks):
        t=toks[i]
        if t in 'MCLZ': cmd=t;i+=1
        if cmd=='M': cur=np.array([float(toks[i]),float(toks[i+1])]);start=cur;i+=2;cmd='L'
        elif cmd=='C':
            p=[np.array([float(toks[i+2*k]),float(toks[i+2*k+1])]) for k in range(3)];segs.append((cur,*p));cur=p[2];i+=6
        elif cmd=='L':
            p=np.array([float(toks[i]),float(toks[i+1])]);segs.append((cur,cur+(p-cur)/3,cur+2*(p-cur)/3,p));cur=p;i+=2
        elif cmd=='Z':
            if np.linalg.norm(cur-start)>1e-6: segs.append((cur,cur+(start-cur)/3,cur+2*(start-cur)/3,start))
            cur=start
    off=np.array([tx,ty])
    return [tuple(q+off for q in s) for s in segs]
def bez(s,t):
    t=np.asarray(t)[:,None];p0,p1,p2,p3=s
    return (1-t)**3*p0+3*(1-t)**2*t*p1+3*(1-t)*t**2*p2+t**3*p3
def sample(segs,step=0.25):
    pts=[]
    for s in segs:
        n=max(4,int(np.linalg.norm(s[3]-s[0])/step*1.5)+2)
        pts.append(bez(s,np.linspace(0,1,n,endpoint=False)))
    P=np.vstack(pts)
    # resample uniformly by arc length (closed)
    Q=np.vstack([P,P[:1]]);dl=np.linalg.norm(np.diff(Q,axis=0),axis=1);L=np.concatenate([[0],np.cumsum(dl)])
    u=np.arange(0,L[-1],step)
    return np.column_stack([np.interp(u,L,Q[:,0]),np.interp(u,L,Q[:,1])]),L[-1]
def turning(P,k):
    n=len(P);a=P[(np.arange(n)-k)%n];b=P[(np.arange(n)+k)%n]
    v1=P-a;v2=b-P
    ang=np.degrees(np.arctan2(v1[:,0]*v2[:,1]-v1[:,1]*v2[:,0],(v1*v2).sum(1)))
    return ang
def ribbons(svgpath):
    r=E.parse(svgpath).getroot();out=[]
    for cid in ('ribbon0','ribbon1'):
        p=r.find(f".//{{*}}clipPath[@id='{cid}']/{{*}}path");out.append(parse_cubics(p.get('d'),p.get('transform')))
    return out
