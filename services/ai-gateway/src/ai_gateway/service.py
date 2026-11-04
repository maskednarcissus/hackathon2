"""Core generation flow: prompt resolution, budget, safety, provider call, schema enforcement."""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from ai_gateway.audit import AuditClient
from ai_gateway.errors import GatewayError, ProviderError
from ai_gateway.models import GenerateRequest
from ai_gateway.pricing import PricingTable
from ai_gateway.prompts import PromptNotFoundError, PromptRegistry, PromptVersion, render_template
from ai_gateway.providers.base import GenerationProvider, Message, ProviderRequest
from ai_gateway.records import BudgetRepository, CallRecord, CallRepository
from ai_gateway.safety import STANDING_INSTRUCTION, detect_injection, wrap_untrusted

log = structlog.get_logger(__name__)

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)
MAX_SCHEMA_ATTEMPTS = 2


@dataclass
class GatewaySettings:
    provider_timeout_s: float = 60.0
    max_transient_retries: int = 3
    backoff_base_s: float = 0.5


class GatewayService:
    def __init__(
        self,
        *,
        registry: PromptRegistry,
        provider: GenerationProvider,
        calls: CallRepository,
        budgets: BudgetRepository,
        pricing: PricingTable,
        audit: AuditClient,
        settings: GatewaySettings | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.registry = registry
        self.provider = provider
        self.calls = calls
        self.budgets = budgets
        self.pricing = pricing
        self.audit = audit
        self.settings = settings or GatewaySettings()
        self.clock = clock
        self.sleep = sleep

    # ------------------------------------------------------------------ public API
    async def generate(self, req: GenerateRequest) -> dict[str, Any]:
        prompt = self._resolve_prompt(req)
        validator = self._validator(req.response_schema)
        signals = sorted(
            {s for text in req.untrusted_inputs.values() for s in detect_injection(text)}
        )
        model = prompt.model
        record = CallRecord(
            request_id=str(uuid.uuid4()),
            created_at=self.clock(),
            institution_id=req.institution_id,
            requested_by=req.requested_by,
            task=req.task,
            prompt_id=prompt.prompt_id,
            prompt_version=prompt.version,
            prompt_sha256=prompt.sha256,
            variables_sha256=_hash_inputs(req.variables, req.untrusted_inputs),
            untrusted_input_chars={k: len(v) for k, v in req.untrusted_inputs.items()},
            provider=self.provider.name,
            model=model,
            injection_suspected=bool(signals),
            injection_signals=signals,
        )
        self._check_budget(record)

        messages = [Message("user", self._render_user(prompt, req))]
        started = time.monotonic()
        output: Any = None
        try:
            for attempt in range(1, MAX_SCHEMA_ATTEMPTS + 1):
                provider_request = ProviderRequest(
                    task=req.task,
                    prompt_id=prompt.prompt_id,
                    model=model,
                    system=f"{prompt.system.rstrip()}\n\n{STANDING_INSTRUCTION}",
                    messages=list(messages),
                    response_schema=req.response_schema,
                    temperature=(
                        req.options.temperature
                        if req.options.temperature is not None
                        else prompt.temperature
                    ),
                    max_output_tokens=req.options.max_output_tokens or prompt.max_output_tokens,
                    metadata={"requestId": record.request_id},
                )
                response = await self._call_with_retries(provider_request, record)
                record.attempts = attempt
                record.model = response.model
                record.input_tokens += response.input_tokens
                record.output_tokens += response.output_tokens
                record.cost_usd = round(
                    record.cost_usd
                    + self.pricing.cost(
                        response.model, response.input_tokens, response.output_tokens
                    ),
                    8,
                )
                parsed, errors = _parse_and_validate(response.text, validator)
                if not errors:
                    output = parsed
                    record.outcome = "valid"
                    record.validation_errors = []
                    break
                record.validation_errors = errors
                messages += [
                    Message("model", response.text[:20000]),
                    Message("user", _correction_message(errors)),
                ]
            else:
                record.outcome = "schema_validation_failed"
        except ProviderError as exc:
            record.outcome = "provider_error"
            record.validation_errors = [str(exc)]
        finally:
            record.latency_ms = int((time.monotonic() - started) * 1000)
            self.calls.save(record)
            await self._audit(record)

        if record.outcome == "provider_error":
            raise GatewayError(
                "provider_error",
                "The model provider failed to produce a response",
                502,
                {"requestId": record.request_id, "reason": record.validation_errors[:1]},
            )
        if record.outcome != "valid":
            raise GatewayError(
                "schema_validation_failed",
                "Model output did not satisfy the response schema after a corrective retry",
                422,
                {"requestId": record.request_id, "errors": record.validation_errors},
            )
        return {
            "requestId": record.request_id,
            "output": output,
            "model": {"provider": record.provider, "name": record.model},
            "prompt": {"id": prompt.prompt_id, "version": prompt.version, "sha256": prompt.sha256},
            "usage": {
                "inputTokens": record.input_tokens,
                "outputTokens": record.output_tokens,
                "costUsd": record.cost_usd,
            },
            "latencyMs": record.latency_ms,
            "attempts": record.attempts,
            "safety": {"injectionSuspected": bool(signals), "injectionSignals": signals},
        }

    def month_to_date_spend(self, institution_id: str) -> float:
        now = self.clock()
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return round(sum(r.cost_usd for r in self.calls.query(institution_id, start, None)), 8)

    # ------------------------------------------------------------------ internals
    def _resolve_prompt(self, req: GenerateRequest) -> PromptVersion:
        try:
            prompt = self.registry.get(req.prompt_id, req.prompt_version)
        except PromptNotFoundError as exc:
            raise GatewayError("prompt_not_found", str(exc), 404) from exc
        if prompt.task != req.task:
            raise GatewayError(
                "task_mismatch",
                f"Prompt {prompt.prompt_id}@{prompt.version} serves task {prompt.task!r}",
                422,
            )
        return prompt

    @staticmethod
    def _validator(schema: dict[str, Any]) -> Draft202012Validator:
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as exc:
            raise GatewayError(
                "invalid_response_schema", f"responseSchema is not valid: {exc.message}", 400
            ) from exc
        return Draft202012Validator(schema)

    def _check_budget(self, record: CallRecord) -> None:
        budget = self.budgets.get(record.institution_id)
        if budget is None:
            return
        spent = self.month_to_date_spend(record.institution_id)
        if spent >= budget:
            record.outcome = "budget_exceeded"
            self.calls.save(record)
            raise GatewayError(
                "budget_exceeded",
                "The institution's monthly AI budget has been exhausted",
                429,
                {"monthlyBudgetUsd": budget, "monthToDateUsd": spent},
            )

    @staticmethod
    def _render_user(prompt: PromptVersion, req: GenerateRequest) -> str:
        values = {
            k: v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
            for k, v in req.variables.items()
        }
        placeholders = prompt.placeholders()
        trailing: list[str] = []
        for name, text in req.untrusted_inputs.items():
            wrapped = wrap_untrusted(name, text)
            key = f"untrusted.{name}"
            if key in placeholders:
                values[key] = wrapped
            else:
                trailing.append(wrapped)
        rendered = render_template(prompt.user_template, values)
        return "\n\n".join([rendered.rstrip(), *trailing]) if trailing else rendered

    async def _call_with_retries(self, request: ProviderRequest, record: CallRecord) -> Any:
        last_error: ProviderError | None = None
        for retry in range(self.settings.max_transient_retries + 1):
            try:
                return await asyncio.wait_for(
                    self.provider.generate(request), timeout=self.settings.provider_timeout_s
                )
            except TimeoutError:
                last_error = ProviderError("provider timeout", transient=True)
            except ProviderError as exc:
                last_error = exc
                if not exc.transient:
                    raise
            if retry < self.settings.max_transient_retries:
                delay = self.settings.backoff_base_s * (2**retry) * (1 + random.random() * 0.25)
                log.warning(
                    "provider_transient_error",
                    request_id=record.request_id,
                    retry=retry + 1,
                    error=str(last_error),
                )
                await self.sleep(delay)
        assert last_error is not None
        raise last_error

    async def _audit(self, record: CallRecord) -> None:
        try:
            await self.audit.record(
                {
                    "tenantId": record.institution_id,
                    "actorType": "system",
                    "action": "ai.generation",
                    "resourceType": "ai_call",
                    "resourceId": record.request_id,
                    "metadata": {
                        "task": record.task,
                        "requestedBy": record.requested_by,
                        "prompt": f"{record.prompt_id}@{record.prompt_version}",
                        "model": record.model,
                        "outcome": record.outcome,
                        "costUsd": record.cost_usd,
                        "injectionSuspected": record.injection_suspected,
                    },
                }
            )
        except Exception as exc:  # noqa: BLE001 - audit must never break generation
            log.warning("audit_failed", error=str(exc))


def _hash_inputs(variables: dict[str, Any], untrusted: dict[str, str]) -> str:
    canonical = json.dumps(
        {"variables": variables, "untrusted": untrusted}, sort_keys=True, ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _parse_and_validate(text: str, validator: Draft202012Validator) -> tuple[Any, list[str]]:
    match = _FENCE_RE.match(text)
    candidate = match.group(1) if match else text
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        return None, [f"invalid JSON: {exc.msg} at position {exc.pos}"]
    errors = sorted(validator.iter_errors(parsed), key=lambda e: list(e.absolute_path))
    messages = [f"{'/'.join(str(p) for p in e.absolute_path) or '$'}: {e.message}" for e in errors]
    return parsed, messages[:10]


def _correction_message(errors: list[str]) -> str:
    bullet = "\n".join(f"- {e}" for e in errors)
    return (
        "Sua resposta anterior não é um JSON válido para o schema exigido. Erros:\n"
        f"{bullet}\n"
        "Responda novamente APENAS com o JSON corrigido, sem texto adicional e sem inventar "
        "informações que não estejam na transcrição."
    )
