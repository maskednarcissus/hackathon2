"""pt-BR keyword families and linguistic cues for academic event detection (2.8, 2.21)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .models import EventType
from .text import normalize

# Ordered by priority: when a clause matches several families the first wins
# (e.g. "a apresentação do trabalho" → presentation; "a aula de reposição" → reschedule).
_FAMILIES: list[tuple[EventType, list[str], list[str]]] = [
    # (type, strong patterns, weak patterns)
    (
        "class_cancellation",
        [
            r"\bnao\s+(?:teremos|havera|vai\s+ter|vamos\s+ter|tem|haver[aá])\s+aula",
            r"\baulas?\s+(?:de\s+\w+\s+)?(?:esta|estao|foi|foram|vai\s+ser|sera|fica|ficou)\s+"
            r"(?:cancelad|suspens)",
            r"\baulas?\s+cancelad",
            r"\b(?:cancelar|cancelei|cancelamos|suspender)\s+(?:a|as|nossa)\s+aulas?",
            r"\bsem\s+aula\b",
            r"\bnao\s+(?:vou|vamos|irei)\s+(?:dar|ter)\s+aula",
            r"\bnao\s+vai\s+haver\s+aula",
        ],
        [],
    ),
    (
        "class_reschedule",
        [
            r"\breposicao\b",
            r"\baula\s+(?:\w+\s+)?(?:foi|vai\s+ser|sera|fica|esta)\s+(?:remarcad|transferid|"
            r"adiantad|adiad)",
            r"\b(?:remarcar|remarquei|remarcamos|repor|transferir|antecipar|adiantar)\s+(?:a|as|"
            r"nossa|essa)\s+aulas?",
            r"\baula\s+extra\b",
            r"\baula\s+remarcad",
            r"\baula\b[^.]{0,40}\b(?:remarcad|transferid|adiad|antecipad)",
            r"\b(?:vamos|vou|iremos)\s+repor\b",
        ],
        [],
    ),
    (
        "room_change",
        [
            r"\b(?:mudanca|troca|mudar|mudamos|trocar|trocamos|mudou|muda)\s+(?:de\s+)?"
            r"(?:sala|laboratorio|auditorio|predio|bloco)",
            r"\b(?:nova|outra)\s+sala\b",
            r"\b(?:aula|prova|aulas)\s+(?:\w+\s+){0,3}(?:vai\s+ser|vao\s+ser|sera|serao|sera\s+feita|"
            r"acontece|vai\s+acontecer)\s+(?:no|na)\s+(?:sala|laboratorio|auditorio|bloco)\b"
            r"(?=.*\b(?:excepcionalmente|em\s+vez|ao\s+inves|nao\s+(?:aqui|nesta|nessa)|"
            r"mudou|mudanca|troca)\b)",
            r"\bem\s+vez\s+d[ae]\s+(?:sala|laboratorio)",
        ],
        [],
    ),
    (
        "examination",
        [
            r"\bprovas?\b",
            r"\bavaliac(?:ao|oes)\b",
            r"\bp[1-4]\b",
            r"\bexames?\b",
            r"\bsimulados?\b",
            r"\bsegunda\s+chamada\b",
        ],
        [],
    ),
    (
        "quiz",
        [r"\bquiz(?:zes)?\b", r"\bteste\s+rapido\b", r"\bprovinha\b", r"\bminiteste\b"],
        [r"\bteste\b", r"\bquestionario\b"],
    ),
    (
        "presentation",
        [r"\bseminarios?\b", r"\bapresentac(?:ao|oes)\b", r"\bapresentarem\b"],
        [r"\bapresentar\b"],
    ),
    (
        "project",
        [r"\bprojetos?\b", r"\btcc\b"],
        [],
    ),
    (
        "assignment",
        [
            r"\btrabalhos?\b",
            r"\blistas?\s+de\s+exercicios?\b",
            r"\brelatorios?\b",
            r"\bresenhas?\b",
            r"\bfichamentos?\b",
            r"\btarefas?\b",
            r"\bestudo\s+de\s+caso\b",
        ],
        [r"\blistas?\b", r"\bentregar\b", r"\bentrega\b", r"\bprazo\b", r"\bexercicios\b"],
    ),
    (
        "reading_deadline",
        [
            r"\bleitura\b",
            r"\bler\s+(?:o|os|a|as)\s+(?:capitulos?|textos?|artigos?|livro)",
            r"\bleiam\b",
            r"\blerem\b",
        ],
        [r"\bler\b"],
    ),
]

_COMPILED = [
    (t, [re.compile(p) for p in strong], [re.compile(p) for p in weak])
    for t, strong, weak in _FAMILIES
]


@dataclass(frozen=True)
class Classification:
    type: EventType
    strength: float
    keyword: str
    matched_families: int


def classify(text: str) -> Classification | None:
    norm = normalize(text)
    hits: list[tuple[EventType, float, str]] = []
    for event_type, strong, weak in _COMPILED:
        for pattern in strong:
            m = pattern.search(norm)
            if m:
                hits.append((event_type, 0.92, m.group(0)))
                break
        else:
            for pattern in weak:
                m = pattern.search(norm)
                if m:
                    hits.append((event_type, 0.72, m.group(0)))
                    break
    if not hits:
        return None
    strong_hits = [h for h in hits if h[1] >= 0.9]
    best = strong_hits[0] if strong_hits else hits[0]
    families = len({h[0] for h in hits})
    strength = best[1] if families == 1 or best[0] in _ANNOUNCEMENT_TYPES else best[1] - 0.04
    # Mixed families are normal ("entrega do trabalho"): only penalise when the winner is weak.
    if not strong_hits and families > 1:
        strength -= 0.06
    return Classification(best[0], strength, best[2], families)


def supports_type(text: str, event_type: EventType) -> bool:
    """True when ``text`` contains a keyword of ``event_type``'s family (hallucination rule)."""
    norm = normalize(text)
    for t, strong, weak in _COMPILED:
        if t == event_type:
            return any(p.search(norm) for p in [*strong, *weak])
    return event_type == "other"


