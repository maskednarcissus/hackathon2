"""FastAPI application factory for lecture intelligence."""

from __future__ import annotations

import base64
import binascii
import json
import os
from dataclasses import dataclass, field
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from lecture_intelligence.clients import (
    AuditClient,
    EventPublisher,
    GatewayClient,
    HttpAuditClient,
    HttpGatewayClient,
    HttpTranscriptClient,
    InMemoryAuditClient,
    InMemoryEventPublisher,
    TranscriptClient,
    TranscriptNotFoundError,
)
from lecture_intelligence.models import StructureRequest
from lecture_intelligence.pipeline import LectureStructurer, PipelineError, PipelineSettings
from lecture_intelligence.repository import InMemoryLectureRepository, LectureRepository

log = structlog.get_logger(__name__)


@dataclass
class LectureDeps:
    gateway: GatewayClient
    transcripts: TranscriptClient
    repository: LectureRepository = field(default_factory=InMemoryLectureRepository)
    publisher: EventPublisher = field(default_factory=InMemoryEventPublisher)
    audit: AuditClient = field(default_factory=InMemoryAuditClient)
    settings: PipelineSettings = field(default_factory=PipelineSettings)


def deps_from_env() -> LectureDeps:
    audit_url = os.environ.get("AUDIT_SERVICE_URL")
    publisher: EventPublisher = InMemoryEventPublisher()
    if project := os.environ.get("PUBSUB_PROJECT_ID"):
        from lecture_intelligence.clients import PubSubEventPublisher

        publisher = PubSubEventPublisher(project)
    return LectureDeps(
        gateway=HttpGatewayClient(os.environ.get("AI_GATEWAY_URL", "http://localhost:8005")),
        transcripts=HttpTranscriptClient(
            os.environ.get("TRANSCRIPT_MANAGEMENT_URL", "http://localhost:4008")
        ),
        publisher=publisher,
        audit=HttpAuditClient(audit_url) if audit_url else InMemoryAuditClient(),
        settings=PipelineSettings(
            max_chunk_tokens=int(os.environ.get("LECTURE_MAX_CHUNK_TOKENS", "12000"))
        ),
    )


def _error(code: str, message: str, status: int, details: Any = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if details:
        body["details"] = details
    return JSONResponse({"error": body}, status_code=status)


def _decode_event(body: Any) -> dict[str, Any]:
    """Accept a raw event envelope or a Pub/Sub push wrapper ``{"message": {"data": b64}}``."""

    if isinstance(body, dict) and isinstance(body.get("message"), dict):
        try:
            decoded = json.loads(base64.b64decode(body["message"].get("data", "")))
        except (binascii.Error, json.JSONDecodeError, TypeError) as exc:
            raise PipelineError("invalid_event", "Pub/Sub message data is not JSON", 400) from exc
        body = decoded
    if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
        raise PipelineError("invalid_event", "Event envelope with a data object is required", 400)
    return body


def create_app(deps: LectureDeps | None = None) -> FastAPI:
    deps = deps or deps_from_env()
    structurer = LectureStructurer(
        gateway=deps.gateway,
        repository=deps.repository,
        publisher=deps.publisher,
        audit=deps.audit,
        settings=deps.settings,
    )
    processed_events: set[str] = set()
    app = FastAPI(
        title="CI Lecture Intelligence Service",
        description=(
            "Turns transcripts into grounded lecture materials: title, executive summary, topic "
            "outline, key concepts, Q&A and reading references, each citing transcript segments."
        ),
        version="0.2.0",
    )

    @app.exception_handler(PipelineError)
    async def _pipeline_error(_: Request, exc: PipelineError) -> JSONResponse:
        return _error(exc.code, exc.message, exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        issues = [
            {"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in exc.errors()
        ]
        return _error("validation_error", "Request validation failed", 400, {"issues": issues})

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "lecture-intelligence"}

    @app.post("/v1/lectures/structure", status_code=201)
    async def structure(body: StructureRequest) -> dict[str, Any]:
        return (await structurer.structure(body)).to_json()

    @app.get("/v1/lectures/{scheduled_class_id}")
    async def get_lecture(scheduled_class_id: str) -> JSONResponse:
        found = deps.repository.latest_for_class(scheduled_class_id)
        if found is None:
            return _error("not_found", "No lecture structure for this scheduled class", 404)
        return JSONResponse(found.to_json())

    async def handle_transcript_event(request: Request) -> JSONResponse:
        try:
            raw = await request.json()
        except json.JSONDecodeError:
            return _error("invalid_event", "Body must be JSON", 400)
        event = _decode_event(raw)
        event_id = str(event.get("eventId", ""))
        if event_id and event_id in processed_events:
            return JSONResponse({"status": "duplicate"}, status_code=200)
        transcript_id = event["data"].get("transcriptId")
        if not isinstance(transcript_id, str):
            return _error("invalid_event", "data.transcriptId is required", 400)
        try:
            transcript = await deps.transcripts.get_transcript(transcript_id)
            segments = await deps.transcripts.get_segments(transcript_id)
        except TranscriptNotFoundError:
            return _error("not_found", f"Transcript {transcript_id} not found", 404)
        scheduled_class_id = transcript.get("scheduledClassId")
        institution_id = event.get("institutionId") or transcript.get("institutionId")
        if not scheduled_class_id or not segments:
            log.info("lecture_skipped", transcript_id=transcript_id, reason="no class or segments")
            return JSONResponse({"status": "skipped", "reason": "unassociated_or_empty"}, 202)
        try:
            req = StructureRequest(
                transcript_id=transcript_id,
                scheduled_class_id=scheduled_class_id,
                institution_id=institution_id,
                course_name=transcript.get("courseName"),
                class_date=transcript.get("classDate"),
                language=transcript.get("language", "pt-BR"),
                segments=segments,
            )
        except ValidationError as exc:
            return _error(
                "invalid_transcript", "Transcript cannot be structured", 422, {"errors": str(exc)}
            )
        result = await structurer.structure(req)
        if event_id:
            processed_events.add(event_id)
        return JSONResponse(
            {"status": "processed", "lectureSummaryId": result.lecture_summary_id}, 202
        )

    app.add_api_route("/v1/events/diarization-completed", handle_transcript_event, methods=["POST"])
    app.add_api_route("/v1/events/transcript-created", handle_transcript_event, methods=["POST"])
    return app
