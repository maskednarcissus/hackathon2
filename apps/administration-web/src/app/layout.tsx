import type { Metadata } from 'next';
import Link from 'next/link';
import { NavLinks } from '../components/NavLinks';
import './globals.css';

export const metadata: Metadata = {
  title: 'Classroom Intelligence — Administração',
  description: 'Operação acadêmica, captura, incidentes e governança da instituição',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body>
        <a className="skipLink" href="#conteudo">
          Pular para o conteúdo
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            Classroom Intelligence · Administração
          </Link>
          <nav aria-label="Principal" className="mainNav">
            <NavLinks />
          </nav>
        </header>
        <div id="conteudo" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}
