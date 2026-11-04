"""Data-owner endpoints for governance (integration stage §5, Phase 4 §5/§6).

* Retention kind ``summary``: lecture summaries and their topics, concepts, Q&A and readings.
* DSR (students): assistant conversations, answers and feedback. Lecture content is not personal
  data of the student and is unaffected.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from lecture_intelligence.assistant_store import AssistantRepository
from lecture_intelligence.models import UUID_PATTERN, CamelModel
from lecture_intelligence.pipeline import PipelineError
from lecture_intelligence.repository import LectureRepository

SERVICE = "lecture-intelligence"
RETENTION_KIND = "summary"
DsrType = Literal["access", "correction", "deletion", "anonymization", "restriction"]


class RetentionDeleteRequest(CamelModel):
    ids: list[str] = Field(max_length=10_000)
    kind: str
    job_id: str | None = None


class DsrRequest(CamelModel):
    subject_type: Literal["student", "professor"]
    subject_id: str = Field(pattern=UUID_PATTERN)
    request_id: str | None = None


def _check_kind(kind: str) -> None:
    if kind != RETENTION_KIND:
        raise PipelineError(
            "unsupported_kind", f"lecture-intelligence owns retention kind {RETENTION_KIND!r}", 400
        )


async def retention_candidates(
    lectures: LectureRepository, institution_id: str, older_than: str, kind: str
) -> dict[str, Any]:
    _check_kind(kind)
    try:
        cutoff = datetime.fromisoformat(older_than.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PipelineError("validation_error", "olderThan must be ISO 8601", 400) from exc
    if cutoff.tzinfo is None:
        raise PipelineError("validation_error", "olderThan must include a UTC offset", 400)
    ids = await lectures.retention_candidates(institution_id, cutoff)
    return {"kind": kind, "institutionId": institution_id, "ids": ids}


async def retention_delete(
    lectures: LectureRepository, req: RetentionDeleteRequest
) -> dict[str, Any]:
    _check_kind(req.kind)
    deleted = await lectures.delete(req.ids)
    return {"kind": req.kind, "jobId": req.job_id, "deletedIds": deleted}


async def handle_dsr(
    store: AssistantRepository, dsr_type: DsrType, req: DsrRequest
) -> dict[str, Any]:
    base: dict[str, Any] = {"service": SERVICE, "requestId": req.request_id}
    if req.subject_type != "student":
        return {**base, "status": "not_applicable", "items": 0, "reason": "no_subject_data"}
    if dsr_type == "access":
        export = await store.export_subject(req.subject_id)
        items = len(export["conversations"]) + len(export["answers"]) + len(export["feedback"])
        return {**base, "status": "completed", "items": items, "export": export}
    if dsr_type == "deletion":
        return {**base, "status": "completed", "items": await store.delete_subject(req.subject_id)}
    if dsr_type == "anonymization":
        count = await store.anonymize_subject(req.subject_id)
        return {**base, "status": "completed", "items": count}
    # Assistant answers are AI output derived from lectures; questions can be deleted/anonymised
    # but there is nothing to correct, and restriction is enforced upstream by identity.
    return {**base, "status": "not_applicable", "items": 0, "reason": f"{dsr_type}_not_supported"}
