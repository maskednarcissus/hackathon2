"""Adapters: in-memory (``memory``), HTTP / event bus (``http``) and PostgreSQL (``postgres``)."""

from speaker_diarization.adapters.http import (
    HttpAuditSink,
    HttpEventBusPublisher,
    HttpTranscriptStoreClient,
    LoggingPublisher,
    PubSubPublisher,
    build_envelope,
)
from speaker_diarization.adapters.memory import (
    InMemoryAuditSink,
    InMemoryProcessedEvents,
    InMemoryPublisher,
    InMemoryTranscriptStore,
    InMemoryTurnRepository,
)

__all__ = [
    "HttpAuditSink",
    "HttpEventBusPublisher",
    "HttpTranscriptStoreClient",
    "InMemoryAuditSink",
    "InMemoryProcessedEvents",
    "InMemoryPublisher",
    "InMemoryTranscriptStore",
    "InMemoryTurnRepository",
    "LoggingPublisher",
    "PubSubPublisher",
    "build_envelope",
]
