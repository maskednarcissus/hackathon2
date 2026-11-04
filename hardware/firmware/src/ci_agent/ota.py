"""Over-the-air updates (Phase 6 §6.10; device-protocol README §8).

``GET /v1/devices/{id}/firmware-update`` returns, when the device is inside a release's
rollout, a compact **signed manifest**. The agent trusts only the manifest (never the unsigned
convenience fields next to it):

1. Ed25519 signature verified with a release key pinned in the agent config (``keyId``).
2. ``model`` must be this device's model, ``version`` newer than the running one, and the
   running version must satisfy ``minVersion``.
3. The image is streamed to a temporary file with a hard size cap; its SHA-256 and size must
   match the manifest before it is moved into the staging directory with ``pending-update.json``.

Installing is left to the platform installer (``ota_install_command``, e.g. RAUC/SWUpdate),
run only when no class is being recorded. After the reboot into the new version the agent
reports ``installed``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import subprocess
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ci_agent.fsutil import atomic_write_json, read_json

log = logging.getLogger(__name__)

PENDING_FILE = "pending-update.json"


class OtaApi(Protocol):
    def firmware_update(self) -> dict[str, Any]: ...

    def firmware_status(self, release_id: str, state: str, error: str | None = None) -> None: ...


Downloader = Callable[[str], Iterator[bytes]]


class ManifestRejected(Exception):
    pass


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", version))


def newer(a: str, b: str) -> bool:
    return _version_key(a) > _version_key(b)


def load_trusted_keys(value: str) -> dict[str, Ed25519PublicKey]:
    """``{"keyId": "-----BEGIN PUBLIC KEY-----…"}`` as JSON, or a path to such a file."""
    if not value.strip():
        return {}
    text = Path(value).read_text() if not value.lstrip().startswith("{") else value
    keys: dict[str, Ed25519PublicKey] = {}
    for key_id, pem in json.loads(text).items():
        key = serialization.load_pem_public_key(str(pem).replace("\\n", "\n").encode())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError(f"release key {key_id} is not Ed25519")
        keys[str(key_id)] = key
    return keys


def _b64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_manifest(compact: str, trusted: Mapping[str, Ed25519PublicKey]) -> dict[str, Any]:
    parts = compact.split(".")
    if len(parts) != 2:
        raise ManifestRejected("manifest is not a compact signed element")
    encoded, signature = parts
    try:
        manifest: dict[str, Any] = json.loads(_b64url(encoded))
    except ValueError as exc:
        raise ManifestRejected("manifest payload is not JSON") from exc
    key = trusted.get(str(manifest.get("keyId")))
    if key is None:
        raise ManifestRejected(f"untrusted release key {manifest.get('keyId')!r}")
    try:
        key.verify(_b64url(signature), encoded.encode("ascii"))
    except (InvalidSignature, ValueError) as exc:
        raise ManifestRejected("manifest signature is invalid") from exc
    if manifest.get("v") != 1 or not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("sha256"))):
        raise ManifestRejected("manifest fields are invalid")
    return manifest


def http_downloader(timeout_s: float = 60.0) -> Downloader:
    def download(url: str) -> Iterator[bytes]:
        import httpx

        with httpx.stream("GET", url, timeout=timeout_s, follow_redirects=True) as response:
            response.raise_for_status()
            yield from response.iter_bytes(1 << 16)

    return download


@dataclass(frozen=True)
class OtaResult:
    state: str  # up_to_date | rejected | staged | already_staged | failed | installed
    version: str | None = None
    path: Path | None = None
    reason: str | None = None


class OtaClient:
    def __init__(
        self,
        api: OtaApi,
        *,
        model: str,
        current_version: str,
        trusted_keys: Mapping[str, Ed25519PublicKey],
        staging_dir: Path,
        downloader: Downloader | None = None,
        max_bytes: int = 2 * 1024**3,
        install_command: Sequence[str] = (),
        run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.api = api
        self.model = model
        self.current_version = current_version
        self.trusted_keys = trusted_keys
        self.staging_dir = staging_dir
        self.downloader = downloader or http_downloader()
        self.max_bytes = max_bytes
        self.install_command = tuple(install_command)
        self.run = run

    @property
    def pending_path(self) -> Path:
        return self.staging_dir / PENDING_FILE

    def pending(self) -> dict[str, Any] | None:
        if not self.pending_path.exists():
            return None
        data: dict[str, Any] = read_json(self.pending_path)
        return data

    def _report(self, release_id: str, state: str, error: str | None = None) -> None:
        try:
            self.api.firmware_status(release_id, state, error)
        except Exception as exc:  # status is informational; never block the update
            log.warning("could not report firmware status %s: %s", state, exc)

    def confirm_installed(self) -> OtaResult | None:
        """After a reboot: report `installed` once the staged version is running."""
        pending = self.pending()
        if not pending or pending.get("version") != self.current_version:
            return None
        self._report(str(pending["releaseId"]), "installed")
        image = Path(str(pending.get("path", "")))
        image.unlink(missing_ok=True)
        self.pending_path.unlink(missing_ok=True)
        return OtaResult("installed", self.current_version)

    def check_and_stage(self, recording: bool = False) -> OtaResult:
        confirmed = self.confirm_installed()
        if confirmed:
            return confirmed
        offer = self.api.firmware_update()
        if not offer.get("updateAvailable"):
            return OtaResult("up_to_date", self.current_version)
        release_id = str(offer.get("releaseId", ""))
        try:
            manifest = verify_manifest(str(offer.get("manifest", "")), self.trusted_keys)
            version = str(manifest["version"])
            if manifest.get("model") != self.model:
                raise ManifestRejected(f"manifest is for {manifest.get('model')}, not {self.model}")
            if not newer(version, self.current_version):
                raise ManifestRejected(f"{version} is not newer than {self.current_version}")
            minimum = manifest.get("minVersion")
            if minimum and newer(str(minimum), self.current_version):
                raise ManifestRejected(f"requires at least {minimum}")
            size = int(manifest["sizeBytes"])
            if not 0 < size <= self.max_bytes:
                raise ManifestRejected(f"image size {size} outside limits")
        except (ManifestRejected, KeyError, ValueError) as exc:
            log.error("firmware manifest rejected: %s", exc)
            if release_id:
                self._report(release_id, "failed", f"manifest rejected: {exc}")
            return OtaResult("rejected", reason=str(exc))

        pending = self.pending()
        if pending and pending.get("version") == version and Path(str(pending["path"])).exists():
            result = OtaResult("already_staged", version, Path(str(pending["path"])))
        else:
            result = self._download(release_id, manifest, size)
        if result.state in {"staged", "already_staged"} and result.path and self.install_command:
            if recording:
                log.info(
                    "firmware %s staged; installation waits until no class is recorded", version
                )
            else:
                return self._install(release_id, version, result.path)
        return result

    def _download(self, release_id: str, manifest: dict[str, Any], size: int) -> OtaResult:
        version = str(manifest["version"])
        self.staging_dir.mkdir(parents=True, exist_ok=True)
        final = self.staging_dir / f"{self.model}-{version}.img"
        tmp = self.staging_dir / f".{final.name}.part"
        self._report(release_id, "downloading")
        digest = hashlib.sha256()
        received = 0
        try:
            with tmp.open("wb") as fh:
                for chunk in self.downloader(str(manifest["url"])):
                    received += len(chunk)
                    if received > size:
                        raise ManifestRejected(f"image larger than the signed size {size}")
                    digest.update(chunk)
                    fh.write(chunk)
                fh.flush()
                os.fsync(fh.fileno())
            if received != size:
                raise ManifestRejected(f"image size {received} != signed size {size}")
            if digest.hexdigest() != manifest["sha256"]:
                raise ManifestRejected("image sha256 does not match the signed manifest")
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            log.error("firmware download failed: %s", exc)
            self._report(release_id, "failed", str(exc)[:500])
            return OtaResult("failed", version, reason=str(exc))
        os.replace(tmp, final)
        atomic_write_json(
            self.pending_path,
            {"releaseId": release_id, "version": version, "path": str(final), "manifest": manifest},
            mode=0o600,
        )
        self._report(release_id, "staged")
        log.info("firmware %s staged at %s", version, final)
        return OtaResult("staged", version, final)

    def _install(self, release_id: str, version: str, image: Path) -> OtaResult:
        argv = [a.replace("{path}", str(image)) for a in self.install_command]
        try:
            done = self.run(argv, capture_output=True, text=True, timeout=1800, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            self._report(release_id, "failed", f"installer: {exc}")
            return OtaResult("failed", version, image, str(exc))
        if done.returncode != 0:
            error = f"installer exited {done.returncode}: {done.stderr.strip()[-300:]}"
            self._report(release_id, "failed", error)
            return OtaResult("failed", version, image, error)
        # `installed` is reported after the reboot, when the new version is running.
        return OtaResult("staged", version, image, "installer completed; reboot pending")
