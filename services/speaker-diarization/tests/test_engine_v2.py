"""Phase 6.1 diarization v2 engine."""

from __future__ import annotations

import base64

import numpy as np
from fastapi.testclient import TestClient
from synth import SR, VOICES, conversation, speak

from speaker_diarization import V1_PROCESSING_VERSION
from speaker_diarization.adapters import (
    InMemoryAuditSink,
    InMemoryPublisher,
    InMemoryTranscriptStore,
)
from speaker_diarization.app import AppDeps, create_app
from speaker_diarization.audio import Audio, LocalAudioLoader, encode_wav
from speaker_diarization.engine_v2 import (
    V2Config,
    diarize_audio_v2,
    spectral_cluster,
    viterbi_min_duration,
)
from speaker_diarization.service import DiarizationService


def mixed(script: list[tuple[str, float]], overlaps: dict[int, str], seed: int = 3) -> Audio:
    """Conversation where item i also contains voice ``overlaps[i]`` (two people at once)."""
    rng = np.random.default_rng(seed)
    parts = []
    for i, (spk, seconds) in enumerate(script):
        chunk = speak(VOICES[spk], seconds, rng)
        if i in overlaps:
            chunk = (chunk + speak(VOICES[overlaps[i]], seconds, rng)) / np.sqrt(2)
        parts += [chunk, (0.0005 * rng.standard_normal(int(0.3 * SR))).astype(np.float32)]
    return Audio(samples=np.concatenate(parts).astype(np.float32), sample_rate=SR)


def test_eigengap_estimates_speaker_count() -> None:
    for script, expected in (
        ([("A", 20)], 1),
        ([("A", 8), ("B", 8), ("A", 6)], 2),
        ([("A", 8), ("C", 8), ("B", 8), ("A", 5), ("C", 5)], 3),
    ):
        audio, _ = conversation(script, seed=len(script))
        assert diarize_audio_v2(audio).estimated_speakers == expected


def test_spectral_cap_and_single_cluster() -> None:
    rng = np.random.default_rng(0)
    centres = np.eye(12)
    x = np.concatenate([c + 0.01 * rng.standard_normal((10, 12)) for c in centres])
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    assert spectral_cluster(x, V2Config(max_speakers=8)).k <= 8
    same = np.ones((30, 12)) + 0.001 * rng.standard_normal((30, 12))
    same /= np.linalg.norm(same, axis=1, keepdims=True)
    assert spectral_cluster(same, V2Config()).k == 1


def test_viterbi_enforces_minimum_turn_duration() -> None:
    # Speaker 0 throughout with a one-frame blip of speaker 1.
    ll = np.zeros((20, 2))
    ll[:, 0] = 1.0
    ll[10] = [0.0, 3.0]
    assert viterbi_min_duration(ll, 1, -1.0)[10] == 1
    assert set(viterbi_min_duration(ll, 3, -1.0).tolist()) == {0}
    # A genuine 4-frame turn survives a 3-frame minimum.
    ll[10:14] = [0.0, 3.0]
    path = viterbi_min_duration(ll, 3, -1.0)
    assert path[10:14].tolist() == [1, 1, 1, 1] and path[0] == 0 and path[-1] == 0


def test_overlap_turns_and_confidence() -> None:
    audio = mixed([("A", 10), ("A", 3), ("B", 10), ("C", 9)], {1: "B"})
    result = diarize_audio_v2(audio)
    assert result.estimated_speakers == 3
    overlapped = [t for t in result.turns if t.overlap]
    assert overlapped, "overlapped speech must be flagged"
    secondary = [t for t in overlapped if t.secondary]
    # The overlap lies at ~10.3–13.3 s; the secondary voice is B (second to appear).
    assert any(9_500 <= t.start_ms <= 11_500 and t.speaker == "SPEAKER_2" for t in secondary)
    assert all(0.0 <= t.confidence <= 1.0 for t in result.turns)
    assert all(t.speaker.startswith("SPEAKER_") for t in result.turns)


def test_cross_chunk_linking_keeps_labels_consistent() -> None:
    audio, truth = conversation([("A", 25), ("B", 15), ("A", 20), ("B", 15)], seed=12)
    result = diarize_audio_v2(audio, V2Config(chunk_s=20.0))
    assert len(result.chunk_estimates) >= 3
    assert result.estimated_speakers == 2
    by_truth: dict[str, set[str]] = {}
    for spk, start, end in truth:
        mid = (start + end) // 2
        label = next(t.speaker for t in result.turns if t.start_ms <= mid < t.end_ms)
        by_truth.setdefault(spk, set()).add(label)
    assert by_truth == {"A": {"SPEAKER_1"}, "B": {"SPEAKER_2"}}


def _client(engine: str) -> tuple[TestClient, InMemoryTranscriptStore]:
    store = InMemoryTranscriptStore()
    service = DiarizationService(
        loader=LocalAudioLoader(),
        store=store,
        publisher=InMemoryPublisher(),
        audit=InMemoryAuditSink(),
        engine_version=engine,
    )
    return TestClient(create_app(AppDeps(service=service))), store


def test_api_exposes_v2_fields_and_v1_rollback() -> None:
    audio = mixed([("A", 8), ("B", 8), ("B", 3), ("A", 8)], {2: "A"}, seed=5)
    wav = base64.b64encode(encode_wav(audio.samples, SR)).decode()
    body = {
        "transcriptId": "66666666-6666-4666-8666-666666666666",
        "audio": {"wavBase64": wav},
        "segments": [
            {"segmentIndex": 0, "startMs": 300, "endMs": 7_800},
            {"segmentIndex": 1, "startMs": 8_600, "endMs": 16_000},
            {"segmentIndex": 2, "startMs": 20_200, "endMs": 27_800},
        ],
    }
    client, store = _client("v2")
    out = client.post("/v1/diarizations", json=body).json()
    assert out["processingVersion"] == "diarization-2.0.0"
    assert out["speakerCountEstimated"] == 2
    assert [a["speakerLabel"] for a in out["assignments"]] == [
        "SPEAKER_1",
        "SPEAKER_2",
        "SPEAKER_1",
    ]
    assert any(t["overlap"] for t in out["turns"])
    assert all("confidence" in t for t in out["turns"])

    v1, v1_store = _client("v1")
    old = v1.post("/v1/diarizations", json=body).json()
    assert old["processingVersion"] == V1_PROCESSING_VERSION
    assert "speakerCountEstimated" not in old
    assert v1_store.speakers[body["transcriptId"]]["processingVersion"] == V1_PROCESSING_VERSION
