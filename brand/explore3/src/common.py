import base64, sys; sys.path.insert(0, '.')
from finals import *
FD = '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/fonts/node_modules/@fontsource/manrope/files'
def _f(w): return 'data:font/woff2;base64,' + base64.b64encode(open(f'{FD}/manrope-latin-{w}-normal.woff2', 'rb').read()).decode()
BASE = (''.join(f'@font-face{{font-family:M;src:url({_f(w)});font-weight:{w}}}' for w in (400, 500, 600)))
BASE = f'<style>{BASE}*{{box-sizing:border-box}}html,body{{margin:0}}</style>'
ROSE, OX, INK, DARKINK, PAPER, LIGHT, SILVER = '#D88595', '#7A2036', '#EEE8EA', '#1A1418', '#07050a', '#F3EEF0', '#A9A4AE'
ICONBG = 'radial-gradient(120% 95% at 50% 0%, #2a1b26 0%, #140d14 48%, #07050a 100%)'
def mk(d, fill, px, style=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{px}" height="{px}" style="display:block;{style}"><path fill="{fill}" d="{d}"/></svg>'
def lk(k, mf, wf, h):
    vb, md, wd = lockup(k)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" height="{h}" style="display:block;overflow:visible"><path fill="{mf}" d="{md}"/><path fill="{wf}" d="{wd}"/></svg>'
def zoom(d, fill, bg, sz):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="{fill}" d="{d}"/></svg>'
    return f'<canvas class=z data-s=\'{s}\' data-sz="{sz}" data-bg="{bg}"></canvas>'
ZJS = ("<script>document.querySelectorAll('canvas.z').forEach(cv=>{const sz=+cv.dataset.sz;cv.width=cv.height=sz;const x=cv.getContext('2d');"
       "x.fillStyle=cv.dataset.bg;x.fillRect(0,0,sz,sz);const im=new Image();im.onload=()=>x.drawImage(im,0,0,sz,sz);"
       "im.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(cv.dataset.s)})</script>")
def appicon(d, px, rounded=True, frac=0.58):
    r = f'border-radius:{px*0.2237:.2f}px;' if rounded else ''
    edge = f'box-shadow:inset 0 0 0 {max(1, px/256):.2f}px rgba(255,255,255,.07),inset 0 {px/128:.2f}px 0 rgba(255,255,255,.05);' if rounded else ''
    return f'<div style="width:{px}px;height:{px}px;{r}background:{ICONBG};display:grid;place-items:center;{edge}">{mk(d, ROSE, px*frac)}</div>'
def nav(k, light, w=None):
    bg, bd, tx, mf, wf, cb, ct = ('#ffffff', '#e8e0e3', '#5b5157', OX, DARKINK, OX, '#fff') if light else (PAPER, '#241c28', '#BFB5B9', ROSE, INK, OX, '#fff')
    return (f'<div class=nav style="background:{bg};border-color:{bd};color:{tx}">{lk(k, mf, wf, 26)}<span style="margin-left:auto">Pools</span><span>Positions</span><span>Docs</span>'
            f'<em style="background:{cb};color:{ct}">Launch app</em></div>')
def og(k, scale=1.0):
    vb, md, wd = lockup(k)
    return f'''<div style="width:1200px;height:630px;background:{PAPER};position:relative;overflow:hidden;font-family:M;transform:scale({scale});transform-origin:0 0">
<div style="position:absolute;inset:0;background:radial-gradient(55% 80% at 82% 50%, rgba(122,32,54,.34), rgba(7,5,10,0) 70%)"></div>
<div style="position:absolute;right:-70px;top:50%;transform:translateY(-50%)">{mk(d64(k), '#5a1a2b', 560)}</div>
<div style="position:absolute;left:96px;top:236px">{lk(k, ROSE, INK, 92)}</div>
<div style="position:absolute;left:98px;top:372px;color:#BFB5B9;font-size:32px;font-weight:400;letter-spacing:-.01em">Private DLMM liquidity on Solana</div></div>'''
CSS = '''<style>.nav{height:64px;display:flex;align-items:center;gap:30px;padding:0 24px;border:1px solid;font:500 15px M;border-radius:14px}
.nav em{font-style:normal;padding:9px 16px;border-radius:999px;white-space:nowrap}.z{width:96px;height:96px;image-rendering:pixelated}</style>'''
