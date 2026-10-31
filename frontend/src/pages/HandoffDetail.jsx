

import { CheckCircle2, Copy, ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, PackageCheck, RefreshCw, Rocket, ShieldAlert, Tag, Undo2 } from 'lucide-react';

import { message } from '../store/toastStore';
import { displayRef, handoffCopyText, handoffHref, handoffRiskPresentation, safeExternalUrl } from './handoffPageModel.js';

import { StatusBadge } from './HandoffStatusBadge.jsx';
import { formatHandoffTime as formatTime } from './handoffTime.js';
export default function HandoffDetail({ detail, onRefresh }) {
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
            {displayRef(handoff.id, 28, 12)} <Copy size={13} />
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
        <div><CheckCircle2 size={16} /><strong>Delivery notice</strong></div>
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
            {handoff.evidence_ids.map(id => <button key={id} onClick={() => copy(id, 'Evidence ref')} title={id} type="button">{displayRef(id, 20, 8)} <Copy size={13} /></button>)}
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
          <Undo2 size={14} />
          <div>
            <strong>{handoff.rollback?.plan || handoff.rollback?.reason || 'No rollback is required for this delivery.'}</strong>
            <span>{handoff.rollback?.destructive ? 'Destructive · explicit approval required' : 'Non-destructive or no-op rollback'}</span>
          </div>
          {(handoff.rollback?.refs || []).length > 0 ? <button onClick={() => copy(handoff.rollback.refs.join('\n'), 'Rollback refs')} type="button"><Copy size={13} /> Copy refs</button> : null}
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

function SectionTitle({ subtitle, title }) {
  return <div className="handoff-section-title"><h3>{title}</h3><span>{subtitle}</span></div>;
}

function RefCard({ Icon, label, onCopy, value }) {
  return (
    <div className="handoff-ref-card">
      <span><Icon size={14} /> {label}</span>
      <code title={value}>{displayRef(value, 22, 12)}</code>
      <button onClick={onCopy} type="button"><Copy size={13} /> Copy</button>
    </div>
  );
}

