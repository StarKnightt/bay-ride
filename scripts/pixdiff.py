"""Pixel-for-pixel comparison of two capture folders (same file names), e.g. before and after a change.

    python scripts/pixdiff.py shots/boot-fix/before-shots shots/boot-fix/after-shots [--out=shots/boot-fix/diff]

Prints, per image, how many pixels differ at all, how many by more than 2 and 8 levels (any channel,
0-255), and the largest difference; with --out it writes an amplified difference image for each
pair that differs (black = identical).
"""
import os
import sys

import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--")]
opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
if len(args) != 2:
    sys.exit(__doc__)
a_dir, b_dir = args
out = opts.get("out")
if out:
    os.makedirs(out, exist_ok=True)
names = sorted(n for n in os.listdir(a_dir) if n.endswith(".png") and os.path.exists(os.path.join(b_dir, n)))
if not names:
    sys.exit("no matching .png files")
worst = 0
for n in names:
    a = np.asarray(Image.open(os.path.join(a_dir, n)).convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(os.path.join(b_dir, n)).convert("RGB"), dtype=np.int16)
    if a.shape != b.shape:
        print(f"{n:28s} size differs {a.shape} vs {b.shape}")
        worst = 255
        continue
    d = np.abs(a - b).max(axis=2)
    total = d.size
    n0, n2, n8, mx = int((d > 0).sum()), int((d > 2).sum()), int((d > 8).sum()), int(d.max())
    worst = max(worst, mx)
    print(f"{n:28s} differing px {n0:7d} ({100 * n0 / total:.3f}%)  >2: {n2:6d}  >8: {n8:6d}  max {mx}")
    if out and n0:
        Image.fromarray(np.clip(d * 16, 0, 255).astype(np.uint8)).save(os.path.join(out, n))
print(f"largest difference over all images: {worst}")
