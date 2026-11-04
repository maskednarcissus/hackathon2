"""Extraction pipeline, deduplication, publication policy and professor review workflow."""

from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from . import keywords as kw
from .dates import DateResolver
from .extractors import (
    PROMPT_ID,
    Draft,
    ExtractionOutput,
    HeuristicExtractor,
    LlmExtractor,
)
from .models import (
    ChangeRecord,
    ClassContext,
    DateResolutionModel,
    Deduplication,
    EditChanges,
    EventSource,
    ExtractedEvent,
    ExtractionRequest,
    ExtractionResult,
    ExtractorKind,
    Limitation,
    Mention,
    ProposedChange,
    Provenance,
    PublicationPolicy,
    TranscriptSegment,
    ValidationStats,
)
from .ports import (
    AcademicClient,
    AuditClient,
    CalendarClient,
    Clock,
    EventPublisher,
    EventRepository,
    GatewayClient,
    InMemoryProcessedEventStore,
    PolicyProvider,
    ProcessedEventStore,
    SystemClock,
    TranscriptClient,
    UpstreamError,
)
from .text import normalize, similarity
from .validation import compute_confidence, validate_draft

log = logging.getLogger("event_extraction")

PROCESSING_VERSION = "event-extraction/2.1.0"
_OUTBOX: ContextVar[list[tuple[str, tuple[Any, ...], dict[str, Any]]] | None] = ContextVar(
    "event_extraction_outbox", default=None
)
REVIEWABLE: set[str] = {"suggested", "awaiting_professor", "awaiting_admin"}
ActorRole = Literal["professor", "admin", "coordinator", "system"]


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


@dataclass
class Actor:
    actor_id: str
    role: ActorRole


@dataclass
class Dependencies:
    repository: EventRepository
    academic: AcademicClient
    calendar: CalendarClient
    transcripts: TranscriptClient
    publisher: EventPublisher
    audit: AuditClient
    policies: PolicyProvider
    gateway: GatewayClient | None = None
    clock: Clock = field(default_factory=SystemClock)
    extractor: ExtractorKind = "heuristic"
    prompt_version: str | None = None
    processed: ProcessedEventStore = field(default_factory=InMemoryProcessedEventStore)
    internal_token: str | None = None
    lifecycle: Lifecycle | None = None


class Lifecycle(Protocol):
    """Resources opened at application start-up (e.g. the Postgres pool)."""

    async def start(self) -> None: ...
    async def stop(self) -> None: ...


def _is_specific(title: str) -> bool:
    n = normalize(title)
    return any(ch.isdigit() for ch in n) or any(
        w in n.split() for w in ("primeira", "segunda", "terceira", "quarta", "ultima", "final")
    )


SUPPORTED_LANGUAGES = frozenset({"pt-br", "pt"})


def is_supported_language(language: str) -> bool:
    return language.strip().lower().replace("_", "-") in SUPPORTED_LANGUAGES


def dominant_language(segments: list[TranscriptSegment]) -> str:
    """Language covering most transcript time (segments default to pt-BR)."""
    if not segments:
        return "pt-BR"
    weight: dict[str, int] = {}
    for s in segments:
        weight[s.language] = weight.get(s.language, 0) + max(1, s.end_ms - s.start_ms)
    return max(weight.items(), key=lambda kv: kv[1])[0]


