"""Ports (interfaces) the transcription service depends on."""

from __future__ import annotations

from dataclasses import dataclass, field
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
    async def save(self, job: TranscriptionJob) -> None: ...

    async def get(self, job_id: str) -> TranscriptionJob | None: ...

    async def find_active_for_recording(
        self, recording_session_id: str
    ) -> TranscriptionJob | None: ...
