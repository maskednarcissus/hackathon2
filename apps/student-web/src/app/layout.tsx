import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Classroom Intelligence — Student',
  description: 'Your academic companion',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
