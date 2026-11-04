"""Integration-stage behaviour with in-memory adapters: security, governance, engagement, bus."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any

import httpx
from conftest import CLASS, INSTITUTION, LECTURE_TEXTS, TRANSCRIPT, Harness, structure_body
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from lecture_intelligence.actor import ActorResolver, JwksVerifier
from lecture_intelligence.clients import HttpEventBusPublisher
from lecture_intelligence.models import SearchResult, Segment

SECTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
STUDENT = "55555555-5555-4555-8555-555555555555"
OTHER = "66666666-6666-4666-8666-666666666666"
KEY = Ed25519PrivateKey.generate()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(claims: dict[str, Any], key: Ed25519PrivateKey = KEY, kid: str = "k1") -> str:
    header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT", "kid": kid}).encode())
    payload = _b64(json.dumps(claims).encode())
    signature = _b64(key.sign(f"{header}.{payload}".encode()))
    return f"{header}.{payload}.{signature}"


def student_claims(**overrides: Any) -> dict[str, Any]:
    claims: dict[str, Any] = {
        "iss": "ci-identity",
        "aud": "ci",
        "sub": "user-1",
        "pid": STUDENT,
        "role": "student",
        "inst": INSTITUTION,
        "exp": int(time.time()) + 600,
    }
    claims.update(overrides)
    return claims


def verified_harness(**kwargs: Any) -> Harness:
    verifier = JwksVerifier(keys={"k1": KEY.public_key()})
    return Harness(actors=ActorResolver(verifier), **kwargs)


def _structure(h: Harness) -> dict[str, Any]:
    h.gateway.responders["lecture-structuring"] = lambda _: {
        "title": "Aula",
        "executiveSummary": "R.",
    }
    body = structure_body(classSectionId=SECTION)
    response = h.client.post("/v1/lectures/structure", json=body)
    assert response.status_code == 201
    result: dict[str, Any] = response.json()
    return result


# ------------------------------------------------------------------ internal token
def test_internal_token_protects_internal_and_event_routes() -> None:
    h = Harness(internal_token="s3cret")
    params = {"institutionId": INSTITUTION, "olderThan": "2030-01-01T00:00:00Z", "kind": "summary"}
    assert h.client.get("/internal/v1/retention/candidates", params=params).status_code == 401
    ok = h.client.get(
        "/internal/v1/retention/candidates", params=params, headers={"x-internal-token": "s3cret"}
    )
    assert ok.status_code == 200
    assert h.client.post("/v1/events/transcript-created", json={}).status_code == 401
    # Student-facing routes are authorised by the BFF/identity, not by the internal token.
    assert h.client.get("/v1/lectures", params={"classSectionIds": SECTION}).status_code == 200
    assert h.client.get("/health").status_code == 200


# ------------------------------------------------------------------ retention
def test_retention_candidates_and_delete() -> None:
    h = Harness()
    summary = _structure(h)
    params = {"institutionId": INSTITUTION, "olderThan": "2999-01-01T00:00:00+00:00"}
    found = h.client.get("/internal/v1/retention/candidates", params=params).json()
    assert found == {
        "kind": "summary",
        "institutionId": INSTITUTION,
        "ids": [summary["lectureSummaryId"]],
    }
    early = h.client.get(
        "/internal/v1/retention/candidates",
        params={"institutionId": INSTITUTION, "olderThan": "2000-01-01T00:00:00Z"},
    ).json()
    assert early["ids"] == []
    bad_kind = h.client.get("/internal/v1/retention/candidates", params={**params, "kind": "audio"})
    assert bad_kind.status_code == 400 and bad_kind.json()["error"]["code"] == "unsupported_kind"
    naive = h.client.get(
        "/internal/v1/retention/candidates",
        params={"institutionId": INSTITUTION, "olderThan": "2030-01-01T00:00:00"},
    )
    assert naive.status_code == 400

    deleted = h.client.post(
        "/internal/v1/retention/delete",
        json={"ids": [summary["lectureSummaryId"], "missing"], "kind": "summary", "jobId": "j1"},
    ).json()
    assert deleted == {
        "kind": "summary",
        "jobId": "j1",
        "deletedIds": [summary["lectureSummaryId"]],
    }
    assert h.client.get(f"/v1/lectures/{CLASS}").status_code == 404


# ------------------------------------------------------------------ DSR
def _ask_once(h: Harness) -> str:
    h.search.results = [
        SearchResult(
            transcript_id=TRANSCRIPT,
            scheduled_class_id=CLASS,
            class_section_id=SECTION,
            segment_index=1,
            start_ms=10_000,
            end_ms=19_000,
            text=LECTURE_TEXTS[1],
            score=1.0,
        )
    ]
    h.gateway.responders["assistant-answer"] = lambda _: {
        "answer": [
            {"kind": "ai_explanation", "text": "Inflação é alta de preços.", "citationIds": ["s1"]}
        ]
    }
    body = {
        "question": "O que é inflação?",
        "studentId": STUDENT,
        "institutionId": INSTITUTION,
        "classSectionIds": [SECTION],
    }
    answer_id: str = h.client.post("/v1/assistant/ask", json=body).json()["answerId"]
    h.client.post(
        "/v1/assistant/feedback", json={"answerId": answer_id, "helpful": True, "comment": "boa"}
    )
    return answer_id


def test_dsr_access_anonymization_deletion() -> None:
    h = Harness()
    _ask_once(h)
    subject = {"subjectType": "student", "subjectId": STUDENT, "requestId": "dsr-1"}
    access = h.client.post("/internal/v1/dsr/access", json=subject).json()
    assert access["service"] == "lecture-intelligence" and access["status"] == "completed"
    assert access["items"] == 3
    assert access["export"]["answers"][0]["question"] == "O que é inflação?"
    assert access["export"]["feedback"][0]["comment"] == "boa"

    anon = h.client.post("/internal/v1/dsr/anonymization", json=subject).json()
    assert anon["items"] == 1
    again = h.client.post("/internal/v1/dsr/access", json=subject).json()
    assert again["export"]["answers"][0]["question"] == "[removido a pedido do titular]"
    assert again["export"]["feedback"][0]["comment"] is None

    deletion = h.client.post("/internal/v1/dsr/deletion", json=subject).json()
    assert deletion["status"] == "completed" and deletion["items"] == 2
    empty = h.client.post("/internal/v1/dsr/access", json=subject).json()
    assert empty["items"] == 0

    na = h.client.post("/internal/v1/dsr/correction", json=subject).json()
    assert na["status"] == "not_applicable"
    prof = h.client.post(
        "/internal/v1/dsr/access", json={"subjectType": "professor", "subjectId": OTHER}
    ).json()
    assert prof["status"] == "not_applicable"
    assert h.client.post("/internal/v1/dsr/erase", json=subject).status_code == 400


# ------------------------------------------------------------------ engagement audit
def _views(h: Harness) -> list[dict[str, Any]]:
    return [e for e in h.audit.events if e["action"] == "lecture.viewed"]


def test_lecture_viewed_from_verified_token() -> None:
    h = verified_harness()
    summary = _structure(h)
    auth = {"Authorization": f"Bearer {token(student_claims())}"}
    assert h.client.get(f"/v1/lectures/{CLASS}", headers=auth).status_code == 200
    view = _views(h)[0]
    assert view["actorId"] == STUDENT and view["actorType"] == "student"
    assert view["resourceId"] == summary["lectureSummaryId"]
    assert view["metadata"]["classSectionId"] == SECTION
    assert view["tenantId"] == INSTITUTION

    forged = token(student_claims(), key=Ed25519PrivateKey.generate())
    h.client.get(f"/v1/lectures/{CLASS}", headers={"Authorization": f"Bearer {forged}"})
    expired = token(student_claims(exp=int(time.time()) - 3600))
    h.client.get(f"/v1/lectures/{CLASS}", headers={"Authorization": f"Bearer {expired}"})
    professor = token(student_claims(role="professor"))
    h.client.get(f"/v1/lectures/{CLASS}", headers={"Authorization": f"Bearer {professor}"})
    h.client.get(f"/v1/lectures/{CLASS}")
    assert len(_views(h)) == 1


def test_lecture_viewed_from_actor_header() -> None:
    h = Harness()
    _structure(h)
    h.client.get(f"/v1/lectures/{CLASS}", headers={"X-Actor-Id": OTHER})
    h.client.get(f"/v1/lectures/{CLASS}", headers={"X-Actor-Id": OTHER, "X-Actor-Role": "admin"})
    views = _views(h)
    assert len(views) == 1 and views[0]["actorId"] == OTHER


def test_assistant_question_audit_and_identity_check() -> None:
    h = verified_harness()
    answer_id = _ask_once(h)
    event = next(e for e in h.audit.events if e["action"] == "lecture.assistant_question")
    assert event["actorId"] == STUDENT and event["resourceId"] == answer_id
    assert event["metadata"]["classSectionId"] == SECTION
    assert "O que é inflação" not in json.dumps(event)

    body = {
        "question": "O que é inflação?",
        "studentId": OTHER,
        "institutionId": INSTITUTION,
        "classSectionIds": [SECTION],
    }
    auth = {"Authorization": f"Bearer {token(student_claims())}"}
    assert h.client.post("/v1/assistant/ask", json=body, headers=auth).status_code == 403


# ------------------------------------------------------------------ events
def test_pubsub_message_id_idempotency() -> None:
    h = Harness()
    h.transcripts.transcripts[TRANSCRIPT] = {"id": TRANSCRIPT, "scheduledClassId": CLASS}
    h.transcripts.segments[TRANSCRIPT] = [
        Segment.model_validate(s) for s in structure_body()["segments"]
    ]
    h.gateway.responders["lecture-structuring"] = lambda _: {"title": "A", "executiveSummary": "B."}
    envelope = {
        "type": "transcript.created",
        "institutionId": INSTITUTION,
        "data": {"transcriptId": TRANSCRIPT},
    }
    push = {
        "message": {
            "data": base64.b64encode(json.dumps(envelope).encode()).decode(),
            "messageId": "m-1",
        },
        "subscription": "projects/p/subscriptions/lecture-intelligence",
    }
    assert h.client.post("/v1/events/transcript-created", json=push).json()["status"] == "processed"
    assert h.client.post("/v1/events/transcript-created", json=push).json() == {
        "status": "duplicate"
    }


def test_event_bus_publisher_posts_envelope_with_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(202)

    publisher = HttpEventBusPublisher(
        "http://bus:8090", "s3cret", transport=httpx.MockTransport(handler)
    )
    asyncio.run(publisher.publish("lecture.structured", {"lectureSummaryId": "x"}, INSTITUTION))
    request = seen[0]
    assert request.url.path == "/v1/topics/lecture.structured:publish"
    assert request.headers["x-internal-token"] == "s3cret"
    body = json.loads(request.content)
    assert body["type"] == "lecture.structured" and body["source"] == "lecture-intelligence"
    assert body["institutionId"] == INSTITUTION and body["data"] == {"lectureSummaryId": "x"}
