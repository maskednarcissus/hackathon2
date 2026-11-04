# Firmware — `ci-agent` (capture device agent)

Python 3.12 agent that runs on the classroom capture device (Linux SBC with an ALSA
microphone array). It implements the device side of Phase 1:

| Deliverable                                                        | Module                     |
| ------------------------------------------------------------------ | -------------------------- |
| 1.3 Hardware identity — Ed25519 key, registration, signed requests | `identity.py`, `api.py`    |
| 1.4 Scheduled, policy-driven recording start/stop                  | `scheduler.py`, `agent.py` |
| 1.6 Local audio buffer with automatic upload recovery              | `spool.py`, `uploader.py`  |
| Capture (ALSA `arecord`, s16le 16 kHz mono)                        | `recorder.py`, `wav.py`    |
| Health heartbeat                                                   | `heartbeat.py`             |
| 4.7 Remote commands (reboot, self-test, upload, plan, logs)        | `commands.py`, `agent.py`  |

Protocol: [`../device-protocol/README.md`](../device-protocol/README.md) ·
Contract: [`docs/architecture/phase-1-capture-pipeline.md`](../../docs/architecture/phase-1-capture-pipeline.md).

## How it works

```
every 1 s   reconcile: desired_state(plan, now) → start / stop / rotate recorder
every 5 min refresh recording plan (cached on disk; offline → keep using the cache)
every 60 s  heartbeat (disk, temperature, uptime, queue, recording state, clock skew)
every 30 s  upload pending recordings (chunked, resumable), purge + enforce quota
every 1 s   run queued remote commands (one at a time) and retry unreported results
```

- **Never records outside a plan window**; windows with `recordingEnabled=false` force idle.
- Overlapping windows: the most recently started window wins, so each file maps to one class.
- Audio is streamed to `<id>.pcm` (fsync every 1 MiB) and wrapped into a WAV with its
  SHA-256 at stop. After a crash/power loss the partial PCM is finalized on next start
  (`recovered: true`).
- Recordings are only marked `uploaded` after `POST /v1/uploads/{id}/complete` succeeds.
  Interrupted uploads resume from `GET /v1/uploads/{id}` (only missing chunks are re-sent).
- Disk quota: above the soft limit uploaded files are deleted; un-uploaded audio is evicted
  (oldest first, never the live capture) only above the hard limit, with an incident that
  is logged and reported as `evictedRecordings` in heartbeats.

## Remote commands (phase 4.7)

Administrators queue commands in device-management (`POST /v1/devices/{id}/commands`); they
arrive in the next heartbeat response and the result is reported, signed, to
`POST /v1/devices/{id}/commands/{commandId}/result`.

| Command        | What the agent does                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reboot`       | finalizes the live recording, then runs `reboot_command` (default `systemctl reboot`)                                                                                                                          |
| `self_test`    | 2 s microphone capture (level/peak/clipping), disk free + writable, clock skew, network reachability of both cloud services; `failed` if any check fails. Skips the microphone while a class is being recorded |
| `upload_now`   | immediate upload cycle (never overlaps the periodic one)                                                                                                                                                       |
| `refresh_plan` | forced recording-plan refresh                                                                                                                                                                                  |
| `rotate_logs`  | rolls over rotating file logs (`log_file`) and runs `rotate_logs_command` if set                                                                                                                               |

- One command at a time; others wait in order. Expired commands (`expiresAt`) are ignored.
- Each command id runs once: ids are remembered in `commands.json`, so re-deliveries of an
  unanswered command (the server repeats them until it gets a result) are not re-run.
- Results go to a persistent outbox and are retried until accepted (`404`/`409` = drop).
- A command is marked in-progress on disk _before_ it runs. After a reboot the agent reports
  `reboot` as succeeded instead of rebooting again; any other interrupted command is reported failed.
- `systemctl reboot` from the unprivileged service needs the polkit rule in
  `deploy/50-ci-agent.rules` (install step below).

## Install (on the device)

```bash
sudo apt-get install -y python3.12-venv alsa-utils
sudo useradd --system --groups audio --home /var/lib/ci-agent ci-agent
sudo python3.12 -m venv /opt/ci-agent/venv
sudo /opt/ci-agent/venv/bin/pip install ./hardware/firmware
sudo install -D -m 0644 deploy/config.example.toml /etc/ci-agent/config.toml   # edit serial + URLs
sudo -u ci-agent /opt/ci-agent/venv/bin/ci-agent register --token pt_XXXX
sudo install -m 0644 deploy/50-ci-agent.rules /etc/polkit-1/rules.d/   # remote reboot
sudo install -m 0644 deploy/ci-agent.service /etc/systemd/system/
sudo systemctl enable --now ci-agent
```

Provisioning tokens are created by an administrator — see
[`../provisioning/README.md`](../provisioning/README.md).

## CLI

| Command                            | Purpose                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| `ci-agent init`                    | create the key pair (idempotent) and print its fingerprint  |
| `ci-agent register --token <pt_…>` | register; stores `identity/registration.json` (0600)        |
| `ci-agent run [--fake-audio]`      | run the agent (`--fake-audio` = 440 Hz tone, no microphone) |
| `ci-agent status`                  | queue size, evictions, plan age, orphan files               |

## Development

```bash
cd hardware/firmware
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
```

Local end-to-end run against dev services:

```bash
CI_AGENT_DATA_DIR=/tmp/ci-agent CI_AGENT_SERIAL_NUMBER=DEV-0001 ci-agent register --token pt_dev
CI_AGENT_DATA_DIR=/tmp/ci-agent ci-agent run --fake-audio
```
