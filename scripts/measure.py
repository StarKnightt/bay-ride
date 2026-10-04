"""Mean RGB and Rec.709 luma over small boxes of a capture.

usage: python scripts/measure.py <png> x,y[,r] [x,y[,r] ...]   (r = box half-size, default 6)
"""
import sys
from PIL import Image

if len(sys.argv) < 3 or sys.argv[1] in ("-h", "--help"):
    print(__doc__.strip())
    print()
    print("Prints one line per box: x,y: rgb=(R,G,B) L=<Rec.709 luma>, all 0-255.")
    print("example: python scripts/measure.py shots/x/shot1_noon_t20.png 1650,850 1890,720,10")
    sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help") else 2)

img = Image.open(sys.argv[1]).convert("RGB")
for spec in sys.argv[2:]:
    parts = [int(v) for v in spec.split(",")]
    x, y = parts[0], parts[1]
    r = parts[2] if len(parts) > 2 else 6
    px = [img.getpixel((i, j)) for i in range(x - r, x + r + 1) for j in range(y - r, y + r + 1)]
    m = [sum(p[c] for p in px) / len(px) for c in range(3)]
    lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
    print(f"{x},{y}: rgb=({m[0]:.0f},{m[1]:.0f},{m[2]:.0f}) L={lum:.0f}")
