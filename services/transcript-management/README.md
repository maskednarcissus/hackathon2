# Transcript Management Service

Stores transcripts and timestamped segments (1.11), versioned professor corrections (2.18, 2.19) and
hybrid lecture search (3.6). Port `4008`.

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

| `POST` | `/v1/transcript## Corrections (phase-2 contract §7)

- Each correction is an immutable version row (`version` 1..n, `previousText`, `correctedText`, `correctedBy`,
  `correctedByRole`, `reason`). The segment keeps `originalText` (never mutated), `text` = latest version,
  `correctionStatus: corrected`. Machine word timings stay attached to the original text.
- Authorization until identity tokens are wired: `X-Actor-Role: admin`, or `professor` whose `X-Actor-Id`
  equals the professor of the transcript's scheduled class (resolved via academic-integration
  `GET /v1/scheduled-classes/:id`; `502 academic_unavailable` if unreachable). Students/coordinators → `403`.
  `correctedBy`, when sent, must equal `X-Actor-Id`. Identical text → `422 no_change`; concurrent edits → `409`.
- Side effects: audit `transcript.corrected`, event `transcript.corrected {transcriptId, segmentIndex, version, …}`
  (re-extraction downstream), search index updated with the corrected text.

## Search (phase-3 contract §3)

- **Lexical:** BM25 (k1 = 1.2, b = 0.75) over pt-BR terms — accent folding, lowercase, stopwords, light
  stemmer for plural/gender/derivational suffixes (`src/search/text.ts`).
- **Semantic:** cosine over embeddings from `EmbeddingClient` — `HttpEmbeddingClient` (ai-gateway
  `POST /v1/embed`, `EMBEDDINGS_PROVIDER=gateway`) or `FakeEmbeddingClient` (deterministic hashed
  bag-of-words, 256 dims; default in dev and tests). Minimum cosine 0.1.
- **Hybrid:** reciprocal-rank fusion (k = 60) of the top 100 of each. If query embedding fails, hybrid falls
  back to lexical with `degraded: true`; `mode=semantic` answers `502 embeddings_unavailable`.
- **Access scoping:** `classSectionIds` is mandatory and filters candidates _before_ ranking; transcripts without
  `classSectionId` are never indexed. The newest processing version of a recording replaces older ones.
- `highlight` is HTML-escaped text with matches in `<mark>`, windowed to ~280 characters.
- The index is in memory (rebuilt from storage on start in production; pgvector / a search engine later).

## Configuration

`PORT` (4008), `ACADEMIC_INTEGRATION_URL` (http://localhost:4003), `AUDIT_SERVICE_URL` (http://localhost:4011),
`EMBEDDINGS_PROVIDER` (`fake` | `gateway`), `AI_GATEWAY_URL` (http://localhost:8005).

ectedBy?, reason?}`→`201 {correction, segment}`|
|`GET`|`/v1/transcripts/:id/segments/:segmentIndex/corrections`|`{currentVersion, originalText, versions: [{version, text, source: machine\|professor\|admin, …}]}`|
|`GET`|`/v1/transcripts/:id/corrections`| all corrections of a transcript |
|`GET`|`/v1/search?q&classSectionIds=a,b&limit≤50&mode=hybrid\|lexical\|semantic`|`{results: [{transcriptId, scheduledClassId, classSectionId, segmentIndex, startMs, endMs, text, highlight, score, speakerLabel?}], mode, degraded}` |

Request body limit is 64 MiB (a 90-minute lecture with word timings is ~5–10 MiB).

## Planned (Phase 2)

Segment corrections with original text preserved (2.18/2.19), full-text search.

## Technology

TypeScript · Fastify · Zod · PostgreSQL
