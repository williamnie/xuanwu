import { useState } from 'react';
import {
  AlertTriangle,
  Clock,
  ExternalLink,
  Link2,
  MoreHorizontal,
  RotateCw,
  Trash2,
} from 'lucide-react';
import {
  issueFailureReason,
  issueRunExitText,
  issueRunSessionId,
  issueRunSessionRef,
  issueRunTurnId,
  latestIssueRun,
  providerLabel,
  shortId,
} from '../utils/issueRuns';
import {
  serviceTierOptions,
  serviceTierRunLabel,
} from '../utils/serviceTier';

export default function IssueCard({
  issue,
  project,
  dragging,
  retrying,
  onDragStart,
  onDragEnd,
  onOpenIssue,
  onOpenSession,
  onRequestDelete,
  onRetry,
  onServiceTierChange,
  getRelativeTime,
}) {
  const run = latestIssueRun(issue);
  const sessionRef = issueRunSessionRef(issue, run);
  const failureReason = issueFailureReason(issue, run);
  return (
    <div
      className={`kanban-card ${dragging ? 'dragging' : ''}`}
      draggable="true"
      onDragStart={(event) => onDragStart(event, issue.id, issue.status)}
      onDragEnd={onDragEnd}
      onClick={() => onOpenIssue(issue.id)}
    >
      <div className="kanban-card-heading">
        <div className="kanban-card-title">#{issue.id} {issue.title}</div>
        <span className={`status-badge kanban-card-status ${issue.status || 'unknown'}`}>
          {issue.status || 'unknown'}
        </span>
      </div>

      {issue.status === 'failed' && failureReason && <IssueFailureSummary reason={failureReason} />}
      <IssueRunMetadata issue={issue} run={run} />
      <IssueQuickActions
        issue={issue}
        sessionRef={sessionRef}
        retrying={retrying}
        onOpenSession={onOpenSession}
        onRequestDelete={onRequestDelete}
        onRetry={onRetry}
        onServiceTierChange={onServiceTierChange}
      />
      <IssueCardFooter issue={issue} project={project} getRelativeTime={getRelativeTime} />
    </div>
  );
}

function IssueFailureSummary({ reason }) {
  return (
    <div className="kanban-card-failure" title={reason}>
      <AlertTriangle size={13} />
      <span>{reason}</span>
    </div>
  );
}

function IssueRunMetadata({ issue, run }) {
  if (!run) return null;
  const sessionId = issueRunSessionId(issue, run);
  const turnId = issueRunTurnId(issue, run);
  const exitText = issueRunExitText(run);
  const attempt = run.attempt || issue.attempt_count || 1;
  const runStatus = run.status || 'unknown';
  const provider = providerLabel(run.provider);
  const speed = serviceTierRunLabel(run);
  const runtimeTitle = runTooltipText({ attempt, runStatus, provider, speed, sessionId, turnId, exitText });
  const items = [
    { label: 'Run', value: `#${attempt} · ${runStatus}`, className: `run-status ${runStatus}` },
    { label: 'Provider', value: provider },
    { label: 'Speed', value: speed },
    { label: 'Session', value: shortId(sessionId), mono: true, hidden: !sessionId },
    { label: 'Turn', value: shortId(turnId), mono: true, hidden: !turnId },
  ].filter(item => !item.hidden);

  return (
    <div className="kanban-card-runtime-meta" aria-label={runtimeTitle} title={runtimeTitle}>
      {items.map(item => (
        <RunMetaPill
          key={item.label}
          className={item.className}
          label={item.label}
          mono={item.mono}
          value={item.value}
        />
      ))}
    </div>
  );
}

function RunMetaPill({ className = '', label, value, mono = false }) {
  return (
    <span className={`kanban-card-runtime-pill ${className}`.trim()}>
      <span>{label}</span>
      <code className={mono ? 'mono' : ''}>{value}</code>
    </span>
  );
}

function runTooltipText({ attempt, runStatus, provider, speed, sessionId, turnId, exitText }) {
  return [
    `Run #${attempt}`,
    `Status: ${runStatus}`,
    `Provider: ${provider}`,
    `Speed: ${speed}`,
    `Session: ${sessionId || '暂无'}`,
    `Turn: ${turnId || '暂无'}`,
    exitText ? `Exit: ${exitText}` : '',
  ].filter(Boolean).join(' · ');
}

function IssueQuickActions({ issue, sessionRef, retrying, onOpenSession, onRequestDelete, onRetry, onServiceTierChange }) {
  const showRetry = issue.status === 'failed';
  const canDelete = issue.status !== 'in_progress';
  if (!showRetry && !sessionRef && !canDelete && !onServiceTierChange) return null;
  return (
    <div className="kanban-card-actions" onClick={(event) => event.stopPropagation()}>
      {onServiceTierChange && (
        <label className="kanban-card-action-select" title="保存为该 Issue 的下次运行速度">
          <span>速度</span>
          <select
            value={issue.service_tier || ''}
            onChange={(event) => onServiceTierChange(event, issue.id, event.target.value)}
          >
            {serviceTierOptions(issue.service_tier).map(option => (
              <option key={option.value || 'standard'} value={option.value}>{option.shortLabel || option.label}</option>
            ))}
          </select>
        </label>
      )}
      {sessionRef && (
        <button type="button" className="kanban-card-action-btn" onClick={(event) => onOpenSession(event, sessionRef)}>
          <ExternalLink size={12} /> Session
        </button>
      )}
      {showRetry && (
        <button type="button" className="kanban-card-action-btn retry" disabled={retrying} onClick={(event) => onRetry(event, issue)}>
          <RotateCw size={12} /> {retrying ? 'Retrying' : 'Retry'}
        </button>
      )}
      <IssueMoreActions issue={issue} canDelete={canDelete} onRequestDelete={onRequestDelete} />
    </div>
  );
}

function IssueMoreActions({ issue, canDelete, onRequestDelete }) {
  const [moreOpen, setMoreOpen] = useState(false);
  if (!canDelete || !onRequestDelete) return null;
  const menuId = `issue-${issue.id}-more-menu`;
  const toggleMenu = (event) => {
    event.stopPropagation();
    setMoreOpen(open => !open);
  };
  const closeOnEscape = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setMoreOpen(false);
  };
  const requestDelete = (event) => {
    event.stopPropagation();
    setMoreOpen(false);
    onRequestDelete(event, issue);
  };
  return (
    <div className="kanban-card-more" onClick={(event) => event.stopPropagation()} onKeyDown={closeOnEscape}>
      <button
        type="button"
        className="kanban-card-more-trigger"
        aria-label={`更多操作：Issue #${issue.id}`}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-controls={menuId}
        onClick={toggleMenu}
      >
        <MoreHorizontal size={14} />
      </button>
      {moreOpen && (
        <div id={menuId} className="kanban-card-more-menu" role="menu" aria-label={`Issue #${issue.id} 更多操作`}>
          <button type="button" className="kanban-card-more-item danger" role="menuitem" onClick={requestDelete}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function IssueCardFooter({ issue, project, getRelativeTime }) {
  return (
    <div className="kanban-card-footer">
      <span className="kanban-card-project">
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f97316', display: 'inline-block' }}></span>
        {project ? project.name : issue.project_id}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <Clock size={11} style={{ opacity: 0.6 }} />
          {getRelativeTime(issue.updated_at)}
        </span>
        <span className="kanban-card-loops" title="Codex 执行回合数">
          <Link2 size={11} style={{ transform: 'rotate(-45deg)', opacity: 0.6 }} />
          {issue.attempt_count || 1}
        </span>
      </div>
    </div>
  );
}
