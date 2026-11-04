"""Local filesystem object store with streaming AES-256-GCM encryption at rest.

File format (``CIENC1``)::

    magic "CIENC1" (6 bytes) | nonce prefix (8 bytes)
    repeated frames: ciphertext length (4 bytes, big endian) | ciphertext + 16-byte GCM tag

Each frame encrypts up to ``FRAME_SIZE`` plaintext bytes with nonce
``prefix || frame_index (4 bytes)``. The associated data binds the object key, the
frame index and a final-frame flag, so frames cannot be reordered, truncated or moved
to another object without detection.
"""

from __future__ import annotations

import base64
import os
import secrets
import struct
import tempfile
from pathlib import Path

import structlog
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = structlog.get_logger(__name__)

MAGIC = b"CIENC1"
FRAME_SIZE = 1024 * 1024
URI_SCHEME = "local://"


class EncryptionError(Exception):
    pass


def load_encryption_key(env_value: str | None) -> bytes:
    """Decode ``AUDIO_ENCRYPTION_KEY`` (base64, 32 bytes) or generate a dev key."""
    if env_value:
        key = base64.b64decode(env_value)
        if len(key) != 32:
            raise EncryptionError("AUDIO_ENCRYPTION_KEY must decode to exactly 32 bytes")
        return key
    log.warning(
        "storage.dev_encryption_key",
        message="AUDIO_ENCRYPTION_KEY not set; using an ephemeral key. Stored audio will be "
        "unreadable after restart. Never run like this outside local development.",
    )
    return AESGCM.generate_key(bit_length=256)


def _aad(key: str, index: int, final: bool) -> bytes:
    return key.encode("utf-8") + struct.pack(">IB", index, 1 if final else 0)


def encrypt_file(aes_key: bytes, object_key: str, source: Path, destination: Path) -> None:
    aead = AESGCM(aes_key)
    prefix = secrets.token_bytes(8)
    size = source.stat().st_size
    total_frames = max(1, -(-size // FRAME_SIZE))
    with source.open("rb") as src, destination.open("wb") as dst:
        dst.write(MAGIC + prefix)
        for index in range(total_frames):
            plaintext = src.read(FRAME_SIZE)
            final = index == total_frames - 1
            nonce = prefix + struct.pack(">I", index)
            ciphertext = aead.encrypt(nonce, plaintext, _aad(object_key, index, final))
            dst.write(struct.pack(">I", len(ciphertext)))
            dst.write(ciphertext)


def decrypt_file(aes_key: bytes, object_key: str, source: Path, destination: Path) -> None:
    aead = AESGCM(aes_key)
    with source.open("rb") as src, destination.open("wb") as dst:
        header = src.read(len(MAGIC) + 8)
        if len(header) != len(MAGIC) + 8 or not header.startswith(MAGIC):
            raise EncryptionError("not a CIENC1 object")
        prefix = header[len(MAGIC) :]
        index = 0
        length_bytes = src.read(4)
        while length_bytes:
            (length,) = struct.unpack(">I", length_bytes)
            ciphertext = src.read(length)
            if len(ciphertext) != length:
                raise EncryptionError("truncated frame")
            next_length = src.read(4)
            final = not next_length
            nonce = prefix + struct.pack(">I", index)
            try:
                dst.write(aead.decrypt(nonce, ciphertext, _aad(object_key, index, final)))
            except InvalidTag as exc:
                raise EncryptionError("object failed authentication") from exc
            index += 1
            length_bytes = next_length
        if index == 0:
            raise EncryptionError("object has no frames")


class EncryptedLocalObjectStore:
    """Object store rooted at a directory; every object is encrypted at rest."""

    def __init__(self, root: Path, aes_key: bytes) -> None:
        self._root = root
        self._key = aes_key
        root.mkdir(parents=True, exist_ok=True)

    def _path_for(self, key: str) -> Path:
        path = (self._root / key).resolve()
        if self._root.resolve() not in path.parents:
            raise ValueError("object key escapes the storage root")
        return path

    @staticmethod
    def _key_from_uri(uri: str) -> str:
        if not uri.startswith(URI_SCHEME):
            raise ValueError(f"unsupported storage URI: {uri}")
        return uri[len(URI_SCHEME) :]

    def put_file(self, key: str, source: Path, content_type: str) -> str:
        target = self._path_for(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            encrypt_file(self._key, key, source, tmp)
            tmp.replace(target)
        finally:
            tmp.unlink(missing_ok=True)
        log.info("storage.object_written", key=key, content_type=content_type)
        return URI_SCHEME + key

    def get_to_file(self, uri: str, destination: Path) -> None:
        key = self._key_from_uri(uri)
        decrypt_file(self._key, key, self._path_for(key), destination)

    def exists(self, uri: str) -> bool:
        return self._path_for(self._key_from_uri(uri)).exists()

    def delete(self, uri: str) -> bool:
        path = self._path_for(self._key_from_uri(uri))
        if not path.exists():
            return False
        path.unlink()
        return True

    def delete_prefix(self, uri_prefix: str) -> int:
        prefix = self._key_from_uri(uri_prefix)
        root = self._root.resolve()
        count = 0
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.relative_to(root).as_posix().startswith(prefix):
                path.unlink()
                count += 1
        return count

    def raw_path(self, uri: str) -> Path:
        """Filesystem path of the encrypted object (diagnostics / tests)."""
        return self._path_for(self._key_from_uri(uri))
