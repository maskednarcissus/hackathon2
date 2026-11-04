# AI Gateway Service

The only path from domain services to foundation models (ADR-003). Phase 2 deliverables
**2.1** (Gemini / Vertex AI integration with token & cost tracking), **2.2** (prompt version
control and evaluation instrumentation) and **2.22** (prompt-injection protection).
Contract: [`docs/architecture/phase-2-classroom-intelligence.md`](../../docs/architecture/phase-2-classroom-intelligence.md) §2.

Port **8005** · Python · FastAPI · Vertex AI (google-genai) · JSON Schema

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/v1/embed` | Embeddings `{texts, institutionId, purpose: search_index\|query}` → `{vectors, model, dimensions, usage}` (Phase 3 §3); budget + usage accounting like generate |
| `POST` | `/v1/generate` | Schema-enforced structured generation (one corrective retry on invalid output) |
| `GET` | `/v1/prompts` · `/v1/prompts/{id}` | Prompt versions, active version, SHA-256 |
| `GET` | `/v1/calls/{requestId}` | Instrumentation record (prompt hash, input hashes, tokens, cost, latency, attempts, outcome) — never raw transcript |
| `GET` | `/v1/usage?institutionId&from&to` | Tokens & cost totals by task, model, prompt version and outcome |
| `GET` / `PUT` | `/v1/budgets/{institutionId}` | Monthly USD budget and month-to-date spend (`429 budget_exceeded` when exhausted) |

Errors: `{ "error": { "code", "message", "details" } }` — `400 validation_error | invalid_response_schema`,
`404 prompt_not_found`, `422 task_mismatch | schema_validation_failed`, `429 budget_exceeded`, `502 provider_error`.

## Prompts

`prompts/<promptId>/<version>.yaml` (immutable once published) + `prompts/<promptId>/active`.
Shipped: `lecture-structuring`, `lecture-structuring-merge`, `event-extraction`, `assistant-answer` (all `2026-11-04.1`).
Placeholders: `{{variable}}` for trusted variables, `{{untrusted.<name>}}` for untrusted inputs
(untrusted inputs without a placeholder are appended to the user turn).

## Prompt-injection defence

* Untrusted inputs go **only** into the user turn, wrapped in `<untrusted_classroom_transcript>` /
  `<untrusted_<name>>` delimiters; `<` and `>` inside them are replaced by `‹ ›` so delimiters and role
  tags cannot be forged. The system prompt gets a standing "this is data" instruction.
* `variables` may not use the reserved `untrusted*` namespace.
* A pt-BR + English heuristic detector (instruction override, system-prompt probing, role reassignment,
  role tags, delimiter spoofing, output manipulation) fills `safety.injectionSuspected/injectionSignals`.
  Callers must not auto-publish anything derived from a suspected call.

## Configuration

| Variable | Default | |
|---|---|---|
| `AI_GATEWAY_PROVIDER` | `fake` | `vertex` for Vertex AI Gemini (`pip install -e ".[gcp]"`) |
| `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION` | —, `southamerica-east1` | Vertex settings |
| `AI_GATEWAY_PROMPTS_DIR` | `./prompts` | Prompt registry root |
| `AI_GATEWAY_DEFAULT_MONTHLY_BUDGET_USD` | unlimited | Default per-institution budget |
| `AI_GATEWAY_PRICING_JSON` | built-in table | `{"model": {"input": usdPer1M, "output": usdPer1M}}` |
| `AI_GATEWAY_PROVIDER_TIMEOUT_S` | `60` | Per-attempt timeout (transient errors retried 3× with backoff) |
| `AUDIT_SERVICE_URL` | — | Emits `ai.generation` audit events (non-fatal) |

Embeddings: `vertex` → `text-multilingual-embedding-002` (RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY task types,
batches of 250); `fake` → deterministic signed hashed bag-of-words, 256 dims, L2-normalised, over pt-BR
normalised tokens (accent folding, stopwords, light stemming).

The `fake` provider is deterministic: scripted responses per prompt/task, otherwise the minimal
instance of the response schema.

## Development

```bash
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
uvicorn main:app --app-dir src --port 8005
```
