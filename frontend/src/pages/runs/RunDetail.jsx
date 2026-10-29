import { Component, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Clock3,
  FileText,
  History,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import EvidencePanel from '../../components/EvidencePanel.jsx';
import Sessions from '../Sessions.jsx';
import { runPhaseLabel } from './runPhaseLabels.js';
import { runsApi } from '../../api/runs.js';
import { providerLabel, runIssueId, runStatusLabel } from './runPageModel.js';
import {
  RUN_EVENT_PAGE_SIZE,
  RUN_EVENT_SCAN_LIMIT,
  eventPageCursor,
  eventsWithinAttempt,
  mergeRunEventPages,
  mergeRunTranscriptPage,
  runAttemptProviderSessionRef,
  runCostView,
  runEventInitialBeforeId,
  runLogSummary,
  runTerminalNotices,
  selectedRunAttempt,
} from './runDetailModel.js';

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

function RunSummary({ attempt, issueId, run }) {
  const progress = run.progress || {};
  const attemptTimeline = (progress.timeline || []).filter(item => !attempt?.id || item.attempt_id === attempt.id);
  const phaseSummary = (progress.phase_summary || []).filter(item => !attempt?.id || item.attempt_id === attempt.id);
  const runCost = runCostView(run.cost);

  return (
    <div className="run-summary-layout">
      <section className="run-summary-main">
        <header className="run-section-heading">
          <div><h2>执行概览</h2><span>整次执行的状态与进展</span></div>
        </header>
        <div className="run-summary-metrics">
          <Metric label="状态" value={runStatusLabel(run.status)} />
          <Metric label="当前阶段" value={runPhaseLabel(progress.provider_phase || progress.phase)} />
          <Metric label="最新进展" value={progress.latest?.summary || run.terminal?.reason || '暂无进展记录'} />
          <Metric label="耗时" value={durationText(run.started_at, run.ended_at)} />
          <Metric label="总 token" value={runCost.total} detail={runCost.completenessLabel} />
          <Metric label="金额" value={runCost.money} />
        </div>
        <section className="run-progress-timeline">
          <div className="run-subsection-title">
            <div><History size={15} /><strong>所选尝试的时间线</strong></div>
            {progress.replay?.timeline_truncated || progress.replay?.source_event_truncated ? <span>仅显示近期记录</span> : null}
          </div>
          {attemptTimeline.length ? attemptTimeline.map(item => (
            <article data-phase={item.phase} key={`${item.attempt_id}:${item.source_event_id}`}>
              <span className="run-timeline-marker" />
              <div>
                <div><strong>{runPhaseLabel(item.phase)}</strong><time>{formatTime(item.occurred_at)}</time></div>
                {item.summary ? <p>{item.summary}</p> : null}
              </div>
            </article>
          )) : phaseSummary.length ? phaseSummary.map(item => (
            <article data-phase={item.phase} key={`${item.attempt_id}:${item.phase}`}>
              <span className="run-timeline-marker" />
              <div><div><strong>{runPhaseLabel(item.phase)}</strong><time>{formatTime(item.last_occurred_at)}</time></div></div>
            </article>
          )) : <EmptyState icon={History} text="这次尝试暂无进展记录。" />}
        </section>
      </section>
      <RunDisclosure title="本次执行验证">
        <EvidencePanel runId={run.id} title="本次执行验证" />
      </RunDisclosure>
      <RunDisclosure title="开发者信息">
        <RunAdvanced attempt={attempt} issueId={issueId} run={run} />
      </RunDisclosure>
    </div>
  );
}

// 仅展开时挂载子组件；原生 details 隐藏内容本身不会停止请求。
function RunDisclosure({ children, title }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="run-summary-disclosure" onToggle={event => setOpen(event.currentTarget.open)} open={open}>
      <summary>{title}</summary>
      {open ? children : null}
    </details>
  );
}

