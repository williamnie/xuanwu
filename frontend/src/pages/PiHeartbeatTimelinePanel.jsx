import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Filter, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { shortId } from './piChatState';
import './PiHeartbeatTimelinePanel.css';

const TIMELINE_LIMIT = 80;
const STAGE_LABELS = {
  action: 'action',
  decision: 'decision',
  result: 'result',
  signal: 'signal',
  supervisor_action: 'supervisor action',
  supervisor_decision: 'supervisor decision',
  supervisor_result: 'supervisor result',
  supervisor_signal: 'supervisor signal',
};

export default function PiHeartbeatTimelinePanel() {
  const timeline = useHeartbeatTimeline();
  return (
    <section className="pi-heartbeat-timeline-panel" aria-label="Heartbeat Timeline">
      <TimelineHeader timeline={timeline} />
      <TimelineFilters timeline={timeline} />
      {timeline.error && <div className="pi-heartbeat-timeline-error" role="alert">{timeline.error}</div>}
      <TimelineList items={timeline.items} loading={timeline.loading} />
    </section>
  );
}

function useHeartbeatTimeline() {
  const [filters, setFilters] = useState({ issueId: '', projectId: '' });
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);
  const [state, setState] = useState({ error: '', loading: true });
  const { issueId, projectId } = filters;
  const load = useCallback(async () => {
    setState({ error: '', loading: true });
    try {
      const [nextProjects, nextItems] = await Promise.all([
        api.getProjects(),
        api.getPiHeartbeatTimeline({ issueId, limit: TIMELINE_LIMIT, projectId }),
      ]);
      setProjects(Array.isArray(nextProjects) ? nextProjects : []);
      setItems(Array.isArray(nextItems) ? nextItems : []);
      setState({ error: '', loading: false });
    } catch (err) {
      setState({ error: err.message || '读取 heartbeat timeline 失败', loading: false });
    }
  }, [issueId, projectId]);
  useEffect(() => { load(); }, [load]);
  const updateFilter = useCallback((name, value) => {
    setFilters((current) => ({ ...current, [name]: value }));
  }, []);
  return { ...state, filters, items, load, projects, updateFilter };
}

function TimelineHeader({ timeline }) {
  return (
    <div className="pi-heartbeat-timeline-header">
      <div>
        <span>PI OpenClaw P11.04</span>
        <h2><Activity size={18} /> Heartbeat Timeline</h2>
        <p>按时间串联 signal / decision / action / result，展示 PI heartbeat 与 audit 证据。</p>
      </div>
      <button className="pi-heartbeat-timeline-refresh" onClick={timeline.load} disabled={timeline.loading} type="button">
        {timeline.loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
        Refresh
      </button>
    </div>
  );
}

function TimelineFilters({ timeline }) {
  return (
    <div className="pi-heartbeat-timeline-filters" aria-label="Heartbeat timeline filters">
      <Filter size={14} />
      <label>
        Project
        <select value={timeline.filters.projectId} onChange={(event) => timeline.updateFilter('projectId', event.target.value)}>
          <option value="">All projects</option>
          {timeline.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name || project.id}</option>
          ))}
        </select>
      </label>
      <label>
        Issue
        <input
          min="1"
          placeholder="issue id"
          type="number"
          value={timeline.filters.issueId}
          onChange={(event) => timeline.updateFilter('issueId', event.target.value)}
        />
      </label>
    </div>
  );
}

function TimelineList({ items, loading }) {
  const visibleItems = useMemo(() => items.slice(0, TIMELINE_LIMIT), [items]);
  if (loading && visibleItems.length === 0) {
    return <div className="pi-heartbeat-timeline-empty"><Loader2 size={14} className="spin-animation" /> 正在加载 timeline…</div>;
  }
  if (visibleItems.length === 0) {
    return <div className="pi-heartbeat-timeline-empty">暂无 heartbeat/audit 记录；可选择项目或 issue 过滤。</div>;
  }
  return (
    <div className="pi-heartbeat-timeline-list">
      {visibleItems.map((item) => <TimelineItem item={item} key={item.id} />)}
    </div>
  );
}

function TimelineItem({ item }) {
  return (
    <article className={`pi-heartbeat-timeline-item ${item.stage}`}>
      <div className="pi-heartbeat-timeline-rail"><span>{STAGE_LABELS[item.stage] || 'result'}</span></div>
      <div className="pi-heartbeat-timeline-body">
        <div className="pi-heartbeat-timeline-meta">
          <strong>{eventTitle(item)}</strong>
          <time>{formatTime(item.created_at)}</time>
        </div>
        <p>{item.message || fallbackMessage(item)}</p>
        <TimelineChips item={item} />
        <TimelineDetails item={item} />
      </div>
    </article>
  );
}

function TimelineChips({ item }) {
  const chips = [
    item.project_id ? `project:${item.project_id}` : '',
    item.issue_id ? `issue:#${item.issue_id}` : '',
    item.heartbeat_id ? `heartbeat:${shortId(item.heartbeat_id)}` : '',
    item.action_id ? `action:${shortId(item.action_id)}` : '',
    item.delegation_id ? `delegation:${shortId(item.delegation_id)}` : '',
    item.decision ? `decision:${item.decision}` : '',
  ].filter(Boolean);
  return <div className="pi-heartbeat-timeline-chips">{chips.map((chip) => <code key={chip}>{chip}</code>)}</div>;
}

function TimelineDetails({ item }) {
  const details = detailText(item);
  if (!details) return null;
  return (
    <details className="pi-heartbeat-timeline-details">
      <summary>payload / result</summary>
      <pre>{details}</pre>
    </details>
  );
}

function eventTitle(item) {
  const source = item.source === 'heartbeat' ? 'heartbeat' : item.source === 'supervisor' ? 'supervisor' : 'audit';
  return `${source} · ${String(item.event_type || 'event').replaceAll('_', ' ')}`;
}

function fallbackMessage(item) {
  if (item.error) return item.error;
  if (item.stage === 'signal') return 'PI collected runtime signals.';
  if (item.stage === 'decision') return 'PI evaluated policy and authorization.';
  if (item.stage === 'action') return 'PI planned or started an action.';
  return 'PI recorded the result.';
}

function detailText(item) {
  const sections = [
    jsonSection('payload', item.payload_json),
    jsonSection('result', item.result_json),
    item.error ? `error\\n${item.error}` : '',
  ].filter(Boolean);
  return sections.join('\\n\\n');
}

function jsonSection(label, text) {
  const normalized = prettyJson(text);
  return normalized && normalized !== '{}' ? `${label}\\n${normalized}` : '';
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text || '{}'), null, 2);
  } catch {
    return String(text || '');
  }
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
