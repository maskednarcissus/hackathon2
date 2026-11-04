export default function Loading(): React.JSX.Element {
  return (
    <div role="status" aria-live="polite">
      <span className="visually-hidden">Carregando…</span>
      <div className="skeleton" style={{ width: '40%', height: '1.75rem' }} />
      <div className="skeleton" />
      <div className="skeleton" style={{ width: '85%' }} />
      <div className="skeleton" style={{ width: '70%' }} />
    </div>
  );
}
