import { analyze } from './text.js';

export type EmbeddingPurpose = 'search_index' | 'query';

export interface EmbeddingClient {
  readonly model: string;
  embed(texts: string[], purpose: EmbeddingPurpose, institutionId?: string): Promise<number[][]>;
}

export class EmbeddingUnavailableError extends Error {}

/** ai-gateway `POST /v1/embed` (phase-3 contract §3). */
export class HttpEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  constructor(
    private readonly baseUrl: string,
    private readonly defaultInstitutionId: string | undefined = undefined,
    private readonly timeoutMs = 10_000,
  ) {
    this.model = 'ai-gateway';
  }

  async embed(
    texts: string[],
    purpose: EmbeddingPurpose,
    institutionId?: string,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          texts,
          purpose,
          institutionId: institutionId ?? this.defaultInstitutionId,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new EmbeddingUnavailableError(`ai-gateway unreachable: ${String(err)}`);
    }
    if (!res.ok) throw new EmbeddingUnavailableError(`ai-gateway returned ${res.status}`);
    const body = (await res.json()) as { vectors?: unknown };
    if (!Array.isArray(body.vectors) || body.vectors.length !== texts.length) {
      throw new EmbeddingUnavailableError('invalid embedding response');
    }
    return body.vectors as number[][];
  }
}

/** FNV-1a 32-bit hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic hashed bag-of-words embedding (256 dims, L2-normalised), mirroring the ai-gateway
 * `fake` provider. Used by default in development and tests; it has no semantic knowledge beyond
 * shared (stemmed, accent-folded) terms.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly model = 'fake-hashed-bow-256';
  constructor(readonly dimensions = 256) {}

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.vector(t)));
  }

  vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const term of analyze(text)) {
      const h = fnv1a(term);
      const idx = h % this.dimensions;
      v[idx] = (v[idx] ?? 0) + ((h >>> 31) & 1 ? -1 : 1);
    }
    const norm = Math.hypot(...v);
    return norm > 0 ? v.map((x) => x / norm) : v;
  }
}
