"""python3 deliver.py [A-F]  -> writes the colourway's files into brand/ (default A, the recommended one) and the
per-colourway SVG sets into brand/owner/<X>/ (a swap = cp brand/owner/<X>/*.svg brand/ , then rerun this for the PNGs)."""
import json, os, sys, base64; sys.path.insert(0, '.'); sys.path.insert(0, '/home/claude/veyl-sol/brand/explore3/src')
from mk import *
from common import BASE, ZJS
from sheet import OPT, DARKICON, OXICON, GOLD, GOLDD, INK, DINK, PAPER
BR = '/home/claude/veyl-sol/brand'; OWN = f'{BR}/owner'; S = '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad'
K = (sys.argv[1] if len(sys.argv) > 1 else 'A').upper()
def W(p, s): os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w').write(s)
def favicon(dk, lt):
    if isinstance(dk['mark'], list):
        t, b = SPLIT[DS]
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.t{{fill:{lt["mark"][1]}}}.b{{fill:{lt["mark"][2]}}}'
                f'@media (prefers-color-scheme:dark){{.t{{fill:{dk["mark"][1]}}}.b{{fill:{dk["mark"][2]}}}}}</style>'
                f'<path class="t" d="{t}"/><path class="b" d="{b}"/></svg>\n')
    return favicon1(dk, lt)
def favicon1(dk, lt):
    # one file, both schemes; gradient colourways fall back to their first stop (flat, one-colour safe at 16 px)
    f = lambda p: p.get('fav') or (p['mark'][0] if isinstance(p['mark'], tuple) else p['mark'])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>path{{fill:{f(lt)}}}@media (prefers-color-scheme:dark){{path{{fill:{f(dk)}}}}}</style>'
            f'<path d="{DS}"/></svg>\n')
def svgset(k, root):
    _, _, dk, lt = OPT[k]
    W(f'{root}/veyl-mark.svg', mark_svg(DM, dk['mark'], standalone=True))
    W(f'{root}/veyl-mark-small.svg', mark_svg(DS, dk['mark'], standalone=True))
    W(f'{root}/veyl-lockup.svg', lockup_svg(dk['mark'], dk['word'], standalone=True))
    W(f'{root}/veyl-mark-light.svg', mark_svg(DM, lt['mark'], standalone=True))
    W(f'{root}/veyl-lockup-light.svg', lockup_svg(lt['mark'], DINK if lt['word'] == DINK else lt['word'], standalone=True))
    W(f'{root}/favicon.svg', favicon(dk, lt))
for k in OPT: svgset(k, f'{OWN}/{k}')
svgset(K, BR)
_, _, dk, lt = OPT[K]
# legacy names from the previous mark, kept so nothing points at a stale logo
for old in ('veyl-mark-oxblood.svg', 'veyl-mark-32grid.svg'):
    if os.path.exists(f'{BR}/{old}'): os.remove(f'{BR}/{old}')
for n, c in (('white', '#FFFFFF'), ('black', '#000000'), ('currentcolor', 'currentColor'), ('light', INK), ('dark', DINK)):
    W(f'{BR}/mono/veyl-mark-{n}.svg', mark_svg(DM, c, standalone=True)); W(f'{BR}/mono/veyl-lockup-{n}.svg', lockup_svg(c, c, standalone=True))
W(f'{BR}/mark-path.txt', f'master (5 pills, 0 0 64 64):\n{DM}\n\nsmall (4 pills, pixel grid, <=32 px):\n{DS}\n')

def mk(d, fill, px, style=''): return mark_svg(d, fill, px, style)
def appicon(d, px, rounded=True, frac=0.64, bg=None):
    bg = bg or (OXICON if K == 'B' else DARKICON)
    r = f'border-radius:{px*0.2237:.2f}px;' if rounded else ''
    edge = f'box-shadow:inset 0 0 0 {max(1, px/256):.2f}px rgba(255,255,255,.07),inset 0 {px/128:.2f}px 0 rgba(255,255,255,.05);' if rounded else ''
    return f'<div style="width:{px}px;height:{px}px;{r}background:{bg};display:grid;place-items:center;{edge}">{mk(d, dk["imark"], round(px*frac))}</div>'
