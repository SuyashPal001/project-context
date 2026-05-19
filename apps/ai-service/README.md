# ai-service

Python FastAPI service for ML capabilities.

## What it does
- Document ingestion (unstructured.io, PyMuPDF) — Phase 3
- Evals (Ragas faithfulness/relevancy metrics) — Phase 3

## Running locally
```bash
cd apps/ai-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 3004 --reload
```

## Deploy (GCP VM)
```bash
cd apps/ai-service
pip install -r requirements.txt
pm2 start "uvicorn main:app --port 3004" --name ai-service
```

## Health check
GET http://localhost:3004/health
