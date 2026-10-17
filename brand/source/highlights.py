"""Edge-following highlights: tapered rims and crescents built from the polished outline."""
import numpy as np
import shapely
from shapely.geometry import Polygon, LineString
from geom import sample, parse_cubics, bez
from fitcurve import fit_open
STEP=0.25
class Outline:
    def __init__(self,cubics):
        self.P,_=sample([tuple(c) for c in cubics],STEP)
        T=np.roll(self.P,-1,0)-np.roll(self.P,1,0);T/=np.linalg.norm(T,axis=1)[:,None]
        N=np.column_stack([-T[:,1],T[:,0]])
        self.poly=Polygon(self.P)
        k=len(self.P)//3
        if not self.poly.contains(shapely.Point(*(self.P[k]+N[k]))):N=-N
        self.N=N
    def idx(self,pt):return int(np.argmin(np.linalg.norm(self.P-np.array(pt),axis=1)))
    def section(self,a,b):
        n=len(self.P);i,j=self.idx(a),self.idx(b)
        fwd=(j-i)%n;bwd=(i-j)%n
        ids=(i+np.arange(fwd+1))%n if fwd<=bwd else (i-np.arange(bwd+1))%n
        return self.P[ids],self.N[ids]
    def width(self,P,N,reach=120):
        """Distance along the inward normal to the opposite edge."""
        out=[]
        for p,n in zip(P,N):
            ray=LineString([p+n*0.6,p+n*reach]);x=ray.intersection(self.poly.exterior)
            pts=np.array([g.coords[0] for g in getattr(x,'geoms',[x])]) if not x.is_empty else None
            out.append(reach if pts is None else np.min(np.linalg.norm(pts-p,axis=1)))
        return np.array(out)
def profile(m,power=0.75,skew=1.0):
    s=np.linspace(0,1,m)**skew
    return np.sin(np.pi*s)**power
def to_path(side_a,side_b,err=0.06):
    A=fit_open(side_a,err);B=fit_open(side_b[::-1],err)
    f=lambda p:f'{p[0]:.2f} {p[1]:.2f}'
    d='M'+f(A[0][0])
    for c in A+B:d+=' C'+f(c[1])+' '+f(c[2])+' '+f(c[3])
    return d+' Z'
def rim(o,a,b,inset,width,power=0.75,skew=1.0,max_frac=0.3):
    """A specular rim at a constant inset (capped by the local ribbon width), tapering to needle points."""
    P,N=o.section(a,b);W=o.width(P,N)
    d=np.minimum(inset,max_frac*W)
    w=np.minimum(width/2*profile(len(P),power,skew),0.12*W)
    C=P+N*d[:,None]
    return to_path(C+N*w[:,None],C-N*w[:,None])
def crescent(o,a,b,depth,inset=0.0,power=0.8,skew=1.0,overshoot=1.5,max_frac=0.45):
    """A reflection hugging the edge; with inset=0 its outer side runs past the edge and the clip trims it."""
    P,N=o.section(a,b);W=o.width(P,N)
    w=np.minimum(depth*profile(len(P),power,skew),max_frac*W)
    t=np.clip(w/max(depth,1e-6)*4,0,1)
    if inset>0:
        # floating reflection: both sides keep the inset, so the ends close as clean needles
        return to_path(P+N*inset,P+N*(inset+w)[:,None])
    return to_path(P-N*(overshoot*t)[:,None],P+N*w[:,None])
