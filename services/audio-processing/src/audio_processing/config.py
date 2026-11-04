"""Environment-driven configuration and default dependency wiring."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from audio_processing.adapters.http import HttpAuditClient
from audio_processing.adapters.local_store import EncryptedLocalObjectStore, load_encryption_key
from audio_processing.adapters.memory import InMemoryAuditClient, LoggingEventPublisher
from audio_processing.ports import AuditClient, EventPublisher, ObjectStore
from audio_processing.segmentation import SegmentationConfig


@dataclass
class Dependencies:
    store: ObjectStore
    publisher: EventPublisher
    audit: AuditClient
    work_dir: Path
    segmentation: SegmentationConfig = field(default_factory=SegmentationConfig)


def dependencies_from_env() -> Dependencies:
    """Wire adapters from the environment.

    Shares the storage settings of audio-ingestion (``AUDIO_STORAGE_BACKEND``,
    ``AUDIO_LOCAL_STORAGE_DIR``, ``AUDIO_ENCRYPTION_KEY``, ``GCS_AUDIO_BUCKET``,
    ``GCS_KMS_KEY_NAME``), plus ``EVENT_PUBLISHER``, ``GCP_PROJECT_ID``, ``AUDIT_URL``,
    ``PROCESSING_WORK_DIR`` and ``SEGMENT_TARGET_SECONDS`` / ``SEGMENT_MAX_SECONDS``.
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

    publisher: EventPublisher
    if os.environ.get("EVENT_PUBLISHER", "log") == "pubsub":
        from audio_processing.adapters.gcp import PubSubEventPublisher

        publisher = PubSubEventPublisher(os.environ["GCP_PROJECT_ID"])
    else:
        publisher = LoggingEventPublisher()

    audit_url = os.environ.get("AUDIT_URL")
    audit: AuditClient = HttpAuditClient(audit_url) if audit_url else InMemoryAuditClient()
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
    )
