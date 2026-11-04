import base64
import json
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from synth import SR, conversation

from speaker_diarization.adapters import (
    InMemoryAuditSink,
    InMemoryPublisher,
    InMemoryTranscriptStore,
    InMemoryTurnRepository,
)
from speaker_diarization.app import AppDeps, create_app
from speaker_diarization.audio import LocalAudioLoader, encode_wav
from speaker_diarization.models import TranscriptSegmentRef
from speaker_diarization.service import DiarizationService, labels_from_provider

INST = "11111111-1111-4111-8111-111111111111"
REC = "44444444-4444-4444-8444-444444444444"


def tid() -> str:
    return str(uuid.uuid4())


class Env:
    def __init__(self, token: str | None = None) -> None:
        self.store = InMemoryTranscriptStore()
        self.publisher = InMemoryPublisher()
        self.audit = InMemoryAuditSink()
        self.turns = InMemoryTurnRepository()
        self.service = DiarizationService(
            loader=LocalAudioLoader(),
            store=self.store,
            publisher=self.publisher,
            audit=self.audit,
            turns=self.turns,
        )
        self.client = TestClient(create_app(AppDeps(service=self.service, internal_token=token)))


def truth_segments(truth: list[tuple[str, int, int]]) -> list[dict[str, Any]]:
    return [
        {"segmentIndex": i, "startMs": start + 200, "endMs": end - 200}
        for i, (_, start, end) in enumerate(truth)
    ]


def completed_event(transcript_id: str, **data: Any) -> dict[str, Any]:
    return {
        "eventId": str(uuid.uuid4()),
        "type": "transcription.completed",
        "occurredAt": "2026-11-04T20:00:00Z",
        "source": "transcription",
        "institutionId": INST,
        "data": {"transcriptId": transcript_id, **data},
    }


