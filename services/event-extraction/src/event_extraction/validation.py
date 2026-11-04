"""Hallucination prevention rules (2.21) and multi-dimensional confidence (2.11)."""

from __future__ import annotations

import math

from . import keywords as kw
from .extractors import Draft
from .injection import injection_signals
from .models import ClassContext, Confidence, TranscriptSegment
from .text import normalize

MAX_QUOTE_CHARS = 600

_DATE_CONFIDENCE_BY_METHOD = {
    "absolute": 0.97,
    "relative": 0.92,
    "weekday": 0.9,
    "next_class": 0.9,
    "none": 0.3,
}


def validate_draft(draft: Draft, segments: dict[int, TranscriptSegment]) -> str | None:
    """Return the rejection reason, or ``None`` when the draft is grounded in the transcript."""
    seg = segments.get(draft.segment_index)
    if seg is None:
        return "unknown_segment"
    if len(draft.quote) > MAX_QUOTE_CHARS:
        return "quote_too_long"
    quote_n = normalize(draft.quote)
    if not quote_n:
        return "empty_quote"
    next_seg = segments.get(draft.segment_index + 1)
    cited = normalize(seg.text + " " + (next_seg.text if next_seg else ""))
    if quote_n not in cited:
        return "quote_not_in_source"
    if draft.date_expression:
        window = " ".join(
            normalize(s.text)
            for j in (draft.segment_index - 1, draft.segment_index, draft.segment_index + 1)
            if (s := segments.get(j)) is not None
        )
        if normalize(draft.date_expression) not in window:
            return "date_expression_not_in_source"
    if not kw.supports_type(draft.quote, draft.type):
        return "type_not_supported_by_quote"
    if kw.is_hypothetical(draft.quote):
        return "hypothetical"
    if injection_signals(draft.quote):
        return "injection_signal"
    return None


def compute_confidence(
    draft: Draft, segments: dict[int, TranscriptSegment], ctx: ClassContext
) -> Confidence:
    seg = segments[draft.segment_index]
    transcription = seg.confidence
    if draft.borrowed_from_segment is not None and draft.borrowed_from_segment in segments:
        transcription = min(transcription, segments[draft.borrowed_from_segment].confidence)

    classification = max(0.0, min(1.0, draft.classification))

    res = draft.resolution
    if res is None or res.ambiguous or res.event_date is None:
        date_conf = 0.3 if res is not None and res.ambiguous else 0.2
    else:
        date_conf = min(_DATE_CONFIDENCE_BY_METHOD.get(res.method, 0.5), res.confidence + 0.02)
        if draft.borrowed_from_segment is not None:
            date_conf -= 0.08
        if res.past:
            date_conf = min(date_conf, 0.4)
    if draft.hedged:
        date_conf = min(date_conf, 0.7)

    course = 0.95 if ctx.course_id and ctx.class_section_id else 0.5
    if draft.other_course:
        course = 0.55

    dims = [transcription, classification, date_conf, course]
    dims = [max(0.01, min(1.0, d)) for d in dims]
    geo = math.exp(sum(math.log(d) for d in dims) / len(dims))
    overall = 0.4 * min(dims) + 0.6 * geo
    return Confidence(
        overall=round(overall, 3),
        transcription=round(dims[0], 3),
        event_classification=round(dims[1], 3),
        date_interpretation=round(dims[2], 3),
        course_association=round(dims[3], 3),
    )
