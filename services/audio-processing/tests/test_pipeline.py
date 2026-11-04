from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from audio_processing.adapters.local_store import EncryptedLocalObjectStore
from audio_processing.adapters.memory import (
    InMemoryAuditClient,
    InMemoryEventPublisher,
    InMemoryProcessingRepository,
)
from audio_processing.app import create_app
from audio_processing.config import Dependencies
from audio_processing.ports import EventPublisher, ObjectStore, ProcessingRepository
from tests.signals import SR, speech_like, to_int16, write_wav

INSTITUTION = str(uuid.uuid4())


@dataclass
class Harness:
    client: TestClient
    store: ObjectStore
    publisher: InMemoryEventPublisher
    audit: InMemoryAuditClient


def make_harness(
    tmp_path: Path,
    store: ObjectStore,
    repository: ProcessingRepository | None = None,
    internal_token: str | None = None,
    publisher: EventPublisher | None = None,
) -> Harness:
    recorder = InMemoryEventPublisher()
    audit = InMemoryAuditClient()
    deps = Dependencies(
        store=store,
        publisher=publisher or recorder,
        audit=audit,
        work_dir=tmp_path / "w",
        repository=repository or InMemoryProcessingRepository(),
        internal_token=internal_token,
    )
    return Harness(TestClient(create_app(deps)), store, recorder, audit)


def upload_recording(store: ObjectStore, path: Path, recording_id: str) -> str:
    key = f"recordings/{INSTITUTION}/2026/11/04/{recording_id}.wav"
    return store.put_file(key, path, "audio/wav")


def uploaded_event(path: Path, uri: str, recording_id: str, **data: Any) -> dict[str, Any]:
    body = path.read_bytes()
    with wave.open(str(path)) as wav:
        rate, channels, frames = wav.getframerate(), wav.getnchannels(), wav.getnframes()
    payload = {
        "recordingSessionId": recording_id,
        "deviceId": str(uuid.uuid4()),
        "classroomId": str(uuid.uuid4()),
        "scheduledClassId": str(uuid.uuid4()),
        "storageUri": uri,
        "sizeBytes": len(body),
        "checksumSha256": hashlib.sha256(body).hexdigest(),
        "sampleRate": rate,
        "channels": channels,
        "durationMs": frames * 1000 // rate,
        "audioFormat": "wav_pcm_s16le",
        "startedAt": "2026-11-04T19:00:00+00:00",
        "endedAt": "2026-11-04T20:30:00+00:00",
        "institutionId": INSTITUTION,
    }
    payload.update(data)
    return {
        "eventId": str(uuid.uuid4()),
        "type": "recording.uploaded",
        "version": 1,
        "occurredAt": "2026-11-04T20:31:00Z",
        "source": "audio-ingestion",
        "institutionId": INSTITUTION,
        "data": payload,
    }


def lecture(tmp_path: Path, minutes: float, seed: int = 0) -> Path:
    rng = np.random.default_rng(seed)
    return write_wav(tmp_path / f"lecture-{seed}.wav", to_int16(speech_like(0, minutes * 60, rng)))


def test_recording_uploaded_is_assessed_segmented_and_published(
    harness: Harness, tmp_path: Path
) -> None:
    path = lecture(tmp_path, 12)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)

    event = uploaded_event(path, uri, recording_id)
    response = harness.client.post("/v1/events/recording-uploaded", json=event)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "segmented"
    assert result["report"]["verdict"] == "good"
    assert len(result["segments"]) == 3

    quality = harness.publisher.of_type("audio.quality_assessed")
    segmented = harness.publisher.of_type("recording.segmented")
    assert len(quality) == 1 and len(segmented) == 1
    assert quality[0].data["report"]["verdict"] == "good"
    assert quality[0].institution_id == INSTITUTION
    data = segmented[0].data
    assert data["recordingSessionId"] == recording_id
    assert data["startedAt"] == "2026-11-04T19:00:00Z"
    assert data["endedAt"] == "2026-11-04T20:30:00Z"
    assert data["institutionId"] == INSTITUTION
    assert "classSectionId" not in data
    assert data["durationMs"] == 12 * 60_000
    prefix = f"mem://recordings/{INSTITUTION}/2026/11/04/{recording_id}/segments/"
    assert [s["storageUri"] for s in data["segments"]] == [f"{prefix}{i:04d}.wav" for i in range(3)]
    assert set(data["segments"][0]) == {"index", "startMs", "endMs", "storageUri"}

    # Each stored segment is a valid WAV with the expected duration.
    total_frames = 0
    for segment in data["segments"]:
        out = tmp_path / "seg.wav"
        harness.store.get_to_file(segment["storageUri"], out)
        with wave.open(str(out)) as wav:
            assert wav.getframerate() == SR
            frames = wav.getnframes()
            assert frames == (segment["endMs"] - segment["startMs"]) * SR // 1000
            total_frames += frames
    assert total_frames == 12 * 60 * SR

    assert harness.audit.actions() == ["audio.quality_assessed", "audio.segmented"]

    # Redelivery of the same event (same eventId) is idempotent.
    again = harness.client.post("/v1/events/recording-uploaded", json=event)
    assert again.status_code == 200
    duplicate = again.json()
    assert duplicate["status"] == "duplicate"
    assert duplicate["report"]["verdict"] == "good"
    assert len(duplicate["segments"]) == 3
    assert len(harness.publisher.events) == 2


