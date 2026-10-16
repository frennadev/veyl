import base64, json, subprocess, sys; sys.path.insert(0, '.')
from geo import *
SRCPNG = '/home/claude/veyl-sol/brand/owner/source-owner.png'
b64 = base64.b64encode(open(SRCPNG, 'rb').read()).decode()
m = master(); d = D(m)
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" width="1254" height="1254" style="position:absolute;inset:0"><path d="{d}" fill="#1E5BFF" fill-opacity=".5"/></svg>'
outl = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" width="1254" height="1254" style="position:absolute;inset:0"><path d="{d}" fill="none" stroke="#E0004D" stroke-width="1.2"/></svg>'
html = (f'<body style="margin:0"><div style="position:relative;width:1254px;height:1254px"><img src="data:image/png;base64,{b64}" style="position:absolute;inset:0">{svg}{outl}'
        f'<div style="position:absolute;left:30px;top:30px;font:500 22px sans-serif;color:#333">Rebuilt SVG (blue, 50%) + outline (red) over the supplied raster</div></div></body>')
mask = f'<body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" width="1254" height="1254" style="display:block"><path d="{d}" fill="#000"/></svg></body>'
J = [{'html': html, 'out': '/home/claude/veyl-sol/brand/owner/overlay.png', 'w': 1254, 'h': 1254},
     {'html': mask, 'out': '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/ovmask.png', 'w': 1254, 'h': 1254}]
json.dump(J, open('/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/ov.json', 'w'))
