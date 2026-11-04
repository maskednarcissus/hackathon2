import type { Metadata } from 'next';
import { GovernanceTabs } from '../../components/GovernanceTabs';
import styles from '../../components/dashboard.module.css';
import { Breadcrumb, CohortValue, Empty, Pill, ServiceError } from '../../components/ui';
import { UUID_RE } from '../../lib/action-state';
import { getAdoption } from '../../lib/analytics';
import { formatDateTime } from '../../lib/format';
import {
  getConsentStatus,
  listPolicies,
  listPolicyVersions,
  type ConsentStatus,
  type PolicyVersion,
  type RecordingPolicy,
} from '../../lib/governance';
import { addDays, itemsOf, today } from '../../lib/http';
import type { ApiResult } from '../../lib/fleet';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Governança da gravação — Classroom Intelligence' };

const MAX_SECTIONS = 40;

const FIELD_LABELS: Record<string, string> = {
  name: 'Nome',
  legalBasis: 'Base legal',
  requiresExplicitConsent: 'Exige consentimento explícito',
  audioRetentionDays: 'Retenção do áudio (dias)',
  transcriptRetentionDays: 'Retenção da transcrição (dias)',
  summaryRetentionDays: 'Retenção do resumo (dias)',
  extractedEventRetentionDays: 'Retenção de eventos (dias)',
  allowRawAudioAccess: 'Acesso ao áudio bruto',
  recordingEnabled: 'Gravação habilitada',
  preRollMinutes: 'Início antecipado (min)',
  postRollMinutes: 'Término estendido (min)',
};

const show = (v: unknown): string =>
  typeof v === 'boolean' ? (v ? 'Sim' : 'Não') : v == null ? '—' : String(v);

