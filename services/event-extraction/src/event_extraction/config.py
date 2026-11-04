"""Environment-driven wiring of the production dependencies."""

from __future__ import annotations

import logging
import os

from .http_clients import (
    HttpAcademicClient,
    HttpAuditClient,
    HttpCalendarClient,
    HttpGatewayClient,
    HttpTranscriptClient,
    LoggingEventPublisher,
    PubSubEventPublisher,
)
from .models import PublicationPolicy
from .ports import EventPublisher, InMemoryEventRepository, StaticPolicyProvider
from .service import Dependencies

log = logging.getLogger("event_extraction")


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def dependencies_from_env() -> Dependencies:
    extractor = _env("EVENT_EXTRACTOR", "hybrid")
    if extractor not in ("llm", "heuristic", "hybrid"):
        raise ValueError(f"EVENT_EXTRACTOR must be llm|heuristic|hybrid, got {extractor!r}")
    publisher: EventPublisher
    project = os.environ.get("GCP_PROJECT_ID")
    if project and _env("EVENT_PUBLISHER", "logging") == "pubsub":
        publisher = PubSubEventPublisher(project)
    else:
        publisher = LoggingEventPublisher()
    policy = PublicationPolicy(
        auto_publish=_env("AUTO_PUBLISH", "false").lower() == "true",
        auto_publish_min_confidence=float(_env("AUTO_PUBLISH_MIN_CONFIDENCE", "0.92")),
    )
    log.warning(
        "event-extraction uses an in-memory event repository; persistence is lost on restart"
    )
    return Dependencies(
        repository=InMemoryEventRepository(),
        academic=HttpAcademicClient(_env("ACADEMIC_INTEGRATION_URL", "http://localhost:4003")),
        calendar=HttpCalendarClient(_env("CALENDAR_URL", "http://localhost:4005")),
        transcripts=HttpTranscriptClient(
            _env("TRANSCRIPT_MANAGEMENT_URL", "http://localhost:4008")
        ),
        publisher=publisher,
        audit=HttpAuditClient(_env("AUDIT_URL", "http://localhost:4011")),
        policies=StaticPolicyProvider(policy),
        gateway=HttpGatewayClient(_env("AI_GATEWAY_URL", "http://localhost:8005")),
        extractor=extractor,  # type: ignore[arg-type]
        prompt_version=os.environ.get("EVENT_EXTRACTION_PROMPT_VERSION"),
    )
