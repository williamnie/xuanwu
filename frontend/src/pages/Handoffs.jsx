import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  PackageCheck,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Tag,
  Undo2,
} from 'lucide-react';
import { handoffsApi } from '../api/handoffs.js';
import { eventsApi } from '../api/events.js';
import { selectProjects, useDataStore } from '../store/dataStore';
import { message } from '../store/toastStore';
import {
  deliveryTone,
  displayRef,
  handoffCopyText,
  handoffHref,
  handoffRiskPresentation,
  safeExternalUrl,
} from './handoffPageModel.js';
import './Handoffs.css';

const STATUS_OPTIONS = ['', 'draft', 'ready', 'delivered', 'superseded'];
const MODE_OPTIONS = ['', 'local_changes', 'branch_commit', 'push', 'draft_pr', 'ready_pr', 'deploy', 'release'];

export default function Handoffs({ selectedHandoffId = '' }) {
  const projects = useDataStore(selectProjects);
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(selectedHandoffId);
  const [detail, setDetail] = useState(null);
  const [filters, setFilters] = useState({ deliveryMode: '', projectId: '', status: '' });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedHandoffId) setSelectedId(selectedHandoffId);
  }, [selectedHandoffId]);

  useEffect(() => eventsApi.subscribeToEvents((event) => {
    if (event.type === 'handoff.notification') setRefreshVersion(version => version + 1);
  }), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    handoffsApi.getHandoffs(filters)
      .then((response) => {
        if (!active) return;
        const nextItems = response?.items || [];
        setItems(nextItems);
        setSelectedId(current => current || nextItems[0]?.id || '');
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || '加载 Handoff 失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [filters, refreshVersion]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    let active = true;
    setDetailLoading(true);
    handoffsApi.getHandoff(selectedId)
      .then((response) => {
        if (active) setDetail(response);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || '加载 Handoff 详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [refreshVersion, selectedId]);

  const stats = useMemo(() => ({
    delivered: items.filter(item => item.delivery_status?.overall === 'delivered').length,
    ready: items.filter(item => item.delivery_status?.overall === 'ready').length,
    risks: items.reduce((total, item) => total + (item.risk_count || 0), 0),
  }), [items]);

  const selectHandoff = (id) => {
    setSelectedId(id);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', handoffHref(id));
  };

  const refresh = () => setRefreshVersion(version => version + 1);

  return (
    <section className="handoff-page">
      <header className="handoff-header">
        <div>
          <span className="handoff-kicker"><PackageCheck size={14} /> Delivery protocol</span>
          <h1>Handoff 审计</h1>
          <p>高级审计视图；日常查看请从对应 Issue / Work 的“交付”页签进入。</p>
        </div>
        <button className="handoff-refresh" disabled={loading || detailLoading} onClick={refresh} type="button">
          <RefreshCw className={loading || detailLoading ? 'is-spinning' : ''} size={15} /> 刷新交付状态
        </button>
        <div className="handoff-stats" aria-label="Handoff summary">
          <HandoffStat label="Visible" value={items.length} />
          <HandoffStat label="Ready" tone="blue" value={stats.ready} />
          <HandoffStat label="Delivered" tone="green" value={stats.delivered} />
          <HandoffStat label="Risks" tone="amber" value={stats.risks} />
        </div>
      </header>

      <div className="handoff-authority-note">
        <span />
        <strong>Facts stay with Git, Evidence, review and delivery audit.</strong>
        <p>当前列表读取 append-only Handoff stream；刷新只重读本地 outbox/交付事实，不触发外部写。</p>
        <code>issue_events:handoff.*.v1</code>
      </div>

      <div className="handoff-filters">
        <Filter label="Project" onChange={projectId => setFilters(current => ({ ...current, projectId }))} value={filters.projectId}>
          <option value="">All projects</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </Filter>
        <Filter label="Status" onChange={status => setFilters(current => ({ ...current, status }))} value={filters.status}>
          {STATUS_OPTIONS.map(status => <option key={status || 'all'} value={status}>{status || 'All statuses'}</option>)}
        </Filter>
        <Filter label="Delivery" onChange={deliveryMode => setFilters(current => ({ ...current, deliveryMode }))} value={filters.deliveryMode}>
          {MODE_OPTIONS.map(mode => <option key={mode || 'all'} value={mode}>{mode || 'All modes'}</option>)}
        </Filter>
      </div>

      {error ? (
        <div className="handoff-error" role="alert">
          <AlertTriangle size={18} />
          <div><strong>Handoff 暂不可用</strong><span>{error}</span></div>
          <button onClick={refresh} type="button">重试</button>
        </div>
      ) : (
        <div className="handoff-workspace" aria-busy={loading || detailLoading}>
          <aside className="handoff-list" aria-label="Handoff list">
            <div className="handoff-list-title"><span>Latest delivery</span><strong>{items.length}</strong></div>
            {items.length > 0 ? items.map(item => (
              <button
                className={`handoff-list-item ${selectedId === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => selectHandoff(item.id)}
                type="button"
              >
                <span className="handoff-list-topline">
                  <StatusBadge status={item.delivery_status?.overall || item.status} />
                  <time>{formatTime(item.updated_at)}</time>
                </span>
                <strong>{item.issue?.id ? `#${item.issue.id} ` : ''}{item.issue?.title || '未关联 Issue 标题'}</strong>
                <span className="handoff-list-summary">{item.summary}</span>
                <span className="handoff-list-ref">
                  {item.delivery?.branch_ref ? <><GitBranch size={12} /> {displayRef(item.delivery.branch_ref, 18, 8)}</> : item.delivery?.mode}
                </span>
                <span className="handoff-list-counts">
                  {item.changed_file_count} files · {item.evidence_count} Evidence · {item.risk_count} risks
                </span>
              </button>
            )) : (
              <div className="handoff-empty">{loading ? '正在读取交付记录…' : '当前过滤条件下没有 Handoff。'}</div>
            )}
          </aside>

          <main className="handoff-detail">
            {detail ? <HandoffDetail detail={detail} onRefresh={refresh} /> : (
              <div className="handoff-empty-detail"><PackageCheck size={30} /><strong>选择一个 Handoff</strong><span>查看交付 refs、Evidence、风险和下一步。</span></div>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function HandoffDetail({ detail, onRefresh }) {
  const handoff = detail.handoff;
  const delivery = handoff.delivery || {};
  const riskPresentation = handoffRiskPresentation(handoff.risks);
  const status = detail.delivery_status?.overall || handoff.status;
  const externalUrl = safeExternalUrl(detail.notification_summary?.external_url || delivery.url);


  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(`${label} 已复制`);
    } catch {
      message.error(`${label} 复制失败`);
    }
  };



  return (
    <article className="handoff-detail-card">
      <header>
        <div>
          <StatusBadge status={status} />
          <h2>{detail.issue?.id ? `#${detail.issue.id} ` : ''}{detail.issue?.title || '交付审计记录'}</h2>
          <p className="handoff-detail-raw-summary">{handoff.summary}</p>
          <button className="handoff-id-copy" onClick={() => copy(handoff.id, 'Handoff ID')} title={handoff.id} type="button">
            {displayRef(handoff.id, 28, 12)} <Copy size={12} />
          </button>
        </div>
        <div className="handoff-detail-actions">
          <a href={handoffHref(handoff.id, handoff.work_id)}>打开所属 Issue 交付</a>
          <button onClick={() => copy(handoffCopyText(detail), '交付摘要')} type="button"><Copy size={14} /> Copy summary</button>
          {externalUrl ? <a href={externalUrl} rel="noreferrer noopener" target="_blank"><ExternalLink size={14} /> Open delivery</a> : null}
          <button onClick={onRefresh} type="button"><RefreshCw size={14} /> Refresh</button>
        </div>
      </header>

      <section className="handoff-notice-summary">
        <div><CheckCircle2 size={18} /><strong>Delivery notice</strong></div>
        <p>{detail.notification_summary?.summary}</p>
        <span>Next step</span>
        <strong>{detail.notification_summary?.next_step}</strong>
      </section>

      <section className="handoff-section">
        <SectionTitle title="Delivery refs" subtitle={delivery.mode} />
        <div className="handoff-ref-grid">
          {delivery.branch_ref ? <RefCard Icon={GitBranch} label="Branch" onCopy={() => copy(delivery.branch_ref, 'Branch')} value={delivery.branch_ref} /> : null}
          {delivery.commit_ref ? <RefCard Icon={GitCommitHorizontal} label="Commit" onCopy={() => copy(delivery.commit_ref, 'Commit')} value={delivery.commit_ref} /> : null}
          {delivery.pull_request_ref ? <RefCard Icon={ExternalLink} label="Pull request" onCopy={() => copy(delivery.pull_request_ref, 'PR ref')} value={delivery.pull_request_ref} /> : null}
          {delivery.deployment_ref ? <RefCard Icon={Rocket} label="Deployment" onCopy={() => copy(delivery.deployment_ref, 'Deployment ref')} value={delivery.deployment_ref} /> : null}
          {delivery.environment ? <RefCard Icon={Rocket} label="Environment" onCopy={() => copy(delivery.environment, 'Environment')} value={delivery.environment} /> : null}
          {delivery.release_ref ? <RefCard Icon={Tag} label="Release" onCopy={() => copy(delivery.release_ref, 'Release ref')} value={delivery.release_ref} /> : null}
          {delivery.version ? <RefCard Icon={Tag} label="Version" onCopy={() => copy(delivery.version, 'Version')} value={delivery.version} /> : null}
          {!delivery.branch_ref && !delivery.commit_ref && !delivery.pull_request_ref ? (
            <RefCard Icon={PackageCheck} label="Artifact" onCopy={() => copy(handoff.final_revision, 'Final revision')} value={handoff.final_revision} />
          ) : null}
        </div>
      </section>

      <DiffSummaryPanel summary={detail.diff_summary} />

      <section className="handoff-section">
        <SectionTitle title="Delivery status" subtitle={`refreshed ${formatTime(detail.delivery_status?.refreshed_at)}`} />
        <div className="handoff-action-list">
          {(detail.delivery_status?.actions || []).length > 0 ? detail.delivery_status.actions.map(action => (
            <div key={`${action.action}:${action.source_ref}`}>
              <span>{action.action.replaceAll('_', ' ')}</span>
              <StatusBadge status={action.current_status} />
              <code title={action.source_ref}>{displayRef(action.source_ref, 24, 8)}</code>
            </div>
          )) : <span className="handoff-muted">No external delivery action required.</span>}
        </div>
      </section>

      <div className="handoff-detail-columns">
        <section className="handoff-section">
          <SectionTitle title="Evidence" subtitle={`${handoff.evidence_ids.length} linked`} />
          <div className="handoff-chip-list">
            {handoff.evidence_ids.map(id => <button key={id} onClick={() => copy(id, 'Evidence ref')} title={id} type="button">{displayRef(id, 20, 8)} <Copy size={11} /></button>)}
          </div>
        </section>
        <section className="handoff-section">
          <SectionTitle title="Changed files" subtitle={`${handoff.changed_files.length} scoped`} />
          <div className="handoff-file-list">
            {handoff.changed_files.slice(0, 100).map(path => <code key={path}>{path}</code>)}
            {handoff.changed_files.length > 100 ? <span>+ {handoff.changed_files.length - 100} more</span> : null}
          </div>
        </section>
      </div>

      <section className="handoff-section">
        <SectionTitle title="Risk" subtitle={`highest ${riskPresentation.highest}`} />
        {riskPresentation.items.length > 0 ? (
          <div className="handoff-risk-list">
            {riskPresentation.items.map(risk => (
              <div key={risk.id} data-severity={risk.severity}>
                <ShieldAlert size={16} />
                <div><strong>{risk.summary}</strong><span>{risk.mitigation}</span></div>
                <em>{risk.severity}</em>
              </div>
            ))}
          </div>
        ) : <div className="handoff-clear-risk"><CheckCircle2 size={16} /> No known delivery risk recorded.</div>}
      </section>

      <section className="handoff-section">
        <SectionTitle title="Rollback" subtitle={handoff.rollback?.availability || 'unknown'} />
        <div className="handoff-rollback" data-availability={handoff.rollback?.availability}>
          <Undo2 size={17} />
          <div>
            <strong>{handoff.rollback?.plan || handoff.rollback?.reason || 'No rollback is required for this delivery.'}</strong>
            <span>{handoff.rollback?.destructive ? 'Destructive · explicit approval required' : 'Non-destructive or no-op rollback'}</span>
          </div>
          {(handoff.rollback?.refs || []).length > 0 ? <button onClick={() => copy(handoff.rollback.refs.join('\n'), 'Rollback refs')} type="button"><Copy size={12} /> Copy refs</button> : null}
        </div>
      </section>

    </article>
  );
}

function DiffSummaryPanel({ summary }) {
  if (!summary) return (
    <section className="handoff-section">
      <SectionTitle title="Diff summary" subtitle="no Git Evidence" />
      <span className="handoff-muted">No canonical Git diff summary is linked to this Handoff.</span>
    </section>
  );
  if (summary.availability !== 'available') return (
    <section className="handoff-section">
      <SectionTitle title="Diff summary" subtitle="artifact unavailable" />
      <div className="handoff-diff-unavailable"><FileDiff size={16} /> Canonical summary cannot be rebuilt from the current Evidence artifact.</div>
    </section>
  );
  const stats = summary.diff_stats || {};
  const notableCount = (summary.notable_files?.binary?.length || 0) + (summary.notable_files?.large?.length || 0) + (summary.notable_files?.generated?.length || 0);
  return (
    <section className="handoff-section">
      <SectionTitle title="Diff summary" subtitle={summary.detail_level} />
      <div className="handoff-diff-stats">
        <DiffStat label="Paths" value={stats.changed_path_count} />
        <DiffStat label="Insertions" tone="positive" value={`+${stats.insertions || 0}`} />
        <DiffStat label="Deletions" tone="negative" value={`−${stats.deletions || 0}`} />
        <DiffStat label="Notable" tone={notableCount > 0 ? 'warning' : ''} value={notableCount} />
      </div>
      <p className="handoff-diff-summary">{summary.summary}</p>
      <div className="handoff-path-groups">
        {(summary.path_groups || []).slice(0, 12).map(group => <span key={group.group}><strong>{group.group}</strong>{group.files.length} files</span>)}
      </div>
    </section>
  );
}

function DiffStat({ label, tone = '', value }) {
  return <div className={tone}><span>{label}</span><strong>{value ?? 0}</strong></div>;
}

function HandoffStat({ label, tone = '', value }) {
  return <div className={`handoff-stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Filter({ children, label, onChange, value }) {
  return <label><span>{label}</span><select onChange={event => onChange(event.target.value)} value={value}>{children}</select></label>;
}

function StatusBadge({ status }) {
  return <span className="handoff-status" data-tone={deliveryTone(status)}>{status || 'unknown'}</span>;
}

function SectionTitle({ subtitle, title }) {
  return <div className="handoff-section-title"><h3>{title}</h3><span>{subtitle}</span></div>;
}

function RefCard({ Icon, label, onCopy, value }) {
  return (
    <div className="handoff-ref-card">
      <span><Icon size={14} /> {label}</span>
      <code title={value}>{displayRef(value, 22, 12)}</code>
      <button onClick={onCopy} type="button"><Copy size={12} /> Copy</button>
    </div>
  );
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