function CostDetails({ attempt, run }) {
  return (
    <div className="run-cost-breakdown">
      {[{ title: '整次执行', cost: run.cost }, { title: `所选尝试（第 ${attempt?.sequence || '?'} 次）`, cost: attempt?.cost }].map(({ title, cost }) => {
        const view = runCostView(cost);
        return (
          <section key={title}>
            <h3>{title}</h3>
            <dl>
              <div><dt>总 token</dt><dd>{view.total}</dd></div>
              <div><dt>金额</dt><dd>{view.money}</dd></div>
              <div><dt>统计完整度</dt><dd>{view.completenessLabel}</dd></div>
              <div><dt>Input</dt><dd>{view.input}</dd></div>
              <div><dt>Cached</dt><dd>{view.cachedInput}</dd></div>
              <div><dt>Output</dt><dd>{view.output}</dd></div>
              <div><dt>Reasoning</dt><dd>{view.reasoning}</dd></div>
            </dl>
            {cost?.source_refs?.length ? <details><summary>费用来源</summary><pre>{cost.source_refs.join('\n')}</pre></details> : null}
          </section>
        );
      })}
    </div>
  );
}

function RunLogs({ attempt, issueId, run }) {
  const events = useRunEvents({ active: true, attempt, issueId, run, types: ['issue.log'] });
  return (
    <section className="run-resource-panel">
      <ResourceHeader
        eyebrow={`所选尝试 · 第 ${attempt?.sequence || '?'} 次`}
        icon={FileText}
        loading={events.loading}
        onRefresh={events.refresh}
        title="执行日志"
      />
      {events.error ? <ErrorState error={events.error} onRetry={events.refresh} /> : null}
      {!events.loading && !events.error && events.items.length === 0 ? (
        <EmptyState icon={FileText} text="这次尝试暂无日志。" />
      ) : (
        <div className="run-log-list" aria-busy={events.loading}>
          {events.items.map(event => (
            <article key={event.id}>
              <span>#{event.id}</span>
              <time>{formatTime(event.created_at)}</time>
              <p>{runLogSummary(event)}</p>
            </article>
          ))}
        </div>
      )}
      <EventPageFooter events={events} />
    </section>
  );
}

function RunAdvanced({ attempt, issueId, run }) {
  const events = useRunEvents({ active: true, attempt: null, issueId, run, types: [] });
  return (
    <section className="run-resource-panel run-advanced-panel">
      <ResourceHeader
        eyebrow="只读 · 整次执行"
        icon={ListTree}
        loading={events.loading}
        onRefresh={events.refresh}
        title="原始事件"
      />
      <CostDetails attempt={attempt} run={run} />
      <div className="run-advanced-contract">
        <span>Authority <strong>{run.progress?.source_of_truth || 'issue_runs+run_attempts+issue_events'}</strong></span>
        <span>Projector <strong>{run.progress?.projected_by || 'unavailable'}</strong></span>
        <span>Duplicates <strong>{run.progress?.replay?.duplicate_event_count ?? 0}</strong></span>
        <span>Invalid <strong>{run.progress?.invalid_event_count ?? 0}</strong></span>
      </div>
      {events.error ? <ErrorState error={events.error} onRetry={events.refresh} /> : null}
      <div className="run-raw-event-list">
        {events.items.map(event => (
          <details key={event.id}>
            <summary><code>#{event.id}</code><span>{event.type}</span><time>{formatTime(event.created_at)}</time></summary>
            <pre>{prettyPayload(event.payload)}</pre>
          </details>
        ))}
      </div>
      {!events.loading && !events.error && events.items.length === 0 ? (
        <EmptyState icon={ListTree} text="本次执行暂无原始事件。" />
      ) : null}
      <EventPageFooter events={events} />
      <details className="run-raw-object">
        <summary>原始 Run / Attempt JSON</summary>
        <pre>{JSON.stringify(run, null, 2)}</pre>
      </details>
    </section>
  );
}

