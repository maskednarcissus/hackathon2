"""Diarization use case: provider tags → labels, else acoustic clustering."""

from __future__ import annotations

import asyncio
import base64
import binascii
import dataclasses
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

import structlog

from speaker_diarization import PROCESSING_VERSION, V1_PROCESSING_VERSION
from speaker_diarization.adapters.memory import InMemoryTurnRepository
from speaker_diarization.audio import Audio, AudioDecodeError, AudioLoader, decode_wav
from speaker_diarization.engine import (
    EngineConfig,
    SegmentSpan,
    WindowFeatures,
    assign_segments,
    diarize_features,
    extract_windows,
)
from speaker_diarization.engine_v2 import (
    V2Config,
    assign_segments_v2,
    diarize_windows,
    extract_chunked,
)
from speaker_diarization.models import (
    AudioSource,
    DiarizationRequest,
    DiarizationResult,
    SpeakerAssignment,
    TranscriptSegmentRef,
    TurnOut,
)
from speaker_diarization.ports import (
    AuditSink,
    EventPublisher,
    TranscriptStoreClient,
    TurnRepository,
)

log = structlog.get_logger(__name__)


class DiarizationError(Exception):
    pass


def labels_from_provider(segments: list[TranscriptSegmentRef]) -> dict[int, str] | None:
    """Use provider speaker tags/labels when *every* segment carries one."""
    if not segments or not all(s.speaker_tag is not None or s.speaker_label for s in segments):
        return None
    names: dict[str, str] = {}
    out: dict[int, str] = {}
    for seg in sorted(segments, key=lambda s: s.start_ms):
        key = (
            f"tag:{seg.speaker_tag}" if seg.speaker_tag is not None else f"lbl:{seg.speaker_label}"
        )
        if key not in names:
            names[key] = f"SPEAKER_{len(names) + 1}"
        out[seg.segment_index] = names[key]
    return out


def turns_from_segments(
    ordered: list[TranscriptSegmentRef], by_index: dict[int, SpeakerAssignment]
) -> list[TurnOut]:
    """Speaker turns from labelled transcript segments (provider-tag path)."""
    out: list[TurnOut] = []
    for seg in ordered:
        label = by_index[seg.segment_index].speaker_label
        if seg.end_ms <= seg.start_ms:
            continue
        if out and out[-1].speaker_label == label:
            out[-1].end_ms = max(out[-1].end_ms, seg.end_ms)
        else:
            out.append(TurnOut(speaker_label=label, start_ms=seg.start_ms, end_ms=seg.end_ms))
    return out


@dataclass
class _Acoustic:
    """Engine-independent acoustic result: turns + optional speaker-count estimate."""

    turns: list[TurnOut]
    labels: dict[int, str]
    estimated: int | None


Extractor = Callable[
    [Audio, int, int | None, int | None], tuple[WindowFeatures, list[float], list[int]]
]


