"""Agent configuration: TOML file + ``CI_AGENT_*`` environment overrides."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path("/etc/ci-agent/config.toml")
MIB = 1024 * 1024
GIB = 1024 * MIB


@dataclass(frozen=True)
class AgentConfig:
    device_management_url: str = "http://localhost:4004"
    ingestion_url: str = "http://localhost:8001"
    data_dir: Path = Path("/var/lib/ci-agent")
    serial_number: str = ""
    model: str = "ci-capture-a1"
    firmware_version: str = "1.0.0"
    audio_device: str = "default"
    sample_rate: int = 16000
    channels: int = 1
    chunk_size_bytes: int = 4 * MIB
    heartbeat_interval_s: float = 60.0
    plan_refresh_interval_s: float = 300.0
    plan_horizon_hours: float = 36.0
    reconcile_interval_s: float = 1.0
    upload_interval_s: float = 30.0
    upload_max_attempts_per_cycle: int = 5
    upload_backoff_base_s: float = 2.0
    upload_backoff_max_s: float = 300.0
    uploaded_retention_hours: float = 24.0
    spool_soft_limit_bytes: int = 20 * GIB
    spool_hard_limit_bytes: int = 28 * GIB
    max_clock_skew_s: float = 120.0
    http_timeout_s: float = 30.0
    # Remote commands (phase 4). Rebooting needs a polkit rule (deploy/50-ci-agent.rules).
    reboot_command: str = "systemctl reboot"
    rotate_logs_command: str = ""
    command_timeout_s: float = 60.0
    self_test_capture_s: float = 2.0
    self_test_min_mic_dbfs: float = -60.0
    # Optional rotating file log in addition to stderr/journald ("" = disabled).
    log_file: str = ""
    log_max_bytes: int = 10 * MIB
    log_backup_count: int = 5

    @property
    def identity_dir(self) -> Path:
        return self.data_dir / "identity"

    @property
    def private_key_path(self) -> Path:
        return self.identity_dir / "device.key"

    @property
    def registration_path(self) -> Path:
        return self.identity_dir / "registration.json"

    @property
    def spool_dir(self) -> Path:
        return self.data_dir / "spool"

    @property
    def plan_cache_path(self) -> Path:
        return self.data_dir / "plan-cache.json"

    @property
    def command_state_path(self) -> Path:
        return self.data_dir / "commands.json"


def _coerce(name: str, raw: Any) -> Any:
    template = AgentConfig()
    current = getattr(template, name)
    if isinstance(current, Path):
        return Path(str(raw))
    if isinstance(current, bool):
        return str(raw).lower() in {"1", "true", "yes"}
    if isinstance(current, int):
        return int(raw)
    if isinstance(current, float):
        return float(raw)
    return str(raw)


def load_config(path: Path | None = None, env: dict[str, str] | None = None) -> AgentConfig:
    """Load config from TOML (``[agent]`` table or top-level keys) then apply env overrides."""
    env = dict(os.environ) if env is None else env
    known = {f.name for f in fields(AgentConfig)}
    values: dict[str, Any] = {}
    config_path = path or Path(env.get("CI_AGENT_CONFIG", str(DEFAULT_CONFIG_PATH)))
    if config_path.exists():
        with config_path.open("rb") as fh:
            data = tomllib.load(fh)
        table = data.get("agent", data)
        for key, value in table.items():
            if key not in known:
                raise ValueError(f"unknown config key: {key}")
            values[key] = _coerce(key, value)
    for name in known:
        env_key = f"CI_AGENT_{name.upper()}"
        if env_key in env:
            values[name] = _coerce(name, env[env_key])
    config = replace(AgentConfig(), **values)
    if config.spool_hard_limit_bytes < config.spool_soft_limit_bytes:
        raise ValueError("spool_hard_limit_bytes must be >= spool_soft_limit_bytes")
    if not 0 < config.chunk_size_bytes <= 16 * MIB:
        raise ValueError("chunk_size_bytes must be in (0, 16 MiB]")
    return config