function Metric({ label, value, detail }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong>{detail ? <small className="run-cost-completeness">{detail}</small> : null}</div>;
}

function ResourceHeader({ eyebrow, icon: Icon, loading, onRefresh, title }) {
  return (
    <header className="run-resource-header">
      <div><span>{eyebrow}</span><h2><Icon size={14} /> {title}</h2></div>
      <button aria-label={`刷新${title}`} disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'is-spinning' : ''} size={14} /> 刷新
      </button>
    </header>
  );
}

function EventPageFooter({ events }) {
  return (
    <footer className="run-event-page-footer">
      {events.scanned >= RUN_EVENT_SCAN_LIMIT ? <span>仅显示近期记录</span> : null}
      {events.hasOlder ? (
        <button disabled={events.loadingMore} onClick={events.loadMore} type="button">
          {events.loadingMore ? <LoaderCircle className="is-spinning" size={13} /> : <Clock3 size={13} />}
          {events.loadingMore ? '加载中…' : '加载更早'}
        </button>
      ) : null}
    </footer>
  );
}

function EmptyState({ icon: Icon, text }) {
  return <div className="run-detail-empty"><Icon size={16} /><span>{text}</span></div>;
}

function ErrorState({ error, onRetry }) {
  return <div className="run-detail-error" role="alert"><span>{error}</span><button onClick={onRetry} type="button">重试</button></div>;
}

function useRunEvents({ active, attempt, issueId, run, types }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState('');
  const [scanned, setScanned] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const typeKey = types.join(',');
  const initialBeforeId = runEventInitialBeforeId(run, attempt);

  useEffect(() => {
    setItems([]);
    setCursor('');
    setScanned(0);
    setHasOlder(false);
    setError('');
    if (!active || !issueId) return undefined;
    let alive = true;
    setLoading(true);
    runsApi.getRunEvents(issueId, {
      beforeId: initialBeforeId,
      limit: RUN_EVENT_PAGE_SIZE,
      types: typeKey ? typeKey.split(',') : [],
    }).then(page => {
      if (!alive) return;
      const raw = Array.isArray(page) ? page : [];
      setItems(eventsWithinAttempt(raw, attempt, run));
      setCursor(eventPageCursor(raw));
      setScanned(raw.length);
      setHasOlder(raw.length === RUN_EVENT_PAGE_SIZE && raw.length < RUN_EVENT_SCAN_LIMIT);
    }).catch(loadError => {
      if (alive) setError(loadError.message || '加载执行事件失败');
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [active, attempt, initialBeforeId, issueId, reloadToken, run, typeKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || scanned >= RUN_EVENT_SCAN_LIMIT) return;
    const remaining = RUN_EVENT_SCAN_LIMIT - scanned;
    const limit = Math.min(RUN_EVENT_PAGE_SIZE, remaining);
    setLoadingMore(true);
    try {
      const page = await runsApi.getRunEvents(issueId, {
        beforeId: cursor,
        limit,
        types: typeKey ? typeKey.split(',') : [],
      });
      const raw = Array.isArray(page) ? page : [];
      setItems(current => mergeRunEventPages(current, eventsWithinAttempt(raw, attempt, run)));
      setCursor(eventPageCursor(raw));
      const nextScanned = scanned + raw.length;
      setScanned(nextScanned);
      setHasOlder(raw.length === limit && nextScanned < RUN_EVENT_SCAN_LIMIT);
      setError('');
    } catch (loadError) {
      setError(loadError.message || '加载更早的执行事件失败');
    } finally {
      setLoadingMore(false);
    }
  }, [attempt, cursor, issueId, loadingMore, run, scanned, typeKey]);

  return {
    error,
    hasOlder,
    items,
    loadMore,
    loading,
    loadingMore,
    refresh: () => setReloadToken(value => value + 1),
    scanned,
  };
}

function prettyPayload(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function durationText(startValue, endValue) {
  const start = Date.parse(startValue || '');
  const end = Date.parse(endValue || '') || Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
