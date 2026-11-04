"""``ci-agent`` command line: ``init``, ``register``, ``run``, ``status``."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import signal
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

from ci_agent.agent import Agent, AgentSettings
from ci_agent.api import DeviceManagementApi, IngestionApi, register_device
from ci_agent.commands import CommandDeps, CommandRunner, build_handlers, parse_command_line
from ci_agent.config import AgentConfig, load_config
from ci_agent.fsutil import atomic_write_json, read_json
from ci_agent.identity import DeviceIdentity
from ci_agent.recorder import ArecordSource, AudioSource, FakeSource, Recorder
from ci_agent.scheduler import ClockGuard, PlanStore
from ci_agent.spool import Spool
from ci_agent.uploader import Uploader

log = logging.getLogger("ci_agent")


def _registration(config: AgentConfig) -> dict[str, Any]:
    if not config.registration_path.exists():
        raise SystemExit("device not registered: run `ci-agent register --token <token>`")
    data: dict[str, Any] = read_json(config.registration_path)
    return data


def cmd_init(config: AgentConfig, _args: argparse.Namespace) -> int:
    identity = DeviceIdentity.load_or_create(config.private_key_path)
    print(json.dumps({"publicKeyFingerprint": identity.public_key_fingerprint()}))
    return 0


def cmd_register(config: AgentConfig, args: argparse.Namespace) -> int:
    if not config.serial_number:
        raise SystemExit("serial_number must be configured")
    if config.registration_path.exists() and not args.force:
        raise SystemExit("already registered (use --force to re-register)")
    identity = DeviceIdentity.load_or_create(config.private_key_path)
    result = register_device(
        config.device_management_url,
        provisioning_token=args.token,
        serial_number=config.serial_number,
        model=config.model,
        firmware_version=config.firmware_version,
        identity=identity,
        timeout=config.http_timeout_s,
    )
    atomic_write_json(
        config.registration_path,
        {
            "deviceId": result["deviceId"],
            "certificate": result["certificate"],
            "certificatePayload": result.get("certificatePayload"),
        },
        mode=0o600,
    )
    print(json.dumps({"deviceId": result["deviceId"]}))
    return 0


def build_agent(config: AgentConfig, fake_audio: bool = False) -> Agent:
    registration = _registration(config)
    device_id = str(registration["deviceId"])
    identity = DeviceIdentity.load(config.private_key_path)
    dm = DeviceManagementApi(
        config.device_management_url, identity, device_id, timeout=config.http_timeout_s
    )
    ingestion = IngestionApi(
        config.ingestion_url, identity, device_id, timeout=config.http_timeout_s
    )
    spool = Spool(
        config.spool_dir,
        config.spool_soft_limit_bytes,
        config.spool_hard_limit_bytes,
        config.sample_rate,
        config.channels,
    )

    def source() -> AudioSource:
        if fake_audio:
            return FakeSource(config.sample_rate, config.channels, realtime=True)
        return ArecordSource(config.audio_device, config.sample_rate, config.channels)

    agent = Agent(
        AgentSettings(
            device_id=device_id,
            firmware_version=config.firmware_version,
            data_dir=config.data_dir,
            plan_horizon=timedelta(hours=config.plan_horizon_hours),
            heartbeat_interval=timedelta(seconds=config.heartbeat_interval_s),
            upload_interval=timedelta(seconds=config.upload_interval_s),
            uploaded_retention=timedelta(hours=config.uploaded_retention_hours),
            reconcile_interval_s=config.reconcile_interval_s,
        ),
        plan_client=dm,
        event_client=ingestion,
        plans=PlanStore(config.plan_cache_path, config.plan_refresh_interval_s),
        clock_guard=ClockGuard(config.max_clock_skew_s),
        spool=spool,
        recorder=Recorder(spool, source),
        uploader=Uploader(
            ingestion,
            spool,
            device_id,
            config.firmware_version,
            config.chunk_size_bytes,
            max_attempts_per_cycle=config.upload_max_attempts_per_cycle,
            backoff_base_s=config.upload_backoff_base_s,
            backoff_max_s=config.upload_backoff_max_s,
        ),
    )
    agent.commands = CommandRunner(
        build_handlers(
            CommandDeps(
                data_dir=config.data_dir,
                source_factory=source,
                recorder_active=lambda: agent.recorder.active is not None,
                before_reboot=agent.stop_recording_for_reboot,
                upload_now=agent.upload_now,
                refresh_plan=agent.refresh_plan_now,
                clock_skew_ms=lambda: agent.clock_guard.skew_ms,
                probe_urls={
                    "deviceManagement": config.device_management_url,
                    "ingestion": config.ingestion_url,
                },
                reboot_command=parse_command_line(config.reboot_command),
                rotate_logs_command=parse_command_line(config.rotate_logs_command),
                command_timeout_s=config.command_timeout_s,
                self_test_capture_s=config.self_test_capture_s,
                min_mic_dbfs=config.self_test_min_mic_dbfs,
            )
        ),
        reporter=dm,
        state_path=config.command_state_path,
        clock=lambda: agent.now(),
    )
    return agent


def cmd_run(config: AgentConfig, args: argparse.Namespace) -> int:
    agent = build_agent(config, fake_audio=args.fake_audio)

    async def main() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        await agent.run(stop)

    asyncio.run(main())
    return 0


def cmd_status(config: AgentConfig, _args: argparse.Namespace) -> int:
    spool = Spool(config.spool_dir, config.spool_soft_limit_bytes, config.spool_hard_limit_bytes)
    stats = spool.stats()
    reg = read_json(config.registration_path) if config.registration_path.exists() else {}
    plans = PlanStore(config.plan_cache_path, config.plan_refresh_interval_s)
    print(
        json.dumps(
            {
                "deviceId": reg.get("deviceId"),
                "planFetchedAt": plans.fetched_at.isoformat() if plans.fetched_at else None,
                "queuedRecordings": stats.queued_recordings,
                "queuedBytes": stats.queued_bytes,
                "evictedRecordings": stats.evicted_recordings,
                "orphanFiles": [p.name for p in spool.orphans()],
            },
            indent=2,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ci-agent")
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--log-level", default="INFO")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="generate the device key pair")
    reg = sub.add_parser("register", help="register with a provisioning token")
    reg.add_argument("--token", required=True)
    reg.add_argument("--force", action="store_true")
    run = sub.add_parser("run", help="run the capture agent")
    run.add_argument("--fake-audio", action="store_true", help="use a test tone, not ALSA")
    sub.add_parser("status", help="print local spool and plan status")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    config = load_config(args.config)
    if config.log_file:
        handler = logging.handlers.RotatingFileHandler(
            config.log_file, maxBytes=config.log_max_bytes, backupCount=config.log_backup_count
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        logging.getLogger().addHandler(handler)
    handlers = {"init": cmd_init, "register": cmd_register, "run": cmd_run, "status": cmd_status}
    return handlers[args.command](config, args)


if __name__ == "__main__":
    raise SystemExit(main())
