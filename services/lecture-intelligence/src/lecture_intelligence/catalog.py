"""Lecture library listing (``GET /v1/lectures``) and class metadata resolution."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import structlog

from lecture_intelligence.clients import AcademicClient
from lecture_intelligence.models import LectureStructure
from lecture_intelligence.text import fold

log = structlog.get_logger(__name__)

SUMMARY_PREVIEW_CHARS = 280
DEFAULT_TIMEZONE = "America/Sao_Paulo"

SORT_PATTERN = r"^(recent|oldest|course|title|date_desc|date_asc)$"
SORT_ALIASES: dict[str, str] = {"date_desc": "recent", "date_asc": "oldest"}


def truncate(text: str, limit: int = SUMMARY_PREVIEW_CHARS) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(" ,.;:")
    return f"{cut}…"


def _date_key(structure: LectureStructure) -> str:
    return structure.starts_at or structure.class_date or structure.created_at


def _matches_query(structure: LectureStructure, query: str) -> bool:
    needle = fold(query)
    haystack = " ".join(
        [
            structure.title,
            structure.executive_summary,
            structure.course_name or "",
            *(t.title for t in structure.topics),
            *(c.term for c in structure.concepts),
        ]
    )
    return all(token in fold(haystack) for token in needle.split())


def _in_range(structure: LectureStructure, start: str | None, end: str | None) -> bool:
    if start is None and end is None:
        return True
    day = structure.class_date or (structure.starts_at or "")[:10]
    if not day:
        return False
    return (start is None or day >= start[:10]) and (end is None or day <= end[:10])


def list_lectures(
    structures: list[LectureStructure],
    *,
    query: str | None,
    course_id: str | None,
    start: str | None,
    end: str | None,
    sort: str,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    filtered = [
        s
        for s in structures
        if (course_id is None or s.course_id == course_id)
        and (not query or _matches_query(s, query))
        and _in_range(s, start, end)
    ]
    mode = SORT_ALIASES.get(sort, sort)
    if mode == "oldest":
        filtered.sort(key=_date_key)
    elif mode == "title":
        filtered.sort(key=lambda s: fold(s.title))
    else:
        filtered.sort(key=_date_key, reverse=True)
        if mode == "course":
            filtered.sort(key=lambda s: fold(s.course_name or "￿"))
    total = len(filtered)
    window = filtered[(page - 1) * page_size : page * page_size]
    return {
        "items": [_item(s) for s in window],
        "page": page,
        "pageSize": page_size,
        "total": total,
    }


def _item(s: LectureStructure) -> dict[str, Any]:
    return {
        "lectureSummaryId": s.lecture_summary_id,
        "scheduledClassId": s.scheduled_class_id,
        "transcriptId": s.transcript_id,
        "classSectionId": s.class_section_id,
        "courseId": s.course_id,
        "courseName": s.course_name,
        "classDate": s.class_date,
        "startsAt": s.starts_at,
        "title": s.title,
        "executiveSummary": truncate(s.executive_summary),
        "topicCount": len(s.topics),
        "conceptCount": len(s.concepts),
    }


async def resolve_class_metadata(
    academic: AcademicClient | None, scheduled_class_id: str, transcript: dict[str, Any]
) -> dict[str, str | None]:
    """Combine transcript-management and academic-integration data about a scheduled class."""

    meta: dict[str, str | None] = {
        "class_section_id": transcript.get("classSectionId"),
        "course_id": transcript.get("courseId"),
        "course_name": transcript.get("courseName"),
        "class_date": transcript.get("classDate"),
        "starts_at": transcript.get("startsAt"),
    }
    if academic is None:
        return meta
    try:
        sc = await academic.get_scheduled_class(scheduled_class_id)
    except Exception as exc:  # noqa: BLE001 - metadata is best effort
        log.warning("scheduled_class_lookup_failed", error=str(exc), id=scheduled_class_id)
        return meta
    if not sc:
        return meta
    raw_course = sc.get("course")
    course: dict[str, Any] = raw_course if isinstance(raw_course, dict) else {}
    meta["class_section_id"] = meta["class_section_id"] or sc.get("classSectionId")
    meta["course_id"] = meta["course_id"] or sc.get("courseId") or course.get("id")
    meta["course_name"] = meta["course_name"] or course.get("name")
    starts_at = sc.get("startsAt")
    if isinstance(starts_at, str):
        meta["starts_at"] = meta["starts_at"] or starts_at
        if not meta["class_date"]:
            try:
                tz = ZoneInfo(str(sc.get("timezone") or DEFAULT_TIMEZONE))
                parsed = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
                meta["class_date"] = parsed.astimezone(tz).date().isoformat()
            except (ValueError, KeyError) as exc:
                log.warning("starts_at_unparseable", value=starts_at, error=str(exc))
    return meta
