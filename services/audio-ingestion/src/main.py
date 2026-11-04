"""Classroom Intelligence — Audio Ingestion Service."""
from fastapi import FastAPI

app = FastAPI(
    title="CI Audio Ingestion Service",
    description="Receives, validates and stores raw audio uploads from classroom devices. Handles chunked uploads, integrity verification via SHA-256 checksums, and publishes events to downstream processing pipeline.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "audio-ingestion"}