class EventExtractionService:
    def __init__(self, deps: Dependencies) -> None:
        self.d = deps
        self.resolver = DateResolver()
        self.heuristic = HeuristicExtractor(self.resolver)

    # ------------------------------------------------------------------ extraction
    async def extract(self, req: ExtractionRequest) -> ExtractionResult:
        ctx = await self.d.academic.get_class_context(req.scheduled_class_id)
        recording_session_id = req.recording_session_id
        segments = req.segments
        language = req.language
        if segments is None:
            transcript = await self.d.transcripts.get_transcript(req.transcript_id)
            segments = transcript.segments
            recording_session_id = recording_session_id or transcript.recording_session_id
            language = language or transcript.language
        kind: ExtractorKind = req.extractor or self.d.extractor
        language = language or dominant_language(segments)
        if not is_supported_language(language):
            return await self._skip_unsupported_language(req, ctx, kind, language)
        output = await self._run_extractors(kind, segments, ctx)
        by_index = {s.segment_index: s for s in segments}

        stats = ValidationStats(candidates=output.candidates, reasons=dict(output.reasons))
        now = self.d.clock.now()
        drafted: list[ExtractedEvent] = []
        for draft in output.drafts:
            reason = validate_draft(draft, by_index)
            if reason is not None:
                stats.reasons[reason] = stats.reasons.get(reason, 0) + 1
                continue
            drafted.append(
                self._to_event(
                    draft, ctx, by_index, req.transcript_id, recording_session_id, output
                )
            )
        stats.accepted = len(drafted)
        stats.dropped = sum(stats.reasons.values())

        # in-run dedup: the same announcement repeated within one class
        unique: list[ExtractedEvent] = []
        for ev in drafted:
            twin = next((u for u in unique if self._same_event(ev, u)), None)
            if twin is None:
                unique.append(ev)
            else:
                twin.mentions.append(self._mention(ev, now))

        policy = await self.d.policies.get_policy(ctx.institution_id)
        result_events: list[ExtractedEvent] = []
        dedups: list[Deduplication] = []
        published = 0
        outbox: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        token = _OUTBOX.set(outbox)
        try:
            # Dedup against stored events must be serialised per section: the Postgres
            # repository takes a transaction-scoped advisory lock here.
            async with self.d.repository.lock_section(ctx.class_section_id):
                existing = [
                    e
                    for e in await self.d.repository.list_by_section(ctx.class_section_id)
                    if e.confirmation_status != "rejected"
                ]
                for ev in unique:
                    twin = next(
                        (e for e in existing if e.duplicate_of is None and self._same_event(ev, e)),
                        None,
                    )
                    if twin is not None:
                        for mention in [self._mention(ev, now), *ev.mentions]:
                            self._add_mention(twin, mention)
                        twin.updated_at = now
                        await self.d.repository.update(twin)
                        dedups.append(
                            Deduplication(event_id=ev.id, merged_into=twin.id, kind="repeat")
                        )
                        await self._audit(
                            "event.deduplicated", twin, None, {"mergedMention": ev.id}
                        )
                        continue
                    target = next(
                        (
                            e
                            for e in existing
                            if e.duplicate_of is None and self._is_date_change(ev, e)
                        ),
                        None,
                    )
                    if target is not None:
                        ev.duplicate_of = target.id
                        ev.flags.append(f"duplicate_of:{target.id}")
                        ev.proposed_change = ProposedChange(
                            target_event_id=target.id,
                            previous_value=target.event_date,
                            proposed_value=ev.event_date,
                        )
                        dedups.append(
                            Deduplication(
                                event_id=ev.id, merged_into=target.id, kind="date_change_proposal"
                            )
                        )

                    await self._check_conflicts(ev)
                    auto = self._decide_status(ev, policy, ctx)
                    await self.d.repository.add(ev)
                    existing.append(ev)
                    await self._audit(
                        "event.extracted",
                        ev,
                        None,
                        {
                            "transcriptId": ev.transcript_id,
                            "type": ev.type,
                            "confidence": ev.confidence.overall,
                            "status": ev.confirmation_status,
                            "flags": ev.flags,
                        },
                    )
                    if auto:
                        await self._publish(ev, Actor("system", "system"), auto=True)
                        published += 1
                    result_events.append(ev)

        finally:
            _OUTBOX.reset(token)
        for kind_, args, kwargs in outbox:
            if kind_ == "audit":
                await self._audit_now(*args, **kwargs)
            else:
                await self._emit_now(*args, **kwargs)

        awaiting = sum(1 for e in result_events if e.confirmation_status.startswith("awaiting"))
        await self._emit(
            "events.extracted",
            {
                "transcriptId": req.transcript_id,
                "scheduledClassId": req.scheduled_class_id,
                "eventIds": [e.id for e in result_events],
                "awaitingReview": awaiting,
            },
            ctx.institution_id,
        )
        return ExtractionResult(
            transcript_id=req.transcript_id,
            scheduled_class_id=req.scheduled_class_id,
            language=language,
            extractor=kind,
            events=result_events,
            deduplicated=dedups,
            validation=stats,
            awaiting_review=awaiting,
            published=published,
            injection_suspected=output.injection_suspected,
        )

    async def _skip_unsupported_language(
        self, req: ExtractionRequest, ctx: ClassContext, kind: ExtractorKind, language: str
    ) -> ExtractionResult:
        """6.4: keyword families, date resolver and prompts are pt-BR only — never guess."""
        limitation = Limitation(
            code="unsupported_language",
            language=language,
            message=(
                f"Event extraction supports pt-BR only; transcript language is {language}. "
                "No events were extracted — announcements must be entered manually."
            ),
        )
        log.info("skipping event extraction for %s: language %s", req.transcript_id, language)
        try:
            await self.d.audit.record(
                action="event.extraction_skipped",
                resource_type="transcript",
                resource_id=req.transcript_id,
                tenant_id=ctx.institution_id,
                actor_id=None,
                actor_type="system",
                metadata={
                    "scheduledClassId": ctx.scheduled_class_id,
                    "classSectionId": ctx.class_section_id,
                    "reason": limitation.code,
                    "language": language,
                },
            )
        except Exception:  # audit failures are never fatal
            log.exception("audit record failed for event.extraction_skipped")
        await self._emit(
            "events.extracted",
            {
                "transcriptId": req.transcript_id,
                "scheduledClassId": req.scheduled_class_id,
                "eventIds": [],
                "awaitingReview": 0,
                "skipped": True,
                "limitation": limitation.code,
                "language": language,
            },
            ctx.institution_id,
        )
        return ExtractionResult(
            transcript_id=req.transcript_id,
            scheduled_class_id=req.scheduled_class_id,
            extractor=kind,
            events=[],
            validation=ValidationStats(reasons={"unsupported_language": 1}),
            awaiting_review=0,
            published=0,
            language=language,
            skipped=True,
            limitation=limitation,
        )

    async def _run_extractors(
        self, kind: ExtractorKind, segments: list[TranscriptSegment], ctx: ClassContext
    ) -> ExtractionOutput:
        if kind == "heuristic":
            return self.heuristic.extract(segments, ctx)
        if self.d.gateway is None:
            if kind == "llm":
                raise ServiceError(503, "gateway_not_configured", "AI gateway is not configured")
            return self.heuristic.extract(segments, ctx)
        llm = LlmExtractor(self.d.gateway, self.resolver, self.d.prompt_version)
        if kind == "llm":
            try:
                return await llm.extract(segments, ctx)
            except UpstreamError as exc:
                raise ServiceError(502, "gateway_error", str(exc)) from exc
        heuristic_out = self.heuristic.extract(segments, ctx)
        try:
            llm_out = await llm.extract(segments, ctx)
        except UpstreamError as exc:
            log.warning("gateway failed, hybrid falls back to heuristic: %s", exc)
            heuristic_out.drop("gateway_unavailable_fallback")
            return heuristic_out
        return self._merge(heuristic_out, llm_out)

    @staticmethod
    def _merge(heuristic: ExtractionOutput, llm: ExtractionOutput) -> ExtractionOutput:
        """Hybrid: events found by both are corroborated; LLM-only events need review."""
        merged = ExtractionOutput(
            drafts=[],
            reasons={**heuristic.reasons},
            candidates=max(heuristic.candidates, llm.candidates),
            injection_suspected=llm.injection_suspected,
            prompt_version=llm.prompt_version,
            model=llm.model,
        )
        for reason, n in llm.reasons.items():
            merged.reasons[f"llm_{reason}"] = merged.reasons.get(f"llm_{reason}", 0) + n
        used: set[int] = set()
        for h in heuristic.drafts:
            match = next(
                (
                    i
                    for i, l_draft in enumerate(llm.drafts)
                    if i not in used
                    and l_draft.type == h.type
                    and abs(l_draft.segment_index - h.segment_index) <= 1
                ),
                None,
            )
            if match is not None:
                used.add(match)
                h.classification = min(0.97, h.classification + 0.03)
                h.corroborated = True
                h.injection_suspected = llm.injection_suspected
                h.title = llm.drafts[match].title or h.title
                h.description = llm.drafts[match].description
            merged.drafts.append(h)
        for i, l_draft in enumerate(llm.drafts):
            if i not in used:
                l_draft.classification = min(l_draft.classification, 0.85)
                merged.drafts.append(l_draft)
        return merged

    def _to_event(
        self,
        draft: Draft,
        ctx: ClassContext,
        segments: dict[int, TranscriptSegment],
        transcript_id: str,
        recording_session_id: str | None,
        output: ExtractionOutput,
    ) -> ExtractedEvent:
        res = draft.resolution
        assert res is not None
        seg = segments[draft.segment_index]
        flags: list[str] = []
        if res.ambiguous or res.event_date is None:
            flags.append("ambiguous_date")
        if res.past:
            flags.append("past_date")
        if seg.confidence < 0.6:
            flags.append("low_transcription_confidence")
        if draft.injection_suspected or output.injection_suspected:
            flags.append("injection_suspected")
        now = self.d.clock.now()
        is_llm = draft.extractor == "llm" or draft.corroborated
        return ExtractedEvent(
            id=str(uuid.uuid4()),
            type=draft.type,
            title=draft.title,
            description=draft.description,
            institution_id=ctx.institution_id,
            course_id=ctx.course_id,
            class_section_id=ctx.class_section_id,
            scheduled_class_id=ctx.scheduled_class_id,
            transcript_id=transcript_id,
            professor_id=ctx.professor_id,
            event_date=res.event_date.isoformat() if res.event_date else None,
            event_time=res.event_time,
            timezone=ctx.timezone,
            date_expression=res.expression,
            date_resolution=DateResolutionModel(
                method=res.method,
                ambiguous=res.ambiguous,
                candidates=res.candidates,
                explanation=res.explanation,
            ),
            source=EventSource(
                recording_session_id=recording_session_id,
                segment_index=seg.segment_index,
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                quote=draft.quote,
            ),
            confidence=compute_confidence(draft, segments, ctx),
            flags=flags,
            provenance=Provenance(
                extractor="llm" if is_llm else "heuristic",
                prompt_id=PROMPT_ID if is_llm else None,
                prompt_version=output.prompt_version if is_llm else None,
                model=output.model if is_llm else None,
                processing_version=PROCESSING_VERSION,
            ),
            created_at=now,
            updated_at=now,
        )

    @staticmethod
    def _mention(ev: ExtractedEvent, now: Any) -> Mention:
        return Mention(
            scheduled_class_id=ev.scheduled_class_id,
            segment_index=ev.source.segment_index,
            quote=ev.source.quote,
            event_date=ev.event_date,
            recorded_at=now,
        )

    @staticmethod
    def _add_mention(target: ExtractedEvent, mention: Mention) -> None:
        """Record a repeat, ignoring re-extractions of the same class segment."""
        if (
            target.scheduled_class_id == mention.scheduled_class_id
            and target.source.segment_index == mention.segment_index
        ):
            return
        if any(
            m.scheduled_class_id == mention.scheduled_class_id
            and m.segment_index == mention.segment_index
            for m in target.mentions
        ):
            return
        target.mentions.append(mention)

    @staticmethod
    def _same_event(a: ExtractedEvent, b: ExtractedEvent) -> bool:
        if a.class_section_id != b.class_section_id or a.type != b.type:
            return False
        if a.event_date and b.event_date:
            if a.event_date != b.event_date:
                return False
            if _is_specific(a.title) and _is_specific(b.title):
                return similarity(a.title, b.title) >= 0.8
            return True
        if a.event_date is None and b.event_date is None:
            return similarity(a.title, b.title) >= 0.8
        return False

    @staticmethod
    def _is_date_change(new: ExtractedEvent, old: ExtractedEvent) -> bool:
        if new.class_section_id != old.class_section_id or new.type != old.type:
            return False
        if new.event_date is None or new.event_date == old.event_date:
            return False
        if old.confirmation_status == "rejected":
            return False
        cue = kw.has_date_change_cue(new.source.quote)
        titles_match = similarity(new.title, old.title) >= 0.8
        if old.event_date is None:
            return titles_match
        return (cue and (titles_match or not _is_specific(new.title))) or (
            titles_match and _is_specific(new.title) and _is_specific(old.title)
        )

    async def _check_conflicts(self, ev: ExtractedEvent) -> None:
        if ev.event_date is None:
            ev.conflict_check = "skipped"
            return
        payload: dict[str, Any] = {
            "institutionId": ev.institution_id,
            "classSectionId": ev.class_section_id,
            "type": ev.type,
            "eventDate": ev.event_date,
        }
        if ev.event_time:
            payload["eventTime"] = ev.event_time
        if ev.duplicate_of:
            payload["excludeEventId"] = ev.duplicate_of
        try:
            conflicts = await self.d.calendar.check_conflicts(payload)
        except UpstreamError as exc:
            log.warning("conflict check failed for %s: %s", ev.id, exc)
            ev.conflict_check = "failed"
            return
        ev.conflict_check = "ok"
        ev.conflicts = conflicts
        if any(c.severity != "info" for c in conflicts) and "conflict" not in ev.flags:
            ev.flags.append("conflict")

    @staticmethod
    def _decide_status(ev: ExtractedEvent, policy: PublicationPolicy, ctx: ClassContext) -> bool:
        """Set the review status; return True when the event may be auto-published (§5)."""
        if ctx.professor_id is None:
            ev.confirmation_status = "awaiting_admin"
            return False
        eligible = (
            policy.auto_publish
            and not ev.flags
            and ev.conflict_check == "ok"
            and not any(c.severity != "info" for c in ev.conflicts)
            and ev.event_date is not None
            and ev.confidence.overall >= policy.auto_publish_min_confidence
            and ev.type in policy.allow_auto_publish_types
            and ev.type not in policy.require_professor_review_for
        )
        ev.confirmation_status = "suggested" if eligible else "awaiting_professor"
        return eligible

    # ------------------------------------------------------------------ review workflow
    async def get(self, event_id: str) -> ExtractedEvent:
        ev = await self.d.repository.get(event_id)
        if ev is None:
            raise ServiceError(404, "not_found", f"event {event_id} not found")
        return ev

    async def review_queue(
        self, professor_id: str | None, statuses: list[str], class_section_id: str | None
    ) -> list[ExtractedEvent]:
        selected = await self.d.repository.list_review(statuses, professor_id, class_section_id)
        return sorted(
            selected,
            key=lambda e: (e.event_date is None, e.event_date or "", e.created_at),
        )

    def _authorize(self, ev: ExtractedEvent, actor: Actor) -> None:
        if actor.role in ("admin", "coordinator"):
            return
        if actor.role == "professor" and ev.professor_id and actor.actor_id == ev.professor_id:
            return
        raise ServiceError(403, "forbidden", "only the section professor or an admin may act")

    def _record(
        self,
        ev: ExtractedEvent,
        actor: Actor,
        field_name: str,
        previous: str | None,
        new: str | None,
        change_type: Literal[
            "date_change", "description_change", "status_change", "cancellation", "other"
        ],
        reason: str | None = None,
    ) -> None:
        source: Literal["professor", "admin", "system", "integration"] = (
            "professor"
            if actor.role == "professor"
            else "system"
            if actor.role == "system"
            else "admin"
        )
        ev.change_history.append(
            ChangeRecord(
                changed_at=self.d.clock.now(),
                changed_by=actor.actor_id,
                source=source,
                change_type=change_type,
                field=field_name,
                previous_value=previous,
                new_value=new,
                reason=reason,
            )
        )

    def _set_status(
        self, ev: ExtractedEvent, actor: Actor, status: Any, reason: str | None
    ) -> None:
        previous = ev.confirmation_status
        ev.confirmation_status = status
        self._record(ev, actor, "confirmationStatus", previous, status, "status_change", reason)
        ev.updated_at = self.d.clock.now()

    async def confirm(self, event_id: str, actor: Actor, notes: str | None) -> ExtractedEvent:
        ev = await self.get(event_id)
        self._authorize(ev, actor)
        if ev.confirmation_status not in REVIEWABLE:
            raise ServiceError(
                409, "invalid_state", f"cannot confirm an event in status {ev.confirmation_status}"
            )
        if ev.proposed_change is not None:
            return await self._apply_proposal(ev, actor, notes)
        policy = await self.d.policies.get_policy(ev.institution_id)
        if policy.publish_on_confirm and ev.event_date is None:
            raise ServiceError(
                422,
                "event_date_required",
                "the event has no date; use edit to set eventDate before confirming",
            )
        self._set_status(ev, actor, "confirmed", notes)
        await self.d.repository.update(ev)
        await self._audit("event.confirmed", ev, actor, {"notes": notes})
        await self._emit(
            "event.confirmed", {"eventId": ev.id, "actorId": actor.actor_id}, ev.institution_id
        )
        if policy.publish_on_confirm:
            await self._publish(ev, actor)
        return ev

    async def _apply_proposal(
        self, proposal: ExtractedEvent, actor: Actor, notes: str | None
    ) -> ExtractedEvent:
        assert proposal.proposed_change is not None
        target = await self.get(proposal.proposed_change.target_event_id)
        previous = target.event_date
        target.event_date = proposal.proposed_change.proposed_value
        if proposal.event_time:
            target.event_time = proposal.event_time
        self._record(
            target,
            actor,
            "eventDate",
            previous,
            target.event_date,
            "date_change",
            notes or f"nova data anunciada em aula ({proposal.scheduled_class_id})",
        )
        target.mentions.append(self._mention(proposal, self.d.clock.now()))
        target.updated_at = self.d.clock.now()
        self._set_status(proposal, actor, "confirmed", notes)
        await self.d.repository.update(proposal)
        await self.d.repository.update(target)
        await self._audit(
            "event.edited",
            target,
            actor,
            {
                "field": "eventDate",
                "previous": previous,
                "new": target.event_date,
                "viaProposal": proposal.id,
            },
        )
        if target.confirmation_status == "published":
            await self._publish(target, actor)
            await self._emit(
                "event.updated",
                {"eventId": target.id, "actorId": actor.actor_id, "field": "eventDate"},
                target.institution_id,
            )
        return proposal

    async def edit(
        self, event_id: str, actor: Actor, changes: EditChanges, reason: str | None
    ) -> ExtractedEvent:
        ev = await self.get(event_id)
        self._authorize(ev, actor)
        if ev.confirmation_status == "rejected":
            raise ServiceError(409, "invalid_state", "cannot edit a rejected event")
        applied: dict[str, Any] = {}
        for field_name, attr, change_type in (
            ("title", "title", "description_change"),
            ("description", "description", "description_change"),
            ("type", "type", "other"),
            ("eventDate", "event_date", "date_change"),
            ("eventTime", "event_time", "date_change"),
        ):
            value = getattr(changes, attr)
            if value is None or value == getattr(ev, attr):
                continue
            previous = getattr(ev, attr)
            setattr(ev, attr, value)
            self._record(
                ev,
                actor,
                field_name,
                None if previous is None else str(previous),
                str(value),
                change_type,  # type: ignore[arg-type]
                reason,
            )
            applied[field_name] = value
        if not applied:
            raise ServiceError(422, "no_changes", "no field differs from the current event")
        ev.updated_at = self.d.clock.now()
        await self._audit("event.edited", ev, actor, {"changes": applied, "reason": reason})
        if ev.confirmation_status == "published":
            await self.d.repository.update(ev)
            await self._publish(ev, actor)
            await self._emit(
                "event.updated",
                {"eventId": ev.id, "actorId": actor.actor_id, "fields": list(applied)},
                ev.institution_id,
            )
            return ev
        if ev.confirmation_status == "confirmed":
            await self.d.repository.update(ev)
            return ev
        await self.d.repository.update(ev)
        return await self.confirm(ev.id, actor, reason)

    async def reject(self, event_id: str, actor: Actor, reason: str) -> ExtractedEvent:
        ev = await self.get(event_id)
        self._authorize(ev, actor)
        if ev.confirmation_status not in REVIEWABLE | {"confirmed"}:
            raise ServiceError(
                409, "invalid_state", f"cannot reject an event in status {ev.confirmation_status}"
            )
        self._set_status(ev, actor, "rejected", reason)
        await self.d.repository.update(ev)
        await self._audit("event.rejected", ev, actor, {"reason": reason})
        await self._emit(
            "event.rejected",
            {"eventId": ev.id, "actorId": actor.actor_id, "reason": reason},
            ev.institution_id,
        )
        return ev

    async def publish(self, event_id: str, actor: Actor) -> ExtractedEvent:
        ev = await self.get(event_id)
        self._authorize(ev, actor)
        if ev.confirmation_status not in ("confirmed", "published"):
            raise ServiceError(
                409, "invalid_state", "only confirmed events can be published; confirm it first"
            )
        if ev.event_date is None:
            raise ServiceError(422, "event_date_required", "the event has no date")
        await self._publish(ev, actor)
        return ev

    async def _publish(self, ev: ExtractedEvent, actor: Actor, *, auto: bool = False) -> None:
        if ev.event_date is None:
            raise ServiceError(422, "event_date_required", "the event has no date")
        confirmed = next(
            (
                c
                for c in reversed(ev.change_history)
                if c.field == "confirmationStatus" and c.new_value == "confirmed"
            ),
            None,
        )
        payload: dict[str, Any] = {
            "institutionId": ev.institution_id,
            "courseId": ev.course_id,
            "classSectionId": ev.class_section_id,
            "extractedEventId": ev.id,
            "type": ev.type,
            "title": ev.title,
            "eventDate": ev.event_date,
            "timezone": ev.timezone,
            "isOfficial": not auto,
            "provenance": {
                "recordingSessionId": ev.source.recording_session_id,
                "transcriptId": ev.transcript_id,
                "scheduledClassId": ev.scheduled_class_id,
                "segmentIndex": ev.source.segment_index,
                "startMs": ev.source.start_ms,
                "endMs": ev.source.end_ms,
                "quote": ev.source.quote,
                "confirmedBy": confirmed.changed_by if confirmed else actor.actor_id,
                "confirmedAt": (
                    confirmed.changed_at if confirmed else self.d.clock.now()
                ).isoformat(),
            },
        }
        if ev.description:
            payload["description"] = ev.description
        if ev.event_time:
            payload["eventTime"] = ev.event_time
        try:
            ev.calendar_event_id = await self.d.calendar.publish(payload)
        except UpstreamError as exc:
            raise ServiceError(502, "calendar_error", f"calendar publish failed: {exc}") from exc
        if ev.confirmation_status != "published":
            self._set_status(
                ev, actor, "published", "auto-publicação por política" if auto else None
            )
        ev.updated_at = self.d.clock.now()
        await self.d.repository.update(ev)
        await self._audit(
            "event.published", ev, actor, {"calendarEventId": ev.calendar_event_id, "auto": auto}
        )
        await self._emit(
            "event.published",
            {
                "eventId": ev.id,
                "actorId": actor.actor_id,
                "calendarEventId": ev.calendar_event_id,
                "auto": auto,
            },
            ev.institution_id,
        )

    async def _audit(
        self, action: str, ev: ExtractedEvent, actor: Actor | None, metadata: dict[str, Any]
    ) -> None:
        outbox = _OUTBOX.get()
        if outbox is not None:
            outbox.append(("audit", (action, ev.model_copy(deep=True), actor, metadata), {}))
            return
        await self._audit_now(action, ev, actor, metadata)

    async def _emit(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        """Publish a domain event, deferred until the surrounding DB transaction committed."""
        outbox = _OUTBOX.get()
        if outbox is not None:
            outbox.append(("event", (event_type, data, institution_id), {}))
            return
        await self._emit_now(event_type, data, institution_id)

    async def _emit_now(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        try:
            await self.d.publisher.publish(event_type, data, institution_id)
        except Exception:  # the extraction is committed; delivery problems are logged
            log.exception("could not publish %s", event_type)

    async def _audit_now(
        self, action: str, ev: ExtractedEvent, actor: Actor | None, metadata: dict[str, Any]
    ) -> None:
        try:
            await self.d.audit.record(
                action=action,
                resource_type="extracted_event",
                resource_id=ev.id,
                tenant_id=ev.institution_id,
                actor_id=actor.actor_id if actor and actor.role != "system" else None,
                actor_type=(actor.role if actor else "system")
                if not actor or actor.role != "coordinator"
                else "coordinator",
                metadata={
                    "scheduledClassId": ev.scheduled_class_id,
                    "classSectionId": ev.class_section_id,
                    **metadata,
                },
            )
        except Exception:  # audit failures are never fatal
            log.exception("audit record failed for %s", action)
