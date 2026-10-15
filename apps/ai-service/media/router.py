from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from .auth import require_internal_key
from .paths import safe_media_path
from . import sound

router = APIRouter(prefix="/media", dependencies=[Depends(require_internal_key)])

class PathBody(BaseModel):
    path: str

@router.post("/sound")
def post_sound(body: PathBody):
    return sound.sound_timeline(str(safe_media_path(body.path)))
from . import cuts

class CutsBody(PathBody):
    threshold: float = 0.5

@router.post("/cuts")
def post_cuts(body: CutsBody):
    return cuts.find_cuts(str(safe_media_path(body.path)), body.threshold)
from typing import Optional
from . import hidden_cuts

class Look(BaseModel):
    label: str
    approx_start_s: float
    approx_end_s: float

class HiddenBody(PathBody):
    looks: list[Look]
    subject_box: Optional[list[float]] = None

@router.post("/hidden-cuts")
def post_hidden(body: HiddenBody):
    return hidden_cuts.find_hidden_cuts(str(safe_media_path(body.path)), [l.model_dump() for l in body.looks], body.subject_box)
from . import motion

class MotionItem(BaseModel):
    id: str
    t_s: float
    box: list[float]

class MotionBody(PathBody):
    items: list[MotionItem]
    exclude: list[list[float]] = []
    window_s: float = 1.5

@router.post("/motion-peaks")
def post_motion(body: MotionBody):
    for it in body.items:
        if len(it.box) != 4:
            raise HTTPException(status_code=400, detail="box must have 4 numbers")
    for span in body.exclude:
        if len(span) != 2 or span[0] > span[1]:
            raise HTTPException(status_code=400, detail="each exclude entry must be [from_s, to_s] with from_s <= to_s")
    return motion.motion_peaks(str(safe_media_path(body.path)), [i.model_dump() for i in body.items], body.exclude, body.window_s)
from . import frame_stats

class JumpsBody(PathBody):
    threshold: float = 3.0

class CoverageBody(PathBody):
    hsv_lo: list[int]
    hsv_hi: list[int]
    step_s: float = 0.2

@router.post("/brightness-jumps")
def post_jumps(body: JumpsBody):
    return frame_stats.brightness_jumps(str(safe_media_path(body.path)), body.threshold)

@router.post("/coverage")
def post_coverage(body: CoverageBody):
    if len(body.hsv_lo) != 3 or len(body.hsv_hi) != 3:
        raise HTTPException(status_code=400, detail="hsv_lo and hsv_hi need 3 numbers")
    # OpenCV HSV: hue 0-179, saturation and value 0-255
    if any(not (0 <= v <= m) for v, m in zip(body.hsv_lo + body.hsv_hi, [179, 255, 255] * 2)):
        raise HTTPException(status_code=400, detail="HSV values must be hue 0-179, saturation/value 0-255")
    if body.step_s <= 0:
        raise HTTPException(status_code=400, detail="step_s must be above 0")
    return frame_stats.coverage(str(safe_media_path(body.path)), body.hsv_lo, body.hsv_hi, body.step_s)
from . import pose

class PoseLook(BaseModel):
    label: str
    start_s: float
    end_s: float

class PoseBody(PathBody):
    looks: list[PoseLook]
    exclude: list[list[float]] = []
    fps: float = 5.0

@router.post("/pose")
def post_pose(body: PoseBody):
    for lk in body.looks:
        if lk.end_s <= lk.start_s:
            raise HTTPException(status_code=400, detail="each look needs end_s after start_s")
    for span in body.exclude:
        if len(span) != 2 or span[0] > span[1]:
            raise HTTPException(status_code=400, detail="each exclude entry must be [from_s, to_s] with from_s <= to_s")
    if not 0 < body.fps <= 30:
        raise HTTPException(status_code=400, detail="fps must be above 0 and at most 30")
    return pose.measure_pose(str(safe_media_path(body.path)), [l.model_dump() for l in body.looks], body.exclude, body.fps)
