"""Body reading for ANY reel, measured from the frames — never a model's guess.

Per look: how many people, and for the main (largest) person at the look's start
and end: framing (which joints are in shot), orientation in the frame, knees, each
arm and where the legs fall — all read along the body's own axis, so a person lying
down or upside down reads the same as one standing. Parts that cannot be seen are
"unknown"; a look with nobody in it is "no person", which is different.

Movement: optical flow, split into camera moves (the whole frame) and body moves
(upper / lower body of the main person, after removing the camera move), each with
its measured time and direction.

Models (Apache-2.0, ONNX on CPU, via rtmlib): YOLOX-tiny person detector and
RTMPose-s body joints (17 COCO points).
"""
from collections import Counter

import cv2
import numpy as np

from .frames import read_frames

DET_URL = "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_tiny_8xb8-300e_humanart-6f3252f9.zip"
POSE_URL = "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip"
MODEL_NAME = "yolox-tiny + rtmpose-s"
VIS = 0.3               # a joint counts as seen at this score
MIN_JOINTS = 4          # a detection needs this many seen joints to count as a person
MIN_BOX_AREA = 0.004    # of the frame; smaller boxes are noise
WINDOW_S = 1.0          # look start / end window
MIN_FRAMES = 2
LEG_THRESHOLD = 0.05    # knee / foot offset as a fraction of torso length
SIDE_ON = 0.3           # shoulder width across the body, as a fraction of torso length, below which the body is side-on
EDGE = 0.985            # with only one ankle seen, a box reaching the bottom edge may have its feet cut off
FOOT_ROOM = 0.04        # of frame height: space a foot needs below its ankle
MOVE_MIN = 0.025        # frame widths per second; weaker body moves are noise
MOVE_GUARD_S = 0.5      # moves this close to a covered span are the occluder, not the body
FLOW_WIDTH = 120

NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN = 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
_models = None


def _load():
    global _models
    if _models is None:
        from rtmlib import RTMPose, YOLOX
        _models = (YOLOX(DET_URL, model_input_size=(416, 416), backend="onnxruntime", device="cpu"),
                   RTMPose(onnx_model=POSE_URL, model_input_size=(192, 256), backend="onnxruntime", device="cpu"))
    return _models


def _mid(kp, sc, ids):
    pts = [kp[i] for i in ids if sc[i] >= VIS]
    return np.mean(pts, axis=0) if pts else None


def _seen(sc, ids):
    return any(sc[i] >= VIS for i in ids)


def _toward(off, v):
    if off is None:
        return "unknown"
    if abs(off) < LEG_THRESHOLD:
        return "center"
    vec = off * v
    return ("image-right" if vec[0] > 0 else "image-left") if abs(vec[0]) >= abs(vec[1]) else ("image-down" if vec[1] > 0 else "image-up")


