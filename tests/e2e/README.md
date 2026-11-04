# End-to-end scenario

`run_e2e.py` drives one class through the whole platform (integration stage §7): organization and
timetable import → identity users and access sync → device provisioning, signed heartbeat and
recording plan → signed chunked upload of a synthetic WAV → processing → transcription →
diarization → lecture structure → extracted exam awaiting review → professor confirmation →
calendar event with provenance → student notification → audit chain → analytics capture coverage.

```bash
pnpm turbo run build --filter='./services/*' --filter=@ci/dev-event-bus
.venv/bin/python tests/e2e/run_e2e.py --local                    # in-memory persistence
.venv/bin/python tests/e2e/run_e2e.py --local \
  --database 'postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433'   # fresh Postgres DB
docker compose -f infrastructure/docker/docker-compose.full.yml up --build -d
.venv/bin/python tests/e2e/run_e2e.py                            # against the compose stack
```

Each step reports `passed`, `failed`, or `workaround` — a workaround means the runner stood in
for an integration that does not exist yet (the detail says which). Independent steps are *soft*:
they record a failure and the scenario continues, so one run surfaces every broken link.
The report is written to `tests/e2e/results/e2e-report.json` and includes dev-bus dead letters
and deliveries that were acknowledged with a failure body.

`services.py` is the single service table (ports, URL env var aliases, extra env). Regenerate the
compose file after changing it:

```bash
.venv/bin/python tests/e2e/services.py --compose
```
