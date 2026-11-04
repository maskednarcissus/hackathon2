import { dsrExecuteAction, dsrRejectAction, dsrVerifyAction } from '../app/governanca/actions';
import type { DataSubjectRequest } from '../lib/governance';
import { ActionForm } from './ActionForm';

export function DsrActions({ request }: { request: DataSubjectRequest }): React.JSX.Element | null {
  const s = request.status;
  if (s === 'completed' || s === 'rejected') return null;
  const destructive = request.type === 'deletion' || request.type === 'anonymization';
  return (
    <div>
      {s === 'received' ? (
        <ActionForm
          action={dsrVerifyAction.bind(null, request.id)}
          submitLabel="Verificar identidade"
          tone="secondary"
        />
      ) : null}
      {s === 'verifying' ? (
        <ActionForm
          action={dsrExecuteAction.bind(null, request.id)}
          submitLabel="Executar"
          {...(destructive
            ? {
                tone: 'danger' as const,
                confirm:
                  'Esta solicitação elimina ou anonimiza dados pessoais em todos os serviços. Continuar?',
              }
            : {})}
        />
      ) : null}
      <details>
        <summary>Rejeitar</summary>
        <ActionForm
          action={dsrRejectAction.bind(null, request.id)}
          submitLabel="Rejeitar solicitação"
          tone="danger"
        >
          <label>
            Motivo
            <textarea name="reason" required maxLength={2000} />
          </label>
        </ActionForm>
      </details>
    </div>
  );
}
