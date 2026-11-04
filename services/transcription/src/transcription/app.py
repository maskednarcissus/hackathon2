"""FastAPI application factory."""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Response, status
from pydantic import ValidationError

from transcription.models import (
    AudioSegmentRef,
    EventEnvelope,
    TranscriptionJob,
    TranscriptionRequest,
)
from transcription.service import TranscriptionService

# Literal 422: Starlette renamed the constant (UNPROCESSABLE_ENTITY → _CONTENT).
UNPROCESSABLE = 422


@dataclass
class AppDeps:
    service: TranscriptionService


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


def create_app(deps: AppDeps) -> FastAPI:
    app = FastAPI(
        title="CI Transcription Service",
        description=(
            "Converts classroom audio segments into timestamped Brazilian Portuguese "
            "transcript segments (Google Speech-to-Text v2 / Chirp 2)."
        ),
        version="0.2.0",
    )
    service = deps.service

    async def _accept(
        request: TranscriptionRequest, background: BackgroundTasks, response: Response
    ) -> dict[str, Any]:
        job, created = await service.submit(request)
        if created:
            background.add_task(service.run, job.job_id)
            response.status_code = status.HTTP_202_ACCEPTED
        else:
            response.status_code = status.HTTP_200_OK
        return {"jobId": job.job_id, "status": job.status.value, "created": created}

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "transcription"}

    @app.post("/v1/transcriptions", status_code=status.HTTP_202_ACCEPTED)
    async def create_transcription(
        request: TranscriptionRequest, background: BackgroundTasks, response: Response
    ) -> dict[str, Any]:
        return await _accept(request, background, response)

    @app.get("/v1/transcriptions/{job_id}")
    async def get_transcription(job_id: str) -> dict[str, Any]:
        job: TranscriptionJob | None = await service.get(job_id)
        if job is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
        return job.dump()

    @app.post("/v1/events/recording-segmented", status_code=status.HTTP_202_ACCEPTED)
    async def on_recording_segmented(
        body: dict[str, Any], background: BackgroundTasks, response: Response
    ) -> dict[str, Any]:
        try:
            envelope = EventEnvelope.model_validate(_unwrap_pubsub_push(body))
        except ValidationError as exc:
            raise HTTPException(UNPROCESSABLE, exc.errors()) from exc
        if envelope.type != "recording.segmented":
            # Acknowledge (2xx) so Pub/Sub does not redeliver an event we will never handle.
            response.status_code = status.HTTP_200_OK
            return {"ignored": True, "reason": f"unexpected event type {envelope.type}"}
        data = envelope.data
        try:
            request = TranscriptionRequest(
                recording_session_id=str(data["recordingSessionId"]),
                scheduled_class_id=data.get("scheduledClassId"),
                institution_id=envelope.institution_id or data.get("institutionId"),
                discipline=data.get("discipline"),
                segments=[AudioSegmentRef.model_validate(s) for s in data.get("segments", [])],
            )
        except (KeyError, ValidationError, ValueError) as exc:
            raise HTTPException(UNPROCESSABLE, str(exc)) from exc
        return await _accept(request, background, response)

    return app
