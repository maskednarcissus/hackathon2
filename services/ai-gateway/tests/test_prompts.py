from __future__ import annotations

from pathlib import Path

import pytest

from ai_gateway.prompts import PromptRegistry, render_template


def _write(root: Path, prompt_id: str, version: str, task: str = "event_extraction") -> None:
    folder = root / prompt_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{version}.yaml").write_text(
        f'version: "{version}"\ntask: {task}\nmodel: gemini-2.5-flash\n'
        "system: sys\nuser_template: 'Olá {{name}} {{untrusted.transcript}}'\n",
        encoding="utf-8",
    )


def test_active_pointer_and_hash_change(tmp_path: Path) -> None:
    _write(tmp_path, "demo", "v1")
    _write(tmp_path, "demo", "v2")
    (tmp_path / "demo" / "active").write_text("v1\n")
    registry = PromptRegistry(tmp_path)
    assert registry.get("demo").version == "v1"
    assert registry.get("demo", "v2").version == "v2"
    old_hash = registry.get("demo", "v1").sha256
    (tmp_path / "demo" / "v1.yaml").write_text(
        'version: "v1"\ntask: event_extraction\nmodel: m\nsystem: changed\nuser_template: u\n'
    )
    registry.reload()
    assert registry.get("demo", "v1").sha256 != old_hash


def test_latest_version_is_active_without_pointer(tmp_path: Path) -> None:
    _write(tmp_path, "demo", "2026-01-01.1")
    _write(tmp_path, "demo", "2026-02-01.1")
    assert PromptRegistry(tmp_path).active_version("demo") == "2026-02-01.1"


def test_invalid_active_pointer_rejected(tmp_path: Path) -> None:
    _write(tmp_path, "demo", "v1")
    (tmp_path / "demo" / "active").write_text("v9")
    with pytest.raises(ValueError, match="does not exist"):
        PromptRegistry(tmp_path)


def test_version_must_match_filename(tmp_path: Path) -> None:
    folder = tmp_path / "demo"
    folder.mkdir()
    (folder / "v1.yaml").write_text(
        'version: "v2"\ntask: t\nmodel: m\nsystem: s\nuser_template: u\n'
    )
    with pytest.raises(ValueError, match="must match"):
        PromptRegistry(tmp_path)


def test_render_template() -> None:
    assert render_template("a {{ x }} b {{y}}", {"x": "1"}) == "a 1 b "
