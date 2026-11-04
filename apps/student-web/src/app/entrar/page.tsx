import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { getSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Entrar' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sessao?: string }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const session = await getSession();
  if (session !== null && params.sessao !== 'expirada') redirect('/');
  const next = typeof params.next === 'string' ? params.next : '/';
  return (
    <main id="conteudo" tabIndex={-1} style={{ maxWidth: 440, paddingBottom: 32 }}>
      <div style={{ marginTop: '8vh' }} className="card">
        <h1>Entrar</h1>
        <p className="muted">Acesse suas aulas, seu calendário e o assistente acadêmico.</p>
        {params.sessao === 'expirada' && (
          <div className="alert alert--info" role="status">
            <p>Sua sessão expirou. Entre novamente para continuar.</p>
          </div>
        )}
        <LoginForm next={next} askInstitution={(process.env['INSTITUTION_ID'] ?? '') === ''} />
      </div>
      <p className="small muted" style={{ marginTop: 16 }}>
        As aulas são gravadas conforme a política de gravação da sua instituição (LGPD). Resumos e
        eventos extraídos são gerados por IA e sempre indicam a fonte.
      </p>
    </main>
  );
}