class DiarizationService:
    """Diarization use case.

    ``engine_version`` selects the acoustic fallback: ``"v2"`` (default — Phase 6.1 spectral
    clustering + HMM re-segmentation + overlap) or ``"v1"`` (Phase 1 agglomerative).
    """

    def __init__(
        self,
        *,
        loader: AudioLoader,
        store: TranscriptStoreClient,
        publisher: EventPublisher,
        audit: AuditSink,
        engine: EngineConfig | None = None,
        turns: TurnRepository | None = None,
        engine_version: str = "v2",
        engine_v2: V2Config | None = None,
    ) -> None:
        if engine_version not in ("v1", "v2"):
            raise ValueError(f"unknown diarization engine {engine_version!r}")
        self._turns: TurnRepository = turns or InMemoryTurnRepository()
        self._loader = loader
        self._store = store
        self._publisher = publisher
        self._audit = audit
        self._engine = engine or EngineConfig()
        self._engine_version = engine_version
        self._engine_v2 = engine_v2 or V2Config()

    @property
    def processing_version(self) -> str:
        return PROCESSING_VERSION if self._engine_version == "v2" else V1_PROCESSING_VERSION

    async def _collect(
        self, source: AudioSource, extract: Extractor
    ) -> tuple[WindowFeatures, list[float], list[int]]:
        """Window features for any audio source; one chunk per audio segment."""
        if source.wav_base64 or source.storage_uri:
            if source.wav_base64:
                try:
                    audio = decode_wav(base64.b64decode(source.wav_base64, validate=True))
                except binascii.Error as exc:
                    raise AudioDecodeError(f"invalid base64 audio: {exc}") from exc
            else:
                audio = await self._loader.load(str(source.storage_uri))
            return await asyncio.to_thread(extract, audio, 0, None, None)

        # Ordered audio segments: one at a time (bounded memory for 2 h lectures), skipping
        # windows already covered by the previous overlapping segment.
        features = WindowFeatures()
        levels: list[float] = []
        chunk_ids: list[int] = []
        covered_until: int | None = None
        for ref in sorted(source.segments or [], key=lambda s: s.start_ms):
            audio = await self._loader.load(ref.storage_uri)
            f, lv, ids = await asyncio.to_thread(
                extract, audio, ref.start_ms, covered_until, ref.index
            )
            features.starts_ms.extend(f.starts_ms)
            features.embeddings.extend(f.embeddings)
            levels.extend(lv)
            chunk_ids.extend(ids)
            covered_until = max(covered_until or 0, ref.start_ms + audio.duration_ms)
        return features, levels, chunk_ids

    async def _acoustic_v1(self, request: DiarizationRequest, audio: AudioSource) -> _Acoustic:
        cfg = self._engine
        if request.max_speakers:
            cfg = dataclasses.replace(cfg, max_speakers=request.max_speakers)

        def extract(
            a: Audio, offset: int, skip: int | None, _chunk: int | None
        ) -> tuple[WindowFeatures, list[float], list[int]]:
            f, lv = extract_windows(a, cfg, offset, skip)
            return f, lv, [0] * len(f.starts_ms)

        features, levels, _ = await self._collect(audio, extract)
        turns = await asyncio.to_thread(diarize_features, features, levels, cfg)
        if not turns:
            raise DiarizationError("no speech detected in audio")
        labels = assign_segments(
            [SegmentSpan(s.segment_index, s.start_ms, s.end_ms) for s in request.segments], turns
        )
        out = [
            TurnOut(speaker_label=t.speaker, start_ms=t.start_ms, end_ms=t.end_ms)
            for t in turns
            if t.end_ms > t.start_ms
        ]
        return _Acoustic(out, labels, None)

    async def _acoustic_v2(self, request: DiarizationRequest, audio: AudioSource) -> _Acoustic:
        cfg = self._engine_v2
        if request.max_speakers:
            cfg = dataclasses.replace(cfg, max_speakers=min(8, request.max_speakers))

        def extract(
            a: Audio, offset: int, skip: int | None, chunk: int | None
        ) -> tuple[WindowFeatures, list[float], list[int]]:
            return extract_chunked(a, cfg, offset, chunk, skip)

        features, levels, chunk_ids = await self._collect(audio, extract)
        result = await asyncio.to_thread(diarize_windows, features, levels, chunk_ids, cfg)
        if not result.turns:
            raise DiarizationError("no speech detected in audio")
        labels = assign_segments_v2(
            [SegmentSpan(s.segment_index, s.start_ms, s.end_ms) for s in request.segments],
            result.turns,
        )
        out = [
            TurnOut(
                speaker_label=t.speaker,
                start_ms=t.start_ms,
                end_ms=t.end_ms,
                overlap=t.overlap,
                confidence=t.confidence,
            )
            for t in result.turns
        ]
        return _Acoustic(out, labels, result.estimated_speakers)

    async def diarize(self, request: DiarizationRequest) -> DiarizationResult:
        resource = request.transcript_id
        acoustic: _Acoustic | None = None
        labels = labels_from_provider(request.segments)
        method = "provider_tags"
        version = self.processing_version
        try:
            if labels is None:
                method = "acoustic_clustering"
                if request.audio is None:
                    raise DiarizationError("no provider speaker tags and no audio supplied")
                if self._engine_version == "v2":
                    acoustic = await self._acoustic_v2(request, request.audio)
                else:
                    acoustic = await self._acoustic_v1(request, request.audio)
                labels = acoustic.labels
        except (AudioDecodeError, DiarizationError, OSError) as exc:
            await self._audit.record(
                action="diarization.failed",
                resource_type="transcript",
                resource_id=resource,
                institution_id=request.institution_id,
                metadata={"reason": str(exc), "processingVersion": version},
            )
            raise DiarizationError(str(exc)) from exc

        # Relabel by first appearance in the transcript so labels are stable and ordered.
        ordered = sorted(request.segments, key=lambda s: s.start_ms)
        rename: dict[str, str] = {}
        for seg in ordered:
            old = labels[seg.segment_index]
            if old not in rename:
                rename[old] = f"SPEAKER_{len(rename) + 1}"
        assignments = [
            SpeakerAssignment(
                segment_index=s.segment_index, speaker_label=rename[labels[s.segment_index]]
            )
            for s in ordered
        ]
        speaker_count = len(rename)
        if acoustic is not None:
            # Speakers heard only in turns no transcript segment covers keep a new label
            # after the transcript's ones (still anonymous).
            for t in acoustic.turns:
                if t.speaker_label not in rename:
                    rename[t.speaker_label] = f"SPEAKER_{len(rename) + 1}"
            turn_out = [
                t.model_copy(update={"speaker_label": rename[t.speaker_label]})
                for t in acoustic.turns
            ]
        else:
            turn_out = turns_from_segments(ordered, {a.segment_index: a for a in assignments})
        result = DiarizationResult(
            transcript_id=resource,
            method=method,
            speaker_count=speaker_count,
            speaker_count_estimated=acoustic.estimated if acoustic else None,
            assignments=assignments,
            turns=turn_out,
            processing_version=version,
            completed_at=datetime.now(UTC),
        )
        await self._turns.replace(resource, turn_out, version)
        await self._store.put_speakers(
            resource,
            assignments,
            speaker_count,
            method=method,
            processing_version=version,
        )
        data: dict[str, object] = {"transcriptId": resource, "speakerCount": speaker_count}
        if result.speaker_count_estimated is not None:
            data["speakerCountEstimated"] = result.speaker_count_estimated
        if request.recording_session_id:
            data["recordingSessionId"] = request.recording_session_id
        await self._publisher.publish("diarization.completed", data, request.institution_id)
        await self._audit.record(
            action="diarization.completed",
            resource_type="transcript",
            resource_id=resource,
            institution_id=request.institution_id,
            metadata={
                "method": method,
                "speakerCount": speaker_count,
                "speakerCountEstimated": result.speaker_count_estimated,
                "overlapTurns": sum(t.overlap for t in turn_out),
                "segments": len(assignments),
                "processingVersion": version,
            },
        )
        log.info("diarization.completed", transcript_id=resource, speakers=speaker_count)
        return result

    async def turns(self, transcript_id: str) -> list[TurnOut]:
        return await self._turns.list(transcript_id)

    async def diarize_transcription(
        self,
        *,
        transcript_id: str,
        recording_session_id: str | None,
        institution_id: str | None,
        audio: AudioSource | None,
    ) -> DiarizationResult:
        """Handle ``transcription.completed``: fetch segments, then diarize."""
        segments = await self._store.get_segments(transcript_id)
        if not segments:
            reason = f"transcript {transcript_id} has no segments"
            await self._audit.record(
                action="diarization.failed",
                resource_type="transcript",
                resource_id=transcript_id,
                institution_id=institution_id,
                metadata={"reason": reason},
            )
            raise DiarizationError(reason)
        return await self.diarize(
            DiarizationRequest(
                transcript_id=transcript_id,
                recording_session_id=recording_session_id,
                institution_id=institution_id,
                audio=audio,
                segments=segments,
            )
        )
