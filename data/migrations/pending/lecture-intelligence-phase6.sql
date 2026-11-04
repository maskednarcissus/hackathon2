-- lecture-intelligence — Phase 6 (6.2 revision materials, 6.4 lecture language).
-- To be merged by the coordinator; idempotent.

-- 6.4: lecture structures are produced in the lecture's language.
ALTER TABLE lecture_summaries ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'pt-BR';

-- 6.2: personalised revision plans built from lecture structures + the student's own signals.
CREATE TABLE IF NOT EXISTS revision_plans (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    class_section_ids UUID[] NOT NULL,
    from_date DATE,
    to_date DATE,
    focus TEXT[] NOT NULL DEFAULT '{}',
    signals JSONB NOT NULL DEFAULT '{}'::jsonb,     -- counts only, never raw signal content
    validation JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {droppedItems, flags}
    limitations TEXT[] NOT NULL DEFAULT '{}',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revision_plans_student ON revision_plans (student_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS revision_items (
    id UUID PRIMARY KEY,
    plan_id UUID NOT NULL REFERENCES revision_plans(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('summary', 'flashcards', 'quiz', 'concept_review')),
    scheduled_class_id UUID NOT NULL REFERENCES scheduled_classes(id) ON DELETE CASCADE,
    concept_ids UUID[] NOT NULL DEFAULT '{}',
    content JSONB NOT NULL,
    source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{scheduledClassId, transcriptId, segmentIndexes, startMs?, endMs?}]
    item_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revision_items_plan ON revision_items (plan_id, item_order);
CREATE INDEX IF NOT EXISTS idx_revision_items_student ON revision_items (student_id);

-- SM-2 state per reviewable item (flashcards, quiz, concept_review).
CREATE TABLE IF NOT EXISTS revision_schedules (
    item_id UUID PRIMARY KEY REFERENCES revision_items(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    repetitions INT NOT NULL DEFAULT 0,
    interval_days INT NOT NULL DEFAULT 0,
    easiness NUMERIC(5,3) NOT NULL DEFAULT 2.5 CHECK (easiness >= 1.3),
    due_at TIMESTAMPTZ NOT NULL,
    last_grade SMALLINT CHECK (last_grade BETWEEN 0 AND 5),
    last_reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_revision_schedules_due ON revision_schedules (student_id, due_at);

CREATE TABLE IF NOT EXISTS revision_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES revision_items(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    grade SMALLINT NOT NULL CHECK (grade BETWEEN 0 AND 5),
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revision_reviews_student ON revision_reviews (student_id, reviewed_at);
