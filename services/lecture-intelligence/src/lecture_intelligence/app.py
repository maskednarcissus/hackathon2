"""FastAPI application factory for lecture intelligence."""

from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import structlog
from fastapi import BackgroundTasks, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from lecture_intelligence.actor import Actor, ActorResolver, JwksVerifier
from lecture_intelligence.assistant import Assistant, AssistantSettings
from lecture_intelligence.assistant_store import AssistantRepository, InMemoryAssistantRepository
from lecture_intelligence.catalog import SORT_PATTERN, list_lectures, resolve_class_metadata
from lecture_intelligence.clients import (
    AcademicClient,
    AuditClient,
    EventPublisher,
    GatewayClient,
    HttpAcademicClient,
    HttpAuditClient,
    HttpEventBusPublisher,
    HttpGatewayClient,
    HttpSearchClient,
    HttpTranscriptClient,
    InMemoryAuditClient,
    InMemoryEventPublisher,
    SearchClient,
    TranscriptClient,
    TranscriptNotFoundError,
)
from lecture_intelligence.governance import (
    DsrRequest,
    DsrType,
    RetentionDeleteRequest,
    handle_dsr,
    retention_candidates,
    retention_delete,
)
from lecture_intelligence.models import AskRequest, FeedbackRequest, StructureRequest
from lecture_intelligence.pipeline import LectureStructurer, PipelineError, PipelineSettings
from lecture_intelligence.repository import (
    EventInbox,
    InMemoryEventInbox,
    InMemoryLectureRepository,
    LectureRepository,
)
from lecture_intelligence.security import install_internal_token

log = structlog.get_logger(__name__)
UUID_RE = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


@dataclass
class LectureDeps:
    gateway: GatewayClient
    transcripts: TranscriptClient
    repository: LectureRepository = field(default_factory=InMemoryLectureRepository)
    publisher: EventPublisher = field(default_factory=InMemoryEventPublisher)
    audit: AuditClient = field(default_factory=InMemoryAuditClient)
    settings: PipelineSettings = field(default_factory=PipelineSettings)
    search: SearchClient | None = None
    academic: AcademicClient | None = None
    assistant_repository: AssistantRepository = field(default_factory=InMemoryAssistantRepository)
    assistant_settings: AssistantSettings = field(default_factory=AssistantSettings)
    inbox: EventInbox = field(default_factory=InMemoryEventInbox)
    actors: ActorResolver = field(default_factory=lambda: ActorResolver(None))
    internal_token: str | None = None
    pool: Any = None  # psycopg_pool.AsyncConnectionPool when DATABASE_URL is set