def test_provider_tags_are_mapped_without_audio() -> None:
    segs = [
        TranscriptSegmentRef(segment_index=0, start_ms=0, end_ms=1000, speaker_tag=4),
        TranscriptSegmentRef(segment_index=1, start_ms=1000, end_ms=2000, speaker_tag=9),
        TranscriptSegmentRef(segment_index=2, start_ms=2000, end_ms=3000, speaker_tag=9),
    ]
    assert labels_from_provider(segs) == {0: "SPEAKER_1", 1: "SPEAKER_2", 2: "SPEAKER_2"}
    partial = [*segs, TranscriptSegmentRef(segment_index=3, start_ms=3000, end_ms=4000)]
    assert labels_from_provider(partial) is None

    env = Env()
    t = tid()
    resp = env.client.post(
        "/v1/diarizations", json={"transcriptId": t, "segments": [s.dump() for s in segs]}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["method"] == "provider_tags" and body["speakerCount"] == 2
    assert env.store.speakers[t]["speakerCount"] == 2
    assert env.store.speakers[t]["method"] == "provider_tags"
    # Turns derived from labelled segments and persisted.
    turns = env.client.get(f"/v1/diarizations/{t}/turns").json()["turns"]
    assert turns == [
        {"speakerLabel": "SPEAKER_1", "startMs": 0, "endMs": 1000, "overlap": False},
        {"speakerLabel": "SPEAKER_2", "startMs": 1000, "endMs": 3000, "overlap": False},
    ]


def test_inline_wav_acoustic_diarization() -> None:
    audio, truth = conversation([("A", 8), ("B", 8), ("A", 8)])
    env = Env()
    t = tid()
    resp = env.client.post(
        "/v1/diarizations",
        json={
            "transcriptId": t,
            "institutionId": INST,
            "audio": {"wavBase64": base64.b64encode(encode_wav(audio.samples, SR)).decode()},
            "segments": truth_segments(truth),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["method"] == "acoustic_clustering"
    assert [a["speakerLabel"] for a in body["assignments"]] == [
        "SPEAKER_1",
        "SPEAKER_2",
        "SPEAKER_1",
    ]
    assert env.publisher.events == [
        {
            "type": "diarization.completed",
            "data": {"transcriptId": t, "speakerCount": 2, "speakerCountEstimated": 2},
            "institutionId": INST,
        }
    ]
    assert env.audit.records[-1]["action"] == "diarization.completed"
    assert env.store.speakers[t]["processingVersion"].startswith("diarization-")
    stored_turns = env.turns.turns[t]
    assert {x.speaker_label for x in stored_turns} == {"SPEAKER_1", "SPEAKER_2"}
    assert all(x.end_ms > x.start_ms for x in stored_turns)
    # Labels only — nothing that could be a person's identity.
    assert all(a["speakerLabel"].startswith("SPEAKER_") for a in body["assignments"])


def test_transcription_completed_event_with_overlapping_audio_segments(tmp_path: Path) -> None:
    audio, truth = conversation([("A", 12), ("B", 12), ("A", 12), ("B", 12)], seed=9)
    n = len(audio.samples)
    cut = n // 2
    overlap = 2 * SR
    (tmp_path / "0.wav").write_bytes(encode_wav(audio.samples[: cut + overlap], SR))
    (tmp_path / "1.wav").write_bytes(encode_wav(audio.samples[cut:], SR))
    cut_ms = cut * 1000 // SR

    env = Env(token="tok")
    t = tid()
    env.store.segments[t] = [TranscriptSegmentRef.model_validate(s) for s in truth_segments(truth)]
    event = completed_event(
        t,
        recordingSessionId=REC,
        audioSegments=[
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
    )
    push = {"message": {"data": base64.b64encode(json.dumps(event).encode()).decode()}}
    headers = {"x-internal-token": "tok"}
    assert env.client.post("/v1/events/transcription-completed", json=push).status_code == 401
    resp = env.client.post("/v1/events/transcription-completed", json=push, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["speakerCount"] == 2
    labels = [a["speakerLabel"] for a in env.store.speakers[t]["assignments"]]
    assert labels == ["SPEAKER_1", "SPEAKER_2", "SPEAKER_1", "SPEAKER_2"]
    assert env.publisher.events[0]["data"]["recordingSessionId"] == REC

    # Redelivery of the same eventId is a no-op.
    dup = env.client.post("/v1/events/transcription-completed", json=push, headers=headers)
    assert dup.json()["duplicate"] is True
    assert len(env.publisher.events) == 1


def test_errors() -> None:
    env = Env()
    t = tid()
    resp = env.client.post(
        "/v1/diarizations",
        json={"transcriptId": t, "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}]},
    )
    assert resp.status_code == 422
    assert env.audit.records[-1]["action"] == "diarization.failed"

    silent = encode_wav(np.zeros(SR * 5, dtype=np.float32), SR)
    resp = env.client.post(
        "/v1/diarizations",
        json={
            "transcriptId": t,
            "audio": {"wavBase64": base64.b64encode(silent).decode()},
            "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}],
        },
    )
    assert resp.status_code == 422 and "no speech" in resp.json()["detail"]

    both = env.client.post(
        "/v1/diarizations",
        json={
            "transcriptId": t,
            "audio": {"storageUri": "file:///x.wav", "wavBase64": "AA=="},
            "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}],
        },
    )
    assert both.status_code == 422
    bad_id = env.client.post(
        "/v1/diarizations",
        json={"transcriptId": "t1", "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 5}]},
    )
    assert bad_id.status_code == 422

    other = completed_event(t)
    other["type"] = "recording.uploaded"
    resp = env.client.post("/v1/events/transcription-completed", json=other)
    assert resp.status_code == 200 and resp.json()["ignored"] is True

    missing = env.client.post("/v1/events/transcription-completed", json=completed_event(tid()))
    assert missing.status_code == 200 and missing.json()["failed"] is True
    assert env.audit.records[-1]["action"] == "diarization.failed"

    not_uuid = env.client.post("/v1/events/transcription-completed", json=completed_event("abc"))
    assert not_uuid.status_code == 422
    assert env.client.get("/health").json()["status"] == "ok"
