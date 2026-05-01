#!/usr/bin/env python3
"""Generate app icons for My Raver Life PWA. Run once."""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

# App accent gradient (pink → cyan) with dark bg
PINK = (255, 46, 138)     # var(--accent)
CYAN = (0, 212, 255)      # var(--accent-2)
DARK = (14, 16, 24)        # var(--bg)


def find_bold_font():
    candidates = [
        '/System/Library/Fonts/SFNSRounded.ttf',
        '/System/Library/Fonts/Supplemental/SF-Pro-Rounded-Bold.otf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial Black.ttf',
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def make_icon(size, output_path):
    # Square base with dark background
    img = Image.new('RGBA', (size, size), DARK)
    draw = ImageDraw.Draw(img)

    # Gradient circle in center: pink (top-left) to cyan (bottom-right)
    pad = int(size * 0.10)
    radius = size - 2 * pad
    grad = Image.new('RGB', (radius, radius), PINK)
    gd = grad.load()
    for y in range(radius):
        for x in range(radius):
            t = (x + y) / (2 * radius)  # diagonal gradient 0..1
            r = int(PINK[0] * (1 - t) + CYAN[0] * t)
            g = int(PINK[1] * (1 - t) + CYAN[1] * t)
            b = int(PINK[2] * (1 - t) + CYAN[2] * t)
            gd[x, y] = (r, g, b)

    # Circular mask
    mask = Image.new('L', (radius, radius), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, radius, radius), fill=255)
    img.paste(grad, (pad, pad), mask)

    # Centered white "M" (mark for "My Raver Life")
    font_path = find_bold_font()
    font_size = int(size * 0.48)
    if font_path:
        font = ImageFont.truetype(font_path, font_size)
    else:
        font = ImageFont.load_default()

    text = "M"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] - int(size * 0.02)
    draw.text((tx, ty), text, fill=(255, 255, 255, 240), font=font)

    img.save(output_path, 'PNG')
    print(f"  → {output_path}  ({size}×{size})")


if __name__ == '__main__':
    print("Generating icons…")
    make_icon(192, os.path.join(HERE, 'icon-192.png'))
    make_icon(512, os.path.join(HERE, 'icon-512.png'))
    make_icon(180, os.path.join(HERE, 'apple-touch-icon.png'))
    print("Done.")
