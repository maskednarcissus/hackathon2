# ADR-004: Primary Speech-to-Text Infrastructure & Evaluation Strategy

- **Status:** Accepted (Subject to Phase 0.6 Benchmarking)
- **Date:** 2026-11-04
- **Deciders:** ML Engineering, Audio Processing Lead
- **Technical Story:** Phase 0.6 & Phase 1.10 Speech-to-Text Pipeline

---

## Context

Classroom audio is an exceptionally difficult acoustic environment:

- Classroom reverberation, echo, HVAC noise, and student side-conversations.
- Brazilian Portuguese with wide regional phonological variance (São Paulo, Rio de Janeiro, Northeast, South).
- Heavy academic jargon across disciplines: Medicine (anatomical terms, pharmacology), Law (Latin legal concepts, Brazilian constitutional terms), Engineering, and Economics.
- Lecture durations of 60 to 120 minutes with multi-turn discussions.
- Critical need for millisecond-accurate timestamps and speaker turns.

---

## Decision

1. **Primary Cloud STT Provider:** **Google Cloud Speech-to-Text v2 using the Chirp / Chirp 2 foundation model** (via Google Vertex AI / Cloud Speech API).
   - Language configuration: `pt-BR`.
   - Feature flags: Automatic punctuation, word-level confidence scores, and spoken punctuation.
2. **Evaluation Framework (Phase 0.6):**
   - The platform will benchmark Google Chirp against OpenAI Whisper Large v3 (self-hosted), Deepgram Nova-2, and AWS Transcribe.
   - Benchmark criteria:
     - Word Error Rate (WER) on Brazilian Portuguese academic test corpora (< 10%).
     - Specialized academic terminology recognition rate (> 90%).
     - Timestamp alignment accuracy (within ±500ms).
     - Processing latency (must achieve at least 3x faster than real-time playback).
     - Operating cost per lecture hour.
3. **Domain Vocabulary Adaptation:**
   - The `transcription` service will maintain institution- and discipline-specific speech phrase adaptation sets (speech contexts / custom vocabulary lists) passed to the STT engine.

---

## Consequences

### Positive

- Google Chirp provides leading accuracy on Brazilian Portuguese conversational and specialized speech.
- Co-location in GCP South America East (`southamerica-east1`) minimizes egress costs and fulfills local data residency preferences.
- Native integration with Cloud Pub/Sub and Cloud Storage streaming.

### Negative / Trade-offs

- Cloud STT cost per hour must be monitored closely to ensure unit economics stay within margin targets.
- Local edge fallback or offline processing is not supported in Phase 1 (requires internet uplink from classroom device).
