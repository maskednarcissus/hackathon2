import Link from 'next/link';

export default function NotFound(): React.JSX.Element {
  return (
    <main id="conteudo" tabIndex={-1}>
      <div className="state">
        <h1>Página não encontrada</h1>
        <p>O conteúdo que você procura não existe ou você não tem acesso a ele.</p>
        <Link href="/" className="btn">
          Voltar ao início
        </Link>
      </div>
    </main>
  );
}
