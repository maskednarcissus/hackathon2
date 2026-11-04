"""Results of processing, shared by the pipeline and the repositories."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from audio_processing.quality import QualityReport
from audio_processing.segmentation import Segment

PipelineStatus = Literal["segmented", "stopped_unusable", "duplicate"]


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PipelineResult(_Camel):
    recording_session_id: str
    status: PipelineStatus
    # ``None`` only for a duplicate whose stored result is no longer available.
    report: QualityReport | None
    segments: list[Segment] = Field(default_factory=list)


class SegmentationResult(_Camel):
    duration_ms: int
    segments: list[Segment]
