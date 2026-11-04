"""FastAPI application factory for the audio ingestion service."""

from typing import Annotated

from fastapi import Depends, FastAPI, Header, Request, Response, status
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from audio_ingestion import __version__
from audio_ingestion.auth import device_authenticator
from audio_ingestion.config import Dependencies, dependencies_from_env
from audio_ingestion.models import (
    MAX_CHUNK_SIZE,
    RecordingEventIn,
    RecordingMetadataIn,
    RecordingSession,
    UploadCreateIn,
    UploadOut,
)
from audio_ingestion.ports import DeviceIdentity
from audio_ingestion.service import IngestionError, IngestionService


def create_app(deps: Dependencies | None = None) -> FastAPI:
    deps = deps or dependencies_from_env()
    service = IngestionService(
        recordings=deps.recordings,
        uploads=deps.uploads,
        store=deps.store,
        publisher=deps.publisher,
        audit=deps.audit,
        staging_dir=deps.staging_dir,
        clock=deps.clock,
    )
    authenticate = device_authenticator(deps)
    Device = Annotated[DeviceIdentity, Depends(authenticate)]  # noqa: N806

    app = FastAPI(
        title="CI Audio Ingestion Service",
        description=(
            "Receives recording metadata and chunked, checksummed audio uploads from "
            "classroom devices, stores them encrypted and publishes `recording.uploaded`."
        ),
        version=__version__,
    )
    app.state.service = service
    app.state.deps = deps

    @app.exception_handler(IngestionError)
    async def _ingestion_error(_: Request, exc: IngestionError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "message": exc.message, **exc.details},
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Service health check."""
        return {"status": "ok", "service": "audio-ingestion"}

    # ----------------------------------------------------------- 1.7 metadata
    @app.post("/v1/recordings", response_model=RecordingSession)
    async def register_recording(
        body: RecordingMetadataIn, device: Device, response: Response
    ) -> RecordingSession:
        recording, created = service.register_recording(device, body)
        response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
        return recording

    @app.get("/v1/recordings/{recording_id}", response_model=RecordingSession)
    async def get_recording(recording_id: str, device: Device) -> RecordingSession:
        return service.get_recording(device, recording_id)

    @app.post("/v1/recording-events", status_code=status.HTTP_202_ACCEPTED)
    async def recording_event(body: RecordingEventIn, device: Device) -> dict[str, str]:
        service.report_recording_event(device, body)
        return {"status": "accepted"}

    # ------------------------------------------------------------ 1.5 uploads
    @app.post("/v1/uploads", response_model=UploadOut)
    async def create_upload(body: UploadCreateIn, device: Device, response: Response) -> UploadOut:
        upload, created = service.create_upload(device, body)
        response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
        return UploadOut.from_session(upload)

    @app.get("/v1/uploads/{upload_id}", response_model=UploadOut)
    async def get_upload(upload_id: str, device: Device) -> UploadOut:
        return UploadOut.from_session(service.get_upload(device, upload_id))

    @app.put(
        "/v1/uploads/{upload_id}/chunks/{index}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def put_chunk(
        upload_id: str,
        index: int,
        request: Request,
        device: Device,
        x_chunk_sha256: Annotated[str, Header(pattern=r"^[0-9a-fA-F]{64}$")],
    ) -> Response:
        declared = request.headers.get("content-length")
        if declared is not None and int(declared) > MAX_CHUNK_SIZE:
            raise IngestionError(413, "chunk_too_large", "chunk exceeds 16 MiB")
        data = await request.body()
        await run_in_threadpool(service.put_chunk, device, upload_id, index, data, x_chunk_sha256)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post("/v1/uploads/{upload_id}/complete", response_model=UploadOut)
    async def complete_upload(upload_id: str, device: Device) -> UploadOut:
        upload, recording = await run_in_threadpool(service.complete_upload, device, upload_id)
        return UploadOut.from_session(upload, storage_uri=recording.storage_uri)

    return app
