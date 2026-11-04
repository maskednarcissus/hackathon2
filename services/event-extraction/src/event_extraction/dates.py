"""Deterministic Brazilian Portuguese date and time resolution (deliverables 2.9, 2.10).

Date interpretation is never delegated to the LLM: every event date is produced here
from the spoken expression, the class date (in the campus timezone) and the section's
upcoming scheduled classes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal

from .text import normalize_aligned

DateMethod = Literal["absolute", "relative", "next_class", "weekday", "none"]

MONTHS = {
    "janeiro": 1,
    "fevereiro": 2,
    "marco": 3,
    "abril": 4,
    "maio": 5,
    "junho": 6,
    "julho": 7,
    "agosto": 8,
    "setembro": 9,
    "outubro": 10,
    "novembro": 11,
    "dezembro": 12,
}
WEEKDAYS = {
    "segunda": 0,
    "terca": 1,
    "quarta": 2,
    "quinta": 3,
    "sexta": 4,
    "sabado": 5,
    "domingo": 6,
}
_UNITS = {
    "um": 1,
    "uma": 1,
    "primeiro": 1,
    "dois": 2,
    "duas": 2,
    "tres": 3,
    "quatro": 4,
    "cinco": 5,
    "seis": 6,
    "sete": 7,
    "oito": 8,
    "nove": 9,
}
_TEENS = {
    "dez": 10,
    "onze": 11,
    "doze": 12,
    "treze": 13,
    "quatorze": 14,
    "catorze": 14,
    "quinze": 15,
    "dezesseis": 16,
    "dezessete": 17,
    "dezoito": 18,
    "dezenove": 19,
}


def _number_words() -> dict[str, int]:
    words: dict[str, int] = {**_UNITS, **_TEENS, "vinte": 20, "trinta": 30}
    for tens_word, tens in (("vinte", 20), ("trinta", 30)):
        for unit_word, unit in _UNITS.items():
            if unit_word == "primeiro" or tens + unit > 31:
                continue
            words[f"{tens_word} e {unit_word}"] = tens + unit
    return words


NUMBER_WORDS = _number_words()
_NUM_ALT = "|".join(sorted((re.escape(w) for w in NUMBER_WORDS), key=len, reverse=True))
_NUM = rf"(?:\d{{1,2}}|{_NUM_ALT})"
_MONTH_ALT = "|".join(MONTHS)
_WEEKDAY_ALT = "segunda|terca|quarta|quinta|sexta|sabado|domingo"
_ORDINAL_NOUNS = (
    "prova|provas|chamada|parte|lista|etapa|avaliacao|unidade|entrega|fase|questao|vez|aula|"
    "semana|versao|turma|edicao|opcao|metade|serie|tarefa|atividade|rodada"
)


def parse_number(token: str) -> int | None:
    token = token.strip()
    if token.isdigit():
        return int(token)
    return NUMBER_WORDS.get(token)


@dataclass
class DateCandidate:
    start: int
    end: int
    value: date
    method: DateMethod
    confidence: float


@dataclass
class DateResolution:
    method: DateMethod = "none"
    ambiguous: bool = False
    candidates: list[str] = field(default_factory=list)
    explanation: str = ""
    expression: str | None = None
    event_date: date | None = None
    event_time: str | None = None
    time_expression: str | None = None
    confidence: float = 0.2
    past: bool = False

    @property
    def has_temporal_reference(self) -> bool:
        return self.event_date is not None or self.ambiguous


@dataclass
class ResolverContext:
    class_date: date
    upcoming_class_dates: list[date] = field(default_factory=list)


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _infer_year(class_date: date, month: int, day: int) -> date | None:
    candidate = _safe_date(class_date.year, month, day)
    if candidate is None:
        return None
    # A date more than 30 days in the past is almost always next year's
    # ("15 de março" said in November). Recent past dates stay as-is → flagged past.
    if candidate < class_date - timedelta(days=30):
        return _safe_date(class_date.year + 1, month, day)
    return candidate


def _add_months(d: date, months: int) -> tuple[int, int]:
    total = d.month - 1 + months
    return d.year + total // 12, total % 12 + 1


def _next_weekday(after: date, weekday: int, *, strictly_after: bool = True) -> date:
    delta = (weekday - after.weekday()) % 7
    if delta == 0 and strictly_after:
        delta = 7
    return after + timedelta(days=delta)


def _weekday_next_week(class_date: date, weekday: int) -> date:
    monday_next = class_date - timedelta(days=class_date.weekday()) + timedelta(days=7)
    return monday_next + timedelta(days=weekday)


_AMBIGUOUS_PATTERNS = [
    rf"\b(?:final|fim|comeco|inicio|meio|metade)\s+d[oea]\s+(?:mes|semestre|bimestre|ano|"
    rf"{_MONTH_ALT})(?:\s+que\s+vem)?\b",
    r"\b(?:mes\s+que\s+vem|proximo\s+mes)\b",
    r"\bdepois\s+do\s+feriado\b",
    r"\bem\s+breve\b",
    r"\bla\s+(?:pra|para|pro|por)\s+\w+",
    r"\bmais\s+(?:pra|para)\s+frente\b",
    r"\bqualquer\s+dia\b",
    r"\bum\s+dia\s+desses\b",
    r"\bnas\s+proximas\s+semanas\b",
    r"\b(?:ainda\s+)?(?:vou|vamos|preciso|precisamos)\s+(?:marcar|definir|ver|confirmar)\s+"
    r"(?:a\s+)?data\b",
    r"\ba\s+(?:definir|combinar|confirmar)\b",
    rf"\b(?:em|no\s+mes\s+de)\s+(?:{_MONTH_ALT})\b",
    r"\bproximamente\b",
]

_PREFERENCE_BEFORE = re.compile(
    r"(?:\b(?:para|pra|pro|ate|adiad[ao]\s+para|passa\s+para|fica\s+para)\b(?:\s+(?:o|a|os|as))?"
    r"(?:\s+dia)?|\bpara\s+o\s+dia)\s*$"
)
_STRONG_PREFERENCE_BEFORE = re.compile(
    r"\b(?:fica|ficou|ficar|passa|passou|adiad[ao]s?|remarcad[ao]s?|transferid[ao]s?|mudou|muda|"
    r"mudamos|agora)\s+(?:(?:para|pra|pro)\s+)?(?:(?:o|a)\s+)?(?:dia\s+)?$"
)


class DateResolver:
    """Resolves pt-BR date/time expressions inside a clause."""

    def resolve(self, text: str, ctx: ResolverContext) -> DateResolution:
        norm = normalize_aligned(text)
        taken: list[tuple[int, int]] = []
        candidates: list[DateCandidate] = []
        notes: list[str] = []

        def free(s: int, e: int) -> bool:
            return all(e <= ts or s >= te for ts, te in taken)

        def add(s: int, e: int, value: date | None, method: DateMethod, conf: float) -> None:
            if not free(s, e):
                return
            taken.append((s, e))
            if value is None:
                notes.append(f"'{text[s:e].strip()}' não corresponde a uma data válida")
                return
            candidates.append(DateCandidate(s, e, value, method, conf))

        cd = ctx.class_date

        # 1. "dia 10 do mês que vem"
        for m in re.finditer(
            rf"\b(?:dia\s+)?({_NUM})\s+do\s+(?:mes\s+que\s+vem|proximo\s+mes)\b", norm
        ):
            day = parse_number(m.group(1))
            y, mo = _add_months(cd, 1)
            add(m.start(), m.end(), _safe_date(y, mo, day or 0), "absolute", 0.95)

        # 2. "20 de novembro (de 2026)"
        for m in re.finditer(
            rf"\b(?:dia\s+)?({_NUM})\s+de\s+({_MONTH_ALT})(?:\s+de\s+(\d{{4}}))?\b", norm
        ):
            day = parse_number(m.group(1)) or 0
            month = MONTHS[m.group(2)]
            if m.group(3):
                value = _safe_date(int(m.group(3)), month, day)
            else:
                value = _infer_year(cd, month, day)
            add(m.start(), m.end(), value, "absolute", 0.97)

        # 3. numeric "15/11", "15/11/2026"
        for m in re.finditer(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", norm):
            day, month = int(m.group(1)), int(m.group(2))
            if not 1 <= month <= 12:
                continue
            if m.group(3):
                year = int(m.group(3))
                year = year + 2000 if year < 100 else year
                value = _safe_date(year, month, day)
            else:
                value = _infer_year(cd, month, day)
            add(m.start(), m.end(), value, "absolute", 0.95)

        # 4. "depois de amanhã" / "amanhã" / "hoje"
        for m in re.finditer(r"\bdepois\s+de\s+amanha\b", norm):
            add(m.start(), m.end(), cd + timedelta(days=2), "relative", 0.93)
        for m in re.finditer(r"\bamanha\b", norm):
            add(m.start(), m.end(), cd + timedelta(days=1), "relative", 0.93)
        for m in re.finditer(r"\bhoje\b", norm):
            add(m.start(), m.end(), cd, "relative", 0.9)

        # 5. "daqui a duas semanas", "em 15 dias", "dentro de 10 dias"
        for m in re.finditer(
            rf"\b(?:daqui\s+a|em|dentro\s+de)\s+({_NUM})\s+(dias?|semanas?)\b", norm
        ):
            n = parse_number(m.group(1))
            if n is None:
                continue
            days = n * 7 if m.group(2).startswith("semana") else n
            add(m.start(), m.end(), cd + timedelta(days=days), "relative", 0.9)
        for m in re.finditer(r"\bdaqui\s+a\s+uma\s+semana\b", norm):
            add(m.start(), m.end(), cd + timedelta(days=7), "relative", 0.9)

        # 6. next class
        for m in re.finditer(
            r"\b(?:(?:na|para\s+a|pra|ate\s+a)\s+)?(?:proxima\s+aula|aula\s+que\s+vem|"
            r"proximo\s+encontro|aula\s+seguinte)\b",
            norm,
        ):
            upcoming = sorted(d for d in ctx.upcoming_class_dates if d > cd)
            if upcoming:
                add(m.start(), m.end(), upcoming[0], "next_class", 0.9)
            elif free(m.start(), m.end()):
                taken.append((m.start(), m.end()))
                notes.append("'próxima aula' sem aulas futuras conhecidas no calendário da turma")

        # 7. weekdays
        used_next_week = False
        has_next_week = re.search(r"\b(?:semana\s+que\s+vem|proxima\s+semana)\b", norm)
        for m in re.finditer(
            rf"\b(?:(proxima|proximo|nesta|nessa|esta|essa|na|no|ate|pra|para|dessa|desta|e|sera|"
            rf"ser|vai\s+ser)\s+)?"
            rf"(?:(?:a|o)\s+)?({_WEEKDAY_ALT})(\s+feira)?(\s+que\s+vem)?"
            rf"(\s+(?:da|na)\s+(?:semana\s+que\s+vem|proxima\s+semana))?\b",
            norm,
        ):
            prefix, wd_word, feira, que_vem, next_week = m.groups()
            following = norm[m.end() :].lstrip()
            weekday_is_ordinal = wd_word in {"segunda", "terca", "quarta", "quinta", "sexta"} and (
                re.match(rf"(?:{_ORDINAL_NOUNS})\b", following) is not None
            )
            if weekday_is_ordinal and not feira:
                continue
            if wd_word in {"segunda", "terca", "quarta", "quinta", "sexta"}:
                if not (prefix or feira or que_vem or next_week):
                    continue
            weekday = WEEKDAYS[wd_word]
            if next_week or (has_next_week and not que_vem and prefix not in {"proxima"}):
                value = _weekday_next_week(cd, weekday)
                used_next_week = True
            else:
                value = _next_weekday(cd, weekday)
            add(m.start(), m.end(), value, "weekday", 0.9)

        # 8. "semana que vem" alone → the section's class next week, else +7 days
        for m in re.finditer(r"\b(?:na\s+)?(?:semana\s+que\s+vem|proxima\s+semana)\b", norm):
            if not free(m.start(), m.end()):
                continue
            if used_next_week:
                taken.append((m.start(), m.end()))
                continue
            week_start = cd - timedelta(days=cd.weekday()) + timedelta(days=7)
            week_end = week_start + timedelta(days=6)
            in_week = sorted(d for d in ctx.upcoming_class_dates if week_start <= d <= week_end)
            if len(in_week) == 1:
                add(m.start(), m.end(), in_week[0], "next_class", 0.85)
            elif len(in_week) > 1:
                taken.append((m.start(), m.end()))
                notes.append("'semana que vem' com mais de uma aula da turma na semana")
                for d in in_week:
                    candidates.append(DateCandidate(m.start(), m.end(), d, "relative", 0.5))
            else:
                add(m.start(), m.end(), cd + timedelta(days=7), "relative", 0.75)

        # 9. bare "dia 15"
        for m in re.finditer(rf"\bdia\s+({_NUM})\b(?!\s*/)", norm):
            day = parse_number(m.group(1))
            if day is None or not 1 <= day <= 31:
                continue
            if day >= cd.day:
                value = _safe_date(cd.year, cd.month, day)
            else:
                y, mo = _add_months(cd, 1)
                value = _safe_date(y, mo, day)
            add(m.start(), m.end(), value, "absolute", 0.85)

        # ambiguous expressions not covered by a resolved candidate
        ambiguous_spans: list[tuple[int, int]] = []
        for pattern in _AMBIGUOUS_PATTERNS:
            for m in re.finditer(pattern, norm):
                if free(m.start(), m.end()):
                    ambiguous_spans.append((m.start(), m.end()))

        resolution = self._decide(text, norm, candidates, ambiguous_spans, notes, ctx)
        self._resolve_time(text, norm, resolution)
        return resolution

    def _decide(
        self,
        text: str,
        norm: str,
        candidates: list[DateCandidate],
        ambiguous_spans: list[tuple[int, int]],
        notes: list[str],
        ctx: ResolverContext,
    ) -> DateResolution:
        distinct = sorted({c.value for c in candidates})
        res = DateResolution(candidates=[d.isoformat() for d in distinct])

        if not candidates:
            if ambiguous_spans or notes:
                s, e = ambiguous_spans[0] if ambiguous_spans else (0, 0)
                res.ambiguous = True
                res.expression = text[s:e].strip() or None
                res.confidence = 0.3
                res.explanation = (
                    f"Expressão temporal vaga ('{res.expression}'): "
                    "requer confirmação do professor."
                    if res.expression
                    else "; ".join(notes)
                )
            else:
                res.explanation = "Nenhuma expressão de data encontrada."
            return res

        chosen: DateCandidate | None = None
        absolute_dates = {c.value for c in candidates if c.method == "absolute"}
        weekday_only = all(c.method in ("absolute", "weekday") for c in candidates)
        if len(distinct) == 1:
            chosen = max(candidates, key=lambda c: c.confidence)
        elif (
            weekday_only
            and len(absolute_dates) == 1
            and all(
                c.value.weekday() == next(iter(absolute_dates)).weekday()
                for c in candidates
                if c.method == "weekday"
            )
        ):
            # "sábado, dia 21 de março": the weekday names the absolute date's weekday
            chosen = max(
                (c for c in candidates if c.method == "absolute"), key=lambda c: c.confidence
            )
        else:
            preferred = [
                c for c in candidates if _STRONG_PREFERENCE_BEFORE.search(norm[: c.start])
            ] or [c for c in candidates if _PREFERENCE_BEFORE.search(norm[: c.start])]
            preferred_dates = {c.value for c in preferred}
            if len(preferred_dates) == 1:
                chosen = max(preferred, key=lambda c: c.confidence)
                others = [d.isoformat() for d in distinct if d != chosen.value]
                notes.append(f"data anterior/alternativa mencionada: {', '.join(others)}")
            elif all(c.confidence <= 0.5 for c in candidates):
                chosen = None

        if chosen is None:
            res.ambiguous = True
            res.confidence = 0.3
            res.expression = text[min(c.start for c in candidates) : max(c.end for c in candidates)]
            res.explanation = "Datas conflitantes mencionadas: " + ", ".join(res.candidates)
            if notes:
                res.explanation += " (" + "; ".join(notes) + ")"
            return res

        res.method = chosen.method
        res.event_date = chosen.value
        res.expression = text[chosen.start : chosen.end].strip()
        res.confidence = chosen.confidence
        res.candidates = [chosen.value.isoformat()]
        if ambiguous_spans:
            res.confidence = min(res.confidence, 0.75)
            notes.append("há também uma expressão temporal vaga na mesma frase")
        if chosen.value < ctx.class_date:
            res.past = True
            notes.append("data no passado em relação à aula")
        res.explanation = (
            f"'{res.expression}' resolvido para {chosen.value.isoformat()} "
            f"({_METHOD_LABEL[chosen.method]}, aula em {ctx.class_date.isoformat()}, "
            f"{_WEEKDAY_LABEL[chosen.value.weekday()]})"
        )
        if notes:
            res.explanation += "; " + "; ".join(notes)
        return res

    def _resolve_time(self, text: str, norm: str, res: DateResolution) -> None:
        patterns: list[tuple[str, int]] = [
            (r"\b(?:as\s+|a\s+partir\s+das\s+)?(\d{1,2})h(\d{2})?\b", 0),
            (r"\b(?:as\s+)?(\d{1,2}):(\d{2})\b", 0),
            (rf"\b(?:as|a)\s+({_NUM})(?:\s+horas?)?\s+da\s+(manha|tarde|noite)\b", 1),
            (rf"\b(?:as|a)\s+({_NUM})\s+horas?\b", 2),
            (r"\bao\s+meio\s+dia\b|\bmeio\s+dia\b", 3),
        ]
        for pattern, kind in patterns:
            m = re.search(pattern, norm)
            if not m:
                continue
            if kind == 3:
                hour, minute = 12, 0
            elif kind == 0:
                hour = int(m.group(1))
                minute = int(m.group(2) or 0)
            else:
                hour = parse_number(m.group(1)) or -1
                minute = 0
                if kind == 1:
                    period = m.group(2)
                    if period in {"tarde", "noite"} and hour < 12:
                        hour += 12
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                res.event_time = f"{hour:02d}:{minute:02d}"
                res.time_expression = text[m.start() : m.end()].strip()
                return


_METHOD_LABEL: dict[DateMethod, str] = {
    "absolute": "data absoluta",
    "relative": "data relativa",
    "next_class": "próxima aula da turma",
    "weekday": "dia da semana",
    "none": "sem data",
}
_WEEKDAY_LABEL = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
