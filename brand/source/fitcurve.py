"""Schneider (Graphics Gems) least-squares cubic fitting with G1 joins."""
import numpy as np
def q(b,t):
    t=np.asarray(t)[:,None];return (1-t)**3*b[0]+3*(1-t)**2*t*b[1]+3*(1-t)*t**2*b[2]+t**3*b[3]
def qd(b,t):
    t=np.asarray(t)[:,None];return 3*(1-t)**2*(b[1]-b[0])+6*(1-t)*t*(b[2]-b[1])+3*t**2*(b[3]-b[2])
def qdd(b,t):
    t=np.asarray(t)[:,None];return 6*(1-t)*(b[2]-2*b[1]+b[0])+6*t*(b[3]-2*b[2]+b[1])
def norm(v):return v/np.linalg.norm(v)
def chord(P):
    d=np.concatenate([[0],np.cumsum(np.linalg.norm(np.diff(P,axis=0),axis=1))]);return d/d[-1]
def gen(P,u,t1,t2):
    p0,p3=P[0],P[-1]
    A1=(3*(1-u)**2*u)[:,None]*t1;A2=(3*(1-u)*u**2)[:,None]*t2
    C=np.array([[(A1*A1).sum(),(A1*A2).sum()],[(A1*A2).sum(),(A2*A2).sum()]])
    tmp=P-q(np.array([p0,p0,p3,p3]),u)
    X=np.array([(A1*tmp).sum(),(A2*tmp).sum()])
    det=C[0,0]*C[1,1]-C[0,1]*C[1,0]
    seg=np.linalg.norm(p3-p0)
    if abs(det)>1e-12:
        a1=(X[0]*C[1,1]-X[1]*C[0,1])/det;a2=(C[0,0]*X[1]-C[1,0]*X[0])/det
    else: a1=a2=seg/3
    if a1<1e-6*seg or a2<1e-6*seg or a1>seg*1.2 or a2>seg*1.2: a1=a2=seg/3
    return np.array([p0,p0+t1*a1,p3+t2*a2,p3])
def reparam(b,P,u):
    d=q(b,u)-P;d1=qd(b,u);d2=qdd(b,u)
    num=(d*d1).sum(1);den=(d1*d1+d*d2).sum(1)
    with np.errstate(divide='ignore',invalid='ignore'):
        nu=np.where(np.abs(den)>1e-12,u-num/den,u)
    return np.clip(nu,0,1)
def maxerr(b,P,u):
    e=np.linalg.norm(q(b,u)-P,axis=1);i=int(np.argmax(e));return e[i],i
def fit(P,t1,t2,err):
    if len(P)==2:
        d=np.linalg.norm(P[1]-P[0])/3;return [np.array([P[0],P[0]+t1*d,P[1]+t2*d,P[1]])]
    u=chord(P);b=gen(P,u,t1,t2);e,i=maxerr(b,P,u)
    if e<err:return [b]
    if e<err*6:
        for _ in range(30):
            u=reparam(b,P,u);b=gen(P,u,t1,t2);e,i=maxerr(b,P,u)
            if e<err:return [b]
    i=max(1,min(len(P)-2,i))
    tc=norm(P[i-1]-P[i+1]) if i+1<len(P) else norm(P[i-1]-P[i])
    return fit(P[:i+1],t1,tc,err)+fit(P[i:],-tc,t2,err)
def fit_open(P,err,t_start=None,t_end=None,k=6):
    t1=norm(P[min(k,len(P)-1)]-P[0]) if t_start is None else t_start
    t2=norm(P[max(0,len(P)-1-k)]-P[-1]) if t_end is None else t_end
    return fit(P,t1,t2,err)
