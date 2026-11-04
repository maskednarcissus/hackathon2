"""Processing use cases: ad-hoc quality/segmentation and the ``recording.uploaded`` handler."""

from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from audio_processing.ports import (
    AuditClient,
    AuditRecord,
    EventEnvelope,
    EventPublisher,
    ObjectStore,
)
from audio_processing.quality import QualityReport, assess
from audio_processing.segmentation import Segment, SegmentationConfig, plan_segments
from audio_processing.wav import analyze_wav, write_wav_range

log = structlog.get_logger(__name__)

SERVICE_NAME = "audio-processing"


class ProcessingError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RecordingUploadedData(_Camel):
    """``data`` of a ``recording.uploaded`` event (contract §6)."""

    recording_session_id: str
    device_id: str
    classroom_id: str
    scheduled_class_id: str | None = None
    storage_uri: str
    size_bytes: int
    checksum_sha256: str
    sample_rate: int
    channels: int
    duration_ms: int
    audio_format: str = "wav_pcm_s16le"


class RecordingUploadedEvent(_Camel):
    event_id: str
    type: str
    version: int = 1
    occurred_at: datetime
    source: str
    institution_id: str | None = None
    data: RecordingUploadedData


class PipelineResult(_Camel):
    recording_session_id: str
    status: str  # "segmented" | "stopped_unusable" | "duplicate"
    report: QualityReport
    segments: list[Segment] = Field(default_factory=list)


class SegmentationResult(_Camel):
    duration_ms: int
    segments: list[Segment]


def segment_key_prefix(store: ObjectStore, source_uri: str) -> str:
    """``recordings/…/{id}.wav`` → ``recordings/…/{id}/segments``."""
    key = store.key_of(source_uri)
    base = key.rsplit(".", 1)[0] if "." in key.rsplit("/", 1)[-1] else key
    return f"{base}/segments"


