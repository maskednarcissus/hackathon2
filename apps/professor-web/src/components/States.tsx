import type { ApiError } from '@/lib/api';

export function ErrorState({
  error,
  title = 'Não foi possível carregar os dados',
}: {
  error: unknown;
  title?: string;
}): React.JSX.Element {
  const apiError = error as Partial<ApiError> | undefined;
  const unreachable = apiError?.status === null;
  return (
    <div role="alert" className="state state-error">
      <h2>{title}</h2>
      <p>{error instanceof Error ? error.message : 'Erro inesperado.'}</p>
      {unreachable ? (
        <p className="muted">
          Verifique se o serviço está em execução e se a variável de ambiente correspondente
          (EVENT_EXTRACTION_URL / TRANSCRIPT_MANAGEMENT_URL) está correta.
        </p>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="state state-empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function AiNotice(): React.JSX.Element {
  return (
    <p className="ai-notice" role="note">
      <strong>Sugestão gerada por IA.</strong> Os anúncios abaixo foram extraídos automaticamente da
      transcrição da aula e <em>não</em> são declarações do professor até que você os confirme.
      Confira sempre o trecho original antes de publicar.
    </p>
  );
}

export function Flash({ message }: { message: string | undefined }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p role="status" className="flash">
      {message}
    </p>
  );
}
