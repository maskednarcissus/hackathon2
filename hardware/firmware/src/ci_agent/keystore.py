"""Device key storage abstraction (Phase 6 §6.10).

* ``FileKeystore`` — Ed25519 key in ``identity/device.key`` (0600); gen1 (a1) default.
* ``Pkcs11Keystore`` — key generated inside a secure element (SE050 / TPM via a PKCS#11
  module); the private key never exists in memory. Signing goes through a small
  ``Pkcs11Session`` interface so the agent does not depend on a specific binding: the default
  implementation uses ``PyKCS11`` when installed (``pip install ci-agent[pkcs11]``), tests and
  bench units inject their own.

Both produce the same request signatures (``CI-DEVICE-V1``) and expose the factory key
attestation (``ci-attest-v1``) used at registration.
"""

from __future__ import annotations

import base64
import hashlib
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ci_agent.fsutil import read_json
from ci_agent.identity import (
    HEADER_DEVICE_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    DeviceIdentity,
    canonical_string,
)
from ci_agent.timeutil import to_iso


class KeystoreUnavailable(RuntimeError):
    pass


class Keystore(Protocol):
    kind: str

    def public_key_pem(self) -> str: ...

    def public_key_fingerprint(self) -> str: ...

    def sign(self, data: bytes) -> bytes: ...

    def signed_headers(
        self, device_id: str, method: str, path_with_query: str, body: bytes, now: datetime
    ) -> dict[str, str]: ...

    def attestation(self) -> dict[str, Any] | None: ...


def _signed_headers(
    signer: Keystore, device_id: str, method: str, path: str, body: bytes, now: datetime
) -> dict[str, str]:
    timestamp = to_iso(now)
    message = canonical_string(method, path, timestamp, body).encode("utf-8")
    return {
        HEADER_DEVICE_ID: device_id,
        HEADER_TIMESTAMP: timestamp,
        HEADER_SIGNATURE: base64.b64encode(signer.sign(message)).decode("ascii"),
    }


def _load_attestation(path: Path | None) -> dict[str, Any] | None:
    """Factory-provisioned ``{"chain": [...], "statement": "..."}`` (see device-protocol §7)."""
    if path is None or not path.exists():
        return None
    data: dict[str, Any] = read_json(path)
    if not isinstance(data.get("chain"), list) or not isinstance(data.get("statement"), str):
        raise ValueError(f"{path} is not a ci-attest-v1 evidence file")
    return {"chain": [str(c) for c in data["chain"]], "statement": data["statement"]}


class FileKeystore:
    kind = "file"

    def __init__(self, identity: DeviceIdentity, attestation_path: Path | None = None) -> None:
        self.identity = identity
        self.attestation_path = attestation_path

    @classmethod
    def load_or_create(cls, path: Path, attestation_path: Path | None = None) -> FileKeystore:
        return cls(DeviceIdentity.load_or_create(path), attestation_path)

    def public_key_pem(self) -> str:
        return self.identity.public_key_pem()

    def public_key_fingerprint(self) -> str:
        return self.identity.public_key_fingerprint()

    def sign(self, data: bytes) -> bytes:
        return self.identity.sign(data)

    def signed_headers(
        self, device_id: str, method: str, path_with_query: str, body: bytes, now: datetime
    ) -> dict[str, str]:
        return _signed_headers(self, device_id, method, path_with_query, body, now)

    def attestation(self) -> dict[str, Any] | None:
        return _load_attestation(self.attestation_path)


class Pkcs11Session(Protocol):
    """Minimal PKCS#11 surface: an Ed25519 (CKM_EDDSA) key pair addressed by label."""

    def public_key_der(self, label: str) -> bytes:
        """DER SubjectPublicKeyInfo of the key pair ``label``."""
        ...

    def sign_eddsa(self, label: str, data: bytes) -> bytes: ...


