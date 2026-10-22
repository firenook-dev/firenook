"""Generate every Firenook brand asset into the folder above this one.

    cd brand/source && python build_brand.py

Needs: fonttools, uharfbuzz, skia-pathops, numpy, scipy, shapely, pillow
(requirements.txt), plus rsvg-convert and ImageMagick
(`brew install librsvg imagemagick`).

The mark comes from the approved Tailored Glass artwork (source-tailored.svg),
polished by stage1.py/stage2.py. The wordmark is Figtree Bold (SIL OFL 1.1,
fonts/) converted to outlines, so no file needs the font installed.
"""
from pathlib import Path
import copy
import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as E

SRC = Path(__file__).resolve().parent
OUT = SRC.parent
os.chdir(SRC)  # stage1 reads source-tailored.svg from the working directory

import numpy as np
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps
from fontTools.varLib import instancer

from geom import parse_cubics, sample
from smallmark import eroded, to_d
from stage2 import build_mark
from wordmark import layout

NS = 'http://www.w3.org/2000/svg'
E.register_namespace('', NS)

# Brand palette. Vermilion/amber are the flat flame colours; charcoal is the ink.
VERMILION = '#F23818'
AMBER = '#FF9800'
CHARCOAL = '#202124'
WHITE = '#FFFFFF'
NIGHT = '#141416'      # social-image background, a shade under charcoal
MUTED_ON_DARK = '#A8A29E'

# The social card. Figures are from benchmarks/020-paired-acceptance.json.
HEADLINE = ('A faster drop-in replacement for', 'the Firebase Local Emulator Suite')
STATS = (('40×', 'faster writes'), ('10×', 'less memory'))
POINTS = ('No Java', 'Data survives restarts', 'Same firebase.json, SDKs and ports')
LABEL_ON_DARK = '#D6D3D1'
TRACKING = -0.025      # em, wordmark
THEME = CHARCOAL       # browser theme colour and app-icon background
SMALL_INSET = 9        # units each flame is inset by in the tab-size favicon

TMP = Path(tempfile.mkdtemp(prefix='firenook-brand-'))


def el(tag, **attrs):
    return E.Element('{' + NS + '}' + tag, {k.replace('_', '-'): str(v) for k, v in attrs.items()})


def n(v):
    return ('%.2f' % v).rstrip('0').rstrip('.')


def figtree(weight):
    font = instancer.instantiateVariableFont(TTFont(SRC / 'fonts/Figtree[wght].ttf'), {'wght': weight})
    removeOverlaps(font)
    path = TMP / f'Figtree-{weight}.ttf'
    font.save(path)
    return str(path)


# --------------------------------------------------------------------------- parts

def mark_parts():
    svg = build_mark(str(SRC / 'source-tailored.svg')).getroot()
    defs = svg.find('{*}defs')
    groups = [svg.find("{*}g[@id='red-liquid-ribbon']"), svg.find("{*}g[@id='amber-liquid-ribbon']")]
    used = set(re.findall(r'url\(#([^)]+)\)', ''.join(E.tostring(g).decode() for g in groups)))
    for d in list(defs):
        if d.get('id') not in used:
            defs.remove(d)
    ribbons = [defs.find(f"{{*}}clipPath[@id='ribbon{i}']/{{*}}path").get('d') for i in (0, 1)]
    pts = np.vstack([sample(parse_cubics(d, None), 0.25)[0] for d in ribbons])
    box = (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max())
    return defs, groups, ribbons, box


DEFS, GLASS, RIBBONS, MB = mark_parts()
BOLD = figtree(700)
MEDIUM = figtree(500)
WORD, WB, _ = layout(BOLD, 'firenook', 708, 643, 383, tracking_em=TRACKING)
MARGIN = MB[0]                       # the approved lockup's clear space (~137 units)
MW, MH = MB[2] - MB[0], MB[3] - MB[1]
WW, WH = WB[2] - WB[0], WB[3] - WB[1]


