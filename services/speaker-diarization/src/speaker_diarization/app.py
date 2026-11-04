"""FastAPI application factory."""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, status
from pydantic import ValidationError

from speaker_diarization.adapters.memory import InMemoryProcessedEvents
from speaker_diarization.ids import is_uuid
from speaker_diarization.models import (
    AudioSegmentRef,
    AudioSource,
    DiarizationRequest,
    EventEnvelope,
)
from speaker_diarization.ports import Lifecycle, ProcessedEventStore
from speaker_diarization.security import internal_token_dependency
from speaker_diarization.service import DiarizationError, DiarizationService

# Literal 422: Starlette renamed the constant (UNPROCESSABLE_ENTITY → _CONTENT).
UNPROCESSABLE = 422


@dataclass
class AppDeps:
    service: DiarizationService
    processed_events: ProcessedEventStore = field(default_factory=InMemoryProcessedEvents)
    internal_token: str | None = None
    resources: list[Lifecycle] = field(default_factory=list)


def _unwrap_pubsub_push(body: dict[str, Any]) -> dict[str, Any]:
    message = body.get("message")
    if isinstance(message, dict) and "data" in message:
        try:
            parsed = json.loads(base64.b64decode(str(message["data"]), validate=True))
        except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"invalid push payload: {exc}"
            ) from exc
        if not isinstance(parsed, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "push payload must be an object")
        return parsed
    return body


def _errors(exc: ValidationError) -> Any:
    return exc.errors(include_context=False, include_url=False)


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
        title="CI Speaker Diarization Service",
        description=(
            "Assigns anonymous speaker labels (SPEAKER_n) to transcript segments. "
            "Never infers real-world identity."
        ),
        version="0.3.0",
        lifespan=lifespan,
    )
    service = deps.service
    processed = deps.processed_events
    require_internal = internal_token_dependency(deps.internal_token)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "speaker-diarization"}

    @app.post("/v1/diarizations")
    async def create_diarization(request: DiarizationRequest) -> dict[str, Any]:
        try:
            result = await service.diarize(request)
        except DiarizationError as exc:
            raise HTTPException(UNPROCESSABLE, str(exc)) from exc
        return result.dump()

    @app.get("/v1/diarizations/{transcript_id}/turns")
    async def get_turns(transcript_id: str) -> dict[str, Any]:
        turns = await service.turns(transcript_id)
        return {"transcriptId": transcript_id, "turns": [t.dump() for t in turns]}

    @app.post(
        "/v1/events/transcription-completed",
        dependencies=[Depends(require_internal)],
    )
    async def on_transcription_completed(body: dict[str, Any]) -> dict[str, Any]:
        """Push subscriber: idempotent by ``eventId``; 2xx only after processing."""
        try:
            envelope = EventEnvelope.model_validate(_unwrap_pubsub_push(body))
        except ValidationError as exc:
            raise HTTPException(UNPROCESSABLE, _errors(exc)) from exc
        if await processed.is_processed(envelope.event_id):
            return {"duplicate": True, "eventId": envelope.event_id}
        if envelope.type != "transcription.completed":
            await processed.mark_processed(envelope.event_id)
            return {"ignored": True, "reason": f"unexpected event type {envelope.type}"}
        data = envelope.data
        transcript_id = data.get("transcriptId")
        if not transcript_id or not is_uuid(str(transcript_id)):
            raise HTTPException(UNPROCESSABLE, "data.transcriptId must be a UUID")
        recording_id = data.get("recordingSessionId")
        if recording_id is not None and not is_uuid(str(recording_id)):
            raise HTTPException(UNPROCESSABLE, "data.recordingSessionId must be a UUID")
        audio: AudioSource | None = None
        try:
            if data.get("audioSegments"):
                audio = AudioSource(
                    segments=[AudioSegmentRef.model_validate(s) for s in data["audioSegments"]]
                )
            elif data.get("storageUri"):
                audio = AudioSource(storage_uri=str(data["storageUri"]))
        except ValidationError as exc:
            raise HTTPException(UNPROCESSABLE, _errors(exc)) from exc
        try:
            result = await service.diarize_transcription(
                transcript_id=str(transcript_id),
                recording_session_id=recording_id,
                institution_id=envelope.institution_id,
                audio=audio,
            )
        except DiarizationError as exc:
            # Non-retryable (bad/no audio): acknowledge so the bus does not loop forever;
            # the failure is audited (``diarization.failed``) for the alerting rules.
            await processed.mark_processed(envelope.event_id)
            return {"failed": True, "reason": str(exc)}
        await processed.mark_processed(envelope.event_id)
        return {"transcriptId": result.transcript_id, "speakerCount": result.speaker_count}

    return app
