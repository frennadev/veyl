import json, sys, base64; sys.path.insert(0, '.'); sys.path.insert(0, '/home/claude/veyl-sol/brand/explore3/src')
from mk import *
from common import BASE, ZJS
S = '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad'
OWN = '/home/claude/veyl-sol/brand/owner'
GOLD, GOLDD, ROSE, OX, OXD, SIL, GRAPH, BONE, INK, DINK, PAPER = '#B89A6E', '#8C6B3E', '#D88595', '#7A2036', '#3A0D19', '#C9C4CE', '#4A4650', '#EFE8DC', '#EEE8EA', '#1A1418', '#07050a'
DARKICON = 'radial-gradient(120% 95% at 50% 0%, #2a1b26 0%, #140d14 48%, #07050a 100%)'
OXICON = 'radial-gradient(120% 95% at 50% 0%, #5a1729 0%, #3A0D19 60%, #2a0812 100%)'
# panel: page, surface, border, mark, word, link, cta bg, cta fg, icon bg, icon mark
OPT = {
 'A': ('His gold on near-black', 'Gold mark, ink wordmark. The supplied colour, unchanged.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark=GOLD, word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark=GOLD),
       dict(page='#FAF7F2', surf='#FFFFFF', bd='#e6dfd6', mark=GOLDD, word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon='#FFFFFF', imark=GOLDD)),
 'B': ('Gold on deep oxblood', 'Oxblood becomes the brand ground; gold sits on it.',
       dict(page=PAPER, surf=OXD, bd='#5a1a2b', mark=GOLD, word=INK, link='#d9c9cd', cta=GOLD, ctaf='#1a0d08', icon=OXICON, imark=GOLD),
       dict(page='#FAF7F2', surf='#5C1427', bd='#5C1427', mark=GOLD, word='#F3EEF0', link='#e8d6da', cta=GOLD, ctaf='#1a0d08', icon=OXICON, imark=GOLD)),
 'C': ('Dusty rose on near-black', 'The current site accent; the mark joins the signal colour.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark=ROSE, word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark=ROSE),
       dict(page='#F3EEF0', surf='#FFFFFF', bd='#e8e0e3', mark=OX, word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon='#FFFFFF', imark=OX)),
 'D': ('Satin silver on near-black', 'Platinum, matching the hardware in the hero render.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark=SIL, word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark=SIL),
       dict(page='#F3F2F4', surf='#FFFFFF', bd='#e2e0e4', mark=GRAPH, word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon='#FFFFFF', imark=GRAPH)),
 'E': ('Oxblood on bone', 'A light-first identity; on the dark site it needs a lighter tint.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark='#93294A', word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark='#93294A'),
       dict(page=BONE, surf='#F6F1E8', bd='#ddd3c4', mark=OX, word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon=BONE, imark=OX)),
 'F': ('Gold to rose, two-tone', 'A quiet gradient along the rise; the shape is still one-colour safe.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark=(GOLD, ROSE), word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark=(GOLD, ROSE)),
       dict(page='#FAF7F2', surf='#FFFFFF', bd='#e6dfd6', mark=(GOLDD, OX), word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon='#FFFFFF', imark=(GOLDD, OX))),
 'G': ('Rose, rising', 'The site theme: wine to rose along the rise of the bins, like the hero signal.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark=('#B3546C', '#F0BAC6'), word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark=('#B3546C', '#F0BAC6'), fav=ROSE),
       dict(page='#F3EEF0', surf='#FFFFFF', bd='#e8e0e3', mark=(OX, '#B3546C'), word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon='#FFFFFF', imark=(OX, '#B3546C'), fav=OX)),
 'I': ('Blush, four bins', 'One clean mark: four bins rising, one cut, in the site blush.',
       dict(page=PAPER, surf=PAPER, bd='#241c28', mark='#F2C0CB', word=INK, link='#BFB5B9', cta=OX, ctaf='#fff', icon=DARKICON, imark='#F2C0CB'),
       dict(page='#F3EEF0', surf='#FFFFFF', bd='#e8e0e3', mark=OX, word=DINK, link='#5b5157', cta=OX, ctaf='#fff', icon='#FFFFFF', imark=OX)),
}
REC = 'A'
def crv(mark, surf):
    cs = tuple(mark[1:]) if isinstance(mark, list) else mark if isinstance(mark, tuple) else (mark,)
    return min(cr(c, surf) for c in cs)
def zoom(d, fill, bg, sz, show=64):
    s = mark_svg(d, fill).replace('style="display:block;"', '')
    s = s.replace('<svg ', '<svg width="64" height="64" ', 1)
    return f'<canvas class=z data-s=\'{s}\' data-sz="{sz}" data-bg="{bg}" style="width:{show}px;height:{show}px;image-rendering:pixelated;border-radius:4px"></canvas>'
def panel(p, light):
    c = crv(p['mark'], p['surf']); ok = c >= 3.0
    lab = f'<span class=cr style="color:{"#2f7a52" if light else "#79C89E"}">{c:.1f}:1 ✓</span>' if ok else f'<span class=cr style="color:{"#b23a2a" if light else "#F08C7B"}">{c:.1f}:1 below 3:1</span>'
    nav = (f'<div class=nav style="background:{p["surf"]};border-color:{p["bd"]};color:{p["link"]}">{lockup_svg(p["mark"], p["word"], 26)}'
           f'<span style="margin-left:auto">Liquidity</span><span>Docs</span><em style="background:{p["cta"]};color:{p["ctaf"]}">Open testnet</em></div>')
    iconbd = 'box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);' if light and not p['icon'].startswith('radial') else 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);'
    icon = lambda px, d: f'<div style="width:{px}px;height:{px}px;border-radius:{px*.2237:.1f}px;background:{p["icon"]};display:grid;place-items:center;{iconbd}">{mark_svg(d, p["imark"], round(px*.64))}</div>'
    tab = (f'<div class=tab style="background:{"#e9e4e6" if light else "#1b151f"};color:{"#333" if light else "#ccc"}">{mark_svg(DS, p["mark"], 16)}<span>Veyl</span></div>')
    return (f'<div class=pan style="background:{p["page"]}">'
            f'<div class=big style="background:{p["surf"]}">{mark_svg(DM, p["mark"], 150)}</div>'
            f'<div class=col>{nav}<div class=row>{icon(84, DM)}{icon(44, DS)}{tab}{zoom(DS, p["mark"], p["surf"], 16)}{zoom(DS, p["mark"], p["surf"], 32)}{lab}</div></div></div>')
