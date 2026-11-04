import { iso, isoOrNull, withTransaction, type Pool, type PoolClient } from '../platform/pg.js';
import type {
  ConceptEdge,
  ConceptMention,
  ConceptNode,
  ConceptRepository,
  CourseGraphState,
  CourseGraphUpdate,
} from './model.js';

interface NodeRow {
  id: string;
  course_id: string;
  institution_id: string | null;
  term: string;
  normalized_key: string;
  language: string;
  aliases: string[];
  embedding: number[] | null;
  created_at: Date;
  updated_at: Date;
}

interface MentionRow {
  id: string;
  node_id: string;
  course_id: string;
  class_section_id: string;
  scheduled_class_id: string;
  transcript_id: string;
  lecture_summary_id: string;
  term: string;
  definition: string;
  example: string | null;
  segment_indexes: number[];
  lecture_starts_at: Date | null;
  created_at: Date;
}

interface EdgeRow {
  course_id: string;
  source_id: string;
  target_id: string;
  kind: ConceptEdge['kind'];
  weight: number;
  scheduled_class_ids: string[];
}

const toNode = (r: NodeRow): ConceptNode => ({
  id: r.id,
  courseId: r.course_id,
  institutionId: r.institution_id,
  term: r.term,
  normalizedKey: r.normalized_key,
  language: r.language,
  aliases: r.aliases,
  embedding: r.embedding ? r.embedding.map(Number) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toMention = (r: MentionRow): ConceptMention => ({
  id: r.id,
  nodeId: r.node_id,
  courseId: r.course_id,
  classSectionId: r.class_section_id,
  scheduledClassId: r.scheduled_class_id,
  transcriptId: r.transcript_id,
  lectureSummaryId: r.lecture_summary_id,
  term: r.term,
  definition: r.definition,
  example: r.example,
  segmentIndexes: r.segment_indexes,
  lectureStartsAt: isoOrNull(r.lecture_starts_at),
  createdAt: iso(r.created_at),
});

const toEdge = (r: EdgeRow): ConceptEdge => ({
  courseId: r.course_id,
  sourceId: r.source_id,
  targetId: r.target_id,
  kind: r.kind,
  weight: r.weight,
  scheduledClassIds: r.scheduled_class_ids,
});

/**
 * Concept graph on `concept_nodes`, `concept_mentions`, `concept_edges`
 * (pending/transcript-management-phase6.sql). Lecture application is one transaction serialised per
 * course with an advisory lock; idempotency uses `processed_events` (V002).
 */
export class PgConceptRepository implements ConceptRepository {
  constructor(private readonly pool: Pool) {}

  applyLecture(
    courseId: string,
    scheduledClassId: string,
    build: (state: CourseGraphState) => CourseGraphUpdate,
  ): Promise<void> {
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 6))', [
        `concepts:${courseId}`,
      ]);
      const [nodes, mentions] = await Promise.all([
        c.query<NodeRow>('SELECT * FROM concept_nodes WHERE course_id = $1', [courseId]),
        c.query<MentionRow>('SELECT * FROM concept_mentions WHERE course_id = $1', [courseId]),
      ]);
      const update = build({
        nodes: nodes.rows.map(toNode),
        mentions: mentions.rows.map(toMention),
      });
      await this.write(c, courseId, scheduledClassId, update);
    });
  }

  private async write(
    c: PoolClient,
    courseId: string,
    scheduledClassId: string,
    u: CourseGraphUpdate,
  ): Promise<void> {
    await c.query('DELETE FROM concept_mentions WHERE scheduled_class_id = $1', [scheduledClassId]);
    if (u.deleteNodeIds.length > 0) {
      await c.query('DELETE FROM concept_nodes WHERE id = ANY($1::uuid[])', [u.deleteNodeIds]);
    }
    if (u.upsertNodes.length > 0) {
      await c.query(
        `INSERT INTO concept_nodes (id, course_id, institution_id, term, normalized_key, language, aliases, embedding,
            created_at, updated_at)
         SELECT n.id, n.course_id, n.institution_id, n.term, n.normalized_key, n.language,
                ARRAY(SELECT jsonb_array_elements_text(n.aliases)),
                CASE WHEN n.embedding IS NULL THEN NULL
                     ELSE ARRAY(SELECT jsonb_array_elements_text(n.embedding))::real[] END,
                n.created_at, n.updated_at
           FROM jsonb_to_recordset($1::jsonb) AS n(id uuid, course_id uuid, institution_id uuid, term text,
                normalized_key text, language text, aliases jsonb, embedding jsonb, created_at timestamptz,
                updated_at timestamptz)
         ON CONFLICT (id) DO UPDATE SET term = EXCLUDED.term, aliases = EXCLUDED.aliases,
           embedding = EXCLUDED.embedding, updated_at = EXCLUDED.updated_at`,
        [
          JSON.stringify(
            u.upsertNodes.map((n) => ({
              id: n.id,
              course_id: n.courseId,
              institution_id: n.institutionId,
              term: n.term,
              normalized_key: n.normalizedKey,
              language: n.language,
              aliases: n.aliases,
              embedding: n.embedding,
              created_at: n.createdAt,
              updated_at: n.updatedAt,
            })),
          ),
        ],
      );
    }
    if (u.lectureMentions.length > 0) {
      await c.query(
        `INSERT INTO concept_mentions (id, node_id, course_id, class_section_id, scheduled_class_id, transcript_id,
            lecture_summary_id, term, definition, example, segment_indexes, lecture_starts_at, created_at)
         SELECT m.id, m.node_id, m.course_id, m.class_section_id, m.scheduled_class_id, m.transcript_id,
                m.lecture_summary_id, m.term, m.definition, m.example,
                ARRAY(SELECT jsonb_array_elements_text(m.segment_indexes))::int[], m.lecture_starts_at, m.created_at
           FROM jsonb_to_recordset($1::jsonb) AS m(id uuid, node_id uuid, course_id uuid, class_section_id uuid,
                scheduled_class_id uuid, transcript_id uuid, lecture_summary_id uuid, term text, definition text,
                example text, segment_indexes jsonb, lecture_starts_at timestamptz, created_at timestamptz)`,
        [
          JSON.stringify(
            u.lectureMentions.map((m) => ({
              id: m.id,
              node_id: m.nodeId,
              course_id: m.courseId,
              class_section_id: m.classSectionId,
              scheduled_class_id: m.scheduledClassId,
              transcript_id: m.transcriptId,
              lecture_summary_id: m.lectureSummaryId,
              term: m.term,
              definition: m.definition,
              example: m.example,
              segment_indexes: m.segmentIndexes,
              lecture_starts_at: m.lectureStartsAt,
              created_at: m.createdAt,
            })),
          ),
        ],
      );
    }
    await c.query('DELETE FROM concept_edges WHERE course_id = $1', [courseId]);
    if (u.edges.length > 0) {
      await c.query(
        `INSERT INTO concept_edges (course_id, source_id, target_id, kind, weight, scheduled_class_ids)
         SELECT e.course_id, e.source_id, e.target_id, e.kind, e.weight,
                ARRAY(SELECT jsonb_array_elements_text(e.scheduled_class_ids))::uuid[]
           FROM jsonb_to_recordset($1::jsonb) AS e(course_id uuid, source_id uuid, target_id uuid, kind text,
                weight int, scheduled_class_ids jsonb)`,
        [
          JSON.stringify(
            u.edges.map((e) => ({
              course_id: e.courseId,
              source_id: e.sourceId,
              target_id: e.targetId,
              kind: e.kind,
              weight: e.weight,
              scheduled_class_ids: e.scheduledClassIds,
            })),
          ),
        ],
      );
    }
  }

  async node(id: string): Promise<ConceptNode | null> {
    const res = await this.pool.query<NodeRow>('SELECT * FROM concept_nodes WHERE id = $1', [id]);
    const row = res.rows[0];
    return row ? toNode(row) : null;
  }

  async mentionsOfNode(nodeId: string, sections: readonly string[]): Promise<ConceptMention[]> {
    const res = await this.pool.query<MentionRow>(
      `SELECT * FROM concept_mentions WHERE node_id = $1 AND class_section_id = ANY($2::uuid[])
        ORDER BY lecture_starts_at NULLS LAST, created_at`,
      [nodeId, sections],
    );
    return res.rows.map(toMention);
  }

  async edgesOfNode(nodeId: string): Promise<ConceptEdge[]> {
    const res = await this.pool.query<EdgeRow>(
      'SELECT * FROM concept_edges WHERE source_id = $1 OR target_id = $1 ORDER BY weight DESC',
      [nodeId],
    );
    return res.rows.map(toEdge);
  }

  async nodesInSections(sections: readonly string[], courseId?: string): Promise<ConceptNode[]> {
    const res = await this.pool.query<NodeRow>(
      `SELECT n.* FROM concept_nodes n
        WHERE EXISTS (SELECT 1 FROM concept_mentions m WHERE m.node_id = n.id AND m.class_section_id = ANY($1::uuid[]))
          AND ($2::uuid IS NULL OR n.course_id = $2)`,
      [sections, courseId ?? null],
    );
    return res.rows.map(toNode);
  }

  async mentionsInSections(
    sections: readonly string[],
    courseId?: string,
  ): Promise<ConceptMention[]> {
    const res = await this.pool.query<MentionRow>(
      `SELECT * FROM concept_mentions WHERE class_section_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR course_id = $2)`,
      [sections, courseId ?? null],
    );
    return res.rows.map(toMention);
  }

  async edgesOfCourses(courseIds: readonly string[]): Promise<ConceptEdge[]> {
    if (courseIds.length === 0) return [];
    const res = await this.pool.query<EdgeRow>(
      'SELECT * FROM concept_edges WHERE course_id = ANY($1::uuid[]) ORDER BY weight DESC',
      [courseIds],
    );
    return res.rows.map(toEdge);
  }

  async nodesByIds(ids: readonly string[]): Promise<ConceptNode[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<NodeRow>(
      'SELECT * FROM concept_nodes WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return res.rows.map(toNode);
  }

  async markProcessed(eventId: string, consumer: string): Promise<boolean> {
    const res = await this.pool.query(
      'INSERT INTO processed_events (event_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [eventId, consumer],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async isProcessed(eventId: string, consumer: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM processed_events WHERE event_id = $1 AND consumer = $2',
      [eventId, consumer],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
