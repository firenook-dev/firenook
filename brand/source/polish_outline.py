import numpy as np, sys
from geom import *
from fitcurve import fit_open, norm
from scipy.ndimage import gaussian_filter1d
STEP=0.2
def nearest_idx(P,pt):return int(np.argmin(np.linalg.norm(P-np.array(pt),axis=1)))
def line_intersect(p,d,q_,e):
    A=np.array([d,-e]).T
    try: s,t=np.linalg.solve(A,q_-p)
    except np.linalg.LinAlgError: return None
    return p+s*d
def smooth_run(R,sigma_px):
    s=sigma_px/STEP;n=int(4*s)+1
    if len(R)<3:return R
    n=min(n,len(R)-1)
    pre=2*R[0]-R[1:n+1][::-1];post=2*R[-1]-R[-n-1:-1][::-1]
    X=np.vstack([pre,R,post])
    Y=np.column_stack([gaussian_filter1d(X[:,0],s,mode='nearest'),gaussian_filter1d(X[:,1],s,mode='nearest')])
    Y=Y[n:n+len(R)];Y[0]=R[0];Y[-1]=R[-1];return Y
def polish(segs,corners,sigma=6.0,err=0.45,rho=None):
    """corners: list of (approx_point, rho_px) — sharp points rebuilt at tangent intersections."""
    P,_=sample(segs,STEP)
    n=len(P)
    cidx=sorted(nearest_idx(P,c) for c,_ in corners)
    rhos={nearest_idx(P,c):r for c,r in corners}
    # build runs between corners, trimming rho around each corner
    runs=[];new_corners={}
    for a,b in zip(cidx,cidx[1:]+[cidx[0]+n]):
        ra=rhos[a%n];rb=rhos[b%n]
        idx=np.arange(a+int(ra/STEP),b-int(rb/STEP)+1)%n
        runs.append(P[idx])
    # corner points = intersection of tangent lines of adjacent runs
    pts=[]
    for k,c in enumerate(cidx):
        prev=runs[k-1];nxt=runs[k]
        d1=norm(prev[-1]-prev[-int(6/STEP)]);d2=norm(nxt[0]-nxt[int(6/STEP)])
        x=line_intersect(prev[-1],d1,nxt[0],d2)
        if x is None or np.linalg.norm(x-P[c])>3*max(rhos[c],2): x=P[c]
        pts.append(x)
    out=[];report=[]
    for k in range(len(runs)):
        a=pts[k];b=pts[(k+1)%len(pts)]
        R=np.vstack([a,runs[k],b])
        # densify the joins to the corner points
        R=np.vstack([np.linspace(R[0],R[1],max(2,int(np.linalg.norm(R[1]-R[0])/STEP)),endpoint=False),R[1:-1],np.linspace(R[-2],R[-1],max(2,int(np.linalg.norm(R[-1]-R[-2])/STEP)))])
        S=smooth_run(R,sigma)
        # tangents at the corner come from the trimmed run, so edges meet as clean points
        t1=norm(S[int(10/STEP)]-S[0]);t2=norm(S[-int(10/STEP)]-S[-1])
        out+=fit_open(S,err,t1,t2)
    return out,pts
def to_d(cubics,prec=2):
    f=lambda p:f'{p[0]:.{prec}f} {p[1]:.{prec}f}'
    d='M'+f(cubics[0][0])
    for c in cubics:d+=' C'+f(c[1])+' '+f(c[2])+' '+f(c[3])
    return d+' Z'

def split(b,t):
    p0,p1,p2,p3=b;a=p0+(p1-p0)*t;bb=p1+(p2-p1)*t;c=p2+(p3-p2)*t
    d=a+(bb-a)*t;e=bb+(c-bb)*t;f=d+(e-d)*t
    return np.array([p0,a,d,f]),np.array([f,e,c,p3])
def t_at_dist(b,corner,dist,from_end):
    lo,hi=(0.0,1.0)
    # distance from corner is monotone near the corner for our short trims
    for _ in range(60):
        mid=(lo+hi)/2;p=(1-mid)**3*b[0]+3*(1-mid)**2*mid*b[1]+3*(1-mid)*mid**2*b[2]+mid**3*b[3]
        dd=np.linalg.norm(p-corner)
        if from_end: (lo,hi)=(mid,hi) if dd>dist else (lo,mid)
        else: (lo,hi)=(lo,mid) if dd>dist else (mid,hi)
    return (lo+hi)/2
def polish2(segs,corners,sigma=10.0,err=1.0):
    """corners: (approx_point, trim_rho_px, fillet_trim_px)."""
    P,_=sample(segs,STEP);n=len(P)
    order=sorted(range(len(corners)),key=lambda k:nearest_idx(P,corners[k][0]))
    corners=[corners[k] for k in order]
    cidx=[nearest_idx(P,c[0]) for c in corners]
    runs=[]
    for k,a in enumerate(cidx):
        b=cidx[(k+1)%len(cidx)]+(n if k==len(cidx)-1 else 0)
        idx=np.arange(a+int(corners[k][1]/STEP),b-int(corners[(k+1)%len(corners)][1]/STEP)+1)%n
        runs.append(P[idx])
    pts=[]
    for k,c in enumerate(cidx):
        prev=runs[k-1];nxt=runs[k]
        d1=norm(prev[-1]-prev[-int(6/STEP)]);d2=norm(nxt[0]-nxt[int(6/STEP)])
        x=line_intersect(prev[-1],d1,nxt[0],d2)
        if x is None or np.linalg.norm(x-P[c])>3*max(corners[k][1],2):x=P[c]
        pts.append(x)
    fitted=[]
    for k in range(len(runs)):
        a=pts[k];b=pts[(k+1)%len(pts)];R=runs[k]
        R=np.vstack([np.linspace(a,R[0],max(2,int(np.linalg.norm(R[0]-a)/STEP)),endpoint=False),R,np.linspace(R[-1],b,max(2,int(np.linalg.norm(b-R[-1])/STEP)))[1:]])
        S=smooth_run(R,sigma)
        t1=norm(S[int(10/STEP)]-S[0]);t2=norm(S[-int(10/STEP)]-S[-1])
        fitted.append([np.array(c) for c in fit_open(S,err,t1,t2)])
    # fillets
    for k,c in enumerate(corners):
        f=c[2]
        if not f:continue
        inc=fitted[k-1];out=fitted[k];corner=pts[k]
        ti=t_at_dist(inc[-1],corner,f,True);inc[-1],_=split(inc[-1],ti)
        to=t_at_dist(out[0],corner,f,False);_,out[0]=split(out[0],to)
        A=inc[-1][3];B=out[0][0]
        tA=norm(inc[-1][3]-inc[-1][2]);tB=norm(out[0][1]-out[0][0])
        phi=np.arccos(np.clip(np.dot(tA,tB),-1,1))
        Rr=f/np.tan(phi/2) if phi>1e-3 else f
        h=4/3*np.tan(phi/4)*Rr
        fitted[k-1].append(np.array([A,A+tA*h,B-tB*h,B]))
    out=[c for run in fitted for c in run]
    return out,pts
