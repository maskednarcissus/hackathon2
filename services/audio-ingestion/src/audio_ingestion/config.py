"""Environment-driven configuration and default dependency wiring."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from audio_ingestion.adapters.event_bus import HttpEventBusPublisher
from audio_ingestion.adapters.http import HttpAuditClient, HttpDeviceKeyResolver
from audio_ingestion.adapters.local_store import EncryptedLocalObjectStore, load_encryption_key
from audio_ingestion.adapters.memory import (
    InMemoryAuditClient,
    LoggingEventPublisher,
    StaticDeviceKeyResolver,
    in_memory_repositories,
)
from audio_ingestion.ports import (
    AuditClient,
    DeviceKeyResolver,
    EventPublisher,
    ObjectStore,
    RecordingRepository,
    UploadRepository,
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class Dependencies:
    recordings: RecordingRepository
    uploads: UploadRepository
    store: ObjectStore
    publisher: EventPublisher
    key_resolver: DeviceKeyResolver
    audit: AuditClient
    staging_dir: Path
    clock: Callable[[], datetime] = field(default=_utcnow)
    internal_token: str | None = None


def _default_dir(env: str, name: str) -> Path:
    value = os.environ.get(env)
    return Path(value) if value else Path(tempfile.gettempdir()) / "ci-audio-ingestion" / name


def dependencies_from_env() -> Dependencies:
    """Wire adapters from environment variables.

    ``AUDIO_STORAGE_BACKEND``  ``local`` (default) | ``gcs``
    ``AUDIO_LOCAL_STORAGE_DIR`` / ``AUDIO_ENCRYPTION_KEY`` (base64, 32 bytes) for ``local``
    ``GCS_AUDIO_BUCKET`` / ``GCS_KMS_KEY_NAME`` / ``GCP_PROJECT_ID`` for ``gcs``
    ``DATABASE_URL``            set → PostgreSQL repositories, unset → in-memory
    ``EVENT_BUS_URL``           set → HTTP event bus; else ``PUBSUB_PROJECT_ID`` → Pub/Sub;
                                else structured-log publisher
    ``INTERNAL_API_TOKEN``      required as ``x-internal-token`` on ``/internal/*`` when set
    ``DEVICE_MANAGEMENT_URL``   base URL; unset → static resolver (no devices, dev only)
    ``AUDIT_URL``               base URL; unset → in-memory audit
    ``UPLOAD_STAGING_DIR``      directory for in-flight chunks
    """
    store: ObjectStore
    if os.environ.get("AUDIO_STORAGE_BACKEND", "local") == "gcs":
        from audio_ingestion.adapters.gcp import GcsObjectStore

        store = GcsObjectStore(
            bucket=os.environ["GCS_AUDIO_BUCKET"],
            kms_key_name=os.environ["GCS_KMS_KEY_NAME"],
            project=os.environ.get("GCP_PROJECT_ID"),
        )
    else:
        store = EncryptedLocalObjectStore(
            _default_dir("AUDIO_LOCAL_STORAGE_DIR", "objects"),
            load_encryption_key(os.environ.get("AUDIO_ENCRYPTION_KEY")),
        )

    internal_token = os.environ.get("INTERNAL_API_TOKEN") or None
    publisher: EventPublisher
    bus_url = os.environ.get("EVENT_BUS_URL")
    pubsub_project = os.environ.get("PUBSUB_PROJECT_ID")
    if bus_url:
        publisher = HttpEventBusPublisher(bus_url, internal_token)
    elif pubsub_project:
        from audio_ingestion.adapters.gcp import PubSubEventPublisher

        publisher = PubSubEventPublisher(pubsub_project)
    else:
        publisher = LoggingEventPublisher()

    recordings: RecordingRepository
    uploads: UploadRepository
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        from audio_ingestion.adapters.postgres import (
            PostgresRecordingRepository,
            PostgresUploadRepository,
            create_pool,
        )

        pool = create_pool(database_url)
        recordings = PostgresRecordingRepository(pool)
        uploads = PostgresUploadRepository(pool)
    else:
        recordings, uploads = in_memory_repositories()

    dm_url = os.environ.get("DEVICE_MANAGEMENT_URL")
    resolver: DeviceKeyResolver = (
        HttpDeviceKeyResolver(dm_url, internal_token) if dm_url else StaticDeviceKeyResolver()
    )
    audit_url = os.environ.get("AUDIT_URL")
    audit: AuditClient = (
        HttpAuditClient(audit_url, internal_token) if audit_url else InMemoryAuditClient()
    )

    return Dependencies(
        recordings=recordings,
        uploads=uploads,
        store=store,
        publisher=publisher,
        key_resolver=resolver,
        audit=audit,
        staging_dir=_default_dir("UPLOAD_STAGING_DIR", "staging"),
        internal_token=internal_token,
    )
