"""API and domain models (contract §5)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

# audio-processing decodes both (FLAC via libsndfile; Phase 6.10 gen2 devices encode FLAC).
ALLOWED_AUDIO_FORMATS = frozenset({"wav_pcm_s16le", "flac"})
ALLOWED_SAMPLE_RATES = frozenset({16_000, 22_050, 24_000, 32_000, 44_100, 48_000})
MAX_CHANNELS = 8

DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
MAX_CHUNK_SIZE = 16 * 1024 * 1024
MIN_CHUNK_SIZE = 64 * 1024  # matches upload_sessions CHECK constraint

SHA256_PATTERN = r"^[0-9a-f]{64}$"

UploadStatus = Literal["pending", "uploading", "complete", "failed"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RecordingMetadataIn(CamelModel):
    """Body of ``POST /v1/recordings`` (contract §5.1)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    device_id: UUID
    classroom_id: UUID
    scheduled_class_id: UUID | None = None
    started_at: datetime
    ended_at: datetime
    audio_format: str
    sample_rate: int
    channels: int
    file_size_bytes: int = Field(gt=0)
    checksum_sha256: str = Field(pattern=SHA256_PATTERN)
    firmware_version: str = Field(min_length=1, max_length=50)
    local_recording_id: str = Field(min_length=1, max_length=128)

    @field_validator("started_at", "ended_at")
    @classmethod
    def _require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("timestamp must include a UTC offset")
        return value

    @field_validator("audio_format")
    @classmethod
    def _check_format(cls, value: str) -> str:
        if value not in ALLOWED_AUDIO_FORMATS:
            raise ValueError(f"audioFormat must be one of {sorted(ALLOWED_AUDIO_FORMATS)}")
        return value

    @field_validator("sample_rate")
    @classmethod
    def _check_sample_rate(cls, value: int) -> int:
        if value not in ALLOWED_SAMPLE_RATES:
            raise ValueError(f"sampleRate must be one of {sorted(ALLOWED_SAMPLE_RATES)}")
        return value

    @field_validator("channels")
    @classmethod
    def _check_channels(cls, value: int) -> int:
        if not 1 <= value <= MAX_CHANNELS:
            raise ValueError(f"channels must be between 1 and {MAX_CHANNELS}")
        return value

    @model_validator(mode="after")
    def _check_interval(self) -> RecordingMetadataIn:
        if self.ended_at <= self.started_at:
            raise ValueError("endedAt must be after startedAt")
        return self


class RecordingSession(CamelModel):
    id: str
    device_id: str
    classroom_id: str
    institution_id: str | None
    scheduled_class_id: str | None
    started_at: datetime
    ended_at: datetime
    duration_ms: int
    audio_format: str
    sample_rate: int
    channels: int
    file_size_bytes: int
    checksum_sha256: str
    firmware_version: str
    local_recording_id: str
    upload_status: UploadStatus = "pending"
    storage_uri: str | None = None
    recording_policy_id: str | None = None
    audio_deleted_at: datetime | None = None
    created_at: datetime


class UploadCreateIn(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    recording_session_id: UUID
    total_size_bytes: int = Field(gt=0)
    checksum_sha256: str = Field(pattern=SHA256_PATTERN)
    chunk_size_bytes: int = Field(default=DEFAULT_CHUNK_SIZE, ge=MIN_CHUNK_SIZE, le=MAX_CHUNK_SIZE)


class UploadSession(CamelModel):
    upload_id: str
    recording_session_id: str
    device_id: str
    total_size_bytes: int
    checksum_sha256: str
    chunk_size_bytes: int
    total_chunks: int
    chunk_checksums: dict[int, str] = Field(default_factory=dict)
    status: UploadStatus = "pending"
    failure_reason: str | None = None
    created_at: datetime
    completed_at: datetime | None = None

    def expected_chunk_size(self, index: int) -> int:
        if index < self.total_chunks - 1:
            return self.chunk_size_bytes
        return self.total_size_bytes - self.chunk_size_bytes * (self.total_chunks - 1)

    def missing_chunks(self) -> list[int]:
        return [i for i in range(self.total_chunks) if i not in self.chunk_checksums]


class UploadOut(CamelModel):
    upload_id: str
    recording_session_id: str
    status: UploadStatus
    total_chunks: int
    chunk_size_bytes: int
    received_chunks: list[int]
    failure_reason: str | None = None
    storage_uri: str | None = None

    @classmethod
    def from_session(cls, upload: UploadSession, storage_uri: str | None = None) -> UploadOut:
        return cls(
            upload_id=upload.upload_id,
            recording_session_id=upload.recording_session_id,
            status=upload.status,
            total_chunks=upload.total_chunks,
            chunk_size_bytes=upload.chunk_size_bytes,
            received_chunks=sorted(upload.chunk_checksums),
            failure_reason=upload.failure_reason,
            storage_uri=storage_uri,
        )


class RecordingEventIn(CamelModel):
    """Device-reported recording lifecycle event (``POST /v1/recording-events``)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    type: Literal["recording.started", "recording.stopped"]
    # Sent by the firmware; optional, but when present it must match the signing device.
    device_id: UUID | None = None
    local_recording_id: str = Field(min_length=1, max_length=128)
    scheduled_class_id: UUID | None = None
    at: datetime
    reason: str | None = Field(default=None, max_length=500)

    @field_validator("at")
    @classmethod
    def _require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("timestamp must include a UTC offset")
        return value