@dataclass
class ProcessingService:
    store: ObjectStore
    publisher: EventPublisher
    audit: AuditClient
    work_dir: Path
    segmentation: SegmentationConfig
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    def __post_init__(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._processed: dict[str, PipelineResult] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------- helpers
    def _emit(self, event_type: str, institution_id: str | None, data: dict[str, Any]) -> None:
        self.publisher.publish(
            EventEnvelope(
                event_id=str(uuid.uuid4()),
                type=event_type,
                version=1,
                occurred_at=self.clock(),
                source=SERVICE_NAME,
                institution_id=institution_id,
                data=data,
            )
        )

    def _audit(
        self, action: str, institution_id: str | None, recording_id: str, **metadata: Any
    ) -> None:
        self.audit.record(
            AuditRecord(
                action=action,
                resource_type="recording_session",
                resource_id=recording_id,
                actor_type="system",
                actor_id=None,
                institution_id=institution_id,
                occurred_at=self.clock(),
                metadata={"service": SERVICE_NAME, **metadata},
            )
        )

    def temp_path(self, suffix: str) -> Path:
        fd, name = tempfile.mkstemp(dir=self.work_dir, suffix=suffix)
        os.close(fd)
        return Path(name)

    # -------------------------------------------------------- 1.8 quality
    def assess_file(self, path: Path) -> QualityReport:
        return assess(analyze_wav(path))

    # --------------------------------------------------- 1.9 segmentation
    def segment_file(
        self,
        path: Path,
        key_prefix: str,
        config: SegmentationConfig | None = None,
    ) -> SegmentationResult:
        analysis = analyze_wav(path)
        segments = plan_segments(
            analysis.frame_db,
            analysis.frame_ms,
            analysis.info.duration_ms,
            config or self.segmentation,
        )
        self._write_segments(path, segments, key_prefix)
        return SegmentationResult(duration_ms=analysis.info.duration_ms, segments=segments)

    def _write_segments(self, path: Path, segments: list[Segment], key_prefix: str) -> None:
        for segment in segments:
            out = self.temp_path(".wav")
            try:
                write_wav_range(path, out, segment.start_ms, segment.end_ms)
                segment.storage_uri = self.store.put_file(
                    f"{key_prefix}/{segment.index:04d}.wav", out, "audio/wav"
                )
            finally:
                out.unlink(missing_ok=True)

    # ------------------------------------------- recording.uploaded handler
    @staticmethod
    def parse_event(payload: dict[str, Any]) -> RecordingUploadedEvent:
        try:
            event = RecordingUploadedEvent.model_validate(payload)
        except ValidationError as exc:
            raise ProcessingError(422, "invalid_event", str(exc)) from exc
        if event.type != "recording.uploaded":
            raise ProcessingError(422, "unexpected_event_type", f"got {event.type}")
        if event.data.audio_format != "wav_pcm_s16le":
            raise ProcessingError(
                422, "unsupported_format", f"cannot process {event.data.audio_format}"
            )
        return event

    def handle_recording_uploaded(self, payload: dict[str, Any]) -> PipelineResult:
        event = self.parse_event(payload)
        data = event.data
        tenant = event.institution_id
        with self._lock:
            previous = self._processed.get(data.recording_session_id)
        if previous is not None:
            return previous.model_copy(update={"status": "duplicate"})

        local = self.temp_path(".wav")
        try:
            self.store.get_to_file(data.storage_uri, local)
            digest = hashlib.sha256()
            with local.open("rb") as handle:
                while block := handle.read(1024 * 1024):
                    digest.update(block)
            if digest.hexdigest() != data.checksum_sha256:
                self._audit(
                    "audio.quality_assessed",
                    tenant,
                    data.recording_session_id,
                    error="checksum_mismatch",
                )
                raise ProcessingError(
                    422, "checksum_mismatch", "stored audio does not match its checksum"
                )

            analysis = analyze_wav(local)
            report = assess(analysis)
            context = {
                "recordingSessionId": data.recording_session_id,
                "deviceId": data.device_id,
                "classroomId": data.classroom_id,
                "scheduledClassId": data.scheduled_class_id,
            }
            self._emit(
                "audio.quality_assessed",
                tenant,
                {**context, "report": report.model_dump(by_alias=True)},
            )
            stopped = report.verdict == "unusable"
            self._audit(
                "audio.quality_assessed",
                tenant,
                data.recording_session_id,
                verdict=report.verdict,
                score=report.score,
                issues=list(report.issues),
                pipelineStopped=stopped,
            )
            if stopped:
                log.warning(
                    "pipeline.stopped_unusable",
                    recording_session_id=data.recording_session_id,
                    issues=report.issues,
                )
                result = PipelineResult(
                    recording_session_id=data.recording_session_id,
                    status="stopped_unusable",
                    report=report,
                )
            else:
                segments = plan_segments(
                    analysis.frame_db,
                    analysis.frame_ms,
                    analysis.info.duration_ms,
                    self.segmentation,
                )
                self._write_segments(
                    local, segments, segment_key_prefix(self.store, data.storage_uri)
                )
                segment_payload = [
                    s.model_dump(
                        by_alias=True, include={"index", "start_ms", "end_ms", "storage_uri"}
                    )
                    for s in segments
                ]
                self._emit(
                    "recording.segmented",
                    tenant,
                    {
                        **context,
                        "sampleRate": analysis.info.sample_rate,
                        "channels": analysis.info.channels,
                        "durationMs": analysis.info.duration_ms,
                        "qualityVerdict": report.verdict,
                        "segments": segment_payload,
                    },
                )
                self._audit(
                    "audio.segmented",
                    tenant,
                    data.recording_session_id,
                    segmentCount=len(segments),
                )
                result = PipelineResult(
                    recording_session_id=data.recording_session_id,
                    status="segmented",
                    report=report,
                    segments=segments,
                )
        finally:
            local.unlink(missing_ok=True)

        with self._lock:
            self._processed[data.recording_session_id] = result
        return result
