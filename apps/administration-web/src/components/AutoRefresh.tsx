'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Re-renders the server component every `seconds` (pauses while the tab is hidden). */
export function AutoRefresh({
  seconds = 30,
  fetchedAt,
}: {
  seconds?: number;
  fetchedAt: string;
}): React.JSX.Element {
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return undefined;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return (): void => window.clearInterval(id);
  }, [paused, router, seconds]);

  return (
    <p className="muted" aria-live="polite">
      Atualizado em {new Date(fetchedAt).toLocaleTimeString('pt-BR')} ·{' '}
      {paused ? 'atualização automática pausada' : `atualiza a cada ${seconds} s`} ·{' '}
      <button type="button" className="linkButton" onClick={() => setPaused((p) => !p)}>
        {paused ? 'Retomar' : 'Pausar'}
      </button>{' '}
      ·{' '}
      <button type="button" className="linkButton" onClick={() => router.refresh()}>
        Atualizar agora
      </button>
    </p>
  );
}
