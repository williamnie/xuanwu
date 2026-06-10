import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Filter, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { shortId } from './piChatState';
import {
  filterTimelineItems,
  timelineChips,
  timelineItemDisplay,
  viewFilterLabel,
} from './piHeartbeatTimelineDisplay';
import './PiHeartbeatTimelinePanel.css';

const TIMELINE_LIMIT = 80;

export default function PiHeartbeatTimelinePanel() {
  const timeline = useHeartbeatTimeline();
  return (
    <section className="pi-heartbeat-timeline-panel" aria-label="自动检查时间线">
      <TimelineHeader timeline={timeline} />
      <TimelineFilters timeline={timeline} />
      {timeline.error && <div className="pi-heartbeat-timeline-error" role="alert">{timeline.error}</div>}
      <TimelineList items={timeline.items} loading={timeline.loading} view={timeline.filters.view} />
    </section>
  );
}

function useHeartbeatTimeline() {
  const [filters, setFilters] = useState({ issueId: '', projectId: '', view: 'all' });
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
        <p>按时间串联发现信号、策略判断、准备执行和执行结果，默认显示用户可读摘要，技术详情可按需展开。</p>
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
      <label>
        记录类型
        <select value={timeline.filters.view} onChange={(event) => timeline.updateFilter('view', event.target.value)}>
          {['all', 'abnormal', 'attention', 'result'].map((view) => (
            <option key={view} value={view}>{viewFilterLabel(view)}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function TimelineList({ items, loading, view }) {
  const visibleItems = useMemo(() => filterTimelineItems(items, view).slice(0, TIMELINE_LIMIT), [items, view]);
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
  const display = timelineItemDisplay(item);
  return (
    <article className={`pi-heartbeat-timeline-item ${item.stage}`}>
      <div className="pi-heartbeat-timeline-rail"><span>{display.stageLabel}</span></div>
      <div className="pi-heartbeat-timeline-body">
        <div className="pi-heartbeat-timeline-meta">
          <strong>{display.title}</strong>
          <time>{formatTime(item.created_at)}</time>
        </div>
        <p>{display.description}</p>
        <TimelineChips item={item} />
        <TimelineDetails item={item} />
      </div>
    </article>
  );
}

function TimelineChips({ item }) {
  const chips = timelineChips(item, shortId);
  return (
    <div className="pi-heartbeat-timeline-chips">
      {chips.map((chip) => <code className={chip.muted ? 'muted' : ''} key={chip.text}>{chip.text}</code>)}
    </div>
  );
}

function TimelineDetails({ item }) {
  const details = detailText(item);
  if (!details) return null;
  return (
    <details className="pi-heartbeat-timeline-details">
      <summary>查看技术详情</summary>
      <p>以下是调试用 payload、result 与错误原文，默认折叠以保持事件流可读。</p>
      <pre>{details}</pre>
    </details>
  );
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
