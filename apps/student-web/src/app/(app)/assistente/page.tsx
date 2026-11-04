import type { Metadata } from 'next';
import { AssistantChat } from '@/components/AssistantChat';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Assistente acadêmico' };

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ aula?: string }>;
}): Promise<React.JSX.Element> {
  await requireSession();
  const { aula } = await searchParams;
  const scheduledClassId =
    typeof aula === 'string' && /^[0-9a-f-]{36}$/i.test(aula) ? aula : undefined;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Assistente acadêmico</h1>
          <p>
            Respostas baseadas nas aulas das suas turmas, sempre com a fonte.
            {scheduledClassId !== undefined && ' Perguntas focadas na aula selecionada.'}
          </p>
        </div>
      </div>
      <AssistantChat {...(scheduledClassId !== undefined ? { scheduledClassId } : {})} />
    </>
  );
}
