"""Front-silhouette check against the concept sheet (reference-locked validation).

Step 1, in Blender after build.py (renders her front mask in the idle pose):
  import runpy; runpy.run_path(r"C:\\Code\\bay-ride\\tools\\character\\silhouette.py", run_name="__main__")
Step 2, with the system Python (numpy + Pillow):
  python tools/character/silhouette.py --compare
Writes shots/silhouette/{render_mask,reference_mask,overlay}.png and
tools/character/silhouette_report.json: IoU after height normalisation plus the width of each
body band (hat brim, head, shoulders, waist, shorts hem, calves) relative to the overall height,
for her and for the front figure of refs/character/concept_sheet.jpg.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "shots", "silhouette")
# The concept sheet's front figure (fractions of the sheet: x0, y0, x1, y1).
REF_BOX = (0.03, 0.0, 0.20, 0.808)
# Bands as fractions of the figure height from the top (hat crown = 0, sandal soles = 1).
BANDS = {"hat_brim": 0.055, "head": 0.12, "shoulders": 0.205, "waist": 0.36, "shorts_hem": 0.60, "calves": 0.80}


def render():
    import bpy
    sys.path.insert(0, HERE)
    import importlib
    from heroine import preview
    importlib.reload(preview)
    arm = bpy.data.objects["heroine"]
    ad = arm.animation_data
    act = bpy.data.actions["idle"]
    ad.action = act
    ad.action_slot = act.slots[0]
    bpy.context.scene.frame_set(1)
    try:
        preview.shoot(os.path.join(OUT, "render_mask.png"), (0, 0, 0.92), 4.0, 0, 0, ortho=2.0, res=(800, 1600), mask=True)
    finally:
        ad.action = None


def _bbox(m):
    ys, xs = (m > 0).nonzero()
    return xs.min(), ys.min(), xs.max(), ys.max()


def compare():
    import numpy as np
    from PIL import Image
    ref = np.asarray(Image.open(os.path.join(REPO, "refs", "character", "concept_sheet.jpg")).convert("RGB"), float)
    H, W = ref.shape[:2]
    x0, y0, x1, y1 = (int(REF_BOX[0] * W), int(REF_BOX[1] * H), int(REF_BOX[2] * W), int(REF_BOX[3] * H))
    crop = ref[y0:y1, x0:x1]
    # Paper is a warm cream; the figure is anything clearly darker or more saturated than it.
    paper = np.median(crop[:20].reshape(-1, 3), axis=0)
    diff = np.linalg.norm(crop - paper, axis=2)
    sat = crop.max(axis=2) - crop.min(axis=2)
    m_ref = (diff > 38) | (sat > 70)
    # Fill: keep the row span between the leftmost and rightmost figure pixel only where both
    # halves agree (closes the watercolour gaps without bridging the legs).
    m_ref = _clean(m_ref)
    m_ren = np.asarray(Image.open(os.path.join(OUT, "render_mask.png")).convert("L"), float) > 128
    a, b = _norm(m_ref), _norm(m_ren)
    inter, union = (a & b).sum(), (a | b).sum()
    rep = {"iou": round(float(inter / union), 3), "bands_width_over_height": {}}
    for k, f in BANDS.items():
        rep["bands_width_over_height"][k] = {"concept": _band(a, f), "model": _band(b, f)}
    ov = np.zeros(a.shape + (3,), np.uint8)
    ov[..., 0] = a * 255
    ov[..., 1] = b * 255
    ov[..., 2] = (a & b) * 255
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(ov).save(os.path.join(OUT, "overlay.png"))
    Image.fromarray((a * 255).astype(np.uint8)).save(os.path.join(OUT, "reference_mask.png"))
    with open(os.path.join(HERE, "silhouette_report.json"), "w") as fh:
        json.dump(rep, fh, indent=1)
    print(json.dumps(rep, indent=1))


def _clean(m):
    import numpy as np
    from PIL import Image, ImageFilter
    im = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    m = np.asarray(im) > 128
    # Drop the floor shadow under the sandals: keep rows down to the last strongly dark one.
    return m


def _norm(m, size=1000):
    """Crop to the figure and scale to a fixed height, centred horizontally."""
    import numpy as np
    from PIL import Image
    x0, y0, x1, y1 = _bbox(m)
    c = m[y0:y1 + 1, x0:x1 + 1]
    h = size
    w = max(1, int(round(c.shape[1] * size / c.shape[0])))
    im = Image.fromarray((c * 255).astype(np.uint8)).resize((w, h), Image.NEAREST)
    out = np.zeros((size, size // 2), bool)
    off = (out.shape[1] - w) // 2
    sub = np.asarray(im) > 128
    lo, hi = max(0, off), min(out.shape[1], off + w)
    out[:, lo:hi] = sub[:, lo - off:hi - off]
    return out


def _band(m, f):
    row = m[int(f * (m.shape[0] - 1))]
    xs = row.nonzero()[0]
    return round(float((xs.max() - xs.min() + 1) / m.shape[0]), 3) if len(xs) else 0.0


if __name__ == "__main__":
    if "--compare" in sys.argv:
        compare()
    else:
        render()
