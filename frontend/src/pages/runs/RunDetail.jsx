import { Component, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BadgeDollarSign,
  Clock3,
  FileCheck2,
  FileText,
  History,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import EvidencePanel from '../../components/EvidencePanel.jsx';
import Sessions from '../Sessions.jsx';
import { runsApi } from '../../api/runs.js';
import { runIssueId } from './runPageModel.js';
import {
  RUN_EVENT_PAGE_SIZE,
  RUN_EVENT_SCAN_LIMIT,
  eventPageCursor,
  eventsWithinAttempt,
  mergeRunEventPages,
  runAttemptProviderSessionRef,
  runCostView,
  runEventInitialBeforeId,
  runLogSummary,
  selectedRunAttempt,
} from './runDetailModel.js';

const DETAIL_SECTIONS = [
  { id: 'provider', icon: Terminal, label: 'Provider' },
  { id: 'summary', icon: Activity, label: 'Summary' },
  { id: 'logs', icon: FileText, label: 'Logs' },
  { id: 'evidence', icon: FileCheck2, label: 'Evidence' },
  { id: 'advanced', icon: ListTree, label: 'Advanced' },
];

export default function RunDetail({ navigateTo, run }) {
  const [activeSection, setActiveSection] = useState('provider');
  const [selectedAttemptId, setSelectedAttemptId] = useState(() => run?.attempts?.at(-1)?.id || '');
  const attempts = useMemo(() => Array.isArray(run?.attempts) ? run.attempts : [], [run]);
  const latestAttemptId = attempts.at(-1)?.id || '';
  const latestProviderSessionRef = runAttemptProviderSessionRef(attempts.at(-1), run);
  const selectedAttempt = useMemo(
    () => selectedRunAttempt(run, selectedAttemptId),
    [run, selectedAttemptId],
  );
  const issueId = runIssueId(run);
  const providerSessionRef = runAttemptProviderSessionRef(selectedAttempt, run);

  useEffect(() => {
    setActiveSection(latestProviderSessionRef ? 'provider' : 'summary');
    setSelectedAttemptId(latestAttemptId);
  }, [latestAttemptId, latestProviderSessionRef, run?.id]);

  useEffect(() => {
    if (selectedAttempt?.id && selectedAttempt.id !== selectedAttemptId) setSelectedAttemptId(selectedAttempt.id);
  }, [selectedAttempt, selectedAttemptId]);

  return (
    <div className="run-detail-workspace">
      <nav aria-label="Run detail sections" className="run-detail-section-tabs">
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
        <div aria-label="Run attempts" className="run-attempt-tabs" role="tablist">
          <span className="run-attempt-tabs-label">Attempts</span>
          {attempts.map(attempt => (
            <button
              aria-selected={attempt.id === selectedAttempt?.id}
              data-status={attempt.status || 'unknown'}
              key={attempt.id}
              onClick={() => setSelectedAttemptId(attempt.id)}
              role="tab"
              type="button"
            >
              <i />
              <span>Attempt {attempt.sequence}</span>
              <small>{attempt.kind || 'legacy'} · {attempt.status || 'unknown'}</small>
            </button>
          ))}
        </div>
      ) : null}

      <main className={`run-detail-content ${activeSection === 'provider' ? 'provider-active' : ''}`}>
        {activeSection === 'provider' ? (
          <ProviderSessionDrillDown
            attempt={selectedAttempt}
            navigateTo={navigateTo}
            run={run}
            sessionRef={providerSessionRef}
          />
        ) : null}
        {activeSection === 'summary' ? <RunSummary attempt={selectedAttempt} run={run} /> : null}
        {activeSection === 'logs' ? <RunLogs attempt={selectedAttempt} issueId={issueId} run={run} /> : null}
        {activeSection === 'evidence' ? <EvidencePanel runId={run.id} title="Run Evidence" /> : null}
        {activeSection === 'advanced' ? <RunAdvanced issueId={issueId} run={run} /> : null}
      </main>
    </div>
  );
}

