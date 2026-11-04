"""Transcription orchestration: provider calls → assembled transcript → store/events/audit."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import structlog

from transcription import PROCESSING_VERSION
from transcription.assembly import GroupingConfig, assemble_transcript
from transcription.languages import (
    DEFAULT_LANGUAGE,
    UnsupportedLanguageError,
    canonical_language,
    chirp_code,
)
from transcription.models import (
    AudioSegmentRef,
    JobStatus,
    TranscriptionJob,
    TranscriptionRequest,
    Word,
)
from transcription.ports import (
    AuditSink,
    ClassContext,
    ClassContextResolver,
    EventPublisher,
    JobRepository,
    ProviderError,
    RecognitionConfig,
    SpeechProvider,
    TranscriptStoreClient,
    TransientProviderError,
    VocabularySource,
)
from transcription.vocabulary import StaticVocabularySource, VocabularyCatalog

log = structlog.get_logger(__name__)

Sleep = Callable[[float], Awaitable[None]]


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 4
    base_delay_s: float = 2.0
    max_delay_s: float = 30.0

    def delay(self, attempt: int) -> float:
        return float(min(self.max_delay_s, self.base_delay_s * (2 ** (attempt - 1))))


@dataclass(frozen=True)
class ServiceSettings:
    max_concurrency: int = 4
    retry: RetryPolicy = RetryPolicy()
    grouping: GroupingConfig = GroupingConfig()
    #: Per-deployment Chirp language-code overrides (``SPEECH_LANGUAGE_CODES``).
    language_codes: dict[str, str] = field(default_factory=dict)


def _now() -> datetime:
    return datetime.now(UTC)


def _context_language(ctx: ClassContext) -> str | None:
    """Class-context language if it is one we support; otherwise keep the default."""
    if not ctx.language:
        return None
    try:
        return canonical_language(ctx.language)
    except UnsupportedLanguageError:
        log.warning("transcription.unsupported_context_language", language=ctx.language)
        return None


class TranscriptionService:
    def __init__(
        self,
        *,
        provider: SpeechProvider,
        store: TranscriptStoreClient,
        publisher: EventPublisher,
        audit: AuditSink,
        jobs: JobRepository,
        vocabulary: VocabularySource | VocabularyCatalog | None = None,
        class_context: ClassContextResolver | None = None,
        settings: ServiceSettings | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self._provider = provider
        self._store = store
        self._publisher = publisher
        self._audit = audit
        self._jobs = jobs
        self._vocabulary: VocabularySource = (
            StaticVocabularySource(vocabulary)
            if vocabulary is None or isinstance(vocabulary, VocabularyCatalog)
            else vocabulary
        )
        self._class_context = class_context
        self._settings = settings or ServiceSettings()
        self._sleep = sleep

    async def submit(self, request: TranscriptionRequest) -> tuple[TranscriptionJob, bool]:
        """Create a job (or return the existing one for the same recording).

        Returns ``(job, created)``; idempotent so Pub/Sub redelivery does not
        transcribe a recording twice.
        """
        now = _now()
        job = TranscriptionJob(
            job_id=str(uuid.uuid4()),
            status=JobStatus.QUEUED,
            request=request,
            created_at=now,
            updated_at=now,
            provider=self._provider.name,
            model=self._provider.model,
        )
        return await self._jobs.create_if_absent(job)

    async def get(self, job_id: str) -> TranscriptionJob | None:
        return await self._jobs.get(job_id)

    async def _transcribe_segment(
        self, segment: AudioSegmentRef, config: RecognitionConfig, sem: asyncio.Semaphore
    ) -> list[Word]:
        retry = self._settings.retry
        async with sem:
            attempt = 1
            while True:
                try:
                    result = await self._provider.transcribe(segment, config)
                    return result.words
                except TransientProviderError as exc:
                    if attempt >= retry.max_attempts:
                        raise ProviderError(
                            f"segment {segment.index}: gave up after {attempt} attempts: {exc}"
                        ) from exc
                    delay = retry.delay(attempt)
                    log.warning(
                        "transcription.segment_retry",
                        segment=segment.index,
                        attempt=attempt,
                        delay_s=delay,
                        error=str(exc),
                    )
                    await self._sleep(delay)
                    attempt += 1

    async def _resolve_context(self, req: TranscriptionRequest) -> TranscriptionRequest:
        """Fill classSectionId / institutionId / discipline / language from
        academic-integration, then default the language to ``pt-BR`` (Phase 6.4).

        Best effort: a lookup failure never blocks transcription (the transcript is then
        stored without section association and can be re-associated later)."""
        resolved = await self._lookup_context(req)
        if resolved.language is None:
            resolved = resolved.model_copy(update={"language": DEFAULT_LANGUAGE})
        return resolved

    async def _lookup_context(self, req: TranscriptionRequest) -> TranscriptionRequest:
        needs = (
            req.class_section_id is None
            or req.institution_id is None
            or not req.discipline
            or req.language is None
        )
        if self._class_context is None or not needs:
            return req
        try:
            ctx: ClassContext | None = await self._class_context.resolve(
                scheduled_class_id=req.scheduled_class_id,
                classroom_id=req.classroom_id,
                started_at=req.started_at,
                ended_at=req.ended_at,
                recording_session_id=req.recording_session_id,
            )
        except Exception as exc:  # noqa: BLE001 — degrade gracefully
            log.warning("transcription.class_context_failed", error=str(exc))
            return req
        if ctx is None:
            return req
        return req.model_copy(
            update={
                "scheduled_class_id": req.scheduled_class_id or ctx.scheduled_class_id,
                "class_section_id": req.class_section_id or ctx.class_section_id,
                "institution_id": req.institution_id or ctx.institution_id,
                "discipline": req.discipline or ctx.discipline,
                "language": req.language or _context_language(ctx),
            }
        )

    async def run(self, job_id: str) -> TranscriptionJob:
        claimed = await self._jobs.claim(job_id)
        if claimed is None:
            existing = await self._jobs.get(job_id)
            if existing is None:
                raise KeyError(job_id)
            return existing  # already running elsewhere or finished
        job = claimed
        job.request = await self._resolve_context(job.request)
        req = job.request
        resource = req.recording_session_id
        job.updated_at = _now()
        await self._jobs.save(job)
        await self._audit.record(
            action="transcription.started",
            resource_type="recording_session",
            resource_id=resource,
            institution_id=req.institution_id,
            metadata={
                "jobId": job.job_id,
                "segments": len(req.segments),
                "provider": job.provider,
                "model": job.model,
            },
        )

        sem = asyncio.Semaphore(max(1, self._settings.max_concurrency))
        ordered = sorted(req.segments, key=lambda s: s.start_ms)
        try:
            language = req.language or DEFAULT_LANGUAGE
            phrases, boosts = await self._vocabulary.phrases_for(
                req.institution_id, req.discipline, language
            )
            config = RecognitionConfig(
                language=chirp_code(language, self._settings.language_codes),
                phrases=phrases,
                boosts=boosts,
            )
            results = await asyncio.gather(
                *(self._transcribe_segment(seg, config, sem) for seg in ordered)
            )
            segments = assemble_transcript(
                list(zip(ordered, results, strict=True)), language, self._settings.grouping
            )
            if not segments:
                raise ProviderError("provider returned no speech for any segment")
            stored = await self._store.create_transcript(
                recording_session_id=req.recording_session_id,
                scheduled_class_id=req.scheduled_class_id,
                language=language,
                processing_version=PROCESSING_VERSION,
                provider=job.provider,
                model=job.model,
                segments=segments,
                class_section_id=req.class_section_id,
                institution_id=req.institution_id,
            )
        except Exception as exc:  # noqa: BLE001 — every failure must be reported
            return await self._fail(job, str(exc) or exc.__class__.__name__)

        word_count = sum(len(s.words) for s in segments)
        job.status = JobStatus.COMPLETED
        job.transcript_id = stored.transcript_id
        job.segment_count = len(segments)
        job.word_count = word_count
        job.mean_confidence = round(
            sum(w.confidence for s in segments for w in s.words) / max(word_count, 1), 3
        )
        job.updated_at = _now()
        await self._jobs.save(job)
        data = {
            "recordingSessionId": req.recording_session_id,
            "transcriptId": stored.transcript_id,
            "scheduledClassId": req.scheduled_class_id,
            "classSectionId": req.class_section_id,
            "segmentCount": len(segments),
            "language": req.language,
            "audioSegments": [s.dump() for s in ordered],
        }
        await self._publisher.publish(
            "transcription.completed",
            {k: v for k, v in data.items() if v is not None},
            req.institution_id,
        )
        await self._audit.record(
            action="transcription.completed",
            resource_type="recording_session",
            resource_id=resource,
            institution_id=req.institution_id,
            metadata={
                "jobId": job.job_id,
                "transcriptId": stored.transcript_id,
                "segmentCount": len(segments),
                "wordCount": word_count,
                "meanConfidence": job.mean_confidence,
            },
        )
        log.info("transcription.completed", job_id=job.job_id, segments=len(segments))
        return job

    async def _fail(self, job: TranscriptionJob, reason: str) -> TranscriptionJob:
        req = job.request
        job.status = JobStatus.FAILED
        job.failure_reason = reason
        job.updated_at = _now()
        await self._jobs.save(job)
        await self._publisher.publish(
            "transcription.failed",
            {"recordingSessionId": req.recording_session_id, "reason": reason},
            req.institution_id,
        )
        await self._audit.record(
            action="transcription.failed",
            resource_type="recording_session",
            resource_id=req.recording_session_id,
            institution_id=req.institution_id,
            metadata={"jobId": job.job_id, "reason": reason},
        )
        log.error("transcription.failed", job_id=job.job_id, reason=reason)
        return job
