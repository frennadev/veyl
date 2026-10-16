import json, sys; sys.path.insert(0, '.')
from common import *
rows = ''
for k, (name, fn, _) in FIN.items():
    D64, D32 = d64(k), d32(k)
    sizes = lambda f, bg: (f'<div style="display:flex;gap:18px;align-items:flex-end;background:{bg};padding:20px">{mk(D64, f, 64)}{mk(D32, f, 32)}{mk(D32, f, 24)}{mk(D32, f, 16)}'
                           f'{zoom(D32, f, bg, 32)}{zoom(D32, f, bg, 16)}</div>')
    rows += f'''<div class=row>
 <div class=hd><b>{k.upper()}</b> {name}</div>
 <div class=r1>
  <div class=box style="background:{PAPER}">{mk(D64, ROSE, 230)}</div>
  <div class=box style="background:{LIGHT}">{mk(D64, OX, 230)}</div>
  <div class=col style="background:{PAPER}">{lk(k, ROSE, INK, 86)}{sizes(ROSE, PAPER)}{nav(k, False)}</div>
  <div class=col style="background:{LIGHT}">{lk(k, OX, DARKINK, 86)}{sizes(OX, LIGHT)}{nav(k, True)}</div>
 </div>
 <div class=r2>
  <div class=col style="background:#0f0b11;flex-direction:row;align-items:flex-end;gap:22px">{appicon(D64, 180)}{appicon(D64, 96)}{appicon(D32, 48)}
     <div style="display:flex;gap:14px;margin-left:24px">{mk(D64, '#000', 72, 'background:#fff')}{mk(D64, '#fff', 72, 'background:#000')}{mk(D64, SILVER, 72, 'background:#1b151f')}</div></div>
  <div style="width:600px;height:315px;overflow:hidden">{og(k, 0.5)}</div>
 </div></div>'''
html = f'''{BASE}{CSS}<body style="background:#1d1820;width:1720px;font-family:M;color:#BFB5B9">
<style>.row{{padding:28px;display:flex;flex-direction:column;gap:2px;border-bottom:2px solid #2b2430}}.hd{{font-size:20px;padding:0 0 14px}}
.r1,.r2{{display:flex;gap:2px}}.box{{width:300px;height:300px;display:grid;place-items:center}}
.col{{flex:1;padding:26px;display:flex;flex-direction:column;gap:18px;justify-content:center}}</style>{rows}{ZJS}</body>'''
json.dump([{'html': html, 'out': sys.argv[1], 'w': 1720, 'h': 800, 'full': True}], open('j2.json', 'w'))
