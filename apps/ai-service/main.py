from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os

load_dotenv()

app = FastAPI(
    title="Sarathi AI Service",
    description="Python ML service for document ingestion and evals",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from media.router import router as media_router
app.include_router(media_router)

@app.get("/health")
async def health():
    return { "status": "ok", "service": "ai-service" }

@app.get("/ready")
async def ready():
    return { "status": "ready" }
