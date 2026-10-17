"""The fan-blade wipe, as a shared trick: a ceiling fan's blade sweeps across the frame and each new look
appears behind it (wherever the blade has passed shows the new look; her face stays visible meanwhile).

Proven by hand on the fan reel (v3-v12, 2026-10-14). The timing and shape come from the original, MEASURED,
never from a model: Omni and Veo ignored timing and "corrected" the blade to a normal fan (2026-10-14/17).

replay(): the original's blade area itself, frame by frame (dark wood that moves), filled with our wood
texture, and the next look shown wherever that area has passed during the sweep. Earlier tries failed on the
real reel (fan runs real23): a track from cut times swept late and too steep; angles around a guessed hub drew
blades too steep and too many; fitted lines broke when the blade met the frame edge.

compose(): no original to measure; three blades on a steady track through the cut times (a real fan turns at a
steady speed: an eased sweep stopped and started at every cut).
"""
import os
import subprocess

import cv2
import numpy as np

COVER_DEG = 55.0       # steady track: blade angle (from the top edge, clockwise) lying across her body at a cut
STEP_DEG = 120.0       # three blades
REVEAL_DEG = 90.0      # past this the blade has left the frame
HUB = (-0.042, -0.023)  # steady track: hub just off the top-left corner, frame fractions
BLADE_LEN = 2.9        # steady track: blade length and thickness, in frame widths
BLADE_THICK = 0.75
SHADE = 0.72           # the blade sits in shadow under the ceiling (when its colour was not measured)
SMOOTH = 9             # frames: a moving average so the steady track's speed never jumps at a cut
# a dark red-brown blade (OpenCV HSV: hue 0-179); the fan reel's blade reads hue 5-12, saturation 228+, value 62-76
BLADE_HSV = ([0, 170, 20], [16, 255, 120])
STILL_SHARE = 0.85     # a pixel dark in this share of frames is something lying still (her hair), not the blade
MIN_BLADE = 0.02       # of the frame: a dark area smaller than this is not the blade
MEASURE_WIDTH = 240    # the original is read at this width (fast); the mask is scaled up and softened
EDGE_PX = 3            # softened blade edge, in output pixels
ASSETS = os.path.join(os.path.dirname(__file__), "assets")


def angle_track(peaks: list[float], duration_s: float, fps: int = 30) -> list[float]:
    """Fan angle per frame: at rest, then turning steadily so a blade lies across her at each cut time."""
    n = round(duration_s * fps)
    if not peaks:
        return [0.0] * n
    speeds = [STEP_DEG / (b - a) for a, b in zip(peaks, peaks[1:]) if b > a] or [30.0]
    start = peaks[0] - COVER_DEG / speeds[0]
    knots_t = [start] + list(peaks)
    knots_a = [0.0] + [COVER_DEG + STEP_DEG * k for k in range(len(peaks))]
    t = np.arange(n) / fps
    a = np.interp(t, knots_t, knots_a, left=0.0, right=np.nan)
    after = t > peaks[-1]
    a[after] = knots_a[-1] + speeds[-1] * (t[after] - peaks[-1])
    if SMOOTH > 1:
        pad = SMOOTH // 2
        padded = np.concatenate([np.full(pad, a[0]), a, a[-1] + speeds[-1] / fps * np.arange(1, pad + 1)])
        a = np.convolve(padded, np.ones(SMOOTH) / SMOOTH, mode="valid")
    a = np.maximum.accumulate(np.maximum(a, 0.0))
    return [round(float(x), 3) for x in a]


class _Segment:
    """Frames of one look, read in order; before its first frame it shows its first, after its last its last."""

    def __init__(self, path: str, count: int, size):
        self.cap, self.count, self.size = cv2.VideoCapture(path), count, size
        self.pos, self.frame = -1, None
        self._next()

    def _next(self):
        ok, f = self.cap.read()
        if ok:
            self.frame = cv2.resize(f, self.size)
            self.pos += 1
        return ok

    def at(self, i: int):
        i = max(0, min(self.count - 1, i))
        while self.pos < i and self._next():
            pass
        return self.frame


def _load_rgba(name: str, color=None):
    """The asset in shadow, or tinted to the original's measured colour (BGR)."""
    im = cv2.imread(os.path.join(ASSETS, name), cv2.IMREAD_UNCHANGED)
    rgb, a = im[..., :3].astype(np.float32), im[..., 3].astype(np.float32) / 255.0
    if color is None:
        return rgb * SHADE, a
    mean = rgb[a > 0.5].mean(axis=0)
    return np.clip(rgb * (np.array(color, np.float32) / np.maximum(mean, 1.0)), 0, 255), a


def _writer(out: str, w: int, h: int, fps: int):
    return subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
                             "-i", "-", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)


def _finish(proc):
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg could not write the swept video")


def _dark_masks(path: str, hsv_lo, hsv_hi):
    """The original's dark-wood mask per frame (at MEASURE_WIDTH), its fps, and the blade colour (BGR)."""
    lo, hi = np.array(hsv_lo, np.uint8), np.array(hsv_hi, np.uint8)
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    masks, colours = [], []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        h0, w0 = f.shape[:2]
        f = cv2.resize(f, (MEASURE_WIDTH, round(MEASURE_WIDTH * h0 / w0)))
        m = cv2.inRange(cv2.cvtColor(f, cv2.COLOR_BGR2HSV), lo, hi)
        # only large dark areas are the blade: dark folds of crimson clothes matched too (fan run real23)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m)
        big = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= MIN_BLADE * m.size]
        m = np.isin(labels, big)
        masks.append(m)
        if m.mean() > 0.01:
            colours.append(f[m].mean(axis=0))
    return masks, fps, (np.median(np.array(colours), axis=0) if colours else np.array([6.0, 20.0, 66.0]))


