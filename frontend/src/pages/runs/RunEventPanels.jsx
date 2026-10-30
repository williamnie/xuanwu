import { useRunEvents } from './useRunEvents.js';
import { ResourceHeader, EmptyState, ErrorState, EventPageFooter } from './RunDetailPrimitives.jsx';
import { prettyPayload, formatTime } from './runDetailFormat.js';

import { FileText, ListTree } from 'lucide-react';

import { runCostView, runLogSummary } from './runDetailModel.js';

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

export function RunLogs({ attempt, issueId, run }) {
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

export function RunAdvanced({ attempt, issueId, run }) {
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

