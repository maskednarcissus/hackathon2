"""Google Cloud adapters (Cloud Storage with CMEK, Pub/Sub).

The Google client libraries are an optional dependency (``pip install .[gcp]``) and are
imported lazily so the service and its tests run without them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog

from audio_processing.ports import EventEnvelope

log = structlog.get_logger(__name__)


class GcsObjectStore:
    """Cloud Storage object store; objects are encrypted with a customer-managed KMS key."""

    def __init__(self, bucket: str, kms_key_name: str, project: str | None = None) -> None:
        from google.cloud import storage

        self._client: Any = storage.Client(project=project)
        self._bucket: Any = self._client.bucket(bucket)
        self._bucket_name = bucket
        self._kms_key_name = kms_key_name

    def put_file(self, key: str, source: Path, content_type: str) -> str:
        blob = self._bucket.blob(key, kms_key_name=self._kms_key_name)
        # Segments are derived data: re-processing may overwrite them.
        blob.upload_from_filename(str(source), content_type=content_type)
        return f"gs://{self._bucket_name}/{key}"

    def key_of(self, uri: str) -> str:
        prefix = f"gs://{self._bucket_name}/"
        if not uri.startswith(prefix):
            raise ValueError(f"URI {uri} is not in bucket {self._bucket_name}")
        return uri[len(prefix) :]

    def _blob_for(self, uri: str) -> Any:
        return self._bucket.blob(self.key_of(uri))

    def get_to_file(self, uri: str, destination: Path) -> None:
        self._blob_for(uri).download_to_filename(str(destination))

    def exists(self, uri: str) -> bool:
        return bool(self._blob_for(uri).exists())


class PubSubEventPublisher:
    """Publishes each event to the Pub/Sub topic named after the event type (contract §6)."""

    def __init__(self, project_id: str) -> None:
        from google.cloud import pubsub_v1

        self._publisher: Any = pubsub_v1.PublisherClient()
        self._project_id = project_id

    def publish(self, event: EventEnvelope) -> None:
        topic = self._publisher.topic_path(self._project_id, event.type)
        data = json.dumps(event.to_json(), separators=(",", ":")).encode("utf-8")
        future = self._publisher.publish(topic, data, eventType=event.type, eventId=event.event_id)
        future.result(timeout=30)
        log.info("event.published", type=event.type, event_id=event.event_id)
