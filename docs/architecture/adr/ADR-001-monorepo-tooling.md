# ADR-001: Monorepo Architecture and Tooling

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Architecture Team, Platform Engineering
- **Technical Story:** Phase 0.1 Monorepo Tooling Setup

---

## Context

Classroom Intelligence is an integrated platform combining dedicated classroom hardware, an audio ingestion and ML processing pipeline (speech-to-text, diarization, LLM reasoning), application business logic, shared libraries, and user-facing web applications across three distinct user roles (Students, Faculty, Institutional Administrators).

Key constraints:
1. Heterogeneous stack: Python 3.12+ for audio processing, deep learning pipelines, and LLM orchestration; TypeScript 5.5+ for web applications (Next.js 15), backend APIs (Fastify), and shared domain schemas.
2. High code reuse requirements: Academic data types, event schemas (Zod/Pydantic), and design system tokens must remain synchronized between UI apps and backend APIs.
3. Strict build-pipeline requirements: Changes in hardware firmware or Python ingestion services should not trigger unnecessary rebuilds of student-facing web applications.

---

## Decision

We adopt a **modular monorepo structure** orchestrated by **pnpm workspaces** and **Turborepo** for Node/TypeScript, paired with standardized PEP 621 (`pyproject.toml`) and `uv` for Python environments.

```
classroom-intelligence/
├── apps/               # Next.js 15 web applications and Fastify API
├── services/           # Domain microservices (Python 3.12 + TypeScript)
├── packages/           # Shared packages (@ci/types, @ci/schemas, @ci/ui, etc.)
├── hardware/           # Firmware, device protocols, provisioning
├── infrastructure/     # Terraform, Docker Compose, monitoring
├── data/               # Schemas, migrations, seeds
├── docs/               # Architecture, ADRs, compliance, hardware guides
└── tests/              # E2E, benchmarks, security, audio eval
```

### Key Tooling Choices:
- **Package Manager:** `pnpm` (strict symlinked dependency tree, disk efficiency).
- **Task Runner:** `Turborepo` (`turbo.json` caching builds, linting, typechecks across TypeScript packages).
- **Python Package Management:** `pyproject.toml` with `ruff` (linter/formatter) and `mypy` (strict type checking).
- **Linter & Formatter:** ESLint 8 + `@typescript-eslint` + Prettier for web/TS; Ruff for Python.

---

## Consequences

### Positive
- Unified repository simplifies end-to-end integration testing, schema evolution, and atomic PR commits touching schema, backend, and frontend.
- TypeScript packages (`@ci/types`, `@ci/schemas`) can be imported directly via workspace protocol (`workspace:*`) with zero latency.
- Turborepo remote caching accelerates CI/CD pipelines significantly.

### Negative / Trade-offs
- Requires developers to maintain both Node.js (20+) and Python (3.12+) local development environments.
- Python packages are not managed directly by Turborepo, requiring separate GitHub Actions matrix jobs.

---

## Alternatives Considered

1. **Polyrepo:** Each service in its own repository. Rejected due to high overhead in cross-service contract syncing and synchronized release friction.
2. **Nx Monorepo:** Rejected due to excessive plugin overhead and complex configuration for mixed Python-TypeScript architectures.
3. **Bazel:** Rejected due to steep learning curve and disproportionate setup complexity for initial phases.
