"""Classroom Intelligence — Speaker Diarization Service."""
from fastapi import FastAPI

app = FastAPI(
    title="CI Speaker Diarization Service",
    description="Speaker separation and labeling across recording sessions. Identifies professor and student voices, tracks speaker turns, and assigns speaker labels to transcript segments.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "speaker-diarization"}
