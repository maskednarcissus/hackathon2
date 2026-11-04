"""Domain and API models (contract: docs/architecture/phase-2-classroom-intelligence.md §4–§5)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

EventType = Literal[
    "examination",
    "quiz",
    "assignment",
    "project",
    "presentation",
    "reading_deadline",
    "class_cancellation",
    "class_reschedule",
    "room_change",
    "other",
]
EVENT_TYPES: tuple[EventType, ...] = (
    "examination",
    "quiz",
    "assignment",
    "project",
    "presentation",
    "reading_deadline",
    "class_cancellation",
    "class_reschedule",
    "room_change",
    "other",
)
ConfirmationStatus = Literal[
    "suggested", "awaiting_professor", "awaiting_admin", "confirmed", "published", "rejected"
]
ExtractorKind = Literal["llm", "heuristic", "hybrid"]
DateMethod = Literal["absolute", "relative", "next_class", "weekday", "none"]
ChangeSource = Literal["professor", "admin", "system", "integration"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class TranscriptSegment(CamelModel):
    segment_index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str
    confidence: float = Field(default=0.9, ge=0, le=1)
    speaker_label: str | None = None
    language: str = "pt-BR"


class ScheduledClassRef(CamelModel):
    scheduled_class_id: str
    class_date: date


class ClassContext(CamelModel):
    scheduled_class_id: str
    class_date: date
    timezone: str = "America/Sao_Paulo"
    institution_id: str
    course_id: str
    course_name: str | None = None
    class_section_id: str
    professor_id: str | None = None
    upcoming_classes: list[ScheduledClassRef] = Field(default_factory=list)


class DateResolutionModel(CamelModel):
    method: DateMethod
    ambiguous: bool
    candidates: list[str]
    explanation: str


class EventSource(CamelModel):
    recording_session_id: str | None = None
    segment_index: int
    start_ms: int
    end_ms: int
    quote: str


class Confidence(CamelModel):
    overall: float = Field(ge=0, le=1)
    transcription: float = Field(ge=0, le=1)
    event_classification: float = Field(ge=0, le=1)
    date_interpretation: float = Field(ge=0, le=1)
    course_association: float = Field(ge=0, le=1)


class Mention(CamelModel):
    scheduled_class_id: str
    segment_index: int
    quote: str
    event_date: str | None = None
    recorded_at: datetime


class Conflict(CamelModel):
    kind: str
    severity: Literal["info", "warning", "blocking"]
    message: str
    related_event_id: str | None = None


class ChangeRecord(CamelModel):
    changed_at: datetime
    changed_by: str
    source: ChangeSource
    change_type: Literal[
        "date_change", "description_change", "status_change", "cancellation", "other"
    ]
    field: str
    previous_value: str | None = None
    new_value: str | None = None
    reason: str | None = None


class Provenance(CamelModel):
    extractor: Literal["llm", "heuristic"]
    prompt_id: str | None = None
    prompt_version: str | None = None
    model: str | None = None
    processing_version: str


class ProposedChange(CamelModel):
    """A repeated announcement with a different date for an existing assessment (§4 dedup)."""

    target_event_id: str
    field: Literal["eventDate"] = "eventDate"
    previous_value: str | None = None
    proposed_value: str | None = None


class ExtractedEvent(CamelModel):
    id: str
    type: EventType
    title: str
    description: str | None = None
    institution_id: str
    course_id: str
    class_section_id: str
    scheduled_class_id: str
    transcript_id: str
    professor_id: str | None = None
    event_date: str | None = None
    event_time: str | None = None
    timezone: str = "America/Sao_Paulo"
    date_expression: str | None = None
    date_resolution: DateResolutionModel
    source: EventSource
    confidence: Confidence
    flags: list[str] = Field(default_factory=list)
    confirmation_status: ConfirmationStatus = "suggested"
    duplicate_of: str | None = None
    proposed_change: ProposedChange | None = None
    mentions: list[Mention] = Field(default_factory=list)
    conflicts: list[Conflict] = Field(default_factory=list)
    conflict_check: Literal["ok", "failed", "skipped"] = "skipped"
    change_history: list[ChangeRecord] = Field(default_factory=list)
    provenance: Provenance
    calendar_event_id: str | None = None
    created_at: datetime
    updated_at: datetime


def _default_auto_types() -> list[EventType]:
    return ["examination", "quiz", "assignment", "project", "presentation"]


def _default_review_types() -> list[EventType]:
    return ["class_cancellation", "class_reschedule", "room_change"]


class PublicationPolicy(CamelModel):
    auto_publish: bool = False
    auto_publish_min_confidence: float = Field(default=0.92, ge=0, le=1)
    allow_auto_publish_types: list[EventType] = Field(default_factory=_default_auto_types)
    require_professor_review_for: list[EventType] = Field(default_factory=_default_review_types)
    publish_on_confirm: bool = True


# ---------------------------------------------------------------------------
# API payloads
# ---------------------------------------------------------------------------


class ExtractionRequest(CamelModel):
    transcript_id: str
    scheduled_class_id: str
    recording_session_id: str | None = None
    segments: list[TranscriptSegment] | None = None
    extractor: ExtractorKind | None = None


class ValidationStats(CamelModel):
    candidates: int = 0
    accepted: int = 0
    dropped: int = 0
    reasons: dict[str, int] = Field(default_factory=dict)


class Deduplication(CamelModel):
    event_id: str
    merged_into: str
    kind: Literal["repeat", "date_change_proposal"]


class ExtractionResult(CamelModel):
    transcript_id: str
    scheduled_class_id: str
    extractor: ExtractorKind
    events: list[ExtractedEvent]
    deduplicated: list[Deduplication] = Field(default_factory=list)
    validation: ValidationStats
    awaiting_review: int
    published: int
    injection_suspected: bool = False


class ActionBody(CamelModel):
    actor_id: str | None = None
    notes: str | None = None


class EditChanges(CamelModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    type: EventType | None = None
    event_date: str | None = None
    event_time: str | None = None
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("event_date")
    @classmethod
    def _valid_date(cls, v: str | None) -> str | None:
        if v is not None:
            date.fromisoformat(v)
        return v

    @field_validator("event_time")
    @classmethod
    def _valid_time(cls, v: str | None) -> str | None:
        if v is not None:
            hh, mm = v.split(":")
            if not (len(hh) == 2 and len(mm) == 2 and 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
                raise ValueError("eventTime must be HH:MM")
        return v


class EditBody(CamelModel):
    actor_id: str | None = None
    changes: EditChanges
    reason: str | None = None


class RejectBody(CamelModel):
    actor_id: str | None = None
    reason: str = Field(min_length=1, max_length=2000)


class LifecycleEnvelope(CamelModel):
    event_id: str | None = None
    type: str
    version: int = 1
    occurred_at: str | None = None
    source: str | None = None
    institution_id: str | None = None
    data: dict[str, object]
