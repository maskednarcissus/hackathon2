import { analyze } from './text.js';

export interface EmbeddingClient {
  readonly model: string;
  embed(texts: string[], institutionId: string): Promise<number[][]>;
}

export class EmbeddingUnavailableError extends Error {}

/** ai-gateway `POST /v1/embed` (phase-3 contract §3). Batches of ≤ 1000 texts. */
export class HttpEmbeddingClient implements EmbeddingClient {
  readonly model = 'ai-gateway';
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async embed(texts: string[], institutionId: string): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 1000) {
      const batch = texts.slice(i, i + 1000);
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/v1/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            texts: batch,
            institutionId,
            purpose: 'search_index',
            requestedBy: 'academic-analytics',
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw new EmbeddingUnavailableError(`ai-gateway unreachable: ${String(err)}`);
      }
      if (!res.ok) throw new EmbeddingUnavailableError(`ai-gateway returned ${res.status}`);
      const body = (await res.json()) as { vectors?: unknown };
      if (!Array.isArray(body.vectors) || body.vectors.length !== batch.length) {
        throw new EmbeddingUnavailableError('invalid embedding response');
      }
      out.push(...(body.vectors as number[][]));
    }
    return out;
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hashed bag-of-words (256 dims, L2-normalised) — mirrors the ai-gateway `fake` provider. */
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

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}
