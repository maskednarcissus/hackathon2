/** lecture-intelligence `GET /v1/lectures/{scheduledClassId}` (only the fields the concept graph uses). */
export interface LectureStructure {
  lectureSummaryId: string;
  transcriptId: string;
  scheduledClassId: string;
  institutionId?: string;
  classSectionId?: string;
  courseId?: string;
  startsAt?: string;
  classDate?: string;
  concepts: { term: string; definition: string; example?: string; segmentIndexes: number[] }[];
}

export class LectureServiceUnavailableError extends Error {}

export interface LectureClient {
  getLecture(scheduledClassId: string): Promise<LectureStructure | null>;
}

export class HttpLectureClient implements LectureClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async getLecture(scheduledClassId: string): Promise<LectureStructure | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/lectures/${encodeURIComponent(scheduledClassId)}`, {
        headers: this.internalToken ? { 'x-internal-token': this.internalToken } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LectureServiceUnavailableError(`lecture-intelligence unreachable: ${String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok)
      throw new LectureServiceUnavailableError(`lecture-intelligence returned ${res.status}`);
    return (await res.json()) as LectureStructure;
  }
}

export class StaticLectureClient implements LectureClient {
  readonly lectures = new Map<string, LectureStructure>();
  getLecture(scheduledClassId: string): Promise<LectureStructure | null> {
    return Promise.resolve(this.lectures.get(scheduledClassId) ?? null);
  }
}
