"""Acoustic speaker diarization (fallback when the STT provider gives no speaker tags).

Pipeline:

1. **Windowing** — 1.5 s analysis windows with a 0.75 s hop.
2. **Speech gating** — windows whose RMS is below
   ``max(abs_floor_dbfs, p90 − relative_floor_db)`` are treated as non-speech.
3. **Embeddings** — 25 ms / 10 ms STFT → 40-band log-mel spectrum (filterbank built
   here, no external DSP dependency); per window: mean log-mel spectrum (spectral shape).
   The per-window mean is removed (loudness invariance) and embeddings are L2-normalised.
   ``distance_threshold`` must be calibrated on the field benchmark corpus.
4. **Clustering** — average-linkage agglomerative clustering on cosine distance; merging
   stops at ``distance_threshold`` unless more than ``max_speakers`` clusters remain.
   Long recordings are clustered on an evenly spaced subsample (``max_cluster_points``)
   and every window is then assigned to the nearest cluster centroid. Clusters smaller
   than ``min_cluster_fraction`` of speech windows are absorbed by their nearest cluster.
5. **Smoothing** — majority filter over consecutive speech windows.
6. **Turns** — each window owns the central ``hop``-long part of its span; adjacent
   windows with the same label merge into a speaker turn.

Labels are relabelled ``SPEAKER_1..n`` by first appearance. Nothing here estimates who
a speaker *is* — only that two stretches of audio sound like the same voice.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt

from speaker_diarization.audio import Audio

FloatArray = npt.NDArray[np.float32]
IntArray = npt.NDArray[np.int64]


@dataclass(frozen=True)
class EngineConfig:
    window_s: float = 1.5
    hop_s: float = 0.75
    frame_s: float = 0.025
    frame_hop_s: float = 0.010
    n_mels: int = 40
    fmin_hz: float = 60.0
    fmax_hz: float = 7600.0
    abs_floor_dbfs: float = -55.0
    relative_floor_db: float = 30.0
    distance_threshold: float = 0.30
    max_speakers: int = 8
    max_cluster_points: int = 600
    min_cluster_fraction: float = 0.03
    smoothing_width: int = 5


@dataclass
class WindowFeatures:
    """Speech windows of one recording: absolute start times (ms) and embeddings."""

    starts_ms: list[int] = field(default_factory=list)
    embeddings: list[FloatArray] = field(default_factory=list)


@dataclass(frozen=True)
class SpeakerTurn:
    speaker: str
    start_ms: int
    end_ms: int


def _hz_to_mel(hz: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def _mel_to_hz(mel: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def mel_filterbank(
    sample_rate: int, n_fft: int, n_mels: int, fmin: float, fmax: float
) -> FloatArray:
    """Triangular HTK-style mel filterbank, shape ``(n_mels, n_fft // 2 + 1)``."""
    fmax = min(fmax, sample_rate / 2)
    mels = np.linspace(_hz_to_mel(np.array(fmin)), _hz_to_mel(np.array(fmax)), n_mels + 2)
    hz = _mel_to_hz(mels)
    bins = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    fb = np.zeros((n_mels, len(bins)), dtype=np.float32)
    for m in range(n_mels):
        lo, center, hi = hz[m], hz[m + 1], hz[m + 2]
        rising = (bins - lo) / max(center - lo, 1e-9)
        falling = (hi - bins) / max(hi - center, 1e-9)
        fb[m] = np.maximum(0.0, np.minimum(rising, falling))
    return fb


def _frame(signal: FloatArray, size: int, hop: int) -> FloatArray:
    if len(signal) < size:
        return np.zeros((0, size), dtype=np.float32)
    count = 1 + (len(signal) - size) // hop
    idx = np.arange(size)[None, :] + hop * np.arange(count)[:, None]
    framed: FloatArray = signal[idx]
    return framed


def log_mel_frames(audio: Audio, cfg: EngineConfig) -> FloatArray:
    sr = audio.sample_rate
    frame_len = int(round(cfg.frame_s * sr))
    frame_hop = int(round(cfg.frame_hop_s * sr))
    n_fft = 1 << max(1, (frame_len - 1).bit_length())
    frames = _frame(audio.samples, frame_len, frame_hop) * np.hanning(frame_len).astype(np.float32)
    if len(frames) == 0:
        return np.zeros((0, cfg.n_mels), dtype=np.float32)
    power = (np.abs(np.fft.rfft(frames, n=n_fft, axis=1)) ** 2).astype(np.float32)
    fb = mel_filterbank(sr, n_fft, cfg.n_mels, cfg.fmin_hz, cfg.fmax_hz)
    return np.log(power @ fb.T + 1e-10).astype(np.float32)


def extract_windows(
    audio: Audio,
    cfg: EngineConfig,
    offset_ms: int = 0,
    skip_before_ms: int | None = None,
) -> tuple[WindowFeatures, list[float]]:
    """Window embeddings for one audio chunk placed at ``offset_ms`` on the timeline.

    Windows whose centre lies before ``skip_before_ms`` (already covered by the previous,
    overlapping chunk) are skipped. Returns features of *all* windows plus their RMS dBFS
    so the caller can apply a recording-wide speech gate.
    """
    sr = audio.sample_rate
    win = int(round(cfg.window_s * sr))
    hop = int(round(cfg.hop_s * sr))
    out = WindowFeatures()
    levels: list[float] = []
    if len(audio.samples) < win:
        return out, levels
    logmel = log_mel_frames(audio, cfg)
    frames_per_s = 1.0 / cfg.frame_hop_s
    for start in range(0, len(audio.samples) - win + 1, hop):
        start_ms = offset_ms + int(start * 1000 / sr)
        center_ms = start_ms + int(cfg.window_s * 500)
        if skip_before_ms is not None and center_ms < skip_before_ms:
            continue
        chunk = audio.samples[start : start + win]
        rms = float(np.sqrt(np.mean(np.square(chunk, dtype=np.float64))))
        levels.append(20.0 * np.log10(max(rms, 1e-10)))
        f0 = int(start / sr * frames_per_s)
        f1 = max(f0 + 1, int((start + win) / sr * frames_per_s) - 2)
        shape = logmel[f0:f1].mean(axis=0)
        # Spectral *shape*: remove overall loudness so distance tracks timbre, not volume.
        emb = (shape - shape.mean()).astype(np.float32)
        out.starts_ms.append(start_ms)
        out.embeddings.append(emb)
    return out, levels


def speech_mask(levels: list[float], cfg: EngineConfig) -> npt.NDArray[np.bool_]:
    arr = np.asarray(levels, dtype=np.float64)
    if arr.size == 0:
        return np.zeros(0, dtype=bool)
    gate = max(cfg.abs_floor_dbfs, float(np.percentile(arr, 90)) - cfg.relative_floor_db)
    mask: npt.NDArray[np.bool_] = arr >= gate
    return mask


def _normalise(x: FloatArray) -> FloatArray:
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return (x / np.maximum(norms, 1e-9)).astype(np.float32)


def agglomerative(x: FloatArray, threshold: float, max_clusters: int) -> IntArray:
    """Average-linkage clustering on cosine distance (rows of ``x`` L2-normalised)."""
    n = len(x)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    if n == 1:
        return np.zeros(1, dtype=np.int64)
    dist = (1.0 - x @ x.T).astype(np.float64)
    np.fill_diagonal(dist, np.inf)
    sizes = np.ones(n, dtype=np.float64)
    active = np.ones(n, dtype=bool)
    members: dict[int, list[int]] = {i: [i] for i in range(n)}
    clusters = n
    while clusters > 1:
        flat = int(np.argmin(dist))
        i, j = divmod(flat, n)
        d = dist[i, j]
        if d > threshold and clusters <= max_clusters:
            break
        # Lance–Williams update for average linkage: merge j into i.
        merged = (sizes[i] * dist[i] + sizes[j] * dist[j]) / (sizes[i] + sizes[j])
        dist[i] = merged
        dist[:, i] = merged
        dist[i, i] = np.inf
        dist[j, :] = np.inf
        dist[:, j] = np.inf
        sizes[i] += sizes[j]
        active[j] = False
        members[i].extend(members.pop(j))
        clusters -= 1
    labels = np.empty(n, dtype=np.int64)
    for label, idxs in enumerate(members.values()):
        labels[idxs] = label
    return labels


def _centroids(x: FloatArray, labels: IntArray) -> tuple[list[int], FloatArray]:
    ids = sorted(set(labels.tolist()))
    cents = np.stack([x[labels == k].mean(axis=0) for k in ids]).astype(np.float32)
    return ids, _normalise(cents)


def cluster_embeddings(embeddings: FloatArray, cfg: EngineConfig) -> IntArray:
    n = len(embeddings)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    x = _normalise(embeddings.astype(np.float32))

    if n > cfg.max_cluster_points:
        sample_idx = np.linspace(0, n - 1, cfg.max_cluster_points).round().astype(np.int64)
    else:
        sample_idx = np.arange(n, dtype=np.int64)
    sample_labels = agglomerative(x[sample_idx], cfg.distance_threshold, cfg.max_speakers)
    ids, cents = _centroids(x[sample_idx], sample_labels)
    labels = np.asarray(ids, dtype=np.int64)[np.argmax(x @ cents.T, axis=1)]

    # Absorb tiny clusters (noise, coughs, chair scrapes) into their nearest neighbour.
    min_size = max(2, int(np.ceil(cfg.min_cluster_fraction * n)))
    while True:
        counts = Counter(labels.tolist())
        if len(counts) <= 1:
            break
        small = [k for k, c in counts.items() if c < min_size]
        if not small:
            break
        smallest = min(small, key=lambda k: counts[k])
        keep = [k for k in counts if k != smallest]
        keep_ids, keep_cents = _centroids(x, labels)
        keep_mask = [i for i, k in enumerate(keep_ids) if k in keep]
        sel = labels == smallest
        nearest = np.argmax(x[sel] @ keep_cents[keep_mask].T, axis=1)
        labels[sel] = np.asarray([keep_ids[i] for i in keep_mask], dtype=np.int64)[nearest]
    return labels


def smooth_labels(labels: IntArray, width: int) -> IntArray:
    if width <= 1 or len(labels) < 3:
        return labels.copy()
    half = width // 2
    out = labels.copy()
    for i in range(len(labels)):
        window = labels[max(0, i - half) : i + half + 1].tolist()
        counts = Counter(window)
        best = max(counts.values())
        # Keep the current label on ties to avoid flip-flopping.
        out[i] = labels[i] if counts[int(labels[i])] == best else counts.most_common(1)[0][0]
    return out


def build_turns(starts_ms: list[int], labels: IntArray, cfg: EngineConfig) -> list[SpeakerTurn]:
    """Merge labelled windows into turns and relabel ``SPEAKER_n`` by first appearance."""
    hop_ms = int(cfg.hop_s * 1000)
    win_ms = int(cfg.window_s * 1000)
    lead = (win_ms - hop_ms) // 2
    raw: list[tuple[int, int, int]] = []
    for idx, (start, label) in enumerate(zip(starts_ms, labels.tolist(), strict=True)):
        own_start = start + lead
        own_end = own_start + hop_ms
        if idx == 0 or start - starts_ms[idx - 1] > hop_ms:
            own_start = start  # first window of a speech run owns its leading edge
        if idx == len(starts_ms) - 1 or starts_ms[idx + 1] - start > hop_ms:
            own_end = start + win_ms
        if raw and raw[-1][2] == label and own_start <= raw[-1][1]:
            raw[-1] = (raw[-1][0], own_end, label)
        else:
            raw.append((own_start, own_end, label))

    names: dict[int, str] = {}
    turns: list[SpeakerTurn] = []
    for start, end, label in raw:
        if label not in names:
            names[label] = f"SPEAKER_{len(names) + 1}"
        turns.append(SpeakerTurn(speaker=names[label], start_ms=start, end_ms=end))
    return turns


def diarize_features(
    features: WindowFeatures, levels: list[float], cfg: EngineConfig
) -> list[SpeakerTurn]:
    if not features.embeddings:
        return []
    mask = speech_mask(levels, cfg)
    order = np.argsort(np.asarray(features.starts_ms))
    starts = [features.starts_ms[i] for i in order if mask[i]]
    if not starts:
        return []
    emb = np.stack([features.embeddings[i] for i in order if mask[i]]).astype(np.float32)
    labels = smooth_labels(cluster_embeddings(emb, cfg), cfg.smoothing_width)
    return build_turns(starts, labels, cfg)


def diarize_audio(audio: Audio, cfg: EngineConfig | None = None) -> list[SpeakerTurn]:
    config = cfg or EngineConfig()
    features, levels = extract_windows(audio, config)
    return diarize_features(features, levels, config)


@dataclass(frozen=True)
class SegmentSpan:
    segment_index: int
    start_ms: int
    end_ms: int


def assign_segments(segments: list[SegmentSpan], turns: list[SpeakerTurn]) -> dict[int, str]:
    """Label each transcript segment with the speaker overlapping it the most."""
    out: dict[int, str] = {}
    if not turns:
        return out
    for seg in segments:
        overlap: Counter[str] = Counter()
        for t in turns:
            o = min(seg.end_ms, t.end_ms) - max(seg.start_ms, t.start_ms)
            if o > 0:
                overlap[t.speaker] += o
        if overlap:
            out[seg.segment_index] = overlap.most_common(1)[0][0]
        else:
            mid = (seg.start_ms + seg.end_ms) / 2
            nearest = min(turns, key=lambda t: min(abs(mid - t.start_ms), abs(mid - t.end_ms)))
            out[seg.segment_index] = nearest.speaker
    return out
