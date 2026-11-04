from __future__ import annotations

from datetime import date

import pytest

from event_extraction.dates import DateResolver, ResolverContext

CLASS_DATE = date(2026, 3, 10)  # Tuesday
CTX = ResolverContext(CLASS_DATE, [date(2026, 3, 17), date(2026, 3, 24)])
R = DateResolver()


@pytest.mark.parametrize(
    ("text", "expected", "method"),
    [
        ("a prova será no dia 20 de novembro", "2026-11-20", "absolute"),
        ("prova em 15 de março", "2026-03-15", "absolute"),
        ("entrega em 15 de janeiro", "2027-01-15", "absolute"),  # year rollover
        ("prova no dia 15/04/2026", "2026-04-15", "absolute"),
        ("prova 15/4/26", "2026-04-15", "absolute"),
        ("trabalho para o dia 20", "2026-03-20", "absolute"),
        ("relatório para o dia 2", "2026-04-02", "absolute"),
        ("dia 10 do mês que vem", "2026-04-10", "absolute"),
        ("dia vinte e cinco de maio", "2026-05-25", "absolute"),
        ("amanhã tem quiz", "2026-03-11", "relative"),
        ("depois de amanhã", "2026-03-12", "relative"),
        ("daqui a duas semanas", "2026-03-24", "relative"),
        ("em 15 dias", "2026-03-25", "relative"),
        ("na próxima aula", "2026-03-17", "next_class"),
        ("para a aula que vem", "2026-03-17", "next_class"),
        ("semana que vem", "2026-03-17", "next_class"),
        ("na próxima segunda-feira", "2026-03-16", "weekday"),
        ("sexta que vem", "2026-03-13", "weekday"),
        ("na quarta da semana que vem", "2026-03-18", "weekday"),
        ("semana que vem, na quinta", "2026-03-19", "weekday"),
        ("no sábado, dia 21 de março", "2026-03-21", "absolute"),
        ("foi remarcada do dia 24 de março para o dia 26 de março", "2026-03-26", "absolute"),
        ("o prazo que era dia 12 agora fica para dia 19", "2026-03-19", "absolute"),
    ],
)
def test_resolves_dates(text: str, expected: str, method: str) -> None:
    res = R.resolve(text, CTX)
    assert res.event_date is not None, res.explanation
    assert res.event_date.isoformat() == expected
    assert res.method == method
    assert not res.ambiguous
    assert res.expression


@pytest.mark.parametrize(
    "text",
    [
        "lá para o final do mês que vem",
        "a prova vai ser mês que vem",
        "depois do feriado",
        "em breve",
        "lá pra dezembro",
        "no fim do semestre",
        "data a definir",
        "a prova é dia 20 ou dia 27",
    ],
)
def test_ambiguous_expressions_are_held(text: str) -> None:
    res = R.resolve(text, CTX)
    assert res.ambiguous
    assert res.event_date is None
    assert res.explanation


def test_ordinal_segunda_is_not_a_weekday() -> None:
    res = R.resolve("a segunda prova", CTX)
    assert res.event_date is None
    assert not res.ambiguous


def test_invalid_date_is_not_resolved() -> None:
    res = R.resolve("prova dia 31 de fevereiro", CTX)
    assert res.event_date is None
    assert res.ambiguous


def test_past_date_is_flagged() -> None:
    res = R.resolve("a entrega era dia 3 de março", CTX)
    assert res.event_date == date(2026, 3, 3)
    assert res.past


def test_next_class_without_calendar_is_ambiguous() -> None:
    res = R.resolve("na próxima aula", ResolverContext(CLASS_DATE, []))
    assert res.ambiguous and res.event_date is None


def test_next_week_with_two_classes_is_ambiguous() -> None:
    ctx = ResolverContext(CLASS_DATE, [date(2026, 3, 17), date(2026, 3, 19)])
    res = R.resolve("prova semana que vem", ctx)
    assert res.ambiguous
    assert res.candidates == ["2026-03-17", "2026-03-19"]


@pytest.mark.parametrize(
    ("text", "time"),
    [
        ("amanhã às 19h", "19:00"),
        ("amanhã 19h30", "19:30"),
        ("amanhã às 7 da noite", "19:00"),
        ("amanhã às 8 da manhã", "08:00"),
        ("amanhã às 14:15", "14:15"),
        ("amanhã ao meio dia", "12:00"),
    ],
)
def test_times(text: str, time: str) -> None:
    assert R.resolve(text, CTX).event_time == time
