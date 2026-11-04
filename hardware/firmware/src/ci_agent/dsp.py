"""On-device audio processing for multi-microphone units (Phase 6 §6.10).

* **Delay-and-sum beamforming**: each channel is delayed by the integer number of samples
  that aligns a far-field source at the steering azimuth, then the channels are averaged.
  Coherent speech adds up while diffuse noise (HVAC, reverberation) partially cancels
  (≈ +10·log10(N) dB SNR for uncorrelated noise). Steering defaults to broadside (0°),
  i.e. the lectern in front of a wall-mounted linear array.
* **Energy VAD**: 20 ms frame energies against an adaptive noise floor (10th percentile);
  used only to trim silence in the pre-/post-roll, never inside the class itself.

Everything streams from/to files in fixed-size blocks so a 2-hour 4-channel capture never
has to fit in memory.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

SPEED_OF_SOUND_M_S = 343.0
BLOCK_FRAMES = 16_000  # 1 s at 16 kHz
SILENCE_FLOOR_DBFS = -60.0

Int16Array = npt.NDArray[np.int16]


def parse_mic_positions(value: str) -> list[tuple[float, float]]:
    """``"x,y;x,y;…"`` in metres → positions. Empty → no geometry (zero delays)."""
    positions: list[tuple[float, float]] = []
    for part in filter(None, (p.strip() for p in value.split(";"))):
        x, y = (float(v) for v in part.split(","))
        positions.append((x, y))
    return positions


def steering_delays(
    positions: Sequence[tuple[float, float]],
    azimuth_deg: float,
    sample_rate: int,
    channels: int,
) -> list[int]:
    """Non-negative integer delays (samples) aligning a far-field source at ``azimuth_deg``.

    Azimuth 0° = broadside (perpendicular to the x axis, towards +y).
    """
    if len(positions) != channels:
        return [0] * channels
    theta = math.radians(azimuth_deg)
    direction = (math.sin(theta), math.cos(theta))
    # Mics further along the look direction hear the wavefront earlier (by advance/c); delaying
    # each one by its advance over the latest-hearing mic aligns all channels.
    advance = [(x * direction[0] + y * direction[1]) / SPEED_OF_SOUND_M_S for x, y in positions]
    latest = min(advance)
    return [round((a - latest) * sample_rate) for a in advance]


class DelayAndSum:
    """Streaming delay-and-sum mixer: interleaved int16 blocks in → mono int16 out."""

    def __init__(self, channels: int, delays: Sequence[int] | None = None) -> None:
        self.channels = channels
        self.delays = list(delays) if delays else [0] * channels
        if len(self.delays) != channels or min(self.delays) < 0:
            raise ValueError("one non-negative delay per channel is required")
        self.max_delay = max(self.delays)
        # History so delays work across block boundaries.
        self._history = np.zeros((self.max_delay, channels), dtype=np.float32)

    def process(self, interleaved: Int16Array) -> Int16Array:
        frames = interleaved.reshape(-1, self.channels).astype(np.float32)
        if frames.shape[0] == 0:
            return np.zeros(0, dtype=np.int16)
        padded = np.concatenate([self._history, frames])
        n = frames.shape[0]
        acc = np.zeros(n, dtype=np.float32)
        for ch, delay in enumerate(self.delays):
            start = self.max_delay - delay
            acc += padded[start : start + n, ch]
        if self.max_delay:
            self._history = padded[-self.max_delay :]
        mono = np.clip(np.round(acc / self.channels), -32768, 32767)
        return mono.astype(np.int16)


def _read_blocks(path: Path, frame_bytes: int, start_byte: int = 0) -> Iterator[bytes]:
    block = BLOCK_FRAMES * frame_bytes
    with path.open("rb") as fh:
        fh.seek(start_byte)
        carry = b""
        while True:
            data = fh.read(block)
            if not data:
                break
            data = carry + data
            usable = len(data) - (len(data) % frame_bytes)
            carry = data[usable:]
            if usable:
                yield data[:usable]


def beamform_file(src: Path, dst: Path, channels: int, delays: Sequence[int] | None = None) -> int:
    """Mix an interleaved s16le capture down to mono; returns mono frames written."""
    mixer = DelayAndSum(channels, delays)
    written = 0
    with dst.open("wb") as out:
        for block in _read_blocks(src, 2 * channels):
            mono = mixer.process(np.frombuffer(block, dtype="<i2"))
            out.write(mono.astype("<i2").tobytes())
            written += mono.shape[0]
    return written


def frame_levels_dbfs(path: Path, sample_rate: int, frame_ms: int = 20) -> npt.NDArray[np.float64]:
    """dBFS of consecutive mono frames of a raw s16le file."""
    frame = max(1, sample_rate * frame_ms // 1000)
    levels: list[npt.NDArray[np.float64]] = []
    tail = np.zeros(0, dtype=np.float64)
    for block in _read_blocks(path, 2):
        samples = np.concatenate([tail, np.frombuffer(block, dtype="<i2").astype(np.float64)])
        whole = samples.shape[0] // frame * frame
        tail = samples[whole:]
        if whole:
            rms = np.sqrt(np.mean(samples[:whole].reshape(-1, frame) ** 2, axis=1))
            levels.append(20 * np.log10(np.maximum(rms, 1e-9) / 32768.0))
    return np.concatenate(levels) if levels else np.zeros(0, dtype=np.float64)


@dataclass(frozen=True)
class TrimResult:
    start_ms: int
    end_ms: int
    duration_ms: int
    speech_detected: bool
    noise_floor_dbfs: float | None

    @property
    def trimmed(self) -> bool:
        return self.start_ms > 0 or self.end_ms < self.duration_ms


def vad_trim_bounds(
    levels_dbfs: npt.NDArray[np.float64],
    frame_ms: int,
    *,
    class_start_ms: int,
    class_end_ms: int,
    threshold_db: float = 12.0,
    margin_ms: int = 1000,
    trim_pre_roll: bool = True,
    trim_post_roll: bool = True,
) -> TrimResult:
    """Keep ``[start_ms, end_ms)``: silence is trimmed only inside the pre-roll
    (``< class_start_ms``) and post-roll (``>= class_end_ms``)."""
    duration = int(levels_dbfs.shape[0] * frame_ms)
    class_start = max(0, min(class_start_ms, duration))
    class_end = max(class_start, min(class_end_ms, duration))
    if levels_dbfs.shape[0] == 0:
        return TrimResult(0, duration, duration, False, None)
    floor = float(np.percentile(levels_dbfs, 10))
    threshold = max(floor + threshold_db, SILENCE_FLOOR_DBFS)
    speech = np.nonzero(levels_dbfs > threshold)[0]
    start, end = 0, duration
    if speech.shape[0] == 0:
        # Nothing above the floor: keep exactly the class body.
        if trim_pre_roll:
            start = class_start
        if trim_post_roll:
            end = class_end
        return TrimResult(start, end, duration, False, round(floor, 1))
    first_ms = int(speech[0]) * frame_ms
    last_ms = (int(speech[-1]) + 1) * frame_ms
    if trim_pre_roll:
        start = max(0, min(first_ms - margin_ms, class_start))
    if trim_post_roll:
        end = min(duration, max(last_ms + margin_ms, class_end))
    return TrimResult(start, end, duration, True, round(floor, 1))


def copy_range(src: Path, dst: Path, sample_rate: int, start_ms: int, end_ms: int) -> int:
    """Copy the mono s16le samples of ``[start_ms, end_ms)``; returns bytes written."""
    start = int(sample_rate * start_ms / 1000) * 2
    stop = int(sample_rate * end_ms / 1000) * 2
    remaining = max(0, stop - start)
    written = 0
    with src.open("rb") as fh, dst.open("wb") as out:
        fh.seek(start)
        while remaining > 0:
            data = fh.read(min(1 << 20, remaining))
            if not data:
                break
            out.write(data)
            written += len(data)
            remaining -= len(data)
    return written
