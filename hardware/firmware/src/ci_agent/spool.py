"""Durable local audio buffer (deliverable 1.6).

Every recording is tracked in ``index.json`` (written atomically) so that audio
survives reboots, power cuts and long network outages.

States: ``recording`` → ``recorded`` → ``uploading`` → ``uploaded``.

Quota policy
------------
1. Above the *soft* limit, already-uploaded files are deleted (oldest first).
2. Un-uploaded audio is only ever deleted above the *hard* limit; then the oldest
   pending recordings are evicted one by one and an incident is recorded (it is
   reported in heartbeats and logged at ERROR). The active recording is never evicted.
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from ci_agent.fsutil import atomic_write_json, read_json
from ci_agent.timeutil import parse_iso, to_iso, utcnow
from ci_agent.wav import finalize_pcm_to_wav

if TYPE_CHECKING:
    from ci_agent.pipeline import CapturePipeline

log = logging.getLogger(__name__)

EntryState = Literal["recording", "recorded", "uploading", "uploaded"]
PENDING_STATES: tuple[EntryState, ...] = ("recorded", "uploading")
INDEX_VERSION = 1
MAX_INCIDENTS = 100


@dataclass
class SpoolEntry:
    local_recording_id: str
    state: EntryState
    classroom_id: str
    started_at: str
    sample_rate: int
    channels: int
    pcm_file: str
    # Name of the file that is uploaded (``.wav`` or, with FLAC encoding, ``.flac``).
    wav_file: str
    scheduled_class_id: str | None = None
    ended_at: str | None = None
    size_bytes: int = 0
    checksum_sha256: str | None = None
    duration_ms: int = 0
    recovered: bool = False
    recording_session_id: str | None = None
    upload_id: str | None = None
    uploaded_at: str | None = None
    attempts: int = 0
    next_attempt_at: str | None = None
    last_error: str | None = None
    # Phase 6 (gen2): capture pipeline results.
    audio_format: str = "wav_pcm_s16le"
    capture_channels: int | None = None
    class_starts_at: str | None = None
    class_ends_at: str | None = None
    trimmed_start_ms: int = 0
    trimmed_end_ms: int | None = None
    encoding_note: str | None = None
    raw_file: str | None = None
    upload_started_at: str | None = None
    upload_ended_at: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SpoolEntry:
        return cls(**data)


@dataclass
class SpoolIncident:
    at: str
    kind: str
    local_recording_id: str | None
    detail: str


@dataclass
class SpoolStats:
    queued_recordings: int
    queued_bytes: int
    total_bytes: int
    evicted_recordings: int
    incidents: list[SpoolIncident] = field(default_factory=list)


class Spool:
    def __init__(
        self,
        directory: Path,
        soft_limit_bytes: int,
        hard_limit_bytes: int,
        sample_rate: int = 16000,
        channels: int = 1,
        pipeline: CapturePipeline | None = None,
    ) -> None:
        self.directory = directory
        self.pipeline = pipeline
        self.soft_limit_bytes = soft_limit_bytes
        self.hard_limit_bytes = hard_limit_bytes
        self.sample_rate = sample_rate
        self.channels = channels
        self._lock = threading.RLock()
        self._entries: dict[str, SpoolEntry] = {}
        self._incidents: list[SpoolIncident] = []
        self._evicted = 0
        self.directory.mkdir(parents=True, exist_ok=True)
        self._load()
        self.recover()

    # ------------------------------------------------------------------ persistence
    @property
    def index_path(self) -> Path:
        return self.directory / "index.json"

    def _load(self) -> None:
        if not self.index_path.exists():
            return
        try:
            data = read_json(self.index_path)
            self._entries = {
                e["local_recording_id"]: SpoolEntry.from_dict(e) for e in data["entries"]
            }
            self._incidents = [SpoolIncident(**i) for i in data.get("incidents", [])]
            self._evicted = int(data.get("evicted", 0))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            # A corrupt index must never cause audio loss: keep files, rebuild empty
            # index and record an incident. Orphan WAVs are listed by ``orphans()``.
            log.error("spool index unreadable (%s); starting with empty index", exc)
            broken = self.index_path.with_suffix(".corrupt")
            self.index_path.replace(broken)
            self._entries = {}
            self._incident("index_corrupt", None, f"moved to {broken.name}: {exc}")

    def _save(self) -> None:
        atomic_write_json(
            self.index_path,
            {
                "version": INDEX_VERSION,
                "entries": [asdict(e) for e in self._entries.values()],
                "incidents": [asdict(i) for i in self._incidents[-MAX_INCIDENTS:]],
                "evicted": self._evicted,
            },
        )

    def _incident(self, kind: str, local_recording_id: str | None, detail: str) -> None:
        incident = SpoolIncident(to_iso(utcnow()), kind, local_recording_id, detail)
        self._incidents.append(incident)
        log.error("spool incident %s (%s): %s", kind, local_recording_id, detail)

    def path_of(self, name: str) -> Path:
        return self.directory / name

    # ------------------------------------------------------------------ recovery
    def recover(self) -> list[str]:
        """Finalize recordings interrupted by a crash. Returns recovered ids."""
        recovered: list[str] = []
        with self._lock:
            for entry in list(self._entries.values()):
                if entry.state != "recording":
                    continue
                pcm = self.path_of(entry.pcm_file)
                if not pcm.exists() or pcm.stat().st_size == 0:
                    pcm.unlink(missing_ok=True)
                    del self._entries[entry.local_recording_id]
                    self._incident(
                        "empty_recording_discarded", entry.local_recording_id, "no audio data"
                    )
                    continue
                ended = datetime.fromtimestamp(pcm.stat().st_mtime).astimezone()
                self._finalize(entry, ended)
                entry.recovered = True
                recovered.append(entry.local_recording_id)
                self._incident(
                    "recording_recovered",
                    entry.local_recording_id,
                    f"interrupted recording finalized ({entry.duration_ms} ms)",
                )
            if recovered or self._incidents:
                self._save()
        return recovered

    def orphans(self) -> list[Path]:
        known = (
            {e.wav_file for e in self._entries.values()}
            | {e.pcm_file for e in self._entries.values()}
            | {e.raw_file for e in self._entries.values() if e.raw_file}
        )
        return sorted(
            p
            for p in self.directory.iterdir()
            if p.suffix in {".wav", ".pcm", ".flac"} and p.name not in known
        )

    # ------------------------------------------------------------------ lifecycle
    def begin(
        self,
        classroom_id: str,
        scheduled_class_id: str | None,
        started_at: datetime,
        *,
        class_starts_at: datetime | None = None,
        class_ends_at: datetime | None = None,
    ) -> SpoolEntry:
        local_id = str(uuid.uuid4())
        entry = SpoolEntry(
            local_recording_id=local_id,
            state="recording",
            classroom_id=classroom_id,
            scheduled_class_id=scheduled_class_id,
            started_at=to_iso(started_at),
            sample_rate=self.sample_rate,
            channels=self.channels,
            pcm_file=f"{local_id}.pcm",
            wav_file=f"{local_id}.wav",
            class_starts_at=to_iso(class_starts_at) if class_starts_at else None,
            class_ends_at=to_iso(class_ends_at) if class_ends_at else None,
        )
        with self._lock:
            self._entries[local_id] = entry
            self._save()
        return entry

    def _finalize(self, entry: SpoolEntry, ended_at: datetime) -> None:
        pcm = self.path_of(entry.pcm_file)
        if self.pipeline is not None:
            self._finalize_with_pipeline(entry, ended_at, self.pipeline)
            return
        audio = finalize_pcm_to_wav(
            pcm, self.path_of(entry.wav_file), entry.sample_rate, entry.channels
        )
        pcm.unlink(missing_ok=True)
        entry.state = "recorded"
        entry.ended_at = to_iso(ended_at)
        entry.size_bytes = audio.size_bytes
        entry.checksum_sha256 = audio.checksum_sha256
        entry.duration_ms = audio.duration_ms

    def _finalize_with_pipeline(
        self, entry: SpoolEntry, ended_at: datetime, pipeline: CapturePipeline
    ) -> None:
        pcm = self.path_of(entry.pcm_file)
        out = pipeline.process(
            pcm,
            local_id=entry.local_recording_id,
            sample_rate=entry.sample_rate,
            channels=entry.channels,
            started_at=entry.started_at,
            class_starts_at=entry.class_starts_at,
            class_ends_at=entry.class_ends_at,
        )
        pcm.unlink(missing_ok=True)
        began = parse_iso(entry.started_at)
        entry.state = "recorded"
        entry.ended_at = to_iso(ended_at)
        entry.capture_channels = entry.channels
        entry.channels = out.channels
        entry.wav_file = out.file.name
        entry.audio_format = out.audio_format
        entry.size_bytes = out.size_bytes
        entry.checksum_sha256 = out.checksum_sha256
        entry.duration_ms = out.duration_ms
        entry.trimmed_start_ms = out.trimmed_start_ms
        entry.trimmed_end_ms = out.trimmed_end_ms
        entry.encoding_note = out.encoding_note
        entry.raw_file = out.raw_file.name if out.raw_file else None
        # The uploaded audio covers [start + trimmed_start, start + trimmed_start + duration).
        upload_start = began + timedelta(milliseconds=out.trimmed_start_ms)
        entry.upload_started_at = to_iso(upload_start)
        entry.upload_ended_at = to_iso(upload_start + timedelta(milliseconds=out.duration_ms))

    def finish(self, local_recording_id: str, ended_at: datetime) -> SpoolEntry:
        with self._lock:
            entry = self._entries[local_recording_id]
            if entry.state != "recording":
                raise ValueError(f"{local_recording_id} is not recording")
            self._finalize(entry, ended_at)
            self._save()
            return entry

    def update(self, entry: SpoolEntry) -> None:
        with self._lock:
            self._entries[entry.local_recording_id] = entry
            self._save()

    def mark_uploaded(self, local_recording_id: str, at: datetime) -> None:
        with self._lock:
            entry = self._entries[local_recording_id]
            entry.state = "uploaded"
            entry.uploaded_at = to_iso(at)
            entry.last_error = None
            entry.next_attempt_at = None
            self._save()

    def get(self, local_recording_id: str) -> SpoolEntry | None:
        with self._lock:
            return self._entries.get(local_recording_id)

    def entries(self) -> list[SpoolEntry]:
        with self._lock:
            return sorted(self._entries.values(), key=lambda e: e.started_at)

    def pending(self, now: datetime | None = None) -> list[SpoolEntry]:
        """Recordings awaiting upload, oldest first, honouring backoff."""
        with self._lock:
            result = []
            for entry in self.entries():
                if entry.state not in PENDING_STATES:
                    continue
                if now and entry.next_attempt_at and parse_iso(entry.next_attempt_at) > now:
                    continue
                result.append(entry)
            return result

    # ------------------------------------------------------------------ quota
    def _entry_bytes(self, entry: SpoolEntry) -> int:
        total = 0
        for name in (entry.wav_file, entry.pcm_file, entry.raw_file):
            if not name:
                continue
            path = self.path_of(name)
            if path.exists():
                total += path.stat().st_size
        return total

    def total_bytes(self) -> int:
        with self._lock:
            return sum(self._entry_bytes(e) for e in self._entries.values())

    def _remove(self, entry: SpoolEntry) -> None:
        self.path_of(entry.wav_file).unlink(missing_ok=True)
        self.path_of(entry.pcm_file).unlink(missing_ok=True)
        if entry.raw_file:
            self.path_of(entry.raw_file).unlink(missing_ok=True)
        del self._entries[entry.local_recording_id]

    def purge_uploaded(self, now: datetime, retention: timedelta) -> int:
        removed = 0
        with self._lock:
            for entry in self.entries():
                if (
                    entry.state == "uploaded"
                    and entry.uploaded_at
                    and now - parse_iso(entry.uploaded_at) >= retention
                ):
                    self._remove(entry)
                    removed += 1
            if removed:
                self._save()
        return removed

    def enforce_quota(self) -> list[str]:
        """Apply the soft/hard limit policy. Returns ids removed."""
        removed: list[str] = []
        with self._lock:
            total = self.total_bytes()
            for entry in self.entries():
                if total <= self.soft_limit_bytes:
                    break
                if entry.state == "uploaded":
                    total -= self._entry_bytes(entry)
                    self._remove(entry)
                    removed.append(entry.local_recording_id)
            for entry in self.entries():
                if total <= self.hard_limit_bytes:
                    break
                if entry.state in PENDING_STATES:
                    size = self._entry_bytes(entry)
                    total -= size
                    self._remove(entry)
                    self._evicted += 1
                    removed.append(entry.local_recording_id)
                    self._incident(
                        "pending_recording_evicted",
                        entry.local_recording_id,
                        f"hard limit exceeded; evicted {size} bytes never uploaded "
                        f"(scheduledClassId={entry.scheduled_class_id})",
                    )
            if removed:
                self._save()
        return removed

    def stats(self) -> SpoolStats:
        with self._lock:
            pending = [e for e in self._entries.values() if e.state in PENDING_STATES]
            return SpoolStats(
                queued_recordings=len(pending),
                queued_bytes=sum(self._entry_bytes(e) for e in pending),
                total_bytes=self.total_bytes(),
                evicted_recordings=self._evicted,
                incidents=list(self._incidents[-10:]),
            )
