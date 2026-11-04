"""Transcript formatting and token-budgeted chunking for long lectures."""

from __future__ import annotations

from lecture_intelligence.models import Segment


def timestamp(ms: int) -> str:
    seconds = ms // 1000
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def format_segment(segment: Segment) -> str:
    return f"[s{segment.segment_index} {timestamp(segment.start_ms)}] {segment.text.strip()}"


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def chunk_segments(segments: list[Segment], max_tokens: int) -> list[list[Segment]]:
    """Split ordered segments into chunks whose formatted size fits ``max_tokens``.

    Chunks always break on segment boundaries; a single oversized segment forms its own chunk.
    """

    chunks: list[list[Segment]] = []
    current: list[Segment] = []
    used = 0
    for segment in sorted(segments, key=lambda s: (s.start_ms, s.segment_index)):
        cost = estimate_tokens(format_segment(segment)) + 1
        if current and used + cost > max_tokens:
            chunks.append(current)
            current, used = [], 0
        current.append(segment)
        used += cost
    if current:
        chunks.append(current)
    return chunks


def render_transcript(segments: list[Segment]) -> str:
    return "\n".join(format_segment(s) for s in segments)
