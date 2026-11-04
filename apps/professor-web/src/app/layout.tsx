import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Classroom Intelligence — Professor',
  description: 'Lecture management and academic event confirmation',
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
