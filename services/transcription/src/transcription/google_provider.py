"""Google Cloud Speech-to-Text v2 (Chirp 2) adapter — ADR-004.

Imported lazily: install with ``pip install -e ".[gcp]"``. Not exercised by unit tests
(no credentials in CI); the request mapping is covered by ``build_recognition_config``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from transcription.models import AudioSegmentRef, Word
from transcription.ports import (
    ProviderError,
    ProviderResult,
    RecognitionConfig,
    TransientProviderError,
)

_TRANSIENT = (
    "ServiceUnavailable",
    "DeadlineExceeded",
    "ResourceExhausted",
    "InternalServerError",
    "Aborted",
    "TooManyRequests",
)


def _ms(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, timedelta):
        return int(round(value.total_seconds() * 1000))
    seconds = getattr(value, "seconds", 0)
    nanos = getattr(value, "nanos", 0)
    return int(seconds) * 1000 + int(nanos) // 1_000_000


def build_recognition_config(model: str, config: RecognitionConfig) -> dict[str, Any]:
    """Plain-dict RecognitionConfig (proto-plus accepts mappings)."""
    cfg: dict[str, Any] = {
        "auto_decoding_config": {},
        "language_codes": [config.language],
        "model": model,
        "features": {
            "enable_automatic_punctuation": True,
            "enable_word_time_offsets": True,
            "enable_word_confidence": True,
        },
    }
    if config.phrases:
        cfg["adaptation"] = {
            "phrase_sets": [
                {
                    "inline_phrase_set": {
                        "phrases": [
                            {"value": p, "boost": config.phrase_boost} for p in config.phrases
                        ]
                    }
                }
            ]
        }
    return cfg


@dataclass
class GoogleChirpProvider:
    project_id: str
    location: str = "southamerica-east1"
    model: str = "chirp_2"
    operation_timeout_s: float = 3600.0
    name: str = "google-speech-v2"

    def __post_init__(self) -> None:
        from google.api_core.client_options import ClientOptions
        from google.cloud.speech_v2 import SpeechAsyncClient

        endpoint = (
            "speech.googleapis.com"
            if self.location == "global"
            else f"{self.location}-speech.googleapis.com"
        )
        self._client = SpeechAsyncClient(client_options=ClientOptions(api_endpoint=endpoint))

    @property
    def recognizer(self) -> str:
        return f"projects/{self.project_id}/locations/{self.location}/recognizers/_"

    async def transcribe(
        self, segment: AudioSegmentRef, config: RecognitionConfig
    ) -> ProviderResult:
        from google.cloud.speech_v2.types import cloud_speech

        uri = segment.storage_uri
        if not uri.startswith("gs://"):
            raise ProviderError(f"Google Speech v2 batch requires a gs:// URI, got {uri!r}")
        request = cloud_speech.BatchRecognizeRequest(
            recognizer=self.recognizer,
            config=cloud_speech.RecognitionConfig(
                mapping=build_recognition_config(self.model, config)
            ),
            files=[cloud_speech.BatchRecognizeFileMetadata(uri=uri)],
            recognition_output_config=cloud_speech.RecognitionOutputConfig(
                inline_response_config=cloud_speech.InlineOutputConfig()
            ),
        )
        try:
            operation = await self._client.batch_recognize(request=request)
            response = await operation.result(timeout=self.operation_timeout_s)
        except Exception as exc:
            if exc.__class__.__name__ in _TRANSIENT or isinstance(exc, TimeoutError):
                raise TransientProviderError(str(exc)) from exc
            raise ProviderError(str(exc)) from exc

        file_result = response.results[uri]
        if file_result.error and file_result.error.code:
            raise ProviderError(f"{uri}: {file_result.error.message}")

        speakers: dict[str, int] = {}
        words: list[Word] = []
        for result in file_result.transcript.results:
            if not result.alternatives:
                continue
            for w in result.alternatives[0].words:
                tag: int | None = None
                label = getattr(w, "speaker_label", "") or ""
                if label:
                    tag = speakers.setdefault(label, len(speakers) + 1)
                words.append(
                    Word(
                        word=w.word,
                        start_ms=_ms(w.start_offset),
                        end_ms=_ms(w.end_offset),
                        confidence=min(1.0, max(0.0, float(w.confidence or 0.0))),
                        speaker_tag=tag,
                    )
                )
        return ProviderResult(words=words, detected_language=config.language)
