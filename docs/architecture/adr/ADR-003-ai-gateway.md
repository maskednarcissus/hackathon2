# ADR-003: Centralized AI Gateway and LLM Orchestration

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** AI Engineering, Security Team, Architecture Team
- **Technical Story:** Phase 0.3 & Phase 2.1 AI Infrastructure & LLM Gateway

---

## Context

Classroom Intelligence requires numerous distinct AI workflows:
- Speech-to-text transcription and post-processing
- Speaker diarization refinement
- Lecture topic extraction and summarization
- Academic event extraction (exams, deadlines, cancellations)
- Relative date resolution
- Natural language student Q&A assistant

Challenges:
1. **Vendor Lock-in Risk:** While Google Gemini via Vertex AI is our primary provider, enterprise reliability demands model-provider abstraction.
2. **Cost & Rate Limit Management:** Video/audio lectures generate high token volumes; centralized token accounting, caching, and rate limiting are required.
3. **Security & Prompt Injection:** Transcripts contain untrusted student/professor statements (e.g., student jokingly saying "ignore all previous instructions"). Classroom speech must be treated strictly as untrusted data.
4. **Structured Output Reliability:** downstream systems (calendars, notifications) must receive guaranteed schema-valid JSON, rejecting hallucinations or ill-formed responses.

---

## Decision

We establish a dedicated service: **`services/ai-gateway`** acting as the sole intermediary between internal domain services and foundation models.

```
+----------------------------------------------------------------+
| Domain Services (lecture-intelligence, event-extraction, etc.)  |
+----------------------------------------------------------------+
                               |
                   Internal gRPC / REST API
                               v
+----------------------------------------------------------------+
|                     services/ai-gateway                        |
| - Provider Abstraction (Vertex AI Gemini, OpenAI, Claude)      |
| - Token & Cost Accounting per Tenant / Task                   |
| - Structured Schema Enforcement (Pydantic / Zod JSON Schemas)  |
| - Prompt Versioning & Prompt Injection Defense                 |
| - Retry, Timeout, Circuit Breaker & Caching                   |
+----------------------------------------------------------------+
                               |
                Encrypted HTTPS + IAM / WIF
                               v
+----------------------------------------------------------------+
|                   External AI Providers                        |
| - Primary: Google Cloud Vertex AI (Gemini 1.5 Pro / Flash)     |
| - Secondary: Failover / Evaluation Providers                   |
+----------------------------------------------------------------+
```

### Key Principles:
1. **Schema Validation:** All structured output tasks must enforce explicit Pydantic / Zod schemas (`packages/schemas`). Failed schemas trigger automatic single-shot retries before returning an unresolvable error.
2. **Untrusted Input Treatment:** Classroom transcripts are always injected into user/data roles with explicit delimiters and safety guardrails, never into system prompts.
3. **Auditing & Metrics:** Every LLM call records latency, prompt tokens, completion tokens, model name, and estimated cost tagged with the `tenant_institution_id`.

---

## Consequences

### Positive
- Domain services never directly call provider SDKs or store API keys.
- Fast, non-breaking model upgrades (e.g., swapping Gemini Flash versions).
- Deterministic guardrails protect downstream calendars from corrupt AI outputs.

### Negative / Trade-offs
- An additional network hop between domain services and external models.
- The gateway must be designed for high concurrency with connection pooling.