function ProviderSessionDrillDown({ attempt, navigateTo, run, sessionRef }) {
  if (!sessionRef) {
    return <EmptyState icon={Terminal} text="This Attempt has no provider session observation reference." />;
  }
  const cost = runCostView(attempt?.cost);
  return (
    <section className="run-provider-drilldown">
      <header>
        <div><Terminal size={15} /><strong>{attempt?.provider_ref?.provider || run.provider || 'Provider'} session</strong></div>
        <span>当前 Attempt 的实际执行记录</span>
      </header>
      <div className="run-provider-attempt-facts">
        <div className="run-provider-fact"><small>Provider</small><strong>{attempt?.provider_ref?.provider || 'unknown'}</strong></div>
        <div className="run-provider-fact"><small>Status</small><strong data-status={attempt?.status || 'unknown'}>{attempt?.status || 'unknown'}</strong></div>
        <div className="run-provider-fact"><small>Tokens</small><strong>{cost.total}</strong></div>
        <div className="run-provider-fact"><small>Cost</small><strong>{cost.money}</strong></div>
        {attempt?.terminal?.reason ? <div className="run-provider-fact"><small>Terminal</small><strong>{attempt.terminal.reason}</strong></div> : null}
      </div>
      <ProviderTranscriptBoundary key={sessionRef} sessionRef={sessionRef}>
        <Sessions
          autoSelectFirstSession={false}
          navigateTo={navigateTo}
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
    return { error: error?.message || 'Provider transcript failed to render' };
  }

  componentDidUpdate(previousProps) {
    if (previousProps.sessionRef !== this.props.sessionRef && this.state.error) this.setState({ error: '' });
  }

  render() {
    if (this.state.error) return <ErrorState error={this.state.error} />;
    return this.props.children;
  }
}

