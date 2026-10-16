import sys; sys.path.insert(0,'.')
from geo import *
from marks import pane, flap_curve

def master(X=7, Y=7, S=50, bins=5, gv=None, gc=None, Rt=None, Rb=None, yL=None, yC=None, b=0.48, a=0.34):
    k = S/50
    gv = 3.0*k if gv is None else gv
    gc = 3.1*k if gc is None else gc
    Rt = 13*k if Rt is None else Rt
    Rb = 5.5*k if Rb is None else Rb
    yL = Y + 17.6*k if yL is None else yL
    yC = Y + 35.2*k if yC is None else yC
    c = flap_curve(yL=yL, yC=yC, X=X, W=S, a=a, b=b, ext=3*k)
    up = c.offset(-gc/2)
    assert up.y(X) >= Y+Rt+0.3*k, (up.y(X), Y+Rt)
    return pane(c, X=X, Y=Y, W=S, H=S, Rt=Rt, Rb=Rb, kt=0.82, kb=0.8, g=gc, gaps=[gv]*(bins-1), n=bins)

M64 = master()
# 32px grid: pane 2..30, bins 4px, gaps 2px
M32 = master(X=2, Y=2, S=28, gv=2, gc=2.05, Rt=7.2, Rb=3, yL=12, yC=21.5)
# 16px grid options
M16a = master(X=1, Y=1, S=14, bins=3, gv=1, gc=1.35, Rt=3.9, Rb=1.6, yL=6.4, yC=10.6)
M16b = master(X=1, Y=1, S=14, bins=5, gv=1, gc=1.2, Rt=3.9, Rb=1.6, yL=6.4, yC=10.6)
if __name__ == '__main__':
    import json
    def mk(d, vb): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><path fill="currentColor" d="{d}"/></svg>'
    print(json.dumps({'m64': mk(M64,'0 0 64 64'), 'm32': mk(M32,'0 0 32 32'), 'm16a': mk(M16a,'0 0 16 16'), 'm16b': mk(M16b,'0 0 16 16')}))