def read_person(kp, sc, aspect: float = 1.0, box=None) -> dict:
    """One person's body reading. kp: 17x2 in 0-1 frame fractions; aspect = height / width;
    box: the person's detection box in fractions (a box cut by the frame's bottom edge is not full body)."""
    feet_in_frame = box is None or box[3] < EDGE
    kp = np.array(kp, dtype=float)
    # a joint the model places outside the frame was not seen, however confident it is
    sc = np.where(((kp < 0.0) | (kp > 1.0)).any(axis=1), 0.0, np.asarray(sc, dtype=float))
    # judged on frame fractions, before the height is scaled for distances
    roomy = [sc[i] >= VIS and kp[i][1] <= 1.0 - FOOT_ROOM for i in (L_AN, R_AN)]
    kp = kp * np.array([1.0, aspect])
    # Full body needs the feet in shot. A foot reaches below the ankle, so both ankles must
    # sit at least FOOT_ROOM above the frame's bottom edge; with only one ankle visible
    # (a side view hiding a leg) the person's box must not reach the edge either.
    feet_in = all(roomy) or (any(roomy) and feet_in_frame)
    framing = ("full_body" if feet_in else "knees_up" if _seen(sc, (L_KN, R_KN))
               else "waist_up" if _seen(sc, (L_HIP, R_HIP)) else "chest_up" if _seen(sc, (L_SH, R_SH))
               else "face" if _seen(sc, range(5)) else "unknown")
    sh, hp = _mid(kp, sc, (L_SH, R_SH)), _mid(kp, sc, (L_HIP, R_HIP))
    out = {"framing": framing, "orientation": "unknown", "torso_angle_deg": None, "knees": "unknown",
           "arms": {"left": "unknown", "right": "unknown"}, "knees_toward": "unknown", "feet_toward": "unknown",
           "knee_offset": None, "feet_offset": None, "legs_toward": "unknown", "leg_offset": None, "facing": "unknown"}
    u, L = None, None
    if sh is not None and hp is not None and np.linalg.norm(hp - sh) > 1e-6:
        d = hp - sh
        L = float(np.linalg.norm(d)); u = d / L
        ang = float(np.degrees(np.arctan2(d[0], d[1])))           # 0 = head up, feet down
        out["torso_angle_deg"] = round(ang, 1)
        tilt = min(abs(ang), 180 - abs(ang))
        out["orientation"] = "vertical" if tilt < 25 else "horizontal" if tilt > 65 else "diagonal"
    elif sc[L_SH] >= VIS and sc[R_SH] >= VIS:
        # no hips in shot: assume upright, scale by shoulder width (flagged by framing)
        u, L = np.array([0.0, 1.0]), float(np.linalg.norm(kp[L_SH] - kp[R_SH]) * 1.5) or None
    if u is not None and L and sc[L_SH] >= VIS and sc[R_SH] >= VIS:
        # Facing from the shoulder order across the body: facing the camera, the person's left
        # shoulder is on the image's right. The model also "sees" a face on the back of a head, so
        # the face points never decide (Snitch back-to-camera frame: -0.59; front frames +0.64..+0.73).
        w = float(np.dot(kp[L_SH] - kp[R_SH], np.array([u[1], -u[0]]))) / L
        out["facing"] = "side" if abs(w) < SIDE_ON else "front" if w > 0 else "back"
    if u is not None and L:
        for name, s_i, w_i in (("left", L_SH, L_WR), ("right", R_SH, R_WR)):
            if sc[s_i] >= VIS and sc[w_i] >= VIS:
                along = float(np.dot(kp[w_i] - kp[s_i], u)) / L
                out["arms"][name] = "raised" if along < -0.15 else "down" if along > 0.55 else "mid"
    if out["orientation"] != "unknown" and all(_seen(sc, p) for p in ((L_KN, R_KN), (L_AN, R_AN))):
        angles = []
        for h_i, k_i, a_i in ((L_HIP, L_KN, L_AN), (R_HIP, R_KN, R_AN)):
            if min(sc[h_i], sc[k_i], sc[a_i]) >= VIS:
                a, b = kp[h_i] - kp[k_i], kp[a_i] - kp[k_i]
                angles.append(np.degrees(np.arccos(np.clip(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9), -1, 1))))
        if angles:
            out["knees"] = "straight" if np.mean(angles) > 150 else "bent"
        # Where the knees fall and where the feet go, each against the hips, across the body.
        # They can point opposite ways (knees tipped one side, feet tucked the other).
        v = np.array([u[1], -u[0]])                                 # image-right when upright
        k_off = float(np.dot(_mid(kp, sc, (L_KN, R_KN)) - hp, v)) / L
        f_off = float(np.dot(_mid(kp, sc, (L_AN, R_AN)) - hp, v)) / L
        out["knee_offset"], out["feet_offset"] = round(k_off, 3), round(f_off, 3)
        out["knees_toward"], out["feet_toward"] = _toward(k_off, v), _toward(f_off, v)
        # leg side = where the knees fall (the spike's leg-side truth)
        out["legs_toward"], out["leg_offset"] = out["knees_toward"], out["knee_offset"]
    return out


