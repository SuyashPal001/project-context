from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import deltalake as dl
from deltalake.writer import write_deltalake
import pandas as pd
import pyarrow as pa
import os
import json
from datetime import datetime

app = FastAPI(title="Lakehouse Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DELTA_PATH = os.environ.get("DELTA_PATH", "/data/pension_records")
LABELS_PATH = os.path.join(DELTA_PATH, "_labels.json")


def save_label(version: int, label: str, description: str = "") -> None:
    """Store human-readable label for a Delta version in a sidecar JSON file."""
    os.makedirs(DELTA_PATH, exist_ok=True)
    labels: dict = {}
    if os.path.exists(LABELS_PATH):
        with open(LABELS_PATH) as f:
            labels = json.load(f)
    labels[str(version)] = {"label": label, "description": description, "committed_at": datetime.utcnow().isoformat()}
    with open(LABELS_PATH, "w") as f:
        json.dump(labels, f)


def load_labels() -> dict:
    if os.path.exists(LABELS_PATH):
        with open(LABELS_PATH) as f:
            return json.load(f)
    return {}


class PensionRecord(BaseModel):
    pension_id: str
    pensioner_name: str
    declared_amount: float
    status: str
    office_code: str = "PB-001"
    effective_date: str


class CommitRequest(BaseModel):
    records: List[PensionRecord]
    label: str
    description: str = ""


class CorrectionRequest(BaseModel):
    pension_id: str
    new_amount: float
    label: str
    description: str = ""


@app.post("/commit")
def commit_snapshot(req: CommitRequest):
    """Write a full set of records as a new Delta version (used by P1 ingestion auto-commit)."""
    df = pd.DataFrame([r.dict() for r in req.records])
    table = pa.Table.from_pandas(df)
    write_deltalake(DELTA_PATH, table, mode="overwrite", schema_mode="overwrite")
    dt = dl.DeltaTable(DELTA_PATH)
    version = dt.version()
    save_label(version, req.label, req.description)
    return {"version": version, "label": req.label}


@app.post("/correct")
def apply_correction(req: CorrectionRequest):
    """Apply a single-record correction — creates a new Delta version (used by portal UI)."""
    try:
        dt = dl.DeltaTable(DELTA_PATH)
    except Exception:
        raise HTTPException(status_code=400, detail="No data committed yet. Ingest a document first.")

    df = dt.to_pandas()

    if req.pension_id not in df["pension_id"].values:
        raise HTTPException(status_code=404, detail=f"pension_id '{req.pension_id}' not found")

    df.loc[df["pension_id"] == req.pension_id, "declared_amount"] = req.new_amount
    df.loc[df["pension_id"] == req.pension_id, "status"] = "corrected"

    table = pa.Table.from_pandas(df)
    write_deltalake(DELTA_PATH, table, mode="overwrite", schema_mode="overwrite")

    dt = dl.DeltaTable(DELTA_PATH)
    version = dt.version()
    save_label(version, req.label, req.description)
    return {"version": version, "label": req.label}


@app.get("/snapshots")
def list_snapshots():
    """List all Delta versions with human-readable labels."""
    try:
        dt = dl.DeltaTable(DELTA_PATH)
        history = dt.history()
    except Exception:
        return {"snapshots": []}

    labels = load_labels()
    snapshots = []
    for h in history:
        v = str(h.get("version", ""))
        meta = labels.get(v, {})
        snapshots.append({
            "version": int(v) if v else 0,
            "label": meta.get("label", f"Snapshot {v}"),
            "description": meta.get("description", ""),
            "committed_at": meta.get("committed_at", ""),
            "operation": h.get("operation", "WRITE"),
        })
    snapshots.sort(key=lambda x: x["version"], reverse=True)
    return {"snapshots": snapshots}


@app.get("/records")
def get_records(version: Optional[int] = None):
    """Read pension records at a specific Delta version (or latest if omitted)."""
    try:
        dt = dl.DeltaTable(DELTA_PATH)
        if version is not None:
            dt.load_as_version(version)
        df = dt.to_pandas()
        return {"records": df.to_dict(orient="records"), "version": dt.version()}
    except Exception as e:
        return {"records": [], "version": 0, "error": str(e)}


@app.get("/health")
def health():
    return {"status": "ok"}
