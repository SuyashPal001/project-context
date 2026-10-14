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
    return motion.motion_peaks(str(safe_media_path(body.path)), [i.model_dump() for i in body.items], body.exclude, body.window_s)
