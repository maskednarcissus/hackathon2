"""Wire models (camelCase JSON) for the transcription service.

Shapes follow docs/architecture/phase-1-capture-pipeline.md §6 and §8.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from transcription.ids import check_uuid
from transcription.languages import check_language

#: Platform identifiers are UUID strings (contract §2); normalised to lowercase.
UUIDStr = Annotated[str, AfterValidator(check_uuid)]
#: Supported lecture language, canonicalised (``es_MX`` → ``es-419``) — Phase 6.4.
LanguageStr = Annotated[str, AfterValidator(check_language)]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class AudioSegmentRef(CamelModel):
    """One audio segment produced by audio-processing (``recording.segmented``)."""

    index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    storage_uri: str = Field(min_length=1)

    @model_validator(mode="after")
    def _check_bounds(self) -> AudioSegmentRef:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs must be greater than startMs")
        return self


class TranscriptionRequest(CamelModel):
    recording_session_id: UUIDStr
    scheduled_class_id: UUIDStr | None = None
    class_section_id: UUIDStr | None = None
    institution_id: UUIDStr | None = None
    classroom_id: UUIDStr | None = None
    #: Recording bounds — used for class identification when no scheduledClassId is known.
    started_at: datetime | None = None
    ended_at: datetime | None = None
    discipline: str | None = Field(default=None, max_length=100)
    #: Explicit lecture language; ``None`` → class context → ``pt-BR``.
    language: LanguageStr | None = None
    segments: list[AudioSegmentRef] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_indexes(self) -> TranscriptionRequest:
        indexes = [s.index for s in self.segments]
        if len(indexes) != len(set(indexes)):
            raise ValueError("segment indexes must be unique")
        return self


class Word(CamelModel):
    word: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    confidence: float = Field(ge=0.0, le=1.0)
    speaker_tag: int | None = None


class TranscriptSegment(CamelModel):
    """Contract §8 transcript segment."""

    segment_index: int
    start_ms: int
    end_ms: int
    text: str
    confidence: float
    language: str = "pt-BR"
    speaker_label: str | None = None
    words: list[Word] = Field(default_factory=list)


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class TranscriptionJob(CamelModel):
    job_id: str
    status: JobStatus
    request: TranscriptionRequest
    created_at: datetime
    updated_at: datetime
    transcript_id: str | None = None
    segment_count: int | None = None
    word_count: int | None = None
    mean_confidence: float | None = None
    failure_reason: str | None = None
    provider: str
    model: str


class EventEnvelope(CamelModel):
    """Platform event envelope (§6)."""

    event_id: UUIDStr
    type: str
    version: int = 1
    occurred_at: datetime
    source: str
    institution_id: UUIDStr | None = None
    data: dict[str, Any]