class PyKcs11Session:
    """PKCS#11 via ``PyKCS11`` (optional dependency). Not exercised in CI (needs hardware)."""

    def __init__(self, module_path: str, token_label: str, pin: str | None) -> None:
        try:
            import PyKCS11  # type: ignore[import-not-found]
        except ImportError as exc:
            raise KeystoreUnavailable(
                "PyKCS11 is not installed (pip install ci-agent[pkcs11])"
            ) from exc
        if not Path(module_path).exists():
            raise KeystoreUnavailable(f"PKCS#11 module {module_path} not found")
        lib = PyKCS11.PyKCS11Lib()
        lib.load(module_path)
        slots = [
            s
            for s in lib.getSlotList(tokenPresent=True)
            if lib.getTokenInfo(s).label.strip() == token_label
        ]
        if not slots:
            raise KeystoreUnavailable(f"PKCS#11 token {token_label!r} not present")
        self._pk = PyKCS11
        self._session = lib.openSession(slots[0])
        if pin:
            self._session.login(pin)

    def _find(self, label: str, cls: Any) -> Any:
        objs = self._session.findObjects([(self._pk.CKA_CLASS, cls), (self._pk.CKA_LABEL, label)])
        if not objs:
            raise KeystoreUnavailable(f"key {label!r} not found on the token")
        return objs[0]

    def public_key_der(self, label: str) -> bytes:
        key = self._find(label, self._pk.CKO_PUBLIC_KEY)
        # CKA_EC_POINT holds the DER OCTET STRING of the 32-byte Ed25519 point.
        point = bytes(self._session.getAttributeValue(key, [self._pk.CKA_EC_POINT])[0])
        raw = point[2:] if len(point) == 34 and point[0] == 0x04 else point
        return Ed25519PublicKey.from_public_bytes(raw).public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def sign_eddsa(self, label: str, data: bytes) -> bytes:
        key = self._find(label, self._pk.CKO_PRIVATE_KEY)
        mechanism = self._pk.Mechanism(self._pk.CKM_EDDSA, None)
        return bytes(self._session.sign(key, data, mechanism))


class Pkcs11Keystore:
    kind = "pkcs11"

    def __init__(
        self,
        session: Pkcs11Session,
        key_label: str = "ci-device-identity",
        attestation_path: Path | None = None,
    ) -> None:
        self.session = session
        self.key_label = key_label
        self.attestation_path = attestation_path
        der = session.public_key_der(key_label)
        key = serialization.load_der_public_key(der)
        if not isinstance(key, Ed25519PublicKey):
            raise KeystoreUnavailable("secure-element identity key must be Ed25519")
        self._public = key
        self._der = der

    def public_key_pem(self) -> str:
        return self._public.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode("ascii")

    def public_key_fingerprint(self) -> str:
        return "sha256:" + hashlib.sha256(self._der).hexdigest()

    def sign(self, data: bytes) -> bytes:
        return self.session.sign_eddsa(self.key_label, data)

    def signed_headers(
        self, device_id: str, method: str, path_with_query: str, body: bytes, now: datetime
    ) -> dict[str, str]:
        return _signed_headers(self, device_id, method, path_with_query, body, now)

    def attestation(self) -> dict[str, Any] | None:
        return _load_attestation(self.attestation_path)


def open_keystore(
    kind: str,
    *,
    key_path: Path,
    attestation_path: Path | None,
    pkcs11_module: str = "",
    pkcs11_token_label: str = "",
    pkcs11_key_label: str = "ci-device-identity",
    pkcs11_pin_env: str = "CI_AGENT_PKCS11_PIN",
) -> Keystore:
    if kind == "file":
        return FileKeystore.load_or_create(key_path, attestation_path)
    if kind == "pkcs11":
        session = PyKcs11Session(pkcs11_module, pkcs11_token_label, os.environ.get(pkcs11_pin_env))
        return Pkcs11Keystore(session, pkcs11_key_label, attestation_path)
    raise ValueError(f"unknown keystore {kind!r} (expected file | pkcs11)")
