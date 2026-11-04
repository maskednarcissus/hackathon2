"""PostgreSQL repositories (integration stage §1).

Tables: ``recording_sessions`` (V001/V002/V004 + pending ``audio_deleted_at``),
``upload_sessions``, ``upload_chunks`` (V002) and ``audio_segments`` (rows removed on
retention). Invariants that span rows run in one transaction:

* chunk idempotency — the ``(upload_session_id, chunk_index)`` primary key arbitrates;
* one open upload per recording — partial unique index ``uq_upload_sessions_open``;
* upload completion / failure — upload and recording rows change together, under
  ``SELECT … FOR UPDATE`` on the upload;
* retention — recording marked, upload and segment rows deleted together.

The service layer is synchronous (it runs in FastAPI's threadpool next to file I/O), so
this adapter uses ``psycopg_pool.ConnectionPool``.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import psycopg
from psycopg import errors
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from audio_ingestion.models import RecordingSession, UploadSession
from audio_ingestion.ports import ConcurrentUpdateError, RetentionCandidate, UnknownReferenceError

RETENTION_BATCH_LIMIT = 5000

_RECORDING_COLUMNS = """
    id::text, device_id::text, classroom_id::text, institution_id::text,
    scheduled_class_id::text, recording_policy_id::text, started_at, ended_at, duration_ms,
    audio_format, sample_rate, channels, file_size_bytes, checksum_sha256, firmware_version,
    local_recording_id, upload_status::text, storage_path, audio_deleted_at, created_at
"""

_UPLOAD_COLUMNS = """
    id::text, recording_session_id::text, device_id::text, total_size_bytes, checksum_sha256,
    chunk_size_bytes, total_chunks, status::text, failure_reason, created_at, completed_at
