import { ExternalLink, History } from 'lucide-react';
import { issueRunSessionRef } from '../../utils/issueRuns';
import { serviceTierRunLabel } from '../../utils/serviceTier';
import {
  issueRunProfileLabel,
  runCapabilitySummary,
  runSelectionReasonLabel,
} from '../../utils/agentProfiles';
import { formatDateTime, providerLabel, summarize } from './issueDetailFormatters';
import './IssueDetailRuns.css';

export default function IssueDetailRuns({ issue, project, profiles, runs, currentStatus, navigateTo, onCopy }) {
  const latestRunId = latestRunFromRuns(runs)?.id || '';
  return (
    <section className="glass-card issue-detail-runs">
      <h3 className="issue-detail-runs__heading">
        <History size={18} color="var(--primary)" /> Runs 历史
      </h3>
      <p className="issue-detail-runs__description">
        当前状态是 <strong>{currentStatus}</strong>；下方按 attempt 展示每一轮独立执行记录。
      </p>

      {runs.length === 0 ? (
        <p className="issue-detail-runs__empty">
          暂无 run 记录，issue 进入 runner claim 后会生成第一条。
        </p>
      ) : (
        <div className="issue-detail-runs__list">
          {runs.map(run => (
            <IssueRunCard
              key={run.id}
              issue={issue}
              project={project}
              profiles={profiles}
              run={run}
              isLatest={run.id === latestRunId}
              navigateTo={navigateTo}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueRunCard({ issue, project, profiles, run, isLatest, navigateTo, onCopy }) {
  const running = !run.ended_at;
  const error = run.error ? summarize(run.error, 160) : '';
  const sessionRef = issueRunSessionRef(issue, run);
  const sessionId = run.provider_session_id || run.codex_thread_id || issue?.codex_thread_id || '';
  const turnId = run.provider_turn_id || run.codex_turn_id || issue?.codex_turn_id || '';
  return (
    <article className="issue-detail-runs__card">
      <div className="issue-detail-runs__card-header">
        <span className="issue-detail-runs__attempt">
          Attempt #{run.attempt}{isLatest ? ' · latest' : ''}
        </span>
        <span className={`status-badge issue-detail-runs__status ${run.status}`}>
          {running && <span className="status-dot running" />}
          {run.status}
        </span>
      </div>

      <RunField label="Run ID" value={run.id} mono />
      <RunField label="Provider" value={providerLabel(run.provider)} />
      <RunField label="Speed" value={serviceTierRunLabel(run)} />
      <RunField label="Agent Profile" value={issueRunProfileLabel(run, project, profiles)} />
      <RunField label="选择原因" value={runSelectionReasonLabel(run.selection_reason)} />
      <RunField label="Capabilities" value={runCapabilitySummary(run)} />
      <RunField label="Session" value={sessionId || '暂无'} mono />
      <RunField label="Turn" value={turnId || '暂无'} mono />
      <RunField label="开始" value={formatDateTime(run.started_at)} />
      <RunField label="结束" value={running ? '运行中' : formatDateTime(run.ended_at)} />
      {run.exit_reason && <RunField label="退出原因" value={run.exit_reason} />}
      {error && (
        <div className="issue-detail-runs__error">
          {error}
        </div>
      )}
      <div className="issue-detail-runs__actions">
        {sessionRef && (
          <button type="button" className="kanban-card-action-btn" onClick={() => navigateTo?.('sessions', null, sessionRef)}>
            <ExternalLink size={12} /> 打开 Session
          </button>
        )}
        <button type="button" className="kanban-card-action-btn" onClick={() => onCopy?.(runCopyText(run, sessionRef, sessionId, turnId))}>
          复制 Run
        </button>
      </div>
    </article>
  );
}

function latestRunFromRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.reduce(
    (latest, run) => Number(run.attempt || 0) >= Number(latest.attempt || 0) ? run : latest,
    runs[0],
  );
}

function runCopyText(run, sessionRef, sessionId, turnId) {
  return [
    `Run ID: ${run.id || ''}`,
    `Attempt: ${run.attempt || '?'}`,
    `Status: ${run.status || 'unknown'}`,
    `Provider: ${providerLabel(run.provider)}`,
    `Speed: ${serviceTierRunLabel(run)}`,
    `Agent Profile: ${run.agent_profile_id || 'none'}`,
    `Selection: ${run.selection_reason || 'none'}`,
    `Capabilities: ${runCapabilitySummary(run)}`,
    `Session: ${sessionRef || sessionId || 'none'}`,
    `Turn: ${turnId || 'none'}`,
    `Exit: ${run.error || run.exit_reason || 'none'}`,
  ].join('\n');
}

function RunField({ label, value, mono = false }) {
  return (
    <div className="issue-detail-runs__field">
      <span className="issue-detail-runs__field-label">{label}</span>
      <span className={`issue-detail-runs__field-value${mono ? ' is-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}
