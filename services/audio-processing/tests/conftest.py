from __future__ import annotations

from pathlib import Path

import pytest

from audio_processing.adapters.memory import InMemoryObjectStore
from tests.test_pipeline import Harness, make_harness


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    return make_harness(tmp_path, InMemoryObjectStore())
