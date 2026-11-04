"""Versioned prompt registry backed by YAML files.

Layout::

    prompts/<promptId>/<version>.yaml   # one immutable file per version
    prompts/<promptId>/active           # text file holding the active version string

The SHA-256 of a version is computed over the file bytes, so any edit to a published version
is detectable in call records.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")


@dataclass(frozen=True)
class PromptVersion:
    prompt_id: str
    version: str
    task: str
    system: str
    user_template: str
    model: str
    temperature: float
    max_output_tokens: int
    sha256: str
    changelog: str = ""
    variables: tuple[str, ...] = field(default_factory=tuple)

    def placeholders(self) -> set[str]:
        return set(_PLACEHOLDER_RE.findall(self.user_template))


class PromptNotFoundError(LookupError):
    pass


class PromptRegistry:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._versions: dict[str, dict[str, PromptVersion]] = {}
        self._active: dict[str, str] = {}
        self.reload()

    def reload(self) -> None:
        versions: dict[str, dict[str, PromptVersion]] = {}
        active: dict[str, str] = {}
        if self._root.is_dir():
            for prompt_dir in sorted(p for p in self._root.iterdir() if p.is_dir()):
                prompt_id = prompt_dir.name
                if not _ID_RE.match(prompt_id):
                    continue
                for file in sorted(prompt_dir.glob("*.yaml")):
                    pv = _load_version(prompt_id, file)
                    versions.setdefault(prompt_id, {})[pv.version] = pv
                active_file = prompt_dir / "active"
                if active_file.is_file():
                    active[prompt_id] = active_file.read_text(encoding="utf-8").strip()
                elif prompt_id in versions:
                    active[prompt_id] = sorted(versions[prompt_id])[-1]
        for prompt_id, version in active.items():
            if version not in versions.get(prompt_id, {}):
                raise ValueError(f"Active version {version!r} of {prompt_id!r} does not exist")
        self._versions = versions
        self._active = active

    def get(self, prompt_id: str, version: str | None = None) -> PromptVersion:
        versions = self._versions.get(prompt_id)
        if not versions:
            raise PromptNotFoundError(f"Unknown prompt {prompt_id!r}")
        resolved = version or self._active[prompt_id]
        if resolved not in versions:
            raise PromptNotFoundError(f"Unknown version {resolved!r} of prompt {prompt_id!r}")
        return versions[resolved]

    def active_version(self, prompt_id: str) -> str:
        if prompt_id not in self._active:
            raise PromptNotFoundError(f"Unknown prompt {prompt_id!r}")
        return self._active[prompt_id]

    def list(self) -> list[dict[str, Any]]:
        return [self.describe(prompt_id) for prompt_id in sorted(self._versions)]

    def describe(self, prompt_id: str) -> dict[str, Any]:
        versions = self._versions.get(prompt_id)
        if not versions:
            raise PromptNotFoundError(f"Unknown prompt {prompt_id!r}")
        return {
            "id": prompt_id,
            "activeVersion": self._active[prompt_id],
            "versions": [
                {
                    "version": pv.version,
                    "task": pv.task,
                    "model": pv.model,
                    "temperature": pv.temperature,
                    "sha256": pv.sha256,
                    "changelog": pv.changelog,
                    "active": pv.version == self._active[prompt_id],
                }
                for pv in sorted(versions.values(), key=lambda p: p.version)
            ],
        }


def _load_version(prompt_id: str, file: Path) -> PromptVersion:
    raw = file.read_bytes()
    data = yaml.safe_load(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{file}: prompt file must be a mapping")
    version = str(data.get("version", file.stem))
    if version != file.stem or not _VERSION_RE.match(version):
        raise ValueError(f"{file}: version {version!r} must match the file name")
    if data.get("id", prompt_id) != prompt_id:
        raise ValueError(f"{file}: id must match directory {prompt_id!r}")
    for key in ("task", "system", "user_template", "model"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ValueError(f"{file}: missing required string field {key!r}")
    return PromptVersion(
        prompt_id=prompt_id,
        version=version,
        task=data["task"],
        system=data["system"],
        user_template=data["user_template"],
        model=data["model"],
        temperature=float(data.get("temperature", 0.0)),
        max_output_tokens=int(data.get("max_output_tokens", 8192)),
        sha256=hashlib.sha256(raw).hexdigest(),
        changelog=str(data.get("changelog", "")).strip(),
        variables=tuple(data.get("variables", []) or []),
    )


def render_template(template: str, values: dict[str, str]) -> str:
    """Replace ``{{name}}`` placeholders. Unknown placeholders render as empty strings."""

    return _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), ""), template)
