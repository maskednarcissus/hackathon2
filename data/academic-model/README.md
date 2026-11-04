# Academic Data Model

This directory contains the canonical academic data model for Classroom Intelligence.

## Contents

- `erd.md` — Entity-relationship diagram
- `entities/` — Per-entity field definitions
- `relationships/` — Relationship and cardinality definitions

## Design principles

- All material information retains source provenance.
- Timestamps are stored in UTC with timezone recorded separately.
- Soft deletes are preferred for academic records.
- Change history is maintained for all published academic events.
