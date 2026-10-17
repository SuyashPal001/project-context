import os
from pathlib import Path
from fastapi import HTTPException

def media_dir() -> Path:
    return Path(os.environ.get("MEDIA_DIR", str(Path.home() / ".project-context" / "media" / "inbound"))).resolve()

def safe_media_path(raw: str) -> Path:
    p = Path(raw).resolve()
    root = media_dir()
    if root not in p.parents or not p.is_file():
        raise HTTPException(status_code=400, detail="path must be an existing file inside the media cache")
    return p

def safe_output_path(raw: str) -> Path:
    """A file to write: inside the media cache, in a folder that exists, with an .mp4 name."""
    p = Path(raw).resolve()
    root = media_dir()
    if root not in p.parents or not p.parent.is_dir() or p.suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="out must be an .mp4 path inside the media cache")
    return p
