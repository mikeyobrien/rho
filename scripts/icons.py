#!/usr/bin/env python3
"""Draw rho's app icons (a rho: a ring with a stem) as PNG files, with no image library.

    python3 -I scripts/icons.py web

Writes icon-192.png, icon-512.png and icon-maskable-512.png. Run again after changing the shape.
"""
import struct, sys, zlib
from pathlib import Path

BACK, FORE = (0x16, 0x18, 0x1C), (0xE8, 0xE6, 0xE1)

def coverage(x: float, y: float, scale: float) -> float:
    """How much of the glyph covers the point, 0 to 1, in a unit square; `scale` shrinks the glyph."""
    u, v = (x - 0.5) / scale + 0.5, (y - 0.5) / scale + 0.5
    ring = abs(((u - 0.54) ** 2 + (v - 0.42) ** 2) ** 0.5 - 0.17) <= 0.045
    stem = 0.325 <= u <= 0.415 and 0.42 <= v <= 0.80
    return 1.0 if ring or stem else 0.0

def png(size: int, scale: float, rounded: bool) -> bytes:
    rows = bytearray()
    samples = [(a + 0.5) / 3 for a in range(3)]
    radius = 0.22
    for py in range(size):
        rows.append(0)
        for px in range(size):
            ink = sum(coverage((px + sx) / size, (py + sy) / size, scale) for sx in samples for sy in samples) / 9
            alpha = 255
            if rounded:  # transparent corners; a maskable icon fills its square instead
                x, y = (px + 0.5) / size, (py + 0.5) / size
                cx, cy = min(max(x, radius), 1 - radius), min(max(y, radius), 1 - radius)
                if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                    alpha = 0
            rows.extend(round(b + (f - b) * ink) for b, f in zip(BACK, FORE))
            rows.append(alpha)
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")

out = Path(sys.argv[1])
for name, size, scale, rounded in [("icon-192.png", 192, 1.0, True), ("icon-512.png", 512, 1.0, True), ("icon-maskable-512.png", 512, 0.72, False)]:
    (out / name).write_bytes(png(size, scale, rounded))
    print(name, (out / name).stat().st_size, "bytes")
