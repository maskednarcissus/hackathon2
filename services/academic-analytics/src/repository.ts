import type { ClassFact } from './facts.js';

export interface SyllabusItem {
  id: string;
  title: string;
  keywords: string[];
  plannedWeek: number | null;
}

export interface Syllabus {
  courseId: string;
  institutionId: string;
  items: SyllabusItem[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface DailySnapshot {
  institutionId: string;
  date: string;
  generatedAt: string;
  classes: ClassFact[];
}

export interface AnalyticsRepository {
  putSyllabus(s: Syllabus): Promise<void>;
  getSyllabus(courseId: string): Promise<Syllabus | null>;
  putSnapshot(s: DailySnapshot): Promise<void>;
  snapshots(institutionId: string, from: string, to: string): Promise<DailySnapshot[]>;
}

export class InMemoryAnalyticsRepository implements AnalyticsRepository {
  private readonly syllabi = new Map<string, Syllabus>();
  private readonly snaps = new Map<string, DailySnapshot>();

  putSyllabus(s: Syllabus): Promise<void> {
    this.syllabi.set(s.courseId, s);
    return Promise.resolve();
  }
  getSyllabus(courseId: string): Promise<Syllabus | null> {
    return Promise.resolve(this.syllabi.get(courseId) ?? null);
  }
  putSnapshot(s: DailySnapshot): Promise<void> {
    this.snaps.set(`${s.institutionId}|${s.date}`, s);
    return Promise.resolve();
  }
  snapshots(institutionId: string, from: string, to: string): Promise<DailySnapshot[]> {
    return Promise.resolve(
      [...this.snaps.values()]
        .filter((s) => s.institutionId === institutionId && s.date >= from && s.date <= to)
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    );
  }
}
