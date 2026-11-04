import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Classroom Intelligence — Professor',
  description: 'Revisão de anúncios acadêmicos e correção de transcrições',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body>
        <a className="skip-link" href="#conteudo">
          Pular para o conteúdo
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            Classroom Intelligence · Professor
          </Link>
          <nav aria-label="Principal">
            <ul>
              <li>
                <Link href="/anuncios">Anúncios para revisar</Link>
              </li>
            </ul>
          </nav>
        </header>
        <main id="conteudo">{children}</main>
      </body>
    </html>
  );
}
