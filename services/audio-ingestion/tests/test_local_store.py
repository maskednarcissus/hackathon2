from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest

from audio_ingestion.adapters.local_store import (
    FRAME_SIZE,
    EncryptedLocalObjectStore,
    EncryptionError,
    load_encryption_key,
)


def test_round_trip_multi_frame(tmp_path: Path) -> None:
    store = EncryptedLocalObjectStore(tmp_path / "o", os.urandom(32))
    source = tmp_path / "in.bin"
    data = os.urandom(FRAME_SIZE * 2 + 17)
    source.write_bytes(data)
    uri = store.put_file("recordings/a/b.wav", source, "audio/wav")
    assert store.exists(uri)
    out = tmp_path / "out.bin"
    store.get_to_file(uri, out)
    assert out.read_bytes() == data


def test_empty_file_round_trip(tmp_path: Path) -> None:
    store = EncryptedLocalObjectStore(tmp_path / "o", os.urandom(32))
    source = tmp_path / "empty"
    source.write_bytes(b"")
    uri = store.put_file("x/empty", source, "audio/wav")
    out = tmp_path / "out"
    store.get_to_file(uri, out)
    assert out.read_bytes() == b""


def test_tampering_and_truncation_detected(tmp_path: Path) -> None:
    store = EncryptedLocalObjectStore(tmp_path / "o", os.urandom(32))
    source = tmp_path / "in.bin"
    source.write_bytes(os.urandom(FRAME_SIZE + 10))
    uri = store.put_file("k/obj", source, "audio/wav")
    raw = store.raw_path(uri)
    original = raw.read_bytes()

    tampered = bytearray(original)
    tampered[40] ^= 0x01
    raw.write_bytes(bytes(tampered))
    with pytest.raises(EncryptionError):
        store.get_to_file(uri, tmp_path / "x")

    # Drop the final frame: the previous frame is not marked final → rejected.
    first_frame_len = int.from_bytes(original[14:18], "big")
    raw.write_bytes(original[: 14 + 4 + first_frame_len])
    with pytest.raises(EncryptionError):
        store.get_to_file(uri, tmp_path / "y")


def test_wrong_key_cannot_decrypt(tmp_path: Path) -> None:
    root = tmp_path / "o"
    source = tmp_path / "in"
    source.write_bytes(b"audio")
    uri = EncryptedLocalObjectStore(root, os.urandom(32)).put_file("k", source, "audio/wav")
    with pytest.raises(EncryptionError):
        EncryptedLocalObjectStore(root, os.urandom(32)).get_to_file(uri, tmp_path / "out")


def test_key_escape_rejected(tmp_path: Path) -> None:
    store = EncryptedLocalObjectStore(tmp_path / "o", os.urandom(32))
    source = tmp_path / "in"
    source.write_bytes(b"a")
    with pytest.raises(ValueError):
        store.put_file("../evil", source, "audio/wav")


def test_load_encryption_key() -> None:
    key = os.urandom(32)
    assert load_encryption_key(base64.b64encode(key).decode()) == key
    assert len(load_encryption_key(None)) == 32
    with pytest.raises(EncryptionError):
        load_encryption_key(base64.b64encode(b"short").decode())
