"""Call instrumentation records, usage aggregation and per-institution budgets.

Records intentionally hold *hashes and sizes* of variables and untrusted inputs — never the
raw transcript — so the call log does not become a second copy of classroom speech.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass
class CallRecord:
    request_id: str
    created_at: datetime
    institution_id: str
    requested_by: str
    task: str
    prompt_id: str
    prompt_version: str
    prompt_sha256: str
    variables_sha256: str
    untrusted_input_chars: dict[str, int]
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    attempts: int = 0
    outcome: str = "pending"  # valid | schema_validation_failed | provider_error | budget_exceeded
    validation_errors: list[str] = field(default_factory=list)
    injection_suspected: bool = False
    injection_signals: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        return {
            "requestId": data["request_id"],
            "createdAt": self.created_at.isoformat(),
            "institutionId": self.institution_id,
            "requestedBy": self.requested_by,
            "task": self.task,
            "prompt": {
                "id": self.prompt_id,
                "version": self.prompt_version,
                "sha256": self.prompt_sha256,
            },
            "variablesSha256": self.variables_sha256,
            "untrustedInputChars": self.untrusted_input_chars,
            "model": {"provider": self.provider, "name": self.model},
            "usage": {
                "inputTokens": self.input_tokens,
                "outputTokens": self.output_tokens,
                "costUsd": self.cost_usd,
            },
            "latencyMs": self.latency_ms,
            "attempts": self.attempts,
            "outcome": self.outcome,
            "validationErrors": self.validation_errors,
            "safety": {
                "injectionSuspected": self.injection_suspected,
                "injectionSignals": self.injection_signals,
            },
        }


class CallRepository(Protocol):
    async def reserve(
        self, record: CallRecord, budget_usd: float | None, month_start: datetime
    ) -> tuple[bool, float]:
        """Atomically check the month-to-date spend against ``budget_usd`` and insert ``record``.

        ``record.cost_usd`` holds the pre-call cost estimate (a reservation), so concurrent
        in-flight calls count against the budget. Returns ``(allowed, spent_before)``; when not
        allowed the record is stored with outcome ``budget_exceeded``.
        """
        ...

    async def save(self, record: CallRecord) -> None: ...

    async def get(self, request_id: str) -> CallRecord | None: ...

    async def query(
        self,
        institution_id: str | None,
        start: datetime | None,
        end: datetime | None,
    ) -> list[CallRecord]: ...

    async def month_spend(self, institution_id: str, month_start: datetime) -> float: ...


class InMemoryCallRepository:
    def __init__(self) -> None:
        self._records: dict[str, CallRecord] = {}

    async def reserve(
        self, record: CallRecord, budget_usd: float | None, month_start: datetime
    ) -> tuple[bool, float]:
        # No await between check and insert: atomic within the event loop.
        spent = await self.month_spend(record.institution_id, month_start)
        allowed = budget_usd is None or spent < budget_usd
        if not allowed:
            record.outcome = "budget_exceeded"
            record.cost_usd = 0.0
        self._records[record.request_id] = record
        return allowed, spent

    async def save(self, record: CallRecord) -> None:
        self._records[record.request_id] = record

    async def get(self, request_id: str) -> CallRecord | None:
        return self._records.get(request_id)

    async def query(
        self,
        institution_id: str | None,
        start: datetime | None,
        end: datetime | None,
    ) -> list[CallRecord]:
        return [
            r
            for r in self._records.values()
            if (institution_id is None or r.institution_id == institution_id)
            and (start is None or r.created_at >= start)
            and (end is None or r.created_at < end)
        ]

    async def month_spend(self, institution_id: str, month_start: datetime) -> float:
        records = await self.query(institution_id, month_start, None)
        return round(sum(r.cost_usd for r in records), 8)


class BudgetRepository(Protocol):
    async def get(self, institution_id: str) -> float | None: ...

    async def set(self, institution_id: str, monthly_usd: float | None) -> None: ...


class InMemoryBudgetRepository:
    def __init__(self, default_monthly_usd: float | None = None) -> None:
        self._default = default_monthly_usd
        self._budgets: dict[str, float | None] = {}

    async def get(self, institution_id: str) -> float | None:
        return self._budgets.get(institution_id, self._default)

    async def set(self, institution_id: str, monthly_usd: float | None) -> None:
        self._budgets[institution_id] = monthly_usd


def summarise(records: list[CallRecord]) -> dict[str, Any]:
    def bucket() -> dict[str, Any]:
        return {"calls": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0}

    totals = bucket()
    groups: dict[str, dict[str, dict[str, Any]]] = {
        "byTask": defaultdict(bucket),
        "byModel": defaultdict(bucket),
        "byPromptVersion": defaultdict(bucket),
        "byOutcome": defaultdict(bucket),
    }
    for r in records:
        keys = {
            "byTask": r.task,
            "byModel": f"{r.provider}/{r.model}",
            "byPromptVersion": f"{r.prompt_id}@{r.prompt_version}",
            "byOutcome": r.outcome,
        }
        for target in [totals, *(groups[g][k] for g, k in keys.items())]:
            target["calls"] += 1
            target["inputTokens"] += r.input_tokens
            target["outputTokens"] += r.output_tokens
            target["costUsd"] = round(target["costUsd"] + r.cost_usd, 8)
    return {
        "totals": totals,
        **{name: [{"key": k, **v} for k, v in sorted(g.items())] for name, g in groups.items()},
    }
