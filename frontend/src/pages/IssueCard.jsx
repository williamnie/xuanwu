import {
  AlertTriangle,
  Clock,
  ExternalLink,
  Link2,
  RotateCw,
  Terminal,
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
  onOpenLog,
  onOpenSession,
  onRequestDelete,
  onRetry,
  onServiceTierChange,
  getRelativeTime,
}) {
  const run = latestIssueRun(issue);
  const sessionRef = issueRunSessionRef(issue, run);
  const hasRuntime = Boolean(sessionRef || issueRunTurnId(issue, run));
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
        hasRuntime={hasRuntime}
        sessionRef={sessionRef}
        retrying={retrying}
        onOpenLog={onOpenLog}
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

function IssueQuickActions({ issue, hasRuntime, sessionRef, retrying, onOpenLog, onOpenSession, onRequestDelete, onRetry, onServiceTierChange }) {
  const showRetry = issue.status === 'failed';
  const showLog = issue.status === 'in_progress' || hasRuntime;
  const canDelete = issue.status !== 'in_progress';
  if (!showRetry && !showLog && !sessionRef && !canDelete && !onServiceTierChange) return null;
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
      {showLog && (
        <button type="button" className="kanban-card-action-btn" onClick={(event) => onOpenLog(event, issue.id)}>
          <Terminal size={12} /> Logs
        </button>
      )}
      {showRetry && (
        <button type="button" className="kanban-card-action-btn retry" disabled={retrying} onClick={(event) => onRetry(event, issue)}>
          <RotateCw size={12} /> {retrying ? 'Retrying' : 'Retry'}
        </button>
      )}
      {canDelete && (
        <button type="button" className="kanban-card-action-btn danger" onClick={(event) => onRequestDelete(event, issue)}>
          <Trash2 size={12} /> Delete
        </button>
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