"""


Pool = ConnectionPool[psycopg.Connection[DictRow]]


def create_pool(database_url: str, min_size: int = 1, max_size: int = 10) -> Pool:
    return ConnectionPool(
        database_url,
        connection_class=psycopg.Connection[DictRow],
        min_size=min_size,
        max_size=max_size,
        kwargs={"row_factory": dict_row},
        open=True,
    )


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _recording(row: dict[str, Any]) -> RecordingSession:
    return RecordingSession(
        id=row["id"],
        device_id=row["device_id"],
        classroom_id=row["classroom_id"],
        institution_id=row["institution_id"],
        scheduled_class_id=row["scheduled_class_id"],
        recording_policy_id=row["recording_policy_id"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        duration_ms=row["duration_ms"],
        audio_format=row["audio_format"],
        sample_rate=row["sample_rate"],
        channels=row["channels"],
        file_size_bytes=row["file_size_bytes"],
        checksum_sha256=row["checksum_sha256"],
        firmware_version=row["firmware_version"],
        local_recording_id=row["local_recording_id"],
        upload_status=row["upload_status"],
        storage_uri=row["storage_path"],
        audio_deleted_at=row["audio_deleted_at"],
        created_at=row["created_at"],
    )


class PostgresRecordingRepository:
    def __init__(self, pool: Pool) -> None:
        self._pool = pool

    def add(self, recording: RecordingSession) -> None:
        try:
            with self._pool.connection() as conn:
                conn.execute(
                    """
                    INSERT INTO recording_sessions (
                        id, device_id, classroom_id, institution_id, scheduled_class_id,
                        recording_policy_id, started_at, ended_at, duration_ms, duration_seconds,
                        audio_format, sample_rate, channels, file_size_bytes, checksum_sha256,
                        firmware_version, local_recording_id, upload_status, capture_status,
                        storage_path, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, 'complete', %s, %s)
                    """,
                    (
                        recording.id,
                        recording.device_id,
                        recording.classroom_id,
                        recording.institution_id,
                        recording.scheduled_class_id,
                        recording.recording_policy_id,
                        recording.started_at,
                        recording.ended_at,
                        recording.duration_ms,
                        recording.duration_ms // 1000,
                        recording.audio_format,
                        recording.sample_rate,
                        recording.channels,
                        recording.file_size_bytes,
                        recording.checksum_sha256,
                        recording.firmware_version,
                        recording.local_recording_id,
                        recording.upload_status,
                        recording.storage_uri,
                        recording.created_at,
                    ),
                )
        except errors.UniqueViolation as exc:
            raise ConcurrentUpdateError(str(exc)) from exc
        except errors.ForeignKeyViolation as exc:
            raise UnknownReferenceError(
                "device, classroom, institution or scheduled class is not registered"
            ) from exc

    def get(self, recording_id: str) -> RecordingSession | None:
        if not _is_uuid(recording_id):
            return None
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {_RECORDING_COLUMNS} FROM recording_sessions WHERE id = %s",  # noqa: S608
                (recording_id,),
            ).fetchone()
        return _recording(row) if row else None

    def find_by_local_id(self, device_id: str, local_recording_id: str) -> RecordingSession | None:
        if not _is_uuid(device_id):
            return None
        with self._pool.connection() as conn:
            row = conn.execute(
                f"""SELECT {_RECORDING_COLUMNS} FROM recording_sessions
                    WHERE device_id = %s AND local_recording_id = %s""",  # noqa: S608
                (device_id, local_recording_id),
            ).fetchone()
        return _recording(row) if row else None

    def update(self, recording: RecordingSession) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """UPDATE recording_sessions SET upload_status = %s, storage_path = %s
                   WHERE id = %s""",
                (recording.upload_status, recording.storage_uri, recording.id),
            )

    def retention_candidates(
        self, institution_id: str, older_than: datetime
    ) -> list[RetentionCandidate]:
        if not _is_uuid(institution_id):
            return []
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT r.id::text AS id, r.created_at, r.recording_policy_id::text AS policy_id,
                       sc.class_section_id::text AS class_section_id
                FROM recording_sessions r
                LEFT JOIN scheduled_classes sc ON sc.id = r.scheduled_class_id
                WHERE r.institution_id = %s
                  AND r.storage_path IS NOT NULL
                  AND r.audio_deleted_at IS NULL
                  AND r.created_at < %s
                ORDER BY r.created_at
                LIMIT %s
                """,
                (institution_id, older_than, RETENTION_BATCH_LIMIT),
            ).fetchall()
        return [
            RetentionCandidate(
                id=row["id"],
                created_at=row["created_at"],
                recording_session_id=row["id"],
                class_section_id=row["class_section_id"],
                recording_policy_id=row["policy_id"],
            )
            for row in rows
        ]

    def delete_audio(self, recording_id: str, deleted_at: datetime) -> RecordingSession | None:
        if not _is_uuid(recording_id):
            return None
        with self._pool.connection() as conn, conn.transaction():
            row = conn.execute(
                f"SELECT {_RECORDING_COLUMNS} FROM recording_sessions "  # noqa: S608
                "WHERE id = %s FOR UPDATE",
                (recording_id,),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """UPDATE recording_sessions
                   SET audio_deleted_at = COALESCE(audio_deleted_at, %s), storage_path = NULL
                   WHERE id = %s""",
                (deleted_at, recording_id),
            )
            conn.execute(
                "DELETE FROM upload_sessions WHERE recording_session_id = %s", (recording_id,)
            )
            conn.execute(
                "DELETE FROM audio_segments WHERE recording_session_id = %s", (recording_id,)
            )
        return _recording(row)


