"""
Classroom Intelligence — Transcription Benchmark Runner.

Computes Word Error Rate (WER) and Character Error Rate (CER) against reference transcripts.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml


def load_manifest(manifest_path: str) -> dict[str, Any]:
    with open(manifest_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)  # type: ignore[no-any-return]


def compute_wer(reference: str, hypothesis: str) -> float:
    ref_words = reference.lower().split()
    hyp_words = hypothesis.lower().split()

    r, h = len(ref_words), len(hyp_words)
    dp = [[0] * (h + 1) for _ in range(r + 1)]
    for i in range(r + 1):
        dp[i][0] = i
    for j in range(h + 1):
        dp[0][j] = j

    for i in range(1, r + 1):
        for j in range(1, h + 1):
            if ref_words[i - 1] == hyp_words[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])

    return dp[r][h] / max(r, 1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcription Benchmark")
    parser.add_argument("--manifest", default="tests/audio-evaluation/benchmark-manifest.yaml")
    parser.add_argument("--output", default="tests/audio-evaluation/results")
    args = parser.parse_args()

    manifest = load_manifest(args.manifest)
    print(f"Loaded {len(manifest.get('test_cases', []))} evaluation cases from {args.manifest}")
    print("Benchmark framework ready.")


if __name__ == "__main__":
    main()
