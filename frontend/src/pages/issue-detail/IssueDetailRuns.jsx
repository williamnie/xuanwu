import { ExternalLink, History } from 'lucide-react';
import { issueRunSessionRef } from '../../utils/issueRuns';
import { serviceTierRunLabel } from '../../utils/serviceTier';
import {
  issueRunProfileLabel,
  runCapabilitySummary,
  runSelectionReasonLabel,
} from '../../utils/agentProfiles';
import { formatDateTime, providerLabel, summarize } from './issueDetailFormatters';

export default function IssueDetailRuns({ issue, project, profiles, runs, currentStatus, navigateTo, onCopy }) {
  const latestRunId = latestRunFromRuns(runs)?.id || '';
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
      <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <History size={18} color="var(--primary)" /> Runs 历史
      </h3>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
        当前状态是 <strong>{currentStatus}</strong>；下方按 attempt 展示每一轮独立执行记录。
      </p>

      {runs.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
          暂无 run 记录，issue 进入 runner claim 后会生成第一条。
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
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
    <article style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>
          Attempt #{run.attempt}{isLatest ? ' · latest' : ''}
        </span>
        <span className={`status-badge ${run.status}`} style={{ fontSize: '0.72rem', padding: '3px 8px' }}>
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
        <div style={{ color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 'var(--radius-md)', padding: '8px', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined, fontSize: mono ? '0.72rem' : '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  );
}