def og(scale=1.0):
    return f'''<div style="width:1200px;height:630px;background:{PAPER};position:relative;overflow:hidden;font-family:M;transform:scale({scale});transform-origin:0 0">
<div style="position:absolute;inset:0;background:radial-gradient(60% 85% at 84% 50%, rgba(122,32,54,.30), rgba(7,5,10,0) 70%)"></div>
<div style="position:absolute;right:-90px;top:50%;transform:translateY(-50%);opacity:.22">{mk(DM, dk["mark"], 640)}</div>
<div style="position:absolute;left:96px;top:190px">{lockup_svg(dk["mark"], dk["word"], 92)}</div>
<div style="position:absolute;left:96px;top:356px;color:#EEE8EA;font-size:58px;letter-spacing:-.03em;line-height:1">Liquidity, <span style="font-family:IS;font-style:italic;color:#F2C0CB;font-size:64px">without a name.</span></div>
<div style="position:absolute;left:98px;top:452px;color:#9A8F94;font-size:26px;letter-spacing:-.01em">Private DLMM liquidity on Solana</div></div>'''
import base64 as _b64
_IS = _b64.b64encode(open('/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/fonts/node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2','rb').read()).decode()
BASE = BASE + '<style>@font-face{font-family:IS;font-style:italic;src:url(data:font/woff2;base64,' + _IS + ') format("woff2")}</style>'
J = []
def job(html, out, w, h, t=False, full=False): J.append({'html': BASE + html, 'out': out, 'w': w, 'h': h, 'transparent': t, 'full': full})
job(f'<body style="background:transparent">{appicon(DM, 512)}</body>', f'{BR}/veyl-app-icon-512.png', 512, 512, True)
job(f'<body>{appicon(DM, 180, rounded=False, frac=0.66)}</body>', f'{BR}/apple-touch-icon.png', 180, 180)
job(f'<body style="background:{PAPER};display:grid;place-items:center;height:512px">{mk(DM, dk["mark"], 420)}</body>', f'{BR}/png-mark-512-dark.png', 512, 512)
job(f'<body style="background:transparent">{mk(DM, dk["mark"], 512)}</body>', f'{BR}/veyl-mark-512.png', 512, 512, True)
job(f'<body style="background:transparent">{mk(DS, dk["mark"], 32)}</body>', f'{BR}/favicon-32.png', 32, 32, True)
job(f'<body>{og()}</body>', f'{BR}/og.png', 1200, 630)

def zoom(d, fill, bg, sz, show=96):
    s = mark_svg(d, fill).replace('<svg ', '<svg width="64" height="64" ', 1)
    return f'<canvas class=z data-s=\'{s}\' data-sz="{sz}" data-bg="{bg}" style="width:{show}px;height:{show}px;image-rendering:pixelated;border-radius:6px"></canvas>'
def nav(light):
    p = lt if light else dk
    return (f'<div class=nav style="background:{p["surf"]};border-color:{p["bd"]};color:{p["link"]}">{lockup_svg(p["mark"], p["word"], 28)}'
            f'<span style="margin-left:auto">Products</span><span>Liquidity</span><span>Docs</span><em style="background:{p["cta"]};color:{p["ctaf"]}">Open testnet</em></div>')
