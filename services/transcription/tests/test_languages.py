"""Phase 6.4: per-language Chirp codes, vocabularies and language resolution."""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from transcription.app import AppDeps, create_app
from transcription.config import DEFAULT_VOCABULARY, deps_from_env
from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryJobRepository,
    InMemoryPublisher,
    InMemoryTranscriptStore,
    StaticClassContextResolver,
)
from transcription.languages import (
    SUPPORTED_LANGUAGES,
    UnsupportedLanguageError,
    canonical_language,
    chirp_code,
    parse_overrides,
)
from transcription.models import TranscriptionRequest
from transcription.ports import ClassContext
from transcription.service import ServiceSettings, TranscriptionService
from transcription.vocabulary import VocabularyCatalog

SCHEDULED = "33333333-3333-4333-8333-333333333333"
CATALOG = VocabularyCatalog.from_dict(
    {
        "default": ["ementa"],
        "disciplines": {"law": ["habeas corpus"]},
        "languages": {
            "en-US": {"default": ["syllabus"], "disciplines": {"law": ["case law"]}},
            "es_MX": {"default": ["programa del curso"]},
            "fr-FR": {"default": ["partiel"]},
        },
    }
)


def test_canonical_language_and_chirp_codes() -> None:
    assert canonical_language(None) == "pt-BR"
    assert canonical_language("pt") == "pt-BR"
    assert canonical_language("en_GB") == "en-US"
    assert canonical_language("es-AR") == "es-419"
    assert canonical_language("es") == "es-ES"
    assert canonical_language("FR-ca") == "fr-FR"
    with pytest.raises(UnsupportedLanguageError):
        canonical_language("de-DE")
    assert {chirp_code(lang) for lang in SUPPORTED_LANGUAGES} == set(SUPPORTED_LANGUAGES)
    assert chirp_code("es-419", parse_overrides('{"es_MX": "es-US"}')) == "es-US"


def test_catalog_is_per_language() -> None:
    assert CATALOG.phrases_for(None, "law") == ("ementa", "habeas corpus")
    assert CATALOG.phrases_for(None, "law", "en-US") == ("syllabus", "case law")
    assert CATALOG.phrases_for(None, None, "es-419") == ("programa del curso",)
    assert CATALOG.phrases_for(None, None, "es-ES") == ()
    shipped = VocabularyCatalog.load(DEFAULT_VOCABULARY)
    for lang in SUPPORTED_LANGUAGES:
        assert shipped.phrases_for(None, None, lang), f"no shipped vocabulary for {lang}"


def harness(
    resolver: StaticClassContextResolver | None = None,
) -> tuple[TranscriptionService, FakeSpeechProvider, InMemoryTranscriptStore, InMemoryPublisher]:
    provider = FakeSpeechProvider()
    store = InMemoryTranscriptStore()
    publisher = InMemoryPublisher()
    service = TranscriptionService(
        provider=provider,
        store=store,
        publisher=publisher,
        audit=InMemoryAuditSink(),
        jobs=InMemoryJobRepository(),
        vocabulary=CATALOG,
        class_context=resolver,
        settings=ServiceSettings(language_codes={"es-419": "es-US"}),
    )
    return service, provider, store, publisher


def request(**kw: object) -> TranscriptionRequest:
    return TranscriptionRequest.model_validate(
        {
            "recordingSessionId": str(uuid.uuid4()),
            "segments": [{"index": 0, "startMs": 0, "endMs": 20_000, "storageUri": "gs://b/0"}],
            **kw,
        }
    )


async def test_default_is_pt_br() -> None:
    service, provider, store, _ = harness()
    job, _ = await service.submit(request())
    done = await service.run(job.job_id)
    assert done.request.language == "pt-BR"
    assert provider.calls[0][1].language == "pt-BR"
    assert provider.calls[0][1].phrases == ("ementa",)
    stored = store.transcripts[done.transcript_id or ""]
    assert stored["language"] == "pt-BR"
    assert {s["language"] for s in stored["segments"]} == {"pt-BR"}


async def test_explicit_language_selects_code_and_vocabulary() -> None:
    service, provider, store, publisher = harness()
    job, _ = await service.submit(request(language="en", discipline="law"))
    done = await service.run(job.job_id)
    assert done.request.language == "en-US"
    assert provider.calls[0][1].language == "en-US"
    assert provider.calls[0][1].phrases == ("syllabus", "case law")
    assert store.transcripts[done.transcript_id or ""]["language"] == "en-US"
    assert publisher.events[0]["data"]["language"] == "en-US"


async def test_language_from_class_context_and_code_override() -> None:
    resolver = StaticClassContextResolver(
        by_scheduled_class={SCHEDULED: ClassContext(scheduled_class_id=SCHEDULED, language="es-MX")}
    )
    service, provider, store, _ = harness(resolver)
    job, _ = await service.submit(request(scheduledClassId=SCHEDULED))
    done = await service.run(job.job_id)
    assert done.request.language == "es-419"
    assert provider.calls[0][1].language == "es-US"  # deployment override
    assert provider.calls[0][1].phrases == ("programa del curso",)
    assert store.transcripts[done.transcript_id or ""]["language"] == "es-419"


async def test_payload_language_beats_context_and_unsupported_context_falls_back() -> None:
    resolver = StaticClassContextResolver(
        by_scheduled_class={SCHEDULED: ClassContext(scheduled_class_id=SCHEDULED, language="de")}
    )
    service, provider, _, _ = harness(resolver)
    job, _ = await service.submit(request(scheduledClassId=SCHEDULED))
    assert (await service.run(job.job_id)).request.language == "pt-BR"
    job2, _ = await service.submit(request(scheduledClassId=SCHEDULED, language="fr-FR"))
    assert (await service.run(job2.job_id)).request.language == "fr-FR"
    assert provider.calls[-1][1].phrases == ("partiel",)


def test_event_language_and_validation() -> None:
    service, provider, store, _ = harness()
    client = TestClient(create_app(AppDeps(service=service)))
    event = {
        "eventId": str(uuid.uuid4()),
        "type": "recording.segmented",
        "occurredAt": "2026-11-04T19:00:00Z",
        "source": "audio-processing",
        "data": {
            "recordingSessionId": str(uuid.uuid4()),
            "language": "fr_FR",
            "segments": [{"index": 0, "startMs": 0, "endMs": 20_000, "storageUri": "gs://b/0"}],
        },
    }
    resp = client.post("/v1/events/recording-segmented", json=event)
    assert resp.status_code == 200
    assert store.transcripts[resp.json()["transcriptId"]]["language"] == "fr-FR"
    bad = client.post(
        "/v1/transcriptions",
        json={
            "recordingSessionId": str(uuid.uuid4()),
            "language": "klingon",
            "segments": [{"index": 0, "startMs": 0, "endMs": 5, "storageUri": "gs://b"}],
        },
    )
    assert bad.status_code == 422


def test_google_config_receives_language_code() -> None:
    from transcription.google_provider import build_recognition_config
    from transcription.ports import RecognitionConfig

    cfg = build_recognition_config("chirp_2", RecognitionConfig(language="es-419"))
    assert cfg["language_codes"] == ["es-419"]


def test_env_wiring_language_code_overrides() -> None:
    deps = deps_from_env({"SPEECH_LANGUAGE_CODES": json.dumps({"fr-FR": "fr-CA"})})
    assert deps.service._settings.language_codes == {"fr-FR": "fr-CA"}  # noqa: SLF001
