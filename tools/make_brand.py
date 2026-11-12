#!/usr/bin/env python3
"""Builds the Evoked logo and the images the website needs.

    python3 tools/make_brand.py        (needs rsvg-convert for the PNG exports)
"""
import math
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
INK, MINT, PINK, PAPER, DIM = "#14112B", "#3DFFA2", "#FF4FA3", "#F4F1FF", "#6B66A0"


def neuron(x, y, r, color, seed=0.0, glow=False):
    out = ""
    if glow:
        out += f'<circle cx="{x}" cy="{y}" r="{r * 2.6:.1f}" fill="{color}" opacity=".22"/>'
    for i in range(5):
        a = seed + i * 2 * math.pi / 5 + 0.4 * math.sin(seed * 3 + i)
        out += (f'<path d="M{x + math.cos(a) * r * .8:.1f} {y + math.sin(a) * r * .8:.1f} '
                f'L{x + math.cos(a) * r * 1.9:.1f} {y + math.sin(a) * r * 1.9:.1f}" '
                f'stroke="{color}" stroke-width="{r * .24:.1f}" stroke-linecap="round"/>')
    out += f'<circle cx="{x}" cy="{y}" r="{r}" fill="{color}"/>'
    out += f'<circle cx="{x - r * .3:.1f}" cy="{y - r * .3:.1f}" r="{r * .28:.1f}" fill="#fff" opacity=".6"/>'
    return out


def logo():
    # one neuron firing, and the spike it makes
    spike = "M34 194 L98 194 L112 186 L126 126 L142 222 L156 190 L172 194 L222 194"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">'
        f'<rect width="256" height="256" rx="58" fill="{INK}"/>'
        f'{neuron(64, 92, 13, DIM, 0.4)}{neuron(196, 62, 12, DIM, 2.0)}{neuron(204, 126, 10, PINK, 1.1)}'
        f'{neuron(126, 68, 21, MINT, 0.7, glow=True)}'
        f'<path d="{spike}" fill="none" stroke="{MINT}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>'
        '</svg>\n'
    )


def og():
    cells = ""
    for i in range(34):
        d = 190 * math.sqrt((i + 0.5) / 34)
        x = 930 + d * math.cos(i * 2.399963)
        y = 315 + d * math.sin(i * 2.399963)
        lit = i in (1, 4, 9, 12, 17, 22, 26, 31)
        cells += neuron(round(x, 1), round(y, 1), 13, PINK if i in (9, 22) else MINT if lit else DIM, i, glow=lit)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">'
        f'<rect width="1200" height="630" fill="{INK}"/>{cells}'
        f'<text x="80" y="210" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="40" fill="{MINT}">Evoked</text>'
        f'<text x="80" y="320" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="76" fill="{PAPER}">See what your</text>'
        f'<text x="80" y="410" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="76" fill="{PAPER}">talk evokes.</text>'
        f'<text x="80" y="480" font-family="DejaVu Sans, sans-serif" font-size="27" fill="{PAPER}" fill-opacity=".7">Every phone in the room is a neuron.</text>'
        '</svg>\n'
    )


def png(svg_path, out, width):
    subprocess.run(["rsvg-convert", "-w", str(width), str(svg_path), "-o", str(out)], check=True)


def main():
    brand = ROOT / "brand"
    site = ROOT / "docs" / "assets"
    icons = ROOT / "extension" / "assets"
    for d in (brand, site, icons):
        d.mkdir(parents=True, exist_ok=True)
    (brand / "logo.svg").write_text(logo())
    (icons / "evoked.svg").write_text(logo())
    (site / "mark.svg").write_text(logo())
    (brand / "og.svg").write_text(og())
    png(brand / "logo.svg", brand / "logo-512.png", 512)
    png(brand / "logo.svg", brand / "logo-256.png", 256)
    png(brand / "logo.svg", site / "favicon.png", 64)
    png(brand / "logo.svg", site / "apple-touch-icon.png", 180)
    png(brand / "og.svg", site / "og.png", 1200)
    print("brand assets written")


if __name__ == "__main__":
    main()
