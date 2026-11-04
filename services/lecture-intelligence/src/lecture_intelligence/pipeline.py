"""Lecture structuring pipeline: chunk → map (per chunk) → reduce (merge) → ground → store."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog
from pydantic import ValidationError

from lecture_intelligence import PROCESSING_VERSION
from lecture_intelligence.chunking import chunk_segments, render_transcript
from lecture_intelligence.clients import (
    AuditClient,
    EventPublisher,
    GatewayCallError,
    GatewayClient,
)
from lecture_intelligence.models import (
    LectureStructure,
    LlmMerge,
    LlmStructure,
    Provenance,
    Segment,
    StructureRequest,
    Topic,
    response_schema,
)
from lecture_intelligence.repository import LectureRepository
from lecture_intelligence.validation import (
    Grounder,
    dedupe_concepts,
    dedupe_questions,
    dedupe_readings,
    finalize_topics,
)

log = structlog.get_logger(__name__)

STRUCTURE_PROMPT = "lecture-structuring"
MERGE_PROMPT = "lecture-structuring-merge"


class PipelineError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class PipelineSettings:
    max_chunk_tokens: int = 12_000
    map_concurrency: int = 4


@dataclass
class _GatewayResult:
    output: dict[str, Any]
    request_id: str
    prompt_version: str
    model: str
    injection_suspected: bool


class LectureStructurer:
    def __init__(
        self,
        *,
        gateway: GatewayClient,
        repository: LectureRepository,
        publisher: EventPublisher,
        audit: AuditClient,
        settings: PipelineSettings | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.gateway = gateway
        self.repository = repository
        self.publisher = publisher
        self.audit = audit
        self.settings = settings or PipelineSettings()
        self.clock = clock

    async def structure(self, req: StructureRequest) -> LectureStructure:
        if req.institution_id is None:
            raise PipelineError(
                "institution_required", "institutionId is required for AI cost accounting", 422
            )
        segments = sorted(req.segments, key=lambda s: (s.start_ms, s.segment_index))
        grounder = Grounder(segments)
        chunks = chunk_segments(segments, self.settings.max_chunk_tokens)
        semaphore = asyncio.Semaphore(self.settings.map_concurrency)

        async def run_map(index: int, chunk: list[Segment]) -> _GatewayResult:
            async with semaphore:
                return await self._call(
                    req,
                    STRUCTURE_PROMPT,
                    LlmStructure,
                    variables={"chunkIndex": index + 1, "chunkCount": len(chunks)},
                    untrusted={"transcript": render_transcript(chunk)},
                )

        partial_results = await asyncio.gather(*(run_map(i, c) for i, c in enumerate(chunks)))
        partials = [
            self._parse(r, LlmStructure, f"chunks[{i}]") for i, r in enumerate(partial_results)
        ]
        results = list(partial_results)

        concepts, questions, readings = [], [], []
        for i, partial in enumerate(partials):
            prefix = f"chunks[{i}]." if len(partials) > 1 else ""
            concepts += [
                c
                for j, item in enumerate(partial.concepts)
                if (c := grounder.concept(f"{prefix}concepts[{j}]", item)) is not None
            ]
            questions += [
                q
                for j, item in enumerate(partial.questions)
                if (q := grounder.question(f"{prefix}questions[{j}]", item)) is not None
            ]
            readings += [
                r
                for j, item in enumerate(partial.readingReferences)
                if (r := grounder.reading(f"{prefix}readingReferences[{j}]", item)) is not None
            ]

        if len(partials) == 1:
            title, summary, llm_topics = (
                partials[0].title,
                partials[0].executiveSummary,
                partials[0].topics,
            )
            topic_prefix = "topics"
        else:
            merge_input = [
                {
                    "chunk": i + 1,
                    "title": p.title,
                    "executiveSummary": p.executiveSummary,
                    "topics": [t.model_dump() for t in p.topics],
                }
                for i, p in enumerate(partials)
            ]
            merge_result = await self._call(
                req,
                MERGE_PROMPT,
                LlmMerge,
                variables={"chunkCount": len(chunks)},
                untrusted={"partials": json.dumps(merge_input, ensure_ascii=False)},
            )
            results.append(merge_result)
            merged = self._parse(merge_result, LlmMerge, "merge")
            title, summary, llm_topics = merged.title, merged.executiveSummary, merged.topics
            topic_prefix = "merge.topics"

        topics: list[Topic] = [
            t
            for i, item in enumerate(llm_topics)
            if (t := grounder.topic(f"{topic_prefix}[{i}]", item)) is not None
        ]
        clean_summary = grounder.clean_prose("executiveSummary", summary) or ""
        if any(r.injection_suspected for r in results):
            grounder.flag("$", "injection_suspected", dropped=False)

        structure = LectureStructure(
            lecture_summary_id=str(uuid.uuid4()),
            transcript_id=req.transcript_id,
            scheduled_class_id=req.scheduled_class_id,
            institution_id=req.institution_id,
            class_section_id=req.class_section_id,
            course_id=req.course_id,
            course_name=req.course_name,
            class_date=req.class_date,
            starts_at=req.starts_at,
            title=title.strip(),
            executive_summary=clean_summary,
            topics=finalize_topics(topics),
            concepts=dedupe_concepts(concepts),
            questions=dedupe_questions(questions),
            reading_references=dedupe_readings(readings),
            validation=grounder.report,
            provenance=Provenance(
                prompt_id=STRUCTURE_PROMPT,
                prompt_version=results[0].prompt_version,
                model=results[0].model,
                processing_version=PROCESSING_VERSION,
                chunk_count=len(chunks),
                ai_request_ids=[r.request_id for r in results],
            ),
            created_at=self.clock().isoformat(),
        )
        await self.repository.save(structure)
        await self._emit(req, structure)
        return structure

    # ------------------------------------------------------------------ internals
    async def _call(
        self,
        req: StructureRequest,
        prompt_id: str,
        model: type[LlmStructure] | type[LlmMerge],
        *,
        variables: dict[str, Any],
        untrusted: dict[str, str],
    ) -> _GatewayResult:
        payload = {
            "task": "lecture_structuring",
            "promptId": prompt_id,
            "variables": {
                "courseName": req.course_name or "não informada",
                "classDate": req.class_date or "não informada",
                "language": req.language,
                **variables,
            },
            "untrustedInputs": untrusted,
            "responseSchema": response_schema(model),
            "institutionId": req.institution_id,
            "requestedBy": "lecture-intelligence",
        }
        try:
            body = await self.gateway.generate(payload)
        except GatewayCallError as exc:
            status = 429 if exc.status_code == 429 else 502
            raise PipelineError(f"ai_gateway_{exc.code}", str(exc), status) from exc
        return _GatewayResult(
            output=body.get("output") or {},
            request_id=str(body.get("requestId", "")),
            prompt_version=str(body.get("prompt", {}).get("version", "unknown")),
            model=str(body.get("model", {}).get("name", "unknown")),
            injection_suspected=bool(body.get("safety", {}).get("injectionSuspected", False)),
        )

    @staticmethod
    def _parse[T: (LlmStructure, LlmMerge)](result: _GatewayResult, model: type[T], path: str) -> T:
        try:
            return model.model_validate(result.output)
        except ValidationError as exc:
            log.warning("llm_output_invalid", path=path, errors=exc.errors()[:5])
            raise PipelineError(
                "invalid_model_output", f"AI output for {path} failed validation", 502
            ) from exc

    async def _emit(self, req: StructureRequest, structure: LectureStructure) -> None:
        data = {
            "scheduledClassId": structure.scheduled_class_id,
            "transcriptId": structure.transcript_id,
            "lectureSummaryId": structure.lecture_summary_id,
        }
        try:
            await self.publisher.publish("lecture.structured", data, req.institution_id)
        except Exception as exc:  # noqa: BLE001 - publish failure must not lose the result
            log.error("publish_failed", error=str(exc), **data)
        try:
            await self.audit.record(
                {
                    "tenantId": req.institution_id,
                    "actorType": "system",
                    "action": "lecture.structured",
                    "resourceType": "lecture_summary",
                    "resourceId": structure.lecture_summary_id,
                    "metadata": {
                        **data,
                        "droppedItems": structure.validation.dropped_items,
                        "flags": len(structure.validation.flags),
                        "promptVersion": structure.provenance.prompt_version,
                        "chunkCount": structure.provenance.chunk_count,
                    },
                }
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("audit_failed", error=str(exc))
