"""Environment-driven configuration and default dependency wiring."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from audio_processing.adapters.event_bus import HttpEventBusPublisher
from audio_processing.adapters.http import HttpAuditClient
from audio_processing.adapters.local_store import EncryptedLocalObjectStore, load_encryption_key
from audio_processing.adapters.memory import (
    InMemoryAuditClient,
    InMemoryProcessingRepository,
    LoggingEventPublisher,
)
from audio_processing.ports import AuditClient, EventPublisher, ObjectStore, ProcessingRepository
from audio_processing.segmentation import SegmentationConfig


@dataclass
class Dependencies:
    store: ObjectStore
    publisher: EventPublisher
    audit: AuditClient
    work_dir: Path
    segmentation: SegmentationConfig = field(default_factory=SegmentationConfig)
    repository: ProcessingRepository = field(default_factory=InMemoryProcessingRepository)
    internal_token: str | None = None


def dependencies_from_env() -> Dependencies:
    """Wire adapters from the environment.

    Shares the storage settings of audio-ingestion (``AUDIO_STORAGE_BACKEND``,
    ``AUDIO_LOCAL_STORAGE_DIR``, ``AUDIO_ENCRYPTION_KEY``, ``GCS_AUDIO_BUCKET``,
    ``GCS_KMS_KEY_NAME``, ``GCP_PROJECT_ID``), plus ``DATABASE_URL`` (Postgres results and
    ``processed_events``; unset → in-memory), ``EVENT_BUS_URL`` (HTTP event bus) or
    ``PUBSUB_PROJECT_ID`` (Pub/Sub), ``INTERNAL_API_TOKEN`` (required on the event push
    endpoint when set), ``AUDIT_URL``, ``PROCESSING_WORK_DIR`` and
    ``SEGMENT_TARGET_SECONDS`` / ``SEGMENT_MAX_SECONDS``.
    """
    store: ObjectStore
    if os.environ.get("AUDIO_STORAGE_BACKEND", "local") == "gcs":
        from audio_processing.adapters.gcp import GcsObjectStore

        store = GcsObjectStore(
            bucket=os.environ["GCS_AUDIO_BUCKET"],
            kms_key_name=os.environ["GCS_KMS_KEY_NAME"],
            project=os.environ.get("GCP_PROJECT_ID"),
        )
    else:
        root = os.environ.get("AUDIO_LOCAL_STORAGE_DIR")
        store = EncryptedLocalObjectStore(
            Path(root) if root else Path(tempfile.gettempdir()) / "ci-audio-ingestion" / "objects",
            load_encryption_key(os.environ.get("AUDIO_ENCRYPTION_KEY")),
        )

    internal_token = os.environ.get("INTERNAL_API_TOKEN") or None
    publisher: EventPublisher
    bus_url = os.environ.get("EVENT_BUS_URL")
    pubsub_project = os.environ.get("PUBSUB_PROJECT_ID")
    if bus_url:
        publisher = HttpEventBusPublisher(bus_url, internal_token)
    elif pubsub_project:
        from audio_processing.adapters.gcp import PubSubEventPublisher

        publisher = PubSubEventPublisher(pubsub_project)
    else:
        publisher = LoggingEventPublisher()

    repository: ProcessingRepository
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        from audio_processing.adapters.postgres import PostgresProcessingRepository, create_pool

        repository = PostgresProcessingRepository(create_pool(database_url))
    else:
        repository = InMemoryProcessingRepository()

    audit_url = os.environ.get("AUDIT_URL")
    audit: AuditClient = (
        HttpAuditClient(audit_url, internal_token) if audit_url else InMemoryAuditClient()
    )
    work = os.environ.get("PROCESSING_WORK_DIR")
    segmentation = SegmentationConfig(
        target_ms=int(os.environ.get("SEGMENT_TARGET_SECONDS", "300")) * 1000,
        max_ms=int(os.environ.get("SEGMENT_MAX_SECONDS", "360")) * 1000,
    )
    return Dependencies(
        store=store,
        publisher=publisher,
        audit=audit,
        work_dir=Path(work) if work else Path(tempfile.gettempdir()) / "ci-audio-processing",
        segmentation=segmentation,
        repository=repository,
        internal_token=internal_token,
    )