function PolicyCard({
  policy,
  versions,
}: {
  policy: RecordingPolicy;
  versions: ApiResult<PolicyVersion[] | { items: PolicyVersion[] }>;
}): React.JSX.Element {
  const typed = versions.ok ? itemsOf(versions.data) : [];
  return (
    <article className="card" aria-labelledby={`pol-${policy.id}`}>
      <h3 id={`pol-${policy.id}`}>
        {policy.name}{' '}
        {policy.version != null ? <span className="muted">v{policy.version}</span> : null}
      </h3>
      <dl className={styles.metricGrid}>
        <div>
          <dt>Base legal</dt>
          <dd>{policy.legalBasis}</dd>
        </div>
        <div>
          <dt>Consentimento explícito</dt>
          <dd>{policy.requiresExplicitConsent ? 'Exigido' : 'Não exigido'}</dd>
        </div>
        <div>
          <dt>Retenção: áudio / transcrição / resumo</dt>
          <dd>
            {policy.audioRetentionDays} / {policy.transcriptRetentionDays} /{' '}
            {policy.summaryRetentionDays} dias
          </dd>
        </div>
        <div>
          <dt>Acesso ao áudio bruto</dt>
          <dd>{policy.allowRawAudioAccess ? 'Permitido' : 'Bloqueado'}</dd>
        </div>
      </dl>
      <details>
        <summary>Histórico de versões ({typed.length})</summary>
        {!versions.ok ? (
          <p className="muted">Versões indisponíveis: {versions.error}</p>
        ) : typed.length === 0 ? (
          <p className="muted">Nenhuma versão anterior.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Versões imutáveis da política {policy.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Versão</th>
                  <th scope="col">Criada em</th>
                  <th scope="col">Por</th>
                  <th scope="col">Alterações</th>
                </tr>
              </thead>
              <tbody>
                {[...typed]
                  .sort((a, b) => b.version - a.version)
                  .map((v) => (
                    <tr key={v.version}>
                      <td>v{v.version}</td>
                      <td>{formatDateTime(v.createdAt)}</td>
                      <td>{v.createdBy ? v.createdBy.slice(0, 8) : '—'}</td>
                      <td className="wrap">
                        {v.changes && Object.keys(v.changes).length > 0
                          ? Object.entries(v.changes)
                              .map(
                                ([k, c]) =>
                                  `${FIELD_LABELS[k] ?? k}: ${show(c.from)} → ${show(c.to)}`,
                              )
                              .join('; ')
                          : 'Versão inicial'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </article>
  );
}

function ConsentRow({
  label,
  status,
}: {
  label: string;
  status: ApiResult<ConsentStatus>;
}): React.JSX.Element {
  if (!status.ok) {
    return (
      <tr>
        <th scope="row">{label}</th>
        <td colSpan={4} className="muted">
          {status.status === 404 ? 'Sem política associada' : 'Indisponível'}
        </td>
      </tr>
    );
  }
  const s = status.data;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{s.requiresExplicitConsent ? 'Sim' : 'Não'}</td>
      <td>{s.allProfessorsConsented ? '✓ Sim' : '✕ Não'}</td>
      <td>
        <CohortValue value={s.studentsConsented} /> / <CohortValue value={s.studentsTotal} />
      </td>
      <td>
        {s.recordingAllowed ? (
          <Pill icon="●" tone="success">
            Permitida
          </Pill>
        ) : (
          <Pill icon="■" tone="danger">
            Bloqueada (consentimento pendente)
          </Pill>
        )}
      </td>
    </tr>
  );
}

export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<{ secao?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const [policies, adoption] = await Promise.all([
    listPolicies(),
    getAdoption({ from: addDays(today(), -90), to: today() }),
  ]);
  const policyList = policies.ok ? itemsOf(policies.data) : [];
  const versions = await Promise.all(policyList.map((p) => listPolicyVersions(p.id)));

  const sections = new Map<string, string>();
  if (sp.secao && UUID_RE.test(sp.secao)) sections.set(sp.secao, sp.secao);
  if (adoption.ok) {
    for (const p of adoption.data.professors) {
      if (sections.size >= MAX_SECTIONS) break;
      if (!sections.has(p.classSectionId)) {
        sections.set(
          p.classSectionId,
          `${p.courseName ?? p.courseId}${p.sectionCode ? ` (${p.sectionCode})` : ''}`,
        );
      }
    }
  }
  const sectionIds = [...sections.keys()];
  const consent = await Promise.all(sectionIds.map((id) => getConsentStatus(id)));

  return (
    <main>
      <Breadcrumb trail={[{ href: '/', label: 'Administração' }, { label: 'Governança' }]} />
      <h1>Governança da gravação</h1>
      <GovernanceTabs current="politicas" />

      <section aria-labelledby="pol-h">
        <h2 id="pol-h">Políticas de gravação</h2>
        <p className="muted">
          Cada alteração gera uma versão imutável; gravações referenciam a versão vigente.
        </p>
        {!policies.ok ? (
          <ServiceError
            title="Políticas indisponíveis"
            message={policies.error}
            status={policies.status}
          />
        ) : policyList.length === 0 ? (
          <Empty>Nenhuma política cadastrada para a instituição.</Empty>
        ) : (
          policyList.map((p, idx) => (
            <PolicyCard
              key={p.id}
              policy={p}
              versions={versions[idx] ?? { ok: false, error: 'sem dados', fetchedAt: '' }}
            />
          ))
        )}
      </section>

      <section aria-labelledby="consent-h" className="card">
        <h2 id="consent-h">Consentimento por turma</h2>
        <form className="filterForm" method="get" aria-label="Consultar turma">
          <label>
            Consultar turma (ID)
            <input
              name="secao"
              defaultValue={sp.secao ?? ''}
              placeholder="UUID da turma"
              size={38}
            />
          </label>
          <button type="submit" className="button secondary">
            Consultar
          </button>
        </form>
        {sectionIds.length === 0 ? (
          <Empty>Nenhuma turma encontrada nos últimos 90 dias.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Situação do consentimento (contagens de estudantes seguem a regra de coorte mínima)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Turma</th>
                  <th scope="col">Exige consentimento</th>
                  <th scope="col">Professores consentiram</th>
                  <th scope="col">Estudantes (consentiram / total)</th>
                  <th scope="col">Gravação</th>
                </tr>
              </thead>
              <tbody>
                {sectionIds.map((id, idx) => (
                  <ConsentRow
                    key={id}
                    label={sections.get(id) ?? id}
                    status={consent[idx] ?? { ok: false, error: '', fetchedAt: '' }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
