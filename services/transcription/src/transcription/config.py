"""Environment-driven wiring.

| Variable | Default | Meaning |
|---|---|---|
| ``TRANSCRIPTION_PROVIDER`` | ``fake`` | ``google`` or ``fake`` |
| ``GCP_PROJECT_ID`` | — | required for ``google`` provider / Pub/Sub |
| ``SPEECH_LOCATION`` | ``southamerica-east1`` | Speech v2 location |
| ``SPEECH_MODEL`` | ``chirp_2`` | Speech v2 model |
| ``TRANSCRIPT_MANAGEMENT_URL`` | — | transcript-management base URL (in-memory if unset) |
| ``AUDIT_URL`` | — | audit base URL (in-memory if unset) |
| ``EVENT_PUBLISHER`` | ``memory`` | ``pubsub`` or ``memory`` |
| ``PUBSUB_TOPIC_TEMPLATE`` | ``{event}`` | topic name template |
| ``TRANSCRIPTION_VOCABULARY_PATH`` | — | JSON phrase sets (see vocabulary.py) |
| ``TRANSCRIPTION_MAX_CONCURRENCY`` | ``4`` | parallel provider calls per job |
"""

from __future__ import annotations

import os

from transcription.adapters import HttpAuditSink, HttpTranscriptStoreClient, PubSubPublisher
from transcription.app import AppDeps
from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryJobRepository,
    InMemoryPublisher,
    InMemoryTranscriptStore,
)
from transcription.ports import AuditSink, EventPublisher, SpeechProvider, TranscriptStoreClient
from transcription.service import ServiceSettings, TranscriptionService
from transcription.vocabulary import VocabularyCatalog


def deps_from_env(env: dict[str, str] | None = None) -> AppDeps:
    e = dict(os.environ if env is None else env)
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

    store: TranscriptStoreClient = (
        HttpTranscriptStoreClient(e["TRANSCRIPT_MANAGEMENT_URL"])
        if e.get("TRANSCRIPT_MANAGEMENT_URL")
        else InMemoryTranscriptStore()
    )
    audit: AuditSink = HttpAuditSink(e["AUDIT_URL"]) if e.get("AUDIT_URL") else InMemoryAuditSink()
    publisher: EventPublisher = (
        PubSubPublisher(e["GCP_PROJECT_ID"], e.get("PUBSUB_TOPIC_TEMPLATE", "{event}"))
        if e.get("EVENT_PUBLISHER") == "pubsub"
        else InMemoryPublisher()
    )
    service = TranscriptionService(
        provider=provider,
        store=store,
        publisher=publisher,
        audit=audit,
        jobs=InMemoryJobRepository(),
        vocabulary=VocabularyCatalog.load(e.get("TRANSCRIPTION_VOCABULARY_PATH")),
        settings=ServiceSettings(max_concurrency=int(e.get("TRANSCRIPTION_MAX_CONCURRENCY", "4"))),
    )
    return AppDeps(service=service)
