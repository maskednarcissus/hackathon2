from __future__ import annotations

import hashlib
from pathlib import Path

from tests.conftest import Harness, make_device
from tests.helpers import chunks, put_chunk, random_audio, register, start_upload

CHUNK = 64 * 1024


def upload_all(harness: Harness, audio: bytes) -> tuple[str, str]:
    recording_id = register(harness, audio)
    upload = start_upload(harness.signed, recording_id, audio, CHUNK)
    for index, data in enumerate(chunks(audio, CHUNK)):
        assert put_chunk(harness.signed, upload["uploadId"], index, data) == 204
    return recording_id, str(upload["uploadId"])


def test_full_chunked_upload_stores_encrypted_and_publishes(
    harness: Harness, tmp_path: Path
) -> None:
    audio = random_audio(CHUNK * 3 + 1234)
    recording_id, upload_id = upload_all(harness, audio)

    response = harness.signed.post(f"/v1/uploads/{upload_id}/complete")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "complete"
    uri = body["storageUri"]
    institution = harness.device.identity.institution_id
    assert uri == f"local://recordings/{institution}/2026/11/04/{recording_id}.wav"

    # Encrypted at rest: raw bytes differ, decrypted bytes match.
    raw = harness.store.raw_path(uri).read_bytes()
    assert audio not in raw
    assert raw.startswith(b"CIENC1")
    restored = tmp_path / "restored.wav"
    harness.store.get_to_file(uri, restored)
    assert restored.read_bytes() == audio

    events = harness.publisher.of_type("recording.uploaded")
    assert len(events) == 1
    data = events[0].data
    assert data["recordingSessionId"] == recording_id
    assert data["storageUri"] == uri
    assert data["checksumSha256"] == hashlib.sha256(audio).hexdigest()
    assert data["durationMs"] == 90 * 60 * 1000
    envelope = events[0].to_json()
    assert envelope["version"] == 1 and envelope["source"] == "audio-ingestion"

    recording = harness.signed.get(f"/v1/recordings/{recording_id}").json()
    assert recording["uploadStatus"] == "complete"
    assert recording["storageUri"] == uri
    for action in ("upload.started", "upload.completed"):
        assert action in harness.audit.actions()

    # Completing again is idempotent; starting a new upload is refused.
    assert harness.signed.post(f"/v1/uploads/{upload_id}/complete").status_code == 200
    again = harness.signed.post(
        "/v1/uploads",
        json_body={
            "recordingSessionId": recording_id,
            "totalSizeBytes": len(audio),
            "checksumSha256": hashlib.sha256(audio).hexdigest(),
        },
    )
    assert again.status_code == 409


def test_resume_returns_existing_upload_with_received_chunks(harness: Harness) -> None:
    audio = random_audio(CHUNK * 4)
    recording_id = register(harness, audio)
    first = start_upload(harness.signed, recording_id, audio, CHUNK)
    parts = chunks(audio, CHUNK)
    assert put_chunk(harness.signed, first["uploadId"], 0, parts[0]) == 204
    assert put_chunk(harness.signed, first["uploadId"], 2, parts[2]) == 204

    resumed = start_upload(harness.signed, recording_id, audio, CHUNK)
    assert resumed["uploadId"] == first["uploadId"]
    assert resumed["receivedChunks"] == [0, 2]
    status = harness.signed.get(f"/v1/uploads/{first['uploadId']}").json()
    assert status["status"] == "uploading"
    assert status["receivedChunks"] == [0, 2]

    incomplete = harness.signed.post(f"/v1/uploads/{first['uploadId']}/complete")
    assert incomplete.status_code == 409
    assert incomplete.json()["missingChunks"] == [1, 3]

    for index in (1, 3):
        assert put_chunk(harness.signed, first["uploadId"], index, parts[index]) == 204
    done = harness.signed.post(f"/v1/uploads/{first['uploadId']}/complete")
    assert done.json()["status"] == "complete"


