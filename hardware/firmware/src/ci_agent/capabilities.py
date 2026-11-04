"""Hardware capability detection and capture profiles (Phase 6 §6.10).

The cloud sends a *capture profile* per device model with the recording plan
(``captureProfile``); the agent reconciles it with what it actually detects on the
hardware (microphone channels, encoders installed, keystore, LTE modem) so a profile can
never ask for something the unit cannot do — it degrades instead (e.g. FLAC → WAV).
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SUPPORTED_ENCODINGS = ("wav", "flac")  # opus is advertised by a2 hardware but not used yet


@dataclass(frozen=True)
class DeviceCapabilities:
    model: str
    mic_channels: int
    beamforming: bool
    on_device_vad: bool
    encoders: tuple[str, ...]
    keystore: str  # "file" | "pkcs11"
    hardware_keystore: str  # model capability: "none" | "se050" | "tpm"
    lte: bool

    def report(self) -> dict[str, Any]:
        """Heartbeat ``capabilities`` (camelCase, as reported to device-management)."""
        return {
            "model": self.model,
            "micChannels": self.mic_channels,
            "beamforming": self.beamforming,
            "onDeviceVad": self.on_device_vad,
            "encoders": list(self.encoders),
            "keystore": self.keystore,
            "hardwareKeystore": self.hardware_keystore,
            "lte": self.lte,
        }


@dataclass(frozen=True)
class VadSettings:
    enabled: bool = False
    trim_pre_roll: bool = False
    trim_post_roll: bool = False
    threshold_db: float = 12.0
    margin_ms: int = 1000


@dataclass(frozen=True)
class CaptureProfile:
    capture_channels: int = 1
    sample_rate: int = 16_000
    encoding: str = "wav"
    beamforming: bool = False
    keep_raw_multichannel: bool = False
    vad: VadSettings = VadSettings()

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> CaptureProfile:
        vad = data.get("vad") or {}
        return cls(
            capture_channels=int(data.get("captureChannels", 1)),
            sample_rate=int(data.get("sampleRate", 16_000)),
            encoding=str(data.get("encoding", "wav")),
            beamforming=bool(data.get("beamforming", False)),
            keep_raw_multichannel=bool(data.get("keepRawMultichannel", False)),
            vad=VadSettings(
                enabled=bool(vad.get("enabled", False)),
                trim_pre_roll=bool(vad.get("trimPreRoll", False)),
                trim_post_roll=bool(vad.get("trimPostRoll", False)),
                threshold_db=float(vad.get("thresholdDb", 12.0)),
                margin_ms=int(vad.get("marginMs", 1000)),
            ),
        )

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        return {
            "captureChannels": d["capture_channels"],
            "sampleRate": d["sample_rate"],
            "encoding": d["encoding"],
            "beamforming": d["beamforming"],
            "keepRawMultichannel": d["keep_raw_multichannel"],
            "vad": {
                "enabled": self.vad.enabled,
                "trimPreRoll": self.vad.trim_pre_roll,
                "trimPostRoll": self.vad.trim_post_roll,
                "thresholdDb": self.vad.threshold_db,
                "marginMs": self.vad.margin_ms,
            },
        }


@dataclass(frozen=True)
class ModelDefaults:
    mic_channels: int
    beamforming: bool
    on_device_vad: bool
    hardware_keystore: str
    lte: bool
    profile: CaptureProfile


# Mirrors device-management's registry (src/models.ts); used offline / before the first plan.
MODEL_DEFAULTS: dict[str, ModelDefaults] = {
    "ci-capture-a1": ModelDefaults(1, False, False, "none", False, CaptureProfile()),
    "ci-capture-a2": ModelDefaults(
        4,
        True,
        True,
        "se050",
        True,
        CaptureProfile(
            capture_channels=4,
            encoding="flac",
            beamforming=True,
            vad=VadSettings(enabled=True, trim_pre_roll=True, trim_post_roll=True),
        ),
    ),
}


def probe_alsa_channels(device: str, run: Callable[..., Any] = subprocess.run) -> int | None:
    """Max capture channels of an ALSA PCM (``arecord --dump-hw-params``), or ``None``."""
    binary = shutil.which("arecord")
    if binary is None:
        return None
    try:
        done = run(
            [binary, "-D", device, "--dump-hw-params", "-d", "1", "/dev/null"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return parse_channels(f"{done.stdout}\n{done.stderr}")


def parse_channels(hw_params: str) -> int | None:
    match = re.search(r"CHANNELS:\s*\[?\s*(\d+)(?:\s+(\d+))?\s*\]?", hw_params)
    if not match:
        return None
    return int(match.group(2) or match.group(1))


def detect_capabilities(
    model: str,
    *,
    audio_device: str = "default",
    keystore: str = "file",
    which: Callable[[str], str | None] = shutil.which,
    channel_probe: Callable[[str], int | None] = probe_alsa_channels,
    net_root: Path = Path("/sys/class/net"),
) -> DeviceCapabilities:
    defaults = MODEL_DEFAULTS.get(model, MODEL_DEFAULTS["ci-capture-a1"])
    probed = channel_probe(audio_device)
    mic_channels = min(defaults.mic_channels, probed) if probed else defaults.mic_channels
    encoders = ["wav"]
    if which("flac"):
        encoders.append("flac")
    lte = defaults.lte and net_root.exists() and any(net_root.glob("ww*"))
    return DeviceCapabilities(
        model=model,
        mic_channels=mic_channels,
        beamforming=defaults.beamforming and mic_channels > 1,
        on_device_vad=defaults.on_device_vad,
        encoders=tuple(encoders),
        keystore=keystore,
        hardware_keystore=defaults.hardware_keystore,
        lte=lte,
    )


def default_profile(model: str) -> CaptureProfile:
    return MODEL_DEFAULTS.get(model, MODEL_DEFAULTS["ci-capture-a1"]).profile


def effective_profile(
    requested: CaptureProfile | None, caps: DeviceCapabilities
) -> tuple[CaptureProfile, list[str]]:
    """Clamp the server profile to the hardware. Returns the profile and the downgrades made."""
    profile = requested or default_profile(caps.model)
    notes: list[str] = []
    channels = profile.capture_channels
    if channels > caps.mic_channels:
        notes.append(f"captureChannels {channels} > {caps.mic_channels} microphones")
        channels = caps.mic_channels
    encoding = profile.encoding
    if encoding not in caps.encoders or encoding not in SUPPORTED_ENCODINGS:
        notes.append(f"encoding {encoding} unavailable; using wav")
        encoding = "wav"
    beamforming = profile.beamforming and caps.beamforming and channels > 1
    vad = profile.vad if caps.on_device_vad else replace(profile.vad, enabled=False)
    out = replace(
        profile, capture_channels=channels, encoding=encoding, beamforming=beamforming, vad=vad
    )
    for note in notes:
        log.warning("capture profile adjusted: %s", note)
    return out, notes
