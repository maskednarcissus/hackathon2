import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Classroom Intelligence — Administration',
  description: 'Campus and institution administration',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
