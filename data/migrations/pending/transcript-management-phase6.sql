-- transcript-management — Phase 6.3 concept graph (built from lecture-intelligence structures).
-- Concepts are merged per course by language-aware normalised term or embedding similarity >= 0.88.
-- No foreign keys to lecture tables (owned by lecture-intelligence); transcripts are referenced by id only.
CREATE TABLE IF NOT EXISTS concept_nodes (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL,
    institution_id UUID,
    term TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'pt-BR',
    aliases TEXT[] NOT NULL DEFAULT '{}',
    embedding REAL[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_concept_nodes_course_key ON concept_nodes(course_id, normalized_key);

CREATE TABLE IF NOT EXISTS concept_mentions (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES concept_nodes(id) ON DELETE CASCADE,
    course_id UUID NOT NULL,
    class_section_id UUID NOT NULL,
    scheduled_class_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    lecture_summary_id UUID NOT NULL,
    term TEXT NOT NULL,
    definition TEXT NOT NULL,
    example TEXT,
    segment_indexes INT[] NOT NULL DEFAULT '{}',
    lecture_starts_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_node ON concept_mentions(node_id);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_section ON concept_mentions(class_section_id);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_class ON concept_mentions(scheduled_class_id);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_course ON concept_mentions(course_id);

CREATE TABLE IF NOT EXISTS concept_edges (
    course_id UUID NOT NULL,
    source_id UUID NOT NULL REFERENCES concept_nodes(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES concept_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('co_occurrence', 'related')),
    weight INT NOT NULL CHECK (weight > 0),
    scheduled_class_ids UUID[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (source_id, target_id, kind),
    CHECK (source_id < target_id)
);
CREATE INDEX IF NOT EXISTS idx_concept_edges_course ON concept_edges(course_id);
CREATE INDEX IF NOT EXISTS idx_concept_edges_target ON concept_edges(target_id);
