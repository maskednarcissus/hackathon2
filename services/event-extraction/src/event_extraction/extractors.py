"""Candidate detection and the heuristic / LLM extractors (2.8, 2.22 caller side).

Extractors only *propose* drafts: type, title, cited segment and quote, and the spoken date
expression. Dates are always resolved afterwards by the deterministic resolver and every draft
goes through the hallucination validator before becoming an ``ExtractedEvent``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import keywords as kw
from .dates import DateResolution, DateResolver, ResolverContext
from .injection import injection_signals
from .models import EVENT_TYPES, ClassContext, EventType, TranscriptSegment
from .ports import GatewayClient
from .text import normalize, split_clauses, split_sentences

PROMPT_ID = "event-extraction"

TYPE_LABELS: dict[EventType, str] = {
    "examination": "Prova",
    "quiz": "Quiz",
    "assignment": "Entrega de trabalho",
    "project": "Entrega de projeto",
    "presentation": "Apresentação",
    "reading_deadline": "Leitura obrigatória",
    "class_cancellation": "Aula cancelada",
    "class_reschedule": "Aula remarcada / reposição",
    "room_change": "Mudança de sala",
    "other": "Aviso acadêmico",
}
ANNOUNCEMENT_TYPES: set[EventType] = {"class_cancellation", "class_reschedule", "room_change"}


@dataclass
class Draft:
    type: EventType
    title: str
    segment_index: int
    quote: str
    classification: float
    extractor: str
    date_context: str
    description: str | None = None
    date_expression: str | None = None
    hedged: bool = False
    other_course: bool = False
    llm_hypothetical: bool = False
    injection_suspected: bool = False
    borrowed_from_segment: int | None = None
    resolution: DateResolution | None = None
    corroborated: bool = False


@dataclass
class ExtractionOutput:
    drafts: list[Draft]
    reasons: dict[str, int] = field(default_factory=dict)
    candidates: int = 0
    injection_suspected: bool = False
    prompt_version: str | None = None
    model: str | None = None

    def drop(self, reason: str) -> None:
        self.reasons[reason] = self.reasons.get(reason, 0) + 1


def resolver_context(ctx: ClassContext) -> ResolverContext:
    return ResolverContext(
        class_date=ctx.class_date,
        upcoming_class_dates=[c.class_date for c in ctx.upcoming_classes],
    )


_SPECIFIERS = [
    r"\b(?:primeira|segunda|terceira|quarta|ultima)\s+(?:prova|avaliacao|lista|entrega|etapa)\b",
    r"\bprova\s+final\b",
    r"\bp[1-4]\b",
    r"\bsegunda\s+chamada\b",
    r"\bsimulado\b",
    r"\blista\s+(?:de\s+exercicios\s+)?(?:n(?:umero)?\s*)?\d+\b",
    r"\b(?:trabalho|projeto)\s+(?:final|em\s+grupo|individual)\b",
    r"\btcc\b",
]


def build_title(event_type: EventType, text: str) -> str:
    """A short, neutral title made only of words present in the quote (no invention)."""
    norm = normalize(text)
    title = TYPE_LABELS[event_type]
    for pattern in _SPECIFIERS:
        m = re.search(pattern, norm)
        if m:
            spec = m.group(0)
            title = spec.upper() if re.fullmatch(r"p[1-4]|tcc", spec) else spec.capitalize()
            if event_type in {"assignment", "project"} and not spec.startswith(
                ("trabalho", "projeto", "tcc", "lista")
            ):
                title = f"{TYPE_LABELS[event_type]} — {spec}"
            break
    chapters = re.search(r"\bcapitulos?\s+(\w+)(?:\s+(?:a|ao|ate|e)\s+(\w+))?", norm)
    if chapters and event_type in {"examination", "quiz", "reading_deadline"}:
        rng = chapters.group(1) + (f" a {chapters.group(2)}" if chapters.group(2) else "")
        title += f" — capítulos {rng}"
    room = re.search(r"\b(sala|laboratorio|auditorio|bloco)\s+([a-z]?\d+[a-z]?|\w+\s+\d+)\b", norm)
    if room and event_type == "room_change":
        title += f" — {room.group(1)} {room.group(2)}"
    return title[:200]


@dataclass
class _Sentence:
    segment_index: int
    position: int
    text: str


class HeuristicExtractor:
    """Deterministic rule-based extractor (offline / CI baseline and LLM cross-check)."""

    name = "heuristic"

    def __init__(self, resolver: DateResolver | None = None) -> None:
        self.resolver = resolver or DateResolver()

    def extract(self, segments: list[TranscriptSegment], ctx: ClassContext) -> ExtractionOutput:
        out = ExtractionOutput(drafts=[])
        rctx = resolver_context(ctx)
        ordered = sorted(segments, key=lambda s: s.segment_index)
        sentences: list[_Sentence] = []
        for seg in ordered:
            for pos, span in enumerate(split_sentences(seg.text)):
                sentences.append(_Sentence(seg.segment_index, pos, span.text))

        for idx, sentence in enumerate(sentences):
            clauses = split_clauses(sentence.text)
            for clause in clauses:
                cls = kw.classify(clause)
                if cls is None:
                    continue
                out.candidates += 1
                if injection_signals(clause) or injection_signals(sentence.text):
                    out.drop("injection_signal")
                    continue
                if kw.is_hypothetical(clause) or kw.is_hypothetical(sentence.text):
                    out.drop("hypothetical")
                    continue
                change_cue = kw.has_date_change_cue(clause)
                if not change_cue and (kw.is_retrospective(clause) or kw.is_negated(clause)):
                    out.drop("retrospective_or_negated")
                    continue

                resolution = self.resolver.resolve(clause, rctx)
                date_context = clause
                borrowed: int | None = None
                if not resolution.has_temporal_reference:
                    if len(clauses) == 1:
                        neighbour = self._neighbour_with_date(sentences, idx, cls.type, rctx)
                        if neighbour is not None:
                            date_context, resolution = neighbour[0].text, neighbour[1]
                            if neighbour[0].segment_index != sentence.segment_index:
                                borrowed = neighbour[0].segment_index
                if not resolution.has_temporal_reference:
                    if cls.type in ANNOUNCEMENT_TYPES or (
                        cls.strength >= 0.9
                        and kw.has_announcement_cue(clause)
                        and not kw.is_content_reference(clause)
                    ):
                        resolution.ambiguous = True
                        resolution.confidence = 0.3
                        resolution.explanation = (
                            "Anúncio sem data explícita: requer confirmação do professor."
                        )
                    else:
                        out.drop("no_temporal_reference")
                        continue

                hedge = kw.hedge(clause)
                out.drafts.append(
                    Draft(
                        type=cls.type,
                        title=build_title(cls.type, clause),
                        segment_index=sentence.segment_index,
                        quote=clause.strip(),
                        classification=cls.strength - (0.2 if hedge else 0.0),
                        extractor=self.name,
                        date_context=date_context,
                        date_expression=resolution.expression,
                        hedged=hedge is not None,
                        other_course=kw.mentions_other_course(clause),
                        borrowed_from_segment=borrowed,
                        resolution=resolution,
                    )
                )
        return out

    def _neighbour_with_date(
        self, sentences: list[_Sentence], idx: int, event_type: EventType, rctx: ResolverContext
    ) -> tuple[_Sentence, DateResolution] | None:
        current = sentences[idx]
        order = [idx + 1, idx - 1]
        for j in order:
            if j < 0 or j >= len(sentences):
                continue
            other = sentences[j]
            if abs(other.segment_index - current.segment_index) > 1:
                continue
            other_cls = kw.classify(other.text)
            if other_cls is not None and other_cls.type != event_type:
                continue
            if injection_signals(other.text) or kw.is_hypothetical(other.text):
                continue
            res = self.resolver.resolve(other.text, rctx)
            if res.event_date is not None:
                return other, res
        return None


EVENT_EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["events"],
    "properties": {
        "events": {
            "type": "array",
            "maxItems": 50,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["type", "title", "segmentIndex", "quote", "isHypothetical"],
                "properties": {
                    "type": {"type": "string", "enum": list(EVENT_TYPES)},
                    "title": {"type": "string", "minLength": 1, "maxLength": 200},
                    "description": {"type": ["string", "null"], "maxLength": 1000},
                    "segmentIndex": {"type": "integer", "minimum": 0},
                    "quote": {"type": "string", "minLength": 1, "maxLength": 600},
                    "dateExpression": {"type": ["string", "null"], "maxLength": 200},
                    "timeExpression": {"type": ["string", "null"], "maxLength": 100},
                    "isHypothetical": {"type": "boolean"},
                    "classificationConfidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
            },
        }
    },
}


def _fmt_ts(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def format_transcript(segments: list[TranscriptSegment]) -> str:
    return "\n".join(
        f"[s{seg.segment_index} {_fmt_ts(seg.start_ms)}] {seg.text}"
        for seg in sorted(segments, key=lambda s: s.segment_index)
    )


class LlmExtractor:
    """Structured extraction through the AI gateway (ADR-003)."""

    name = "llm"

    def __init__(
        self,
        gateway: GatewayClient,
        resolver: DateResolver | None = None,
        prompt_version: str | None = None,
        requested_by: str = "event-extraction",
    ) -> None:
        self.gateway = gateway
        self.resolver = resolver or DateResolver()
        self.prompt_version = prompt_version
        self.requested_by = requested_by

    async def extract(
        self, segments: list[TranscriptSegment], ctx: ClassContext
    ) -> ExtractionOutput:
        request: dict[str, Any] = {
            "task": "event_extraction",
            "promptId": PROMPT_ID,
            "variables": {
                "classDate": ctx.class_date.isoformat(),
                "classWeekday": [
                    "segunda",
                    "terça",
                    "quarta",
                    "quinta",
                    "sexta",
                    "sábado",
                    "domingo",
                ][ctx.class_date.weekday()],
                "courseName": ctx.course_name or "",
                "timezone": ctx.timezone,
                "eventTypes": list(EVENT_TYPES),
            },
            "untrustedInputs": {"transcript": format_transcript(segments)},
            "responseSchema": EVENT_EXTRACTION_SCHEMA,
            "institutionId": ctx.institution_id,
            "requestedBy": self.requested_by,
            "options": {"temperature": 0, "maxOutputTokens": 4096},
        }
        if self.prompt_version:
            request["promptVersion"] = self.prompt_version
        response = await self.gateway.generate(request)
        safety = response.get("safety") or {}
        injection = bool(safety.get("injectionSuspected"))
        prompt = response.get("prompt") or {}
        model = response.get("model") or {}
        out = ExtractionOutput(
            drafts=[],
            injection_suspected=injection,
            prompt_version=prompt.get("version"),
            model=model.get("name"),
        )
        by_index = {s.segment_index: s for s in segments}
        rctx = resolver_context(ctx)
        output = response.get("output") or {}
        for raw in output.get("events", []) if isinstance(output, dict) else []:
            out.candidates += 1
            try:
                event_type = raw["type"]
                if event_type not in EVENT_TYPES:
                    out.drop("invalid_type")
                    continue
                seg_index = int(raw["segmentIndex"])
                quote = str(raw["quote"]).strip()
            except (KeyError, TypeError, ValueError):
                out.drop("malformed_item")
                continue
            if raw.get("isHypothetical"):
                out.drop("hypothetical")
                continue
            date_expression = raw.get("dateExpression") or None
            date_context = self._date_context(quote, date_expression, seg_index, by_index)
            resolution = self.resolver.resolve(date_context, rctx)
            classification = float(raw.get("classificationConfidence", 0.85))
            out.drafts.append(
                Draft(
                    type=event_type,
                    title=str(raw.get("title") or TYPE_LABELS[event_type])[:200],
                    description=raw.get("description") or None,
                    segment_index=seg_index,
                    quote=quote,
                    classification=min(classification, 0.95),
                    extractor=self.name,
                    date_context=date_context,
                    date_expression=date_expression,
                    hedged=kw.hedge(quote) is not None,
                    other_course=kw.mentions_other_course(quote),
                    injection_suspected=injection,
                    resolution=resolution,
                )
            )
        return out

    @staticmethod
    def _date_context(
        quote: str,
        expression: str | None,
        seg_index: int,
        by_index: dict[int, TranscriptSegment],
    ) -> str:
        if not expression or normalize(expression) in normalize(quote):
            return quote
        for j in (seg_index, seg_index + 1, seg_index - 1):
            seg = by_index.get(j)
            if seg is None:
                continue
            for span in split_sentences(seg.text):
                if normalize(expression) in normalize(span.text):
                    return span.text
        return quote
