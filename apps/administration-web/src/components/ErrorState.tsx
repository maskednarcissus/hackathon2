export function ErrorState({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.JSX.Element {
  return (
    <div role="alert" className="errorBox">
      <strong>{title}</strong>
      <p>{message}</p>
      <p className="muted">
        Verifique se o serviço <code>device-management</code> está acessível (variável{' '}
        <code>DEVICE_MANAGEMENT_URL</code>). A página tentará novamente automaticamente.
      </p>
    </div>
  );
}
