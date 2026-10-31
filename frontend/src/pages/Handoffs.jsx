import HandoffDetail from './HandoffDetail.jsx';
import { StatusBadge } from './HandoffStatusBadge.jsx';
import { formatHandoffTime as formatTime } from './handoffTime.js';
import { projectOptionLabel } from '../utils/projectOptionLabel.js';
import { useProjectNodes } from '../store/useProjectNodes.js';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, GitBranch, PackageCheck, RefreshCw } from 'lucide-react';
import { handoffsApi } from '../api/handoffs.js';
import { eventsApi } from '../api/events.js';
import { selectProjects, useDataStore } from '../store/dataStore';

import { displayRef, handoffHref } from './handoffPageModel.js';
import './Handoffs.css';

const STATUS_OPTIONS = ['', 'draft', 'ready', 'delivered', 'superseded'];
const MODE_OPTIONS = ['', 'local_changes', 'branch_commit', 'push', 'draft_pr', 'ready_pr', 'deploy', 'release'];

export default function Handoffs({ selectedHandoffId = '' }) {
  const nodesById = useProjectNodes();
  const projects = useDataStore(selectProjects);
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(selectedHandoffId);
  const [detail, setDetail] = useState(null);
  const [filters, setFilters] = useState({ deliveryMode: '', projectId: '', status: '' });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedHandoffId) setSelectedId(selectedHandoffId);
  }, [selectedHandoffId]);

  useEffect(() => eventsApi.subscribeToEvents((event) => {
    if (event.type === 'handoff.notification') setRefreshVersion(version => version + 1);
  }), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    handoffsApi.getHandoffs(filters)
      .then((response) => {
        if (!active) return;
        const nextItems = response?.items || [];
        setItems(nextItems);
        setSelectedId(current => current || nextItems[0]?.id || '');
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || '加载 Handoff 失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [filters, refreshVersion]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    let active = true;
    setDetailLoading(true);
    handoffsApi.getHandoff(selectedId)
      .then((response) => {
        if (active) setDetail(response);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || '加载 Handoff 详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [refreshVersion, selectedId]);

  const stats = useMemo(() => ({
    delivered: items.filter(item => item.delivery_status?.overall === 'delivered').length,
    ready: items.filter(item => item.delivery_status?.overall === 'ready').length,
    risks: items.reduce((total, item) => total + (item.risk_count || 0), 0),
  }), [items]);

  const selectHandoff = (id) => {
    setSelectedId(id);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', handoffHref(id));
  };

  const refresh = () => setRefreshVersion(version => version + 1);

  return (
    <section className="handoff-page">
      <header className="handoff-header">
        <div>
          <span className="handoff-kicker"><PackageCheck size={14} /> Delivery protocol</span>
          <h1>Handoff 审计</h1>
          <p>高级审计视图；日常查看请从对应 Issue / Work 的“交付”页签进入。</p>
        </div>
        <button className="handoff-refresh" disabled={loading || detailLoading} onClick={refresh} type="button">
          <RefreshCw className={loading || detailLoading ? 'is-spinning' : ''} size={15} /> 刷新交付状态
        </button>
        <div className="handoff-stats" aria-label="Handoff summary">
          <HandoffStat label="Visible" value={items.length} />
          <HandoffStat label="Ready" tone="blue" value={stats.ready} />
          <HandoffStat label="Delivered" tone="green" value={stats.delivered} />
          <HandoffStat label="Risks" tone="amber" value={stats.risks} />
        </div>
      </header>

      <div className="handoff-authority-note">
        <span />
        <strong>Facts stay with Git, Evidence, review and delivery audit.</strong>
        <p>当前列表读取 append-only Handoff stream；刷新只重读本地 outbox/交付事实，不触发外部写。</p>
        <code>issue_events:handoff.*.v1</code>
      </div>

      <div className="handoff-filters">
        <Filter label="Project" onChange={projectId => setFilters(current => ({ ...current, projectId }))} value={filters.projectId}>
          <option value="">All projects</option>
          {projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name)}</option>)}
        </Filter>
        <Filter label="Status" onChange={status => setFilters(current => ({ ...current, status }))} value={filters.status}>
          {STATUS_OPTIONS.map(status => <option key={status || 'all'} value={status}>{status || 'All statuses'}</option>)}
        </Filter>
        <Filter label="Delivery" onChange={deliveryMode => setFilters(current => ({ ...current, deliveryMode }))} value={filters.deliveryMode}>
          {MODE_OPTIONS.map(mode => <option key={mode || 'all'} value={mode}>{mode || 'All modes'}</option>)}
        </Filter>
      </div>

      {error ? (
        <div className="handoff-error" role="alert">
          <AlertTriangle size={16} />
          <div><strong>Handoff 暂不可用</strong><span>{error}</span></div>
          <button onClick={refresh} type="button">重试</button>
        </div>
      ) : (
        <div className="handoff-workspace" aria-busy={loading || detailLoading}>
          <aside className="handoff-list" aria-label="Handoff list">
            <div className="handoff-list-title"><span>Latest delivery</span><strong>{items.length}</strong></div>
            {items.length > 0 ? items.map(item => (
              <button
                className={`handoff-list-item ${selectedId === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => selectHandoff(item.id)}
                type="button"
              >
                <span className="handoff-list-topline">
                  <StatusBadge status={item.delivery_status?.overall || item.status} />
                  <time>{formatTime(item.updated_at)}</time>
                </span>
                <strong>{item.issue?.id ? `#${item.issue.id} ` : ''}{item.issue?.title || '未关联 Issue 标题'}</strong>
                <span className="handoff-list-summary">{item.summary}</span>
                <span className="handoff-list-ref">
                  {item.delivery?.branch_ref ? <><GitBranch size={13} /> {displayRef(item.delivery.branch_ref, 18, 8)}</> : item.delivery?.mode}
                </span>
                <span className="handoff-list-counts">
                  {item.changed_file_count} files · {item.evidence_count} Evidence · {item.risk_count} risks
                </span>
              </button>
            )) : (
              <div className="handoff-empty">{loading ? '正在读取交付记录…' : '当前过滤条件下没有 Handoff。'}</div>
            )}
          </aside>

          <main className="handoff-detail">
            {detail ? <HandoffDetail detail={detail} onRefresh={refresh} /> : (
              <div className="handoff-empty-detail"><PackageCheck size={34} /><strong>选择一个 Handoff</strong><span>查看交付 refs、Evidence、风险和下一步。</span></div>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function HandoffStat({ label, tone = '', value }) {
  return <div className={`handoff-stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Filter({ children, label, onChange, value }) {
  return <label><span>{label}</span><select onChange={event => onChange(event.target.value)} value={value}>{children}</select></label>;
}
