"""Grounding / hallucination validation for LLM lecture structures (deliverables 2.7, 2.21).

Nothing the model returns is trusted:
* every item must cite segment indexes that exist in the transcript;
* the item's key text (concept term, reading title, question, topic title) must be lexically
  supported by the cited segments (accent-insensitive, light stemming, ±1 neighbouring segment);
* topic time ranges are recomputed from the cited segments;
* quoted speech that is not literally in the transcript is removed.
Items failing a rule are dropped and recorded as validation flags.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from lecture_intelligence.models import (
    Concept,
    LlmConcept,
    LlmQuestion,
    LlmReadingReference,
    LlmSubtopic,
    LlmTopic,
    Question,
    ReadingReference,
    Segment,
    Subtopic,
    Topic,
    ValidationFlag,
    ValidationReport,
)
from lecture_intelligence.text import content_tokens, fold, strip_fabricated_quotes, token_overlap

CONCEPT_TERM_MIN_OVERLAP = 0.6
CONCEPT_DEFINITION_MIN_OVERLAP = 0.2
READING_TITLE_MIN_OVERLAP = 0.6
QUESTION_MIN_OVERLAP = 0.3
ANSWER_MIN_OVERLAP = 0.2


@dataclass
class Grounder:
    segments: list[Segment]
    report: ValidationReport = field(default_factory=ValidationReport)

    def __post_init__(self) -> None:
        ordered = sorted(self.segments, key=lambda s: (s.start_ms, s.segment_index))
        self._by_index = {s.segment_index: s for s in ordered}
        self._position = {s.segment_index: i for i, s in enumerate(ordered)}
        self._ordered = ordered
        self.transcript_folded = fold(" ".join(s.text for s in ordered))

    # ------------------------------------------------------------------ helpers
    def flag(self, path: str, reason: str, *, dropped: bool) -> None:
        self.report.flags.append(ValidationFlag(path=path, reason=reason))
        if dropped:
            self.report.dropped_items += 1

    def _citations(self, path: str, indexes: list[int]) -> list[int] | None:
        if not indexes:
            self.flag(path, "missing_citation", dropped=True)
            return None
        valid = sorted({i for i in indexes if i in self._by_index})
        if not valid:
            self.flag(path, "invalid_segment_reference", dropped=True)
            return None
        if len(valid) != len(set(indexes)):
            self.flag(path, "invalid_segment_reference_removed", dropped=False)
        return valid

    def citations(self, path: str, indexes: list[int]) -> list[int] | None:
        """Valid cited indexes, or ``None`` (and a drop flag) when nothing valid is cited."""

        return self._citations(path, indexes)

    def evidence(self, indexes: list[int]) -> str:
        positions: set[int] = set()
        for index in indexes:
            pos = self._position[index]
            positions.update({pos - 1, pos, pos + 1})
        return " ".join(
            self._ordered[p].text for p in sorted(positions) if 0 <= p < len(self._ordered)
        )

    def span(self, indexes: list[int]) -> tuple[int, int]:
        cited = [self._by_index[i] for i in indexes]
        return min(s.start_ms for s in cited), max(s.end_ms for s in cited)

    def clean_prose(self, path: str, text: str | None) -> str | None:
        if text is None:
            return None
        cleaned, removed = strip_fabricated_quotes(text, self.transcript_folded)
        if removed:
            self.flag(path, "fabricated_quote", dropped=False)
        return cleaned or None

    # ------------------------------------------------------------------ items
    def topic(
        self, path: str, item: LlmTopic | LlmSubtopic, *, nested: bool = False
    ) -> Topic | None:
        indexes = self._citations(path, item.segmentIndexes)
        if indexes is None:
            return None
        if content_tokens(item.title) and token_overlap(item.title, self.evidence(indexes)) == 0:
            self.flag(path, "ungrounded", dropped=True)
            return None
        start, end = self.span(indexes)
        subtopics: list[Subtopic] = []
        if isinstance(item, LlmTopic) and not nested:
            for i, sub in enumerate(item.subtopics):
                parsed = self.topic(f"{path}.subtopics[{i}]", sub, nested=True)
                if parsed is not None:
                    subtopics.append(Subtopic(**parsed.model_dump(exclude={"subtopics"})))
            subtopics.sort(key=lambda s: s.start_ms)
            for order, subtopic in enumerate(subtopics, start=1):
                subtopic.order = order
        return Topic(
            order=0,
            title=item.title.strip(),
            description=self.clean_prose(f"{path}.description", item.description),
            start_ms=start,
            end_ms=end,
            segment_indexes=indexes,
            subtopics=subtopics,
        )

    def concept(self, path: str, item: LlmConcept) -> Concept | None:
        indexes = self._citations(path, item.segmentIndexes)
        if indexes is None:
            return None
        evidence = self.evidence(indexes)
        if token_overlap(item.term, evidence) < CONCEPT_TERM_MIN_OVERLAP:
            self.flag(path, "ungrounded", dropped=True)
            return None
        if token_overlap(item.definition, evidence) < CONCEPT_DEFINITION_MIN_OVERLAP:
            self.flag(path, "ungrounded_definition", dropped=True)
            return None
        definition = self.clean_prose(f"{path}.definition", item.definition)
        if definition is None:
            self.report.dropped_items += 1
            return None
        return Concept(
            term=item.term.strip(),
            definition=definition,
            example=self.clean_prose(f"{path}.example", item.example),
            segment_indexes=indexes,
        )

    def question(self, path: str, item: LlmQuestion) -> Question | None:
        indexes = self._citations(path, item.segmentIndexes)
        if indexes is None:
            return None
        evidence = self.evidence(indexes)
        if token_overlap(item.question, evidence) < QUESTION_MIN_OVERLAP:
            self.flag(path, "ungrounded", dropped=True)
            return None
        answer = self.clean_prose(f"{path}.answer", item.answer)
        if answer is not None and token_overlap(answer, evidence) < ANSWER_MIN_OVERLAP:
            self.flag(f"{path}.answer", "ungrounded_answer", dropped=False)
            answer = None
        return Question(
            question=item.question.strip(),
            answer=answer,
            asked_by=item.askedBy,
            segment_indexes=indexes,
        )

    def reading(self, path: str, item: LlmReadingReference) -> ReadingReference | None:
        indexes = self._citations(path, item.segmentIndexes)
        if indexes is None:
            return None
        evidence = self.evidence(indexes)
        if token_overlap(item.title, evidence) < READING_TITLE_MIN_OVERLAP:
            self.flag(path, "ungrounded", dropped=True)
            return None
        authors = item.authors
        if authors and token_overlap(authors, evidence) < 1.0:
            self.flag(f"{path}.authors", "ungrounded_authors", dropped=False)
            authors = None
        return ReadingReference(
            title=item.title.strip(), authors=authors, type=item.type, segment_indexes=indexes
        )


def finalize_topics(topics: list[Topic]) -> list[Topic]:
    ordered = sorted(topics, key=lambda t: (t.start_ms, t.end_ms))
    for order, topic in enumerate(ordered, start=1):
        topic.order = order
    return ordered


def dedupe_concepts(concepts: list[Concept]) -> list[Concept]:
    merged: dict[str, Concept] = {}
    for concept in concepts:
        key = fold(concept.term)
        if key in merged:
            existing = merged[key]
            existing.segment_indexes = sorted(
                set(existing.segment_indexes + concept.segment_indexes)
            )
            if len(concept.definition) > len(existing.definition):
                existing.definition = concept.definition
        else:
            merged[key] = concept
    return list(merged.values())


def dedupe_questions(items: list[Question]) -> list[Question]:
    seen: set[str] = set()
    result: list[Question] = []
    for item in items:
        if (key := fold(item.question)) not in seen:
            seen.add(key)
            result.append(item)
    return result


def dedupe_readings(items: list[ReadingReference]) -> list[ReadingReference]:
    seen: set[str] = set()
    result: list[ReadingReference] = []
    for item in items:
        if (key := fold(item.title)) not in seen:
            seen.add(key)
            result.append(item)
    return result
