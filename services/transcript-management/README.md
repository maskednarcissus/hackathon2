# Transcript Management Service

Stores transcripts and timestamped segments (Phase 1 deliverable 1.11). Port `4008`.

## Responsibilities

- Transcript and segment storage with timestamps, confidence and word timings (contract §8)
- Validation: contiguous `segmentIndex` from 0, ordered and non-overlapping segments, confidence in `[0, 1]`,
  words inside their segment, speaker labels restricted to anonymous `SPEAKER_<n>` (LGPD — no identities)
- One transcript per `(recordingSessionId, processingVersion)` (`409` on duplicates; reprocessing uses a new version)
- Diarization results (speaker labels) applied atomically
- Quality stats: duration, speech time, duration-weighted average confidence, low-confidence segment count (< 0.6)
- Plain-text export with `[hh:mm:ss]` stamps

## API

| Method | Path                                  | Notes                                                                                                                            |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/transcripts`                     | `{recordingSessionId, scheduledClassId?, language='pt-BR', processingVersion, provider, model, segments[]}` → `201` with `stats` |
| `GET`  | `/v1/transcripts?recordingSessionId=` | transcripts of a recording (all processing versions)                                                                             |
| `GET`  | `/v1/transcripts/:id`                 | transcript + `stats`                                                                                                             |
| `GET`  | `/v1/transcripts/:id/segments`        | `fromMs`, `toMs` (overlap window), `cursor` (segmentIndex), `limit` ≤ 1000, `includeWords` → `{items, nextCursor}`               |
| `PUT`  | `/v1/transcripts/:id/speakers`        | `{speakerCount, assignments: [{segmentIndex, speakerLabel}]}`; `400` for non-anonymous labels, `422 unknown_segment`             |
| `GET`  | `/v1/transcripts/:id/export.txt`      | `text/plain`, one line per segment: `[00:01:05] SPEAKER_1: …`                                                                    |

Request body limit is 64 MiB (a 90-minute lecture with word timings is ~5–10 MiB).

## Planned (Phase 2)

Segment corrections with original text preserved (2.18/2.19), full-text search.

## Technology

TypeScript · Fastify · Zod · PostgreSQL
