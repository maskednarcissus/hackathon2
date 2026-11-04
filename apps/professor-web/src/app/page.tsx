import Link from 'next/link';

export default function ProfessorHome(): React.JSX.Element {
  return (
    <>
      <h1>Área do professor</h1>
      <p className="muted">
        Revise os anúncios que a IA identificou nas suas aulas antes que eles cheguem ao calendário
        dos alunos, e corrija trechos da transcrição quando necessário.
      </p>
      <div className="card">
        <h2>
          <Link href="/anuncios">Anúncios aguardando revisão</Link>
        </h2>
        <p>
          Provas, trabalhos, prazos e mudanças de aula detectados nas gravações. Nada é publicado
          para os alunos sem passar pelas regras de publicação da instituição.
        </p>
      </div>
      <div className="card">
        <h2>Transcrições</h2>
        <p>
          Abra uma transcrição a partir do trecho de origem de um anúncio para revisar e corrigir o
          texto. A versão original da máquina é sempre preservada.
        </p>
      </div>
    </>
  );
}
