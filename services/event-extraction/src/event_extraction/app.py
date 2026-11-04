"""FastAPI application factory."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .models import (
    ActionBody,
    EditBody,
    ExtractedEvent,
    ExtractionRequest,
    ExtractionResult,
    LifecycleEnvelope,
    RejectBody,
)
from .ports import NotFoundError, UpstreamError
from .service import Actor, ActorRole, Dependencies, EventExtractionService, ServiceError

_ROLES: set[str] = {"professor", "admin", "coordinator"}
_TRANSCRIPT_EVENTS = {"transcript.created", "diarization.completed", "transcript.corrected"}


def _error(status: int, code: str, message: str, details: Any = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(status_code=status, content=body)


def _actor(actor_id: str | None, role: str | None, body_actor: str | None) -> Actor:
    if not actor_id or not role:
        raise ServiceError(401, "unauthenticated", "X-Actor-Id and X-Actor-Role headers required")
    if role not in _ROLES:
        raise ServiceError(403, "forbidden", f"role {role!r} cannot review events")
    if body_actor and body_actor != actor_id:
        raise ServiceError(403, "forbidden", "actorId does not match the authenticated actor")
    actor_role: ActorRole = role  # type: ignore[assignment]
    return Actor(actor_id, actor_role)


ActorId = Annotated[str | None, Header(alias="X-Actor-Id")]
ActorRoleHeader = Annotated[str | None, Header(alias="X-Actor-Role")]


def create_app(deps: Dependencies) -> FastAPI:
    service = EventExtractionService(deps)
    app = FastAPI(
        title="CI Event Extraction Service",
        description=(
            "Extracts academic events (exams, deadlines, class changes) from transcripts, "
            "resolves pt-BR dates deterministically, scores confidence, deduplicates, checks "
            "calendar conflicts and runs the professor review / publication workflow."
        ),
        version="0.2.0",
    )
    app.state.service = service

    @app.exception_handler(ServiceError)
    async def _service_error(_req: Request, exc: ServiceError) -> JSONResponse:
        return _error(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(NotFoundError)
    async def _not_found(_req: Request, exc: NotFoundError) -> JSONResponse:
        return _error(404, "not_found", f"{exc} not found")

    @app.exception_handler(UpstreamError)
    async def _upstream(_req: Request, exc: UpstreamError) -> JSONResponse:
        return _error(502, "upstream_error", str(exc))

    @app.exception_handler(RequestValidationError)
    async def _invalid(_req: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"path": ".".join(str(p) for p in e.get("loc", ())), "message": e.get("msg")}
            for e in exc.errors()
        ]
        return _error(400, "validation_error", "invalid request", details)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "event-extraction"}

    @app.post("/v1/extractions", response_model=ExtractionResult, status_code=201)
    async def extract(body: ExtractionRequest) -> ExtractionResult:
        return await service.extract(body)

    @app.post("/v1/events/transcript-ready", status_code=202)
    async def transcript_ready(envelope: LifecycleEnvelope) -> dict[str, Any]:
        if envelope.type not in _TRANSCRIPT_EVENTS:
            return {"status": "ignored", "reason": f"unsupported event type {envelope.type}"}
        transcript_id = envelope.data.get("transcriptId")
        transcript = None
        if not isinstance(transcript_id, str):
            raise ServiceError(400, "validation_error", "data.transcriptId is required")
        scheduled_class_id = envelope.data.get("scheduledClassId")
        if not isinstance(scheduled_class_id, str):
            transcript = await deps.transcripts.get_transcript(transcript_id)
            scheduled_class_id = transcript.scheduled_class_id
        if not scheduled_class_id:
            return {"status": "ignored", "reason": "transcript has no scheduled class"}
        result = await service.extract(
            ExtractionRequest(
                transcript_id=transcript_id,
                scheduled_class_id=scheduled_class_id,
                segments=transcript.segments if transcript else None,
                recording_session_id=transcript.recording_session_id if transcript else None,
            )
        )
        return {
            "status": "processed",
            "eventIds": [e.id for e in result.events],
            "awaitingReview": result.awaiting_review,
        }

    @app.get("/v1/review-queue", response_model=list[ExtractedEvent])
    async def review_queue(
        professor_id: Annotated[str | None, Query(alias="professorId")] = None,
        status: Annotated[str, Query()] = "awaiting_professor,awaiting_admin",
        class_section_id: Annotated[str | None, Query(alias="classSectionId")] = None,
    ) -> list[ExtractedEvent]:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        return await service.review_queue(professor_id, statuses, class_section_id)

    @app.get("/v1/events/{event_id}", response_model=ExtractedEvent)
    async def get_event(event_id: str) -> ExtractedEvent:
        return await service.get(event_id)

    @app.post("/v1/events/{event_id}/confirm", response_model=ExtractedEvent)
    async def confirm(
        event_id: str,
        x_actor_id: ActorId = None,
        x_actor_role: ActorRoleHeader = None,
        body: ActionBody | None = None,
    ) -> ExtractedEvent:
        body = body or ActionBody()
        actor = _actor(x_actor_id, x_actor_role, body.actor_id)
        return await service.confirm(event_id, actor, body.notes)

    @app.post("/v1/events/{event_id}/edit", response_model=ExtractedEvent)
    async def edit(
        event_id: str,
        body: EditBody,
        x_actor_id: ActorId = None,
        x_actor_role: ActorRoleHeader = None,
    ) -> ExtractedEvent:
        actor = _actor(x_actor_id, x_actor_role, body.actor_id)
        return await service.edit(event_id, actor, body.changes, body.reason)

    @app.post("/v1/events/{event_id}/reject", response_model=ExtractedEvent)
    async def reject(
        event_id: str,
        body: RejectBody,
        x_actor_id: ActorId = None,
        x_actor_role: ActorRoleHeader = None,
    ) -> ExtractedEvent:
        actor = _actor(x_actor_id, x_actor_role, body.actor_id)
        return await service.reject(event_id, actor, body.reason)

    @app.post("/v1/events/{event_id}/publish", response_model=ExtractedEvent)
    async def publish(
        event_id: str,
        x_actor_id: ActorId = None,
        x_actor_role: ActorRoleHeader = None,
        body: ActionBody | None = None,
    ) -> ExtractedEvent:
        body = body or ActionBody()
        actor = _actor(x_actor_id, x_actor_role, body.actor_id)
        return await service.publish(event_id, actor)

    return app
