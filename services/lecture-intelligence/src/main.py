"""Classroom Intelligence — Lecture Intelligence Service."""

from fastapi import FastAPI

app = FastAPI(
    title="CI Lecture Intelligence Service",
    description="Generates structured lecture summaries, topic outlines, key definitions and Q&A pairs from transcripts using LLMs. Produces student-facing academic content.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "lecture-intelligence"}
