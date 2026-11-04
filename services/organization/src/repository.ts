import type {
  Campus,
  Classroom,
  Consent,
  HoldingCompany,
  Institution,
  LegalHold,
  RecordingPolicy,
  RecordingPolicyVersion,
  RetentionJob,
} from './domain.js';

/** Equality pre-filter on top-level string fields; pushed down to SQL by the Postgres tables. */
export type Scope<T> = Partial<{ [K in keyof T]: T[K] & string }>;

export interface Table<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  /** `scope` narrows the rows fetched (indexed columns); `filter` refines in memory. */
  list(filter?: (item: T) => boolean, scope?: Scope<T>): Promise<T[]>;
  save(item: T): Promise<T>;
  delete(id: string): Promise<boolean>;
}

export interface OrganizationRepository {
  holdingCompanies: Table<HoldingCompany>;
  institutions: Table<Institution>;
  campuses: Table<Campus>;
  classrooms: Table<Classroom>;
  recordingPolicies: Table<RecordingPolicy>;
  /** Append-only: versions are never updated or deleted. */
  recordingPolicyVersions: Table<RecordingPolicyVersion>;
  consents: Table<Consent>;
  legalHolds: Table<LegalHold>;
  retentionJobs: Table<RetentionJob>;

  /**
   * Saves a policy and (optionally) its new immutable version in one transaction. When the policy
   * is the default, every other default of the institution is cleared first.
   */
  commitPolicy(change: {
    policy: RecordingPolicy;
    version?: RecordingPolicyVersion;
  }): Promise<void>;
  /** Supersedes `previous` and stores `consent` atomically (one current decision per scope). */
  recordConsent(consent: Consent, previous: readonly Consent[]): Promise<void>;
  /** Stores a `running` job unless one is already running for the institution. */
  startRetentionJob(job: RetentionJob): Promise<boolean>;
}

export class InMemoryTable<T extends { id: string }> implements Table<T> {
  private readonly items = new Map<string, T>();

  get(id: string): Promise<T | undefined> {
    const item = this.items.get(id);
    return Promise.resolve(item ? structuredClone(item) : undefined);
  }

  list(filter?: (item: T) => boolean, scope?: Scope<T>): Promise<T[]> {
    const entries = Object.entries(scope ?? {}) as [keyof T, unknown][];
    const all = [...this.items.values()]
      .filter((i) => entries.every(([k, v]) => i[k] === v))
      .map((i) => structuredClone(i));
    return Promise.resolve(filter ? all.filter(filter) : all);
  }

  save(item: T): Promise<T> {
    this.items.set(item.id, structuredClone(item));
    return Promise.resolve(item);
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(id));
  }
}

export function createInMemoryOrganizationRepository(): OrganizationRepository {
  const recordingPolicies = new InMemoryTable<RecordingPolicy>();
  const recordingPolicyVersions = new InMemoryTable<RecordingPolicyVersion>();
  const consents = new InMemoryTable<Consent>();
  const retentionJobs = new InMemoryTable<RetentionJob>();
  return {
    holdingCompanies: new InMemoryTable<HoldingCompany>(),
    institutions: new InMemoryTable<Institution>(),
    campuses: new InMemoryTable<Campus>(),
    classrooms: new InMemoryTable<Classroom>(),
    recordingPolicies,
    recordingPolicyVersions,
    consents,
    legalHolds: new InMemoryTable<LegalHold>(),
    retentionJobs,
    async commitPolicy({ policy, version }): Promise<void> {
      if (policy.isDefault) {
        const others = await recordingPolicies.list((p) => p.isDefault && p.id !== policy.id, {
          institutionId: policy.institutionId,
        });
        for (const p of others)
          await recordingPolicies.save({ ...p, isDefault: false, updatedAt: policy.updatedAt });
      }
      if (version) await recordingPolicyVersions.save(version);
      await recordingPolicies.save(policy);
    },
    async recordConsent(consent, previous): Promise<void> {
      for (const p of previous)
        await consents.save({ ...p, supersededAt: consent.recordedAt, supersededBy: consent.id });
      await consents.save(consent);
    },
    async startRetentionJob(job): Promise<boolean> {
      const running = await retentionJobs.list((j) => j.status === 'running', {
        institutionId: job.institutionId,
      });
      if (running.length > 0) return false;
      await retentionJobs.save(job);
      return true;
    },
  };
}
