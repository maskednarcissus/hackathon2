"""Classroom Intelligence — Event Extraction Service."""

from fastapi import FastAPI

app = FastAPI(
    title="CI Event Extraction Service",
    description="Extracts academic events (exams, deadlines, class changes) from transcripts using LLMs with structured output. Performs date resolution, confidence scoring, and deduplication.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "event-extraction"}