def test_chunk_resend_is_idempotent_and_conflict_detected(harness: Harness) -> None:
    audio = random_audio(CHUNK * 2)
    recording_id = register(harness, audio)
    upload = start_upload(harness.signed, recording_id, audio, CHUNK)
    part = audio[:CHUNK]
    assert put_chunk(harness.signed, upload["uploadId"], 0, part) == 204
    assert put_chunk(harness.signed, upload["uploadId"], 0, part) == 204
    assert put_chunk(harness.signed, upload["uploadId"], 0, bytes(CHUNK)) == 409


def test_chunk_validation(harness: Harness) -> None:
    audio = random_audio(CHUNK * 2 + 10)
    recording_id = register(harness, audio)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    assert upload_id
    # wrong size for a non-final chunk
    assert put_chunk(harness.signed, upload_id, 0, audio[:100]) == 422
    # final chunk must be the remainder
    assert put_chunk(harness.signed, upload_id, 2, audio[-10:]) == 204
    # out of range
    assert put_chunk(harness.signed, upload_id, 3, audio[:10]) == 422
    # checksum header must match the body
    bad = harness.signed.put(
        f"/v1/uploads/{upload_id}/chunks/0",
        content=audio[:CHUNK],
        headers={"X-Chunk-SHA256": "0" * 64},
    )
    assert bad.status_code == 422
    assert bad.json()["error"] == "chunk_checksum_mismatch"
    missing_header = harness.signed.put(f"/v1/uploads/{upload_id}/chunks/0", content=audio[:CHUNK])
    assert missing_header.status_code == 422


def test_upload_must_match_recording_metadata(harness: Harness) -> None:
    audio = random_audio(CHUNK)
    recording_id = register(harness, audio)
    response = harness.signed.post(
        "/v1/uploads",
        json_body={
            "recordingSessionId": recording_id,
            "totalSizeBytes": len(audio) + 1,
            "checksumSha256": hashlib.sha256(audio).hexdigest(),
        },
    )
    assert response.status_code == 422
    too_big = harness.signed.post(
        "/v1/uploads",
        json_body={
            "recordingSessionId": recording_id,
            "totalSizeBytes": len(audio),
            "checksumSha256": hashlib.sha256(audio).hexdigest(),
            "chunkSizeBytes": 32 * 1024 * 1024,
        },
    )
    assert too_big.status_code == 422


def test_whole_file_checksum_mismatch_fails_upload(harness: Harness) -> None:
    audio = random_audio(CHUNK * 2)
    recording_id = register(harness, audio)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    # Each chunk is self-consistent but the second one is not the real audio.
    assert put_chunk(harness.signed, upload_id, 0, audio[:CHUNK]) == 204
    assert put_chunk(harness.signed, upload_id, 1, bytes(CHUNK)) == 204

    response = harness.signed.post(f"/v1/uploads/{upload_id}/complete")
    assert response.status_code == 422
    assert response.json()["error"] == "checksum_mismatch"
    status = harness.signed.get(f"/v1/uploads/{upload_id}").json()
    assert status["status"] == "failed"
    failed = harness.publisher.of_type("upload.failed")
    assert len(failed) == 1 and failed[0].data["uploadId"] == upload_id
    assert "upload.failed" in harness.audit.actions()
    assert not harness.publisher.of_type("recording.uploaded")
    assert not (harness.deps.staging_dir / upload_id).exists()

    # A fresh upload can be started after a failure.
    retry = start_upload(harness.signed, recording_id, audio, CHUNK)
    assert retry["uploadId"] != upload_id


def test_uploads_are_private_to_their_device(harness: Harness) -> None:
    audio = random_audio(CHUNK)
    recording_id = register(harness, audio)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    other = harness.sign_as(make_device())
    assert other.get(f"/v1/uploads/{upload_id}").status_code == 404
    assert put_chunk(other, upload_id, 0, audio) == 404
