import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, MessageSquare } from 'lucide-react';

const ROW_HEIGHT = 96;
const OVERSCAN = 6;

function formatTime(seconds) {
  if (!seconds) return 'unknown';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(seconds * 1000));
}

function sessionTitle(session) {
  return session.name || session.preview || 'Untitled Codex session';
}

function statusType(session) {
  if (!session.status) return 'unknown';
  if (typeof session.status === 'string') return session.status;
  return session.status.type || 'unknown';
}

function projectNameFromPath(cwd) {
  const trimmed = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'No project';
  return trimmed.split(/[\\/]/).pop() || 'No project';
}

function projectNameForSession(session, projectsByCwd) {
  const cwd = session.cwd || '';
  return projectsByCwd.get(cwd)?.name || projectNameFromPath(cwd);
}

function useVirtualRows(containerRef, count) {
  const frameRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const node = containerRef.current;
    const updateHeight = () => setHeight(node.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const onScroll = useCallback((event) => {
    const nextTop = event.currentTarget.scrollTop;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => setScrollTop(nextTop));
  }, []);

  return useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(count, start + visible);
    return { onScroll, start, end, totalHeight: count * ROW_HEIGHT, offsetY: start * ROW_HEIGHT };
  }, [count, height, onScroll, scrollTop]);
}

const SessionRow = memo(function SessionRow({ session, active, projectName, onSelect }) {
  const title = sessionTitle(session);
  const status = statusType(session);
  return (
    <button className={`session-row ${active ? 'active' : ''}`} onClick={() => onSelect(session.id)}>
      <div className="session-row-icon"><MessageSquare size={16} /></div>
      <div className="session-row-main">
        <div className="session-row-title" title={title}>{title}</div>
        <div className="session-row-meta">
          <span className={`session-status ${status}`}>{status}</span>
          <span>{formatTime(session.updatedAt || session.createdAt)}</span>
        </div>
        <div className="session-row-project" title={session.cwd || projectName}>
          <GitBranch size={12} /> {projectName}
        </div>
      </div>
    </button>
  );
});

export default function VirtualSessionList({ sessions, projects = [], selectedId, hasMore, loadingMore, onSelect, onLoadMore }) {
  const containerRef = useRef(null);
  const virtual = useVirtualRows(containerRef, sessions.length);
  const projectsByCwd = useMemo(() => new Map(projects.map((project) => [project.cwd, project])), [projects]);

  const handleScroll = useCallback((event) => {
    virtual.onScroll(event);
    const node = event.currentTarget;
    if (hasMore && !loadingMore && node.scrollTop + node.clientHeight > node.scrollHeight - 500) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore, virtual]);

  const visibleSessions = sessions.slice(virtual.start, virtual.end);

  return (
    <div ref={containerRef} className="session-list-viewport" onScroll={handleScroll}>
      <div style={{ height: virtual.totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${virtual.offsetY}px)` }}>
          {visibleSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              projectName={projectNameForSession(session, projectsByCwd)}
              active={selectedId === session.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      {loadingMore && <div className="session-list-loading">继续加载 Codex sessions...</div>}
    </div>
  );
}
