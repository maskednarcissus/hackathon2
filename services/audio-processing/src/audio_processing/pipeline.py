"""Processing use cases: ad-hoc quality/segmentation and the ``recording.uploaded`` handler."""

from __future__ import annotations

import hashlib
import os
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from audio_processing.decode import flac_to_wav, sniff_format
from audio_processing.ports import (
    AuditClient,
    AuditRecord,
    EventEnvelope,
    EventPublisher,
    ObjectStore,
    ProcessingRepository,
    UnknownRecordingError,
)
from audio_processing.quality import QualityReport, assess
from audio_processing.results import PipelineResult, SegmentationResult
from audio_processing.segmentation import Segment, SegmentationConfig, plan_segments
from audio_processing.wav import WavFormatError, analyze_wav, write_wav_range

log = structlog.get_logger(__name__)

SERVICE_NAME = "audio-processing"
SUPPORTED_FORMATS = frozenset({"wav_pcm_s16le", "flac"})
CONSUMER = SERVICE_NAME  # processed_events.consumer
EVENT_ID_NAMESPACE = uuid.UUID("0b7f6a52-3c1e-4d7b-9a61-5f2d8c4e9b13")


def _iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def derived_event_id(consumed_event_id: str, event_type: str) -> str:
    """Id of an event emitted while handling ``consumed_event_id``.

    Deterministic, so a redelivered input re-publishes identical ids that subscribers
    deduplicate.
    """
    return str(uuid.uuid5(EVENT_ID_NAMESPACE, f"{consumed_event_id}:{event_type}"))


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
    started_at: datetime | None = None
    ended_at: datetime | None = None
    institution_id: str | None = None
    class_section_id: str | None = None


class RecordingUploadedEvent(_Camel):
    event_id: uuid.UUID
    type: str
    version: int = 1
    occurred_at: datetime
    source: str
    institution_id: str | None = None
    data: RecordingUploadedData


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
    repository: ProcessingRepository
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    def __post_init__(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------- helpers
    def _emit(
        self, event_type: str, institution_id: str | None, data: dict[str, Any], event_id: str
    ) -> None:
        self.publisher.publish(
            EventEnvelope(
                event_id=event_id,
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

    def as_wav(self, path: Path) -> tuple[Path, bool]:
        """WAV for ``path`` (FLAC is decoded into a temp file) and whether it is temporary."""
        if sniff_format(path) == "wav":
            return path, False
        wav = self.temp_path(".wav")
        try:
            flac_to_wav(path, wav)
        except Exception:
            wav.unlink(missing_ok=True)
            raise
        return wav, True

    # -------------------------------------------------------- 1.8 quality
    def assess_file(self, path: Path) -> QualityReport:
        wav, temporary = self.as_wav(path)
        try:
            return assess(analyze_wav(wav))
        finally:
            if temporary:
                wav.unlink(missing_ok=True)

    # --------------------------------------------------- 1.9 segmentation
    def segment_file(
        self,
        path: Path,
        key_prefix: str,
        config: SegmentationConfig | None = None,
    ) -> SegmentationResult:
        wav, temporary = self.as_wav(path)
        try:
            analysis = analyze_wav(wav)
            segments = plan_segments(
                analysis.frame_db,
                analysis.frame_ms,
                analysis.info.duration_ms,
                config or self.segmentation,
            )
            self._write_segments(wav, segments, key_prefix)
        finally:
            if temporary:
                wav.unlink(missing_ok=True)
        return SegmentationResult(duration_ms=analysis.info.duration_ms, segments=segments)

    def _write_segments(self, path: Path, segments: list[Segment], key_prefix: str) -> None:
        for segment in segments:
            out = self.temp_path(".wav")
            try:
                write_wav_range(path, out, segment.start_ms, segment.end_ms)
                data = out.read_bytes()
                segment.size_bytes = len(data)
                segment.checksum_sha256 = hashlib.sha256(data).hexdigest()
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
        if event.data.audio_format not in SUPPORTED_FORMATS:
            raise ProcessingError(
                422, "unsupported_format", f"cannot process {event.data.audio_format}"
            )
        return event

    def _duplicate(self, recording_id: str) -> PipelineResult:
        previous = self.repository.load_result(recording_id)
        if previous is None:
            return PipelineResult(
                recording_session_id=recording_id, status="duplicate", report=None
            )
        return previous.model_copy(update={"status": "duplicate"})

    def handle_recording_uploaded(self, payload: dict[str, Any]) -> PipelineResult:
        """Process one ``recording.uploaded`` event, idempotently by ``eventId``.

        Order matters for at-least-once delivery: outputs are written and published
        (with ids derived from the consumed event id) *before* the event is recorded as
        processed, so a crash or publish failure leads to a redelivery that completes the
        work instead of silently dropping it.
        """
        event = self.parse_event(payload)
        event_id = str(event.event_id)
        data = event.data
        tenant = event.institution_id or data.institution_id
        if self.repository.is_processed(event_id):
            return self._duplicate(data.recording_session_id)

        local = self.temp_path(".audio")
        wav: Path | None = None
        temporary = False
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

            try:
                wav, temporary = self.as_wav(local)
            except WavFormatError as exc:
                raise ProcessingError(422, "undecodable_audio", str(exc)) from exc
            if (sniff_format(local) == "flac") != (data.audio_format == "flac"):
                log.warning(
                    "audio_format.mismatch",
                    declared=data.audio_format,
                    recording_session_id=data.recording_session_id,
                )
            analysis = analyze_wav(wav)
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
                derived_event_id(event_id, "audio.quality_assessed"),
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
                    wav, segments, segment_key_prefix(self.store, data.storage_uri)
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
                        # Recording window + tenant, carried from recording.uploaded so
                        # transcription can resolve the class section (class identification).
                        "startedAt": _iso(data.started_at),
                        "endedAt": _iso(data.ended_at),
                        "institutionId": tenant,
                        **(
                            {"classSectionId": data.class_section_id}
                            if data.class_section_id
                            else {}
                        ),
                        "segments": segment_payload,
                    },
                    derived_event_id(event_id, "recording.segmented"),
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
            if wav is not None and temporary:
                wav.unlink(missing_ok=True)

        try:
            recorded = self.repository.save(event_id, result)
        except UnknownRecordingError as exc:
            raise ProcessingError(422, "unknown_recording", str(exc)) from exc
        if not recorded:
            # A concurrent delivery of the same event finished first.
            return self._duplicate(data.recording_session_id)
        return result
