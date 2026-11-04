import { isReportKind, reportCsvPath } from '../../../../lib/analytics';
import { addDays, authHeaders, isIsoDate, serviceUrl, today } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

/** Proxies academic-analytics `format=csv` so the admin token never reaches the browser. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await params;
  if (!isReportKind(kind)) return new Response('Relatório desconhecido', { status: 404 });
  const url = new URL(request.url);
  const toParam = url.searchParams.get('to') ?? undefined;
  const fromParam = url.searchParams.get('from') ?? undefined;
  const to = isIsoDate(toParam) ? toParam : today();
  const from = isIsoDate(fromParam) && fromParam <= to ? fromParam : addDays(to, -30);

  let upstream: Response;
  try {
    upstream = await fetch(`${serviceUrl('analytics')}${reportCsvPath(kind, { from, to })}`, {
      headers: { accept: 'text/csv', ...authHeaders('analytics') },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return new Response('Serviço de análises indisponível', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(`Falha ao gerar o relatório (HTTP ${upstream.status})`, { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${kind}_${from}_${to}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}
