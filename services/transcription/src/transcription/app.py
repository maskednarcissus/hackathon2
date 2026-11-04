"""FastAPI application factory."""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Response, status
from pydantic import ValidationError

from transcription.fakes import InMemoryProcessedEvents
from transcription.models import (
    AudioSegmentRef,
    EventEnvelope,
    JobStatus,
    TranscriptionJob,
    TranscriptionRequest,
)
from transcription.ports import Lifecycle, ProcessedEventStore
from transcription.security import internal_token_dependency
from transcription.service import TranscriptionService

# Literal 422: Starlette renamed the constant (UNPROCESSABLE_ENTITY → _CONTENT).
UNPROCESSABLE = 422


@dataclass
class AppDeps:
    service: TranscriptionService
    processed_events: ProcessedEventStore = field(default_factory=InMemoryProcessedEvents)
    internal_token: str | None = None
    #: Opened on start-up and closed on shutdown (e.g. the Postgres pool).
    resources: list[Lifecycle] = field(default_factory=list)


def _unwrap_pubsub_push(body: dict[str, Any]) -> dict[str, Any]:
    """Accept either a raw §6 envelope or a Pub/Sub push wrapper."""
    message = body.get("message")
    if isinstance(message, dict) and "data" in message:
        try:
            decoded = base64.b64decode(str(message["data"]), validate=True)
            parsed = json.loads(decoded)
        except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"invalid push payload: {exc}"
            ) from exc
        if not isinstance(parsed, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "push payload must be an object")
        return parsed
    return body


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def request_from_segmented(envelope: EventEnvelope) -> TranscriptionRequest:
    data = envelope.data
    return TranscriptionRequest(
        recording_session_id=str(data["recordingSessionId"]),
        scheduled_class_id=data.get("scheduledClassId"),
        class_section_id=data.get("classSectionId"),
        institution_id=envelope.institution_id or data.get("institutionId"),
        classroom_id=data.get("classroomId"),
        started_at=_parse_dt(data.get("startedAt")),
        ended_at=_parse_dt(data.get("endedAt")),
        discipline=data.get("discipline"),
        segments=[AudioSegmentRef.model_validate(s) for s in data.get("segments", [])],
    )


def create_app(deps: AppDeps) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        for resource in deps.resources:
            await resource.open()
        try:
            yield
        finally:
            for resource in reversed(deps.resources):
                await resource.close()

    app = FastAPI(
        title="CI Transcription Service",
        description=(
            "Converts classroom audio segments into timestamped Brazilian Portuguese "
            "transcript segments (Google Speech-to-Text v2 / Chirp 2)."
        ),
        version="0.3.0",
        lifespan=lifespan,
    )
    service = deps.service
    processed = deps.processed_events
    require_internal = internal_token_dependency(deps.internal_token)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "transcription"}

    @app.post("/v1/transcriptions", status_code=status.HTTP_202_ACCEPTED)
    async def create_transcription(
        request: TranscriptionRequest, background: BackgroundTasks, response: Response
    ) -> dict[str, Any]:
        job, created = await service.submit(request)
        if created:
            background.add_task(service.run, job.job_id)
        else:
            response.status_code = status.HTTP_200_OK
        return {"jobId": job.job_id, "status": job.status.value, "created": created}

    @app.get("/v1/transcriptions/{job_id}")
    async def get_transcription(job_id: str) -> dict[str, Any]:
        job: TranscriptionJob | None = await service.get(job_id)
        if job is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
        return job.dump()

    @app.post(
        "/v1/events/recording-segmented",
        dependencies=[Depends(require_internal)],
    )
    async def on_recording_segmented(body: dict[str, Any], response: Response) -> dict[str, Any]:
        """Push subscriber: idempotent by ``eventId``; returns 2xx only after processing."""
        try:
            envelope = EventEnvelope.model_validate(_unwrap_pubsub_push(body))
        except ValidationError as exc:
            raise HTTPException(
                UNPROCESSABLE, exc.errors(include_context=False, include_url=False)
            ) from exc
        if await processed.is_processed(envelope.event_id):
            return {"duplicate": True, "eventId": envelope.event_id}
        if envelope.type != "recording.segmented":
            # Acknowledge (2xx) so the bus does not redeliver an event we will never handle.
            await processed.mark_processed(envelope.event_id)
            return {"ignored": True, "reason": f"unexpected event type {envelope.type}"}
        try:
            request = request_from_segmented(envelope)
        except (KeyError, ValidationError, ValueError) as exc:
            raise HTTPException(UNPROCESSABLE, str(exc)) from exc

        job, created = await service.submit(request)
        if job.status is JobStatus.QUEUED:
            job = await service.run(job.job_id)
        if job.status is JobStatus.RUNNING:
            # Another delivery is processing this recording: ask the bus to retry later
            # rather than acknowledging work that has not finished.
            raise HTTPException(status.HTTP_409_CONFLICT, f"job {job.job_id} in progress")
        await processed.mark_processed(envelope.event_id)
        response.status_code = status.HTTP_200_OK
        return {
            "jobId": job.job_id,
            "status": job.status.value,
            "created": created,
            "transcriptId": job.transcript_id,
        }

    return app
