"""Post-capture pipeline (Phase 6 §6.10): multichannel PCM → upload file.

    capture.pcm (N ch, s16le)
      ├─ keepRawMultichannel → <id>.raw.wav   (kept on the device, not uploaded)
      ├─ beamform (delay-and-sum) → mono       (N > 1)
      ├─ VAD trim of pre/post-roll silence      (profile.vad.enabled + class window known)
      ├─ WAV (s16le mono)
      └─ FLAC via the `flac` CLI (profile.encoding == "flac"; verified with --verify)
                 ↳ fallback: WAV, and the reason is recorded on the spool entry

The uploaded file is always mono; its format is reported as ``audioFormat``
(``wav_pcm_s16le`` or ``flac``) in the recording metadata.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from ci_agent.capabilities import CaptureProfile
from ci_agent.dsp import beamform_file, copy_range, frame_levels_dbfs, vad_trim_bounds
from ci_agent.timeutil import parse_iso
from ci_agent.wav import finalize_pcm_to_wav

log = logging.getLogger(__name__)

AUDIO_FORMAT_WAV = "wav_pcm_s16le"
AUDIO_FORMAT_FLAC = "flac"
VAD_FRAME_MS = 20


@dataclass(frozen=True)
class EncodeResult:
    ok: bool
    detail: str


def flac_encode(
    wav: Path,
    out: Path,
    which: Callable[[str], str | None] = shutil.which,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    timeout_s: float = 600.0,
) -> EncodeResult:
    binary = which("flac")
    if binary is None:
        return EncodeResult(False, "flac CLI not installed")
    try:
        done = run(
            [binary, "--silent", "--best", "--verify", "--force", "-o", str(out), str(wav)],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return EncodeResult(False, f"flac failed: {exc}")
    if done.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        return EncodeResult(False, f"flac exited {done.returncode}: {done.stderr.strip()[:200]}")
    return EncodeResult(True, "flac")


@dataclass(frozen=True)
class ProcessedAudio:
    file: Path
    audio_format: str
    channels: int
    size_bytes: int
    checksum_sha256: str
    duration_ms: int
    trimmed_start_ms: int
    trimmed_end_ms: int
    capture_duration_ms: int
    encoding_note: str
    raw_file: Path | None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class CapturePipeline:
    def __init__(
        self,
        profile_provider: Callable[[], CaptureProfile],
        delays_provider: Callable[[int, int], Sequence[int] | None] = lambda _c, _sr: None,
        encoder: Callable[[Path, Path], EncodeResult] = flac_encode,
    ) -> None:
        self.profile_provider = profile_provider
        self.delays_provider = delays_provider
        self.encoder = encoder

    def process(
        self,
        pcm: Path,
        *,
        local_id: str,
        sample_rate: int,
        channels: int,
        started_at: str,
        class_starts_at: str | None,
        class_ends_at: str | None,
    ) -> ProcessedAudio:
        profile = self.profile_provider()
        directory = pcm.parent
        frame = 2 * channels
        size = pcm.stat().st_size
        usable = size - size % frame
        capture_ms = int(usable / frame * 1000 / sample_rate) if sample_rate else 0
        temps: list[Path] = []

        raw_file: Path | None = None
        if channels > 1 and profile.keep_raw_multichannel:
            raw_file = directory / f"{local_id}.raw.wav"
            finalize_pcm_to_wav(pcm, raw_file, sample_rate, channels)

        mono = pcm
        if channels > 1:
            mono = directory / f".{local_id}.mono.pcm"
            temps.append(mono)
            delays = self.delays_provider(channels, sample_rate) if profile.beamforming else None
            beamform_file(pcm, mono, channels, delays)

        start_ms, end_ms = 0, capture_ms
        if profile.vad.enabled and (class_starts_at or class_ends_at):
            began = parse_iso(started_at)
            cls_start = _offset_ms(began, class_starts_at, default=0)
            cls_end = _offset_ms(began, class_ends_at, default=capture_ms)
            result = vad_trim_bounds(
                frame_levels_dbfs(mono, sample_rate, VAD_FRAME_MS),
                VAD_FRAME_MS,
                class_start_ms=cls_start,
                class_end_ms=cls_end,
                threshold_db=profile.vad.threshold_db,
                margin_ms=profile.vad.margin_ms,
                trim_pre_roll=profile.vad.trim_pre_roll,
                trim_post_roll=profile.vad.trim_post_roll,
            )
            if result.trimmed:
                start_ms, end_ms = result.start_ms, min(result.end_ms, capture_ms)
                trimmed = directory / f".{local_id}.trim.pcm"
                temps.append(trimmed)
                copy_range(mono, trimmed, sample_rate, start_ms, end_ms)
                mono = trimmed
                log.info(
                    "VAD trimmed %s: kept %d–%d ms of %d ms", local_id, start_ms, end_ms, capture_ms
                )

        wav = directory / f"{local_id}.wav"
        audio = finalize_pcm_to_wav(mono, wav, sample_rate, 1)
        out, audio_format, note = wav, AUDIO_FORMAT_WAV, "wav"
        if profile.encoding == "flac":
            flac = directory / f"{local_id}.flac"
            encoded = self.encoder(wav, flac)
            if encoded.ok:
                wav.unlink(missing_ok=True)
                out, audio_format, note = flac, AUDIO_FORMAT_FLAC, "flac"
            else:
                note = f"wav (fallback: {encoded.detail})"
                log.warning("FLAC encoding of %s unavailable: %s", local_id, encoded.detail)
        for t in temps:
            t.unlink(missing_ok=True)
        return ProcessedAudio(
            file=out,
            audio_format=audio_format,
            channels=1,
            size_bytes=out.stat().st_size,
            checksum_sha256=_sha256(out) if out != wav else audio.checksum_sha256,
            duration_ms=audio.duration_ms,
            trimmed_start_ms=start_ms,
            trimmed_end_ms=end_ms,
            capture_duration_ms=capture_ms,
            encoding_note=note,
            raw_file=raw_file,
        )


def _offset_ms(began: datetime, at: str | None, default: int) -> int:
    if not at:
        return default
    return int((parse_iso(at) - began) / timedelta(milliseconds=1))
