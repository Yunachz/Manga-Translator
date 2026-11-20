"""Synthetic fixtures for the v0.4.9 outside-balloon regressions. Original drawings, DejaVu Sans fonts (free license).
usage (repo root): python3 tests/fixtures/make-v049-fixtures.py
Writes tests/fixtures/outlined-captions.png, tests/fixtures/joined-balloons.png and tests/fixtures/v049-fixtures.json.

outlined-captions.png (1266 x 550): three multi-line captions, no balloons. Glyphs have black interiors with a thick white
outline, printed across synthetic artwork: a dark area with light hatching, a halftone area on mid-gray and a
diagonal edge between them. A white-outlined black star and a hatched pillar are artwork controls that must stay.

joined-balloons.png (1800 x 1300): two speech balloons drawn into each other. The large left balloon holds a five-line
column; the smaller right balloon is cut off by the panel frame at the top right and holds a three-line column whose
x range overlaps the widest left line. Panel frame is black on a dark textured page.
"""
import json
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

here = Path(__file__).parent
bold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf'
plain = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
rng = np.random.default_rng(49)


def artwork(width, height):
    yy, xx = np.mgrid[0:height, 0:width]
    base = np.full((height, width), 18.0)
    # Halftone dots on mid gray above a diagonal edge.
    above = yy < 0.62 * height - 0.25 * xx
    dots = ((xx % 6 - 3) ** 2 + (yy % 6 - 3) ** 2) < 5
    base[above] = np.where(dots[above], 70, 150)
    # Light hatching in the dark area.
    hatch = (~above) & ((xx + 2 * yy) % 23 < 2)
    base[hatch] = 120
    # Wood-grain rings on the right of the halftone area.
    rings = above & (xx > width * 0.55) & ((np.hypot(xx - width * 0.8, yy - height * 0.1) // 9) % 3 == 0)
    base[rings] = 205
    base += rng.normal(0, 6, base.shape)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert('RGB')


def outlined(draw, center_x, top, lines, size, step):
    font = ImageFont.truetype(bold, size)
    boxes = []
    for index, text in enumerate(lines):
        width = draw.textlength(text, font=font)
        x, y = center_x - width / 2, top + index * step
        draw.text((x, y), text, font=font, fill=(10, 10, 10), stroke_width=max(5, size // 6), stroke_fill=(250, 250, 250))
        boxes.append([round(x), round(y), round(width), size])
    return boxes


def captions():
    im = artwork(1266, 550)
    d = ImageDraw.Draw(im)
    # Artwork controls: a white-outlined black star and a hatched pillar.
    star = [(170 + 40 * math.cos(a) * (1 if i % 2 == 0 else 0.45), 470 + 40 * math.sin(a) * (1 if i % 2 == 0 else 0.45))
            for i, a in enumerate(np.linspace(-math.pi / 2, 1.5 * math.pi, 11)[:-1])]
    d.polygon(star, fill=(10, 10, 10), outline=(250, 250, 250), width=6)
    d.rectangle((1150, 300, 1230, 540), fill=(30, 30, 30))
    for y in range(300, 540, 9):
        d.line((1150, y, 1230, y + 20), fill=(200, 200, 200), width=2)
    groups = {
        'top-right': (1000, 70, ['FROM WHAT', 'I CAN TELL...']),
        'left': (230, 165, ['...OF AN', 'ANCIENT', 'CIVILIZATION,', 'NO LONGER', 'IN USE...!']),
        'center': (790, 210, ['THERE IS NO', 'QUESTION THAT', 'THESE ARE', 'RELICS...']),
    }
    meta = {'size': [1266, 550], 'groups': {}, 'controls': {'star': [125, 425, 90, 90], 'pillar': [1146, 296, 88, 248]}}
    for name, (cx, top, lines) in groups.items():
        meta['groups'][name] = {'text': ' '.join(lines), 'lines': lines, 'boxes': outlined(d, cx, top, lines, 40, 46)}
    im.save(here / 'outlined-captions.png', optimize=True)
    return meta


def joined():
    w, h = 1800, 1300
    page = artwork(w, h)
    d = ImageDraw.Draw(page)
    frame = (40, 30, w - 40, h - 30)
    left = (700, 140, 1300, 1120)
    right = (1080, 0, w, 560)
    # Outlines first, then both interiors, so the balloons share one open interior where they overlap.
    d.ellipse(left, fill=(0, 0, 0))
    d.rounded_rectangle(right, radius=90, fill=(0, 0, 0))
    d.ellipse((left[0] + 8, left[1] + 8, left[2] - 8, left[3] - 8), fill=(252, 252, 252))
    d.rounded_rectangle((right[0] + 8, right[1] + 8, right[2] - 8, right[3] - 8), radius=82, fill=(252, 252, 252))
    # Tail of the left balloon.
    d.polygon([(760, 820), (650, 860), (740, 870)], fill=(252, 252, 252), outline=(0, 0, 0))
    # Black panel frame clips the right balloon at the top right.
    d.rectangle((0, 0, w, frame[1]), fill=(0, 0, 0))
    d.rectangle((frame[2], 0, w, h), fill=(0, 0, 0))
    d.rectangle((0, frame[3], w, h), fill=(0, 0, 0))
    d.rectangle((0, 0, frame[0], h), fill=(0, 0, 0))
    d.rectangle(frame, outline=(0, 0, 0), width=10)
    font = ImageFont.truetype(plain, 84)
    def column(cx, top, lines, step):
        boxes = []
        for index, text in enumerate(lines):
            tw = d.textlength(text, font=font)
            x, y = cx - tw / 2, top + index * step
            d.text((x, y), text, font=font, fill=(15, 15, 15))
            boxes.append([round(x), round(y), round(tw), 84])
        return boxes
    meta = {'size': [w, h], 'groups': {
        'left': {'lines': ['WHY', 'WERE YOU', 'TALKING', 'TO EMPTY', 'SPACE?!'], 'boxes': column(1000, 300, ['WHY', 'WERE YOU', 'TALKING', 'TO EMPTY', 'SPACE?!'], 105)},
        'right': {'lines': ['EXPLAIN', 'YOUR-', 'SELF!'], 'boxes': column(1427, 150, ['EXPLAIN', 'YOUR-', 'SELF!'], 100)},
    }}
    for group in meta['groups'].values():
        group['text'] = ' '.join(group['lines'])
    page.save(here / 'joined-balloons.png', optimize=True)
    return meta


meta = {'outlined-captions.png': captions(), 'joined-balloons.png': joined()}
(here / 'v049-fixtures.json').write_text(json.dumps(meta, indent=1) + '\n')
print(json.dumps({k: {g: v['text'] for g, v in m['groups'].items()} for k, m in meta.items()}, indent=1))