def deps_from_env() -> LectureDeps:
    audit_url = os.environ.get("AUDIT_SERVICE_URL")
    token = os.environ.get("INTERNAL_API_TOKEN") or None
    publisher: EventPublisher = InMemoryEventPublisher()
    if bus_url := os.environ.get("EVENT_BUS_URL"):
        publisher = HttpEventBusPublisher(bus_url, token)
    elif project := os.environ.get("PUBSUB_PROJECT_ID"):
        from lecture_intelligence.clients import PubSubEventPublisher

        publisher = PubSubEventPublisher(project)
    transcript_url = os.environ.get("TRANSCRIPT_MANAGEMENT_URL", "http://localhost:4008")
    assistant_settings = AssistantSettings()
    storage: dict[str, Any] = {}
    if database_url := os.environ.get("DATABASE_URL"):
        from lecture_intelligence.adapters.postgres import (
            PostgresAssistantRepository,
            PostgresEventInbox,
            PostgresLectureRepository,
            create_pool,
        )

        pool = create_pool(database_url)
        storage = {
            "pool": pool,
            "repository": PostgresLectureRepository(pool),
            "assistant_repository": PostgresAssistantRepository(
                pool, assistant_settings.memory_turns
            ),
            "inbox": PostgresEventInbox(pool, "lecture-intelligence"),
        }
    jwks_url = os.environ.get("IDENTITY_JWKS_URL")
    return LectureDeps(
        **storage,
        assistant_settings=assistant_settings,
        internal_token=token,
        actors=ActorResolver(
            JwksVerifier(jwks_url) if jwks_url else None, allow_unverified=not jwks_url
        ),
        gateway=HttpGatewayClient(os.environ.get("AI_GATEWAY_URL", "http://localhost:8005")),
        transcripts=HttpTranscriptClient(transcript_url),
        search=HttpSearchClient(transcript_url),
        academic=HttpAcademicClient(
            os.environ.get("ACADEMIC_INTEGRATION_URL", "http://localhost:4003")
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


def _decode_event(body: Any) -> tuple[dict[str, Any], str | None]:
    """Accept a raw envelope or Pub/Sub push ``{"message": {"data": b64, "messageId"}}``.

    Returns the envelope and its idempotency key (``eventId``, else the Pub/Sub ``messageId``).
    """

    message_id: str | None = None
    if isinstance(body, dict) and isinstance(body.get("message"), dict):
        message_id = body["message"].get("messageId") or body["message"].get("message_id")
        try:
            decoded = json.loads(base64.b64decode(body["message"].get("data", "")))
        except (binascii.Error, json.JSONDecodeError, TypeError) as exc:
            raise PipelineError("invalid_event", "Pub/Sub message data is not JSON", 400) from exc
        body = decoded
    if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
        raise PipelineError("invalid_event", "Event envelope with a data object is required", 400)
    key = body.get("eventId") or message_id
    return body, str(key) if key else None


def create_app(deps: LectureDeps | None = None) -> FastAPI:
    deps = deps or deps_from_env()
    structurer = LectureStructurer(
        gateway=deps.gateway,
        repository=deps.repository,
        publisher=deps.publisher,
        audit=deps.audit,
        settings=deps.settings,
    )
    assistant = (
        Assistant(
            gateway=deps.gateway,
            search=deps.search,
            lectures=deps.repository,
            repository=deps.assistant_repository,
            settings=deps.assistant_settings,
        )
        if deps.search is not None
        else None
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if deps.pool is None:
            yield
            return
        await deps.pool.open(wait=True)
        try:
            yield
        finally:
            await deps.pool.close()

    async def engagement(
        actor: Actor | None, action: str, tenant: str | None, resource: tuple[str, str], meta: Any
    ) -> None:
        if actor is None or actor.role != "student":
            return
        await deps.audit.record(
            {
                "tenantId": tenant or actor.institution_id,
                "actorId": actor.actor_id,
                "actorType": "student",
                "action": action,
                "resourceType": resource[0],
                "resourceId": resource[1],
                "metadata": meta,
            }
        )

    app = FastAPI(
        lifespan=lifespan,
        title="CI Lecture Intelligence Service",
        description=(
            "Turns transcripts into grounded lecture materials: title, executive summary, topic "
            "outline, key concepts, Q&A and reading references, each citing transcript segments."
        ),
        version="0.2.0",
    )

    install_internal_token(
        app,
        deps.internal_token,
        lambda path: path.startswith("/internal/") or path.startswith("/v1/events/"),
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

    @app.get("/v1/lectures")
    async def list_lecture_library(
        class_section_ids: str | None = Query(default=None, alias="classSectionIds"),
        q: str | None = Query(default=None, max_length=200),
        course_id: str | None = Query(default=None, alias="courseId"),
        start: str | None = Query(default=None, alias="from", max_length=40),
        end: str | None = Query(default=None, alias="to", max_length=40),
        sort: str = Query(default="recent", pattern=SORT_PATTERN),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100, alias="pageSize"),
    ) -> dict[str, Any]:
        sections = {s.strip() for s in (class_section_ids or "").split(",") if s.strip()}
        if not sections:
            raise PipelineError(
                "validation_error", "classSectionIds is required (comma-separated)", 400
            )
        return list_lectures(
            await deps.repository.latest_for_sections(sections),
            query=q,
            course_id=course_id,
            start=start,
            end=end,
            sort=sort,
            page=page,
            page_size=page_size,
        )

    @app.get("/v1/lectures/{scheduled_class_id}")
    async def get_lecture(
        scheduled_class_id: str, request: Request, background: BackgroundTasks
    ) -> JSONResponse:
        found = await deps.repository.latest_for_class(scheduled_class_id)
        if found is None:
            return _error("not_found", "No lecture structure for this scheduled class", 404)
        actor = await deps.actors.resolve(request)
        background.add_task(
            engagement,
            actor,
            "lecture.viewed",
            found.institution_id,
            ("lecture_summary", found.lecture_summary_id),
            {"classSectionId": found.class_section_id, "scheduledClassId": scheduled_class_id},
        )
        return JSONResponse(found.to_json(), background=background)

    @app.post("/v1/assistant/ask")
    async def ask(body: AskRequest, request: Request) -> JSONResponse:
        if assistant is None:
            raise PipelineError("assistant_unavailable", "Search is not configured", 503)
        actor = await deps.actors.resolve(request)
        if (
            actor is not None
            and actor.verified
            and actor.role == "student"
            and actor.actor_id != body.student_id
        ):
            raise PipelineError("forbidden", "studentId does not match the caller", 403)
        result = await assistant.ask(body)
        background = BackgroundTasks()
        background.add_task(
            engagement,
            actor or Actor(actor_id=body.student_id, role="student"),
            "lecture.assistant_question",
            body.institution_id,
            ("assistant_answer", result.answer_id),
            {
                "classSectionId": result.primary_class_section_id,
                "classSectionIds": body.class_section_ids,
                "scheduledClassId": body.scheduled_class_id,
                "conversationId": result.conversation_id,
                "grounded": result.grounded,
                "refusal": result.refusal,
            },
        )
        return JSONResponse(result.to_json(), background=background)

    @app.post("/v1/assistant/feedback", status_code=201)
    async def feedback(body: FeedbackRequest) -> dict[str, Any]:
        if assistant is None:
            raise PipelineError("assistant_unavailable", "Search is not configured", 503)
        return await assistant.feedback(body)

    # ---------------------------------------------------------------- governance (internal)
    @app.get("/internal/v1/retention/candidates")
    async def retention_candidates_route(
        institution_id: str = Query(alias="institutionId", pattern=UUID_RE),
        older_than: str = Query(alias="olderThan", max_length=40),
        kind: str = Query(default="summary"),
    ) -> dict[str, Any]:
        return await retention_candidates(deps.repository, institution_id, older_than, kind)

    @app.post("/internal/v1/retention/delete")
    async def retention_delete_route(body: RetentionDeleteRequest) -> dict[str, Any]:
        return await retention_delete(deps.repository, body)

    @app.post("/internal/v1/dsr/{dsr_type}")
    async def dsr_route(dsr_type: DsrType, body: DsrRequest) -> dict[str, Any]:
        return await handle_dsr(deps.assistant_repository, dsr_type, body)

    async def handle_transcript_event(request: Request) -> JSONResponse:
        try:
            raw = await request.json()
        except json.JSONDecodeError:
            return _error("invalid_event", "Body must be JSON", 400)
        event, event_id = _decode_event(raw)
        if event_id and await deps.inbox.seen(event_id):
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
        meta = await resolve_class_metadata(deps.academic, scheduled_class_id, transcript)
        try:
            req = StructureRequest(
                transcript_id=transcript_id,
                scheduled_class_id=scheduled_class_id,
                institution_id=institution_id,
                **meta,
                language=transcript.get("language", "pt-BR"),
                segments=segments,
            )
        except ValidationError as exc:
            return _error(
                "invalid_transcript", "Transcript cannot be structured", 422, {"errors": str(exc)}
            )
        result = await structurer.structure(req)
        if event_id:
            await deps.inbox.mark(event_id, str(event.get("type", "")))
        return JSONResponse(
            {"status": "processed", "lectureSummaryId": result.lecture_summary_id}, 202
        )

    app.add_api_route("/v1/events/diarization-completed", handle_transcript_event, methods=["POST"])
    app.add_api_route("/v1/events/transcript-created", handle_transcript_event, methods=["POST"])
    return app
