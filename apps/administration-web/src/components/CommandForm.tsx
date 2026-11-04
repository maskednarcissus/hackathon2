import { sendCommandAction } from '../app/devices/actions';
import { COMMAND_LABELS, COMMAND_TYPES } from '../lib/console';
import { ActionForm } from './ActionForm';

export function CommandForm({
  deviceId,
  compact = false,
}: {
  deviceId: string;
  compact?: boolean;
}): React.JSX.Element {
  const id = `cmd-${deviceId}`;
  return (
    <ActionForm
      action={sendCommandAction.bind(null, deviceId)}
      submitLabel={compact ? 'Enviar' : 'Enviar comando'}
      tone="secondary"
    >
      <label htmlFor={id} className={compact ? 'visually-hidden' : undefined}>
        Comando remoto
      </label>
      <select id={id} name="type" defaultValue="self_test">
        {COMMAND_TYPES.map((t) => (
          <option key={t} value={t}>
            {COMMAND_LABELS[t]}
          </option>
        ))}
      </select>
    </ActionForm>
  );
}
