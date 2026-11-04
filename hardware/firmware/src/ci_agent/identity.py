"""Device identity (Ed25519) and request signing — contract §3.

The private key is generated on first boot and never leaves the device.
"""

from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from ci_agent.timeutil import to_iso

SIGNATURE_SCHEME = "CI-DEVICE-V1"
HEADER_DEVICE_ID = "X-Device-Id"
HEADER_TIMESTAMP = "X-Device-Timestamp"
HEADER_SIGNATURE = "X-Device-Signature"
KEY_FILE_MODE = 0o600


def canonical_string(method: str, path_with_query: str, timestamp: str, body: bytes) -> str:
    """Build the canonical string that is signed for every device→cloud request."""
    body_hash = hashlib.sha256(body).hexdigest()
    return "\n".join([SIGNATURE_SCHEME, method.upper(), path_with_query, timestamp, body_hash])


@dataclass(frozen=True)
class DeviceIdentity:
    private_key: Ed25519PrivateKey

    @classmethod
    def generate(cls) -> DeviceIdentity:
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def load(cls, path: Path) -> DeviceIdentity:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError(f"{path} does not contain an Ed25519 private key")
        return cls(key)

    @classmethod
    def load_or_create(cls, path: Path) -> DeviceIdentity:
        """Load the key at ``path`` or create it with mode 0600 (never overwrites)."""
        if path.exists():
            mode = path.stat().st_mode & 0o777
            if mode & 0o077:
                os.chmod(path, KEY_FILE_MODE)
            return cls.load(path)
        identity = cls.generate()
        identity.save(path)
        return identity

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        pem = self.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        # O_EXCL: refuse to clobber an existing identity.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, KEY_FILE_MODE)
        with os.fdopen(fd, "wb") as fh:
            fh.write(pem)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(path, KEY_FILE_MODE)

    @property
    def public_key(self) -> Ed25519PublicKey:
        return self.private_key.public_key()

    def public_key_pem(self) -> str:
        return self.public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")

    def public_key_fingerprint(self) -> str:
        der = self.public_key.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return "sha256:" + hashlib.sha256(der).hexdigest()

    def sign(self, data: bytes) -> bytes:
        return self.private_key.sign(data)

    def signed_headers(
        self,
        device_id: str,
        method: str,
        path_with_query: str,
        body: bytes,
        now: datetime,
    ) -> dict[str, str]:
        timestamp = to_iso(now)
        message = canonical_string(method, path_with_query, timestamp, body).encode("utf-8")
        signature = base64.b64encode(self.sign(message)).decode("ascii")
        return {
            HEADER_DEVICE_ID: device_id,
            HEADER_TIMESTAMP: timestamp,
            HEADER_SIGNATURE: signature,
        }


def verify_signature(
    public_key: Ed25519PublicKey,
    method: str,
    path_with_query: str,
    timestamp: str,
    body: bytes,
    signature_b64: str,
) -> bool:
    """Reference verifier (mirrors the cloud side); used in tests and diagnostics."""
    from cryptography.exceptions import InvalidSignature

    message = canonical_string(method, path_with_query, timestamp, body).encode("utf-8")
    try:
        public_key.verify(base64.b64decode(signature_b64), message)
    except (InvalidSignature, ValueError):
        return False
    return True
