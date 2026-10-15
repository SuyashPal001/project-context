import cv2
import numpy as np

def _energies(path: str, box):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in box]
    prev, out = None, []
    try:
        while True:
            ok, img = cap.read()
            if not ok:
                break
            h, w = img.shape[:2]
            scale = 160 / w
            g = cv2.cvtColor(cv2.resize(img, (160, max(1, int(h * scale)))), cv2.COLOR_BGR2GRAY).astype(np.float32)
            gh, gw = g.shape
            crop = g[int(gh * y0):max(int(gh * y1), int(gh * y0) + 2), int(gw * x0):max(int(gw * x1), int(gw * x0) + 2)]
            out.append(0.0 if prev is None or prev.shape != crop.shape else float(np.mean(np.abs(crop - prev))))
            prev = crop
    finally:
        cap.release()
    return fps, np.array(out)

GUARD_S = 0.5  # an occluder or cut still moves just past its measured span

def motion_peaks(path: str, items: list[dict], exclude: list[list[float]], window_s: float = 1.5) -> dict:
    """Exact time of a movement near a hint time: the frame with the most
    change inside the box. Counts only if clearly above the window's normal
    level; otherwise the hint is kept and marked unmeasured. Never measured
    near a cut or covered span, or on the window's edge (review C1)."""
    results, cache = [], {}
    for it in items:
        key = tuple(it["box"])
        if key not in cache:
            cache[key] = _energies(path, it["box"])
        fps, e = cache[key]
        n = len(e)
        keep = np.ones(n, dtype=bool)
        near = np.zeros(n, dtype=bool)
        for a, b in exclude:
            keep[max(0, int((a - 0.1) * fps)):min(n, int((b + 0.1) * fps) + 1)] = False
            near[max(0, int((a - GUARD_S) * fps)):min(n, int((b + GUARD_S) * fps) + 1)] = True
        unmeasured = {"id": it["id"], "t_s_in": it["t_s"], "t_s": it["t_s"], "measured": False, "strength": 0.0}
        hint_i = int(it["t_s"] * fps)
        if 0 <= hint_i < n and near[hint_i]:
            results.append(unmeasured); continue
        lo = max(0, int((it["t_s"] - window_s) * fps)); hi = min(n, int((it["t_s"] + window_s) * fps) + 1)
        win = np.where(keep[lo:hi], e[lo:hi], 0.0)
        live = e[lo:hi][keep[lo:hi]]
        if live.size == 0:
            results.append(unmeasured); continue
        k = int(np.argmax(win)); peak = float(win[k]); med = float(np.median(live))
        on_edge = k == 0 or k == len(win) - 1
        if peak >= 1.0 and peak >= 3 * max(med, 1e-6) and not on_edge and not near[lo + k]:
            results.append({"id": it["id"], "t_s_in": it["t_s"], "t_s": round((lo + k) / fps, 2), "measured": True, "strength": round(peak, 2)})
        else:
            results.append({**unmeasured, "strength": round(peak, 2) if peak >= 1.0 else 0.0})
    return {"items": results}
