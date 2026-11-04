"""FastAPI application factory for the audio processing service."""

import base64
import binascii
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from audio_processing import __version__
from audio_processing.config import Dependencies, dependencies_from_env
from audio_processing.internal import internal_token_guard
from audio_processing.pipeline import ProcessingError, ProcessingService
from audio_processing.quality import QualityReport
from audio_processing.results import PipelineResult, SegmentationResult
from audio_processing.segmentation import SegmentationConfig
from audio_processing.wav import WavFormatError

MAX_ADHOC_BYTES = 1024 * 1024 * 1024


def _unwrap_push(payload: dict[str, Any]) -> dict[str, Any]:
    """Accept a raw event envelope or a Pub/Sub push request wrapping one."""
    message = payload.get("message")
    if isinstance(message, dict) and "data" in message:
        try:
            decoded = json.loads(base64.b64decode(message["data"], validate=True))
        except (binascii.Error, ValueError) as exc:
            raise ProcessingError(422, "invalid_push", "message.data is not base64 JSON") from exc
        if not isinstance(decoded, dict):
            raise ProcessingError(422, "invalid_push", "message.data must be a JSON object")
        return decoded
    return payload


def create_app(deps: Dependencies | None = None) -> FastAPI:
    deps = deps or dependencies_from_env()
    service = ProcessingService(
        store=deps.store,
        publisher=deps.publisher,
        audit=deps.audit,
        work_dir=deps.work_dir,
        segmentation=deps.segmentation,
        repository=deps.repository,
    )
    app = FastAPI(
        title="CI Audio Processing Service",
        description=(
            "Audio quality assessment and segmentation of long classroom recordings. "
            "Consumes `recording.uploaded`, publishes `audio.quality_assessed` and "
            "`recording.segmented`."
        ),
        version=__version__,
    )
    app.state.service = service

    @app.exception_handler(ProcessingError)
    async def _processing_error(_: Request, exc: ProcessingError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code, content={"error": exc.code, "message": exc.message}
        )

    @app.exception_handler(WavFormatError)
    async def _wav_error(_: Request, exc: WavFormatError) -> JSONResponse:
        return JSONResponse(
            status_code=415, content={"error": "unsupported_audio", "message": str(exc)}
        )

    async def _spool(request: Request) -> Path:
        path = service.temp_path(".wav")
        size = 0
        with path.open("wb") as out:
            async for block in request.stream():
                size += len(block)
                if size > MAX_ADHOC_BYTES:
                    out.close()
                    path.unlink(missing_ok=True)
                    raise ProcessingError(413, "too_large", "audio exceeds 1 GiB")
                out.write(block)
        return path

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Service health check."""
        return {"status": "ok", "service": "audio-processing"}

    @app.post("/v1/quality", response_model=QualityReport)
    async def quality(request: Request) -> QualityReport:
        """Assess the quality of a WAV PCM s16le body (contract §7)."""
        path = await _spool(request)
        try:
            return await run_in_threadpool(service.assess_file, path)
        finally:
            path.unlink(missing_ok=True)

    @app.post("/v1/segmentation", response_model=SegmentationResult)
    async def segmentation(
        request: Request,
        recording_session_id: str | None = Query(default=None, alias="recordingSessionId"),
        target_seconds: int = Query(default=300, alias="targetSeconds", ge=10),
        max_seconds: int = Query(default=360, alias="maxSeconds", ge=10),
        search_seconds: int = Query(default=30, alias="searchSeconds", ge=0),
        overlap_ms: int = Query(default=0, alias="overlapMs", ge=0),
    ) -> SegmentationResult:
        """Split a WAV body into segments and store each one; returns their URIs."""
        config = SegmentationConfig(
            target_ms=target_seconds * 1000,
            max_ms=max_seconds * 1000,
            search_ms=search_seconds * 1000,
            overlap_ms=overlap_ms,
        )
        try:
            config.validate()
        except ValueError as exc:
            raise ProcessingError(422, "invalid_segmentation_config", str(exc)) from exc
        prefix = f"adhoc/{recording_session_id or uuid.uuid4()}/segments"
        path = await _spool(request)
        try:
            return await run_in_threadpool(service.segment_file, path, prefix, config)
        finally:
            path.unlink(missing_ok=True)

    @app.post(
        "/v1/events/recording-uploaded",
        response_model=PipelineResult,
        dependencies=[Depends(internal_token_guard(deps.internal_token))],
    )
    async def recording_uploaded(payload: dict[str, Any]) -> PipelineResult:
        """Push endpoint for the `recording.uploaded` subscription (raw or Pub/Sub push)."""
        return await run_in_threadpool(service.handle_recording_uploaded, _unwrap_push(payload))

    return app