def _mode(values):
    vals = [v for v in values if v not in (None, "unknown")]
    return Counter(vals).most_common(1)[0][0] if vals else "unknown"


def _aggregate(readings):
    if len(readings) < MIN_FRAMES:
        return None
    angles = [r["torso_angle_deg"] for r in readings if r["torso_angle_deg"] is not None]
    offs = [r["leg_offset"] for r in readings if r["leg_offset"] is not None]
    return {
        "framing": _mode(r["framing"] for r in readings),
        "orientation": _mode(r["orientation"] for r in readings),
        "torso_angle_deg": round(float(np.median(angles)), 1) if angles else None,
        "knees": _mode(r["knees"] for r in readings),
        "arms": {s: _mode(r["arms"][s] for r in readings) for s in ("left", "right")},
        "legs_toward": _mode(r["legs_toward"] for r in readings),
        "leg_offset": round(float(np.median(offs)), 3) if offs else None,
        "knees_toward": _mode(r["knees_toward"] for r in readings),
        "feet_toward": _mode(r["feet_toward"] for r in readings),
        "facing": _mode(r.get("facing") for r in readings),
        "frames": len(readings),
    }


def _box_area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _key_frame(t, persons):
    return {"t_s": round(t, 2), "people": [{"box": [round(float(v), 3) for v in box],
            "keypoints": [[round(float(x), 3), round(float(y), 3), round(float(s), 2)] for (x, y), s in zip(kp, sc)]} for kp, sc, box in persons]}


def summarise_looks(looks: list[dict], frames, aspect: float = 1.0) -> list[dict]:
    """frames: [(t_s, [(kp 17x2 fractions, scores 17, box [x0,y0,x1,y1] fractions), ...])] outside excluded spans."""
    out = []
    for lk in looks:
        inside = [(t, ps) for t, ps in frames if lk["start_s"] <= t < lk["end_s"]]
        counts = [len(ps) for _, ps in inside]
        people = int(round(float(np.median(counts)))) if counts else None
        with_main = [(t, max(ps, key=lambda p: _box_area(p[2]))) for t, ps in inside if ps]
        readings = [(t, read_person(m[0], m[1], aspect, m[2])) for t, m in with_main]
        start = [r for t, r in readings if readings and t <= readings[0][0] + WINDOW_S]
        end = [r for t, r in readings if readings and t >= readings[-1][0] - WINDOW_S]
        main_start, main_end = _aggregate(start), _aggregate(end)
        side = lambda m: (m["legs_toward"] if m and m["legs_toward"] in ("image-left", "image-right", "center") else "unknown")
        people_frames = [(t, ps) for t, ps in inside if ps]
        out.append({
            "label": lk["label"], "start_s": lk["start_s"], "end_s": lk["end_s"],
            "frames_used": len(inside),
            "people": people, "people_max": max(counts) if counts else None,
            "no_person": (people == 0) if people is not None else None,
            "main_start": main_start, "main_end": main_end,
            # kept for callers of the first version
            "leg_side_start": side(main_start), "leg_side_end": side(main_end),
            "body_angle_end": main_end["torso_angle_deg"] if main_end else None,
            "key_frames": [_key_frame(*people_frames[0]), _key_frame(*people_frames[-1])] if people_frames else [],
        })
    return out


def _excluded(t, exclude):
    return any(a - 0.1 <= t <= b + 0.1 for a, b in exclude)


def _segments(ts, sig, floor_abs, min_len):
    """Runs where a smoothed signal stays clearly above its normal level, same sign: (i_from, i_peak, i_to, sign)."""
    if len(sig) < 5:
        return []
    sm = np.convolve(np.array(sig), np.ones(5) / 5, "same")
    mag = np.abs(sm)
    floor = max(4 * float(np.median(mag)), floor_abs)
    segs, i = [], 0
    while i < len(sm):
        if mag[i] < floor:
            i += 1; continue
        j = i
        while j < len(sm) and mag[j] >= floor and np.sign(sm[j]) == np.sign(sm[i]):
            j += 1
        if j - i >= min_len:
            k = i + int(np.argmax(mag[i:j]))
            segs.append((i, k, j - 1, float(np.sign(sm[k])), float(mag[k])))
        i = j
    return segs


