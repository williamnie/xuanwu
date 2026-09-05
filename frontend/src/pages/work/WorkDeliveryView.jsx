import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Copy,
  FileCode2,
  History,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  TestTube2,
} from 'lucide-react';
import { handoffsApi } from '../../api/handoffs.js';
import { message } from '../../store/toastStore.js';
import {
  handoffHref,
  handoffRiskPresentation,
} from '../handoffPageModel.js';
import {
  deliveryEvidenceRows,
  deliveryHistoryLabel,
  deliveryRefRows,
  workDeliveryView,
} from './workDeliveryModel.js';
import { useI18n } from '../../i18n/context.js';

export default function WorkDeliveryView({
  evidence = [],
  handoffs = [],
  loading = false,
  loadError = '',
  onRefresh,
  onSelectionChange,
  selectedHandoffId = '',
  work,
}) {
  const { language, t } = useI18n();
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    const requested = selectedHandoffId || '';
    setSelectedId(current => requested || (handoffs.some(item => item.id === current) ? current : handoffs[0]?.id || ''));
  }, [handoffs, selectedHandoffId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError('');
      return undefined;
    }
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    handoffsApi.getHandoff(selectedId)
      .then(response => {
        if (!active) return;
        if (work?.id && response?.handoff?.work_id !== work.id) {
          setDetailError(t('delivery.loadFailed'));
          return;
        }
        setDetail(response);
      })
      .catch(error => {
        if (active) setDetailError(error.message || t('delivery.loadFailed'));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [refreshVersion, selectedId, t, work?.id]);


  const view = useMemo(() => workDeliveryView({ detail, evidence, language, work }), [detail, evidence, language, work]);
  const evidenceRows = useMemo(() => deliveryEvidenceRows(detail, evidence, language), [detail, evidence, language]);
  const refs = useMemo(() => deliveryRefRows(detail?.handoff, language), [detail, language]);
  const risks = useMemo(() => handoffRiskPresentation(detail?.handoff?.risks), [detail]);

  const selectHandoff = (id) => {
    setSelectedId(id);
    onSelectionChange?.(id);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', handoffHref(id, work?.id));
  };

  const refresh = async () => {
    await onRefresh?.();
    setRefreshVersion(version => version + 1);
  };



  if (loading && handoffs.length === 0) {
    return <DeliveryState icon={<LoaderCircle className="is-spinning" size={20} />} title={t('delivery.loading')} />;
  }

  if (loadError && handoffs.length === 0) {
    return <DeliveryState icon={<AlertTriangle size={20} />} title={t('delivery.unavailable')} detail={loadError} tone="error" />;
  }

  if (handoffs.length === 0) {
    const missing = workDeliveryView({ language, work });
    return (
      <DeliveryState
        icon={<PackageCheck size={22} />}
        title={missing.statusLabel}
        detail={missing.deliverySummary}
        tone={work?.status === 'done' ? 'warning' : ''}
      />
    );
  }

  return (
    <div className="work-delivery-view">
      <header className="work-delivery-header">
        <div>
          <span className="work-delivery-eyebrow"><PackageCheck size={14} /> {t('delivery.credentialForIssue', { issue: detail?.issue?.id || issueID(work?.id) })}</span>
          <h2>{t('delivery.result')}</h2>
          <p>{t('delivery.description')}</p>
        </div>
        <button disabled={detailLoading} onClick={refresh} type="button">
          <RefreshCw className={detailLoading ? 'is-spinning' : ''} size={14} /> {t('work.refresh')}
        </button>
      </header>

      {detailError ? <div className="work-delivery-error"><AlertTriangle size={15} /> {detailError}</div> : null}

      <div className="work-delivery-summary-grid" aria-busy={detailLoading}>
        <DeliveryFact label={t('delivery.issueStatus')} value={t(`status.${work?.status}`)} tone={work?.status === 'done' ? 'success' : ''} />
        <DeliveryFact label={t('delivery.mode')} value={view.modeLabel} />
        <DeliveryFact
          label={t('delivery.evidence')}
          value={t('delivery.passedRatio', { passed: view.evidencePassed, total: view.evidenceLinked })}
          tone={view.evidenceFailed > 0 ? 'danger' : view.evidenceLinked > 0 && view.evidencePassed === view.evidenceLinked ? 'success' : ''}
        />
        <DeliveryFact label={t('delivery.actionNeeded')} value={view.nextAction} tone={view.highRiskCount > 0 ? 'warning' : ''} />
      </div>

      <section className="work-delivery-conclusion" data-mode={view.mode || 'missing'}>
        <div><CircleDot size={16} /><strong>{view.statusLabel} · {view.modeLabel}</strong></div>
        <p><strong>{language === 'en-US' ? 'What changed' : '改了什么'}</strong> · {view.changeSummary}</p>
        <p>{view.deliverySummary}</p>
        <div className="work-delivery-milestones" aria-label={language === 'en-US' ? 'Verified delivery facts' : '实际交付进度'}>
          {(view.milestones || []).map(item => <div key={item.key} data-status={item.status}><span>{item.label}</span><strong>{item.value}</strong></div>)}
        </div>
        <p><strong>{language === 'en-US' ? 'Your next step' : '需要你做什么'}</strong> · {view.nextAction}</p>
        <div className="work-delivery-conclusion-counts">
          <span>{t('delivery.files', { count: view.changedFileCount })}</span>
          <span>{t('delivery.evidenceCount', { count: view.evidenceLinked })}</span>
          <span className={view.riskCount > 0 ? 'warning' : ''}>{t('delivery.risks', { count: view.riskCount })}</span>
        </div>
      </section>

      <div className="work-delivery-body">
        {handoffs.length > 1 ? (
          <aside className="work-delivery-history">
            <div><History size={14} /><strong>{t('delivery.history')}</strong><span>{handoffs.length}</span></div>
            {handoffs.map(item => {
              const label = deliveryHistoryLabel(item, language);
              return (
                <button className={item.id === selectedId ? 'active' : ''} key={item.id} onClick={() => selectHandoff(item.id)} type="button">
                  <span>{label.revisionLabel} · {formatTime(item.updated_at, language)}</span>
                  <strong>{label.statusLabel}</strong>
                  <small>{t('work.handoff.summary', { files: item.changed_file_count, evidence: item.evidence_count, risks: item.risk_count })}</small>
                  <ChevronRight size={13} />
                </button>
              );
            })}
          </aside>
        ) : null}

        <div className="work-delivery-detail">
          <div className="work-delivery-detail-grid">
            <section className="work-delivery-section">
              <SectionHeader icon={<FileCode2 size={16} />} title={t('delivery.codeChanges')} meta={t('delivery.files', { count: view.changedFileCount })} />
              <DiffStats summary={detail?.diff_summary} />
              <div className="work-delivery-files">
                {(detail?.handoff?.changed_files || []).map(path => <code key={path}>{path}</code>)}
              </div>
            </section>

            <section className="work-delivery-section">
              <SectionHeader icon={<TestTube2 size={16} />} title={t('delivery.evidence')} meta={t('delivery.items', { count: view.evidenceLinked })} />
              <div className="work-delivery-evidence">
                {evidenceRows.map(row => (
                  <article key={row.id} data-status={row.status}>
                    {row.status === 'passed' ? <CheckCircle2 size={15} /> : <CircleDot size={15} />}
                    <div>
                      <strong>{evidenceKindLabel(row.kind, t)}</strong>
                      <p>{row.summary}</p>
                      <span>{row.observedAt ? formatTime(row.observedAt, language) : t('delivery.summaryNotLoaded')}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          {risks.items.length > 0 ? (
            <section className="work-delivery-section work-delivery-risks">
              <SectionHeader icon={<ShieldAlert size={16} />} title={t('delivery.attention')} meta={t('delivery.highestRisk', { level: riskLevelLabel(risks.highest, t) })} />
              {risks.items.map(risk => (
                <article data-severity={risk.severity} key={risk.id}>
                  <div><strong>{risk.summary}</strong><em>{riskLevelLabel(risk.severity, t)}</em></div>
                  <p>{risk.mitigation}</p>
                </article>
              ))}
            </section>
          ) : null}

          <details className="work-delivery-technical">
            <summary>{t('delivery.technicalDetails')}</summary>
            <div className="work-delivery-refs">
              {refs.map(ref => <TechnicalRef key={`${ref.label}:${ref.value}`} label={ref.label} value={ref.value} />)}
              <TechnicalRef label="Handoff ID" value={detail?.handoff?.id} />
              <TechnicalRef label="Run" value={detail?.handoff?.run_ids?.join(', ')} />
              <TechnicalRef label="Baseline" value={detail?.handoff?.baseline_revision} />
              <TechnicalRef label="Final revision" value={detail?.handoff?.final_revision} />
            </div>
          </details>
        </div>
      </div>

    </div>
  );
}

function DeliveryState({ detail = '', icon, title, tone = '' }) {
  return <div className={`work-delivery-state ${tone}`} role={tone === 'error' ? 'alert' : undefined}>{icon}<div><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</div></div>;
}

function DeliveryFact({ label, tone = '', value }) {
  return <div className={tone}><span>{label}</span><strong>{value}</strong></div>;
}

function SectionHeader({ icon, meta, title }) {
  return <header className="work-delivery-section-header"><div>{icon}<h3>{title}</h3></div><span>{meta}</span></header>;
}

function DiffStats({ summary }) {
  const { t } = useI18n();
  if (!summary || summary.availability !== 'available') return <p className="work-delivery-muted">{t('delivery.noDiffStats')}</p>;
  const stats = summary.diff_stats || {};
  return (
    <div className="work-delivery-diff-stats">
      <span><strong>{stats.changed_path_count || 0}</strong> {t('delivery.paths')}</span>
      <span className="positive"><strong>+{stats.insertions || 0}</strong> {t('delivery.insertions')}</span>
      <span className="negative"><strong>−{stats.deletions || 0}</strong> {t('delivery.deletions')}</span>
      {stats.untracked_file_count > 0 ? <span className="warning"><strong>{stats.untracked_file_count}</strong> {t('delivery.untracked')}</span> : null}
    </div>
  );
}

function TechnicalRef({ label, value }) {
  const { t } = useI18n();
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(t('delivery.copied', { label }));
    } catch {
      message.error(t('delivery.copyFailed', { label }));
    }
  };
  return <div><span>{label}</span><code>{value}</code><button aria-label={t('delivery.copy', { label })} onClick={copy} type="button"><Copy size={12} /></button></div>;
}

function evidenceKindLabel(kind, t) {
  if (kind === 'git') return t('delivery.evidenceGit');
  if (kind === 'test') return t('delivery.evidenceTest');
  if (kind === 'build') return t('delivery.evidenceBuild');
  if (kind === 'lint') return t('delivery.evidenceLint');
  return t('delivery.evidenceOther');
}

function riskLevelLabel(level, t) {
  return t(`risk.${level || 'none'}`);
}

function issueID(workID) {
  return /^xw:work:issues:(\d+)$/.exec(String(workID || ''))?.[1] || '—';
}

function formatTime(value, language) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(language, { hour12: false });
}
