import type { Directory } from './directory.js';
import { collectClassFacts, type ClassFact } from './facts.js';
import type { UpstreamClients } from './fakes.js';
import type { AnalyticsRepository } from './repository.js';
import { eachDate } from './stats.js';

export interface FactsResult {
  facts: ClassFact[];
  source: { snapshotDays: number; liveDays: number };
}

/** Serves class facts from daily snapshots, falling back to live collection for missing days. */
export class FactSource {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly directory: Directory,
    private readonly up: UpstreamClients,
    private readonly now: () => Date,
  ) {}

  async get(institutionId: string, from: string, to: string): Promise<FactsResult> {
    const today = this.now().toISOString().slice(0, 10);
    const snaps = await this.repo.snapshots(institutionId, from, to);
    // Snapshots for today or later are never trusted (the day is still changing).
    const usable = new Map(snaps.filter((s) => s.date < today).map((s) => [s.date, s]));
    const missing = [...eachDate(from, to)].filter((d) => !usable.has(d));
    let live: ClassFact[] = [];
    if (missing.length > 0) {
      const first = missing[0] ?? from;
      const last = missing[missing.length - 1] ?? to;
      const missingSet = new Set(missing);
      live = (await this.collect(institutionId, first, last)).filter((f) =>
        missingSet.has(f.localDate),
      );
    }
    const facts = [...[...usable.values()].flatMap((s) => s.classes), ...live].sort((a, b) =>
      a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0,
    );
    return { facts, source: { snapshotDays: usable.size, liveDays: missing.length } };
  }

  collect(institutionId: string, from: string, to: string): Promise<ClassFact[]> {
    return collectClassFacts(institutionId, from, to, this.now(), this.directory, this.up);
  }
}
