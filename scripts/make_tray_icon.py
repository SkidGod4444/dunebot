"""Draws Dunebot's spark as macOS template tray icons (black + alpha). Usage: python3 -I make_tray_icon.py <out-dir>"""
import struct, sys, zlib, os

def star(x, y):
    # 4-point spark: |x|^p + |y|^p <= 1 with p < 1 gives the pinched star
    p = 0.55
    return abs(x) ** p + abs(y) ** p <= 1.0

def render(size, dot=False, rgb=(0, 0, 0)):
    ss = 6
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            hit = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size * 2 - 1
                    y = (py + (sy + 0.5) / ss) / size * 2 - 1
                    inside = star(x * 1.08, y * 1.08)
                    if dot:
                        inside = inside or ((x - 0.72) ** 2 + (y + 0.72) ** 2 <= 0.07)
                    hit += inside
            a = round(255 * hit / (ss * ss))
            row += bytes((*rgb, a))
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

out = sys.argv[1]
for name, dot in [("tray", False), ("tray-busy", True)]:
    open(os.path.join(out, f"{name}Template.png"), "wb").write(render(18, dot))
    open(os.path.join(out, f"{name}Template@2x.png"), "wb").write(render(36, dot))
# Windows/Linux trays have no template images: a coral mark reads on light and dark bars.
open(os.path.join(out, "tray-color.png"), "wb").write(render(32, False, (255, 107, 74)))
open(os.path.join(out, "tray-color-busy.png"), "wb").write(render(32, True, (255, 107, 74)))
print("ok")
