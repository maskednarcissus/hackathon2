import json
from pathlib import Path

from transcription.google_provider import build_recognition_config
from transcription.ports import RecognitionConfig
from transcription.vocabulary import VocabularyCatalog


def test_vocabulary_merges_and_deduplicates(tmp_path: Path) -> None:
    path = tmp_path / "vocab.json"
    path.write_text(
        json.dumps(
            {
                "default": ["Ementa", "prova"],
                "disciplines": {"law": ["habeas corpus", "PROVA"]},
                "institutions": {"inst": {"*": ["vade mecum"], "law": ["STF"]}},
            }
        ),
        encoding="utf-8",
    )
    catalog = VocabularyCatalog.load(path)
    assert catalog.phrases_for("inst", "law") == (
        "Ementa",
        "prova",
        "habeas corpus",
        "vade mecum",
        "STF",
    )
    assert catalog.phrases_for(None, None) == ("Ementa", "prova")
    assert VocabularyCatalog.load(None).phrases_for("x", "y") == ()


def test_google_recognition_config_mapping() -> None:
    cfg = build_recognition_config("chirp_2", RecognitionConfig(phrases=("anamnese",)))
    assert cfg["language_codes"] == ["pt-BR"]
    assert cfg["model"] == "chirp_2"
    assert cfg["features"]["enable_word_time_offsets"] is True
    assert cfg["features"]["enable_word_confidence"] is True
    phrases = cfg["adaptation"]["phrase_sets"][0]["inline_phrase_set"]["phrases"]
    assert phrases == [{"value": "anamnese", "boost": 10.0}]
    assert "adaptation" not in build_recognition_config("chirp_2", RecognitionConfig())
