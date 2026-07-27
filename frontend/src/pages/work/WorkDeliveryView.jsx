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
  X,
} from 'lucide-react';
import { handoffsApi } from '../../api/handoffs.js';
import { message } from '../../store/toastStore.js';
import {
  handoffHref,
  handoffReviewActions,
  handoffReviewPayload,
  handoffRiskPresentation,
} from '../handoffPageModel.js';
import {
  deliveryEvidenceRows,
  deliveryHistoryLabel,
  deliveryRefRows,
  workDeliveryView,
} from './workDeliveryModel.js';

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
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [reviewAction, setReviewAction] = useState('');
  const [reviewComment, setReviewComment] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);

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
    setDetailLoading(true);
    setDetailError('');
    handoffsApi.getHandoff(selectedId)
      .then(response => {
        if (active) setDetail(response);
      })
      .catch(error => {
        if (active) setDetailError(error.message || '加载交付详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => {
    setReviewAction('');
    setReviewComment('');
  }, [selectedId]);

  const view = useMemo(() => workDeliveryView({ detail, evidence, work }), [detail, evidence, work]);
  const evidenceRows = useMemo(() => deliveryEvidenceRows(detail, evidence), [detail, evidence]);
  const refs = useMemo(() => deliveryRefRows(detail?.handoff), [detail]);
  const risks = useMemo(() => handoffRiskPresentation(detail?.handoff?.risks), [detail]);
  const reviewActions = handoffReviewActions(detail);

  const selectHandoff = (id) => {
    setSelectedId(id);
    onSelectionChange?.(id);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', handoffHref(id, work?.id));
  };

  const refresh = async () => {
    await onRefresh?.();
    if (!selectedId) return;
    setDetailLoading(true);
    try {
      setDetail(await handoffsApi.getHandoff(selectedId));
      setDetailError('');
    } catch (error) {
      setDetailError(error.message || '刷新交付详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const submitReview = async () => {
    if (!reviewAction || reviewSubmitting) return;
    setReviewSubmitting(true);
    try {
      await handoffsApi.reviewHandoff(
        detail.handoff.id,
        handoffReviewPayload(detail, reviewAction, reviewComment),
      );
      message.success(reviewAction === 'accept' ? '交付评审已通过' : '修改要求已记录');
      setReviewAction('');
      setReviewComment('');
      await refresh();
    } catch (error) {
      message.error(error.message || '提交交付评审失败');
    } finally {
      setReviewSubmitting(false);
    }
  };

  if (loading && handoffs.length === 0) {
    return <DeliveryState icon={<LoaderCircle className="is-spinning" size={20} />} title="正在读取交付凭证…" />;
  }

  if (loadError && handoffs.length === 0) {
    return <DeliveryState icon={<AlertTriangle size={20} />} title="交付凭证暂不可用" detail={loadError} tone="error" />;
  }

  if (handoffs.length === 0) {
    const missing = workDeliveryView({ work });
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
          <span className="work-delivery-eyebrow"><PackageCheck size={14} /> Issue #{detail?.issue?.id || issueID(work?.id)} 的完成凭证</span>
          <h2>交付结果</h2>
          <p>交付要求来自 Issue；Handoff 只记录本次 Run 实际完成的代码、验证与交付动作。</p>
        </div>
        <button disabled={detailLoading} onClick={refresh} type="button">
          <RefreshCw className={detailLoading ? 'is-spinning' : ''} size={14} /> 刷新
        </button>
      </header>

      {detailError ? <div className="work-delivery-error"><AlertTriangle size={15} /> {detailError}</div> : null}

      <div className="work-delivery-summary-grid" aria-busy={detailLoading}>
        <DeliveryFact label="Issue 状态" value={workStatusLabel(work?.status)} tone={work?.status === 'done' ? 'success' : ''} />
        <DeliveryFact label="交付方式" value={view.modeLabel} />
        <DeliveryFact
          label="验证证据"
          value={`${view.evidencePassed}/${view.evidenceLinked} 已通过`}
          tone={view.evidenceFailed > 0 ? 'danger' : view.evidenceLinked > 0 && view.evidencePassed === view.evidenceLinked ? 'success' : ''}
        />
        <DeliveryFact label="需要操作" value={view.nextAction} tone={view.highRiskCount > 0 ? 'warning' : ''} />
      </div>

      <section className="work-delivery-conclusion" data-mode={view.mode || 'missing'}>
        <div><CircleDot size={16} /><strong>{view.statusLabel} · {view.modeLabel}</strong></div>
        <p>{view.deliverySummary}</p>
        <div className="work-delivery-conclusion-counts">
          <span>{view.changedFileCount} 个文件</span>
          <span>{view.evidenceLinked} 项 Evidence</span>
          <span className={view.riskCount > 0 ? 'warning' : ''}>{view.riskCount} 条风险</span>
          <span>{view.reviewLabel}</span>
        </div>
      </section>

      <div className="work-delivery-body">
        {handoffs.length > 1 ? (
          <aside className="work-delivery-history">
            <div><History size={14} /><strong>交付历史</strong><span>{handoffs.length}</span></div>
            {handoffs.map(item => {
              const label = deliveryHistoryLabel(item);
              return (
                <button className={item.id === selectedId ? 'active' : ''} key={item.id} onClick={() => selectHandoff(item.id)} type="button">
                  <span>{label.revisionLabel} · {formatTime(item.updated_at)}</span>
                  <strong>{label.statusLabel}</strong>
                  <small>{item.changed_file_count} 个文件 · {item.evidence_count} 项证据 · {item.risk_count} 条风险</small>
                  <ChevronRight size={13} />
                </button>
              );
            })}
          </aside>
        ) : null}

        <div className="work-delivery-detail">
          <div className="work-delivery-detail-grid">
            <section className="work-delivery-section">
              <SectionHeader icon={<FileCode2 size={16} />} title="代码改动" meta={`${view.changedFileCount} 个文件`} />
              <DiffStats summary={detail?.diff_summary} />
              <div className="work-delivery-files">
                {(detail?.handoff?.changed_files || []).map(path => <code key={path}>{path}</code>)}
              </div>
            </section>

            <section className="work-delivery-section">
              <SectionHeader icon={<TestTube2 size={16} />} title="验证证据" meta={`${view.evidenceLinked} 项`} />
              <div className="work-delivery-evidence">
                {evidenceRows.map(row => (
                  <article key={row.id} data-status={row.status}>
                    {row.status === 'passed' ? <CheckCircle2 size={15} /> : <CircleDot size={15} />}
                    <div>
                      <strong>{evidenceKindLabel(row.kind)}</strong>
                      <p>{row.summary}</p>
                      <span>{row.observedAt ? formatTime(row.observedAt) : '详细摘要未加载'}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          {risks.items.length > 0 ? (
            <section className="work-delivery-section work-delivery-risks">
              <SectionHeader icon={<ShieldAlert size={16} />} title="需要关注" meta={`最高 ${riskLevelLabel(risks.highest)}`} />
              {risks.items.map(risk => (
                <article data-severity={risk.severity} key={risk.id}>
                  <div><strong>{risk.summary}</strong><em>{riskLevelLabel(risk.severity)}</em></div>
                  <p>{risk.mitigation}</p>
                </article>
              ))}
            </section>
          ) : null}

          {reviewActions.length > 0 ? (
            <section className="work-delivery-section work-delivery-review">
              <SectionHeader icon={<CheckCircle2 size={16} />} title="交付评审" meta="需要人工决定" />
              <div className="work-delivery-review-actions">
                {reviewActions.includes('accept') ? <button onClick={() => setReviewAction('accept')} type="button">接受交付</button> : null}
                {reviewActions.includes('request_changes') ? <button onClick={() => setReviewAction('request_changes')} type="button">请求修改</button> : null}
              </div>
            </section>
          ) : null}

          <details className="work-delivery-technical">
            <summary>技术详情与审计引用</summary>
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

      {reviewAction ? (
        <ReviewDialog
          action={reviewAction}
          busy={reviewSubmitting}
          comment={reviewComment}
          onCancel={() => { setReviewAction(''); setReviewComment(''); }}
          onChange={setReviewComment}
          onSubmit={submitReview}
        />
      ) : null}
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
  if (!summary || summary.availability !== 'available') return <p className="work-delivery-muted">当前 Evidence 没有可展示的逐文件 diff 统计。</p>;
  const stats = summary.diff_stats || {};
  return (
    <div className="work-delivery-diff-stats">
      <span><strong>{stats.changed_path_count || 0}</strong> 路径</span>
      <span className="positive"><strong>+{stats.insertions || 0}</strong> 新增</span>
      <span className="negative"><strong>−{stats.deletions || 0}</strong> 删除</span>
      {stats.untracked_file_count > 0 ? <span className="warning"><strong>{stats.untracked_file_count}</strong> 未跟踪</span> : null}
    </div>
  );
}

function TechnicalRef({ label, value }) {
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(`${label} 已复制`);
    } catch {
      message.error(`${label} 复制失败`);
    }
  };
  return <div><span>{label}</span><code>{value}</code><button aria-label={`复制 ${label}`} onClick={copy} type="button"><Copy size={12} /></button></div>;
}

function ReviewDialog({ action, busy, comment, onCancel, onChange, onSubmit }) {
  const requestingChanges = action === 'request_changes';
  return (
    <div className="modal-overlay work-dialog-overlay">
      <form className="work-review-dialog" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <div className="work-delivery-review-title"><strong>{requestingChanges ? '请求修改交付' : '接受当前交付'}</strong><button disabled={busy} onClick={onCancel} type="button"><X size={15} /></button></div>
        <p>{requestingChanges ? '说明必须修改的内容；决定会写入交付审计。' : '确认当前代码、Evidence、风险和交付引用可以接受。'}</p>
        <textarea autoFocus disabled={busy} onChange={event => onChange(event.target.value)} placeholder={requestingChanges ? '需要修改…' : '可选评审说明…'} rows={5} value={comment} />
        <div><button disabled={busy} onClick={onCancel} type="button">取消</button><button className="primary" disabled={busy || (requestingChanges && !comment.trim())} type="submit">{busy ? '提交中…' : requestingChanges ? '提交修改要求' : '接受交付'}</button></div>
      </form>
    </div>
  );
}

function evidenceKindLabel(kind) {
  if (kind === 'git') return 'Git 改动快照';
  if (kind === 'test') return '测试验证';
  if (kind === 'build') return '构建验证';
  if (kind === 'lint') return '代码检查';
  return '交付证据';
}

function riskLevelLabel(level) {
  return { critical: '严重', high: '高', low: '低', medium: '中', none: '无' }[level] || level;
}

function workStatusLabel(status) {
  return {
    cancelled: '已取消',
    done: '已完成',
    failed: '执行失败',
    in_progress: '执行中',
    pending_verification: '等待验收',
    todo: '待执行',
    triage: '待确认',
  }[status] || status || '未知';
}

function issueID(workID) {
  return /^xw:work:issues:(\d+)$/.exec(String(workID || ''))?.[1] || '—';
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
