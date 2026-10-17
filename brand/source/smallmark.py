"""Optically adjusted outlines for tab-size favicons: each flame shrunk so the gap survives 16-32 px."""
import numpy as np
from shapely.geometry import Polygon
from geom import parse_cubics, sample
from fitcurve import fit_open, norm


def eroded(d, amount, step=0.5):
    """Inset a ribbon outline by `amount` units; returns a closed polyline starting at its sharpest tip."""
    P, _ = sample(parse_cubics(d, None), step)
    poly = Polygon(P).buffer(-amount, join_style='mitre', mitre_limit=8)
    Q = np.array(poly.exterior.coords)
    # resample uniformly so the fitter sees evenly spaced points
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(Q, axis=0), axis=1))])
    u = np.arange(0, L[-1], step)
    Q = np.column_stack([np.interp(u, L, Q[:, 0]), np.interp(u, L, Q[:, 1])])
    k = int(round(4 / step))
    a = np.roll(Q, k, 0) - Q
    b = np.roll(Q, -k, 0) - Q
    cos = (a * b).sum(1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
    start = int(np.argmax(cos))
    Q = np.roll(Q, -start, 0)
    return np.vstack([Q, Q[:1]])


def to_d(Q, err=0.6):
    k = 8
    cubics = fit_open(Q, err, norm(Q[k] - Q[0]), norm(Q[-1 - k] - Q[-1]))
    f = lambda p: f'{p[0]:.2f} {p[1]:.2f}'
    s = 'M' + f(cubics[0][0])
    for c in cubics:
        s += ' C' + f(c[1]) + ' ' + f(c[2]) + ' ' + f(c[3])
    return s + ' Z'
