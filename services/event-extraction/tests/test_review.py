from __future__ import annotations

from conftest import CLASS_2, PROF_HEADERS, PROFESSOR, Harness

from event_extraction.models import PublicationPolicy

ADMIN = {"X-Actor-Id": "admin-1", "X-Actor-Role": "admin"}


def _exam(h: Harness, text: str = "A P1 vai ser dia 24/03.") -> str:
    return str(h.extract(text)["events"][0]["id"])


def test_confirm_publishes_with_provenance(harness: Harness) -> None:
    eid = _exam(harness)
    r = harness.client.post(f"/v1/events/{eid}/confirm", headers=PROF_HEADERS, json={"notes": "ok"})
    assert r.status_code == 200, r.text
    ev = r.json()
    assert ev["confirmationStatus"] == "published"
    assert [c["newValue"] for c in ev["changeHistory"]] == ["confirmed", "published"]
    assert ev["changeHistory"][0]["source"] == "professor"
    payload = harness.calendar.published[ev["calendarEventId"]]
    assert payload["isOfficial"] is True
    assert payload["provenance"]["confirmedBy"] == PROFESSOR
    assert payload["provenance"]["segmentIndex"] == 0
    actions = [r["action"] for r in harness.audit.records]
    assert "event.confirmed" in actions and "event.published" in actions
    types = [e["type"] for e in harness.publisher.events]
    assert "event.confirmed" in types and "event.published" in types


def test_confirm_without_publish_on_confirm_then_publish() -> None:
    h = Harness(policy=PublicationPolicy(publish_on_confirm=False))
    eid = _exam(h)
    assert h.client.post(f"/v1/events/{eid}/publish", headers=PROF_HEADERS).status_code == 409
    ev = h.client.post(f"/v1/events/{eid}/confirm", headers=PROF_HEADERS).json()
    assert ev["confirmationStatus"] == "confirmed"
    assert h.calendar.published == {}
    ev = h.client.post(f"/v1/events/{eid}/publish", headers=PROF_HEADERS).json()
    assert ev["confirmationStatus"] == "published"
    # re-publishing is idempotent (same calendar event)
    again = h.client.post(f"/v1/events/{eid}/publish", headers=PROF_HEADERS).json()
    assert again["calendarEventId"] == ev["calendarEventId"]
    assert len(h.calendar.published) == 1


def test_authorization(harness: Harness) -> None:
    eid = _exam(harness)
    url = f"/v1/events/{eid}/confirm"
    assert harness.client.post(url).status_code == 401
    other = {"X-Actor-Id": "someone-else", "X-Actor-Role": "professor"}
    assert harness.client.post(url, headers=other).json()["error"]["code"] == "forbidden"
    student = {"X-Actor-Id": PROFESSOR, "X-Actor-Role": "student"}
    assert harness.client.post(url, headers=student).status_code == 403
    mismatch = harness.client.post(url, headers=PROF_HEADERS, json={"actorId": "x"})
    assert mismatch.status_code == 403
    assert harness.client.post(url, headers=ADMIN).status_code == 200


def test_ambiguous_event_requires_date_before_confirm(harness: Harness) -> None:
    eid = str(harness.extract("A prova final vai ser depois do feriado.")["events"][0]["id"])
    r = harness.client.post(f"/v1/events/{eid}/confirm", headers=PROF_HEADERS)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "event_date_required"
    r = harness.client.post(
        f"/v1/events/{eid}/edit",
        headers=PROF_HEADERS,
        json={
            "changes": {"eventDate": "2026-04-28", "eventTime": "19:00"},
            "reason": "data fixada",
        },
    )
    assert r.status_code == 200, r.text
    ev = r.json()
    assert ev["eventDate"] == "2026-04-28"
    assert ev["confirmationStatus"] == "published"
    date_change = ev["changeHistory"][0]
    assert date_change["changeType"] == "date_change"
    assert date_change["previousValue"] is None
    assert date_change["reason"] == "data fixada"


