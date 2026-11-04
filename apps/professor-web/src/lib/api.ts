// Server-side only: imported from Server Components and Server Actions (never from client components).
import type {
  ExtractedEvent,
  SegmentPage,
  Transcript,
  TranscriptCorrection,
  TranscriptSegment,
} from './types';

const EVENT_EXTRACTION_URL = (process.env.EVENT_EXTRACTION_URL ?? 'http://localhost:8007').replace(
  /\/$/,
  '',
);
const TRANSCRIPT_MANAGEMENT_URL = (
  process.env.TRANSCRIPT_MANAGEMENT_URL ?? 'http://localhost:4008'
).replace(/\/$/, '');

/** Placeholder identity until Phase 3 authentication (identity service) lands. */
export const PROFESSOR_ID = process.env.PROFESSOR_ID ?? '00000000-0000-4000-8000-000000000001';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly service: string,
    public readonly status: number | null,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get unreachable(): boolean {
    return this.status === null;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
  detail?: unknown;
}

async function request<T>(
  service: 'event-extraction' | 'transcript-management',
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const base = service === 'event-extraction' ? EVENT_EXTRACTION_URL : TRANSCRIPT_MANAGEMENT_URL;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-actor-id': PROFESSOR_ID,
        'x-actor-role': 'professor',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(`Serviço ${service} indisponível em ${base}.`, service, null);
  }
  if (!res.ok) {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      /* non-JSON error body */
    }
    const message =
      body.error?.message ??
      (typeof body.detail === 'string' ? body.detail : `HTTP ${res.status} em ${path}`);
    throw new ApiError(message, service, res.status, body.error?.code ?? null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const listOf = <T>(data: T[] | { items: T[] }): T[] => (Array.isArray(data) ? data : data.items);

// ---- event-extraction (§5) ---------------------------------------------------

export async function getReviewQueue(status?: string): Promise<ExtractedEvent[]> {
  const params = new URLSearchParams({ professorId: PROFESSOR_ID });
  if (status) params.set('status', status);
  return listOf(
    await request<ExtractedEvent[] | { items: ExtractedEvent[] }>(
      'event-extraction',
      `/v1/review-queue?${params.toString()}`,
    ),
  );
}

export function getEvent(id: string): Promise<ExtractedEvent> {
  return request<ExtractedEvent>('event-extraction', `/v1/events/${encodeURIComponent(id)}`);
}

export function confirmEvent(id: string, notes?: string): Promise<ExtractedEvent> {
  return request('event-extraction', `/v1/events/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    body: { actorId: PROFESSOR_ID, ...(notes ? { notes } : {}) },
  });
}

export interface EventEdits {
  title?: string;
  type?: string;
  eventDate?: string;
  eventTime?: string;
  description?: string;
}

export function editEvent(
  id: string,
  changes: EventEdits,
  reason?: string,
): Promise<ExtractedEvent> {
  return request('event-extraction', `/v1/events/${encodeURIComponent(id)}/edit`, {
    method: 'POST',
    body: { actorId: PROFESSOR_ID, changes, ...(reason ? { reason } : {}) },
  });
}

export function rejectEvent(id: string, reason: string): Promise<ExtractedEvent> {
  return request('event-extraction', `/v1/events/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: { actorId: PROFESSOR_ID, reason },
  });
}

export function publishEvent(id: string): Promise<ExtractedEvent> {
  return request('event-extraction', `/v1/events/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    body: { actorId: PROFESSOR_ID },
  });
}

// ---- transcript-management (§7) ---------------------------------------------

export function getTranscript(id: string): Promise<Transcript> {
  return request<Transcript>('transcript-management', `/v1/transcripts/${encodeURIComponent(id)}`);
}

/** Loads every segment, following the cursor (transcripts of a 90-minute class fit in a few pages). */
export async function getAllSegments(id: string): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = [];
  let cursor: number | null = 0;
  for (let page = 0; cursor !== null && page < 50; page += 1) {
    const data: SegmentPage = await request<SegmentPage>(
      'transcript-management',
      `/v1/transcripts/${encodeURIComponent(id)}/segments?limit=1000&cursor=${cursor}`,
    );
    out.push(...data.items);
    cursor = data.nextCursor;
  }
  return out;
}

export async function getCorrections(
  transcriptId: string,
  segmentIndex: number,
): Promise<TranscriptCorrection[]> {
  return listOf(
    await request<TranscriptCorrection[] | { items: TranscriptCorrection[] }>(
      'transcript-management',
      `/v1/transcripts/${encodeURIComponent(transcriptId)}/segments/${segmentIndex}/corrections`,
    ),
  );
}

export function correctSegment(
  transcriptId: string,
  segmentIndex: number,
  correctedText: string,
  reason?: string,
): Promise<unknown> {
  return request(
    'transcript-management',
    `/v1/transcripts/${encodeURIComponent(transcriptId)}/segments/${segmentIndex}/corrections`,
    {
      method: 'POST',
      body: { correctedText, correctedBy: PROFESSOR_ID, ...(reason ? { reason } : {}) },
    },
  );
}
