# Device Provisioning

How a capture device goes from the box to recording classes.

## Roles

- **Institution administrator** — creates the provisioning token and assigns the device to a classroom.
- **Installer** — mounts the device, connects network, runs registration.

## Procedure

1. **Create a provisioning token** (admin workstation):

   ```bash
   python3 hardware/provisioning/scripts/provision.py \
     --device-management-url https://devices.ci.example.com \
     --admin-token "$CI_ADMIN_TOKEN" \
     --serial CI-A1-000123 \
     --institution-id 7d5c…  \
     --ingestion-url https://ingest.ci.example.com \
     --out ./CI-A1-000123.toml
   ```

   This calls `POST /v1/provisioning-tokens` `{ serialNumber, institutionId, expiresInHours }`
   and writes a ready-to-install `config.toml`. The token is printed once; it is single-use,
   bound to the serial number and expires (default 72 h). Treat it as a secret.

2. **Install the agent** on the device (see [`../firmware/README.md`](../firmware/README.md))
   and copy the generated config to `/etc/ci-agent/config.toml`.

3. **Register** (on the device):

   ```bash
   sudo -u ci-agent /opt/ci-agent/venv/bin/ci-agent register --token pt_…
   ```

   The device generates its Ed25519 key locally (never leaves the device), sends the public
   key and receives its device certificate.

4. **Assign to a classroom** in the administration console or via
   `POST /v1/devices/{deviceId}/assignments` `{ classroomId }` (device-management). Until
   assigned the device has no recording plan and stays idle.

5. **Start** `sudo systemctl enable --now ci-agent` and verify in
   _Administração → Dispositivos_ that the device is `online` with a recent heartbeat.

6. **Acoustic check** — run a 2-minute test recording (`ci-agent run --fake-audio` is _not_
   a substitute) and confirm the audio-quality report verdict is `good` or `acceptable`.

## Re-provisioning / replacement

- A compromised or replaced device must be revoked: `POST /v1/devices/{id}/revoke`.
- Re-registering the same unit requires a new token and `ci-agent register --force`
  (the existing key is reused unless `identity/device.key` is deleted).