def test_edit_validation(harness: Harness) -> None:
    eid = _exam(harness)
    url = f"/v1/events/{eid}/edit"
    bad = harness.client.post(url, headers=PROF_HEADERS, json={"changes": {"eventDate": "24/03"}})
    assert bad.status_code == 400
    same = harness.client.post(
        url, headers=PROF_HEADERS, json={"changes": {"eventDate": "2026-03-24"}}
    )
    assert same.json()["error"]["code"] == "no_changes"


def test_edit_after_publication_republishes(harness: Harness) -> None:
    eid = _exam(harness)
    harness.client.post(f"/v1/events/{eid}/confirm", headers=PROF_HEADERS)
    r = harness.client.post(
        f"/v1/events/{eid}/edit",
        headers=PROF_HEADERS,
        json={"changes": {"title": "P1 — capítulos 1 a 3"}},
    )
    ev = r.json()
    assert ev["confirmationStatus"] == "published"
    assert harness.calendar.published[ev["calendarEventId"]]["title"] == "P1 — capítulos 1 a 3"
    assert harness.publisher.events[-1]["type"] == "event.updated"


def test_reject(harness: Harness) -> None:
    eid = _exam(harness)
    url = f"/v1/events/{eid}/reject"
    assert harness.client.post(url, headers=PROF_HEADERS, json={"reason": ""}).status_code == 400
    ev = harness.client.post(url, headers=PROF_HEADERS, json={"reason": "era exemplo"}).json()
    assert ev["confirmationStatus"] == "rejected"
    assert ev["changeHistory"][-1]["reason"] == "era exemplo"
    assert harness.client.post(f"/v1/events/{eid}/confirm", headers=PROF_HEADERS).status_code == 409
    assert (
        harness.client.post(
            f"/v1/events/{eid}/edit", headers=PROF_HEADERS, json={"changes": {"title": "x"}}
        ).status_code
        == 409
    )


def test_published_event_cannot_be_rejected(harness: Harness) -> None:
    eid = _exam(harness)
    harness.client.post(f"/v1/events/{eid}/confirm", headers=PROF_HEADERS)
    r = harness.client.post(f"/v1/events/{eid}/reject", headers=PROF_HEADERS, json={"reason": "x"})
    assert r.status_code == 409


def test_confirming_date_change_proposal_updates_original(harness: Harness) -> None:
    original = harness.extract("O trabalho em grupo deve ser entregue no dia 24 de março.")
    oid = original["events"][0]["id"]
    harness.client.post(f"/v1/events/{oid}/confirm", headers=PROF_HEADERS)
    proposal = harness.extract(
        "O trabalho em grupo foi adiado para o dia 31 de março.", scheduled_class_id=CLASS_2
    )["events"][0]
    r = harness.client.post(f"/v1/events/{proposal['id']}/confirm", headers=PROF_HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["confirmationStatus"] == "confirmed"
    updated = harness.client.get(f"/v1/events/{oid}").json()
    assert updated["eventDate"] == "2026-03-31"
    change = next(c for c in updated["changeHistory"] if c["field"] == "eventDate")
    assert (change["previousValue"], change["newValue"]) == ("2026-03-24", "2026-03-31")
    assert harness.calendar.published[updated["calendarEventId"]]["eventDate"] == "2026-03-31"
    assert harness.publisher.events[-1]["type"] == "event.updated"


def test_review_queue(harness: Harness) -> None:
    harness.extract("A prova final vai ser depois do feriado.")
    harness.extract("A P1 vai ser dia 24/03. O quiz é amanhã.")
    queue = harness.client.get("/v1/review-queue", params={"professorId": PROFESSOR}).json()
    assert [e["eventDate"] for e in queue] == ["2026-03-11", "2026-03-24", None]
    assert harness.client.get("/v1/review-queue", params={"professorId": "x"}).json() == []
    published = harness.client.get("/v1/review-queue", params={"status": "published"}).json()
    assert published == []


def test_unknown_event_is_404(harness: Harness) -> None:
    assert harness.client.get("/v1/events/nope").status_code == 404
    r = harness.client.post("/v1/events/nope/confirm", headers=PROF_HEADERS)
    assert r.status_code == 404