def replay(original: str, segments: list[str], counts: list[int], covered: list[list[float]], out: str, size,
           fps: int = 30, hsv_lo=None, hsv_hi=None) -> dict:
    """Join the looks with the original's own blade: at each covered span (a hidden cut) the next look shows
    wherever the blade has passed since that sweep began; between sweeps the blade is drawn wherever the
    original's is. Returns the measured blade colour."""
    w, h = size
    masks, ofps, colour = _dark_masks(original, hsv_lo or BLADE_HSV[0], hsv_hi or BLADE_HSV[1])
    if not masks:
        raise ValueError("the original could not be read")
    still = np.mean(masks, axis=0) >= STILL_SHARE          # her dark hair, a shadow: never the blade
    segs = [_Segment(p, c, (w, h)) for p, c in zip(segments, counts)]
    offsets = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(int)
    total = int(sum(counts))
    # each sweep runs from midway after the previous covered span to midway before the next one
    mids = [(a + b) / 2 for a, b in covered]
    bounds = [0.0] + [(mids[k] + mids[k + 1]) / 2 for k in range(len(mids) - 1)] + [total / fps + 1]
    # the solid middle of the wood picture, stretched over the whole frame (the blade area cuts it out)
    wood, wood_a = _load_rgba("fan_blade.png", colour)
    ys, xs = np.where(wood_a > 0.95)
    core = wood[ys.min() + (ys.max() - ys.min()) // 4: ys.max() - (ys.max() - ys.min()) // 4, xs.min() + (xs.max() - xs.min()) // 6: xs.max() - (xs.max() - xs.min()) // 6]
    wood = cv2.resize(core, (w, h), interpolation=cv2.INTER_LINEAR)
    proc = _writer(out, w, h, fps)
    last = len(segs) - 1
    swept = np.zeros((masks[0].shape[0], masks[0].shape[1]), bool)
    sweep_k = -1
    for n in range(total):
        t = n / fps
        k = next((i for i in range(len(covered)) if bounds[i] <= t < bounds[i + 1]), len(covered) - 1)
        m = masks[min(len(masks) - 1, round(t * ofps))] & ~still
        if k != sweep_k:
            swept[:] = False
            sweep_k = k
        swept |= m
        frame = lambda i: segs[min(i, last)].at(n - offsets[min(i, last)]).astype(np.float32)
        # looks before this sweep are done; this sweep's look shows wherever the blade has passed
        done = sum(1 for i in range(len(covered)) if t >= bounds[i + 1])
        img = frame(done)
        if done < len(covered) and done < last and t >= bounds[done]:
            up = cv2.resize(swept.astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_LINEAR) > 127
            img = np.where(up[..., None], frame(done + 1), img)
        blade = cv2.GaussianBlur(cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR), (0, 0), EDGE_PX)
        img = img * (1 - blade[..., None]) + wood * blade[..., None]
        proc.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
    _finish(proc)
    return {"color": [round(float(c), 1) for c in colour]}


def _phi(w: int, h: int):
    yy, xx = np.mgrid[0:h, 0:w]
    return np.degrees(np.arctan2(yy - HUB[1] * h, xx - HUB[0] * w))   # 0 = along the top edge, 90 = down the left edge


def _blade_layer(img, alpha, angle: float, w: int, h: int):
    bh, bw = img.shape[:2]
    L, T = BLADE_LEN * w, BLADE_THICK * w
    hx, hy = HUB[0] * w, HUB[1] * h
    c, s = np.cos(np.radians(angle)), np.sin(np.radians(angle))
    m = np.float32([[L / bw * c, -T / bh * s, hx + T / 2 * s], [L / bw * s, T / bh * c, hy - T / 2 * c]])
    return cv2.warpAffine(img, m, (w, h), borderValue=0), cv2.warpAffine(alpha, m, (w, h), borderValue=0)


def compose(segments: list[str], counts: list[int], peaks: list[float], out: str, size, fps: int = 30) -> str:
    """No original to measure: three blades on a steady track; look j+1 appears along the edge of the blade that
    lies across her at cut j."""
    w, h = size
    segs = [_Segment(p, c, (w, h)) for p, c in zip(segments, counts)]
    offsets = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(int)
    total = int(sum(counts))
    track = angle_track(peaks, total / fps, fps)
    phi = _phi(w, h)
    blade, blade_a = _load_rgba("fan_blade.png")
    proc = _writer(out, w, h, fps)
    last = len(segs) - 1
    for n in range(total):
        th = track[n]
        frame = lambda k: segs[k].at(n - offsets[k]).astype(np.float32)
        j = min(last, sum(1 for k in range(last) if th >= STEP_DEG * k + REVEAL_DEG))
        img = frame(j)
        if j < last and th > STEP_DEG * j:
            img = np.where((phi < th - STEP_DEG * j)[..., None], frame(j + 1), img)
        for m in range(3):
            rgb, a = _blade_layer(blade, blade_a, th + STEP_DEG * m, w, h)
            img = img * (1 - a[..., None]) + rgb * a[..., None]
        proc.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
    _finish(proc)
    return out
