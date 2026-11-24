"""그림판 PWA 아이콘 생성 (icon-192.png, icon-512.png, icon-512-maskable.png)."""

from PIL import Image, ImageDraw, ImageFilter

SS = 4  # 슈퍼샘플링 배율


def gradient(size, c1=(37, 99, 235), c2=(124, 58, 237)):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x / size * 0.55 + y / size * 0.45)
            px[x, y] = (
                int(c1[0] + (c2[0] - c1[0]) * t),
                int(c1[1] + (c2[1] - c1[1]) * t),
                int(c1[2] + (c2[2] - c1[2]) * t),
            )
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def palette_art(size, scale=1.0):
    """흰 팔레트 + 색 점들 (RGBA 레이어)."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = size * 0.5, size * 0.5
    pr = size * 0.30 * scale

    # 팔레트 본체 (살짝 기울인 느낌의 원)
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=(255, 255, 255, 255))

    # 손가락 구멍 (오른쪽 아래)
    hx, hy = cx + pr * 0.45, cy + pr * 0.45
    hr = pr * 0.33
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=(0, 0, 0, 0))

    # 색 점
    dots = [
        (185, (239, 68, 68)),
        (222, (245, 158, 11)),
        (259, (34, 197, 94)),
        (296, (6, 182, 212)),
        (333, (236, 72, 153)),
    ]
    import math
    for deg, color in dots:
        a = math.radians(deg)
        dx = cx + math.cos(a) * pr * 0.60
        dy = cy + math.sin(a) * pr * 0.60
        r = pr * 0.17
        d.ellipse([dx - r, dy - r, dx + r, dy + r], fill=color + (255,))

    return layer


def make_icon(px, maskable=False):
    size = px * SS
    bg = gradient(size)
    if maskable:
        canvas = bg.convert("RGBA")
        art = palette_art(size, scale=0.80)
        canvas.alpha_composite(art)
    else:
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(bg, (0, 0), rounded_mask(size, int(size * 0.22)))
        art = palette_art(size, scale=0.95)
        shadow = art.filter(ImageFilter.GaussianBlur(size * 0.012))
        canvas.alpha_composite(shadow, (0, int(size * 0.008)))
        canvas.alpha_composite(art)

    return canvas.resize((px, px), Image.LANCZOS).convert("RGBA")


if __name__ == "__main__":
    make_icon(192).save("icon-192.png")
    make_icon(512).save("icon-512.png")
    make_icon(512, maskable=True).save("icon-512-maskable.png")
    print("icons written")
