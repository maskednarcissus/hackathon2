import type { Campus, Classroom, HoldingCompany, Institution, RecordingPolicy } from './domain.js';

export interface Table<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  list(filter?: (item: T) => boolean): Promise<T[]>;
  save(item: T): Promise<T>;
  delete(id: string): Promise<boolean>;
}

export interface OrganizationRepository {
  holdingCompanies: Table<HoldingCompany>;
  institutions: Table<Institution>;
  campuses: Table<Campus>;
  classrooms: Table<Classroom>;
  recordingPolicies: Table<RecordingPolicy>;
}

export class InMemoryTable<T extends { id: string }> implements Table<T> {
  private readonly items = new Map<string, T>();

  get(id: string): Promise<T | undefined> {
    const item = this.items.get(id);
    return Promise.resolve(item ? structuredClone(item) : undefined);
  }

  list(filter?: (item: T) => boolean): Promise<T[]> {
    const all = [...this.items.values()].map((i) => structuredClone(i));
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
  return {
    holdingCompanies: new InMemoryTable<HoldingCompany>(),
    institutions: new InMemoryTable<Institution>(),
    campuses: new InMemoryTable<Campus>(),
    classrooms: new InMemoryTable<Classroom>(),
    recordingPolicies: new InMemoryTable<RecordingPolicy>(),
  };
}
