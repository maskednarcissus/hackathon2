from collections import Counter

import numpy as np
import pytest
from synth import SR, conversation

from speaker_diarization.audio import Audio, decode_wav, encode_wav
from speaker_diarization.engine import (
    EngineConfig,
    SegmentSpan,
    SpeakerTurn,
    agglomerative,
    assign_segments,
    diarize_audio,
    mel_filterbank,
    smooth_labels,
)


def frame_purity(
    turns: list[SpeakerTurn], truth: list[tuple[str, int, int]], margin_ms: int = 400
) -> tuple[float, dict[str, str]]:
    """Fraction of 100 ms frames (inside truth turns, away from edges) whose predicted
    label matches the one-to-one best mapping from truth speaker to predicted label."""
    pairs: Counter[tuple[str, str]] = Counter()
    total = 0
    for speaker, start, end in truth:
        for t in range(start + margin_ms, end - margin_ms, 100):
            total += 1
            label = next((x.speaker for x in turns if x.start_ms <= t < x.end_ms), None)
            if label:
                pairs[(speaker, label)] += 1
    mapping: dict[str, str] = {}
    for (speaker, label), _ in pairs.most_common():
        if speaker not in mapping and label not in mapping.values():
            mapping[speaker] = label
    correct = sum(c for (s, lbl), c in pairs.items() if mapping.get(s) == lbl)
    return correct / max(total, 1), mapping


def test_mel_filterbank_shape_and_coverage() -> None:
    fb = mel_filterbank(16_000, 512, 40, 60.0, 7600.0)
    assert fb.shape == (40, 257)
    assert np.all(fb >= 0) and np.all(fb.max(axis=1) > 0.5)


def test_two_speakers_turns_detected() -> None:
    audio, truth = conversation([("A", 10), ("B", 8), ("A", 6), ("B", 7), ("A", 9)])
    turns = diarize_audio(audio)
    purity, mapping = frame_purity(turns, truth)
    assert purity >= 0.9
    assert len({t.speaker for t in turns}) == 2
    assert mapping["A"] == "SPEAKER_1"  # first to speak
    # Turn boundaries land within ~1 window of the true change points.
    changes = [t.start_ms for t in turns[1:]]
    for _, start, _ in truth[1:]:
        assert min(abs(c - start) for c in changes) <= 1_500


def test_three_speakers() -> None:
    audio, truth = conversation(
        [("A", 10), ("C", 8), ("B", 9), ("A", 6), ("C", 7), ("B", 8)], seed=3
    )
    turns = diarize_audio(audio)
    purity, mapping = frame_purity(turns, truth)
    assert purity >= 0.9
    assert len(set(mapping.values())) == 3
    assert len({t.speaker for t in turns}) == 3


def test_single_speaker_gets_one_label_even_with_volume_changes() -> None:
    audio, _ = conversation([("A", 30), ("A", 30)], seed=11)
    half = len(audio.samples) // 2
    samples = audio.samples.copy()
    samples[half:] *= 0.25  # professor walks away from the microphone
    turns = diarize_audio(Audio(samples=samples, sample_rate=SR))
    assert {t.speaker for t in turns} == {"SPEAKER_1"}


def test_background_noise_robustness() -> None:
    audio, truth = conversation([("A", 12), ("B", 12), ("A", 12)], seed=5)
    rng = np.random.default_rng(1)
    noise = rng.standard_normal(len(audio.samples)).astype(np.float32)
    noise = np.convolve(noise, np.ones(8) / 8, mode="same").astype(np.float32)  # HVAC-ish
    noise *= 0.1 * audio.samples.std() / noise.std()  # ≈ 20 dB SNR
    turns = diarize_audio(Audio(samples=audio.samples + noise, sample_rate=SR))
    purity, _ = frame_purity(turns, truth)
    assert purity >= 0.9


def test_silence_yields_no_turns() -> None:
    silence = Audio(samples=np.zeros(SR * 10, dtype=np.float32), sample_rate=SR)
    assert diarize_audio(silence) == []
    short = Audio(samples=np.zeros(SR // 2, dtype=np.float32), sample_rate=SR)
    assert diarize_audio(short) == []


def test_max_speakers_is_enforced() -> None:
    audio, _ = conversation([("A", 8), ("B", 8), ("C", 8)], seed=2)
    turns = diarize_audio(audio, EngineConfig(max_speakers=2))
    assert len({t.speaker for t in turns}) <= 2


def test_agglomerative_threshold() -> None:
    x = np.array([[1, 0], [0.99, 0.14], [0, 1], [0.1, 0.99]], dtype=np.float32)
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    labels = agglomerative(x, threshold=0.3, max_clusters=8)
    assert labels[0] == labels[1] and labels[2] == labels[3] and labels[0] != labels[2]
    assert len(set(agglomerative(x, threshold=0.3, max_clusters=1).tolist())) == 1


def test_smoothing_removes_isolated_flips() -> None:
    labels = np.array([0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1], dtype=np.int64)
    assert smooth_labels(labels, 5).tolist() == [0] * 7 + [1] * 4


def test_assign_segments_by_max_overlap_and_nearest() -> None:
    turns = [SpeakerTurn("SPEAKER_1", 0, 5_000), SpeakerTurn("SPEAKER_2", 5_000, 9_000)]
    segs = [
        SegmentSpan(0, 0, 4_000),
        SegmentSpan(1, 4_000, 8_000),  # 1 s vs 3 s overlap
        SegmentSpan(2, 12_000, 13_000),  # after the last turn → nearest
    ]
    assert assign_segments(segs, turns) == {0: "SPEAKER_1", 1: "SPEAKER_2", 2: "SPEAKER_2"}


def test_wav_roundtrip_and_stereo_downmix() -> None:
    tone = (0.5 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR)).astype(np.float32)
    audio = decode_wav(encode_wav(tone, SR))
    assert audio.sample_rate == SR and audio.duration_ms == 1000
    assert np.allclose(audio.samples, tone, atol=1e-3)

    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(np.array([1000, 3000] * 10, dtype="<i2").tobytes())
    stereo = decode_wav(buf.getvalue())
    assert np.allclose(stereo.samples, 2000 / 32768, atol=1e-6)


def test_invalid_wav() -> None:
    from speaker_diarization.audio import AudioDecodeError

    with pytest.raises(AudioDecodeError):
        decode_wav(b"not a wav")
