from transcription.assembly import (
    GroupingConfig,
    assemble_transcript,
    group_words,
    merge_segment_words,
    offset_words,
)
from transcription.models import AudioSegmentRef, Word


def w(text: str, start: int, end: int, conf: float = 0.9, tag: int | None = None) -> Word:
    return Word(word=text, start_ms=start, end_ms=end, confidence=conf, speaker_tag=tag)


def seg(index: int, start: int, end: int) -> AudioSegmentRef:
    return AudioSegmentRef(index=index, start_ms=start, end_ms=end, storage_uri=f"gs://b/{index}")


def test_offset_words_adds_segment_start() -> None:
    out = offset_words(seg(1, 300_000, 600_000), [w("olá", 100, 400)])
    assert (out[0].start_ms, out[0].end_ms) == (300_100, 300_400)


def test_overlap_is_deduplicated_at_midpoint() -> None:
    # Segment 0: 0–10 s, segment 1: 9–20 s (1 s overlap → cut at 9.5 s).
    a = [w("um", 8_000, 8_400), w("dois", 9_100, 9_400), w("três", 9_600, 9_900)]
    b = [w("dois", 9_100, 9_400), w("três", 9_600, 9_900), w("quatro", 10_500, 10_900)]
    merged = merge_segment_words([(seg(0, 0, 10_000), a), (seg(1, 9_000, 20_000), b)])
    assert [x.word for x in merged] == ["um", "dois", "três", "quatro"]


def test_grouping_splits_on_punctuation_pause_and_length() -> None:
    words = [
        w("Bom", 0, 300),
        w("dia.", 350, 600),  # sentence end
        w("Hoje", 700, 900),
        w("vamos", 2_500, 2_800),  # pause 1.6 s > 1.2 s
        w("começar", 2_900, 3_300),
    ]
    segments = group_words(words)
    assert [s.text for s in segments] == ["Bom dia.", "Hoje", "vamos começar"]
    assert [s.segment_index for s in segments] == [0, 1, 2]

    long_run = [w(f"p{i}", i * 1_000, i * 1_000 + 900) for i in range(70)]
    capped = group_words(long_run, config=GroupingConfig(max_segment_ms=30_000))
    assert all(s.end_ms - s.start_ms <= 30_000 for s in capped)
    assert sum(len(s.words) for s in capped) == 70


def test_segments_are_ordered_non_overlapping_with_mean_confidence() -> None:
    words = [w("a.", 0, 500, 0.8), w("b", 400, 900, 1.0), w("c.", 950, 1_200, 0.6)]
    segments = group_words(words)
    assert segments[0].end_ms <= segments[1].start_ms
    assert segments[1].confidence == 0.8
    assert all(0 <= s.confidence <= 1 for s in segments)


def test_provider_speaker_tags_become_anonymous_labels() -> None:
    words = [
        w("Pergunta", 0, 400, tag=7),
        w("professor?", 450, 900, tag=7),
        w("Sim.", 1_000, 1_300, tag=3),
    ]
    segments = group_words(words)
    assert [s.speaker_label for s in segments] == ["SPEAKER_1", "SPEAKER_2"]


def test_assemble_full_pipeline() -> None:
    per_segment = [
        (seg(0, 0, 5_000), [w("Olá", 0, 300), w("turma.", 350, 700)]),
        (seg(1, 5_000, 10_000), [w("Prova", 100, 500), w("segunda.", 550, 1_000)]),
    ]
    out = assemble_transcript(per_segment)
    assert [(s.text, s.start_ms) for s in out] == [("Olá turma.", 0), ("Prova segunda.", 5_100)]
    assert out[0].dump()["segmentIndex"] == 0
    assert "speakerLabel" not in out[0].dump()
