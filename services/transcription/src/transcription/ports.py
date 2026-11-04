"""Ports (interfaces) the transcription service depends on."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from transcription.models import AudioSegmentRef, TranscriptionJob, TranscriptSegment, Word


class ProviderError(Exception):
    """Permanent speech-provider failure (bad audio, invalid request)."""


class TransientProviderError(ProviderError):
    """Retryable failure (quota, timeout, 5xx)."""


@dataclass(frozen=True)
class RecognitionConfig:
    language: str = "pt-BR"
    phrases: tuple[str, ...] = ()
    phrase_boost: float = 10.0
    #: Per-phrase boost overrides (e.g. institution vocabularies with their own boost).
    boosts: Mapping[str, float] = field(default_factory=dict)

    def boost_for(self, phrase: str) -> float:
        return float(self.boosts.get(phrase, self.phrase_boost))


@dataclass(frozen=True)
class ProviderResult:
    """Words with timestamps **relative to the start of the audio segment**."""

    words: list[Word]
    detected_language: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class SpeechProvider(Protocol):
    name: str
    model: str

    async def transcribe(
        self, segment: AudioSegmentRef, config: RecognitionConfig
    ) -> ProviderResult: ...


@dataclass(frozen=True)
class StoredTranscript:
    transcript_id: str


class TranscriptStoreClient(Protocol):
    async def create_transcript(
        self,
        *,
        recording_session_id: str,
        scheduled_class_id: str | None,
        language: str,
        processing_version: str,
        provider: str,
        model: str,
        segments: list[TranscriptSegment],
        class_section_id: str | None = None,
        institution_id: str | None = None,
    ) -> StoredTranscript: ...


class EventPublisher(Protocol):
    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None: ...


class AuditSink(Protocol):
    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str,
        institution_id: str | None,
        metadata: dict[str, Any],
    ) -> None: ...


class JobRepository(Protocol):
    async def create_if_absent(self, job: TranscriptionJob) -> tuple[TranscriptionJob, bool]:
        """Insert ``job`` unless the recording already has a queued/running/completed job
        (``uq_transcription_jobs_active``); returns ``(job, created)``."""
        ...

    async def claim(self, job_id: str) -> TranscriptionJob | None:
        """Atomically move a *queued* job to *running*; ``None`` if it was not queued."""
        ...

    async def save(self, job: TranscriptionJob) -> None: ...

    async def get(self, job_id: str) -> TranscriptionJob | None: ...

    async def find_active_for_recording(
        self, recording_session_id: str
    ) -> TranscriptionJob | None: ...


class VocabularySource(Protocol):
    async def phrases_for(
        self, institution_id: str | None, discipline: str | None
    ) -> tuple[tuple[str, ...], dict[str, float]]:
        """Phrases for a job and per-phrase boost overrides."""
        ...


@dataclass(frozen=True)
class ClassContext:
    scheduled_class_id: str | None = None
    class_section_id: str | None = None
    institution_id: str | None = None
    discipline: str | None = None


class ClassContextResolver(Protocol):
    """academic-integration lookups: scheduled class → section, or class identification."""

    async def resolve(
        self,
        *,
        scheduled_class_id: str | None,
        classroom_id: str | None,
        started_at: datetime | None,
        ended_at: datetime | None,
        recording_session_id: str,
    ) -> ClassContext | None: ...


class ProcessedEventStore(Protocol):
    """Idempotent consumption by ``eventId`` (``processed_events``)."""

    async def is_processed(self, event_id: str) -> bool: ...

    async def mark_processed(self, event_id: str) -> None: ...


class Lifecycle(Protocol):
    async def open(self) -> None: ...

    async def close(self) -> None: ...
