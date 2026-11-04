"""FLAC input (Phase 6.10): decoded with soundfile, analysed and segmented like WAV."""

from __future__ import annotations

import hashlib
import uuid
import wave
from pathlib import Path

import numpy as np
import soundfile

from audio_processing.decode import flac_to_wav, sniff_format
from tests.signals import SR, speech_like, to_int16, write_wav
from tests.test_pipeline import Harness, upload_recording, uploaded_event


def write_flac(path: Path, samples: np.ndarray, subtype: str = "PCM_16") -> Path:
    soundfile.write(str(path), samples, SR, format="FLAC", subtype=subtype)
    return path


def test_flac_decodes_to_identical_pcm(tmp_path: Path) -> None:
    rng = np.random.default_rng(20)
    pcm = to_int16(speech_like(0, 5, rng))
    flac = write_flac(tmp_path / "a.flac", pcm)
    assert sniff_format(flac) == "flac"
    assert flac.stat().st_size < pcm.nbytes  # actually compressed
    out = tmp_path / "a.wav"
    flac_to_wav(flac, out)
    with wave.open(str(out)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, SR)
        decoded = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    assert np.array_equal(decoded, pcm)  # lossless


def test_24_bit_multichannel_flac(tmp_path: Path) -> None:
    rng = np.random.default_rng(21)
    mono = speech_like(0, 3, rng) / 32768.0
    four = np.column_stack([mono] * 4).astype(np.float32)
    flac = tmp_path / "gen2.flac"
    soundfile.write(str(flac), four, SR, format="FLAC", subtype="PCM_24")
    out = tmp_path / "gen2.wav"
    flac_to_wav(flac, out)
    with wave.open(str(out)) as wav:
        assert wav.getnchannels() == 4 and wav.getsampwidth() == 2
        assert wav.getnframes() == 3 * SR


def test_quality_endpoint_accepts_flac(harness: Harness, tmp_path: Path) -> None:
    rng = np.random.default_rng(22)
    flac = write_flac(tmp_path / "q.flac", to_int16(speech_like(0, 120, rng)))
    response = harness.client.post(
        "/v1/quality", content=flac.read_bytes(), headers={"Content-Type": "audio/flac"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["verdict"] == "good"
    assert response.json()["durationMs"] == 120_000


def test_flac_recording_pipeline(harness: Harness, tmp_path: Path) -> None:
    rng = np.random.default_rng(23)
    pcm = to_int16(speech_like(0, 7 * 60, rng))
    flac = write_flac(tmp_path / "lecture.flac", pcm)
    reference = write_wav(tmp_path / "lecture.wav", pcm)
    recording_id = str(uuid.uuid4())
    key = f"recordings/inst/2026/11/04/{recording_id}.flac"
    uri = harness.store.put_file(key, flac, "audio/flac")
    event = uploaded_event(
        flac,
        uri,
        recording_id,
        audioFormat="flac",
        sampleRate=SR,
        channels=1,
        durationMs=7 * 60_000,
    )
    response = harness.client.post("/v1/events/recording-uploaded", json=event)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "segmented"
    assert len(result["segments"]) == 2
    # Segments are WAV PCM regardless of the input codec, under the recording prefix.
    first = result["segments"][0]["storageUri"]
    assert first == f"mem://recordings/inst/2026/11/04/{recording_id}/segments/0000.wav"
    out = tmp_path / "seg.wav"
    harness.store.get_to_file(first, out)
    with wave.open(str(out)) as wav, wave.open(str(reference)) as ref:
        frames = wav.getnframes()
        assert wav.readframes(frames) == ref.readframes(frames)


def test_corrupt_flac_rejected(harness: Harness, tmp_path: Path) -> None:
    bad = tmp_path / "bad.flac"
    bad.write_bytes(b"fLaC" + bytes(100))
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, bad, recording_id)
    payload = {
        "eventId": str(uuid.uuid4()),
        "type": "recording.uploaded",
        "version": 1,
        "occurredAt": "2026-11-04T20:31:00Z",
        "source": "audio-ingestion",
        "institutionId": None,
        "data": {
            "recordingSessionId": recording_id,
            "deviceId": str(uuid.uuid4()),
            "classroomId": str(uuid.uuid4()),
            "storageUri": uri,
            "sizeBytes": 104,
            "checksumSha256": hashlib.sha256(bad.read_bytes()).hexdigest(),
            "sampleRate": SR,
            "channels": 1,
            "durationMs": 1000,
            "audioFormat": "flac",
        },
    }
    response = harness.client.post("/v1/events/recording-uploaded", json=payload)
    assert response.status_code == 422
    assert response.json()["error"] == "undecodable_audio"
    assert harness.client.post("/v1/quality", content=bad.read_bytes()).status_code == 415
