"""Lecture structure storage port (in-memory; Postgres tables: lecture_summaries & children)."""

from __future__ import annotations

from typing import Protocol

from lecture_intelligence.models import LectureStructure


class LectureRepository(Protocol):
    def save(self, structure: LectureStructure) -> None: ...

    def latest_for_class(self, scheduled_class_id: str) -> LectureStructure | None: ...

    def get(self, lecture_summary_id: str) -> LectureStructure | None: ...

    def latest_for_sections(self, class_section_ids: set[str]) -> list[LectureStructure]: ...


class InMemoryLectureRepository:
    def __init__(self) -> None:
        self._by_id: dict[str, LectureStructure] = {}
        self._latest: dict[str, str] = {}

    def save(self, structure: LectureStructure) -> None:
        self._by_id[structure.lecture_summary_id] = structure
        self._latest[structure.scheduled_class_id] = structure.lecture_summary_id

    def latest_for_class(self, scheduled_class_id: str) -> LectureStructure | None:
        summary_id = self._latest.get(scheduled_class_id)
        return self._by_id.get(summary_id) if summary_id else None

    def get(self, lecture_summary_id: str) -> LectureStructure | None:
        return self._by_id.get(lecture_summary_id)

    def latest_for_sections(self, class_section_ids: set[str]) -> list[LectureStructure]:
        latest = (self._by_id[summary_id] for summary_id in self._latest.values())
        return [s for s in latest if s.class_section_id in class_section_ids]