class PostgresUploadRepository:
    def __init__(self, pool: Pool) -> None:
        self._pool = pool

    @staticmethod
    def _upload(conn: psycopg.Connection[DictRow], row: dict[str, Any]) -> UploadSession:
        chunks = conn.execute(
            "SELECT chunk_index, checksum_sha256 FROM upload_chunks WHERE upload_session_id = %s",
            (row["id"],),
        ).fetchall()
        return UploadSession(
            upload_id=row["id"],
            recording_session_id=row["recording_session_id"],
            device_id=row["device_id"],
            total_size_bytes=row["total_size_bytes"],
            checksum_sha256=row["checksum_sha256"],
            chunk_size_bytes=row["chunk_size_bytes"],
            total_chunks=row["total_chunks"],
            chunk_checksums={c["chunk_index"]: c["checksum_sha256"] for c in chunks},
            status=row["status"],
            failure_reason=row["failure_reason"],
            created_at=row["created_at"],
            completed_at=row["completed_at"],
        )

    def _one(self, where: str, params: tuple[Any, ...]) -> UploadSession | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                # ``where`` is one of the literal clauses below, never user input.
                f"SELECT {_UPLOAD_COLUMNS} FROM upload_sessions WHERE {where} "  # noqa: S608
                "ORDER BY created_at DESC LIMIT 1",
                params,
            ).fetchone()
            return self._upload(conn, row) if row else None

    def add(self, upload: UploadSession) -> None:
        try:
            with self._pool.connection() as conn:
                conn.execute(
                    """
                    INSERT INTO upload_sessions (
                        id, recording_session_id, device_id, total_size_bytes, checksum_sha256,
                        chunk_size_bytes, total_chunks, status, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        upload.upload_id,
                        upload.recording_session_id,
                        upload.device_id,
                        upload.total_size_bytes,
                        upload.checksum_sha256,
                        upload.chunk_size_bytes,
                        upload.total_chunks,
                        upload.status,
                        upload.created_at,
                    ),
                )
        except errors.UniqueViolation as exc:
            raise ConcurrentUpdateError(str(exc)) from exc

    def get(self, upload_id: str) -> UploadSession | None:
        if not _is_uuid(upload_id):
            return None
        return self._one("id = %s", (upload_id,))

    def find_open_for_recording(self, recording_session_id: str) -> UploadSession | None:
        return self._one(
            "recording_session_id = %s AND status IN ('pending', 'uploading')",
            (recording_session_id,),
        )

    def find_complete_for_recording(self, recording_session_id: str) -> UploadSession | None:
        return self._one(
            "recording_session_id = %s AND status = 'complete'", (recording_session_id,)
        )

    def update(self, upload: UploadSession) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """UPDATE upload_sessions SET status = %s, failure_reason = %s, completed_at = %s
                   WHERE id = %s""",
                (upload.status, upload.failure_reason, upload.completed_at, upload.upload_id),
            )

    def add_chunk(self, upload_id: str, index: int, checksum_sha256: str, size: int) -> str | None:
        with self._pool.connection() as conn, conn.transaction():
            inserted = conn.execute(
                """INSERT INTO upload_chunks (upload_session_id, chunk_index, checksum_sha256,
                                              size_bytes)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (upload_session_id, chunk_index) DO NOTHING
                   RETURNING chunk_index""",
                (upload_id, index, checksum_sha256, size),
            ).fetchone()
            if inserted is None:
                row = conn.execute(
                    """SELECT checksum_sha256 FROM upload_chunks
                       WHERE upload_session_id = %s AND chunk_index = %s""",
                    (upload_id, index),
                ).fetchone()
                assert row is not None
                return str(row["checksum_sha256"])
            conn.execute(
                "UPDATE upload_sessions SET status = 'uploading' "
                "WHERE id = %s AND status = 'pending'",
                (upload_id,),
            )
        return None

    def finalize(self, upload: UploadSession, recording: RecordingSession) -> bool:
        with self._pool.connection() as conn, conn.transaction():
            row = conn.execute(
                "SELECT status::text AS status FROM upload_sessions WHERE id = %s FOR UPDATE",
                (upload.upload_id,),
            ).fetchone()
            if row is None or row["status"] not in ("pending", "uploading"):
                return False
            conn.execute(
                """UPDATE upload_sessions SET status = 'complete', completed_at = %s
                   WHERE id = %s""",
                (upload.completed_at, upload.upload_id),
            )
            conn.execute(
                """UPDATE recording_sessions SET upload_status = 'complete', storage_path = %s
                   WHERE id = %s""",
                (recording.storage_uri, recording.id),
            )
        return True

    def fail(self, upload: UploadSession, recording: RecordingSession) -> None:
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                """UPDATE upload_sessions SET status = 'failed', failure_reason = %s
                   WHERE id = %s AND status IN ('pending', 'uploading')""",
                (upload.failure_reason, upload.upload_id),
            )
            conn.execute(
                "UPDATE recording_sessions SET upload_status = 'failed' WHERE id = %s",
                (recording.id,),
            )
