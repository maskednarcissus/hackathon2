# Database Migrations

Managed with Flyway or standard SQL migration runners against PostgreSQL 16+ / AlloyDB.

## Naming Convention

`V{version}__{description}.sql`

Examples:

- `V001__initial_academic_schema.sql`
- `V002__add_syllabus_coverage.sql`

## Standards & Rules

- **Immutability:** Migrations are strictly immutable once merged to `main`.
- **Idempotency & Isolation:** Run in isolated transactional batches (`BEGIN` / `COMMIT`).
- **No Direct Column Drops:** Mark deprecated or nullify before removal across minor versions.
- **Data Lineage:** Every extracted intelligence item must map to a `transcript_segment_id` and `scheduled_class_id`.
- **Immutable Audit:** The `audit_events` table contains no `updated_at` column or update triggers.

## Running Migrations Locally

Ensure local Postgres is running via Docker Compose:

```bash
docker compose up -d postgres
```

Execute migration script:

```bash
docker exec -i ci-postgres psql -U ci -d classroom_intelligence < data/migrations/V001__initial_academic_schema.sql
```
