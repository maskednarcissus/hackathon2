"""Storage ports for lecture structures and processed events (in-memory implementations).

Postgres implementations live in :mod:`lecture_intelligence.adapters.postgres`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from lecture_intelligence.models import LectureStructure


class LectureRepository(Protocol):
    async def save(self, structure: LectureStructure) -> None: ...

    async def latest_for_class(self, scheduled_class_id: str) -> LectureStructure | None: ...

    async def get(self, lecture_summary_id: str) -> LectureStructure | None: ...

    async def latest_for_sections(self, class_section_ids: set[str]) -> list[LectureStructure]: ...

    async def retention_candidates(self, institution_id: str, older_than: datetime) -> list[str]:
        """Lecture summary ids of the institution created before ``older_than``."""
        ...

    async def delete(self, lecture_summary_ids: list[str]) -> list[str]:
        """Delete summaries (and their topics, concepts, Q&A, readings); return deleted ids."""
        ...


class InMemoryLectureRepository:
    def __init__(self) -> None:
        self._by_id: dict[str, LectureStructure] = {}
        self._latest: dict[str, str] = {}

    async def save(self, structure: LectureStructure) -> None:
        self._by_id[structure.lecture_summary_id] = structure
        self._latest[structure.scheduled_class_id] = structure.lecture_summary_id

    async def latest_for_class(self, scheduled_class_id: str) -> LectureStructure | None:
        summary_id = self._latest.get(scheduled_class_id)
        return self._by_id.get(summary_id) if summary_id else None

    async def get(self, lecture_summary_id: str) -> LectureStructure | None:
        return self._by_id.get(lecture_summary_id)

    async def latest_for_sections(self, class_section_ids: set[str]) -> list[LectureStructure]:
        latest = (self._by_id[summary_id] for summary_id in self._latest.values())
        return [s for s in latest if s.class_section_id in class_section_ids]

    async def retention_candidates(self, institution_id: str, older_than: datetime) -> list[str]:
        return [
            s.lecture_summary_id
            for s in self._by_id.values()
            if s.institution_id == institution_id
            and datetime.fromisoformat(s.created_at.replace("Z", "+00:00")) < older_than
        ]

    async def delete(self, lecture_summary_ids: list[str]) -> list[str]:
        deleted = [i for i in lecture_summary_ids if self._by_id.pop(i, None) is not None]
        for class_id, summary_id in list(self._latest.items()):
            if summary_id in deleted:
                remaining = [s for s in self._by_id.values() if s.scheduled_class_id == class_id]
                if remaining:
                    newest = max(remaining, key=lambda s: s.created_at)
                    self._latest[class_id] = newest.lecture_summary_id
                else:
                    del self._latest[class_id]
        return deleted


class EventInbox(Protocol):
    """Idempotency store for consumed events (``event_inbox`` table in Postgres)."""

    async def seen(self, event_id: str) -> bool: ...

    async def mark(self, event_id: str, event_type: str) -> None: ...


class InMemoryEventInbox:
    def __init__(self) -> None:
        self._ids: set[str] = set()

    async def seen(self, event_id: str) -> bool:
        return event_id in self._ids

    async def mark(self, event_id: str, event_type: str) -> None:
        self._ids.add(event_id)
