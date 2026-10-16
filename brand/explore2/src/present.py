import json, sys
sys.path.insert(0,'.')
from assets import *
from final_mark import M16b
def zoom(fill, bg, d, vb, sz):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><path fill="{fill}" d="{d}"/></svg>'
    return f'<canvas class=z data-s=\'{s}\' data-sz="{sz}" data-bg="{bg}"></canvas>'
def sizes(fill, bg):
    return (f'<div class=sizes style="background:{bg}">' + mk(fill, 64) + mk(fill, 32, M32, '0 0 32 32') + mk(fill, 24) +
            mk(fill, 16, M32, '0 0 32 32') + zoom(fill, bg, M32, '0 0 32 32', 32) + zoom(fill, bg, M32, '0 0 32 32', 16) + '</div>')
def nav(light):
    bg, bd, tx, mf, wf = ('#ffffff', '#e8e0e3', '#5b5157', OX, DARKINK) if light else ('#07050a', '#241c28', '#BFB5B9', ROSE, INK)
    return (f'<div class=nav style="background:{bg};border-color:{bd};color:{tx}">{lock(mf, wf, 26)}<span style="margin-left:auto">Pools</span><span>Positions</span><span>Docs</span>'
            f'<em style="background:{ROSE if not light else OX};color:{"#1a0b10" if not light else "#fff"}">Launch app</em></div>')
html = f'''<body style="width:1600px;background:#141016;font-family:IS;color:#9A8F94;padding:0">
<style>
.hero{{display:flex;align-items:center;gap:120px;padding:110px 120px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:#141016}}
.cell{{padding:44px 56px;display:flex;flex-direction:column;gap:22px;justify-content:center}}
.sizes{{display:flex;align-items:flex-end;gap:26px;padding:26px}}
.z{{width:128px;height:128px;image-rendering:pixelated}}
.nav{{height:64px;display:flex;align-items:center;gap:30px;padding:0 26px;border:1px solid;font:500 15px IS;border-radius:14px}}
.nav em{{font-style:normal;padding:9px 16px;border-radius:999px}}
.cap{{font-size:14px;letter-spacing:.01em}}
.icons{{display:flex;gap:28px;align-items:flex-end}}
.tab{{display:flex;gap:10px;align-items:center;background:#2b2530;color:#e6dfe3;padding:11px 16px;border-radius:10px 10px 0 0;width:260px;font-size:14px}}
</style>
<div class=hero style="background:#07050a">{mk(ROSE, 400)}<div style="display:flex;flex-direction:column;gap:56px">{lock(ROSE, INK, 150)}<div style="color:#BFB5B9;font-size:22px;max-width:520px;line-height:1.45">The flap is a veil, a sealed note and a V at once; under it, the bins of a bid-ask book.</div></div></div>
<div class=hero style="background:#F3EEF0;padding:80px 120px">{mk(OX, 260)}{lock(OX, DARKINK, 110)}<div style="margin-left:auto;display:flex;gap:26px">{mk('#000', 88)}{mk('#fff', 88, style="background:#000;padding:0")}</div></div>
<div class=grid>
 <div class=cell style="background:#07050a">{sizes(ROSE, '#07050a')}{nav(False)}</div>
 <div class=cell style="background:#F3EEF0">{sizes(OX, '#F3EEF0')}{nav(True)}</div>
 <div class=cell style="background:#0f0b11"><div class=icons>{appicon(180)}{appicon(120)}{appicon(76)}{appicon(40)}</div><div class=cap>App icon · 32 px grid for favicon and small UI</div></div>
 <div class=cell style="background:#1d1820"><div style="display:flex;gap:2px;background:#1a161c;padding:10px 10px 0;border-radius:12px 12px 0 0"><div class=tab>{mk(ROSE, 16, M32, '0 0 32 32')}Veyl</div><div class=tab style="background:transparent;color:#8d858a">{mk('#8d858a',16,M32,'0 0 32 32')}Pools · Veyl</div></div>
   <div style="display:flex;gap:2px;background:#e9e4e7;padding:10px 10px 0;border-radius:12px 12px 0 0"><div class=tab style="background:#fff;color:#222">{mk(OX, 16, M32, '0 0 32 32')}Veyl</div></div></div>
</div>
<script>document.querySelectorAll('canvas.z').forEach(cv=>{{const sz=+cv.dataset.sz;cv.width=cv.height=sz;const x=cv.getContext('2d');x.fillStyle=cv.dataset.bg;x.fillRect(0,0,sz,sz);const im=new Image();im.onload=()=>x.drawImage(im,0,0,sz,sz);im.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(cv.dataset.s)}})</script>
</body>'''
json.dump([{'html': BASE+html, 'out': f'{BR}/final.png', 'w': 1600, 'h': 1000, 'transparent': False, 'full': True}], open('pj.json','w'))
