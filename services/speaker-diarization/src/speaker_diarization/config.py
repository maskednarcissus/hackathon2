"""Environment-driven wiring.

| Variable | Default | Meaning |
|---|---|---|
| ``DATABASE_URL`` | — | Postgres (``speaker_turns``, ``processed_events``); in-memory if unset |
| ``TRANSCRIPT_MANAGEMENT_URL`` | — | transcript-management base URL (in-memory if unset) |
| ``AUDIT_URL`` | — | audit base URL (in-memory if unset) |
| ``EVENT_BUS_URL`` | — | dev/HTTP event bus (integration-stage §2) |
| ``PUBSUB_PROJECT_ID`` | — | Google Pub/Sub publisher (if no ``EVENT_BUS_URL``) |
| ``PUBSUB_TOPIC_TEMPLATE`` | ``{event}`` | Pub/Sub topic name template |
| ``INTERNAL_API_TOKEN`` | — | ``x-internal-token`` required on the event route; sent outbound |
| ``AUDIO_GCS_ENABLED`` | ``false`` | enable ``gs://`` loader (needs ``[gcp]`` extra) |
| ``AUDIO_LOCAL_ROOT`` | — | confine ``file://`` reads to this directory |
| ``DIARIZATION_ENGINE`` | ``v2`` | ``v2`` (Phase 6.1) or ``v1`` (Phase 1, rollback) |
| ``DIARIZATION_DISTANCE_THRESHOLD`` | ``0.30`` | v1 clustering stop distance |
| ``DIARIZATION_MAX_SPEAKERS`` | ``8`` | upper bound on speakers (v2 caps at 8) |
| ``DIARIZATION_MIN_TURN_S`` | ``1.0`` | v2 HMM minimum turn duration |
| ``DIARIZATION_CHUNK_S`` | ``300`` | v2 chunk length for single long files |
"""

from __future__ import annotations

import os

from speaker_diarization.adapters.http import (
    HttpAuditSink,
    HttpEventBusPublisher,
    HttpTranscriptStoreClient,
    LoggingPublisher,
    PubSubPublisher,
)
from speaker_diarization.adapters.memory import (
    InMemoryAuditSink,
    InMemoryProcessedEvents,
    InMemoryTranscriptStore,
    InMemoryTurnRepository,
)
from speaker_diarization.app import AppDeps
from speaker_diarization.audio import (
    AudioLoader,
    GcsAudioLoader,
    LocalAudioLoader,
    RoutingAudioLoader,
)
from speaker_diarization.engine import EngineConfig
from speaker_diarization.engine_v2 import V2Config
from speaker_diarization.ports import (
    AuditSink,
    EventPublisher,
    Lifecycle,
    ProcessedEventStore,
    TranscriptStoreClient,
    TurnRepository,
)
from speaker_diarization.service import DiarizationService


def select_publisher(e: dict[str, str], token: str | None) -> EventPublisher:
    if e.get("EVENT_BUS_URL"):
        return HttpEventBusPublisher(e["EVENT_BUS_URL"], internal_token=token)
    if e.get("PUBSUB_PROJECT_ID"):
        return PubSubPublisher(e["PUBSUB_PROJECT_ID"], e.get("PUBSUB_TOPIC_TEMPLATE", "{event}"))
    return LoggingPublisher()


def deps_from_env(env: dict[str, str] | None = None) -> AppDeps:
    e = dict(os.environ if env is None else env)
    token = e.get("INTERNAL_API_TOKEN") or None
    loaders: dict[str, AudioLoader] = {"file": LocalAudioLoader(e.get("AUDIO_LOCAL_ROOT"))}
    if e.get("AUDIO_GCS_ENABLED", "false").lower() == "true":
        loaders["gs"] = GcsAudioLoader()

    resources: list[Lifecycle] = []
    turns: TurnRepository
    processed: ProcessedEventStore
    if e.get("DATABASE_URL"):
        from speaker_diarization.adapters.postgres import (
            PoolLifecycle,
            PostgresProcessedEvents,
            PostgresTurnRepository,
            make_pool,
        )

        pool = make_pool(e["DATABASE_URL"])
        resources.append(PoolLifecycle(pool))
        turns = PostgresTurnRepository(pool)
        processed = PostgresProcessedEvents(pool)
    else:
        turns = InMemoryTurnRepository()
        processed = InMemoryProcessedEvents()

    store: TranscriptStoreClient = (
        HttpTranscriptStoreClient(e["TRANSCRIPT_MANAGEMENT_URL"], internal_token=token)
        if e.get("TRANSCRIPT_MANAGEMENT_URL")
        else InMemoryTranscriptStore()
    )
    audit: AuditSink = (
        HttpAuditSink(e["AUDIT_URL"], internal_token=token)
        if e.get("AUDIT_URL")
        else InMemoryAuditSink()
    )
    engine = EngineConfig(
        distance_threshold=float(e.get("DIARIZATION_DISTANCE_THRESHOLD", "0.30")),
        max_speakers=int(e.get("DIARIZATION_MAX_SPEAKERS", "8")),
    )
    service = DiarizationService(
        loader=RoutingAudioLoader(loaders),
        store=store,
        publisher=select_publisher(e, token),
        audit=audit,
        engine=engine,
        turns=turns,
        engine_version=e.get("DIARIZATION_ENGINE", "v2"),
        engine_v2=V2Config(
            max_speakers=min(8, int(e.get("DIARIZATION_MAX_SPEAKERS", "8"))),
            min_turn_s=float(e.get("DIARIZATION_MIN_TURN_S", "1.0")),
            chunk_s=float(e.get("DIARIZATION_CHUNK_S", "300")),
        ),
    )
    return AppDeps(
        service=service, processed_events=processed, internal_token=token, resources=resources
    )
