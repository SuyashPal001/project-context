import cv2
import numpy as np
from .frames import read_frames

MIN_STABLE_S = 0.3

def _feat(img, box):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    c = img[int(h * y0):max(int(h * y1), int(h * y0) + 8), int(w * x0):max(int(w * x1), int(w * x0) + 8)]
    hist = cv2.calcHist([cv2.cvtColor(c, cv2.COLOR_BGR2HSV)], [0, 1], None, [30, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist

def find_hidden_cuts(path: str, looks: list[dict], subject_box=None) -> dict:
    if len(looks) < 2:
        return {"hidden_cuts": [], "cover_threshold": None}
    box = subject_box or [0.1, 0.1, 0.9, 0.9]
    feats, ts = [], []
    for t, img in read_frames(path):
        feats.append(_feat(img, box))
        ts.append(t)
    if not feats:
        raise ValueError("no frames")
    ts = np.array(ts)
    fps = len(ts) / max(ts[-1] - ts[0], 1e-6) if len(ts) > 1 else 30
    refs = [feats[min(len(feats) - 1, int(np.searchsorted(ts, (l["approx_start_s"] + l["approx_end_s"]) / 2)))] for l in looks]
    sim = np.array([[cv2.compareHist(f, r, cv2.HISTCMP_CORREL) for r in refs] for f in feats])
    top, best = sim.max(1), sim.argmax(1)
    cover = min(0.6, float(np.median(top)) * 0.75)
    lab = np.where(top >= cover, best, -1)
    # keep only runs of a look that last at least MIN_STABLE_S
    min_run = max(1, int(round(MIN_STABLE_S * fps)))
    i = 0
    while i < len(lab):
        if lab[i] < 0:
            i += 1
            continue
        j = i
        while j < len(lab) and lab[j] == lab[i]:
            j += 1
        if j - i < min_run:
            lab[i:j] = -1
        i = j
    switches, prev, prev_i = [], None, 0
    for i, l in enumerate(lab):
        if l < 0:
            continue
        if prev is not None and l != prev:
            switches.append({"from": looks[prev]["label"], "to": looks[l]["label"], "at_s": round(float(ts[prev_i] + ts[i]) / 2, 2), "covered_s": [round(float(ts[prev_i]), 2), round(float(ts[i]), 2)]})
        prev, prev_i = l, i
    return {"hidden_cuts": switches, "cover_threshold": round(cover, 2)}