def test_unusable_audio_stops_pipeline(harness: Harness, tmp_path: Path) -> None:
    path = write_wav(tmp_path / "silent.wav", np.zeros(SR * 90, dtype=np.int16))
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    response = harness.client.post(
        "/v1/events/recording-uploaded", json=uploaded_event(path, uri, recording_id)
    )
    assert response.json()["status"] == "stopped_unusable"
    assert len(harness.publisher.of_type("audio.quality_assessed")) == 1
    assert harness.publisher.of_type("recording.segmented") == []
    assert harness.audit.records[-1].metadata["pipelineStopped"] is True


def test_pubsub_push_envelope_and_encrypted_store(tmp_path: Path) -> None:
    store = EncryptedLocalObjectStore(tmp_path / "objects", os.urandom(32))
    harness = make_harness(tmp_path, store)
    path = lecture(tmp_path, 7, seed=3)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(store, path, recording_id)
    event = uploaded_event(path, uri, recording_id)
    push = {
        "message": {
            "data": base64.b64encode(json.dumps(event).encode()).decode(),
            "messageId": "1",
        },
        "subscription": "projects/p/subscriptions/audio-processing",
    }
    response = harness.client.post("/v1/events/recording-uploaded", json=push)
    assert response.status_code == 200, response.text
    segments = response.json()["segments"]
    assert len(segments) == 2
    assert segments[0]["storageUri"].startswith("local://recordings/")
    raw = store.raw_path(segments[0]["storageUri"]).read_bytes()
    assert raw.startswith(b"CIENC1")


def test_checksum_mismatch_rejected(harness: Harness, tmp_path: Path) -> None:
    path = lecture(tmp_path, 2)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    event = uploaded_event(path, uri, recording_id, checksumSha256="0" * 64)
    response = harness.client.post("/v1/events/recording-uploaded", json=event)
    assert response.status_code == 422
    assert response.json()["error"] == "checksum_mismatch"
    assert harness.publisher.events == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda e: e.update(type="upload.failed"),
        lambda e: e["data"].pop("storageUri"),
        lambda e: e["data"].update(audioFormat="flac"),
    ],
)
def test_invalid_events_rejected(harness: Harness, tmp_path: Path, mutate: Any) -> None:
    path = lecture(tmp_path, 1)
    event = uploaded_event(path, "mem://x.wav", str(uuid.uuid4()))
    mutate(event)
    assert harness.client.post("/v1/events/recording-uploaded", json=event).status_code == 422


def test_quality_endpoint(harness: Harness, tmp_path: Path) -> None:
    body = lecture(tmp_path, 2).read_bytes()
    response = harness.client.post(
        "/v1/quality", content=body, headers={"Content-Type": "audio/wav"}
    )
    assert response.status_code == 200
    report = response.json()
    assert report["verdict"] == "good"
    assert set(report) == {
        "durationMs",
        "sampleRate",
        "channels",
        "rmsDbfs",
        "peakDbfs",
        "noiseFloorDbfs",
        "snrDb",
        "clippingRatio",
        "silenceRatio",
        "longestSilenceMs",
        "score",
        "verdict",
        "issues",
    }


def test_quality_rejects_non_wav(harness: Harness) -> None:
    response = harness.client.post("/v1/quality", content=b"not audio")
    assert response.status_code == 415
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(1)
        wav.setframerate(8000)
        wav.writeframes(bytes(8000))
    assert harness.client.post("/v1/quality", content=buf.getvalue()).status_code == 415


def test_segmentation_endpoint(harness: Harness, tmp_path: Path) -> None:
    body = lecture(tmp_path, 3).read_bytes()
    response = harness.client.post(
        "/v1/segmentation?recordingSessionId=abc&targetSeconds=60&maxSeconds=80&searchSeconds=5",
        content=body,
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["durationMs"] == 180_000
    assert len(result["segments"]) == 3
    assert result["segments"][0]["storageUri"] == "mem://adhoc/abc/segments/0000.wav"
    assert all(s["endMs"] - s["startMs"] <= 80_000 for s in result["segments"])

    bad = harness.client.post("/v1/segmentation?targetSeconds=60&maxSeconds=30", content=body)
    assert bad.status_code == 422


def test_class_section_is_carried_when_known(harness: Harness, tmp_path: Path) -> None:
    path = lecture(tmp_path, 1)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    section = str(uuid.uuid4())
    event = uploaded_event(path, uri, recording_id, classSectionId=section)
    event["institutionId"] = None  # tenant falls back to data.institutionId
    assert harness.client.post("/v1/events/recording-uploaded", json=event).status_code == 200
    segmented = harness.publisher.of_type("recording.segmented")[0]
    assert segmented.data["classSectionId"] == section
    assert segmented.data["institutionId"] == INSTITUTION
    assert segmented.institution_id == INSTITUTION
