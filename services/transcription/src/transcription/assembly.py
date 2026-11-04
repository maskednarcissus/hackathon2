"""Turn per-segment provider words into contract §8 transcript segments.

Steps:
1. Offset every word by its audio segment's ``startMs`` (provider times are relative).
2. Resolve overlaps between consecutive audio segments: audio-processing cuts long
   recordings with a small overlap so no word is lost at a boundary. Inside an overlap
   ``[next.startMs, prev.endMs]`` we cut at the midpoint — words of the earlier segment
   whose midpoint is before the cut are kept, and words of the later segment from the
   cut onwards.
3. Group words into transcript segments at sentence punctuation, at pauses longer than
   ``max_pause_ms`` or when a segment would exceed ``max_segment_ms``.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from transcription.models import AudioSegmentRef, TranscriptSegment, Word

SENTENCE_END = (".", "?", "!", "…")


@dataclass(frozen=True)
class GroupingConfig:
    max_pause_ms: int = 1200
    max_segment_ms: int = 30_000


def offset_words(segment: AudioSegmentRef, words: list[Word]) -> list[Word]:
    out: list[Word] = []
    for w in words:
        start = segment.start_ms + w.start_ms
        end = max(start, segment.start_ms + w.end_ms)
        out.append(w.model_copy(update={"start_ms": start, "end_ms": end}))
    return out


def _mid(w: Word) -> float:
    return (w.start_ms + w.end_ms) / 2


def merge_segment_words(
    per_segment: list[tuple[AudioSegmentRef, list[Word]]],
) -> list[Word]:
    """Merge absolute-time words from ordered audio segments, de-duplicating overlaps."""
    ordered = sorted(per_segment, key=lambda item: item[0].start_ms)
    merged: list[Word] = []
    prev_seg: AudioSegmentRef | None = None
    for seg, words in ordered:
        words = sorted(words, key=lambda w: (w.start_ms, w.end_ms))
        if prev_seg is not None and seg.start_ms < prev_seg.end_ms:
            cut = (seg.start_ms + prev_seg.end_ms) / 2
            merged = [w for w in merged if _mid(w) < cut]
            words = [w for w in words if _mid(w) >= cut]
        merged.extend(words)
        prev_seg = seg if prev_seg is None or seg.end_ms > prev_seg.end_ms else prev_seg
    merged.sort(key=lambda w: (w.start_ms, w.end_ms))
    return merged


def _speaker_labels(words: list[Word]) -> dict[int, str]:
    """Map provider speaker tags to anonymous ``SPEAKER_n`` by first appearance."""
    mapping: dict[int, str] = {}
    for w in words:
        if w.speaker_tag is not None and w.speaker_tag not in mapping:
            mapping[w.speaker_tag] = f"SPEAKER_{len(mapping) + 1}"
    return mapping


def _build_segment(
    index: int, words: list[Word], language: str, labels: dict[int, str]
) -> TranscriptSegment:
    text = " ".join(w.word.strip() for w in words if w.word.strip())
    confidence = round(sum(w.confidence for w in words) / len(words), 3)
    tags = Counter(w.speaker_tag for w in words if w.speaker_tag is not None)
    speaker = labels[tags.most_common(1)[0][0]] if tags else None
    return TranscriptSegment(
        segment_index=index,
        start_ms=words[0].start_ms,
        end_ms=max(w.end_ms for w in words),
        text=text,
        confidence=confidence,
        language=language,
        speaker_label=speaker,
        words=words,
    )


def group_words(
    words: list[Word], language: str = "pt-BR", config: GroupingConfig | None = None
) -> list[TranscriptSegment]:
    cfg = config or GroupingConfig()
    words = [w for w in words if w.word.strip()]
    labels = _speaker_labels(words)
    segments: list[TranscriptSegment] = []
    current: list[Word] = []

    def flush() -> None:
        if current:
            segments.append(_build_segment(len(segments), list(current), language, labels))
            current.clear()

    for w in words:
        if current:
            last = current[-1]
            pause = w.start_ms - last.end_ms
            too_long = w.end_ms - current[0].start_ms > cfg.max_segment_ms
            speaker_change = (
                w.speaker_tag is not None
                and last.speaker_tag is not None
                and w.speaker_tag != last.speaker_tag
            )
            if pause > cfg.max_pause_ms or too_long or speaker_change:
                flush()
        current.append(w)
        if w.word.rstrip().endswith(SENTENCE_END):
            flush()
    flush()

    _enforce_invariants(segments)
    return segments


def _enforce_invariants(segments: list[TranscriptSegment]) -> None:
    """Contract §8 / transcript-management validation: segments ordered, non-overlapping,
    ``endMs > startMs``, and every word inside its segment."""
    for i, seg in enumerate(segments):
        if i > 0:
            prev = segments[i - 1]
            if seg.start_ms < prev.end_ms:
                if seg.start_ms > prev.start_ms:
                    prev.end_ms = seg.start_ms
                else:
                    seg.start_ms = prev.end_ms
        if seg.end_ms <= seg.start_ms:
            seg.end_ms = seg.start_ms + 1
    for i, seg in enumerate(segments):
        if i + 1 < len(segments) and seg.end_ms > segments[i + 1].start_ms:
            seg.end_ms = max(seg.start_ms + 1, segments[i + 1].start_ms)
        clamped: list[Word] = []
        for w in seg.words:
            start = min(max(w.start_ms, seg.start_ms), seg.end_ms)
            end = min(max(w.end_ms, start), seg.end_ms)
            clamped.append(w.model_copy(update={"start_ms": start, "end_ms": end}))
        seg.words = clamped


def assemble_transcript(
    per_segment: list[tuple[AudioSegmentRef, list[Word]]],
    language: str = "pt-BR",
    config: GroupingConfig | None = None,
) -> list[TranscriptSegment]:
    absolute = [(seg, offset_words(seg, words)) for seg, words in per_segment]
    return group_words(merge_segment_words(absolute), language, config)
