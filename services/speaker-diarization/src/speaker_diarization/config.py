"""Environment-driven wiring.

| Variable | Default | Meaning |
|---|---|---|
| ``TRANSCRIPT_MANAGEMENT_URL`` | — | transcript-management base URL (in-memory if unset) |
| ``AUDIT_URL`` | — | audit base URL (in-memory if unset) |
| ``EVENT_PUBLISHER`` | ``memory`` | ``pubsub`` or ``memory`` |
| ``GCP_PROJECT_ID`` | — | required for Pub/Sub |
| ``PUBSUB_TOPIC_TEMPLATE`` | ``{event}`` | topic name template |
| ``AUDIO_GCS_ENABLED`` | ``false`` | enable ``gs://`` loader (needs ``[gcp]`` extra) |
| ``AUDIO_LOCAL_ROOT`` | — | confine ``file://`` reads to this directory |
| ``DIARIZATION_DISTANCE_THRESHOLD`` | ``0.30`` | clustering stop distance |
| ``DIARIZATION_MAX_SPEAKERS`` | ``8`` | upper bound on speakers |
"""

from __future__ import annotations

import os

from speaker_diarization.adapters import (
    HttpAuditSink,
    HttpTranscriptStoreClient,
    InMemoryAuditSink,
    InMemoryPublisher,
    InMemoryTranscriptStore,
    PubSubPublisher,
)
from speaker_diarization.app import AppDeps
from speaker_diarization.audio import (
    AudioLoader,
    GcsAudioLoader,
    LocalAudioLoader,
    RoutingAudioLoader,
)
from speaker_diarization.engine import EngineConfig
from speaker_diarization.ports import AuditSink, EventPublisher, TranscriptStoreClient
from speaker_diarization.service import DiarizationService


def deps_from_env(env: dict[str, str] | None = None) -> AppDeps:
    e = dict(os.environ if env is None else env)
    loaders: dict[str, AudioLoader] = {"file": LocalAudioLoader(e.get("AUDIO_LOCAL_ROOT"))}
    if e.get("AUDIO_GCS_ENABLED", "false").lower() == "true":
        loaders["gs"] = GcsAudioLoader()
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
    engine = EngineConfig(
        distance_threshold=float(e.get("DIARIZATION_DISTANCE_THRESHOLD", "0.30")),
        max_speakers=int(e.get("DIARIZATION_MAX_SPEAKERS", "8")),
    )
    return AppDeps(
        service=DiarizationService(
            loader=RoutingAudioLoader(loaders),
            store=store,
            publisher=publisher,
            audit=audit,
            engine=engine,
        )
    )
