import cv2
import numpy as np
from .frames import read_frames

def _frames(path: str, width: int = 180):
    for t, img in read_frames(path):
        h, w = img.shape[:2]
        yield t, cv2.resize(img, (width, max(1, int(h * width / w))))

def brightness_jumps(path: str, threshold: float = 3.0) -> dict:
    """Sudden whole-frame brightness changes (a dark flicker the reference never had)."""
    prev, jumps = None, []
    for t, img in _frames(path):
        m = float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())
        if prev is not None and abs(m - prev) > threshold:
            jumps.append({"at_s": round(t, 2), "delta": round(m - prev, 1)})
        prev = m
    return {"count": len(jumps), "jumps": jumps}

def coverage(path: str, hsv_lo, hsv_hi, step_s: float = 0.2) -> dict:
    """Fraction of the frame inside an HSV range (the occluder), every step_s."""
    curve, next_t = [], 0.0
    for t, img in _frames(path):
        if t + 1e-9 >= next_t:
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            mask = cv2.inRange(hsv, np.array(hsv_lo, np.uint8), np.array(hsv_hi, np.uint8))
            curve.append(round(float((mask > 0).mean()), 3))
            next_t += step_s
    return {"curve": curve, "step_s": step_s}
