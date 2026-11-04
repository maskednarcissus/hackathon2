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

| Metric               | How                                                         |
| -------------------- | ----------------------------------------------------------- |
| WER                  | word-level Levenshtein distance / reference words           |
| CER                  | character-level Levenshtein distance / reference characters |
| Terminology accuracy | Σ min(hyp, ref) / Σ ref occurrences of the case's `terms`   |

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

## Languages (Phase 6.4)

Normalisation is language-aware (`language` per case, manifest `language`, or `--language`):
spoken symbols (`&`, `%`, `+`, `=`) become the language's words, French ligatures are expanded,
and `--drop-fillers` removes hesitations (`ahn`/`uh, um`/`eh`/`euh`…). Supported: `pt-BR`
(default), `en-US`, `es-ES`, `es-419`, `fr-FR`.

## Diarization DER (Phase 6.1)

```bash
.venv/bin/python tests/audio-evaluation/run_benchmark.py --diarization --systems v1,v2
```

`diarization/manifest.yaml` lists synthetic multi-speaker cases (rendered by
`diarization/synthetic.py`, including overlapped speech) and slots for labelled real data
(RTTM/JSON reference + WAV or hypothesis, under `diarization/corpus/`, gitignored). DER =
(missed + false alarm + confusion) / reference speech on a 10 ms grid, overlap scored, optimal
one-to-one speaker mapping, 250 ms collar by default (`--collar-ms`). Exit code 1 if a case
exceeds its `expected_der_max` or v2 regresses against v1.
