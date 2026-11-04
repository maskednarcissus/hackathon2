import base64
import json
from pathlib import Path
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from synth import SR, conversation

from speaker_diarization.adapters import (
    InMemoryAuditSink,
    InMemoryPublisher,
    InMemoryTranscriptStore,
)
from speaker_diarization.app import AppDeps, create_app
from speaker_diarization.audio import LocalAudioLoader, encode_wav
from speaker_diarization.models import TranscriptSegmentRef
from speaker_diarization.service import DiarizationService, labels_from_provider


class Env:
    def __init__(self) -> None:
        self.store = InMemoryTranscriptStore()
        self.publisher = InMemoryPublisher()
        self.audit = InMemoryAuditSink()
        self.service = DiarizationService(
            loader=LocalAudioLoader(),
            store=self.store,
            publisher=self.publisher,
            audit=self.audit,
        )
        self.client = TestClient(create_app(AppDeps(service=self.service)))


def truth_segments(truth: list[tuple[str, int, int]]) -> list[dict[str, Any]]:
    return [
        {"segmentIndex": i, "startMs": start + 200, "endMs": end - 200}
        for i, (_, start, end) in enumerate(truth)
    ]


def test_provider_tags_are_mapped_without_audio() -> None:
    segs = [
        TranscriptSegmentRef(segment_index=0, start_ms=0, end_ms=1, speaker_tag=4),
        TranscriptSegmentRef(segment_index=1, start_ms=2, end_ms=3, speaker_tag=9),
        TranscriptSegmentRef(segment_index=2, start_ms=4, end_ms=5, speaker_tag=4),
    ]
    assert labels_from_provider(segs) == {0: "SPEAKER_1", 1: "SPEAKER_2", 2: "SPEAKER_1"}
    partial = [*segs, TranscriptSegmentRef(segment_index=3, start_ms=6, end_ms=7)]
    assert labels_from_provider(partial) is None

    env = Env()
    resp = env.client.post(
        "/v1/diarizations",
        json={"transcriptId": "t1", "segments": [s.dump() for s in segs]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["method"] == "provider_tags" and body["speakerCount"] == 2
    assert env.store.speakers["t1"]["speakerCount"] == 2


def test_inline_wav_acoustic_diarization() -> None:
    audio, truth = conversation([("A", 8), ("B", 8), ("A", 8)])
    env = Env()
    resp = env.client.post(
        "/v1/diarizations",
        json={
            "transcriptId": "t2",
            "institutionId": "inst",
            "audio": {"wavBase64": base64.b64encode(encode_wav(audio.samples, SR)).decode()},
            "segments": truth_segments(truth),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["method"] == "acoustic"
    assert [a["speakerLabel"] for a in body["assignments"]] == [
        "SPEAKER_1",
        "SPEAKER_2",
        "SPEAKER_1",
    ]
    assert env.publisher.events == [
        {
            "type": "diarization.completed",
            "data": {"transcriptId": "t2", "speakerCount": 2},
            "institutionId": "inst",
        }
    ]
    assert env.audit.records[-1]["action"] == "diarization.completed"
    # Labels only — nothing that could be a person's identity.
    assert all(a["speakerLabel"].startswith("SPEAKER_") for a in body["assignments"])


def test_transcription_completed_event_with_overlapping_audio_segments(tmp_path: Path) -> None:
    audio, truth = conversation([("A", 12), ("B", 12), ("A", 12), ("B", 12)], seed=9)
    n = len(audio.samples)
    # Two audio segments with a 2 s overlap, as audio-processing produces them.
    cut = n // 2
    overlap = 2 * SR
    first, second = audio.samples[: cut + overlap], audio.samples[cut:]
    (tmp_path / "0.wav").write_bytes(encode_wav(first, SR))
    (tmp_path / "1.wav").write_bytes(encode_wav(second, SR))
    cut_ms = cut * 1000 // SR

    env = Env()
    env.store.segments["t3"] = [
        TranscriptSegmentRef.model_validate(s) for s in truth_segments(truth)
    ]
    event = {
        "eventId": "e",
        "type": "transcription.completed",
        "occurredAt": "2026-11-04T20:00:00Z",
        "source": "transcription",
        "institutionId": "inst",
        "data": {
            "recordingSessionId": "rec",
            "transcriptId": "t3",
            "audioSegments": [
                {
                    "index": 0,
                    "startMs": 0,
                    "endMs": (cut + overlap) * 1000 // SR,
                    "storageUri": f"file://{tmp_path / '0.wav'}",
                },
                {
                    "index": 1,
                    "startMs": cut_ms,
                    "endMs": n * 1000 // SR,
                    "storageUri": str(tmp_path / "1.wav"),
                },
            ],
        },
    }
    push = {"message": {"data": base64.b64encode(json.dumps(event).encode()).decode()}}
    resp = env.client.post("/v1/events/transcription-completed", json=push)
    assert resp.status_code == 200, resp.text
    assert resp.json()["speakerCount"] == 2
    labels = [a["speakerLabel"] for a in env.store.speakers["t3"]["assignments"]]
    assert labels == ["SPEAKER_1", "SPEAKER_2", "SPEAKER_1", "SPEAKER_2"]
    assert env.publisher.events[0]["data"]["recordingSessionId"] == "rec"


def test_errors() -> None:
    env = Env()
    # No tags and no audio → 422 and an audit record.
    resp = env.client.post(
        "/v1/diarizations",
        json={"transcriptId": "t", "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}]},
    )
    assert resp.status_code == 422
    assert env.audit.records[-1]["action"] == "diarization.failed"

    silent = encode_wav(np.zeros(SR * 5, dtype=np.float32), SR)
    resp = env.client.post(
        "/v1/diarizations",
        json={
            "transcriptId": "t",
            "audio": {"wavBase64": base64.b64encode(silent).decode()},
            "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}],
        },
    )
    assert resp.status_code == 422 and "no speech" in resp.json()["detail"]

    both = env.client.post(
        "/v1/diarizations",
        json={
            "transcriptId": "t",
            "audio": {"storageUri": "file:///x.wav", "wavBase64": "AA=="},
            "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}],
        },
    )
    assert both.status_code == 422

    other = env.client.post(
        "/v1/events/transcription-completed",
        json={
            "eventId": "e",
            "type": "recording.uploaded",
            "occurredAt": "2026-11-04T20:00:00Z",
            "source": "x",
            "data": {},
        },
    )
    assert other.status_code == 200 and other.json()["ignored"] is True

    missing = env.client.post(
        "/v1/events/transcription-completed",
        json={
            "eventId": "e",
            "type": "transcription.completed",
            "occurredAt": "2026-11-04T20:00:00Z",
            "source": "x",
            "data": {"transcriptId": "unknown"},
        },
    )
    assert missing.status_code == 200 and missing.json()["failed"] is True
    assert env.client.get("/health").json()["status"] == "ok"
