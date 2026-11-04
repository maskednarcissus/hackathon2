"""Classroom Intelligence — Transcription Service."""
from fastapi import FastAPI

app = FastAPI(
    title="CI Transcription Service",
    description="Converts classroom audio recordings into timestamped, structured transcript segments. Supports Brazilian Portuguese with academic vocabulary adaptation.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "transcription"}
