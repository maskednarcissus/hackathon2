# ADR-002: Operational and Analytical Data Architecture

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Data Engineering, Architecture Team
- **Technical Story:** Phase 0.4 Relational Academic Data Model & Analytics Strategy

---

## Context

The Classroom Intelligence platform serves large educational holding companies (e.g., hundreds of campuses, thousands of daily classes). The data layer must handle:
1. **Transactional integrity:** Multi-level academic hierarchies, class scheduling, event confirmations, calendar synchronizations, and immutable audit logs.
2. **Flexible intelligence storage:** Lecture outlines, extracted concepts, timestamps, and JSON-based event metadata.
3. **Data governance & compliance:** LGPD compliance requires granular retention policies (e.g., raw audio retention vs. transcript retention vs. official academic records) and reliable deletion/anonymization workflows.
4. **Aggregated group intelligence:** Complex cross-institution analytical queries across millions of transcript passages and academic outcomes without impacting operational application performance.

---

## Decision

We adopt a **two-tier data architecture**:
1. **Operational Database:** **PostgreSQL 16** (locally and in staging) and **Google Cloud AlloyDB for PostgreSQL** in production.
   - Relational modeling with UUID primary keys.
   - Strict foreign key constraints with `ON DELETE RESTRICT` for primary academic artifacts and `ON DELETE CASCADE` only for direct segment children.
   - PostgreSQL `JSONB` for schema-flexible metadata (notifications, audit context).
   - Automated timestamp tracking using PL/pgSQL triggers (`set_updated_at()`).
2. **Analytical Warehouse:** **Google BigQuery**.
   - Asynchronous ETL / streaming replication via Cloud Pub/Sub and Google Cloud Dataflow.
   - Heavy aggregate reporting (e.g., group-level syllabus coverage, hardware uptime trends, lecture material adoption) runs strictly in BigQuery.

---

## Consequences

### Positive
- Full ACID compliance protects academic event confirmations, calendar dates, and schedule conflicts.
- AlloyDB provides up to 4x transactional throughput and 100x analytical query speed over standard Cloud SQL PostgreSQL while maintaining 100% PostgreSQL engine compatibility.
- Clear boundary prevents heavy analytical queries from starving operational API transactions.
- Native PostgreSQL JSONB and pgvector support allow seamless future vector search experiments without introducing separate niche databases.

### Negative / Trade-offs
- Requires running database migrations in PostgreSQL and schema synchronizations to BigQuery.
- Multi-tenant data segregation relies on `tenant_institution_id` / row-level security or application-level tenant context rather than physical database separation.

---

## Alternatives Considered

1. **MongoDB / DocumentDB:** Rejected because academic relationships (Holding -> Institution -> Campus -> Program -> Course -> Section -> Enrollment) are deeply relational, and eventual consistency is dangerous for assessment calendars.
2. **Cloud Spanner:** Rejected due to excessive initial operational cost and lack of justification for global cross-region synchronous multi-master transactions at this stage.
