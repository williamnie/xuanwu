import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, Pin } from 'lucide-react';
import TurtleLoader from '../../components/TurtleLoader';
import VirtualSessionList from './VirtualSessionList';
import { providerLabel } from './sessionPageRuntime';

const SESSION_APP_SIDEBAR_SLOT_ID = 'sessions-app-sidebar-slot';
const PINNED_SESSIONS_STORAGE_KEY = 'codex-pinned-sessions';

export default function SessionSidebar({
  activeView,
  cursor,
  loading,
  loadingMore,
  projects,
  savingProjectOrder,
  selectedId,
  sessions,
  onLoadMore,
  onNewSession,
  onReorderProjects,
  onSelectSession,
}) {
  const [portalTarget, setPortalTarget] = useState(null);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(() => {
    const stored = localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  });
  const pinnedSessions = useMemo(
    () => sessions.filter((session) => pinnedSessionIds.includes(session.id)),
    [pinnedSessionIds, sessions],
  );
  const togglePinSession = useCallback((id, event) => {
    event?.stopPropagation();
    setPinnedSessionIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    setPortalTarget(document.getElementById(SESSION_APP_SIDEBAR_SLOT_ID));
  }, []);

  if (!portalTarget) return null;

  return createPortal((
    <div className="sessions-app-sidebar-panel">
      <div className="sidebar-shortcut-items">
        <button
          className={`sidebar-shortcut-item ${activeView === 'new' ? 'active' : ''}`}
          onClick={onNewSession}
          type="button"
        >
          <span className="sidebar-shortcut-item-icon"><MessageSquarePlus size={16} /></span>
          <span>新对话</span>
        </button>
      </div>

      {pinnedSessions.length > 0 && (
        <>
          <div className="sidebar-section-title">置顶</div>
          <div className="pinned-sessions-list">
            {pinnedSessions.map((session) => (
              <button
                key={session.id}
                className={`pinned-session-row ${selectedId === session.id && activeView === 'chat' ? 'active' : ''}`}
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <span className="pinned-title" title={session.name || session.preview}>{session.name || session.preview || '未命名 Codex 会话'}</span>
                <div className="pinned-actions">
                  <span className="session-provider-pill">{providerLabel(session.provider)}</span>
                  <button
                    className="pinned-action-btn"
                    onClick={(event) => togglePinSession(session.id, event)}
                    title="取消置顶"
                    type="button"
                  >
                    <Pin size={11} fill="currentColor" style={{ transform: 'rotate(45deg)', color: 'var(--primary)' }} />
                  </button>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sidebar-section-title">项目</div>
      <div className="sidebar-scroll-area">
        {loading ? (
          <div className="session-list-loading">
            <TurtleLoader compact label="正在召回会话…" />
          </div>
        ) : (
          <VirtualSessionList
            sessions={sessions}
            projects={projects}
            selectedId={selectedId}
            hasMore={Boolean(cursor)}
            loadingMore={loadingMore}
            savingOrder={savingProjectOrder}
            onSelect={onSelectSession}
            onLoadMore={onLoadMore}
            onReorderProjects={onReorderProjects}
          />
        )}
      </div>
    </div>
  ), portalTarget);
}
