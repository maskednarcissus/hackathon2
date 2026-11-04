from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime, timedelta
from typing import Any

from tests.conftest import CLASSROOM_ID, Harness, SignedClient


def recording_body(harness: Harness, audio: bytes, **overrides: Any) -> dict[str, Any]:
    started = datetime(2026, 11, 4, 19, 0, tzinfo=UTC)
    body: dict[str, Any] = {
        "deviceId": harness.device.identity.device_id,
        "classroomId": CLASSROOM_ID,
        "startedAt": started.isoformat(),
        "endedAt": (started + timedelta(minutes=90)).isoformat(),
        "audioFormat": "wav_pcm_s16le",
        "sampleRate": 16000,
        "channels": 1,
        "fileSizeBytes": len(audio),
        "checksumSha256": hashlib.sha256(audio).hexdigest(),
        "firmwareVersion": "1.0.0",
        "localRecordingId": "rec-20261104-1900",
    }
    body.update(overrides)
    return body


def random_audio(size: int) -> bytes:
    return os.urandom(size)


def register(harness: Harness, audio: bytes, **overrides: Any) -> str:
    response = harness.signed.post(
        "/v1/recordings", json_body=recording_body(harness, audio, **overrides)
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def start_upload(
    signed: SignedClient, recording_id: str, audio: bytes, chunk_size: int
) -> dict[str, Any]:
    response = signed.post(
        "/v1/uploads",
        json_body={
            "recordingSessionId": recording_id,
            "totalSizeBytes": len(audio),
            "checksumSha256": hashlib.sha256(audio).hexdigest(),
            "chunkSizeBytes": chunk_size,
        },
    )
    assert response.status_code in (200, 201), response.text
    result: dict[str, Any] = response.json()
    return result


def put_chunk(signed: SignedClient, upload_id: str, index: int, data: bytes) -> int:
    response = signed.put(
        f"/v1/uploads/{upload_id}/chunks/{index}",
        content=data,
        headers={
            "X-Chunk-SHA256": hashlib.sha256(data).hexdigest(),
            "Content-Type": "application/octet-stream",
        },
    )
    return response.status_code


def chunks(audio: bytes, size: int) -> list[bytes]:
    return [audio[i : i + size] for i in range(0, len(audio), size)]
