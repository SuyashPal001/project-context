"""Body position measured from frames (pose joints + optical flow), not read by a model.

Leg side per look = where knees and ankles sit against the hips (image left/right),
judged at the look's start (first second) and end (last second). A look with too
few readable frames is "unknown", never a guess. Leg moves (when, which way) come
from optical flow on the lower body.
"""
import cv2
import numpy as np
from .frames import read_frames

# RTMPose-s, body-only (17 COCO joints), Apache-2.0, ONNX on CPU. No person detector:
# the breakdown's measured subject box is the crop.
MODEL_URL = "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip"
MODEL_NAME = "rtmpose-s"
MIN_SCORE = 0.2
SIDE_THRESHOLD = 0.02   # fraction of frame width
WINDOW_S = 1.0          # look start / end window
MIN_FRAMES = 2
_model = None

def _pose_model():
    global _model
    if _model is None:
        from rtmlib import RTMPose
        _model = RTMPose(onnx_model=MODEL_URL, model_input_size=(192, 256), backend="onnxruntime", device="cpu")
    return _model

def leg_offset(kp, sc, width: float):
    """Knees and ankles against hips, as a fraction of frame width (+ = image-right)."""
    if min(sc[i] for i in (11, 12, 13, 14, 15, 16)) < MIN_SCORE:
        return None
    hips = kp[[11, 12], 0].mean()
    return float(((kp[[13, 14], 0].mean() + kp[[15, 16], 0].mean()) / 2 - hips) / width)

def body_angle(kp, sc):
    """Shoulders-to-hips line against the frame's vertical, degrees (0 = straight down)."""
    if min(sc[i] for i in (5, 6, 11, 12)) < MIN_SCORE:
        return None
    sh, hp = kp[[5, 6]].mean(0), kp[[11, 12]].mean(0)
    return float(np.degrees(np.arctan2(hp[0] - sh[0], hp[1] - sh[1])))

def side(v):
    if v is None:
        return "unknown"
    return "image-right" if v > SIDE_THRESHOLD else "image-left" if v < -SIDE_THRESHOLD else "center"

def _window(readings, first: bool):
    if not readings:
        return []
    t0 = readings[0][0] if first else readings[-1][0]
    return [r for r in readings if (r[0] <= t0 + WINDOW_S if first else r[0] >= t0 - WINDOW_S)]

def summarise_looks(looks: list[dict], frames, width: float) -> list[dict]:
    """frames: [(t_s, (kp, sc))] already outside excluded spans."""
    out = []
    for lk in looks:
        readings = []
        for t, (kp, sc) in frames:
            if lk["start_s"] <= t < lk["end_s"]:
                off = leg_offset(kp, sc, width)
                if off is not None:
                    readings.append((t, off, body_angle(kp, sc)))
        res = {"label": lk["label"], "start_s": lk["start_s"], "end_s": lk["end_s"], "frames_used": len(readings)}
        for name, first in (("start", True), ("end", False)):
            w = _window(readings, first)
            ok = len(w) >= MIN_FRAMES
            off = float(np.median([r[1] for r in w])) if ok else None
            angles = [r[2] for r in w if r[2] is not None]
            res[f"leg_side_{name}"] = side(off)
            res[f"leg_offset_{name}"] = round(off, 3) if off is not None else None
            res[f"body_angle_{name}"] = round(float(np.median(angles)), 1) if ok and angles else None
        out.append(res)
    return out

def _excluded(t, exclude):
    return any(a - 0.1 <= t <= b + 0.1 for a, b in exclude)

FLOW_WIDTH = 180  # flow is computed at this frame width (thresholds are in these pixels)

def _legs_gray(img, legs_box):
    """The lower-body area only, at the same scale as a FLOW_WIDTH-wide frame (cheaper flow, same numbers)."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in legs_box]
    crop = img[int(h * y0):max(int(h * y1), int(h * y0) + 2), int(w * x0):max(int(w * x1), int(w * x0) + 2)]
    scale = FLOW_WIDTH / w
    return cv2.cvtColor(cv2.resize(crop, (max(8, int(crop.shape[1] * scale)), max(8, int(crop.shape[0] * scale)))), cv2.COLOR_BGR2GRAY)

class _Flow:
    def __init__(self, legs_box, exclude):
        self.box, self.exclude, self.prev, self.ts, self.vx = legs_box, exclude, None, [], []

    def add(self, t, img):
        g = _legs_gray(img, self.box)
        if self.prev is not None and self.prev.shape == g.shape:
            f = cv2.calcOpticalFlowFarneback(self.prev, g, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            self.ts.append(t); self.vx.append(0.0 if _excluded(t, self.exclude) else float(f[..., 0].mean()))
        self.prev = g

    def moves(self) -> list[dict]:
        ts, vx = self.ts, self.vx
        if len(vx) < 5:
            return []
        sm = np.convolve(np.array(vx), np.ones(5) / 5, "same")
        mag = np.abs(sm)
        floor = max(4 * float(np.median(mag)), 0.05)
        out, i = [], 0
        while i < len(sm):
            if mag[i] < floor:
                i += 1; continue
            j = i
            while j < len(sm) and mag[j] >= floor and np.sign(sm[j]) == np.sign(sm[i]):
                j += 1
            k = i + int(np.argmax(mag[i:j]))
            if not any(_excluded(ts[m], self.exclude) for m in range(i, j)):
                out.append({"t_s": round(ts[k], 2), "from_s": round(ts[i], 2), "to_s": round(ts[j - 1], 2), "part": "legs", "direction": "image-right" if sm[k] > 0 else "image-left", "strength": round(float(mag[k]), 3)})
            i = j
        return out

def flow_moves(path: str, legs_box, exclude) -> list[dict]:
    """Sideways leg moves from optical flow in the lower-body box: peak time and direction."""
    fl = _Flow(legs_box, exclude)
    for t, img in read_frames(path):
        fl.add(t, img)
    return fl.moves()

def measure_pose(path: str, looks: list[dict], subject_box=None, exclude=None, fps: float = 10.0) -> dict:
    """One pass over the video: optical flow on every frame's lower body, pose joints at `fps`."""
    exclude = exclude or []
    model = _pose_model()
    sb = subject_box or [0.1, 0.1, 0.9, 0.9]
    fl = _Flow([sb[0], sb[1] + (sb[3] - sb[1]) * 0.45, sb[2], sb[3]], exclude)
    frames, width, next_t = [], None, 0.0
    for t, img in read_frames(path):
        fl.add(t, img)
        if t + 1e-9 < next_t:
            continue
        next_t = t + 1.0 / fps
        if _excluded(t, exclude):
            continue
        h, w = img.shape[:2]
        width = w
        bb = [[subject_box[0] * w, subject_box[1] * h, subject_box[2] * w, subject_box[3] * h]] if subject_box else []
        kp, sc = model(img, bboxes=bb)
        if len(kp):
            frames.append((t, (kp[0], sc[0])))
    return {"model": MODEL_NAME, "looks": summarise_looks(looks, frames, width or 1.0), "moves": fl.moves()}
