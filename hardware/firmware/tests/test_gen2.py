"""Phase 6 (6.10) — gen2 hardware: capabilities, beamforming, VAD, FLAC, keystore, OTA."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import subprocess
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ci_agent.capabilities import (
    CaptureProfile,
    DeviceCapabilities,
    VadSettings,
    detect_capabilities,
    effective_profile,
    parse_channels,
)
from ci_agent.dsp import (
    DelayAndSum,
    beamform_file,
    frame_levels_dbfs,
    parse_mic_positions,
    steering_delays,
    vad_trim_bounds,
)
from ci_agent.identity import verify_signature
from ci_agent.keystore import FileKeystore, Pkcs11Keystore
from ci_agent.ota import OtaClient, verify_manifest
from ci_agent.pipeline import CapturePipeline, EncodeResult, flac_encode
from ci_agent.scheduler import RecordingPlan
from ci_agent.spool import Spool
from ci_agent.timeutil import to_iso
from ci_agent.uploader import Uploader

from .conftest import T0, Clock

SR = 16_000

# ----------------------------------------------------------------------------- capabilities


def test_parse_alsa_channels() -> None:
    assert parse_channels("FORMAT: S16_LE\nCHANNELS: [1 8]\nRATE: [8000 48000]") == 8
    assert parse_channels("CHANNELS: 4") == 4
    assert parse_channels("nothing here") is None


def test_detect_capabilities_and_profile_downgrades(tmp_path: Path) -> None:
    (tmp_path / "wwan0").mkdir()
    caps = detect_capabilities(
        "ci-capture-a2",
        which=lambda name: None,  # no flac binary
        channel_probe=lambda _dev: 2,  # only 2 mics wired on this bench unit
        net_root=tmp_path,
        keystore="pkcs11",
    )
    assert caps.mic_channels == 2 and caps.beamforming and caps.lte
    assert caps.encoders == ("wav",)
    assert caps.report()["hardwareKeystore"] == "se050"

    requested = CaptureProfile(capture_channels=4, encoding="flac", beamforming=True)
    profile, notes = effective_profile(requested, caps)
    assert profile.capture_channels == 2 and profile.encoding == "wav" and profile.beamforming
    assert len(notes) == 2

    a1 = detect_capabilities(
        "ci-capture-a1", which=lambda n: "/usr/bin/flac", channel_probe=lambda _d: None
    )
    p1, _ = effective_profile(None, a1)
    assert p1 == CaptureProfile()  # mono WAV, no VAD


def test_plan_carries_capture_profile() -> None:
    plan = RecordingPlan.from_json(
        {
            "classroomId": "room",
            "generatedAt": to_iso(T0),
            "windows": [],
            "deviceModel": "ci-capture-a2",
            "captureProfile": {"captureChannels": 4, "encoding": "flac", "vad": {"enabled": True}},
        }
    )
    assert plan.device_model == "ci-capture-a2"
    assert CaptureProfile.from_json(plan.capture_profile or {}).vad.enabled
    assert RecordingPlan.from_json(plan.to_json()).capture_profile == plan.capture_profile


# ----------------------------------------------------------------------------- beamforming


def _tone(n: int, freq: float = 440.0, amp: float = 6000.0) -> np.ndarray:
    t = np.arange(n) / SR
    return amp * np.sin(2 * math.pi * freq * t)


def _multichannel(signal: np.ndarray, lags: list[int], noise: float, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = signal.shape[0]
    channels = []
    for lag in lags:
        ch = np.zeros(n)
        ch[lag:] = signal[: n - lag]
        channels.append(ch + rng.normal(0, noise, n))
    return np.clip(np.round(np.stack(channels, axis=1)), -32768, 32767).astype(np.int16)


def test_steering_delays_linear_array() -> None:
    positions = parse_mic_positions("0,0; 0.05,0; 0.10,0; 0.15,0")
    assert steering_delays(positions, 0.0, SR, 4) == [0, 0, 0, 0]  # broadside
    # Source along +x: the mic at x=0.15 hears it first, so it is delayed the most.
    assert steering_delays(positions, 90.0, SR, 4) == [0, 2, 5, 7]
    assert steering_delays(positions, 90.0, SR, 2) == [0, 0]  # geometry mismatch → no steering


def test_delay_and_sum_aligns_channels_and_improves_snr() -> None:
    lags = [7, 5, 2, 0]  # arrival lags of a source along +x
    signal = _tone(SR)
    frames = _multichannel(signal, lags, noise=3000.0)
    mono = DelayAndSum(4, [0, 2, 5, 7]).process(frames.reshape(-1)).astype(np.float64)
    reference = np.zeros(SR)
    reference[7:] = signal[: SR - 7]

    def snr_db(x: np.ndarray) -> float:
        err = x[100:] - reference[100:]
        return 10 * math.log10(np.mean(reference[100:] ** 2) / np.mean(err**2))

    single = snr_db(frames[:, 3].astype(np.float64) - 0)  # channel 3 has lag 0
    single_aligned = snr_db(np.concatenate([np.zeros(7), frames[: SR - 7, 3]]).astype(np.float64))
    assert snr_db(mono) > max(single, single_aligned) + 4.5  # ≈ +6 dB for 4 mics


def test_streaming_beamform_equals_one_shot(tmp_path: Path) -> None:
    frames = _multichannel(_tone(SR * 3), [3, 2, 1, 0], noise=500.0)
    one_shot = DelayAndSum(4, [0, 1, 2, 3]).process(frames.reshape(-1))
    mixer = DelayAndSum(4, [0, 1, 2, 3])
    pieces = [mixer.process(chunk.reshape(-1)) for chunk in np.array_split(frames, 7)]
    assert np.array_equal(np.concatenate(pieces), one_shot)

    src = tmp_path / "cap.pcm"
    src.write_bytes(frames.astype("<i2").tobytes())
    out = tmp_path / "mono.pcm"
    assert beamform_file(src, out, 4, [0, 1, 2, 3]) == SR * 3
    assert np.array_equal(np.frombuffer(out.read_bytes(), dtype="<i2"), one_shot)


# ----------------------------------------------------------------------------- VAD


def test_vad_trims_only_pre_and_post_roll() -> None:
    frame_ms = 20
    # 10 s pre-roll (speech starts at 8 s), class 10–70 s with a silent gap, speech ends at 72 s.
    levels = np.full(90_000 // frame_ms, -70.0)
    levels[8_000 // frame_ms : 30_000 // frame_ms] = -25.0
    levels[50_000 // frame_ms : 72_000 // frame_ms] = -25.0
    r = vad_trim_bounds(
        levels, frame_ms, class_start_ms=10_000, class_end_ms=70_000, margin_ms=1000
    )
    assert (r.start_ms, r.end_ms, r.speech_detected) == (7_000, 73_000, True)
    assert r.trimmed

    # Speech only inside the class: trim exactly to the class body.
    levels2 = np.full(90_000 // frame_ms, -70.0)
    levels2[20_000 // frame_ms : 30_000 // frame_ms] = -25.0
    r2 = vad_trim_bounds(levels2, frame_ms, class_start_ms=10_000, class_end_ms=70_000)
    assert (r2.start_ms, r2.end_ms) == (10_000, 70_000)

    # Silence everywhere: still never cut into the class; trimming disabled keeps all.
    r3 = vad_trim_bounds(np.full(100, -80.0), frame_ms, class_start_ms=500, class_end_ms=1500)
    assert (r3.start_ms, r3.end_ms, r3.speech_detected) == (500, 1500, False)
    r4 = vad_trim_bounds(
        levels,
        frame_ms,
        class_start_ms=10_000,
        class_end_ms=70_000,
        trim_pre_roll=False,
        trim_post_roll=False,
    )
    assert (r4.start_ms, r4.end_ms) == (0, 90_000)


def test_frame_levels_from_file(tmp_path: Path) -> None:
    pcm = np.concatenate([np.zeros(SR), _tone(SR, amp=3276.8)]).astype("<i2")
    path = tmp_path / "m.pcm"
    path.write_bytes(pcm.tobytes())
    levels = frame_levels_dbfs(path, SR, 20)
    assert levels.shape[0] == 100
    assert levels[10] < -100 and -24 < levels[80] < -22  # 0.1 FS sine ≈ -23 dBFS


# ----------------------------------------------------------------------------- pipeline


def _a2_profile(encoding: str = "flac") -> CaptureProfile:
    return CaptureProfile(
        capture_channels=4,
        encoding=encoding,
        beamforming=True,
        keep_raw_multichannel=True,
        vad=VadSettings(enabled=True, trim_pre_roll=True, trim_post_roll=True, margin_ms=500),
    )


def _write_capture(path: Path, seconds_pre: int, seconds_speech: int, seconds_post: int) -> None:
    n_pre, n_sp, n_post = (SR * s for s in (seconds_pre, seconds_speech, seconds_post))
    speech = np.concatenate([np.zeros(n_pre), _tone(n_sp), np.zeros(n_post)])
    frames = _multichannel(speech, [0, 0, 0, 0], noise=20.0)
    path.write_bytes(frames.astype("<i2").tobytes())


def fake_flac(wav: Path, out: Path) -> EncodeResult:
    out.write_bytes(b"fLaC" + hashlib.sha256(wav.read_bytes()).digest())
    return EncodeResult(True, "flac")


def test_pipeline_beamforms_trims_and_encodes(tmp_path: Path) -> None:
    pcm = tmp_path / "rec.pcm"
    _write_capture(pcm, 4, 6, 4)  # 14 s; class 3 s … 11 s; speech 4 s … 10 s
    pipeline = CapturePipeline(lambda: _a2_profile(), encoder=fake_flac)
    out = pipeline.process(
        pcm,
        local_id="rec",
        sample_rate=SR,
        channels=4,
        started_at=to_iso(T0),
        class_starts_at=to_iso(T0 + timedelta(seconds=5)),
        class_ends_at=to_iso(T0 + timedelta(seconds=9)),
    )
    assert out.audio_format == "flac" and out.file.suffix == ".flac" and out.channels == 1
    assert out.file.read_bytes().startswith(b"fLaC")
    assert out.checksum_sha256 == hashlib.sha256(out.file.read_bytes()).hexdigest()
    assert (out.trimmed_start_ms, out.trimmed_end_ms) == (3_500, 10_500)
    assert out.duration_ms == 7_000 and out.capture_duration_ms == 14_000
    assert out.raw_file is not None and out.raw_file.exists()
    assert not (tmp_path / "rec.wav").exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rec.flac", "rec.pcm", "rec.raw.wav"]


def test_pipeline_falls_back_to_wav_without_flac(tmp_path: Path) -> None:
    pcm = tmp_path / "rec.pcm"
    _write_capture(pcm, 1, 2, 1)
    pipeline = CapturePipeline(
        lambda: _a2_profile(),
        encoder=lambda w, o: flac_encode(w, o, which=lambda _n: None),
    )
    out = pipeline.process(
        pcm,
        local_id="rec",
        sample_rate=SR,
        channels=4,
        started_at=to_iso(T0),
        class_starts_at=None,
        class_ends_at=None,
    )
    assert out.audio_format == "wav_pcm_s16le" and out.file.name == "rec.wav"
    assert out.encoding_note == "wav (fallback: flac CLI not installed)"
    assert (out.trimmed_start_ms, out.trimmed_end_ms) == (0, 4_000)  # no window → no trimming


def test_flac_encode_invokes_cli(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **_kw: Any) -> subprocess.CompletedProcess[str]:
        calls.append(argv)
        Path(argv[argv.index("-o") + 1]).write_bytes(b"fLaC")
        return subprocess.CompletedProcess(argv, 0, "", "")

    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")
    result = flac_encode(wav, tmp_path / "a.flac", which=lambda _n: "/usr/bin/flac", run=run)
    assert result.ok
    assert calls[0][:5] == ["/usr/bin/flac", "--silent", "--best", "--verify", "--force"]


def test_spool_and_uploader_report_flac_and_trimmed_bounds(tmp_path: Path, clock: Clock) -> None:
    spool = Spool(tmp_path / "spool", 10**9, 10**9, SR, 4)
    spool.pipeline = CapturePipeline(lambda: _a2_profile(), encoder=fake_flac)
    entry = spool.begin(
        "room",
        "class-A",
        T0,
        class_starts_at=T0 + timedelta(seconds=5),
        class_ends_at=T0 + timedelta(seconds=9),
    )
    _write_capture(spool.path_of(entry.pcm_file), 4, 6, 4)
    done = spool.finish(entry.local_recording_id, T0 + timedelta(seconds=14))
    assert done.audio_format == "flac" and done.channels == 1 and done.capture_channels == 4
    assert done.upload_started_at == to_iso(T0 + timedelta(milliseconds=3_500))
    assert done.upload_ended_at == to_iso(T0 + timedelta(milliseconds=10_500))
    assert spool.orphans() == []

    uploader = Uploader(object(), spool, "dev-1", "2.0.0", 1024, sleep=lambda _s: None, clock=clock)  # type: ignore[arg-type]
    meta = uploader._metadata(done)
    assert meta["audioFormat"] == "flac" and meta["channels"] == 1
    assert meta["startedAt"] == done.upload_started_at and meta["endedAt"] == done.upload_ended_at
    assert set(meta) == {
        "deviceId",
        "classroomId",
        "scheduledClassId",
        "startedAt",
        "endedAt",
        "audioFormat",
        "sampleRate",
        "channels",
        "fileSizeBytes",
        "checksumSha256",
        "firmwareVersion",
        "localRecordingId",
    }  # ingestion forbids extra fields


# ----------------------------------------------------------------------------- keystore


class FakePkcs11Session:
    """In-memory stand-in for a secure element token (key never leaves the object)."""

    def __init__(self) -> None:
        self._key = Ed25519PrivateKey.generate()
        self.sign_calls = 0

    def public_key_der(self, label: str) -> bytes:
        assert label == "ci-device-identity"
        return self._key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def sign_eddsa(self, label: str, data: bytes) -> bytes:
        self.sign_calls += 1
        return self._key.sign(data)


def test_pkcs11_keystore_signs_device_requests(tmp_path: Path) -> None:
    session = FakePkcs11Session()
    evidence = tmp_path / "attestation.json"
    evidence.write_text(json.dumps({"chain": ["a.b", "c.d"], "statement": "e.f"}))
    ks = Pkcs11Keystore(session, attestation_path=evidence)
    headers = ks.signed_headers("dev-1", "POST", "/v1/devices/dev-1/heartbeat", b"{}", T0)
    public = serialization.load_pem_public_key(ks.public_key_pem().encode())
    assert verify_signature(
        public,  # type: ignore[arg-type]
        "POST",
        "/v1/devices/dev-1/heartbeat",
        headers["X-Device-Timestamp"],
        b"{}",
        headers["X-Device-Signature"],
    )
    assert session.sign_calls == 1
    assert ks.attestation() == {"chain": ["a.b", "c.d"], "statement": "e.f"}
    assert ks.public_key_fingerprint().startswith("sha256:")


def test_file_keystore_matches_identity(tmp_path: Path) -> None:
    ks = FileKeystore.load_or_create(tmp_path / "device.key", tmp_path / "missing.json")
    again = FileKeystore.load_or_create(tmp_path / "device.key")
    assert ks.public_key_fingerprint() == again.public_key_fingerprint()
    assert ks.attestation() is None and ks.kind == "file"


# ----------------------------------------------------------------------------- OTA


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign_manifest(manifest: dict[str, Any], key: Ed25519PrivateKey) -> str:
    encoded = _b64(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
    return f"{encoded}.{_b64(key.sign(encoded.encode()))}"


IMAGE = b"\x7fELF" + bytes(range(256)) * 400


class FakeOtaApi:
    def __init__(self, offer: dict[str, Any]) -> None:
        self.offer = offer
        self.reports: list[tuple[str, str, str | None]] = []

    def firmware_update(self) -> dict[str, Any]:
        return self.offer

    def firmware_status(self, release_id: str, state: str, error: str | None = None) -> None:
        self.reports.append((release_id, state, error))


@pytest.fixture
def release_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


def _offer(key: Ed25519PrivateKey, **over: Any) -> dict[str, Any]:
    manifest = {
        "v": 1,
        "model": "ci-capture-a2",
        "version": "2.1.0",
        "url": "https://fw.example/a2-2.1.0.img",
        "sha256": hashlib.sha256(IMAGE).hexdigest(),
        "sizeBytes": len(IMAGE),
        "releasedAt": "2026-11-01T00:00:00.000Z",
        "keyId": "release-2026",
        **over,
    }
    return {"updateAvailable": True, "releaseId": "rel-1", "manifest": sign_manifest(manifest, key)}


def _client(tmp_path: Path, api: FakeOtaApi, key: Ed25519PrivateKey, **kw: Any) -> OtaClient:
    def downloader(_url: str) -> Iterator[bytes]:
        data = kw.pop("image", IMAGE)
        for i in range(0, len(data), 4096):
            yield data[i : i + 4096]

    image = kw.get("image")
    return OtaClient(
        api,
        model="ci-capture-a2",
        current_version=kw.get("current_version", "2.0.0"),
        trusted_keys={"release-2026": key.public_key()},
        staging_dir=tmp_path / "ota",
        downloader=(lambda url: iter([image])) if image is not None else downloader,
        install_command=kw.get("install_command", ()),
        run=kw.get("run", subprocess.run),
    )


def test_ota_verifies_and_stages(tmp_path: Path, release_key: Ed25519PrivateKey) -> None:
    api = FakeOtaApi(_offer(release_key))
    result = _client(tmp_path, api, release_key).check_and_stage()
    assert result.state == "staged" and result.path is not None
    assert result.path.read_bytes() == IMAGE
    pending = json.loads((tmp_path / "ota" / "pending-update.json").read_text())
    assert pending["version"] == "2.1.0"
    assert [r[1] for r in api.reports] == ["downloading", "staged"]
    # Second check: already staged, nothing re-downloaded.
    again = _client(tmp_path, api, release_key).check_and_stage()
    assert again.state == "already_staged"
    # After the reboot into 2.1.0: installed is reported and the staging area cleaned.
    installed = _client(tmp_path, api, release_key, current_version="2.1.0").check_and_stage()
    assert installed.state == "installed"
    assert api.reports[-1][1] == "installed"
    assert not (tmp_path / "ota" / "pending-update.json").exists()


@pytest.mark.parametrize(
    ("override", "reason"),
    [
        ({"model": "ci-capture-a1"}, "manifest is for"),
        ({"version": "1.9.0"}, "not newer"),
        ({"minVersion": "2.0.5"}, "requires at least"),
        ({"keyId": "other"}, "untrusted release key"),
    ],
)
def test_ota_rejects_bad_manifests(
    tmp_path: Path, release_key: Ed25519PrivateKey, override: dict[str, Any], reason: str
) -> None:
    api = FakeOtaApi(_offer(release_key, **override))
    result = _client(tmp_path, api, release_key).check_and_stage()
    assert result.state == "rejected" and reason in (result.reason or "")
    assert api.reports[0][1] == "failed"


def test_ota_rejects_forged_signature_and_unsigned_fields(
    tmp_path: Path, release_key: Ed25519PrivateKey
) -> None:
    forged = _offer(Ed25519PrivateKey.generate())
    assert _client(tmp_path, FakeOtaApi(forged), release_key).check_and_stage().state == "rejected"
    with pytest.raises(Exception, match="signature"):
        verify_manifest(forged["manifest"], {"release-2026": release_key.public_key()})


def test_ota_rejects_tampered_or_oversized_images(
    tmp_path: Path, release_key: Ed25519PrivateKey
) -> None:
    api = FakeOtaApi(_offer(release_key))
    tampered = bytearray(IMAGE)
    tampered[10] ^= 0xFF
    result = _client(tmp_path, api, release_key, image=bytes(tampered)).check_and_stage()
    assert result.state == "failed" and "sha256" in (result.reason or "")
    big = _client(tmp_path, FakeOtaApi(_offer(release_key)), release_key, image=IMAGE + b"x")
    assert "larger than the signed size" in (big.check_and_stage().reason or "")
    assert not list((tmp_path / "ota").glob("*.img"))


def test_ota_installs_only_when_not_recording(
    tmp_path: Path, release_key: Ed25519PrivateKey
) -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **_kw: Any) -> subprocess.CompletedProcess[str]:
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    api = FakeOtaApi(_offer(release_key))
    client = _client(
        tmp_path, api, release_key, install_command=("rauc", "install", "{path}"), run=run
    )
    assert client.check_and_stage(recording=True).state == "staged" and calls == []
    result = client.check_and_stage(recording=False)
    assert calls == [["rauc", "install", str(tmp_path / "ota" / "ci-capture-a2-2.1.0.img")]]
    assert result.reason == "installer completed; reboot pending"


def test_ota_up_to_date(tmp_path: Path, release_key: Ed25519PrivateKey) -> None:
    api = FakeOtaApi({"updateAvailable": False})
    assert _client(tmp_path, api, release_key).check_and_stage().state == "up_to_date"
    assert api.reports == []


def test_capabilities_report_shape() -> None:
    caps = DeviceCapabilities(
        "ci-capture-a2", 4, True, True, ("wav", "flac"), "pkcs11", "se050", False
    )
    assert caps.report() == {
        "model": "ci-capture-a2",
        "micChannels": 4,
        "beamforming": True,
        "onDeviceVad": True,
        "encoders": ["wav", "flac"],
        "keystore": "pkcs11",
        "hardwareKeystore": "se050",
        "lte": False,
    }


def test_agent_reports_capabilities_and_applies_plan_profile(
    tmp_path: Path, clock: Clock, identity: Any
) -> None:
    from .test_agent import build

    agent, dm, _ = build(tmp_path, clock, identity)
    agent.capabilities = DeviceCapabilities(
        "ci-capture-a2", 4, True, True, ("wav",), "pkcs11", "se050", True
    )
    dm.windows = []
    original = dm.recording_plan

    def plan_with_profile(start: Any, end: Any) -> tuple[dict[str, Any], str | None]:
        data, date = original(start, end)
        data["captureProfile"] = _a2_profile("flac").to_json()
        return data, date

    dm.recording_plan = plan_with_profile  # type: ignore[method-assign]
    agent.tick()
    assert dm.heartbeats[-1]["capabilities"]["micChannels"] == 4
    profile = agent.capture_profile()
    # Requested FLAC, but this unit has no encoder: degraded to WAV; 4 channels + beamforming kept.
    assert (profile.capture_channels, profile.encoding, profile.beamforming) == (4, "wav", True)
