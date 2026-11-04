"""Environment-driven wiring.

| Variable | Default | Meaning |
|---|---|---|
| ``DATABASE_URL`` | — | Postgres (jobs, vocabularies, processed events); in-memory if unset |
| ``TRANSCRIPTION_PROVIDER`` | ``fake`` | ``google`` or ``fake`` |
| ``GCP_PROJECT_ID`` | — | required for the ``google`` provider |
| ``SPEECH_LOCATION`` | ``southamerica-east1`` | Speech v2 location |
| ``SPEECH_MODEL`` | ``chirp_2`` | Speech v2 model |
| ``TRANSCRIPT_MANAGEMENT_URL`` | — | transcript-management base URL (in-memory if unset) |
| ``ACADEMIC_INTEGRATION_URL`` | — | class context lookups (skipped if unset) |
| ``AUDIT_URL`` | — | audit base URL (in-memory if unset) |
| ``EVENT_BUS_URL`` | — | dev/HTTP event bus (§2) |
| ``PUBSUB_PROJECT_ID`` | — | Google Pub/Sub publisher (if no ``EVENT_BUS_URL``) |
| ``PUBSUB_TOPIC_TEMPLATE`` | ``{event}`` | Pub/Sub topic name template |
| ``INTERNAL_API_TOKEN`` | — | required ``x-internal-token`` on event push routes; sent outbound |
| ``TRANSCRIPTION_VOCABULARY_PATH`` | ``config/vocabularies.json`` | JSON phrase sets per language |
| ``SPEECH_LANGUAGE_CODES`` | — | JSON map platform language → Chirp code override |
| ``TRANSCRIPTION_MAX_CONCURRENCY`` | ``4`` | parallel provider calls per job |
"""

from __future__ import annotations

import os
from pathlib import Path

from transcription import PROCESSING_VERSION
from transcription.adapters.http import (
    HttpAuditSink,
    HttpClassContextResolver,
    HttpEventBusPublisher,
    HttpTranscriptStoreClient,
    LoggingPublisher,
    PubSubPublisher,
)
from transcription.app import AppDeps
from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryJobRepository,
    InMemoryProcessedEvents,
    InMemoryTranscriptStore,
)
from transcription.languages import parse_overrides
from transcription.ports import (
    AuditSink,
    ClassContextResolver,
    EventPublisher,
    JobRepository,
    Lifecycle,
    ProcessedEventStore,
    SpeechProvider,
    TranscriptStoreClient,
    VocabularySource,
)
from transcription.service import ServiceSettings, TranscriptionService
from transcription.vocabulary import StaticVocabularySource, VocabularyCatalog

#: Built-in per-language academic vocabulary shipped with the service.
DEFAULT_VOCABULARY = Path(__file__).resolve().parents[2] / "config" / "vocabularies.json"


def select_publisher(e: dict[str, str], token: str | None) -> EventPublisher:
    if e.get("EVENT_BUS_URL"):
        return HttpEventBusPublisher(e["EVENT_BUS_URL"], internal_token=token)
    if e.get("PUBSUB_PROJECT_ID"):
        return PubSubPublisher(e["PUBSUB_PROJECT_ID"], e.get("PUBSUB_TOPIC_TEMPLATE", "{event}"))
    return LoggingPublisher()


def deps_from_env(env: dict[str, str] | None = None) -> AppDeps:
    e = dict(os.environ if env is None else env)
    token = e.get("INTERNAL_API_TOKEN") or None

    provider: SpeechProvider
    if e.get("TRANSCRIPTION_PROVIDER", "fake") == "google":
        from transcription.google_provider import GoogleChirpProvider

        provider = GoogleChirpProvider(
            project_id=e["GCP_PROJECT_ID"],
            location=e.get("SPEECH_LOCATION", "southamerica-east1"),
            model=e.get("SPEECH_MODEL", "chirp_2"),
        )
    else:
        provider = FakeSpeechProvider()

    vocab_path = e.get("TRANSCRIPTION_VOCABULARY_PATH") or (
        str(DEFAULT_VOCABULARY) if DEFAULT_VOCABULARY.exists() else None
    )
    catalog = VocabularyCatalog.load(vocab_path)
    resources: list[Lifecycle] = []
    jobs: JobRepository
    vocabulary: VocabularySource
    processed: ProcessedEventStore
    if e.get("DATABASE_URL"):
        from transcription.adapters.postgres import (
            PoolLifecycle,
            PostgresJobRepository,
            PostgresProcessedEvents,
            PostgresVocabularySource,
            make_pool,
        )

        pool = make_pool(e["DATABASE_URL"])
        resources.append(PoolLifecycle(pool))
        jobs = PostgresJobRepository(pool, PROCESSING_VERSION)
        vocabulary = PostgresVocabularySource(pool, catalog)
        processed = PostgresProcessedEvents(pool)
    else:
        jobs = InMemoryJobRepository()
        vocabulary = StaticVocabularySource(catalog)
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
    class_context: ClassContextResolver | None = (
        HttpClassContextResolver(e["ACADEMIC_INTEGRATION_URL"], internal_token=token)
        if e.get("ACADEMIC_INTEGRATION_URL")
        else None
    )
    service = TranscriptionService(
        provider=provider,
        store=store,
        publisher=select_publisher(e, token),
        audit=audit,
        jobs=jobs,
        vocabulary=vocabulary,
        class_context=class_context,
        settings=ServiceSettings(
            max_concurrency=int(e.get("TRANSCRIPTION_MAX_CONCURRENCY", "4")),
            language_codes=parse_overrides(e.get("SPEECH_LANGUAGE_CODES")),
        ),
    )
    return AppDeps(
        service=service, processed_events=processed, internal_token=token, resources=resources
    )
