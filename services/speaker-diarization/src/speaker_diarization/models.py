"""Wire models (camelCase JSON)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class AudioSegmentRef(CamelModel):
    index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    storage_uri: str = Field(min_length=1)


class AudioSource(CamelModel):
    """Either one recording URI, inline base64 WAV, or the ordered audio segments."""

    storage_uri: str | None = None
    wav_base64: str | None = None
    segments: list[AudioSegmentRef] | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> AudioSource:
        given = [v for v in (self.storage_uri, self.wav_base64, self.segments) if v]
        if len(given) != 1:
            raise ValueError("provide exactly one of storageUri, wavBase64 or segments")
        return self


class TranscriptSegmentRef(CamelModel):
    segment_index: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    speaker_tag: int | None = None
    speaker_label: str | None = None


class DiarizationRequest(CamelModel):
    transcript_id: str = Field(min_length=1)
    recording_session_id: str | None = None
    institution_id: str | None = None
    audio: AudioSource | None = None
    segments: list[TranscriptSegmentRef] = Field(min_length=1)
    max_speakers: int | None = Field(default=None, ge=1, le=20)


class SpeakerAssignment(CamelModel):
    segment_index: int
    speaker_label: str


class TurnOut(CamelModel):
    speaker_label: str
    start_ms: int
    end_ms: int


class DiarizationResult(CamelModel):
    transcript_id: str
    method: str  # "provider_tags" | "acoustic"
    speaker_count: int
    assignments: list[SpeakerAssignment]
    turns: list[TurnOut]
    processing_version: str
    completed_at: datetime


class EventEnvelope(CamelModel):
    event_id: str
    type: str
    version: int = 1
    occurred_at: datetime
    source: str
    institution_id: str | None = None
    data: dict[str, Any]
