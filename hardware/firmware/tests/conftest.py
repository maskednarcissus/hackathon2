from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from ci_agent.identity import (
    HEADER_DEVICE_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    DeviceIdentity,
    verify_signature,
)

T0 = datetime(2026, 11, 4, 22, 0, tzinfo=UTC)


class Clock:
    def __init__(self, now: datetime = T0) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def identity() -> DeviceIdentity:
    return DeviceIdentity.generate()


@dataclass
class FakeIngestion:
    """Stateful in-memory implementation of the audio-ingestion upload protocol."""

    identity: DeviceIdentity
    device_id: str
    recordings: dict[str, dict[str, Any]] = field(default_factory=dict)
    uploads: dict[str, dict[str, Any]] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    chunk_puts: list[int] = field(default_factory=list)
    fail_chunk_times: dict[int, int] = field(default_factory=dict)
    corrupt_once: bool = False
    down: bool = False

    def _verify(self, request: httpx.Request) -> None:
        assert request.headers[HEADER_DEVICE_ID] == self.device_id
        assert verify_signature(
            self.identity.public_key,
            request.method,
            request.url.raw_path.decode(),
            request.headers[HEADER_TIMESTAMP],
            request.content,
            request.headers[HEADER_SIGNATURE],
        ), "bad device signature"

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("network unreachable", request=request)
        self._verify(request)
        path = request.url.path
        if request.method == "POST" and path == "/v1/recordings":
            body = json.loads(request.content)
            for rid, rec in self.recordings.items():
                if rec["localRecordingId"] == body["localRecordingId"]:
                    return httpx.Response(200, json={"recordingSessionId": rid})
            rid = str(uuid.uuid4())
            self.recordings[rid] = body
            return httpx.Response(201, json={"recordingSessionId": rid})
        if request.method == "POST" and path == "/v1/recording-events":
            self.events.append(json.loads(request.content))
            return httpx.Response(202)
        if request.method == "POST" and path == "/v1/uploads":
            body = json.loads(request.content)
            total = -(-body["totalSizeBytes"] // body["chunkSizeBytes"])
            uid = str(uuid.uuid4())
            self.uploads[uid] = {**body, "totalChunks": total, "chunks": {}, "status": "open"}
            return httpx.Response(
                201, json={"uploadId": uid, "totalChunks": total, "receivedChunks": []}
            )
        m = re.fullmatch(r"/v1/uploads/([^/]+)", path)
        if request.method == "GET" and m:
            up = self.uploads.get(m.group(1))
            if up is None:
                return httpx.Response(404, json={"error": {"code": "not_found"}})
            return httpx.Response(
                200,
                json={
                    "uploadId": m.group(1),
                    "status": up["status"],
                    "totalChunks": up["totalChunks"],
                    "receivedChunks": sorted(up["chunks"]),
                },
            )
        m = re.fullmatch(r"/v1/uploads/([^/]+)/chunks/(\d+)", path)
        if request.method == "PUT" and m:
            index = int(m.group(2))
            if self.fail_chunk_times.get(index, 0) > 0:
                self.fail_chunk_times[index] -= 1
                return httpx.Response(503)
            data = request.content
            assert hashlib.sha256(data).hexdigest() == request.headers["X-Chunk-SHA256"]
            self.chunk_puts.append(index)
            self.uploads[m.group(1)]["chunks"][index] = data
            return httpx.Response(204)
        m = re.fullmatch(r"/v1/uploads/([^/]+)/complete", path)
        if request.method == "POST" and m:
            up = self.uploads[m.group(1)]
            blob = b"".join(up["chunks"][i] for i in sorted(up["chunks"]))
            if self.corrupt_once:
                self.corrupt_once = False
                blob += b"x"
            if hashlib.sha256(blob).hexdigest() != up["checksumSha256"]:
                up["status"] = "failed"
                return httpx.Response(422, json={"error": {"code": "checksum_mismatch"}})
            up["status"] = "complete"
            up["blob"] = blob
            return httpx.Response(200, json={"status": "complete"})
        return httpx.Response(404)