ov = base64.b64encode(open(f'{OWN}/overlay.png', 'rb').read()).decode()
hero = base64.b64encode(open(f'{S}/hero-rec.png', 'rb').read()).decode()
name = OPT[K][0]
html = f'''<body style="width:1600px;background:#141016;font-family:M;color:#9A8F94">
<style>.hero{{display:flex;align-items:center;gap:100px;padding:100px 120px}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:2px}}
.cell{{padding:40px 52px;display:flex;flex-direction:column;gap:26px;justify-content:center}}p{{margin:0;font-size:16px;line-height:1.55;max-width:600px}}
.nav{{height:64px;display:flex;align-items:center;gap:28px;padding:0 22px;border:1px solid;font:500 15px M;border-radius:14px}}
.nav em{{font-style:normal;padding:9px 16px;border-radius:7px;white-space:nowrap}}.lbl{{font-size:13px;color:#9A8F94;text-align:center;margin-top:6px}}</style>
<div class=hero style="background:{PAPER}">{mk(DM, dk["mark"], 360)}<div style="display:flex;flex-direction:column;gap:46px">{lockup_svg(dk["mark"], dk["word"], 116)}
<p style="color:#BFB5B9;font-size:21px;max-width:560px">Five liquidity bins rising to the active price, cut by one clean line. The owner&#8217;s mark, rebuilt as exact geometry: pills as true semicircle-ended bars on one pitch, the cut as real negative space.</p>
<p style="color:#BFB5B9;font-size:15px">Colourway {K}: {name} &#183; mark {" / ".join(dk["mark"][1:]) if isinstance(dk["mark"], list) else dk["mark"] if not isinstance(dk["mark"], tuple) else " to ".join(dk["mark"])} on {PAPER}, ink wordmark &#183; light grounds use {" / ".join(lt["mark"][1:]) if isinstance(lt["mark"], list) else lt["mark"] if not isinstance(lt["mark"], tuple) else " to ".join(lt["mark"])}</p></div></div>
<div class=hero style="background:#FAF7F2;padding:70px 120px">{mk(DM, lt["mark"], 220)}{lockup_svg(lt["mark"], DINK, 92)}<div style="margin-left:auto;display:flex;gap:20px">{mk(DM, "#000", 84)}{mk(DM, "#fff", 84, "background:#000;padding:10px;width:104px;height:104px;border-radius:10px")}</div></div>
<div class=grid>
 <div class=cell style="background:{PAPER}">{nav(False)}<div style="display:flex;gap:22px;align-items:flex-end">{mk(DM, dk["mark"], 64)}{mk(DM, dk["mark"], 40)}{mk(DS, dk["mark"], 32)}{mk(DS, dk["mark"], 24)}{mk(DS, dk["mark"], 16)}
   <div>{zoom(DS, dk["mark"], PAPER, 16)}<div class=lbl>16 px</div></div><div>{zoom(DS, dk["mark"], PAPER, 32)}<div class=lbl>32 px</div></div></div>
   <p>5-pill master from 40 px; below that the 4-pill small master on the pixel grid (3 px pills, 1 px gaps, 1.25 px cut at 16 px) so the cut never closes. The lockup opens the cut 1.45&#215; for nav sizes.</p></div>
 <div class=cell style="background:#FAF7F2">{nav(True)}<div style="display:flex;gap:22px;align-items:flex-end">{mk(DM, lt["mark"], 64)}{mk(DM, lt["mark"], 40)}{mk(DS, lt["mark"], 32)}{mk(DS, lt["mark"], 24)}{mk(DS, lt["mark"], 16)}
   <div>{zoom(DS, lt["mark"], "#FAF7F2", 16)}<div class=lbl>16 px</div></div><div>{zoom(DS, lt["mark"], "#FAF7F2", 32)}<div class=lbl>32 px</div></div></div></div>
 <div class=cell style="background:#0f0b11;flex-direction:row;align-items:flex-end;gap:26px">{appicon(DM, 180)}{appicon(DM, 120)}{appicon(DM, 76)}{appicon(DS, 40)}</div>
 <div class=cell style="background:#0f0b11;padding:0;overflow:hidden;height:317px"><div style="width:600px;height:315px;margin:auto">{og(.5)}</div></div>
 <div class=cell style="background:#fff;padding:0;height:420px;overflow:hidden;display:grid;place-items:center"><img src="data:image/png;base64,{ov}" style="height:420px"></div>
 <div class=cell style="background:#0f0b11;padding:28px"><img src="data:image/png;base64,{hero}" style="width:100%;border-radius:10px"><p>Left: the rebuilt SVG at 50% over the supplied raster (IoU 0.97; the only differences are the raster&#8217;s own wobble, 4.5 px at most on 1254). Right: the site with this colourway.</p></div>
</div>{ZJS}</body>'''
job(html, f'{BR}/final.png', 1600, 1000, full=True)
json.dump(J, open(f'{S}/deliver.json', 'w'))
print('colourway', K, 'written; render with node render.mjs', f'{S}/deliver.json')
