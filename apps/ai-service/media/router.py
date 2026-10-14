from fastapi import APIRouter, Depends
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
