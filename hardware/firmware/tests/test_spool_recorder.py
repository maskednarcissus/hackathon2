from __future__ import annotations

import hashlib
import json
import time
import wave
from datetime import timedelta
from pathlib import Path

from ci_agent.recorder import FakeSource, Recorder
from ci_agent.spool import Spool

from .conftest import T0, Clock


def make_spool(path: Path, soft: int = 10**9, hard: int = 10**9) -> Spool:
    return Spool(path, soft_limit_bytes=soft, hard_limit_bytes=hard)


def test_recorder_produces_valid_wav_with_checksum(tmp_path: Path, clock: Clock) -> None:
    spool = make_spool(tmp_path)
    recorder = Recorder(spool, lambda: FakeSource(total_bytes=32000 * 3), clock=clock)
    entry = recorder.start("room", "A")
    deadline = time.time() + 5
    while recorder.bytes_captured < 32000 * 3 and time.time() < deadline:
        time.sleep(0.01)
    clock.now = T0 + timedelta(seconds=3)
    done = recorder.stop()
    assert done is not None and done.local_recording_id == entry.local_recording_id
    assert done.state == "recorded"
    wav_path = spool.path_of(done.wav_file)
    with wave.open(str(wav_path)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (16000, 1, 2)
        assert w.getnframes() == 48000
    assert done.duration_ms == 3000
    assert done.checksum_sha256 == hashlib.sha256(wav_path.read_bytes()).hexdigest()
    assert done.size_bytes == wav_path.stat().st_size
    assert not spool.path_of(done.pcm_file).exists()
    assert spool.stats().queued_recordings == 1


def test_crash_during_recording_is_recovered_on_restart(tmp_path: Path) -> None:
    spool = make_spool(tmp_path)
    entry = spool.begin("room", "A", T0)
    # simulate power loss: partial PCM with a torn trailing sample
    spool.path_of(entry.pcm_file).write_bytes(b"\x01\x00" * 16000 + b"\x07")
    del spool

    reopened = make_spool(tmp_path)
    recovered = reopened.get(entry.local_recording_id)
    assert recovered is not None
    assert recovered.state == "recorded" and recovered.recovered
    assert recovered.duration_ms == 1000
    with wave.open(str(reopened.path_of(recovered.wav_file))) as w:
        assert w.getnframes() == 16000
    kinds = [i.kind for i in reopened.stats().incidents]
    assert "recording_recovered" in kinds


def test_empty_interrupted_recording_is_dropped(tmp_path: Path) -> None:
    spool = make_spool(tmp_path)
    entry = spool.begin("room", "A", T0)
    spool.path_of(entry.pcm_file).write_bytes(b"")
    reopened = make_spool(tmp_path)
    assert reopened.get(entry.local_recording_id) is None


def test_uploading_state_and_ids_persist(tmp_path: Path) -> None:
    spool = make_spool(tmp_path)
    entry = spool.begin("room", "A", T0)
    spool.path_of(entry.pcm_file).write_bytes(b"\0\0" * 100)
    entry = spool.finish(entry.local_recording_id, T0)
    entry.state = "uploading"
    entry.upload_id = "up-1"
    entry.recording_session_id = "rs-1"
    spool.update(entry)
    reopened = make_spool(tmp_path)
    again = reopened.get(entry.local_recording_id)
    assert again is not None
    assert (again.state, again.upload_id, again.recording_session_id) == (
        "uploading",
        "up-1",
        "rs-1",
    )
    assert [e.local_recording_id for e in reopened.pending()] == [entry.local_recording_id]


def test_corrupt_index_keeps_audio_files(tmp_path: Path) -> None:
    (tmp_path / "index.json").write_text("{broken")
    (tmp_path / "lost.wav").write_bytes(b"RIFF")
    spool = make_spool(tmp_path)
    assert (tmp_path / "index.corrupt").exists()
    assert [p.name for p in spool.orphans()] == ["lost.wav"]


def _recorded(spool: Spool, minute: int, size: int) -> str:
    entry = spool.begin("room", f"C{minute}", T0 + timedelta(minutes=minute))
    spool.path_of(entry.pcm_file).write_bytes(b"\0" * size)
    spool.finish(entry.local_recording_id, T0 + timedelta(minutes=minute + 1))
    return entry.local_recording_id


def test_quota_deletes_uploaded_before_pending(tmp_path: Path) -> None:
    spool = make_spool(tmp_path, soft=2500, hard=10_000)
    a = _recorded(spool, 0, 1000)
    b = _recorded(spool, 1, 1000)
    c = _recorded(spool, 2, 1000)
    spool.mark_uploaded(a, T0)
    removed = spool.enforce_quota()
    assert removed == [a]  # uploaded file freed; pending b, c untouched
    assert spool.get(b) and spool.get(c)
    assert spool.stats().evicted_recordings == 0


def test_quota_evicts_oldest_pending_only_above_hard_limit(tmp_path: Path) -> None:
    spool = make_spool(tmp_path, soft=1000, hard=2400)  # each WAV = 1000 B + 44 B header
    a = _recorded(spool, 0, 1000)
    b = _recorded(spool, 1, 1000)
    c = _recorded(spool, 2, 1000)
    active = spool.begin("room", "live", T0 + timedelta(minutes=3))
    spool.path_of(active.pcm_file).write_bytes(b"\0" * 400)
    removed = spool.enforce_quota()
    assert removed == [a, b]
    assert spool.get(c) is not None
    assert spool.get(active.local_recording_id) is not None  # never evict live capture
    stats = spool.stats()
    assert stats.evicted_recordings == 2
    assert [i.kind for i in stats.incidents].count("pending_recording_evicted") == 2
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["evicted"] == 2


def test_purge_uploaded_after_retention(tmp_path: Path) -> None:
    spool = make_spool(tmp_path)
    a = _recorded(spool, 0, 100)
    spool.mark_uploaded(a, T0)
    assert spool.purge_uploaded(T0 + timedelta(hours=1), timedelta(hours=24)) == 0
    assert spool.purge_uploaded(T0 + timedelta(hours=24), timedelta(hours=24)) == 1
    assert spool.get(a) is None
