"""Diarization v2 (Phase 6.1): spectral clustering, HMM re-segmentation, overlap, linking.

Pipeline (per recording):

1. **Features** — the v1 front-end (log-mel spectral-shape embeddings, energy gate) with a
   finer 0.5 s hop. Windows are grouped in *chunks*: the audio segments produced by
   audio-processing, or fixed ``chunk_s`` slices of a single long file.
2. **Spectral clustering per chunk** — cosine affinity, row-wise p-pruning with the pruning
   ratio auto-selected per chunk (NME-SC style: minimise ``p / eigengap``), symmetric
   normalised Laplacian, **speaker count = argmax eigengap** (capped at ``max_speakers``),
   k-means on the row-normalised spectral embedding. Clusters whose centroids are nearly
   identical are merged (over-splitting guard).
3. **Mixture clusters → overlap** — a small cluster whose centroid is better explained by the
   normalised sum of two other centroids than by any single one is overlapped speech of that
   pair, not a new speaker.
4. **Cross-chunk linking** — chunk-level speakers are joined by average-linkage clustering on
   centroid cosine distance with a *cannot-link* constraint (two speakers of the same chunk
   are never merged). Tiny chunks are attached to the nearest linked speaker afterwards.
5. **HMM / Viterbi re-segmentation** — emissions ``κ·cos(x, μ_k)`` against the linked
   centroids, a duration-expanded state space enforcing ``min_turn_s`` and a switch penalty.
6. **Overlap & confidence** — a frame is overlapped when the second-best posterior is at
   least ``overlap_posterior`` (or it came from a mixture cluster); the second speaker gets
   an ``overlap`` turn. Turn confidence = mean posterior of the assigned speaker.

Output labels are anonymous ``SPEAKER_n`` (first appearance); identity is never inferred.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt

from speaker_diarization.audio import Audio
from speaker_diarization.engine import (
    EngineConfig,
    SegmentSpan,
    WindowFeatures,
    extract_windows,
    speech_mask,
)

FloatArray = npt.NDArray[np.float32]
F64 = npt.NDArray[np.float64]
IntArray = npt.NDArray[np.int64]

ENGINE_VERSION = "diarization-2.0.0"


@dataclass(frozen=True)
class V2Config:
    window_s: float = 1.5
    hop_s: float = 0.5
    max_speakers: int = 8
    max_cluster_points: int = 500
    pruning_candidates: tuple[float, ...] = (0.05, 0.1, 0.15, 0.2, 0.3)
    merge_distance: float = 0.06
    split_distance: float = 0.1
    overlap_margin: float = 0.02
    overlap_penalty: float = 0.0
    link_distance: float = 0.12
    mixture_min_gain: float = 0.08
    mixture_min_similarity: float = 0.9
    mixture_max_fraction: float = 0.3
    min_cluster_windows: int = 3
    min_chunk_windows: int = 8
    chunk_s: float = 300.0
    kappa: float = 40.0
    min_turn_s: float = 1.0
    switch_logprob: float = -6.0
    overlap_posterior: float = 0.25
    seed: int = 0

    def front_end(self) -> EngineConfig:
        return EngineConfig(window_s=self.window_s, hop_s=self.hop_s)


@dataclass(frozen=True)
class TurnV2:
    speaker: str
    start_ms: int
    end_ms: int
    overlap: bool
    confidence: float
    #: True for the turn of the *second* voice inside an overlapped region.
    secondary: bool = False


@dataclass
class DiarizationV2:
    turns: list[TurnV2]
    estimated_speakers: int
    chunk_estimates: list[int] = field(default_factory=list)


# --------------------------------------------------------------------------- utilities


def _normalise(x: F64) -> F64:
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-9)


def _kmeans(x: F64, k: int, rng: np.random.Generator, n_init: int = 8) -> IntArray:
    n = len(x)
    if k <= 1 or n <= k:
        return np.arange(n, dtype=np.int64) % max(k, 1) if n <= k else np.zeros(n, np.int64)
    best: IntArray | None = None
    best_inertia = math.inf
    for _ in range(n_init):
        centres = [x[int(rng.integers(n))]]
        for _ in range(1, k):  # k-means++
            d2 = np.min([np.sum((x - c) ** 2, axis=1) for c in centres], axis=0)
            total = float(d2.sum())
            idx = int(rng.integers(n)) if total <= 0 else int(rng.choice(n, p=d2 / total))
            centres.append(x[idx])
        c = np.stack(centres)
        labels = np.zeros(n, dtype=np.int64)
        for _ in range(50):
            dist = ((x[:, None, :] - c[None, :, :]) ** 2).sum(axis=2)
            new = np.argmin(dist, axis=1).astype(np.int64)
            if np.array_equal(new, labels) and _ > 0:
                break
            labels = new
            for j in range(k):
                members = x[labels == j]
                if len(members):
                    c[j] = members.mean(axis=0)
        inertia = float(((x - c[labels]) ** 2).sum())
        if inertia < best_inertia:
            best_inertia, best = inertia, labels.copy()
    assert best is not None
    return best


def _laplacian_eigs(affinity: F64) -> tuple[F64, F64]:
    deg = affinity.sum(axis=1)
    inv_sqrt = 1.0 / np.sqrt(np.maximum(deg, 1e-12))
    lap = np.eye(len(affinity)) - inv_sqrt[:, None] * affinity * inv_sqrt[None, :]
    values, vectors = np.linalg.eigh(lap)
    return values, vectors


def _pruned_affinity(sim: F64, p: float) -> F64:
    n = len(sim)
    keep = max(2, int(math.ceil(p * n)))
    a = np.clip(sim, 0.0, 1.0)
    if keep < n:
        threshold = np.partition(a, n - keep, axis=1)[:, n - keep][:, None]
        a = np.where(a >= threshold, a, 0.0)
    a = (a + a.T) / 2.0
    np.fill_diagonal(a, 0.0)
    return a


@dataclass(frozen=True)
class SpectralResult:
    labels: IntArray
    k: int
    eigengap: float
    pruning: float


def spectral_cluster(x: F64, cfg: V2Config) -> SpectralResult:
    """Spectral clustering with an eigengap speaker-count estimate (rows of ``x`` unit-norm)."""
    n = len(x)
    if n < 2 * cfg.min_cluster_windows:
        return SpectralResult(np.zeros(n, dtype=np.int64), 1, 0.0, 0.0)
    sim = x @ x.T
    # One speaker: every pair is close — no structure for the eigengap to find.
    if float(np.percentile(1.0 - sim[np.triu_indices(n, 1)], 95)) < cfg.merge_distance:
        return SpectralResult(np.zeros(n, dtype=np.int64), 1, 0.0, 0.0)
    cap = min(cfg.max_speakers, n - 1)
    best: tuple[float, float, int, F64] | None = None  # (ratio, gap, k, vectors)
    for p in cfg.pruning_candidates:
        values, vectors = _laplacian_eigs(_pruned_affinity(sim, p))
        gaps = np.diff(values[: cap + 1])
        k = int(np.argmax(gaps)) + 1
        gap = float(gaps[k - 1])
        ratio = p / max(gap, 1e-6)
        if best is None or ratio < best[0]:
            best = (ratio, gap, k, vectors)
    assert best is not None
    _, gap, k, vectors = best
    best_p = cfg.pruning_candidates[0]
    if k == 1:
        return SpectralResult(np.zeros(n, dtype=np.int64), 1, gap, best_p)
    emb = _normalise(vectors[:, :k])
    labels = _kmeans(emb, k, np.random.default_rng(cfg.seed))
    return SpectralResult(labels, k, gap, best_p)


def _centroids(x: F64, labels: IntArray) -> dict[int, F64]:
    return {int(k): _normalise(x[labels == k].mean(axis=0)) for k in np.unique(labels)}


def _merge_close(x: F64, labels: IntArray, cfg: V2Config) -> IntArray:
    labels = labels.copy()
    while True:
        cents = _centroids(x, labels)
        keys = sorted(cents)
        best: tuple[float, int, int] | None = None
        for i, a in enumerate(keys):
            for b in keys[i + 1 :]:
                d = 1.0 - float(cents[a] @ cents[b])
                if d < cfg.merge_distance and (best is None or d < best[0]):
                    best = (d, a, b)
        if best is None:
            return labels
        labels[labels == best[2]] = best[1]


def _split_heterogeneous(x: F64, labels: IntArray, cfg: V2Config) -> IntArray:
    """Bisect clusters hiding two voices (eigengap under-estimates with tiny clusters).

    A cluster is split with 2-means when both halves have at least ``min_cluster_windows``
    members and their centroids are further apart than ``split_distance``.
    """
    labels = labels.copy()
    rng = np.random.default_rng(cfg.seed)
    changed = True
    while changed and len(np.unique(labels)) < cfg.max_speakers:
        changed = False
        for k in np.unique(labels).tolist():
            rows = np.flatnonzero(labels == k)
            if len(rows) < 2 * cfg.min_cluster_windows:
                continue
            halves = _kmeans(x[rows], 2, rng)
            sizes = np.bincount(halves, minlength=2)
            if sizes.min() < cfg.min_cluster_windows:
                continue
            c0 = _normalise(x[rows[halves == 0]].mean(axis=0))
            c1 = _normalise(x[rows[halves == 1]].mean(axis=0))
            if 1.0 - float(c0 @ c1) > cfg.split_distance:
                labels[rows[halves == 1]] = int(labels.max()) + 1
                changed = True
                break
    return labels


def _absorb_small(x: F64, labels: IntArray, cfg: V2Config) -> IntArray:
    labels = labels.copy()
    while True:
        counts = Counter(labels.tolist())
        small = [k for k, c in counts.items() if c < cfg.min_cluster_windows]
        if not small or len(counts) == 1:
            return labels
        k = min(small, key=lambda s: counts[s])
        cents = _centroids(x, labels)
        others = [o for o in cents if o != k]
        target = max(others, key=lambda o: float(cents[o] @ cents[k]))
        labels[labels == k] = target


def _mixture_pairs(x: F64, labels: IntArray, cfg: V2Config) -> dict[int, tuple[int, int]]:
    """Clusters explained as overlap of two others: ``{cluster: (a, b)}``."""
    cents = _centroids(x, labels)
    if len(cents) < 3:
        return {}
    counts = Counter(labels.tolist())
    n = len(labels)
    out: dict[int, tuple[int, int]] = {}
    # Largest clusters are speakers; test smaller ones against pairs of the rest.
    for c in sorted(cents, key=lambda k: counts[k]):
        if counts[c] > cfg.mixture_max_fraction * n:
            continue
        others = [o for o in cents if o != c and o not in out]
        single = max(float(cents[c] @ cents[o]) for o in others)
        best: tuple[float, int, int] | None = None
        for i, a in enumerate(others):
            for b in others[i + 1 :]:
                mix = _normalise(cents[a] + cents[b])
                sim = float(cents[c] @ mix)
                if (
                    sim >= cfg.mixture_min_similarity
                    and sim > single + cfg.mixture_min_gain
                    and (best is None or sim > best[0])
                ):
                    best = (sim, a, b)
        if best is not None:
            out[c] = (best[1], best[2])
    return out


# --------------------------------------------------------------------------- per chunk


@dataclass
class ChunkSpeakers:
    """Local result of one chunk: window indexes (global), local labels, centroids."""

    index: IntArray
    labels: IntArray
    centroids: dict[int, F64]
    sizes: dict[int, int]
    mixtures: dict[int, tuple[int, int]]
    estimate: int


def cluster_chunk(x: F64, index: IntArray, cfg: V2Config) -> ChunkSpeakers:
    sub = x[index]
    n = len(sub)
    if n > cfg.max_cluster_points:
        pick = np.linspace(0, n - 1, cfg.max_cluster_points).round().astype(np.int64)
    else:
        pick = np.arange(n, dtype=np.int64)
    result = spectral_cluster(sub[pick], cfg)
    # Spectral partition → merge over-split voices → bisect clusters hiding two voices
    # (tiny clusters are invisible to the eigengap) → merge again → absorb noise clusters.
    labels_s = _merge_close(sub[pick], result.labels, cfg)
    labels_s = _split_heterogeneous(sub[pick], labels_s, cfg)
    labels_s = _absorb_small(sub[pick], _merge_close(sub[pick], labels_s, cfg), cfg)
    cents = _centroids(sub[pick], labels_s)
    keys = sorted(cents)
    mat = np.stack([cents[k] for k in keys])
    labels = np.asarray(keys, dtype=np.int64)[np.argmax(sub @ mat.T, axis=1)]
    mixtures = _mixture_pairs(sub, labels, cfg)
    speakers = {k: v for k, v in _centroids(sub, labels).items() if k not in mixtures}
    sizes = {k: int(np.sum(labels == k)) for k in speakers}
    return ChunkSpeakers(index, labels, speakers, sizes, mixtures, len(speakers))


def link_chunks(chunks: list[ChunkSpeakers], cfg: V2Config) -> dict[tuple[int, int], int]:
    """Constrained average-linkage over chunk speakers → ``{(chunk, local): global}``."""
    nodes: list[tuple[int, int]] = [(ci, k) for ci, ch in enumerate(chunks) for k in ch.centroids]
    if not nodes:
        return {}
    vecs = np.stack([chunks[ci].centroids[k] for ci, k in nodes])
    weights = np.array([chunks[ci].sizes[k] for ci, k in nodes], dtype=np.float64)
    clusters: list[list[int]] = [[i] for i in range(len(nodes))]
    dist = 1.0 - vecs @ vecs.T

    def linkage(a: list[int], b: list[int]) -> float:
        w = weights[a][:, None] * weights[b][None, :]
        return float((dist[np.ix_(a, b)] * w).sum() / w.sum())

    def compatible(a: list[int], b: list[int]) -> bool:
        return not ({nodes[i][0] for i in a} & {nodes[j][0] for j in b})

    while len(clusters) > 1:
        best: tuple[float, int, int] | None = None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if compatible(clusters[i], clusters[j]):
                    d = linkage(clusters[i], clusters[j])
                    if best is None or d < best[0]:
                        best = (d, i, j)
        if best is None:
            break
        if best[0] > cfg.link_distance and len(clusters) <= cfg.max_speakers:
            break
        _, i, j = best
        clusters[i] = clusters[i] + clusters[j]
        del clusters[j]
    return {nodes[m]: g for g, members in enumerate(clusters) for m in members}


# --------------------------------------------------------------------------- HMM


def viterbi_min_duration(loglik: F64, min_frames: int, switch_logprob: float) -> IntArray:
    """Viterbi over speakers with a minimum stay of ``min_frames`` frames per turn.

    Each speaker k has ``D = min_frames`` chained sub-states; only the last sub-state may
    loop or switch (penalty ``switch_logprob``) to another speaker's first sub-state.
    """
    t_len, k = loglik.shape
    d = max(1, min_frames)
    if k == 1 or t_len == 0:
        return np.zeros(t_len, dtype=np.int64)
    s = k * d
    neg = -1e18
    delta = np.full(s, neg)
    delta[np.arange(k) * d] = loglik[0]
    back = np.zeros((t_len, s), dtype=np.int64)
    first = np.arange(k) * d
    last = first + d - 1
    # Staying costs nothing (chain moves are free too), so only switches are penalised and
    # the minimum-duration chain is not artificially cheaper than a self-loop.
    stay = 0.0
    for t in range(1, t_len):
        new = np.full(s, neg)
        bp = np.zeros(s, dtype=np.int64)
        # chain progress (sub-state i-1 → i), for i > 0 within each speaker
        if d > 1:
            idx = np.arange(s).reshape(k, d)[:, 1:].ravel()
            new[idx] = delta[idx - 1]
            bp[idx] = idx - 1
        # last sub-state self loop
        loop = delta[last] + stay
        upd = loop > new[last]
        new[last] = np.where(upd, loop, new[last])
        bp[last] = np.where(upd, last, bp[last])
        # switch: best last sub-state of another speaker → first sub-state of k
        lv = delta[last]
        order = np.argsort(lv)[::-1]
        top, second = int(order[0]), int(order[1])
        for spk in range(k):
            src = second if top == spk else top
            cand = lv[src] + switch_logprob
            tgt = first[spk]
            if d == 1:
                if cand > new[tgt]:
                    new[tgt], bp[tgt] = cand, last[src]
            else:
                new[tgt], bp[tgt] = cand, last[src]
        new += np.repeat(loglik[t], d)
        delta = new
        back[t] = bp
    state = int(np.argmax(delta))
    path = np.zeros(t_len, dtype=np.int64)
    for t in range(t_len - 1, -1, -1):
        path[t] = state // d
        state = int(back[t, state]) if t > 0 else state
    return path


def _softmax(z: F64) -> F64:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    out: F64 = e / e.sum(axis=1, keepdims=True)
    return out


# --------------------------------------------------------------------------- top level


def _turn_runs(
    starts: list[int], values: IntArray, conf: F64, cfg: V2Config
) -> list[tuple[int, int, int, float]]:
    """Contiguous runs of equal ``values`` (−1 = none) → ``(start, end, value, confidence)``."""
    hop = int(cfg.hop_s * 1000)
    win = int(cfg.window_s * 1000)
    lead = (win - hop) // 2
    runs: list[tuple[int, int, int, list[float]]] = []
    for i, (start, v) in enumerate(zip(starts, values.tolist(), strict=True)):
        own_s = start if i == 0 or start - starts[i - 1] > hop else start + lead
        own_e = (
            start + win
            if i == len(starts) - 1 or starts[i + 1] - start > hop
            else start + lead + hop
        )
        if v < 0:
            continue
        if runs and runs[-1][2] == v and own_s <= runs[-1][1]:
            prev = runs[-1]
            prev[3].append(float(conf[i]))
            runs[-1] = (prev[0], own_e, v, prev[3])
        else:
            runs.append((own_s, own_e, v, [float(conf[i])]))
    return [(s, e, v, float(np.mean(c))) for s, e, v, c in runs if e > s]


def diarize_windows(
    features: WindowFeatures,
    levels: list[float],
    chunk_ids: list[int],
    cfg: V2Config | None = None,
) -> DiarizationV2:
    config = cfg or V2Config()
    if not features.embeddings:
        return DiarizationV2([], 0)
    mask = speech_mask(levels, config.front_end())
    order = [i for i in np.argsort(np.asarray(features.starts_ms)).tolist() if mask[i]]
    if not order:
        return DiarizationV2([], 0)
    starts = [features.starts_ms[i] for i in order]
    chunk_of = np.asarray([chunk_ids[i] for i in order], dtype=np.int64)
    x = _normalise(np.stack([features.embeddings[i] for i in order]).astype(np.float64))

    # Per-chunk clustering, then cross-chunk linking.
    chunks: list[ChunkSpeakers] = []
    small: list[IntArray] = []
    for cid in sorted(set(chunk_of.tolist())):
        idx = np.flatnonzero(chunk_of == cid).astype(np.int64)
        if len(idx) < config.min_chunk_windows:
            small.append(idx)
            continue
        chunks.append(cluster_chunk(x, idx, config))
    if not chunks:  # everything tiny: treat as one chunk
        chunks.append(cluster_chunk(x, np.arange(len(x), dtype=np.int64), config))
        small = []
    mapping = link_chunks(chunks, config)
    n_global = len(set(mapping.values()))
    cents = np.zeros((n_global, x.shape[1]))
    for (ci, k), g in mapping.items():
        cents[g] += chunks[ci].centroids[k] * chunks[ci].sizes[k]
    cents = _normalise(cents)

    # Frames from mixture clusters are overlap candidates of a known pair.
    forced_pair = np.full((len(x), 2), -1, dtype=np.int64)
    for ci, ch in enumerate(chunks):
        for c, (a, b) in ch.mixtures.items():
            if (ci, a) in mapping and (ci, b) in mapping:
                rows = ch.index[ch.labels == c]
                forced_pair[rows] = (mapping[(ci, a)], mapping[(ci, b)])

    loglik = config.kappa * (x @ cents.T)
    post = _softmax(loglik)
    min_frames = max(1, int(round(config.min_turn_s / config.hop_s)))
    path = viterbi_min_duration(loglik, min_frames, config.switch_logprob)

    # Overlap: second-best posterior high, or mixture-cluster frame.
    secondary = np.full(len(x), -1, dtype=np.int64)
    if n_global > 1:
        masked = post.copy()
        masked[np.arange(len(x)), path] = -1.0
        runner_up = np.argmax(masked, axis=1)
        high = masked[np.arange(len(x)), runner_up] >= config.overlap_posterior
        secondary[high] = runner_up[high]
        has_pair = forced_pair[:, 0] >= 0
        for i in np.flatnonzero(has_pair):
            a, b = int(forced_pair[i, 0]), int(forced_pair[i, 1])
            if path[i] in (a, b):
                secondary[i] = b if path[i] == a else a
            else:
                path[i], secondary[i] = a, b
    primary_conf = post[np.arange(len(x)), path]
    secondary_conf = np.where(secondary >= 0, post[np.arange(len(x)), np.maximum(secondary, 0)], 0)

    raw: list[tuple[int, int, int, float, bool]] = []
    for s, e, v, conf in _turn_runs(starts, path, primary_conf, config):
        raw.append((s, e, v, conf, False))
    for s, e, v, conf in _turn_runs(starts, secondary, secondary_conf, config):
        raw.append((s, e, v, conf, True))
    ov_spans = [(s, e) for s, e, _, _, sec in raw if sec]
    names: dict[int, str] = {}
    turns: list[TurnV2] = []
    for s, e, v, conf, sec in sorted(raw, key=lambda r: (r[0], r[4])):
        if v not in names:
            names[v] = f"SPEAKER_{len(names) + 1}"
        touched = sec or any(min(e, oe) - max(s, os_) > 0 for os_, oe in ov_spans)
        turns.append(TurnV2(names[v], s, e, bool(touched), round(min(1.0, max(0.0, conf)), 3), sec))
    return DiarizationV2(
        turns=turns,
        estimated_speakers=len(names),
        chunk_estimates=[ch.estimate for ch in chunks],
    )


def extract_chunked(
    audio: Audio,
    cfg: V2Config,
    offset_ms: int = 0,
    chunk_id: int | None = None,
    skip_before_ms: int | None = None,
) -> tuple[WindowFeatures, list[float], list[int]]:
    """Window features of one audio buffer; chunk ids = ``chunk_id`` or ``start // chunk_s``."""
    features, levels = extract_windows(audio, cfg.front_end(), offset_ms, skip_before_ms)
    chunk_ms = int(cfg.chunk_s * 1000)
    ids = [
        chunk_id if chunk_id is not None else (s - offset_ms) // chunk_ms
        for s in features.starts_ms
    ]
    return features, levels, ids


def diarize_audio_v2(audio: Audio, cfg: V2Config | None = None) -> DiarizationV2:
    config = cfg or V2Config()
    features, levels, ids = extract_chunked(audio, config)
    return diarize_windows(features, levels, ids, config)


def assign_segments_v2(segments: list[SegmentSpan], turns: list[TurnV2]) -> dict[int, str]:
    """Max-overlap assignment; secondary (overlap) voices count half."""
    out: dict[int, str] = {}
    if not turns:
        return out
    primary = [t for t in turns if not t.secondary] or turns
    for seg in segments:
        score: dict[str, float] = {}
        for t in turns:
            o = min(seg.end_ms, t.end_ms) - max(seg.start_ms, t.start_ms)
            if o > 0:
                score[t.speaker] = score.get(t.speaker, 0.0) + o * (0.5 if t.secondary else 1.0)
        if score:
            out[seg.segment_index] = max(score, key=lambda k: score[k])
        else:
            mid = (seg.start_ms + seg.end_ms) / 2
            out[seg.segment_index] = min(
                primary, key=lambda t: min(abs(mid - t.start_ms), abs(mid - t.end_ms))
            ).speaker
    return out