rows = ''
for k, (name, note, dk, lt) in OPT.items():
    rec = k == REC
    rows += (f'<div class="opt{" rec" if rec else ""}"><div class=lab><b>{k}</b><h3>{name}</h3><p>{note}</p>'
             + (f'<span class=badge>Recommended</span>' if rec else '') + f'</div>{panel(dk, False)}{panel(lt, True)}</div>')
hero = base64.b64encode(open(f'{S}/hero-rec.png', 'rb').read()).decode()
small = ''.join(f'<div class=sm>{zoom(d, GOLD, PAPER, sz, 96)}<span>{lbl} · {sz}px</span></div>' for d, lbl in ((DM, '5 pills'), (DS, '4 pills')) for sz in (16, 24, 32))
CAP = ('<b>Recommendation: A, his gold (#B89A6E) on the near-black ground.</b> It is the colour he chose, it clears 7.6:1 on the site ground, '
       'and a muted warm gold is the classic partner for oxblood, so the mark reads as the signature while the site keeps its own roles: '
       'oxblood for buttons, dusty rose for the proof signal and highlights, satin silver for hardware. It also echoes the warm stone of the hero render. '
       'Minimal palette tweak only: a <code>--gold</code> token for the brand mark; the primary button stays oxblood '
       '(a gold button was tried and competes with the rose links and signals). On light grounds the mark steps down to a deeper gold #8C6B3E (4.4 to 4.9:1), '
       'because #B89A6E on white is only 2.7:1. C is the safe harmonic choice but merges the mark with the signals; D is clean but cold; '
       'B and E change the site ground; F adds a gradient for little gain.')
html = BASE + f'''<body style="width:1760px;background:#141016;font-family:M;color:#9A8F94;padding:56px">
<style>h1{{font:500 34px M;color:#EEE8EA;margin:0 0 6px;letter-spacing:-.02em}}h3{{font:500 19px M;color:#EEE8EA;margin:6px 0}}p{{margin:0;font-size:14.5px;line-height:1.5}}
.opt{{display:grid;grid-template-columns:200px 1fr 1fr;gap:2px;margin-top:2px}}.opt.rec .lab{{box-shadow:inset 3px 0 0 #B89A6E}}
.lab{{background:#0f0b11;padding:24px 22px}}.lab b{{font:600 28px M;color:#B89A6E}}.badge{{display:inline-block;margin-top:12px;background:#B89A6E;color:#140d0a;font:600 12px M;padding:5px 10px;border-radius:99px}}
.pan{{display:flex;gap:22px;padding:22px;align-items:center}}.big{{width:190px;height:190px;border-radius:14px;display:grid;place-items:center;flex:none}}
.col{{display:flex;flex-direction:column;gap:18px;flex:1;min-width:0}}.row{{display:flex;gap:14px;align-items:center}}
.nav{{height:60px;display:flex;align-items:center;gap:22px;padding:0 18px;border:1px solid;font:500 14px M;border-radius:12px}}
.nav em{{font-style:normal;padding:9px 14px;border-radius:7px;white-space:nowrap}}
.tab{{display:flex;gap:7px;align-items:center;padding:7px 12px;border-radius:8px 8px 0 0;font:500 13px M}}.cr{{font:600 13px M;margin-left:auto;white-space:nowrap}}
.sm{{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:13px}}code{{color:#EEE8EA}}
.cap{{background:#0f0b11;border-left:3px solid #B89A6E;padding:22px 26px;margin:34px 0 0;color:#BFB5B9;font-size:16px;line-height:1.6}}.cap b{{color:#EEE8EA}}</style>
<h1>veyl: colourways for the owner's mark</h1>
<p style="font-size:16px">Each option on the dark site ground (left) and on light (right): mark, nav bar with the lowercase wordmark, app icon, favicon in a tab and at 16 / 32 px (pixel zoom). Contrast is the mark against its ground; 3:1 is the floor for graphics.</p>
<div style="display:flex;gap:28px;align-items:flex-end;margin:28px 0 30px;background:#0f0b11;padding:20px 24px;border-radius:12px">{small}
<p style="max-width:380px;margin-left:12px;color:#BFB5B9">Small sizes: the 5-pill master loses its cut and gaps below 32 px. Picked: a 4-pill version drawn on the pixel grid (3 px pills, 1 px gaps, 1.25 px cut at 16 px) for the favicon and anything at 32 px or less; the full 5-pill mark from 40 px up.</p></div>
{rows}
<div class=cap>{CAP}</div>
<h3 style="margin:34px 0 14px">Recommended option A on the live site (index, hero and nav)</h3>
<img src="data:image/png;base64,{hero}" style="width:100%;display:block;border-radius:12px">
{ZJS}</body>'''
json.dump([{'html': html, 'out': f'{OWN}/colourways.png', 'w': 1760, 'h': 1200, 'full': True}], open(f'{S}/cw.json', 'w'))
