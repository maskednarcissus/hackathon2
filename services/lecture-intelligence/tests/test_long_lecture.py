from __future__ import annotations

import re
from typing import Any

from conftest import Harness, structure_body

SENTENCES = [
    "Vamos revisar a teoria quantitativa da moeda e a velocidade de circulação do dinheiro.",
    "A política fiscal expansionista aumenta os gastos do governo e pode pressionar os preços.",
    "O câmbio flutuante absorve choques externos, mas transmite volatilidade para a inflação.",
    "As expectativas dos agentes econômicos são ancoradas pela credibilidade do Banco Central.",
]


def _ninety_minute_texts() -> list[str]:
    # 90 minutes of 5-second segments = 1080 segments.
    return [f"{SENTENCES[i % len(SENTENCES)]} Parte {i}." for i in range(1080)]


def _map(payload: dict[str, Any]) -> dict[str, Any]:
    indexes = [int(m) for m in re.findall(r"\[s(\d+) ", payload["untrustedInputs"]["transcript"])]
    first, last = indexes[0], indexes[-1]
    return {
        "title": f"Trecho {payload['variables']['chunkIndex']}",
        "executiveSummary": "Revisão de conceitos macroeconômicos.",
        "topics": [
            {"title": "Teoria quantitativa da moeda", "segmentIndexes": [first]},
            {"title": "Expectativas e credibilidade", "segmentIndexes": [last]},
        ],
        "concepts": [
            {
                "term": "Câmbio flutuante",
                "definition": "Absorve choques externos e transmite volatilidade.",
                "segmentIndexes": [first + 2],
            }
        ],
    }


def _merge(payload: dict[str, Any]) -> dict[str, Any]:
    assert '"chunk": 1' in payload["untrustedInputs"]["partials"]
    return {
        "title": "Revisão de macroeconomia monetária",
        "executiveSummary": "A aula revisou moeda, política fiscal, câmbio e expectativas.",
        "topics": [
            {"title": "Teoria quantitativa da moeda", "segmentIndexes": [0, 4]},
            {"title": "Expectativas e credibilidade", "segmentIndexes": [1075, 1079]},
            {"title": "Tópico inventado no merge", "segmentIndexes": [5000]},
        ],
    }


def test_ninety_minute_lecture_is_chunked_mapped_and_merged() -> None:
    harness = Harness(max_chunk_tokens=8_000)
    harness.gateway.responders["lecture-structuring"] = _map
    harness.gateway.responders["lecture-structuring-merge"] = _merge
    body = structure_body(_ninety_minute_texts())
    for seg in body["segments"]:
        seg["startMs"] = seg["segmentIndex"] * 5000
        seg["endMs"] = seg["startMs"] + 4900

    response = harness.client.post("/v1/lectures/structure", json=body)
    assert response.status_code == 201, response.text
    result = response.json()

    maps = [p for p in harness.gateway.payloads if p["promptId"] == "lecture-structuring"]
    merges = [p for p in harness.gateway.payloads if p["promptId"] == "lecture-structuring-merge"]
    assert len(maps) >= 3 and len(merges) == 1
    assert result["provenance"]["chunkCount"] == len(maps)
    assert len(result["provenance"]["aiRequestIds"]) == len(maps) + 1
    # Each map call carries only its own chunk.
    seen: list[int] = []
    for payload in maps:
        seen += [int(m) for m in re.findall(r"\[s(\d+) ", payload["untrustedInputs"]["transcript"])]
        assert payload["variables"]["chunkCount"] == len(maps)
    assert seen == list(range(1080))

    assert result["title"] == "Revisão de macroeconomia monetária"
    assert [t["title"] for t in result["topics"]] == [
        "Teoria quantitativa da moeda",
        "Expectativas e credibilidade",
    ]
    assert result["topics"][1]["endMs"] == 1079 * 5000 + 4900
    assert {"path": "merge.topics[2]", "reason": "invalid_segment_reference"} in result[
        "validation"
    ]["flags"]
    # Concept repeated in every chunk is deduplicated with merged citations.
    assert len(result["concepts"]) == 1
    assert len(result["concepts"][0]["segmentIndexes"]) == len(maps)
