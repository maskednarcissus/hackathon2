import { limitationText } from '@/lib/revision';

/** Always-visible honesty block for AI revision material (+ plan-specific limitations). */
export function RevisionNotice({
  limitations = [],
  dropped = 0,
}: {
  limitations?: string[];
  dropped?: number;
}): React.JSX.Element {
  return (
    <section className="card limitations" aria-labelledby="limits-title">
      <h2 id="limits-title">Sobre este material</h2>
      <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
        <li>
          Todo o conteúdo de revisão é <strong>gerado por IA</strong> a partir das transcrições das
          aulas. Pode conter imprecisões: confira sempre o trecho citado.
        </li>
        <li>Não substitui o material oficial nem a explicação do professor.</li>
        <li>
          A personalização considera só as suas perguntas ao assistente e as suas revisões. Buscas e
          denúncias ainda não são consideradas.
        </li>
        <li>
          O agendamento (repetição espaçada SM-2) depende das notas que você dá a cada revisão.
        </li>
        {dropped > 0 && (
          <li>
            {dropped} item(ns) gerado(s) foram descartados por não estarem apoiados nas
            transcrições.
          </li>
        )}
        {[...new Set(limitations)].map((code) => (
          <li key={code}>
            <strong>{limitationText(code)}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
