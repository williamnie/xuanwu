import RunSummary from './RunSummary.jsx';
import { RunLogs } from './RunEventPanels.jsx';
import { EmptyState, ErrorState } from './RunDetailPrimitives.jsx';
import { formatTime } from './runDetailFormat.js';
import { Component, useCallback, useMemo, useState } from 'react';
import { Activity, FileText, Terminal } from 'lucide-react';

import Sessions from '../Sessions.jsx';

import { runsApi } from '../../api/runs.js';
import { providerLabel, runIssueId, runStatusLabel } from './runPageModel.js';
import { mergeRunTranscriptPage, runAttemptProviderSessionRef, runTerminalNotices, selectedRunAttempt } from './runDetailModel.js';

const DETAIL_SECTIONS = [
  { id: 'provider', icon: Terminal, label: '对话' },
  { id: 'summary', icon: Activity, label: '概览' },
  { id: 'logs', icon: FileText, label: '日志' },
];

export default function RunDetail({ navigateTo, run }) {
  return <RunDetailContent key={run.id} navigateTo={navigateTo} run={run} />;
}

function RunDetailContent({ navigateTo, run }) {
  const [activeSection, setActiveSection] = useState('provider');
  // 空值表示持续跟随最新尝试；只有手动切换才固定，切 Run 由 key 重置。
  const [pinnedAttemptId, setPinnedAttemptId] = useState('');
  const attempts = useMemo(() => Array.isArray(run?.attempts) ? run.attempts : [], [run]);
  const selectedAttempt = useMemo(
    () => selectedRunAttempt(run, pinnedAttemptId),
    [run, pinnedAttemptId],
  );
  const issueId = runIssueId(run);
  const providerSessionRef = runAttemptProviderSessionRef(selectedAttempt, run);

  return (
    <div className="run-detail-workspace">
      <nav aria-label="执行详情分区" className="run-detail-section-tabs">
        {DETAIL_SECTIONS.map(section => {
          const Icon = section.icon;
          return (
            <button
              aria-current={activeSection === section.id ? 'page' : undefined}
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              type="button"
            >
              <Icon size={14} /> {section.label}
            </button>
          );
        })}
      </nav>

      {attempts.length > 1 ? (
        <div aria-label="执行尝试" className="run-attempt-tabs" role="tablist">
          <span className="run-attempt-tabs-label">尝试</span>
          {attempts.map(attempt => (
            <button
              aria-selected={attempt.id === selectedAttempt?.id}
              data-status={attempt.status || 'unknown'}
              key={attempt.id}
              onClick={() => setPinnedAttemptId(attempt.id)}
              role="tab"
              type="button"
            >
              <i />
              <span>第 {attempt.sequence} 次尝试</span>
              <small>{runStatusLabel(attempt.status)}</small>
            </button>
          ))}
        </div>
      ) : null}

      <RunAttention attempt={selectedAttempt} run={run} />

      <main className={`run-detail-content ${activeSection === 'provider' ? 'provider-active' : ''}`}>
        {activeSection === 'provider' ? (
          <ProviderSessionDrillDown
            attempt={selectedAttempt}
            navigateTo={navigateTo}
            run={run}
            sessionRef={providerSessionRef}
          />
        ) : null}
        {activeSection === 'summary' ? <RunSummary attempt={selectedAttempt} issueId={issueId} run={run} /> : null}
        {activeSection === 'logs' ? <RunLogs key={selectedAttempt?.id || run.id} attempt={selectedAttempt} issueId={issueId} run={run} /> : null}
      </main>
    </div>
  );
}

function ProviderSessionDrillDown({ attempt, navigateTo, run, sessionRef }) {
  const loadTranscriptPage = useCallback(async (sessionId, input) => {
    const [page, transcript] = await Promise.all([
      runsApi.getSessionTurns(sessionId, input),
      runsApi.getRunTranscript(run.id, { attemptId: attempt?.id || '', limit: 200 }),
    ]);
    return mergeRunTranscriptPage(page, transcript);
  }, [attempt?.id, run.id]);
  if (!sessionRef) {
    return <EmptyState icon={Terminal} text="这次尝试暂无可查看的对话，可在概览或日志中查看执行情况。" />;
  }
  return (
    <section className="run-provider-drilldown">
      <header>
        <div><Terminal size={15} /><strong>{providerLabel(attempt?.provider_ref?.provider || run.provider)} 对话</strong></div>
        <span>所选尝试的对话记录</span>
      </header>
      <ProviderTranscriptBoundary key={sessionRef} sessionRef={sessionRef}>
        <Sessions
          autoSelectFirstSession={false}
          navigateTo={navigateTo}
          loadTranscriptPage={(attempt?.provider_ref?.provider || run.provider) === 'codex' ? loadTranscriptPage : undefined}
          selectedSessionId={sessionRef}
          showEvidence={false}
          showSidebar={false}
        />
      </ProviderTranscriptBoundary>
    </section>
  );
}

class ProviderTranscriptBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: '' };
  }

  static getDerivedStateFromError(error) {
    return { error: error?.message || '对话记录加载失败' };
  }

  componentDidUpdate(previousProps) {
    if (previousProps.sessionRef !== this.props.sessionRef && this.state.error) this.setState({ error: '' });
  }

  render() {
    if (this.state.error) return <ErrorState error={this.state.error} />;
    return this.props.children;
  }
}

function RunAttention({ attempt, run }) {
  const progress = run.progress || {};
  const notices = runTerminalNotices(run, attempt);
  const waiting = progress.provider_phase === 'waiting_approval';
  if (!notices.length && !waiting && !progress.stalled?.detected) return null;
  return (
    <div className="run-attention-card run-detail-attention" role="status">
      {notices.map(notice => <span key={notice.scope}>{notice.scope === 'attempt' ? '所选尝试' : '整次执行'}：{runStatusLabel(notice.status)}{notice.reason ? ` · ${notice.reason}` : ''}</span>)}
      {waiting ? <strong>等待审批</strong> : null}
      {progress.stalled?.detected ? <strong>执行可能卡住{progress.stalled.since ? ` · 自 ${formatTime(progress.stalled.since)}` : ''}</strong> : null}
    </div>
  );
}
