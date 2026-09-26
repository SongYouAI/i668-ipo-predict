#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成插件图标：深蓝底 + 琥珀金圆（金边）+ 深蓝「港」字

与姊妹插件「QDII套利增强」(jisilu-arbitrage) 的图标同款视觉：
深蓝 #0b1b34 底、琥珀金 #f5b64a 圆、深蓝中文字，保持 Analytics Blue 家族一致。
（那边用「溢」= 溢价；这边用「港」= 港股打新。）
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (11, 27, 52, 255)      # 深蓝 #0b1b34
AMBER = (245, 182, 74, 255)  # 琥珀金 #f5b64a
INK = (11, 27, 52, 255)     # 字色深蓝

CH = '港'
SIZES = [16, 48, 128]


def font_for(size):
    """找可用的中文字体"""
    candidates = [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/Library/Fonts/Arial Unicode.ttf',
        '/System/Library/Fonts/Supplemental/Songti.ttc',
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, int(size * 0.62), index=0)
            except Exception:
                continue
    return ImageFont.load_default()


def make(size):
    img = Image.new('RGBA', (size, size), BG)
    d = ImageDraw.Draw(img)
    # 金色圆底（留出深蓝外圈 = 视觉上的"金边托底"）
    pad = max(1, int(size * 0.10))
    d.ellipse([pad, pad, size - pad, size - pad], fill=AMBER)
    # 字
    f = font_for(size)
    try:
        bbox = d.textbbox((0, 0), CH, font=f)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), CH, font=f, fill=INK)
    except Exception:
        d.text((size * 0.3, size * 0.25), CH, fill=INK)
    return img


if __name__ == '__main__':
    for s in SIZES:
        make(s).save(os.path.join(OUT, f'icon-{s}.png'))
        print('generated', s)
