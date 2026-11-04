import pytest

from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryJobRepository,
    InMemoryPublisher,
    InMemoryTranscriptStore,
)
from transcription.models import AudioSegmentRef, JobStatus, TranscriptionRequest
from transcription.service import RetryPolicy, ServiceSettings, TranscriptionService
from transcription.vocabulary import VocabularyCatalog

FIVE_MIN = 5 * 60 * 1000
INSTITUTION = "11111111-1111-4111-8111-111111111111"


class Harness:
    def __init__(self, provider: FakeSpeechProvider, max_concurrency: int = 4) -> None:
        self.provider = provider
        self.store = InMemoryTranscriptStore()
        self.publisher = InMemoryPublisher()
        self.audit = InMemoryAuditSink()
        self.sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            self.sleeps.append(seconds)

        self.service = TranscriptionService(
            provider=provider,
            store=self.store,
            publisher=self.publisher,
            audit=self.audit,
            jobs=InMemoryJobRepository(),
            vocabulary=VocabularyCatalog.from_dict(
                {"default": ["ementa"], "disciplines": {"medicine": ["anamnese"]}}
            ),
            settings=ServiceSettings(
                max_concurrency=max_concurrency,
                retry=RetryPolicy(max_attempts=3, base_delay_s=1.0),
            ),
            sleep=fake_sleep,
        )


def lecture_request(n_segments: int = 18) -> TranscriptionRequest:
    return TranscriptionRequest(
        recording_session_id="rec-90min",
        scheduled_class_id="class-1",
        institution_id=INSTITUTION,
        discipline="medicine",
        segments=[
            AudioSegmentRef(
                index=i,
                start_ms=i * FIVE_MIN,
                end_ms=(i + 1) * FIVE_MIN,
                storage_uri=f"gs://ci-audio/rec-90min/{i:03d}.wav",
            )
            for i in range(n_segments)
        ],
    )


async def test_ninety_minute_lecture_end_to_end() -> None:
    h = Harness(FakeSpeechProvider(), max_concurrency=4)
    job, created = await h.service.submit(lecture_request())
    assert created
    done = await h.service.run(job.job_id)

    assert done.status is JobStatus.COMPLETED, done.failure_reason
    assert h.provider.max_in_flight <= 4
    assert len(h.provider.calls) == 18
    assert h.provider.calls[0][1].phrases == ("ementa", "anamnese")

    stored = h.store.transcripts[done.transcript_id or ""]
    segments = stored["segments"]
    # 75 sentences per 5-min segment × 18 segments.
    assert len(segments) == 18 * 75 == done.segment_count
    assert segments[-1]["endMs"] <= 90 * 60 * 1000
    assert segments[-1]["startMs"] > 89 * 60 * 1000
    starts = [s["startMs"] for s in segments]
    assert starts == sorted(starts)
    assert all(a["endMs"] <= b["startMs"] for a, b in zip(segments, segments[1:], strict=False))
    assert [s["segmentIndex"] for s in segments] == list(range(len(segments)))
    assert stored["language"] == "pt-BR"
    assert stored["provider"] == "fake"

    [event] = h.publisher.events
    assert event["type"] == "transcription.completed"
    assert event["data"]["transcriptId"] == done.transcript_id
    assert event["data"]["recordingSessionId"] == "rec-90min"
    assert len(event["data"]["audioSegments"]) == 18
    assert event["institutionId"] == INSTITUTION
    assert [a["action"] for a in h.audit.records] == [
        "transcription.started",
        "transcription.completed",
    ]


async def test_transient_errors_are_retried_with_backoff() -> None:
    h = Harness(FakeSpeechProvider(fail_times={2: 2}))
    job, _ = await h.service.submit(lecture_request(4))
    done = await h.service.run(job.job_id)
    assert done.status is JobStatus.COMPLETED
    assert h.sleeps == [1.0, 2.0]


async def test_exhausted_retries_fail_job_and_emit_event() -> None:
    h = Harness(FakeSpeechProvider(fail_times={1: 10}))
    job, _ = await h.service.submit(lecture_request(3))
    done = await h.service.run(job.job_id)
    assert done.status is JobStatus.FAILED
    assert "gave up after 3 attempts" in (done.failure_reason or "")
    assert h.store.transcripts == {}
    assert h.publisher.events[-1]["type"] == "transcription.failed"
    assert h.audit.records[-1]["action"] == "transcription.failed"


async def test_permanent_error_fails_without_retry() -> None:
    h = Harness(FakeSpeechProvider(permanent_failures={0}))
    job, _ = await h.service.submit(lecture_request(2))
    done = await h.service.run(job.job_id)
    assert done.status is JobStatus.FAILED
    assert h.sleeps == []


async def test_no_speech_fails() -> None:
    h = Harness(FakeSpeechProvider(script=lambda _s: []))
    job, _ = await h.service.submit(lecture_request(2))
    done = await h.service.run(job.job_id)
    assert done.status is JobStatus.FAILED
    assert "no speech" in (done.failure_reason or "")


async def test_submit_is_idempotent_per_recording() -> None:
    h = Harness(FakeSpeechProvider())
    first, created1 = await h.service.submit(lecture_request(1))
    second, created2 = await h.service.submit(lecture_request(1))
    assert created1 and not created2
    assert first.job_id == second.job_id


async def test_run_unknown_job_raises() -> None:
    h = Harness(FakeSpeechProvider())
    with pytest.raises(KeyError):
        await h.service.run("missing")
