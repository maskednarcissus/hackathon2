"""Environment-driven wiring of the production dependencies (integration stage)."""

from __future__ import annotations

import logging
import os

from .http_clients import (
    HttpAcademicClient,
    HttpAuditClient,
    HttpCalendarClient,
    HttpEventBusPublisher,
    HttpGatewayClient,
    HttpTranscriptClient,
    LoggingEventPublisher,
    PubSubEventPublisher,
)
from .models import PublicationPolicy
from .ports import (
    EventPublisher,
    EventRepository,
    InMemoryEventRepository,
    InMemoryProcessedEventStore,
    PolicyProvider,
    ProcessedEventStore,
    StaticPolicyProvider,
)
from .service import Dependencies, Lifecycle

log = logging.getLogger("event_extraction")


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def build_publisher(token: str | None) -> EventPublisher:
    """EVENT_BUS_URL → HTTP dev bus; PUBSUB_PROJECT_ID → Pub/Sub; else logging (§2)."""
    bus = os.environ.get("EVENT_BUS_URL")
    if bus:
        return HttpEventBusPublisher(bus, token)
    project = os.environ.get("PUBSUB_PROJECT_ID")
    if project:
        return PubSubEventPublisher(project)
    return LoggingEventPublisher()


def dependencies_from_env() -> Dependencies:
    extractor = _env("EVENT_EXTRACTOR", "hybrid")
    if extractor not in ("llm", "heuristic", "hybrid"):
        raise ValueError(f"EVENT_EXTRACTOR must be llm|heuristic|hybrid, got {extractor!r}")
    token = os.environ.get("INTERNAL_API_TOKEN") or None
    default_policy = PublicationPolicy(
        auto_publish=_env("AUTO_PUBLISH", "false").lower() == "true",
        auto_publish_min_confidence=float(_env("AUTO_PUBLISH_MIN_CONFIDENCE", "0.92")),
    )

    repository: EventRepository
    policies: PolicyProvider
    processed: ProcessedEventStore
    lifecycle: Lifecycle | None = None
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        from .adapters.postgres import (
            PoolLifecycle,
            PostgresEventRepository,
            PostgresPolicyProvider,
            PostgresProcessedEventStore,
            make_pool,
        )

        pool = make_pool(database_url, max_size=int(_env("DATABASE_POOL_MAX", "10")))
        repository = PostgresEventRepository(pool)
        policies = PostgresPolicyProvider(pool, default_policy)
        processed = PostgresProcessedEventStore(pool)
        lifecycle = PoolLifecycle(pool)
    else:
        log.warning("DATABASE_URL not set: in-memory event store (data is lost on restart)")
        repository = InMemoryEventRepository()
        policies = StaticPolicyProvider(default_policy)
        processed = InMemoryProcessedEventStore()

    return Dependencies(
        repository=repository,
        academic=HttpAcademicClient(
            _env("ACADEMIC_INTEGRATION_URL", "http://localhost:4003"), internal_token=token
        ),
        calendar=HttpCalendarClient(
            _env("CALENDAR_URL", "http://localhost:4005"), internal_token=token
        ),
        transcripts=HttpTranscriptClient(
            _env("TRANSCRIPT_MANAGEMENT_URL", "http://localhost:4008"), internal_token=token
        ),
        publisher=build_publisher(token),
        audit=HttpAuditClient(_env("AUDIT_URL", "http://localhost:4011"), internal_token=token),
        policies=policies,
        gateway=HttpGatewayClient(
            _env("AI_GATEWAY_URL", "http://localhost:8005"), internal_token=token
        ),
        extractor=extractor,  # type: ignore[arg-type]
        prompt_version=os.environ.get("EVENT_EXTRACTION_PROMPT_VERSION"),
        processed=processed,
        internal_token=token,
        lifecycle=lifecycle,
    )