function RunSummary({ attempt, run }) {
  const progress = run.progress || {};
  const attemptTimeline = (progress.timeline || []).filter(item => !attempt?.id || item.attempt_id === attempt.id);
  const phaseSummary = (progress.phase_summary || []).filter(item => !attempt?.id || item.attempt_id === attempt.id);
  const runCost = runCostView(run.cost);
  const attemptCost = runCostView(attempt?.cost);

  return (
    <div className="run-summary-layout">
      <section className="run-summary-main">
        <header className="run-section-heading">
          <div><span>Execution progress</span><h2>Run summary</h2></div>
        </header>

        <div className="run-summary-metrics">
          <Metric label="Current phase" value={progress.provider_phase || progress.phase || 'unknown'} />
          <Metric label="Latest progress" value={progress.latest?.summary || run.terminal?.reason || 'No progress event yet'} />
          <Metric label="Elapsed" value={durationText(run.started_at, run.ended_at)} />
          <Metric label="Progress events" value={String(progress.replay?.source_event_count ?? 0)} />
        </div>

        <section className="run-progress-timeline">
          <div className="run-subsection-title">
            <div><History size={15} /><strong>Timeline</strong></div>
            <span>{progress.replay?.timeline_truncated ? `${progress.replay.timeline_truncated} earlier transitions compacted` : 'Complete bounded projection'}</span>
          </div>
          {attemptTimeline.length ? attemptTimeline.map(item => (
            <article data-phase={item.phase} key={`${item.attempt_id}:${item.source_event_id}`}>
              <span className="run-timeline-marker" />
              <div>
                <div><strong>{item.phase}</strong><time>{formatTime(item.occurred_at)}</time></div>
                <p>{item.summary}</p>
                <small>{item.event_count} source events · {item.kind} · #{item.source_event_id}</small>
              </div>
            </article>
          )) : phaseSummary.length ? phaseSummary.map(item => (
            <article data-phase={item.phase} key={`${item.attempt_id}:${item.phase}`}>
              <span className="run-timeline-marker" />
              <div>
                <div><strong>{item.phase}</strong><time>{formatTime(item.last_occurred_at)}</time></div>
                <p>{item.event_count} normalized provider events</p>
                <small>#{item.first_event_id} → #{item.last_event_id}</small>
              </div>
            </article>
          )) : <EmptyState icon={History} text="No normalized progress event is available for this Attempt." />}
        </section>
      </section>

      <aside className="run-summary-aside">
        <AttemptSummary attempt={attempt} />
        <CostSummary attemptCost={attemptCost} runCost={runCost} cost={run.cost} />
        {progress.stalled?.detected || progress.provider_phase === 'waiting_approval' ? (
          <div className="run-attention-card">
            <strong>{progress.provider_phase === 'waiting_approval' ? 'Waiting for approval' : 'Possible stall detected'}</strong>
            <span>Since {formatTime(progress.stalled?.since)}</span>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function AttemptSummary({ attempt }) {
  if (!attempt) return <EmptyState icon={History} text="This legacy Run has no mapped Attempt facts." />;
  return (
    <section className="run-attempt-summary-card">
      <div className="run-subsection-title"><div><Activity size={15} /><strong>Selected Attempt</strong></div></div>
      <dl>
        <div><dt>Sequence</dt><dd>{attempt.sequence}</dd></div>
        <div><dt>Kind</dt><dd>{attempt.kind || 'unknown'}</dd></div>
        <div><dt>Status</dt><dd data-status={attempt.status}>{attempt.status || 'unknown'}</dd></div>
        <div><dt>Provider</dt><dd>{attempt.provider_ref?.provider || 'unknown'}</dd></div>
        <div><dt>Started</dt><dd>{formatTime(attempt.started_at)}</dd></div>
        <div><dt>Duration</dt><dd>{durationText(attempt.started_at, attempt.ended_at)}</dd></div>
      </dl>
      {attempt.terminal ? <p className="run-attempt-terminal">{attempt.terminal.reason}</p> : null}
    </section>
  );
}

function CostSummary({ attemptCost, runCost, cost }) {
  return (
    <section className="run-cost-card">
      <div className="run-subsection-title">
        <div><BadgeDollarSign size={15} /><strong>Cost</strong></div>
        <span>{runCost.completeness}</span>
      </div>
      <div className="run-cost-total"><span>Run tokens</span><strong>{runCost.total}</strong><small>{runCost.money}</small></div>
      <dl>
        <div><dt>Input</dt><dd>{runCost.input}</dd></div>
        <div><dt>Cached</dt><dd>{runCost.cachedInput}</dd></div>
        <div><dt>Output</dt><dd>{runCost.output}</dd></div>
        <div><dt>Reasoning</dt><dd>{runCost.reasoning}</dd></div>
        <div><dt>Attempt total</dt><dd>{attemptCost.total}</dd></div>
      </dl>
      {cost?.source_refs?.length ? (
        <details><summary>Cost provenance</summary><pre>{cost.source_refs.join('\n')}</pre></details>
      ) : null}
    </section>
  );
}

function RunLogs({ attempt, issueId, run }) {
  const events = useRunEvents({ active: true, attempt, issueId, run, types: ['issue.log'] });
  return (
    <section className="run-resource-panel">
      <ResourceHeader
        eyebrow={`Attempt ${attempt?.sequence || '?'} · bounded ${RUN_EVENT_PAGE_SIZE}-event pages`}
        icon={FileText}
        loading={events.loading}
        onRefresh={events.refresh}
        title="Execution logs"
      />
      {events.error ? <ErrorState error={events.error} onRetry={events.refresh} /> : null}
      {!events.loading && !events.error && events.items.length === 0 ? (
        <EmptyState icon={FileText} text="No issue.log event falls inside this Attempt window." />
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

function RunAdvanced({ issueId, run }) {
  const events = useRunEvents({ active: true, attempt: null, issueId, run, types: [] });
  return (
    <section className="run-resource-panel run-advanced-panel">
      <ResourceHeader
        eyebrow="Read-only · append-only source events"
        icon={ListTree}
        loading={events.loading}
        onRefresh={events.refresh}
        title="Advanced raw events"
      />
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
        <EmptyState icon={ListTree} text="No raw issue event falls inside this Run window." />
      ) : null}
      <EventPageFooter events={events} />
      <details className="run-raw-object">
        <summary>Raw Run / Attempt projection</summary>
        <pre>{JSON.stringify(run, null, 2)}</pre>
      </details>
    </section>
  );
}

function Metric({ label, value }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function ResourceHeader({ eyebrow, icon: Icon, loading, onRefresh, title }) {
  return (
    <header className="run-resource-header">
      <div><span>{eyebrow}</span><h2><Icon size={17} /> {title}</h2></div>
      <button aria-label={`Refresh ${title}`} disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'is-spinning' : ''} size={14} /> Refresh
      </button>
    </header>
  );
}

function EventPageFooter({ events }) {
  return (
    <footer className="run-event-page-footer">
      <span>{events.scanned} raw events scanned · interactive cap {RUN_EVENT_SCAN_LIMIT}</span>
      {events.hasOlder ? (
        <button disabled={events.loadingMore} onClick={events.loadMore} type="button">
          {events.loadingMore ? <LoaderCircle className="is-spinning" size={13} /> : <Clock3 size={13} />}
          {events.loadingMore ? 'Loading…' : 'Load earlier'}
        </button>
      ) : null}
    </footer>
  );
}

function EmptyState({ icon: Icon, text }) {
  return <div className="run-detail-empty"><Icon size={19} /><span>{text}</span></div>;
}

function ErrorState({ error, onRetry }) {
  return <div className="run-detail-error" role="alert"><span>{error}</span><button onClick={onRetry} type="button">Retry</button></div>;
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
      if (alive) setError(loadError.message || '加载 Run events 失败');
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
      setError(loadError.message || '加载更早 Run events 失败');
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
