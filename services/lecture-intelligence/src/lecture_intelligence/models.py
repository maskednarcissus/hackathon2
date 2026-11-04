"""Wire models (camelCase JSON) and the LLM output schema."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
AskedBy = Literal["student", "professor", "unknown"]
ReferenceType = Literal["book", "article", "chapter", "website", "other"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ----------------------------------------------------------------------------- input
class Word(CamelModel):
    word: str
    start_ms: int
    end_ms: int
    confidence: float | None = None


class Segment(CamelModel):
    segment_index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str
    confidence: float | None = Field(default=None, ge=0, le=1)
    language: str = "pt-BR"
    speaker_label: str | None = None
    words: list[Word] | None = None


class StructureRequest(CamelModel):
    transcript_id: str = Field(pattern=UUID_PATTERN)
    scheduled_class_id: str = Field(pattern=UUID_PATTERN)
    institution_id: str | None = Field(default=None, pattern=UUID_PATTERN)
    class_section_id: str | None = Field(default=None, pattern=UUID_PATTERN)
    course_id: str | None = Field(default=None, pattern=UUID_PATTERN)
    course_name: str | None = Field(default=None, max_length=255)
    class_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    starts_at: str | None = Field(default=None, max_length=40)
    language: str = "pt-BR"
    segments: list[Segment] = Field(min_length=1, max_length=20000)

    @model_validator(mode="after")
    def _unique_indexes(self) -> StructureRequest:
        indexes = [s.segment_index for s in self.segments]
        if len(indexes) != len(set(indexes)):
            raise ValueError("segmentIndex values must be unique")
        return self


# ----------------------------------------------------------------------------- LLM output
class LlmModel(BaseModel):
    """Models the gateway enforces as JSON schema. Field names are the camelCase wire names."""

    model_config = ConfigDict(extra="ignore")


class LlmSubtopic(LlmModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=1500)
    segmentIndexes: list[int] = Field(max_length=200)  # noqa: N815 - wire name


class LlmTopic(LlmSubtopic):
    subtopics: list[LlmSubtopic] = Field(default_factory=list, max_length=20)


class LlmConcept(LlmModel):
    term: str = Field(min_length=1, max_length=200)
    definition: str = Field(min_length=1, max_length=2000)
    example: str | None = Field(default=None, max_length=1500)
    segmentIndexes: list[int] = Field(max_length=50)  # noqa: N815


class LlmQuestion(LlmModel):
    question: str = Field(min_length=1, max_length=1500)
    answer: str | None = Field(default=None, max_length=3000)
    askedBy: AskedBy = "unknown"  # noqa: N815
    segmentIndexes: list[int] = Field(max_length=50)  # noqa: N815


class LlmReadingReference(LlmModel):
    title: str = Field(min_length=1, max_length=500)
    authors: str | None = Field(default=None, max_length=500)
    type: ReferenceType = "other"
    segmentIndexes: list[int] = Field(max_length=50)  # noqa: N815


class LlmStructure(LlmModel):
    title: str = Field(min_length=1, max_length=300)
    executiveSummary: str = Field(min_length=1, max_length=4000)  # noqa: N815
    topics: list[LlmTopic] = Field(default_factory=list, max_length=40)
    concepts: list[LlmConcept] = Field(default_factory=list, max_length=60)
    questions: list[LlmQuestion] = Field(default_factory=list, max_length=40)
    readingReferences: list[LlmReadingReference] = Field(  # noqa: N815
        default_factory=list, max_length=30
    )


class LlmMerge(LlmModel):
    title: str = Field(min_length=1, max_length=300)
    executiveSummary: str = Field(min_length=1, max_length=4000)  # noqa: N815
    topics: list[LlmTopic] = Field(default_factory=list, max_length=40)


def response_schema(model: type[BaseModel]) -> dict[str, Any]:
    return model.model_json_schema()


# ----------------------------------------------------------------------------- output
class Subtopic(CamelModel):
    order: int
    title: str
    description: str | None = None
    start_ms: int
    end_ms: int
    segment_indexes: list[int]


class Topic(Subtopic):
    subtopics: list[Subtopic] = Field(default_factory=list)


class Concept(CamelModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    term: str
    definition: str
    example: str | None = None
    segment_indexes: list[int]


class Question(CamelModel):
    question: str
    answer: str | None = None
    asked_by: AskedBy = "unknown"
    segment_indexes: list[int]


class ReadingReference(CamelModel):
    title: str
    authors: str | None = None
    type: ReferenceType = "other"
    segment_indexes: list[int]


class ValidationFlag(CamelModel):
    path: str
    reason: str


class ValidationReport(CamelModel):
    dropped_items: int = 0
    flags: list[ValidationFlag] = Field(default_factory=list)


class Provenance(CamelModel):
    prompt_id: str
    prompt_version: str
    model: str
    processing_version: str
    chunk_count: int = 1
    ai_request_ids: list[str] = Field(default_factory=list)


class LectureStructure(CamelModel):
    lecture_summary_id: str
    transcript_id: str
    scheduled_class_id: str
    institution_id: str | None = None
    class_section_id: str | None = None
    course_id: str | None = None
    course_name: str | None = None
    class_date: str | None = None
    starts_at: str | None = None
    language: str = "pt-BR"
    title: str
    executive_summary: str
    topics: list[Topic]
    concepts: list[Concept]
    questions: list[Question]
    reading_references: list[ReadingReference]
    validation: ValidationReport
    provenance: Provenance
    created_at: str

    def to_json(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


# ------------------------------------------------------------------- assistant (3.13/3.14)
BlockKind = Literal["professor_statement", "ai_explanation"]
Refusal = Literal["no_evidence", "out_of_scope", "injection_suspected"]


class AskRequest(CamelModel):
    question: str = Field(min_length=1, max_length=2000)
    student_id: str = Field(pattern=UUID_PATTERN)
    institution_id: str = Field(pattern=UUID_PATTERN)
    class_section_ids: list[Annotated[str, Field(pattern=UUID_PATTERN)]] = Field(
        min_length=1, max_length=200
    )
    scheduled_class_id: str | None = Field(default=None, pattern=UUID_PATTERN)
    conversation_id: str | None = Field(default=None, pattern=UUID_PATTERN)


class FeedbackRequest(CamelModel):
    answer_id: str = Field(pattern=UUID_PATTERN)
    helpful: bool
    comment: str | None = Field(default=None, max_length=2000)
    student_id: str | None = Field(default=None, pattern=UUID_PATTERN)


class SearchResult(CamelModel):
    transcript_id: str
    scheduled_class_id: str
    class_section_id: str
    segment_index: int
    start_ms: int
    end_ms: int
    text: str
    highlight: str | None = None
    score: float = 0.0
    speaker_label: str | None = None


class LlmAnswerBlock(LlmModel):
    kind: BlockKind
    text: str = Field(min_length=1, max_length=3000)
    citationIds: list[str] = Field(default_factory=list, max_length=10)  # noqa: N815
    quote: str | None = Field(default=None, max_length=1500)


class LlmAnswer(LlmModel):
    answer: list[LlmAnswerBlock] = Field(default_factory=list, max_length=8)
    refusal: Literal["no_evidence", "out_of_scope"] | None = None


class AnswerBlock(CamelModel):
    kind: BlockKind
    text: str
    citation_ids: list[str] = Field(default_factory=list)


class Citation(CamelModel):
    id: str
    scheduled_class_id: str
    transcript_id: str
    segment_index: int
    start_ms: int
    end_ms: int
    quote: str
    class_date: str | None = None
    course_name: str | None = None


class AnswerProvenance(CamelModel):
    prompt_id: str | None = None
    prompt_version: str | None = None
    model: str | None = None


class AssistantAnswer(CamelModel):
    answer_id: str
    conversation_id: str
    answer: list[AnswerBlock]
    citations: list[Citation]
    grounded: bool
    refusal: Refusal | None = None
    provenance: AnswerProvenance
    # Section of the best retrieved passage — for engagement analytics only, never serialised.
    primary_class_section_id: str | None = Field(default=None, exclude=True)

    def to_json(self) -> dict[str, Any]:
        data = self.model_dump(by_alias=True, mode="json")
        for citation in data["citations"]:
            for key in ("classDate", "courseName"):
                if citation.get(key) is None:
                    citation.pop(key, None)
        return data
