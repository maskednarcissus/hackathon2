"""Assistant conversation / answer / feedback storage port and in-memory implementation."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from lecture_intelligence.models import AssistantAnswer

ANONYMISED_QUESTION = "[removido a pedido do titular]"


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
    ai_request_id: str | None = None
    feedback: list[dict[str, Any]] = field(default_factory=list)


def answer_text(answer: AssistantAnswer) -> str:
    return " ".join(b.text for b in answer.answer) or f"[recusa: {answer.refusal}]"


class AssistantRepository(Protocol):
    async def get_conversation(self, conversation_id: str) -> Conversation | None:
        """Conversation with its most recent turns (oldest first)."""
        ...

    async def save_conversation(self, conversation: Conversation) -> None: ...

    async def save_answer(self, answer: StoredAnswer) -> None:
        """Persist a new answer as the next turn of its conversation."""
        ...

    async def get_answer(self, answer_id: str) -> StoredAnswer | None: ...

    async def add_feedback(self, answer_id: str, entry: dict[str, Any]) -> None: ...

    async def recent_questions(self, student_id: str, limit: int = 50) -> list[str]:
        """The student's own most recent assistant questions (revision signal, 6.2)."""
        ...

    # LGPD data-subject rights (integration stage §5)
    async def export_subject(self, student_id: str) -> dict[str, Any]: ...

    async def delete_subject(self, student_id: str) -> int: ...

    async def anonymize_subject(self, student_id: str) -> int: ...


class InMemoryAssistantRepository:
    def __init__(self, memory_turns: int = 6) -> None:
        self.memory_turns = memory_turns
        self.conversations: dict[str, Conversation] = {}
        self.answers: dict[str, StoredAnswer] = {}

    async def get_conversation(self, conversation_id: str) -> Conversation | None:
        return self.conversations.get(conversation_id)

    async def save_conversation(self, conversation: Conversation) -> None:
        conversation.turns = conversation.turns[-self.memory_turns :]
        self.conversations[conversation.conversation_id] = conversation

    async def save_answer(self, answer: StoredAnswer) -> None:
        self.answers[answer.answer.answer_id] = answer

    async def get_answer(self, answer_id: str) -> StoredAnswer | None:
        return self.answers.get(answer_id)

    async def add_feedback(self, answer_id: str, entry: dict[str, Any]) -> None:
        self.answers[answer_id].feedback.append(entry)

    async def recent_questions(self, student_id: str, limit: int = 50) -> list[str]:
        own = [a for a in self.answers.values() if a.student_id == student_id]
        own.sort(key=lambda a: a.created_at, reverse=True)
        return [a.question for a in own if a.question != ANONYMISED_QUESTION][:limit]

    async def export_subject(self, student_id: str) -> dict[str, Any]:
        conversations = [c for c in self.conversations.values() if c.student_id == student_id]
        answers = [a for a in self.answers.values() if a.student_id == student_id]
        return {
            "conversations": [
                {"conversationId": c.conversation_id, "institutionId": c.institution_id}
                for c in conversations
            ],
            "answers": [
                {
                    "answerId": a.answer.answer_id,
                    "conversationId": a.answer.conversation_id,
                    "question": a.question,
                    "answer": a.answer.to_json()["answer"],
                    "refusal": a.answer.refusal,
                    "createdAt": a.created_at.isoformat(),
                }
                for a in answers
            ],
            "feedback": [f for a in answers for f in a.feedback],
        }

    async def delete_subject(self, student_id: str) -> int:
        conversation_ids = [
            cid for cid, c in self.conversations.items() if c.student_id == student_id
        ]
        answer_ids = [aid for aid, a in self.answers.items() if a.student_id == student_id]
        for cid in conversation_ids:
            del self.conversations[cid]
        for aid in answer_ids:
            del self.answers[aid]
        return len(conversation_ids) + len(answer_ids)

    async def anonymize_subject(self, student_id: str) -> int:
        count = 0
        for stored in self.answers.values():
            if stored.student_id == student_id:
                stored.question = ANONYMISED_QUESTION
                for entry in stored.feedback:
                    entry["comment"] = None
                count += 1
        for conversation in self.conversations.values():
            if conversation.student_id == student_id:
                for turn in conversation.turns:
                    turn.question = ANONYMISED_QUESTION
        return count
