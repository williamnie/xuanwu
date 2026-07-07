import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Link2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import './ActivityTimelinePanel.css';

const DEFAULT_FILTERS = { inboxItemId: '', issueId: '', limit: 100, proposalId: '', since: '', source: '', until: '' };

export default function ActivityTimelinePanel({ navigateTo }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [applied, setApplied] = useState(DEFAULT_FILTERS);
  const [timeline, setTimeline] = useState({ items: [] });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const items = useMemo(() => timeline.items || [], [timeline]);

  useEffect(() => { loadTimeline(applied, setTimeline, setNotice, setLoading); }, [applied]);
  const applyFilters = (event) => {
    event.preventDefault();
    setApplied(cleanFilters(filters));
  };

  return (
    <section className="glass-card activity-panel">
      <PanelHeader loading={loading} onRefresh={() => loadTimeline(applied, setTimeline, setNotice, setLoading)} />
      <FilterForm filters={filters} onChange={setFilters} onSubmit={applyFilters} />
      {notice && <div className="activity-empty compact">{notice}</div>}
      {!notice && <TimelineSummary generatedAt={timeline.generated_at} items={items} />}
      {!notice && <TimelineList items={items} loading={loading} navigateTo={navigateTo} />}
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="activity-head">
      <div>
        <p className="activity-eyebrow"><Activity size={14} /> Activity Timeline</p>
        <h2>Raw → Intake → Action trace</h2>
        <p>串联 raw event、context bundle、intake run、inbox item、domain skill、proposal、policy 与 issue/reply。</p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function FilterForm({ filters, onChange, onSubmit }) {
  const update = (field) => (event) => onChange((current) => ({ ...current, [field]: event.target.value }));
  return (
    <form className="activity-filter" onSubmit={onSubmit}>
      <label>Source<input value={filters.source} onChange={update('source')} placeholder="fixture-cli" /></label>
      <label>Inbox item<input value={filters.inboxItemId} onChange={update('inboxItemId')} placeholder="123" /></label>
      <label>Proposal<input value={filters.proposalId} onChange={update('proposalId')} placeholder="proposal id" /></label>
      <label>Issue<input value={filters.issueId} onChange={update('issueId')} placeholder="602" /></label>
      <label>Since<input value={filters.since} onChange={update('since')} placeholder="2026-07-06T00:00:00Z" /></label>
      <label>Until<input value={filters.until} onChange={update('until')} placeholder="2026-07-07T00:00:00Z" /></label>
      <button className="btn btn-secondary" type="submit"><Search size={15} /> 查询</button>
    </form>
  );
}

function TimelineSummary({ generatedAt, items }) {
  return (
    <div className="activity-summary">
      <span>{items.length} nodes</span>
      <span>generated {formatTime(generatedAt)}</span>
      <span><ShieldCheck size={13} /> summaries are redacted</span>
    </div>
  );
}

function TimelineList({ items, loading, navigateTo }) {
  if (loading && !items.length) return <div className="activity-empty">正在加载 Activity timeline…</div>;
  if (!items.length) return <div className="activity-empty">暂无可追踪 activity。可按 source / inbox / proposal / issue 缩小范围。</div>;
  return <div className="activity-list">{items.map((node) => <TimelineNode key={node.id} navigateTo={navigateTo} node={node} />)}</div>;
}

function TimelineNode({ navigateTo, node }) {
  const failed = isFailed(node);
  return (
    <article className={`activity-node ${failed ? 'failed' : ''} ${node.kind === 'policy_decision' ? 'policy' : ''}`}>
      <div className="activity-rail-dot">{failed ? <AlertTriangle size={13} /> : node.stage.slice(0, 1)}</div>
      <div className="activity-node-body">
        <div className="activity-node-top">
          <span className={`activity-stage ${node.kind}`}>{node.stage}</span>
          <span className="activity-time">{formatTime(node.at)}</span>
        </div>
        <h3>{node.title || node.kind}</h3>
        <p>{node.summary || 'No redacted summary.'}</p>
        <div className="activity-meta">
          <span>Status: <strong>{node.status || 'recorded'}</strong></span>
          {node.decision && <span>Decision: <strong>{node.decision}</strong></span>}
        </div>
        <NodeLinks navigateTo={navigateTo} node={node} />
        <details className="activity-refs"><summary>refs</summary><pre>{JSON.stringify(node.refs || {}, null, 2)}</pre></details>
      </div>
    </article>
  );
}

function NodeLinks({ navigateTo, node }) {
  const links = Object.entries(node.links || {}).filter(([, href]) => href);
  const issueId = Number(node.refs?.issue_id || 0);
  const sessionId = node.refs?.session_id || '';
  return (
    <div className="activity-links">
      {issueId > 0 && navigateTo && <button onClick={() => navigateTo('issues', issueId)} type="button"><Link2 size={13} /> Issue #{issueId}</button>}
      {sessionId && navigateTo && <button onClick={() => navigateTo('sessions', null, sessionId)} type="button"><Link2 size={13} /> Session</button>}
      {issueId > 0 && <a href={`/api/issues/${issueId}`} rel="noreferrer" target="_blank"><Link2 size={13} /> issue API</a>}
      {links.map(([label, href]) => <a href={href} key={`${label}:${href}`} rel="noreferrer" target="_blank"><Link2 size={13} /> {label}</a>)}
    </div>
  );
}

function cleanFilters(filters) {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

function loadTimeline(filters, setTimeline, setNotice, setLoading) {
  setLoading(true);
  api.getPiActivityTimeline(filters)
    .then((data) => { setTimeline(data || { items: [] }); setNotice(''); })
    .catch((err) => {
      if (err.status === 404) setNotice('当前 runtime 尚未启用 Activity API。');
      else message.error(err.message || '加载 Activity timeline 失败');
    })
    .finally(() => setLoading(false));
}

function isFailed(node) {
  return /fail|error|deny|denied/i.test(`${node.status} ${node.summary} ${node.decision}`);
}

function formatTime(value) {
  if (!value) return 'unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
