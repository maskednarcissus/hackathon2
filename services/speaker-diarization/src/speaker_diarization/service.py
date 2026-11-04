"""Diarization use case: provider tags → labels, else acoustic clustering."""

from __future__ import annotations

import asyncio
import base64
import binascii
import dataclasses
from datetime import UTC, datetime

import structlog

from speaker_diarization import PROCESSING_VERSION
from speaker_diarization.audio import AudioDecodeError, AudioLoader, decode_wav
from speaker_diarization.engine import (
    EngineConfig,
    SegmentSpan,
    SpeakerTurn,
    WindowFeatures,
    assign_segments,
    diarize_features,
    extract_windows,
)
from speaker_diarization.models import (
    AudioSource,
    DiarizationRequest,
    DiarizationResult,
    SpeakerAssignment,
    TranscriptSegmentRef,
    TurnOut,
)
from speaker_diarization.ports import AuditSink, EventPublisher, TranscriptStoreClient

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


class DiarizationService:
    def __init__(
        self,
        *,
        loader: AudioLoader,
        store: TranscriptStoreClient,
        publisher: EventPublisher,
        audit: AuditSink,
        engine: EngineConfig | None = None,
    ) -> None:
        self._loader = loader
        self._store = store
        self._publisher = publisher
        self._audit = audit
        self._engine = engine or EngineConfig()

    async def _features(
        self, source: AudioSource, cfg: EngineConfig
    ) -> tuple[WindowFeatures, list[float]]:
        if source.wav_base64:
            try:
                audio = decode_wav(base64.b64decode(source.wav_base64, validate=True))
            except binascii.Error as exc:
                raise AudioDecodeError(f"invalid base64 audio: {exc}") from exc
            return await asyncio.to_thread(extract_windows, audio, cfg)
        if source.storage_uri:
            audio = await self._loader.load(source.storage_uri)
            return await asyncio.to_thread(extract_windows, audio, cfg)

        # Ordered audio segments: process one at a time (bounded memory for 2 h lectures),
        # skipping windows already covered by the previous overlapping segment.
        features = WindowFeatures()
        levels: list[float] = []
        covered_until: int | None = None
        for ref in sorted(source.segments or [], key=lambda s: s.start_ms):
            audio = await self._loader.load(ref.storage_uri)
            f, lv = await asyncio.to_thread(
                extract_windows, audio, cfg, ref.start_ms, covered_until
            )
            features.starts_ms.extend(f.starts_ms)
            features.embeddings.extend(f.embeddings)
            levels.extend(lv)
            covered_until = max(covered_until or 0, ref.start_ms + audio.duration_ms)
        return features, levels

    async def diarize(self, request: DiarizationRequest) -> DiarizationResult:
        resource = request.transcript_id
        turns: list[SpeakerTurn] = []
        labels = labels_from_provider(request.segments)
        method = "provider_tags"
        try:
            if labels is None:
                method = "acoustic"
                if request.audio is None:
                    raise DiarizationError("no provider speaker tags and no audio supplied")
                cfg = self._engine
                if request.max_speakers:
                    cfg = dataclasses.replace(cfg, max_speakers=request.max_speakers)
                features, levels = await self._features(request.audio, cfg)
                turns = await asyncio.to_thread(diarize_features, features, levels, cfg)
                if not turns:
                    raise DiarizationError("no speech detected in audio")
                labels = assign_segments(
                    [SegmentSpan(s.segment_index, s.start_ms, s.end_ms) for s in request.segments],
                    turns,
                )
        except (AudioDecodeError, DiarizationError, OSError) as exc:
            await self._audit.record(
                action="diarization.failed",
                resource_type="transcript",
                resource_id=resource,
                institution_id=request.institution_id,
                metadata={"reason": str(exc)},
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
        result = DiarizationResult(
            transcript_id=resource,
            method=method,
            speaker_count=speaker_count,
            assignments=assignments,
            turns=[
                TurnOut(
                    speaker_label=rename.get(t.speaker, t.speaker),
                    start_ms=t.start_ms,
                    end_ms=t.end_ms,
                )
                for t in turns
                if t.speaker in rename
            ],
            processing_version=PROCESSING_VERSION,
            completed_at=datetime.now(UTC),
        )
        await self._store.put_speakers(resource, assignments, speaker_count)
        data: dict[str, object] = {"transcriptId": resource, "speakerCount": speaker_count}
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
                "segments": len(assignments),
                "processingVersion": PROCESSING_VERSION,
            },
        )
        log.info("diarization.completed", transcript_id=resource, speakers=speaker_count)
        return result

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
            raise DiarizationError(f"transcript {transcript_id} has no segments")
        return await self.diarize(
            DiarizationRequest(
                transcript_id=transcript_id,
                recording_session_id=recording_session_id,
                institution_id=institution_id,
                audio=audio,
                segments=segments,
            )
        )