class _Motion:
    """Optical flow per frame: the camera (median of the whole frame) and the main
    person's upper and lower body (mean in their joint boxes, camera removed)."""

    def __init__(self, exclude):
        self.exclude, self.prev, self.ts = exclude, None, []
        self.sig = {k: [] for k in ("cam_x", "cam_y", "upper_x", "upper_y", "lower_x", "lower_y")}
        self.areas = {"upper": None, "lower": None}

    def set_person(self, kp, sc):
        def box(ids, pad=0.08):
            pts = np.array([kp[i] for i in ids if sc[i] >= VIS])
            if len(pts) < 2:
                return None
            (x0, y0), (x1, y1) = pts.min(0), pts.max(0)
            return (max(0, x0 - pad), max(0, y0 - pad), min(1, x1 + pad), min(1, y1 + pad))
        self.areas = {"upper": box(range(11)), "lower": box(range(11, 17))}

    def clear_person(self):
        self.areas = {"upper": None, "lower": None}

    def add(self, t, img):
        g = cv2.cvtColor(cv2.resize(img, (FLOW_WIDTH, max(8, int(img.shape[0] * FLOW_WIDTH / img.shape[1])))), cv2.COLOR_BGR2GRAY)
        if self.prev is not None and self.prev.shape == g.shape:
            f = cv2.calcOpticalFlowFarneback(self.prev, g, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            ex = _excluded(t, self.exclude)
            cam = np.median(f.reshape(-1, 2), axis=0)
            self.ts.append(t)
            self.sig["cam_x"].append(0.0 if ex else float(cam[0])); self.sig["cam_y"].append(0.0 if ex else float(cam[1]))
            gh, gw = g.shape
            for area in ("upper", "lower"):
                b = self.areas[area]
                if ex or b is None:
                    vx = vy = 0.0
                else:
                    reg = f[int(gh * b[1]):max(int(gh * b[3]), int(gh * b[1]) + 2), int(gw * b[0]):max(int(gw * b[2]), int(gw * b[0]) + 2)]
                    vx, vy = (reg.reshape(-1, 2).mean(0) - cam) if reg.size else (0.0, 0.0)
                self.sig[f"{area}_x"].append(float(vx)); self.sig[f"{area}_y"].append(float(vy))
        self.prev = g

    def result(self):
        ts = self.ts
        # pixels per frame -> frame widths per second, so reels at any frame rate compare
        fps = 1.0 / float(np.median(np.diff(ts))) if len(ts) > 2 else 30.0
        scale = fps / FLOW_WIDTH
        self.sig = {k: [v * scale for v in vs] for k, vs in self.sig.items()}
        moves, cams = [], []
        for area in ("upper", "lower"):
            for axis, names in (("x", ("image-left", "image-right")), ("y", ("image-up", "image-down"))):
                for i, k, j, s, m in _segments(ts, self.sig[f"{area}_{axis}"], 0.009, 3):
                    if not any(_excluded(ts[q], self.exclude) for q in range(i, j + 1)):
                        moves.append({"t_s": round(ts[k], 2), "from_s": round(ts[i], 2), "to_s": round(ts[j], 2), "area": area, "direction": names[s > 0], "strength": round(m, 3)})
        # content moving right means the camera turned left
        for axis, names in (("x", ("pan-right", "pan-left")), ("y", ("tilt-down", "tilt-up"))):
            for i, k, j, s, m in _segments(ts, self.sig[f"cam_{axis}"], 0.025, 8):
                cams.append({"t_s": round(ts[k], 2), "from_s": round(ts[i], 2), "to_s": round(ts[j], 2), "direction": names[s > 0], "strength": round(m, 3)})
        return {"moves": clean_moves(moves, self.exclude), "camera_moves": sorted(cams, key=lambda m: m["t_s"])}


def clean_moves(moves: list[dict], exclude) -> list[dict]:
    """Keep clear body moves only: drop weak ones and ones next to a covered span, and
    merge moves of the same body area at the same moment (up + right = one diagonal move)."""
    keep = [m for m in moves if m["strength"] >= MOVE_MIN and not any(a - MOVE_GUARD_S <= m["t_s"] <= b + MOVE_GUARD_S for a, b in exclude)]
    keep.sort(key=lambda m: (m["area"], m["t_s"], -m["strength"]))
    merged: list[dict] = []
    for m in keep:
        last = merged[-1] if merged else None
        if last and last["area"] == m["area"] and abs(last["t_s"] - m["t_s"]) <= 0.2:
            if m["direction"] not in last["direction"]:
                last["direction"] += f" + {m['direction']}"
            last["from_s"], last["to_s"] = min(last["from_s"], m["from_s"]), max(last["to_s"], m["to_s"])
        else:
            merged.append(dict(m))
    return sorted(merged, key=lambda m: m["t_s"])


def motion_summary(path: str, exclude) -> dict:
    """Camera moves only (no person reading) — used for tests and person-free footage."""
    mo = _Motion(exclude)
    for t, img in read_frames(path):
        mo.add(t, img)
    return mo.result()


def _persons(img, det, pose_model):
    """[(kp 17x2 fractions, scores 17, box fractions)] for every person worth counting in one frame."""
    h, w = img.shape[:2]
    boxes = [b for b in np.asarray(det(img)).reshape(-1, 4) if _box_area((b[0] / w, b[1] / h, b[2] / w, b[3] / h)) >= MIN_BOX_AREA]
    persons = []
    if boxes:
        kps, scs = pose_model(img, bboxes=[list(map(float, b)) for b in boxes])
        for kp, sc, b in zip(kps, scs, boxes):
            if int((sc >= VIS).sum()) >= MIN_JOINTS:
                persons.append((kp / np.array([w, h]), sc, (b[0] / w, b[1] / h, b[2] / w, b[3] / h)))
    return persons


def read_image(path: str) -> dict:
    """The same general body reading as a look, for one still (a generated remake frame)."""
    img = cv2.imread(path)
    if img is None:
        raise ValueError("unreadable image")
    det, pose_model = _load()
    h, w = img.shape[:2]
    persons = _persons(img, det, pose_model)
    if not persons:
        return {"model": MODEL_NAME, "people": 0, "no_person": True, "main": None}
    main = max(persons, key=lambda p: _box_area(p[2]))
    # where the main person sits in the frame (fractions), so a still's framing can be compared with the original's
    return {"model": MODEL_NAME, "people": len(persons), "no_person": False, "main": read_person(main[0], main[1], h / w, main[2]),
            "box": [round(float(v), 3) for v in main[2]]}


def measure_pose(path: str, looks: list[dict], exclude=None, fps: float = 5.0) -> dict:
    """One pass: optical flow on every frame inside the looks, people and joints at `fps`."""
    exclude = exclude or []
    det, pose_model = _load()
    mo = _Motion(exclude)
    frames, aspect, next_t = [], 1.0, 0.0
    lo, hi = (min(l["start_s"] for l in looks), max(l["end_s"] for l in looks)) if looks else (0.0, 0.0)
    for t, img in read_frames(path):
        if t < lo - 0.1:
            continue
        if t > hi:
            break
        mo.add(t, img)
        if t + 1e-9 < next_t or _excluded(t, exclude):
            continue
        next_t = t + 1.0 / fps
        h, w = img.shape[:2]
        aspect = h / w
        persons = _persons(img, det, pose_model)
        frames.append((t, persons))
        if persons:
            main = max(persons, key=lambda p: _box_area(p[2]))
            mo.set_person(main[0], main[1])
        else:
            mo.clear_person()
    return {"model": MODEL_NAME, "looks": summarise_looks(looks, frames, aspect), **mo.result()}
