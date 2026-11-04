/** Classroom → campus lookup (organization service), cached. Phase 4 §4. */

export interface ClassroomLocation {
  classroomId: string;
  classroomName: string | null;
  campusId: string;
  campusName: string | null;
  institutionId: string | null;
}

export interface OrganizationClient {
  locateClassroom(classroomId: string): Promise<ClassroomLocation | undefined>;
}

interface ClassroomResponse {
  id: string;
  name?: string;
  code?: string;
  campusId: string;
  institutionId?: string;
}

interface CampusResponse {
  id: string;
  name?: string;
}

/**
 * `GET {ORGANIZATION_URL}/v1/classrooms/:id` (+ `/v1/campuses/:id` for the name).
 * Positive results are cached for `ttlMs`, misses for `negativeTtlMs`; errors are not cached
 * and surface as `undefined` (incident enrichment is best-effort).
 */
export class HttpOrganizationClient implements OrganizationClient {
  private readonly cache = new Map<
    string,
    { value: ClassroomLocation | undefined; expiresAt: number }
  >();

  constructor(
    private readonly baseUrl: string,
    private readonly options: {
      token?: string | undefined;
      ttlMs?: number;
      negativeTtlMs?: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {},
  ) {}

  private async get<T>(path: string): Promise<T | undefined> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    const res = await (this.options.fetchImpl ?? fetch)(
      `${this.baseUrl.replace(/\/$/, '')}${path}`,
      {
        headers,
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`organization responded ${res.status}`);
    return (await res.json()) as T;
  }

  async locateClassroom(classroomId: string): Promise<ClassroomLocation | undefined> {
    const now = (this.options.now ?? Date.now)();
    const hit = this.cache.get(classroomId);
    if (hit && hit.expiresAt > now) return hit.value;
    try {
      const classroom = await this.get<ClassroomResponse>(
        `/v1/classrooms/${encodeURIComponent(classroomId)}`,
      );
      let value: ClassroomLocation | undefined;
      if (classroom) {
        let campusName: string | null = null;
        try {
          campusName =
            (
              await this.get<CampusResponse>(
                `/v1/campuses/${encodeURIComponent(classroom.campusId)}`,
              )
            )?.name ?? null;
        } catch {
          campusName = null;
        }
        value = {
          classroomId,
          classroomName: classroom.name ?? classroom.code ?? null,
          campusId: classroom.campusId,
          campusName,
          institutionId: classroom.institutionId ?? null,
        };
      }
      const ttl = value
        ? (this.options.ttlMs ?? 10 * 60_000)
        : (this.options.negativeTtlMs ?? 60_000);
      this.cache.set(classroomId, { value, expiresAt: now + ttl });
      return value;
    } catch {
      return undefined;
    }
  }
}

export class MapOrganizationClient implements OrganizationClient {
  readonly classrooms = new Map<string, ClassroomLocation>();
  calls = 0;
  locateClassroom(classroomId: string): Promise<ClassroomLocation | undefined> {
    this.calls += 1;
    return Promise.resolve(this.classrooms.get(classroomId));
  }
}
