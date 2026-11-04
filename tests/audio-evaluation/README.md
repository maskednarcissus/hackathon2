# Audio Evaluation

Representative classroom recordings for transcription and audio quality benchmarking.

## Coverage targets

- Different classroom sizes (small seminar, standard, lecture hall)
- Different microphone placements
- Brazilian regional accents
- Background noise conditions
- Reverberation levels
- Multiple simultaneous speakers
- Technical terminology (medicine, law, engineering, economics)
- Quiet speakers
- Overlapping speech
- Long lectures (90-120 minutes)

> Note: Actual recordings and their transcripts are excluded from version control (LGPD).
> Place them under `corpus/<case id>/` (gitignored) — see `benchmark-manifest.yaml`.

## Benchmark runner

`run_benchmark.py` scores each manifest case and writes `results.json` + `report.md`:

| Metric | How |
|---|---|
| WER | word-level Levenshtein distance / reference words |
| CER | character-level Levenshtein distance / reference characters |
| Terminology accuracy | Σ min(hyp, ref) / Σ ref occurrences of the case's `terms` |

Text normalisation (pt-BR): NFKC, casefold, punctuation removed (intra-word `-` and `'`
kept), numbers kept as written. `--accent-insensitive` additionally strips diacritics.

```bash
.venv/bin/python tests/audio-evaluation/run_benchmark.py \
  --manifest tests/audio-evaluation/benchmark-manifest.yaml \
  --hypothesis-dir out/chirp_2 \
  --output tests/audio-evaluation/results
```

Hypotheses can be plain `.txt` or the transcript JSON stored by transcript-management
(`{"segments": [{"text": …}]}`). Cases with no data are reported as `missing_data`; the
exit code is `1` if any evaluated case misses its thresholds (or, with `--require-data`,
if any case lacks data).

Tests: `.venv/bin/pytest tests/audio-evaluation`.
