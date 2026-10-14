import os
from fastapi import Header, HTTPException

def require_internal_key(x_internal_service_key: str | None = Header(default=None)):
    expected = os.environ.get("INTERNAL_SERVICE_KEY")
    if not expected or x_internal_service_key != expected:
        raise HTTPException(status_code=401, detail="unauthorized")
