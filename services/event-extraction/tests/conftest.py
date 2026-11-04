from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from event_extraction.app import create_app
from event_extraction.models import ClassContext, PublicationPolicy, ScheduledClassRef
from event_extraction.ports import (
    InMemoryAcademicClient,
    InMemoryAuditClient,
    InMemoryCalendarClient,
    InMemoryEventPublisher,
    InMemoryEventRepository,
    InMemoryTranscriptClient,
    ScriptedGatewayClient,
    StaticPolicyProvider,
)
from event_extraction.service import Dependencies

INSTITUTION = "11111111-1111-4111-8111-111111111111"
COURSE = "22222222-2222-4222-8222-222222222222"
SECTION = "33333333-3333-4333-8333-333333333333"
PROFESSOR = "44444444-4444-4444-8444-444444444444"
CLASS_1 = "55555555-5555-4555-8555-555555555551"
CLASS_2 = "55555555-5555-4555-8555-555555555552"


class FixedClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 3, 10, 22, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


def context(scheduled_class_id: str, class_date: date) -> ClassContext:
    return ClassContext(
        scheduled_class_id=scheduled_class_id,
        class_date=class_date,
        institution_id=INSTITUTION,
        course_id=COURSE,
        course_name="Microeconomia I",
        class_section_id=SECTION,
        professor_id=PROFESSOR,
        upcoming_classes=[
            ScheduledClassRef(scheduled_class_id=f"next-{i}", class_date=d)
            for i, d in enumerate([date(2026, 3, 17), date(2026, 3, 24), date(2026, 3, 31)])
        ],
    )


def segments(*texts: str, confidence: float = 0.95) -> list[dict[str, Any]]:
    return [
        {
            "segmentIndex": i,
            "startMs": i * 10_000,
            "endMs": i * 10_000 + 9_000,
            "text": t,
            "confidence": confidence,
        }
        for i, t in enumerate(texts)
    ]


class Harness:
    def __init__(
        self,
        *,
        policy: PublicationPolicy | None = None,
        gateway: ScriptedGatewayClient | None = None,
        extractor: str = "heuristic",
    ) -> None:
        self.repository = InMemoryEventRepository()
        self.academic = InMemoryAcademicClient(
            {
                CLASS_1: context(CLASS_1, date(2026, 3, 10)),
                CLASS_2: context(CLASS_2, date(2026, 3, 17)),
            }
        )
        self.calendar = InMemoryCalendarClient()
        self.transcripts = InMemoryTranscriptClient()
        self.publisher = InMemoryEventPublisher()
        self.audit = InMemoryAuditClient()
        self.clock = FixedClock()
        self.deps = Dependencies(
            repository=self.repository,
            academic=self.academic,
            calendar=self.calendar,
            transcripts=self.transcripts,
            publisher=self.publisher,
            audit=self.audit,
            policies=StaticPolicyProvider(policy or PublicationPolicy()),
            gateway=gateway,
            clock=self.clock,
            extractor=extractor,  # type: ignore[arg-type]
        )
        self.client = TestClient(create_app(self.deps))

    def extract(self, *texts: str, scheduled_class_id: str = CLASS_1, **extra: Any) -> Any:
        body = {
            "transcriptId": f"t-{scheduled_class_id}",
            "scheduledClassId": scheduled_class_id,
            "recordingSessionId": "rec-1",
            "segments": segments(*texts),
            **extra,
        }
        response = self.client.post("/v1/extractions", json=body)
        assert response.status_code == 201, response.text
        return response.json()


PROF_HEADERS = {"X-Actor-Id": PROFESSOR, "X-Actor-Role": "professor"}


@pytest.fixture
def harness() -> Harness:
    return Harness()


@pytest.fixture
def make_harness() -> Callable[..., Harness]:
    return Harness
