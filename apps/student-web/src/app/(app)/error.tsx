'use client';

import { useEffect } from 'react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="state" role="alert">
      <h1>Algo deu errado</h1>
      <p>Não foi possível exibir esta página agora. Tente novamente em instantes.</p>
      {error.digest !== undefined && <p className="small">Código do erro: {error.digest}</p>}
      <button type="button" className="btn" onClick={reset}>
        Tentar novamente
      </button>
    </div>
  );
}
