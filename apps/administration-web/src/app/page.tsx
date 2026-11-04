import Link from 'next/link';

export default function AdministrationHome(): React.JSX.Element {
  return (
    <main>
      <h1>Classroom Intelligence</h1>
      <p>Área administrativa do campus.</p>
      <nav aria-label="Seções">
        <ul>
          <li>
            <Link href="/devices">Dispositivos de captura</Link> — saúde, status e métricas da frota
          </li>
        </ul>
      </nav>
    </main>
  );
}
