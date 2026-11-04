"""In-memory adapters for local development and tests."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from transcription.models import (
    AudioSegmentRef,
    JobStatus,
    TranscriptionJob,
    TranscriptSegment,
    Word,
)
from transcription.ports import (
    ProviderError,
    ProviderResult,
    RecognitionConfig,
    StoredTranscript,
    TransientProviderError,
)

WordScript = Callable[[AudioSegmentRef], list[Word]]


def _default_script(segment: AudioSegmentRef) -> list[Word]:
    """One sentence every ~4 s of audio, deterministic per segment."""
    words: list[Word] = []
    duration = segment.end_ms - segment.start_ms
    t = 0
    n = 0
    while t + 2_400 <= duration:
        sentence = ["Hoje", "estudamos", "o", f"tópico{segment.index}_{n}."]
        for i, token in enumerate(sentence):
            words.append(
                Word(
                    word=token,
                    start_ms=t + i * 600,
                    end_ms=t + i * 600 + 500,
                    confidence=0.9,
                )
            )
        t += 4_000
        n += 1
    return words


@dataclass
class FakeSpeechProvider:
    """Deterministic provider. ``fail_times[index]`` transient failures before success;
    ``permanent_failures`` always raise."""

    script: WordScript = _default_script
    fail_times: dict[int, int] = field(default_factory=dict)
    permanent_failures: set[int] = field(default_factory=set)
    name: str = "fake"
    model: str = "fake-chirp"
    calls: list[tuple[int, RecognitionConfig]] = field(default_factory=list)
    max_in_flight: int = 0
    _in_flight: int = 0

    async def transcribe(
        self, segment: AudioSegmentRef, config: RecognitionConfig
    ) -> ProviderResult:
        self.calls.append((segment.index, config))
        self._in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            await asyncio.sleep(0)
            if segment.index in self.permanent_failures:
                raise ProviderError(f"segment {segment.index}: unsupported audio")
            remaining = self.fail_times.get(segment.index, 0)
            if remaining > 0:
                self.fail_times[segment.index] = remaining - 1
                raise TransientProviderError("deadline exceeded")
            return ProviderResult(words=self.script(segment), detected_language=config.language)
        finally:
            self._in_flight -= 1


@dataclass
class InMemoryTranscriptStore:
    transcripts: dict[str, dict[str, Any]] = field(default_factory=dict)

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
    ) -> StoredTranscript:
        transcript_id = str(uuid.uuid4())
        self.transcripts[transcript_id] = {
            "recordingSessionId": recording_session_id,
            "scheduledClassId": scheduled_class_id,
            "language": language,
            "processingVersion": processing_version,
            "provider": provider,
            "model": model,
            "segments": [s.dump() for s in segments],
        }
        return StoredTranscript(transcript_id=transcript_id)


@dataclass
class InMemoryPublisher:
    events: list[dict[str, Any]] = field(default_factory=list)

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        self.events.append({"type": event_type, "data": data, "institutionId": institution_id})


@dataclass
class InMemoryAuditSink:
    records: list[dict[str, Any]] = field(default_factory=list)

    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str,
        institution_id: str | None,
        metadata: dict[str, Any],
    ) -> None:
        self.records.append(
            {
                "action": action,
                "resourceType": resource_type,
                "resourceId": resource_id,
                "institutionId": institution_id,
                "metadata": metadata,
            }
        )


@dataclass
class InMemoryJobRepository:
    jobs: dict[str, TranscriptionJob] = field(default_factory=dict)

    async def save(self, job: TranscriptionJob) -> None:
        self.jobs[job.job_id] = job.model_copy(deep=True)

    async def get(self, job_id: str) -> TranscriptionJob | None:
        job = self.jobs.get(job_id)
        return job.model_copy(deep=True) if job else None

    async def find_active_for_recording(self, recording_session_id: str) -> TranscriptionJob | None:
        for job in self.jobs.values():
            if job.request.recording_session_id == recording_session_id and job.status in (
                JobStatus.QUEUED,
                JobStatus.RUNNING,
                JobStatus.COMPLETED,
            ):
                return job.model_copy(deep=True)
        return None
