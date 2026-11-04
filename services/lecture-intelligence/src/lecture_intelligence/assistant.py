"""Academic assistant (deliverables 3.13 and 3.14).

Retrieval-augmented answers grounded only in the student's own lectures:

1. The question is untrusted. Instruction-like questions are refused (``injection_suspected``)
   *before* retrieval or any model call — the assistant has no legitimate use for them.
2. Retrieval: hybrid search restricted to the caller's ``classSectionIds`` (and optionally one
   ``scheduledClassId``) plus stored lecture structures for the retrieved classes. Results from any
   other section are discarded again here (defence in depth).
3. No evidence → ``no_evidence`` refusal without calling the model.
4. The model answers in blocks; the server validates them:
   * citations must reference retrieved passages (unknown ids removed);
   * a ``professor_statement`` survives only if it cites a transcript passage *and* its quote is
     verbatim (normalised) in that passage, or its text is ≥ 60 % lexically supported by it;
     otherwise it is downgraded to ``ai_explanation``;
   * ``ai_explanation`` blocks are stripped of professor-attribution phrases.
5. Conversation memory keeps the last N turns per ``conversationId`` (owned by one student).
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog
from pydantic import ValidationError

from lecture_intelligence.clients import GatewayCallError, GatewayClient, SearchClient
from lecture_intelligence.models import (
    AnswerBlock,
    AnswerProvenance,
    AskRequest,
    AssistantAnswer,
    Citation,
    FeedbackRequest,
    LectureStructure,
    LlmAnswer,
    SearchResult,
    response_schema,
)
from lecture_intelligence.pipeline import PipelineError
from lecture_intelligence.repository import LectureRepository
from lecture_intelligence.text import fold, token_overlap

log = structlog.get_logger(__name__)

ASSISTANT_PROMPT = "assistant-answer"
PROFESSOR_STATEMENT_MIN_OVERLAP = 0.6

_INJECTION_PATTERNS = [
    re.compile(
        r"\b(ignore|ignorem|ignora|desconsidere|esqueca|disregard|forget|override)\b"
        r"[\w\s,]{0,40}\b(instruc(ao|oes)|instructions?|regras|rules|prompts?)\b"
    ),
    re.compile(r"\b(system prompt|prompt do sistema|prompt de sistema)\b"),
    re.compile(r"\b(voce agora e|a partir de agora voce|you are now|aja como se|act as)\b"),
    re.compile(r"(<\s*/?\s*(system|assistant|developer)\s*>|untrusted_[a-z_]+|\[\s*system\s*\])"),
]

_ATTRIBUTION_RE = re.compile(
    r"\b(segundo|de acordo com|conforme|como)\s+(o|a)\s+professor(a)?\b(\s+(disse|explicou|"
    r"afirmou|falou|mencionou|comentou|destacou))?\s*,?\s*"
    r"|\b(o|a)\s+professor(a)?\s+(disse|afirmou|explicou|falou|comentou|mencionou|destacou|"
    r"ressaltou|garantiu|declarou)(\s+que)?\s*,?\s*",
    re.IGNORECASE,
)


def question_injection_suspected(question: str) -> bool:
    folded = fold(question.replace("<", " <").replace(">", "> "))
    raw = question.lower()
    return any(p.search(folded) or p.search(raw) for p in _INJECTION_PATTERNS)


def strip_attribution(text: str) -> str:
    cleaned = _ATTRIBUTION_RE.sub("", text).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned[:1].upper() + cleaned[1:] if cleaned else cleaned


# ------------------------------------------------------------------ storage ports
@dataclass
class Turn:
    question: str
    answer_text: str


@dataclass
class Conversation:
    conversation_id: str
    student_id: str
    institution_id: str
    turns: list[Turn] = field(default_factory=list)


@dataclass
class StoredAnswer:
    answer: AssistantAnswer
    student_id: str
    institution_id: str
    question: str
    created_at: datetime
    feedback: list[dict[str, Any]] = field(default_factory=list)


class AssistantRepository(Protocol):
    def get_conversation(self, conversation_id: str) -> Conversation | None: ...

    def save_conversation(self, conversation: Conversation) -> None: ...

    def save_answer(self, answer: StoredAnswer) -> None: ...

    def get_answer(self, answer_id: str) -> StoredAnswer | None: ...


class InMemoryAssistantRepository:
    def __init__(self) -> None:
        self.conversations: dict[str, Conversation] = {}
        self.answers: dict[str, StoredAnswer] = {}

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        return self.conversations.get(conversation_id)

    def save_conversation(self, conversation: Conversation) -> None:
        self.conversations[conversation.conversation_id] = conversation

    def save_answer(self, answer: StoredAnswer) -> None:
        self.answers[answer.answer.answer_id] = answer

    def get_answer(self, answer_id: str) -> StoredAnswer | None:
        return self.answers.get(answer_id)


# ------------------------------------------------------------------ service
@dataclass
class AssistantSettings:
    retrieval_limit: int = 8
    memory_turns: int = 6
    min_score: float = 0.0
    search_mode: str = "hybrid"


@dataclass
class _Source:
    id: str
    result: SearchResult


class Assistant:
    def __init__(
        self,
        *,
        gateway: GatewayClient,
        search: SearchClient,
        lectures: LectureRepository,
        repository: AssistantRepository,
        settings: AssistantSettings | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.gateway = gateway
        self.search = search
        self.lectures = lectures
        self.repository = repository
        self.settings = settings or AssistantSettings()
        self.clock = clock

    async def ask(self, req: AskRequest) -> AssistantAnswer:
        conversation = self._conversation(req)
        allowed = set(req.class_section_ids)

        if question_injection_suspected(req.question):
            return self._finish(
                req, conversation, [], [], "injection_suspected", AnswerProvenance()
            )

        sources = await self._retrieve(req, conversation, allowed)
        if not sources:
            return self._finish(req, conversation, [], [], "no_evidence", AnswerProvenance())

        structures = self._structures(sources)
        payload = {
            "task": "assistant_answer",
            "promptId": ASSISTANT_PROMPT,
            "variables": {"today": self.clock().date().isoformat(), "sectionCount": len(allowed)},
            "untrustedInputs": {
                "question": req.question,
                "context": _render_context(sources, structures),
                "conversation": _render_history(conversation, self.settings.memory_turns),
            },
            "responseSchema": response_schema(LlmAnswer),
            "institutionId": req.institution_id,
            "requestedBy": "lecture-intelligence.assistant",
        }
        try:
            body = await self.gateway.generate(payload)
        except GatewayCallError as exc:
            status = 429 if exc.status_code == 429 else 502
            raise PipelineError(f"ai_gateway_{exc.code}", str(exc), status) from exc
        provenance = AnswerProvenance(
            prompt_id=ASSISTANT_PROMPT,
            prompt_version=str(body.get("prompt", {}).get("version", "unknown")),
            model=str(body.get("model", {}).get("name", "unknown")),
        )
        try:
            llm = LlmAnswer.model_validate(body.get("output") or {})
        except ValidationError as exc:
            raise PipelineError(
                "invalid_model_output", "Assistant output failed validation", 502
            ) from exc

        if llm.refusal is not None or not llm.answer:
            return self._finish(req, conversation, [], [], llm.refusal or "no_evidence", provenance)
        blocks, citations = self._validate(llm, sources)
        if not blocks:
            return self._finish(req, conversation, [], [], "no_evidence", provenance)
        return self._finish(req, conversation, blocks, citations, None, provenance)

    def feedback(self, req: FeedbackRequest) -> dict[str, Any]:
        stored = self.repository.get_answer(req.answer_id)
        if stored is None or (req.student_id is not None and req.student_id != stored.student_id):
            raise PipelineError("not_found", "Unknown answerId", 404)
        entry = {
            "feedbackId": str(uuid.uuid4()),
            "answerId": req.answer_id,
            "helpful": req.helpful,
            "comment": req.comment,
            "createdAt": self.clock().isoformat(),
        }
        stored.feedback.append(entry)
        self.repository.save_answer(stored)
        return entry

    # ------------------------------------------------------------------ internals
    def _conversation(self, req: AskRequest) -> Conversation:
        if req.conversation_id is None:
            return Conversation(str(uuid.uuid4()), req.student_id, req.institution_id)
        existing = self.repository.get_conversation(req.conversation_id)
        if existing is None:
            return Conversation(req.conversation_id, req.student_id, req.institution_id)
        if existing.student_id != req.student_id or existing.institution_id != req.institution_id:
            raise PipelineError("not_found", "Unknown conversationId", 404)
        return existing

    async def _retrieve(
        self, req: AskRequest, conversation: Conversation, allowed: set[str]
    ) -> list[_Source]:
        query = req.question
        if conversation.turns and len(fold(req.question).split()) < 4:
            # Short follow-ups ("e na prática?") inherit the previous question's topic.
            query = f"{conversation.turns[-1].question} {req.question}"
        try:
            results = await self.search.search(
                query, sorted(allowed), self.settings.retrieval_limit, self.settings.search_mode
            )
        except Exception as exc:  # noqa: BLE001 - surfaced as a 502 below
            log.error("search_failed", error=str(exc))
            raise PipelineError("search_unavailable", "Lecture search is unavailable", 502) from exc
        sources: list[_Source] = []
        seen: set[tuple[str, int]] = set()
        for result in sorted(results, key=lambda r: -r.score):
            if result.class_section_id not in allowed:
                log.warning("search_returned_foreign_section", section=result.class_section_id)
                continue
            if req.scheduled_class_id and result.scheduled_class_id != req.scheduled_class_id:
                continue
            if result.score < self.settings.min_score or not result.text.strip():
                continue
            key = (result.transcript_id, result.segment_index)
            if key in seen:
                continue
            seen.add(key)
            sources.append(_Source(f"s{len(sources) + 1}", result))
            if len(sources) >= self.settings.retrieval_limit:
                break
        return sources

    def _structures(self, sources: list[_Source]) -> list[LectureStructure]:
        found: list[LectureStructure] = []
        for class_id in dict.fromkeys(s.result.scheduled_class_id for s in sources):
            structure = self.lectures.latest_for_class(class_id)
            if structure is not None:
                found.append(structure)
        return found

    def _validate(
        self, llm: LlmAnswer, sources: list[_Source]
    ) -> tuple[list[AnswerBlock], list[Citation]]:
        by_id = {s.id: s for s in sources}
        citations: dict[str, Citation] = {}
        blocks: list[AnswerBlock] = []
        for block in llm.answer:
            cited = [by_id[c] for c in dict.fromkeys(block.citationIds) if c in by_id]
            kind = block.kind
            text = block.text.strip()
            quote_source: _Source | None = None
            if block.quote:
                quote_source = next(
                    (
                        s
                        for s in cited
                        if fold(block.quote) and fold(block.quote) in fold(s.result.text)
                    ),
                    None,
                )
            if kind == "professor_statement":
                supported = quote_source is not None or any(
                    token_overlap(text, s.result.text) >= PROFESSOR_STATEMENT_MIN_OVERLAP
                    for s in cited
                )
                if not cited or not supported:
                    kind = "ai_explanation"
            if kind == "ai_explanation":
                text = strip_attribution(text)
                if not text:
                    continue
            for source in cited:
                if source.id not in citations:
                    quote = block.quote.strip() if source is quote_source and block.quote else None
                    citations[source.id] = _citation(source, quote)
            blocks.append(AnswerBlock(kind=kind, text=text, citation_ids=[s.id for s in cited]))
        ordered = [citations[s.id] for s in sources if s.id in citations]
        return blocks, ordered

    def _finish(
        self,
        req: AskRequest,
        conversation: Conversation,
        blocks: list[AnswerBlock],
        citations: list[Citation],
        refusal: Any,
        provenance: AnswerProvenance,
    ) -> AssistantAnswer:
        answer = AssistantAnswer(
            answer_id=str(uuid.uuid4()),
            conversation_id=conversation.conversation_id,
            answer=blocks,
            citations=citations,
            grounded=bool(citations) and refusal is None,
            refusal=refusal,
            provenance=provenance,
        )
        answer_text = " ".join(b.text for b in blocks) or f"[recusa: {refusal}]"
        conversation.turns.append(Turn(req.question, answer_text))
        conversation.turns = conversation.turns[-self.settings.memory_turns :]
        self.repository.save_conversation(conversation)
        self.repository.save_answer(
            StoredAnswer(answer, req.student_id, req.institution_id, req.question, self.clock())
        )
        return answer


def _citation(source: _Source, quote: str | None) -> Citation:
    r = source.result
    return Citation(
        id=source.id,
        scheduled_class_id=r.scheduled_class_id,
        transcript_id=r.transcript_id,
        segment_index=r.segment_index,
        start_ms=r.start_ms,
        end_ms=r.end_ms,
        quote=quote or r.text.strip(),
    )


def _timestamp(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _render_context(sources: list[_Source], structures: list[LectureStructure]) -> str:
    lines = [
        f"[{s.id}] aula {s.result.scheduled_class_id} {_timestamp(s.result.start_ms)} — "
        f"{s.result.text.strip()}"
        for s in sources
    ]
    for i, structure in enumerate(structures, start=1):
        concepts = "; ".join(f"{c.term}: {c.definition}" for c in structure.concepts[:10])
        lines.append(
            f"[l{i}] resumo gerado por IA da aula {structure.scheduled_class_id} — "
            f"{structure.title}. {structure.executive_summary} Conceitos: {concepts or 'nenhum'}"
        )
    return "\n".join(lines)


def _render_history(conversation: Conversation, max_turns: int) -> str:
    if not conversation.turns:
        return "(sem histórico)"
    return "\n".join(
        f"Estudante: {t.question}\nAssistente: {t.answer_text}"
        for t in conversation.turns[-max_turns:]
    )
