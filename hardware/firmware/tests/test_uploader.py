from __future__ import annotations

import hashlib
from pathlib import Path

import httpx

from ci_agent.api import IngestionApi
from ci_agent.identity import DeviceIdentity
from ci_agent.spool import Spool
from ci_agent.uploader import Uploader

from .conftest import T0, Clock, FakeIngestion

CHUNK = 1000


def setup(
    tmp_path: Path, identity: DeviceIdentity, clock: Clock
) -> tuple[FakeIngestion, Spool, Uploader, list[float]]:
    fake = FakeIngestion(identity, "dev-1")
    api = IngestionApi(
        "http://ingest",
        identity,
        "dev-1",
        transport=httpx.MockTransport(fake.handler),
        clock=clock,
    )
    spool = Spool(tmp_path, 10**9, 10**9)
    sleeps: list[float] = []
    uploader = Uploader(
        api,
        spool,
        "dev-1",
        "1.0.0",
        CHUNK,
        max_attempts_per_cycle=3,
        sleep=sleeps.append,
        rand=lambda: 1.0,
        clock=clock,
    )
    return fake, spool, uploader, sleeps


def recorded(spool: Spool, size: int = 4500) -> str:
    entry = spool.begin("room", "class-A", T0)
    spool.path_of(entry.pcm_file).write_bytes(
        bytes(range(256)) * (size // 256) + b"\0" * (size % 256)
    )
    return spool.finish(entry.local_recording_id, T0).local_recording_id


def test_full_upload_happy_path(tmp_path: Path, identity: DeviceIdentity, clock: Clock) -> None:
    fake, spool, uploader, _ = setup(tmp_path, identity, clock)
    rid = recorded(spool)
    result = uploader.upload_pending()
    assert result.uploaded == [rid]
    entry = spool.get(rid)
    assert entry is not None and entry.state == "uploaded"
    (rec,) = fake.recordings.values()
    assert rec["localRecordingId"] == rid and rec["scheduledClassId"] == "class-A"
    assert rec["audioFormat"] == "wav_pcm_s16le" and rec["sampleRate"] == 16000
    (up,) = fake.uploads.values()
    assert up["status"] == "complete"
    assert hashlib.sha256(up["blob"]).hexdigest() == entry.checksum_sha256
    assert sorted(fake.chunk_puts) == list(range(up["totalChunks"]))


def test_resume_after_mid_upload_failure(
    tmp_path: Path, identity: DeviceIdentity, clock: Clock
) -> None:
    fake, spool, uploader, sleeps = setup(tmp_path, identity, clock)
    rid = recorded(spool)
    fake.fail_chunk_times = {2: 99}  # chunk 2 keeps failing with 503 this cycle
    result = uploader.upload_pending()
    assert result.deferred == [rid]
    entry = spool.get(rid)
    assert entry is not None and entry.state == "uploading" and entry.upload_id
    assert entry.attempts == 1 and entry.next_attempt_at is not None
    assert sleeps == [2.0, 4.0]  # exponential backoff within the cycle
    assert fake.chunk_puts == [0, 1]

    # backoff not elapsed yet → skipped
    assert uploader.upload_pending().uploaded == []

    # simulate agent restart: reload spool from disk, network healthy again
    fake.fail_chunk_times = {}
    clock.now = T0.replace(hour=23)
    spool2 = Spool(tmp_path, 10**9, 10**9)
    uploader.spool = spool2
    assert uploader.upload_pending().uploaded == [rid]
    assert fake.chunk_puts == [0, 1, 2, 3, 4]  # only the missing chunks re-sent
    assert len(fake.uploads) == 1
    assert len(fake.recordings) == 1


def test_network_down_defers_and_stops_cycle(
    tmp_path: Path, identity: DeviceIdentity, clock: Clock
) -> None:
    fake, spool, uploader, _ = setup(tmp_path, identity, clock)
    recorded(spool)
    recorded(spool)
    fake.down = True
    result = uploader.upload_pending()
    assert len(result.deferred) == 1 and result.uploaded == []


def test_checksum_mismatch_restarts_upload(
    tmp_path: Path, identity: DeviceIdentity, clock: Clock
) -> None:
    fake, spool, uploader, _ = setup(tmp_path, identity, clock)
    rid = recorded(spool)
    fake.corrupt_once = True
    assert uploader.upload_pending().failed == [rid]
    entry = spool.get(rid)
    assert entry is not None and entry.upload_id is None and entry.state == "uploading"
    clock.now = T0.replace(hour=23)
    assert uploader.upload_pending().uploaded == [rid]
    assert len(fake.uploads) == 2


def test_expired_upload_is_recreated(
    tmp_path: Path, identity: DeviceIdentity, clock: Clock
) -> None:
    fake, spool, uploader, _ = setup(tmp_path, identity, clock)
    rid = recorded(spool)
    entry = spool.get(rid)
    assert entry is not None
    entry.state = "uploading"
    entry.recording_session_id = "rs-x"
    entry.upload_id = "gone"
    spool.update(entry)
    assert uploader.upload_pending().uploaded == [rid]
