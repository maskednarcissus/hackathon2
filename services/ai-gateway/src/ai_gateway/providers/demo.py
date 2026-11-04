"""Offline, extractive provider for demos and MVP presentations (``AI_GATEWAY_PROVIDER=demo``).

It needs no credentials and no network. Instead of generating text, it *extracts* it from the
untrusted inputs the gateway already renders into the prompt (transcript lines, retrieved
passages, concept lists), so every output is grounded in the lecture and passes the
lecture-intelligence validators. Quality depends on the transcript using plain didactic
phrasing ("Hoje a nossa aula é sobre …", "Vamos falar agora sobre …", "A inflação é …").

Prompts without a dedicated handler fall back to the minimal schema instance, like
:class:`~ai_gateway.providers.fake.FakeProvider`.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable
from typing import Any

from ai_gateway.providers.base import ProviderRequest, ProviderResponse, estimate_tokens
from ai_gateway.providers.fake import minimal_instance

_SEG = re.compile(r"^\[s(\d+) [0-9:]+\]\s*(.+)$")
_SRC = re.compile(r"^\[(s\d+)\] aula \S+ \S+ — (.+)$")
_SUMMARY = re.compile(r"^\[(l\d+)\] resumo gerado por IA da aula \S+ — (.+)$")
_TAG = re.compile(r"</?untrusted_[a-z_]+>")

_TITLE = re.compile(r"(?:nossa aula|a aula de hoje|hoje a aula|hoje vamos estudar)\s+(?:é\s+)?sobre\s+([^.?!]{4,120})", re.I)
_TOPIC = re.compile(
    r"(?:vamos falar agora sobre|agora vamos ver|vamos ver agora|vamos começar pel[ao]s?|"
    r"próximo ponto(?: é)?|outro ponto importante(?: é)?|passando para)\s*:?\s*([^.?!]{4,120})",
    re.I,
)
_DEFINITION = re.compile(
    r"^(?:(?:O|A|Os|As|Um|Uma)\s+)?([a-zà-úA-ZÀ-Ú][\wà-úÀ-Ú-]*(?:\s+[\wà-úÀ-Ú-]+){0,4}?)\s+"
    r"(?:é|são|significa|representa|mede)\s+([a-zà-ú].{12,})$"
)
_READING = re.compile(
    r"(?:livro|artigo|capítulo)\s+([A-ZÀ-Ú][^,]{3,120}),\s+(?:de|do|da)\s+([A-ZÀ-Ú][\wÀ-úà-ú. ]{2,80}?)(?:[,.;]|$)"
)

_STOP = frozenset(
    """a o as os um uma uns umas de do da dos das em no na nos nas por para pra com sem sobre
    entre e ou mas que se como quando onde qual quais quem porque pois ja nao sim muito muita
    mais menos isso isto esse essa este esta aquele aquela ele ela eles elas voce voces eu nos
    meu minha seu sua ser estar ter foi era sao e ha tem vai vamos aqui ali entao tambem so
    professor professora aula aulas gente turma pessoal""".split()
)


_NOT_TERMS = frozenset(
    "isso isto aquilo este esta esse essa ele ela eles elas aqui ai que qual quem onde "
    "hoje se quando mesmo entao porque mas para na no primeira segunda terceira lei outro outra ponto problema ideia resposta pergunta prova trabalho objetivo tudo nada".split()
)


def _fold(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", _fold(text)) if len(t) >= 3 and t not in _STOP}


def _overlap(a: str, b: str) -> float:
    ta = _tokens(a)
    return len(ta & _tokens(b)) / len(ta) if ta else 0.0


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.?!])\s+", text.strip()) if s.strip()]


def _clean(text: str) -> str:
    return text.strip().strip(" ,;:").rstrip(".")


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def _block(prompt: str, label: str) -> str:
    """Text after ``label`` up to the next blank-line-separated section."""

    idx = prompt.find(label)
    if idx < 0:
        return ""
    return prompt[idx + len(label):]


def _segments(text: str) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for line in _TAG.sub("", text).splitlines():
        m = _SEG.match(line.strip())
        if m:
            out.append((int(m.group(1)), m.group(2).strip()))
    return out


# --------------------------------------------------------------------------- structuring
def _structure(segments: list[tuple[int, str]]) -> dict[str, Any]:
    title = ""
    topics: list[dict[str, Any]] = []
    concepts: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    readings: list[dict[str, Any]] = []
    seen_terms: set[str] = set()
    current: dict[str, Any] | None = None

    for pos, (idx, text) in enumerate(segments):
        sentences = _sentences(text)
        if not title:
            m = _TITLE.search(text)
            if m:
                title = _cap(_clean(m.group(1)))
        m = _TOPIC.search(text)
        if m:
            rest = [x for x in sentences if not _TOPIC.search(x) and len(x) > 30 and not x.endswith("?")]
            current = {"title": _cap(_clean(m.group(1))), "description": rest[0][:600] if rest else None,
                       "segmentIndexes": [idx], "subtopics": []}
            topics.append(current)
        elif current is not None:
            current["segmentIndexes"].append(idx)
            if (current["description"] is None and len(sentences[0]) > 40
                    and not any(x.endswith("?") for x in sentences)):
                current["description"] = sentences[0][:600]
        for sentence in sentences:
            d = None if _TITLE.search(sentence) else _DEFINITION.match(sentence)
            if d:
                term = _clean(d.group(1))
                key = _fold(term)
                if (2 < len(term) <= 60 and key not in seen_terms and len(term.split()) <= 5
                        and key.split()[0] not in _NOT_TERMS):
                    seen_terms.add(key)
                    example = next((x for x in sentences if x != sentence
                                    and re.search(r"por exemplo", x, re.I)), None)
                    concepts.append({"term": term, "definition": sentence[:1500],
                                     "example": example[:1500] if example else None,
                                     "segmentIndexes": [idx]})
            if sentence.endswith("?") and len(sentence) > 15:
                student = bool(re.match(r"^(professora|professor|prof)\b", _fold(sentence)))
                answer = None
                ev = [idx]
                if student and pos + 1 < len(segments):
                    answer = " ".join(_sentences(segments[pos + 1][1])[:2])[:1500]
                    ev.append(segments[pos + 1][0])
                if student or len(questions) < 3:
                    questions.append({"question": sentence[:1500], "answer": answer,
                                      "askedBy": "student" if student else "professor",
                                      "segmentIndexes": ev})
            r = _READING.search(sentence)
            if r:
                rtype = "chapter" if "capítulo" in sentence.lower() else (
                    "article" if "artigo" in sentence.lower() else "book")
                readings.append({"title": _clean(r.group(1)), "authors": _clean(r.group(2)),
                                 "type": rtype, "segmentIndexes": [idx]})

    if not title:
        title = topics[0]["title"] if topics else _cap(_clean(_sentences(segments[0][1])[0]))[:120]
    summary_parts: list[str] = []
    opening = next((x for _, t in segments[:3] for x in _sentences(t) if _TITLE.search(x)), None)
    if opening:
        summary_parts.append(opening)
    for c in concepts[:4]:
        summary_parts.append(c["definition"])
    for t in topics:
        if len(summary_parts) >= 6:
            break
        if t["description"] and not t["description"].endswith("?"):
            summary_parts.append(t["description"])
    if len(summary_parts) < 2:
        summary_parts += [x for _, t in segments[:3] for x in _sentences(t) if not x.endswith("?")][:3]
    summary_parts = list(dict.fromkeys(summary_parts))[:6]
    return {
        "title": title[:300],
        "executiveSummary": " ".join(summary_parts)[:3900],
        "topics": topics[:40],
        "concepts": concepts[:60],
        "questions": questions[:40],
        "readingReferences": readings[:30],
    }


def _merge(prompt: str) -> dict[str, Any]:
    raw = _TAG.sub("", _block(prompt, "Resultados parciais (JSON):")).strip()
    try:
        partials = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("["), raw.rfind("]")
        partials = json.loads(raw[start:end + 1]) if start >= 0 else []
    if isinstance(partials, dict):
        partials = partials.get("partials") or [partials]
    title = next((p.get("title") for p in partials if p.get("title")), "Aula")
    sentences: list[str] = []
    topics: list[dict[str, Any]] = []
    for p in partials:
        sentences.extend(_sentences(p.get("executiveSummary", ""))[:2])
        topics.extend(p.get("topics", []))
    return {"title": title, "executiveSummary": " ".join(sentences[:6]) or title,
            "topics": topics[:40]}


# --------------------------------------------------------------------------- revision
_DISTRACTORS = [
    "Um conceito que não foi abordado nesta disciplina.",
    "O oposto do que foi explicado em aula.",
    "Uma definição que só vale para casos excepcionais, sem relação com o tema.",
]


def _revision(prompt: str) -> dict[str, Any]:
    raw = _TAG.sub("", _block(prompt, "Conceitos selecionados para revisão (JSON):"))
    raw = raw.split("Trechos da aula:")[0].strip()
    try:
        concepts = json.loads(raw)
    except json.JSONDecodeError:
        concepts = []
    segments = _segments(_block(prompt, "Trechos da aula:"))
    flashcards: list[dict[str, Any]] = []
    quiz: list[dict[str, Any]] = []
    for i, c in enumerate(concepts):
        term, definition = c.get("term", ""), c.get("definition", "")
        if not term or not definition:
            continue
        ev = [idx for idx, text in segments if _fold(term) in _fold(text)][:5]
        flashcards.append({"conceptId": c["conceptId"], "front": f"O que é {term}?"[:500],
                           "back": definition[:1500], "segmentIndexes": ev})
        others = [o.get("definition", "") for j, o in enumerate(concepts) if j != i and o.get("definition")]
        options = (others + _DISTRACTORS)[:3]
        correct = i % 4
        options.insert(correct, definition)
        quiz.append({"conceptId": c["conceptId"],
                     "question": f"Qual alternativa descreve corretamente {term}, como visto em aula?"[:1000],
                     "options": [o[:400] for o in options[:4]], "correctOption": correct,
                     "explanation": f"Na aula: {definition}"[:1500], "segmentIndexes": ev})
    return {"flashcards": flashcards[:40], "quiz": quiz[:40]}


# --------------------------------------------------------------------------- assistant
_OUT_OF_SCOPE = re.compile(
    r"\b(faca|faz|resolva) (a|minha) prova|\bcola\b|namor|piada|receita de|futebol|aposta|senha", re.I
)


def _assistant(prompt: str) -> dict[str, Any]:
    question = _TAG.sub("", _block(prompt, "Pergunta do estudante:")).strip()
    if _OUT_OF_SCOPE.search(_fold(question)):
        return {"answer": [], "refusal": "out_of_scope"}
    context = _TAG.sub("", _block(prompt, "Trechos recuperados das aulas (id, aula, horário, texto):"))
    context = context.split("Histórico recente da conversa:")[0]
    sources: list[tuple[str, str]] = []
    summaries: list[str] = []
    for line in context.splitlines():
        line = line.strip()
        if m := _SRC.match(line):
            sources.append((m.group(1), m.group(2)))
        elif m := _SUMMARY.match(line):
            summaries.append(m.group(2))
    qtok = _tokens(question)
    if not qtok or not sources:
        return {"answer": [], "refusal": "no_evidence"}

    scored: list[tuple[float, str, str]] = []
    for sid, text in sources:
        for sentence in _sentences(text):
            if sentence.endswith("?") or _TITLE.search(sentence):
                continue
            score = len(qtok & _tokens(sentence)) / len(qtok)
            d = _DEFINITION.match(sentence)
            if d and _tokens(d.group(1)) & qtok:
                score += 1.0  # a definition of the asked term is the best evidence
            if score > 0:
                scored.append((score, sid, sentence))
    scored.sort(key=lambda x: -x[0])
    if not scored or scored[0][0] < 0.25:
        return {"answer": [], "refusal": "no_evidence"}

    blocks: list[dict[str, Any]] = []
    used: set[str] = set()
    for score, sid, sentence in scored:
        if sid in used or score < 0.25 or len(blocks) >= 2:
            continue
        used.add(sid)
        blocks.append({"kind": "professor_statement",
                       "text": f"Em aula foi explicado: {sentence}",
                       "citationIds": [sid], "quote": sentence})

    explanation: list[str] = []
    for summary in summaries:
        for part in summary.split("Conceitos:", 1)[-1].split(";"):
            term = part.split(":", 1)[0].strip()
            if term and _tokens(term) & qtok and ":" in part:
                explanation.append(part.split(":", 1)[1].strip())
    if explanation:
        text = "Resumindo com base no material da aula: " + " ".join(dict.fromkeys(explanation))[:1200]
    else:
        text = ("Resumindo: os trechos citados acima são os pontos da aula que respondem à sua "
                "pergunta. Vale revisar a transcrição nesses horários para ver o contexto completo.")
    blocks.append({"kind": "ai_explanation", "text": text, "citationIds": sorted(used)})
    return {"answer": blocks, "refusal": None}


# --------------------------------------------------------------------------- provider
_HANDLERS: dict[str, Callable[[str], dict[str, Any]]] = {
    "lecture-structuring": lambda p: _structure(_segments(p)) if _segments(p) else {},
    "lecture-structuring-merge": _merge,
    "revision-materials": _revision,
    "assistant-answer": _assistant,
}


class DemoProvider:
    name = "demo"

    def __init__(self, model: str = "demo-extractive") -> None:
        self._model = model

    async def generate(self, request: ProviderRequest) -> ProviderResponse:
        prompt = "\n".join(m.text for m in request.messages)
        handler = _HANDLERS.get(request.prompt_id)
        output: Any = None
        if handler is not None:
            try:
                output = handler(prompt)
            except Exception:  # noqa: BLE001 - a demo must degrade, not crash
                output = None
        if not output:
            output = minimal_instance(request.response_schema, request.response_schema)
        text = json.dumps(output, ensure_ascii=False)
        return ProviderResponse(
            text=text,
            model=self._model,
            input_tokens=estimate_tokens(request.system + prompt),
            output_tokens=estimate_tokens(text),
        )
