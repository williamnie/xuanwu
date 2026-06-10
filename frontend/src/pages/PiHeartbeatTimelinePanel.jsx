import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Filter, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { shortId } from './piChatState';
import { eventTypeLabel, runtimeMessageLabel, sourceLabel, stageLabel } from './piCommandCenterTerms';
import './PiHeartbeatTimelinePanel.css';

const TIMELINE_LIMIT = 80;

export default function PiHeartbeatTimelinePanel() {
  const timeline = useHeartbeatTimeline();
  return (
    <section className="pi-heartbeat-timeline-panel" aria-label="自动检查时间线">
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
      setState({ error: err.message || '读取自动检查时间线失败', loading: false });
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
        <span>PI 自动化证据</span>
        <h2><Activity size={18} /> 自动检查时间线</h2>
        <p>按时间串联运行信号、策略决策、执行动作和执行结果，展示 PI 自动检查与审计证据。</p>
      </div>
      <button className="pi-heartbeat-timeline-refresh" onClick={timeline.load} disabled={timeline.loading} type="button">
        {timeline.loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
        刷新
      </button>
    </div>
  );
}

function TimelineFilters({ timeline }) {
  return (
    <div className="pi-heartbeat-timeline-filters" aria-label="自动检查时间线筛选">
      <Filter size={14} />
      <label>
        项目
        <select value={timeline.filters.projectId} onChange={(event) => timeline.updateFilter('projectId', event.target.value)}>
          <option value="">全部项目</option>
          {timeline.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name || project.id}</option>
          ))}
        </select>
      </label>
      <label>
        Issue 编号
        <input
          min="1"
          placeholder="例如 310"
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
    return <div className="pi-heartbeat-timeline-empty"><Loader2 size={14} className="spin-animation" /> 正在加载时间线…</div>;
  }
  if (visibleItems.length === 0) {
    return <div className="pi-heartbeat-timeline-empty">暂无自动检查或审计记录；可选择项目或 issue 编号过滤。</div>;
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
      <div className="pi-heartbeat-timeline-rail"><span>{stageLabel(item.stage)}</span></div>
      <div className="pi-heartbeat-timeline-body">
        <div className="pi-heartbeat-timeline-meta">
          <strong>{eventTitle(item)}</strong>
          <time>{formatTime(item.created_at)}</time>
        </div>
        <p>{runtimeMessageLabel(item.message) || fallbackMessage(item)}</p>
        <TimelineChips item={item} />
        <TimelineDetails item={item} />
      </div>
    </article>
  );
}

function TimelineChips({ item }) {
  const chips = [
    item.project_id ? `项目：${item.project_id}` : '',
    item.issue_id ? `Issue：#${item.issue_id}` : '',
    item.heartbeat_id ? `自动检查：${shortId(item.heartbeat_id)}` : '',
    item.action_id ? `动作：${shortId(item.action_id)}` : '',
    item.delegation_id ? `委托：${shortId(item.delegation_id)}` : '',
    item.decision ? `决策：${item.decision}` : '',
  ].filter(Boolean);
  return <div className="pi-heartbeat-timeline-chips">{chips.map((chip) => <code key={chip}>{chip}</code>)}</div>;
}

function TimelineDetails({ item }) {
  const details = detailText(item);
  if (!details) return null;
  return (
    <details className="pi-heartbeat-timeline-details">
      <summary>请求数据 / 执行结果</summary>
      <pre>{details}</pre>
    </details>
  );
}

function eventTitle(item) {
  return `${sourceLabel(item.source)} · ${eventTypeLabel(item.event_type || 'event')}`;
}

function fallbackMessage(item) {
  if (item.error) return item.error;
  if (item.stage === 'signal') return 'PI 已收集运行信号。';
  if (item.stage === 'decision') return 'PI 已评估执行策略和授权范围。';
  if (item.stage === 'action') return 'PI 已规划或启动动作。';
  return 'PI 已记录执行结果。';
}

function detailText(item) {
  const sections = [
    jsonSection('请求数据', item.payload_json),
    jsonSection('执行结果', item.result_json),
    item.error ? `错误\\n${item.error}` : '',
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
