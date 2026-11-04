"""Classroom Intelligence — Audio Processing Service."""
from fastapi import FastAPI

app = FastAPI(
    title="CI Audio Processing Service",
    description="Audio quality analysis, segmentation, format normalization and noise profiling. Prepares audio segments for transcription and speaker diarization.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "audio-processing"}
