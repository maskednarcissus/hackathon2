"""FastAPI application factory."""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException, Response, status
from pydantic import ValidationError

from speaker_diarization.models import (
    AudioSegmentRef,
    AudioSource,
    DiarizationRequest,
    EventEnvelope,
)
from speaker_diarization.service import DiarizationError, DiarizationService

# Literal 422: Starlette renamed the constant (UNPROCESSABLE_ENTITY → _CONTENT).
UNPROCESSABLE = 422


@dataclass
class AppDeps:
    service: DiarizationService


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


def create_app(deps: AppDeps) -> FastAPI:
    app = FastAPI(
        title="CI Speaker Diarization Service",
        description=(
            "Assigns anonymous speaker labels (SPEAKER_n) to transcript segments. "
            "Never infers real-world identity."
        ),
        version="0.2.0",
    )
    service = deps.service

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

    @app.post("/v1/events/transcription-completed")
    async def on_transcription_completed(
        body: dict[str, Any], response: Response
    ) -> dict[str, Any]:
        try:
            envelope = EventEnvelope.model_validate(_unwrap_pubsub_push(body))
        except ValidationError as exc:
            raise HTTPException(UNPROCESSABLE, exc.errors()) from exc
        if envelope.type != "transcription.completed":
            response.status_code = status.HTTP_200_OK
            return {"ignored": True, "reason": f"unexpected event type {envelope.type}"}
        data = envelope.data
        transcript_id = data.get("transcriptId")
        if not transcript_id:
            raise HTTPException(UNPROCESSABLE, "data.transcriptId required")
        audio: AudioSource | None = None
        try:
            if data.get("audioSegments"):
                audio = AudioSource(
                    segments=[AudioSegmentRef.model_validate(s) for s in data["audioSegments"]]
                )
            elif data.get("storageUri"):
                audio = AudioSource(storage_uri=str(data["storageUri"]))
        except ValidationError as exc:
            raise HTTPException(UNPROCESSABLE, exc.errors()) from exc
        try:
            result = await service.diarize_transcription(
                transcript_id=str(transcript_id),
                recording_session_id=data.get("recordingSessionId"),
                institution_id=envelope.institution_id,
                audio=audio,
            )
        except DiarizationError as exc:
            # Non-retryable (bad/no audio): acknowledge so Pub/Sub does not loop forever;
            # the failure is in the audit log for the alerting rules.
            response.status_code = status.HTTP_200_OK
            return {"failed": True, "reason": str(exc)}
        return {"transcriptId": result.transcript_id, "speakerCount": result.speaker_count}

    return app