_ANNOUNCEMENT_TYPES = {"class_cancellation", "class_reschedule", "room_change"}

_HYPOTHETICAL = [
    r"\bse\b[^.]{0,60}\b(?:fosse|fossem|tivesse|tivessem|caisse|houvesse|fizesse|desse)\b",
    r"\bimagin(?:e|em|a|emos|ando)\b",
    r"\bsuponh(?:a|am|amos)\b",
    r"\bsupondo\b",
    r"\bhipotetic",
    r"\bcaso\s+(?:tivesse|fosse|houvesse)\b",
    r"\bpor\s+exemplo\s*,?\s*(?:numa|em\s+uma|uma)\s+prova\b",
    r"\bnuma\s+prova\s+hipotetica\b",
    r"\bem\s+(?:uma|qualquer)\s+prova\s+de\s+concurso\b",
]
_RETROSPECTIVE = [
    r"\b(?:prova|provas|trabalho|trabalhos|avaliacao|seminario|quiz|lista)\s+(?:passad[ao]s?|"
    r"anterior(?:es)?|de\s+ontem|da\s+semana\s+passada|do\s+semestre\s+passado|do\s+ano\s+passado)\b",
    r"\b(?:na|da|a)\s+ultima\s+(?:prova|avaliacao|aula)\b[^.]{0,40}\b(?:foi|teve|tiveram|"
    r"fizeram|tirou|tiraram)\b",
    r"\b(?:corrigi|corrigimos|devolvi|devolver)\s+(?:as|a|os|o)\s+(?:provas?|trabalhos?)\b",
    r"\bnotas?\s+d[ao]s?\s+(?:prova|trabalho)",
    r"\b(?:no|ano|semestre)\s+passado\b[^.]{0,40}\b(?:prova|trabalho)\b",
]
_NEGATED = [
    r"\bnao\s+(?:vai|vamos|vao|teremos|havera|tem|terao)\s+(?:ter\s+)?(?:prova|trabalho|quiz|"
    r"seminario|lista|avaliacao)",
    r"\bsem\s+(?:prova|trabalho|quiz|seminario)\b",
    r"\bnao\s+cai\s+na\s+prova\b",
    r"\bnao\s+precisa(?:m)?\s+(?:entregar|fazer)\b",
]
_HEDGES = [
    r"\bacho\s+que\b",
    r"\btalvez\b",
    r"\bprovavelmente\b",
    r"\bpode\s+ser\s+que\b",
    r"\bse\s+(?:der|tudo\s+der\s+certo|nao\s+mudar)\b",
    r"\bnao\s+sei\s+(?:ainda|se)\b",
    r"\bainda\s+nao\s+(?:sei|decidi|tenho\s+certeza)\b",
    r"\bou\b[^.]{0,25}\bou\b",
]
_ANNOUNCEMENT_CUES = [
    r"\b(?:teremos|vamos\s+ter|vai\s+ter|havera|tera|teremos\s+um|tem\s+(?:uma|um))\b",
    r"\b(?:sera|vai\s+ser|vao\s+ser|serao|fica|ficou|foi\s+marcad|marquei|marcamos)\b",
    r"\b(?:entreguem|entregar\s+ate|prazo\s+(?:e|ate|final))\b",
    r"\blembrando\s+que\b",
    r"\b(?:anotem|aviso\s+importante)\b",
]
_OTHER_COURSE = [
    r"\boutra\s+(?:turma|disciplina|materia)\b",
    r"\bturma\s+d[ao]\s+(?:manha|tarde|noite)\b",
    r"\bna\s+disciplina\s+d[oe]\b",
]


