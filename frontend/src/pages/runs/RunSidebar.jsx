import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BriefcaseBusiness, Loader2, MessageSquarePlus, RotateCw } from 'lucide-react';
import TurtleLoader from '../../components/TurtleLoader';
import { runStatusLabel } from './runPageModel.js';

const RUNS_APP_SIDEBAR_SLOT_ID = 'sessions-app-sidebar-slot';

export default function RunSidebar({
  hasMore,
  loading,
  loadingMore,
  refreshing,
  onLoadMore,
  onNewProviderSession,
  onRefresh,
  onSelectRun,
  runs,
  selectedRunId,
}) {
  const [portalTarget, setPortalTarget] = useState(null);

  useEffect(() => {
    setPortalTarget(document.getElementById(RUNS_APP_SIDEBAR_SLOT_ID));
  }, []);

  if (!portalTarget) return null;

  const loadOnScroll = (event) => {
    const target = event.currentTarget;
    if (hasMore && !loadingMore && target.scrollHeight - target.scrollTop - target.clientHeight <= 120) {
      onLoadMore();
    }
  };

  return createPortal((
    <div className="sessions-app-sidebar-panel runs-app-sidebar-panel">
      <div className="sidebar-shortcut-items">
        <button className="sidebar-shortcut-item runs-new-session-button" onClick={onNewProviderSession} type="button">
          <span className="sidebar-shortcut-item-icon"><MessageSquarePlus size={16} /></span>
          <span>新建 provider session</span>
        </button>
      </div>

      <div className="runs-sidebar-heading">
        <div>
          <span className="sidebar-section-title">Runs</span>
          <small>执行历史</small>
        </div>
        <button aria-busy={refreshing} aria-label="刷新 Runs" className="runs-sidebar-refresh" disabled={refreshing} onClick={onRefresh} type="button">
          <RotateCw className={refreshing ? 'animate-spin' : ''} size={13} />
        </button>
      </div>

      <div className="sidebar-scroll-area runs-sidebar-scroll" onScroll={loadOnScroll}>
        {loading && runs.length === 0 ? (
          <div className="session-list-loading"><TurtleLoader compact label="正在读取 Runs…" /></div>
        ) : runs.length === 0 ? (
          <div className="runs-sidebar-empty">暂无 Run；Work 被 runner claim 后会生成执行记录。</div>
        ) : (
          <div className="runs-sidebar-list">
            {runs.map(run => (
              <button
                className={`run-sidebar-row ${selectedRunId === run.id ? 'active' : ''}`}
                key={run.id}
                onClick={() => onSelectRun(run.id)}
                type="button"
              >
                <span className="run-sidebar-title">{run.work_title || 'Untitled Work'}</span>
                <span className="run-sidebar-work"><BriefcaseBusiness size={11} /> Work #{workNumber(run.work_id)}</span>
                <span className="run-sidebar-meta">
                  <span className={`run-status-dot ${run.status || 'unknown'}`} />
                  {runStatusLabel(run.status)} · {providerLabel(run.provider)} · Attempt {run.attempt_count || run.sequence || 0}
                </span>
              </button>
            ))}
            {hasMore ? (
              <button className="runs-sidebar-load-more" disabled={loadingMore} onClick={onLoadMore} type="button">
                {loadingMore ? <Loader2 className="is-spinning" size={12} /> : null}
                继续加载
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  ), portalTarget);
}

function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  if (provider === 'pi-coding-agent') return 'Pi Coding Agent';
  return provider || 'Unknown';
}

function workNumber(workId) {
  return String(workId || '').split(':').at(-1) || '?';
}
