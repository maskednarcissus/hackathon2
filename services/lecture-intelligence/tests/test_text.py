from __future__ import annotations

from lecture_intelligence.chunking import chunk_segments, format_segment, timestamp
from lecture_intelligence.models import Segment
from lecture_intelligence.text import fold, strip_fabricated_quotes, token_overlap


def test_fold_is_accent_and_case_insensitive() -> None:
    assert fold("Política MONETÁRIA, já!") == "politica monetaria ja"


def test_token_overlap_with_light_stemming() -> None:
    evidence = "A pressão inflacionária persiste e os juros sobem."
    assert token_overlap("Inflação", "inflacao alta") == 1.0
    assert token_overlap("pressões inflacionárias", evidence) == 1.0
    assert token_overlap("Curva de Phillips", evidence) == 0.0
    assert token_overlap("de", "de") == 1.0


def test_strip_fabricated_quotes_keeps_literal_ones() -> None:
    transcript = fold("Como eu sempre digo, juros altos esfriam a economia.")
    text = 'O professor disse "juros altos esfriam a economia". Ele disse “a inflação acabou”.'
    cleaned, removed = strip_fabricated_quotes(text, transcript)
    assert removed == 1
    assert cleaned == 'O professor disse "juros altos esfriam a economia".'


def test_chunking_respects_budget_and_order() -> None:
    segments = [
        Segment(segment_index=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text="palavra " * 20)
        for i in range(50)
    ]
    chunks = chunk_segments(list(reversed(segments)), max_tokens=200)
    assert len(chunks) > 1
    assert [s.segment_index for c in chunks for s in c] == list(range(50))
    assert timestamp(3_723_000) == "01:02:03"
    assert format_segment(segments[1]).startswith("[s1 00:00:01] palavra")


def test_stemming_does_not_conflate_unrelated_words() -> None:
    assert token_overlap("O Capital", "leiam o capítulo cinco") == 0.0
    assert token_overlap("taxas monetárias", "a taxa monetária") == 1.0
