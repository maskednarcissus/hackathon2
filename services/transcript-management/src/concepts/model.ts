export interface ConceptNode {
  id: string;
  courseId: string;
  institutionId: string | null;
  /** Display term: the most frequent wording across mentions. */
  term: string;
  /** Language-aware normalised term (stopwords removed, stemmed) — merge key within a course. */
  normalizedKey: string;
  language: string;
  aliases: string[];
  /** Mean of the mention embeddings (L2-normalised); null when embeddings were unavailable. */
  embedding: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConceptMention {
  id: string;
  nodeId: string;
  courseId: string;
  classSectionId: string;
  scheduledClassId: string;
  transcriptId: string;
  lectureSummaryId: string;
  term: string;
  definition: string;
  example: string | null;
  segmentIndexes: number[];
  lectureStartsAt: string | null;
  createdAt: string;
}

export type EdgeKind = 'co_occurrence' | 'related';

export interface ConceptEdge {
  courseId: string;
  /** sourceId < targetId (undirected). */
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  weight: number;
  scheduledClassIds: string[];
}

export interface CourseGraphState {
  nodes: ConceptNode[];
  mentions: ConceptMention[];
}

export interface CourseGraphUpdate {
  upsertNodes: ConceptNode[];
  deleteNodeIds: string[];
  /** Mentions of the lecture being applied (replace the previous ones of that scheduled class). */
  lectureMentions: ConceptMention[];
  /** Full edge set of the course (recomputed). */
  edges: ConceptEdge[];
}

export interface ConceptRepository {
  /** Loads the course graph, lets `build` compute the update, and writes it atomically (serialised per course). */
  applyLecture(
    courseId: string,
    scheduledClassId: string,
    build: (state: CourseGraphState) => CourseGraphUpdate,
  ): Promise<void>;
  node(id: string): Promise<ConceptNode | null>;
  mentionsOfNode(nodeId: string, classSectionIds: readonly string[]): Promise<ConceptMention[]>;
  edgesOfNode(nodeId: string): Promise<ConceptEdge[]>;
  nodesInSections(classSectionIds: readonly string[], courseId?: string): Promise<ConceptNode[]>;
  mentionsInSections(
    classSectionIds: readonly string[],
    courseId?: string,
  ): Promise<ConceptMention[]>;
  edgesOfCourses(courseIds: readonly string[]): Promise<ConceptEdge[]>;
  nodesByIds(ids: readonly string[]): Promise<ConceptNode[]>;
  /** Idempotent event consumption: true the first time an event id is marked. */
  markProcessed(eventId: string, consumer: string): Promise<boolean>;
  isProcessed(eventId: string, consumer: string): Promise<boolean>;
}

export class InMemoryConceptRepository implements ConceptRepository {
  private readonly nodes = new Map<string, ConceptNode>();
  private mentions: ConceptMention[] = [];
  private edges: ConceptEdge[] = [];
  private readonly processed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  applyLecture(
    courseId: string,
    scheduledClassId: string,
    build: (s: CourseGraphState) => CourseGraphUpdate,
  ): Promise<void> {
    const run = this.queue.then(() => {
      const update = build({
        nodes: [...this.nodes.values()].filter((n) => n.courseId === courseId),
        mentions: this.mentions.filter((m) => m.courseId === courseId),
      });
      for (const id of update.deleteNodeIds) this.nodes.delete(id);
      for (const n of update.upsertNodes) this.nodes.set(n.id, n);
      this.mentions = [
        ...this.mentions.filter(
          (m) =>
            m.scheduledClassId !== scheduledClassId && !update.deleteNodeIds.includes(m.nodeId),
        ),
        ...update.lectureMentions,
      ];
      this.edges = [...this.edges.filter((e) => e.courseId !== courseId), ...update.edges];
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  node(id: string): Promise<ConceptNode | null> {
    return Promise.resolve(this.nodes.get(id) ?? null);
  }
  mentionsOfNode(nodeId: string, sections: readonly string[]): Promise<ConceptMention[]> {
    return Promise.resolve(
      this.mentions.filter((m) => m.nodeId === nodeId && sections.includes(m.classSectionId)),
    );
  }
  edgesOfNode(nodeId: string): Promise<ConceptEdge[]> {
    return Promise.resolve(
      this.edges.filter((e) => e.sourceId === nodeId || e.targetId === nodeId),
    );
  }
  nodesInSections(sections: readonly string[], courseId?: string): Promise<ConceptNode[]> {
    const ids = new Set(
      this.mentions
        .filter(
          (m) => sections.includes(m.classSectionId) && (!courseId || m.courseId === courseId),
        )
        .map((m) => m.nodeId),
    );
    return Promise.resolve(
      [...ids].map((id) => this.nodes.get(id)).filter((n): n is ConceptNode => n !== undefined),
    );
  }
  mentionsInSections(sections: readonly string[], courseId?: string): Promise<ConceptMention[]> {
    return Promise.resolve(
      this.mentions.filter(
        (m) => sections.includes(m.classSectionId) && (!courseId || m.courseId === courseId),
      ),
    );
  }
  edgesOfCourses(courseIds: readonly string[]): Promise<ConceptEdge[]> {
    return Promise.resolve(this.edges.filter((e) => courseIds.includes(e.courseId)));
  }
  nodesByIds(ids: readonly string[]): Promise<ConceptNode[]> {
    return Promise.resolve(
      ids.map((id) => this.nodes.get(id)).filter((n): n is ConceptNode => n !== undefined),
    );
  }
  markProcessed(eventId: string, consumer: string): Promise<boolean> {
    const key = `${consumer}|${eventId}`;
    if (this.processed.has(key)) return Promise.resolve(false);
    this.processed.add(key);
    return Promise.resolve(true);
  }
  isProcessed(eventId: string, consumer: string): Promise<boolean> {
    return Promise.resolve(this.processed.has(`${consumer}|${eventId}`));
  }
}