def _any(patterns: list[str], text: str) -> str | None:
    norm = normalize(text)
    for p in patterns:
        m = re.search(p, norm)
        if m:
            return m.group(0)
    return None


def is_hypothetical(text: str) -> bool:
    return _any(_HYPOTHETICAL, text) is not None


def is_retrospective(text: str) -> bool:
    return _any(_RETROSPECTIVE, text) is not None


def is_negated(text: str) -> bool:
    return _any(_NEGATED, text) is not None


def hedge(text: str) -> str | None:
    return _any(_HEDGES, text)


def has_announcement_cue(text: str) -> bool:
    return _any(_ANNOUNCEMENT_CUES, text) is not None


def mentions_other_course(text: str) -> bool:
    return _any(_OTHER_COURSE, text) is not None


def has_date_change_cue(text: str) -> bool:
    return (
        _any(
            [
                r"\b(?:fica|ficou|passa|passou|mudou|muda|mudamos)\s+(?:para|pra|pro)\b",
                r"\b(?:adiad|remarcad|transferid|antecipad|prorrogad)\w*\b",
                r"\b(?:adiar|remarcar|prorrogar|antecipar|mudar\s+a\s+data)\b",
                r"\bnova\s+data\b",
                r"\bem\s+vez\s+d[oae]\s+dia\b",
                r"\bnao\s+(?:e|sera)\s+mais\s+(?:no\s+)?dia\b",
            ],
            text,
        )
        is not None
    )


def is_content_reference(text: str) -> bool:
    """ "Isso cai na prova" — refers to exam content, not an announcement."""
    return (
        _any(
            [
                r"\b(?:cai|caem|caira|vai\s+cair|vao\s+cair|pode\s+cair)\s+n[ao]s?\s+"
                r"(?:prova|provas|avaliacao|p[1-4])\b",
                r"\b(?:importante|essencial)\s+para\s+a\s+prova\b",
                r"\bestudem\s+para\s+a\s+prova\b",
            ],
            text,
        )
        is not None
    )
