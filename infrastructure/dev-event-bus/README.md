# Dev Event Bus

Local stand-in for Google Pub/Sub push delivery (integration stage §2). Reads the routing table
`infrastructure/events/subscriptions.yaml` — the same file Terraform uses to create the real
topics and push subscriptions — and delivers each published envelope to every subscriber in
**Pub/Sub push format** (`{ message: { data: base64(envelope), messageId, attributes }, subscription }`).

| Endpoint | Purpose |
|---|---|
| `POST /v1/topics/{type}:publish` | Publish an envelope (`type` must equal the topic). `?wait=true` delivers synchronously and returns the delivery records. |
| `GET /v1/topics` | Routing table with resolved endpoints |
| `GET /v1/deliveries?limit=` | Recent delivery log (status, attempts, last response snippet) |
| `GET /v1/dead-letters` · `DELETE /v1/dead-letters` | Undeliverable messages (retries exhausted, permanent 4xx, or no URL configured) |
| `POST /v1/dead-letters/{deliveryId}/replay` | Re-deliver one dead letter |
| `GET /health` | Liveness |

Delivery: up to `BUS_MAX_ATTEMPTS` (5) with exponential backoff from `BUS_BACKOFF_MS` (200 ms,
capped at 10 s); 4xx other than 408/429 are dead-lettered at once. Subscribers' base URLs come from
`<SERVICE_NAME>_URL` env vars (`audio-processing` → `AUDIO_PROCESSING_URL`).

| Env | Default | |
|---|---|---|
| `PORT` | `8090` | |
| `SUBSCRIPTIONS_FILE` | `../events/subscriptions.yaml` | |
| `INTERNAL_API_TOKEN` | — | required on all endpoints except `/health` when set; also sent to subscribers as `x-internal-token` |
| `BUS_SYNC_DELIVERY` | `false` | answer publishes only after delivery |
| `BUS_ALLOW_UNKNOWN_TOPICS` | `false` | accept topics missing from the routing table |
| `BUS_TIMEOUT_MS` | `120000` | per-attempt subscriber timeout |

```bash
pnpm --filter @ci/dev-event-bus build && (cd infrastructure/dev-event-bus && node dist/index.js)
```

Not for production: state is in memory and delivery is at-least-once only while the process lives.
