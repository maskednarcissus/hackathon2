"""PostgreSQL repository for processing results (integration stage §1).

Tables: ``processed_events`` (consumer ``audio-processing``), ``audio_quality_reports``,
``audio_segments`` and ``recording_sessions.audio_quality_score``. :meth:`save` writes all
of them in one transaction, guarded by the ``processed_events`` primary key so concurrent
deliveries of the same event store exactly one result.
"""

from __future__ import annotations

import uuid
from typing import Any

import psycopg
from psycopg import errors
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from audio_processing.ports import UnknownRecordingError
from audio_processing.quality import QualityReport
from audio_processing.results import PipelineResult
from audio_processing.segmentation import Segment

CONSUMER = "audio-processing"

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


class PostgresProcessingRepository:
    def __init__(self, pool: Pool) -> None:
        self._pool = pool

    def is_processed(self, event_id: str) -> bool:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM processed_events WHERE event_id = %s AND consumer = %s",
                (event_id, CONSUMER),
            ).fetchone()
        return row is not None

    def load_result(self, recording_session_id: str) -> PipelineResult | None:
        if not _is_uuid(recording_session_id):
            return None
        with self._pool.connection() as conn:
            report = conn.execute(
                """SELECT duration_ms, sample_rate, channels, rms_dbfs, peak_dbfs,
                          noise_floor_dbfs, snr_db, clipping_ratio, silence_ratio,
                          longest_silence_ms, score, verdict::text AS verdict, issues
                   FROM audio_quality_reports WHERE recording_session_id = %s
                   ORDER BY assessed_at DESC LIMIT 1""",
                (recording_session_id,),
            ).fetchone()
            if report is None:
                return None
            segments = conn.execute(
                """SELECT segment_index, start_ms, end_ms, storage_path, file_size_bytes,
                          checksum_sha256
                   FROM audio_segments WHERE recording_session_id = %s
                   ORDER BY segment_index""",
                (recording_session_id,),
            ).fetchall()
        quality = QualityReport(
            duration_ms=report["duration_ms"],
            sample_rate=report["sample_rate"],
            channels=report["channels"],
            rms_dbfs=float(report["rms_dbfs"]),
            peak_dbfs=float(report["peak_dbfs"]),
            noise_floor_dbfs=float(report["noise_floor_dbfs"]),
            snr_db=float(report["snr_db"]),
            clipping_ratio=float(report["clipping_ratio"]),
            silence_ratio=float(report["silence_ratio"]),
            longest_silence_ms=report["longest_silence_ms"],
            score=float(report["score"]),
            verdict=report["verdict"],
            issues=list(report["issues"]),
        )
        return PipelineResult(
            recording_session_id=recording_session_id,
            status="stopped_unusable" if quality.verdict == "unusable" else "segmented",
            report=quality,
            segments=[
                Segment(
                    index=row["segment_index"],
                    start_ms=row["start_ms"],
                    end_ms=row["end_ms"],
                    storage_uri=row["storage_path"],
                    size_bytes=row["file_size_bytes"],
                    checksum_sha256=row["checksum_sha256"],
                )
                for row in segments
            ],
        )

    def save(self, event_id: str, result: PipelineResult) -> bool:
        report = result.report
        assert report is not None
        try:
            with self._pool.connection() as conn, conn.transaction():
                claimed = conn.execute(
                    """INSERT INTO processed_events (event_id, consumer) VALUES (%s, %s)
                       ON CONFLICT (event_id, consumer) DO NOTHING RETURNING event_id""",
                    (event_id, CONSUMER),
                ).fetchone()
                if claimed is None:
                    return False
                self._insert_report(conn, result.recording_session_id, report)
                self._replace_segments(conn, result.recording_session_id, result.segments)
                conn.execute(
                    "UPDATE recording_sessions SET audio_quality_score = %s WHERE id = %s",
                    (report.score, result.recording_session_id),
                )
        except errors.ForeignKeyViolation as exc:
            raise UnknownRecordingError(
                f"recording session {result.recording_session_id} does not exist"
            ) from exc
        return True

    @staticmethod
    def _insert_report(
        conn: psycopg.Connection[DictRow], recording_id: str, report: QualityReport
    ) -> None:
        conn.execute(
            """INSERT INTO audio_quality_reports (
                   recording_session_id, duration_ms, sample_rate, channels, rms_dbfs,
                   peak_dbfs, noise_floor_dbfs, snr_db, clipping_ratio, silence_ratio,
                   longest_silence_ms, score, verdict, issues)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                recording_id,
                report.duration_ms,
                report.sample_rate,
                report.channels,
                report.rms_dbfs,
                report.peak_dbfs,
                report.noise_floor_dbfs,
                report.snr_db,
                report.clipping_ratio,
                report.silence_ratio,
                report.longest_silence_ms,
                report.score,
                report.verdict,
                list(report.issues),
            ),
        )

    @staticmethod
    def _replace_segments(
        conn: psycopg.Connection[DictRow], recording_id: str, segments: list[Segment]
    ) -> None:
        params: list[tuple[Any, ...]] = [
            (
                recording_id,
                s.index,
                s.start_ms,
                s.end_ms,
                s.storage_uri,
                s.size_bytes,
                s.checksum_sha256,
            )
            for s in segments
        ]
        with conn.cursor() as cur:
            if params:
                cur.executemany(
                    """INSERT INTO audio_segments (
                           recording_session_id, segment_index, start_ms, end_ms, storage_path,
                           file_size_bytes, checksum_sha256, upload_status)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 'complete')
                       ON CONFLICT (recording_session_id, segment_index) DO UPDATE SET
                           start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms,
                           storage_path = EXCLUDED.storage_path,
                           file_size_bytes = EXCLUDED.file_size_bytes,
                           checksum_sha256 = EXCLUDED.checksum_sha256,
                           upload_status = 'complete'""",
                    params,
                )
            # Re-processing with fewer segments must not leave stale rows behind.
            cur.execute(
                """DELETE FROM audio_segments
                   WHERE recording_session_id = %s AND segment_index >= %s""",
                (recording_id, len(segments)),
            )
