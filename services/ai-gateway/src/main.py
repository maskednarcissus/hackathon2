"""Classroom Intelligence — AI Gateway Service."""
from fastapi import FastAPI

app = FastAPI(
    title="CI AI Gateway Service",
    description="Centralized LLM gateway providing provider selection, model versioning, token and cost tracking, rate limiting, retries and prompt management for all AI-consuming services.",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Service health check."""
    return {"status": "ok", "service": "ai-gateway"}
