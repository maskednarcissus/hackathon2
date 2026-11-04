"""In-memory adapters for local development and tests."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from transcription.models import (
    AudioSegmentRef,
    JobStatus,
    TranscriptionJob,
    TranscriptSegment,
    Word,
)
from transcription.ports import (
    ClassContext,
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
        class_section_id: str | None = None,
        institution_id: str | None = None,
    ) -> StoredTranscript:
        transcript_id = str(uuid.uuid4())
        self.transcripts[transcript_id] = {
            "recordingSessionId": recording_session_id,
            "scheduledClassId": scheduled_class_id,
            "classSectionId": class_section_id,
            "institutionId": institution_id,
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


_ACTIVE = (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.COMPLETED)


@dataclass
class InMemoryJobRepository:
    jobs: dict[str, TranscriptionJob] = field(default_factory=dict)

    async def create_if_absent(self, job: TranscriptionJob) -> tuple[TranscriptionJob, bool]:
        existing = await self.find_active_for_recording(job.request.recording_session_id)
        if existing is not None:
            return existing, False
        await self.save(job)
        return job.model_copy(deep=True), True

    async def claim(self, job_id: str) -> TranscriptionJob | None:
        job = self.jobs.get(job_id)
        if job is None or job.status is not JobStatus.QUEUED:
            return None
        job.status = JobStatus.RUNNING
        return job.model_copy(deep=True)

    async def save(self, job: TranscriptionJob) -> None:
        self.jobs[job.job_id] = job.model_copy(deep=True)

    async def get(self, job_id: str) -> TranscriptionJob | None:
        job = self.jobs.get(job_id)
        return job.model_copy(deep=True) if job else None

    async def find_active_for_recording(self, recording_session_id: str) -> TranscriptionJob | None:
        for job in self.jobs.values():
            if job.request.recording_session_id == recording_session_id and job.status in _ACTIVE:
                return job.model_copy(deep=True)
        return None


@dataclass
class InMemoryProcessedEvents:
    seen: set[str] = field(default_factory=set)

    async def is_processed(self, event_id: str) -> bool:
        return event_id in self.seen

    async def mark_processed(self, event_id: str) -> None:
        self.seen.add(event_id)


@dataclass
class StaticClassContextResolver:
    """Resolves from fixed maps (tests / offline dev)."""

    by_scheduled_class: dict[str, ClassContext] = field(default_factory=dict)
    by_classroom: dict[str, ClassContext] = field(default_factory=dict)
    calls: int = 0

    async def resolve(
        self,
        *,
        scheduled_class_id: str | None,
        classroom_id: str | None,
        started_at: datetime | None,
        ended_at: datetime | None,
        recording_session_id: str,
    ) -> ClassContext | None:
        self.calls += 1
        if scheduled_class_id:
            return self.by_scheduled_class.get(scheduled_class_id)
        if classroom_id and started_at and ended_at:
            return self.by_classroom.get(classroom_id)
        return None