def mark_group(style, ink=None, transform=None, ribbons=None):
    """style: glass | flat | mono (mono uses `ink`); `ribbons` overrides the outlines for flat/mono."""
    g = el('g', id='firenook-mark')
    if transform:
        g.set('transform', transform)
    if style == 'glass':
        for part in GLASS:
            g.append(copy.deepcopy(part))
    else:
        fills = (VERMILION, AMBER) if style == 'flat' else (ink, ink)
        for d, fill in zip(ribbons or RIBBONS, fills):
            g.append(el('path', d=d, fill=fill))
    return g


def word_group(ink, transform=None):
    g = el('g', id='firenook-wordmark', fill=ink)
    if transform:
        g.set('transform', transform)
    for d in WORD:
        g.append(el('path', d=d))
    return g


def document(width, height, view_box, desc, children, glass):
    root = el('svg', width=n(width), height=n(height), viewBox=view_box, role='img', aria_labelledby='title')
    title = el('title', id='title')
    title.text = 'Firenook'
    root.append(title)
    d = el('desc')
    d.text = desc
    root.append(d)
    if glass:
        root.append(copy.deepcopy(DEFS))
    for c in children:
        root.append(c)
    return root


def write(root, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = E.tostring(root, encoding='utf-8', xml_declaration=True)
    assert not any(e.tag.split('}')[-1] in ('image', 'feImage', 'text', 'filter', 'style') for e in root.iter())
    path.write_bytes(data)
    return path


def png(svg_path, out, width=None, height=None, background=None):
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ['rsvg-convert', str(svg_path), '-o', str(out)]
    if width:
        cmd += ['-w', str(width)]
    if height:
        cmd += ['-h', str(height)]
    if background:
        cmd += ['-b', background]
    subprocess.run(cmd, check=True)
    return out


# --------------------------------------------------------------------------- layouts

VARIANTS = {
    # name suffix: (mark style, mono ink, wordmark ink, description)
    '': ('glass', None, CHARCOAL, 'full-colour glass mark, for light backgrounds'),
    '-on-dark': ('glass', None, WHITE, 'full-colour glass mark, for dark backgrounds'),
    '-flat': ('flat', None, CHARCOAL, 'flat two-colour mark, for light backgrounds, UI, docs and print'),
    '-flat-on-dark': ('flat', None, WHITE, 'flat two-colour mark, for dark backgrounds'),
    '-mono-charcoal': ('mono', CHARCOAL, CHARCOAL, 'one colour (charcoal), for single-colour use on light backgrounds'),
    '-mono-white': ('mono', WHITE, WHITE, 'one colour (white), for single-colour use on dark backgrounds'),
}


def horizontal(style, ink, word_ink, desc):
    w, h = WB[2] + MARGIN, 900
    return document(w, h, f'0 0 {n(w)} {n(h)}', f'Firenook logo, horizontal: {desc}.',
                    [mark_group(style, ink), word_group(word_ink)], style == 'glass')


STACK_SCALE = 1.3          # mark size relative to the horizontal lockup
STACK_GAP = 0.5 * WH       # space between mark and wordmark


def stacked(style, ink, word_ink, desc):
    w = WW + 2 * MARGIN
    mh = MH * STACK_SCALE
    h = MARGIN + mh + STACK_GAP + WH + MARGIN
    mx = w / 2 - (MB[0] + MW / 2) * STACK_SCALE
    my = MARGIN - MB[1] * STACK_SCALE
    mark = mark_group(style, ink, f'translate({n(mx)} {n(my)}) scale({STACK_SCALE})')
    word = word_group(word_ink, f'translate({n(MARGIN - WB[0])} {n(MARGIN + mh + STACK_GAP - WB[1])})')
    return document(w, h, f'0 0 {n(w)} {n(h)}', f'Firenook logo, stacked: {desc}.', [mark, word], style == 'glass')


def mark_only(style, ink, desc, pad=1.25, ribbons=None):
    side = max(MW, MH) * pad
    x0, y0 = MB[0] + MW / 2 - side / 2, MB[1] + MH / 2 - side / 2
    return document(side, side, f'{n(x0)} {n(y0)} {n(side)} {n(side)}', f'Firenook mark: {desc}.',
                    [mark_group(style, ink, ribbons=ribbons)], style == 'glass')


def wordmark_only(ink, desc):
    x0, y0 = WB[0] - MARGIN, WB[1] - MARGIN
    w, h = WW + 2 * MARGIN, WH + 2 * MARGIN
    return document(w, h, f'{n(x0)} {n(y0)} {n(w)} {n(h)}', f'Firenook wordmark: {desc}.', [word_group(ink)], False)


def icon(style, size, background, mark_height, ink=None):
    """Square icon with a solid background; the mark is centred at mark_height × size."""
    k = mark_height * size / MH
    tx = size / 2 - (MB[0] + MW / 2) * k
    ty = size / 2 - (MB[1] + MH / 2) * k
    children = [el('rect', width=size, height=size, fill=background),
                mark_group(style, ink, f'translate({n(tx)} {n(ty)}) scale({k:.6f})')]
    return document(size, size, f'0 0 {size} {size}', 'Firenook app icon.', children, style == 'glass')


def text(font, words, x, baseline, cap, fill, tracking=0.0):
    """Outlined text, its left ink edge at x and its capital H `cap` px tall; returns (group, width)."""
    paths, box, _ = layout(font, words, 0, 0, 1000, ref_text='H', tracking_em=tracking)
    k = cap / 1000
    g = el('g', fill=fill, transform=f'translate({n(x)} {n(baseline)}) scale({k:.6f})')
    for d in paths:
        if d:
            g.append(el('path', d=d))
    return g, box[2] * k


def social(width, height):
    """Dark card: the lockup, the drop-in headline, the two measured figures and what stays the same."""
    u = height / 640                     # sizes are drawn for 640 px tall
    pad = 88 * u
    mark_h = 64 * u
    k = mark_h / MH
    lx, ly = pad - MB[0] * k, 70 * u - MB[1] * k
    flame = el('linearGradient', id='flame', x1=0, y1=0, x2=0, y2=1)
    for off, color in ((0, AMBER), (1, VERMILION)):
        flame.append(el('stop', offset=off, stop_color=color))
    defs = copy.deepcopy(DEFS)
    defs.append(flame)
    glows = []
    for i, (cx, cy, rx, ry, op) in enumerate(((lx + (MB[0] + MW / 2) * k, ly + (MB[1] + MH / 2) * k, 0.55, 0.75, 0.24),
                                               (width * 0.92, height * 1.05, 0.45, 0.55, 0.10))):
        glow = el('radialGradient', id=f'glow{i}', gradientUnits='userSpaceOnUse', cx=0, cy=0, r=1,
                  gradientTransform=f'translate({n(cx)} {n(cy)}) scale({n(width * rx)} {n(height * ry)})')
        for off, color, o in ((0, VERMILION, op), (0.45, '#FF6A1A', op / 3), (1, VERMILION, 0)):
            glow.append(el('stop', offset=off, stop_color=color, stop_opacity=o))
        defs.append(glow)
        glows.append(el('rect', width=width, height=height, fill=f'url(#glow{i})'))
    lock = el('g', transform=f'translate({n(lx)} {n(ly)}) scale({k:.6f})')
    lock.append(mark_group('glass'))
    lock.append(word_group(WHITE))

    parts, widths = [], []
    for i, line in enumerate(HEADLINE):
        g, w = text(BOLD, line, pad, (250 + 76 * i) * u, 48 * u, WHITE, tracking=-0.012)
        parts.append(g)
        widths.append(w)
    x = pad
    for number, label in STATS:
        g, w = text(BOLD, number, x, 462 * u, 66 * u, 'url(#flame)', tracking=-0.01)
        lg, lw = text(MEDIUM, label, x + w + 18 * u, 462 * u, 25 * u, LABEL_ON_DARK)
        parts += [g, lg]
        x += w + 18 * u + lw + 64 * u
    widths.append(x - 64 * u - pad)
    x = pad
    for i, point in enumerate(POINTS):
        if i:
            dot = el('circle', cx=n(x + 16 * u), cy=n(547 * u), r=n(3.5 * u), fill=AMBER)
            parts.append(dot)
            x += 32 * u
        g, w = text(MEDIUM, point, x, 556 * u, 21 * u, MUTED_ON_DARK)
        parts.append(g)
        x += w
    widths.append(x - pad)
    assert max(widths) <= width - 2 * pad, (width, [round(w) for w in widths])

    root = el('svg', width=width, height=height, viewBox=f'0 0 {width} {height}', role='img', aria_labelledby='title')
    title = el('title', id='title')
    title.text = 'Firenook: ' + ' '.join(HEADLINE)
    root.append(title)
    root.append(defs)
    root.append(el('rect', width=width, height=height, fill=NIGHT))
    for g in glows:
        root.append(g)
    root.append(lock)
    for g in parts:
        root.append(g)
    return root


# --------------------------------------------------------------------------- build

def main():
    for sub in ('logo', 'mark', 'wordmark', 'favicon', 'social'):
        shutil.rmtree(OUT / sub, ignore_errors=True)

    # Logos: horizontal + stacked, six colour treatments each.
    for suffix, (style, ink, word_ink, desc) in VARIANTS.items():
        p = write(horizontal(style, ink, word_ink, desc), OUT / f'logo/firenook-logo{suffix}.svg')
        png(p, OUT / f'logo/png/firenook-logo{suffix}.png', width=2400)
        p = write(stacked(style, ink, word_ink, desc), OUT / f'logo/firenook-logo-stacked{suffix}.svg')
        png(p, OUT / f'logo/png/firenook-logo-stacked{suffix}.png', width=1600)

    # Mark and wordmark on their own.
    marks = {
        '': ('glass', None, 'full-colour glass'),
        '-flat': ('flat', None, 'flat two-colour'),
        '-mono-charcoal': ('mono', CHARCOAL, 'one colour (charcoal)'),
        '-mono-white': ('mono', WHITE, 'one colour (white)'),
    }
    for suffix, (style, ink, desc) in marks.items():
        p = write(mark_only(style, ink, desc), OUT / f'mark/firenook-mark{suffix}.svg')
        png(p, OUT / f'mark/png/firenook-mark{suffix}.png', width=1024)
    for suffix, ink, desc in (('', CHARCOAL, 'charcoal'), ('-white', WHITE, 'white')):
        p = write(wordmark_only(ink, desc), OUT / f'wordmark/firenook-wordmark{suffix}.svg')
        png(p, OUT / f'wordmark/png/firenook-wordmark{suffix}.png', width=2000)

    # Favicons: the flat mark reads at tab size where glass detail turns to mush. For 16-32 px each
    # flame is inset by 9 units (~1.4%) so the gap between them doesn't close; 48 px uses the true outline.
    fav = OUT / 'favicon'
    small = [to_d(eroded(d, SMALL_INSET)) for d in RIBBONS]
    write(mark_only('flat', None, 'favicon, optically adjusted for small sizes', pad=1.04, ribbons=small),
          fav / 'favicon.svg')
    full = write(mark_only('flat', None, 'favicon', pad=1.04), TMP / 'favicon-48.svg')
    sizes = {}
    for s in (16, 32, 48):
        sizes[s] = png(fav / 'favicon.svg' if s < 48 else full, TMP / f'fav-{s}.png', width=s, height=s)
    shutil.copy(sizes[16], fav / 'favicon-16x16.png')
    shutil.copy(sizes[32], fav / 'favicon-32x32.png')
    subprocess.run(['magick', *(str(sizes[s]) for s in (16, 32, 48)), str(fav / 'favicon.ico')], check=True)

    # App icons: full-bleed charcoal square, glass mark. iOS/Android round the corners themselves.
    for name, size, height in (('apple-touch-icon.png', 180, 0.66), ('icon-192.png', 192, 0.66),
                               ('icon-512.png', 512, 0.66), ('icon-maskable-512.png', 512, 0.56)):
        p = write(icon('glass', size, THEME, height), TMP / (name + '.svg'))
        png(p, fav / name, width=size, height=size)
    (fav / 'site.webmanifest').write_text(json.dumps({
        'name': 'Firenook',
        'short_name': 'Firenook',
        'icons': [
            {'src': '/icon-192.png', 'type': 'image/png', 'sizes': '192x192'},
            {'src': '/icon-512.png', 'type': 'image/png', 'sizes': '512x512'},
            {'src': '/icon-maskable-512.png', 'type': 'image/png', 'sizes': '512x512', 'purpose': 'maskable'},
        ],
        'theme_color': THEME,
        'background_color': THEME,
        'display': 'standalone',
    }, indent=2) + '\n')
    (fav / 'head.html').write_text(
        '<!-- Copy the files in this folder to the site root, then add these tags to <head>. -->\n'
        '<link rel="icon" href="/favicon.ico" sizes="32x32">\n'
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n'
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n'
        '<link rel="manifest" href="/site.webmanifest">\n'
        f'<meta name="theme-color" content="{THEME}">\n')

    # Social: avatars, link previews, GitHub repository preview.
    soc = OUT / 'social'
    for name, bg in (('avatar-dark-1024.png', THEME), ('avatar-light-1024.png', WHITE)):
        p = write(icon('glass', 1024, bg, 0.62), TMP / (name + '.svg'))
        png(p, soc / name, width=1024, height=1024)
    for name, (w, h) in (('og-image-1200x630.png', (1200, 630)),
                         ('github-social-preview-1280x640.png', (1280, 640))):
        p = write(social(w, h), TMP / (name + '.svg'))
        png(p, soc / name, width=w, height=h)

    overview()
    shutil.rmtree(TMP, ignore_errors=True)
    print('mark box', [round(float(v), 1) for v in MB], 'wordmark box', [round(float(v), 1) for v in WB])


# --------------------------------------------------------------------------- overview sheet

def overview():
    from PIL import Image, ImageDraw, ImageFont
    W, PAD, GAP = 1600, 56, 24
    BG, PANEL_LIGHT, LABEL = (244, 244, 245), (255, 255, 255), (82, 82, 91)
    dark = tuple(int(CHARCOAL[i:i + 2], 16) for i in (1, 3, 5))

    def font(size, weight):
        f = ImageFont.truetype(str(SRC / 'fonts/Figtree[wght].ttf'), size)
        f.set_variation_by_axes([weight])
        return f

    rows = []

    def tile(path, w, h, bg, fill=0.78):
        t = Image.new('RGB', (w, h), bg)
        im = Image.open(path).convert('RGBA')
        k = min(w * fill / im.width, h * fill / im.height)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
        t.paste(im, ((w - im.width) // 2, (h - im.height) // 2), im)
        return t

    def section(label, tiles):
        rows.append(('label', label))
        rows.append(('tiles', tiles))

    half = (W - 2 * PAD - GAP) // 2
    quarter = (W - 2 * PAD - 3 * GAP) // 4
    L = OUT / 'logo/png'
    section('Logo  ·  glass, flat and one-colour, for light and dark backgrounds', [
        [tile(L / 'firenook-logo.png', half, 230, PANEL_LIGHT), tile(L / 'firenook-logo-on-dark.png', half, 230, dark)],
        [tile(L / 'firenook-logo-flat.png', half, 230, PANEL_LIGHT), tile(L / 'firenook-logo-flat-on-dark.png', half, 230, dark)],
        [tile(L / 'firenook-logo-mono-charcoal.png', half, 230, PANEL_LIGHT), tile(L / 'firenook-logo-mono-white.png', half, 230, dark)],
    ])
    section('Stacked logo', [[tile(L / 'firenook-logo-stacked.png', quarter, 300, PANEL_LIGHT),
                              tile(L / 'firenook-logo-stacked-on-dark.png', quarter, 300, dark),
                              tile(L / 'firenook-logo-stacked-flat.png', quarter, 300, PANEL_LIGHT),
                              tile(L / 'firenook-logo-stacked-mono-white.png', quarter, 300, dark)]])
    M = OUT / 'mark/png'
    section('Mark', [[tile(M / 'firenook-mark.png', quarter, 260, PANEL_LIGHT),
                      tile(M / 'firenook-mark-flat.png', quarter, 260, PANEL_LIGHT),
                      tile(M / 'firenook-mark-mono-charcoal.png', quarter, 260, PANEL_LIGHT),
                      tile(M / 'firenook-mark-mono-white.png', quarter, 260, dark)]])
    # favicons at true pixel size, next to app icons
    F = OUT / 'favicon'
    fav = Image.new('RGB', (half, 260), PANEL_LIGHT)
    x = 60
    for name in ('favicon-16x16.png', 'favicon-32x32.png'):
        im = Image.open(F / name).convert('RGBA')
        fav.paste(im, (x, 130 - im.height // 2), im)
        big = im.resize((im.width * (96 // im.width), im.height * (96 // im.height)), Image.NEAREST)
        fav.paste(big, (x + 50, 130 - big.height // 2), big)
        x += 220
    apps = Image.new('RGB', (half, 260), PANEL_LIGHT)
    for i, name in enumerate(('apple-touch-icon.png', 'icon-maskable-512.png')):
        im = Image.open(F / name).convert('RGBA').resize((180, 180), Image.LANCZOS)
        mask = Image.new('L', (180, 180), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 179, 179), 40, fill=255)
        apps.paste(im, (110 + i * 260, 40), mask)
    section('Favicons (16 and 32 px, shown actual size and enlarged)  ·  app icons', [[fav, apps]])
    S = OUT / 'social'
    og = tile(S / 'og-image-1200x630.png', half, round(half * 630 / 1200), PANEL_LIGHT, fill=1.0)
    av = Image.new('RGB', (half, og.height), PANEL_LIGHT)
    for i, name in enumerate(('avatar-dark-1024.png', 'avatar-light-1024.png')):
        im = Image.open(S / name).convert('RGBA').resize((220, 220), Image.LANCZOS)
        mask = Image.new('L', (220, 220), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, 219, 219), fill=255)
        av.paste(im, (half // 2 - 250 + i * 280, (og.height - 220) // 2), mask)
    section('Social  ·  link preview and avatars', [[og, av]])

    title_font, label_font = font(40, 650), font(19, 550)
    height = PAD + 60
    for kind, item in rows:
        height += 44 if kind == 'label' else sum(r[0].height + GAP for r in item)
    height += PAD - GAP
    sheet = Image.new('RGB', (W, height), BG)
    d = ImageDraw.Draw(sheet)
    d.text((PAD, PAD - 6), 'Firenook brand assets', font=title_font, fill=dark)
    y = PAD + 60
    for kind, item in rows:
        if kind == 'label':
            d.text((PAD, y + 10), item, font=label_font, fill=LABEL)
            y += 44
            continue
        for r in item:
            x = PAD
            for t in r:
                sheet.paste(t, (x, y))
                x += t.width + GAP
            y += r[0].height + GAP
    sheet.save(OUT / 'overview.png', optimize=True)


if __name__ == '__main__':
    main()
