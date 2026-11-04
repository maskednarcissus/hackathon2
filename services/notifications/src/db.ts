import pg from 'pg';

// DATE → 'YYYY-MM-DD' string (default would build a local-time Date and shift the day).
pg.types.setTypeParser(1082, (v: string) => v);

export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 10) });
  // an idle client losing its connection must not crash the process
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return pool;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const iso = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString()
      : new Date(v).toISOString();

export const isoRequired = (v: Date | string): string => iso(v)!;

/** Runs `fn` in a transaction on a dedicated client. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
