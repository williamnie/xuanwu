import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Folder, FolderOpen, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import {
  nextProjectSessionVisibleCount,
  PROJECT_SESSION_PAGE_SIZE,
  projectSessionMoreState,
  projectSessionVisibleCount,
  visibleProjectSessions,
} from './projectSessionPagination';
import { isProjectSessionGroupCollapsed } from './projectSessionCollapse';
import { filterProjectSessionGroups, isSessionListFilterActive } from './sessionListFilters';
import { providerSupports } from './sessionOptions';
import './ProjectSessionPagination.css';

function projectNameFromPath(cwd) {
  const trimmed = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'No project';
  return trimmed.split(/[\\/]/).pop() || 'No project';
}

function formatRelativeTime(seconds) {
  if (!seconds) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - seconds;
  if (diff < 0) return '刚刚';
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
}

function sessionOriginMeta(origin) {
  if (origin === 'runner') {
    return { className: 'runner', title: 'Runner：由 codex-issue-runner 创建或执行' };
  }
  return { className: 'codex-app', title: 'Codex App：来自 Codex App / CLI 会话' };
}

function providerLabel(provider) {
  switch (String(provider || 'codex').toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'opencode':
      return 'opencode';
    case 'kimicode':
      return 'kimicode';
    default:
      return provider || 'Unknown';
  }
}

const SessionItem = memo(function SessionItem({ session, active, onSelect }) {
  const title = session.name || session.preview || 'Untitled session';
  const relativeTime = formatRelativeTime(session.updatedAt || session.createdAt);
  const origin = sessionOriginMeta(session.origin);
  const provider = providerLabel(session.provider);

  return (
    <button 
      className={`session-item-row ${active ? 'active' : ''}`} 
      onClick={() => onSelect(session.id)}
    >
      <span className="session-item-title" title={title}>{title}</span>
      <div className="session-item-right">
        <span className="session-provider-pill">{provider}</span>
        <span className={`session-origin-dot ${origin.className}`} title={origin.title} />
        {session.isRunning ? (
          <span className="session-item-loading">
            <Loader2 size={12} />
          </span>
        ) : active ? (
          <span className="session-item-active-dot" />
        ) : (
          <span className="session-item-time">{relativeTime}</span>
        )}
      </div>
    </button>
  );
});

export default function VirtualSessionList({
  sessions,
  projects = [],
  selectedId,
  hasMore,
  loadingMore,
  savingOrder = false,
  autoCollapseEmptyProjects = true,
  onSelect,
  onLoadMore,
  onReorderProjects,
  searchTerm = '',
  filterMode = 'all',
}) {
  const [collapsed, setCollapsed] = useState({});
  const [visibleCounts, setVisibleCounts] = useState({});
  const [dragProjectId, setDragProjectId] = useState('');
  const [dragOverProjectId, setDragOverProjectId] = useState('');

  const projectsByCwd = useMemo(() => new Map(projects.map((project) => [project.cwd, project])), [projects]);

  // 分组与排序逻辑
  const groups = useMemo(() => {
    const groupMap = new Map();
    for (const project of projects) {
      groupMap.set(project.id, {
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        sessions: [],
        isVirtual: false,
        sessionsSupported: providerSupports(project, 'sessions'),
      });
    }

    const virtualGroups = new Map();
    for (const session of sessions) {
      const cwd = session.cwd || '';
      const matchedProject = projectsByCwd.get(cwd);
      if (matchedProject) {
        groupMap.get(matchedProject.id).sessions.push(session);
      } else {
        const virtualName = projectNameFromPath(cwd);
        const virtualKey = `virtual-${cwd || 'no-cwd'}`;
        if (!virtualGroups.has(virtualKey)) {
          virtualGroups.set(virtualKey, {
            id: virtualKey,
            name: virtualName,
            cwd: cwd,
            sessions: [],
            isVirtual: true,
          });
        }
        virtualGroups.get(virtualKey).sessions.push(session);
      }
    }

    const virtualProjectGroups = Array.from(virtualGroups.values());
    virtualProjectGroups.sort((a, b) => a.name.localeCompare(b.name));

    return [
      ...Array.from(groupMap.values()),
      ...virtualProjectGroups,
    ];
  }, [sessions, projects, projectsByCwd]);

  const filteredGroups = useMemo(() => (
    filterProjectSessionGroups(groups, { query: searchTerm, mode: filterMode })
  ), [groups, searchTerm, filterMode]);
  const hasActiveFilter = isSessionListFilterActive({ query: searchTerm, mode: filterMode });

  // 自动展开激活 Session 所在的项目组
  useEffect(() => {
    if (!selectedId || sessions.length === 0) return;
    const activeSession = sessions.find((s) => s.id === selectedId);
    if (!activeSession) return;

    const matchedProject = projectsByCwd.get(activeSession.cwd || '');
    const projId = matchedProject ? matchedProject.id : `virtual-${activeSession.cwd || 'no-cwd'}`;

    setCollapsed((prev) => {
      if (prev[projId]) {
        return { ...prev, [projId]: false };
      }
      return prev;
    });
  }, [selectedId, sessions, projectsByCwd]);

  const toggleCollapse = (group, isCollapsed) => {
    setCollapsed((prev) => ({ ...prev, [group.id]: !isCollapsed }));
  };

  const handleScroll = useCallback((event) => {
    const node = event.currentTarget;
    if (hasMore && !loadingMore && node.scrollTop + node.clientHeight > node.scrollHeight - 200) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore]);

  const handleDragStart = (event, group) => {
    if (group.isVirtual || savingOrder) {
      event.preventDefault();
      return;
    }
    setDragProjectId(group.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', group.id);
  };

  const handleDragOver = (event, group) => {
    if (group.isVirtual || savingOrder || !dragProjectId || dragProjectId === group.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverProjectId(group.id);
  };

  const handleProjectLoadMore = useCallback((group) => {
    const current = projectSessionVisibleCount(group.id, visibleCounts);
    if (group.sessions.length > current) {
      setVisibleCounts((prev) => ({
        ...prev,
        [group.id]: nextProjectSessionVisibleCount(current, group.sessions.length),
      }));
      return;
    }
    if (hasMore && !loadingMore) {
      setVisibleCounts((prev) => ({
        ...prev,
        [group.id]: current + PROJECT_SESSION_PAGE_SIZE,
      }));
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore, visibleCounts]);

  const resetDragState = () => {
    setDragProjectId('');
    setDragOverProjectId('');
  };

  const handleDrop = (event, group) => {
    event.preventDefault();
    if (!group.isVirtual && dragProjectId && dragProjectId !== group.id) {
      onReorderProjects?.(dragProjectId, group.id);
    }
    resetDragState();
  };

  return (
    <div className="session-list-viewport" onScroll={handleScroll}>
      <div className="project-session-groups">
        {hasActiveFilter && filteredGroups.length === 0 && (
          <div className="session-list-empty-state">
            <strong>没有匹配的 session</strong>
            <span>请换个关键词，或继续加载更多已存在的 provider sessions。</span>
            {hasMore && (
              <button type="button" className="project-group-load-more" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? <Loader2 size={12} /> : null}<span>继续加载</span>
              </button>
            )}
          </div>
        )}
        {filteredGroups.map((group) => {
          const isCollapsed = isProjectSessionGroupCollapsed(group, collapsed, {
            autoCollapseEmptyProjects,
          });
          const hasSessions = group.sessions.length > 0;
          const isUnsupported = !group.isVirtual && !group.sessionsSupported;
          const visibleCount = projectSessionVisibleCount(group.id, visibleCounts);
          const visibleSessions = visibleProjectSessions(group.sessions, visibleCount);
          const moreState = projectSessionMoreState(group.sessions.length, visibleCount);
          const canLoadFromCursor = hasMore && group.sessions.length >= PROJECT_SESSION_PAGE_SIZE;
          const showLoadMore = moreState.canRevealLoaded || canLoadFromCursor;

          return (
            <div
              key={group.id}
              className={`project-group-container ${dragOverProjectId === group.id ? 'drag-over' : ''}`}
              draggable={!group.isVirtual && !savingOrder}
              onDragStart={(event) => handleDragStart(event, group)}
              onDragOver={(event) => handleDragOver(event, group)}
              onDragEnd={resetDragState}
              onDrop={(event) => handleDrop(event, group)}
            >
              <button
                className="project-group-header"
                onClick={() => toggleCollapse(group, isCollapsed)}
                aria-label={`${group.name} project sessions`}
              >
                <span className="project-group-chevron">
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <span className="project-group-icon">
                  {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
                </span>
                <span className="project-group-name" title={group.cwd}>{group.name}</span>
                {savingOrder && dragProjectId === group.id && <Loader2 className="project-order-saving" size={13} />}
              </button>

              {!isCollapsed && (
                <div className="project-group-sessions animate-slide-down">
                  {isUnsupported ? (
                    <div className="project-group-empty unsupported">Provider 不支持 Sessions</div>
                  ) : hasSessions ? (
                    visibleSessions.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        active={selectedId === session.id}
                        onSelect={onSelect}
                      />
                    ))
                  ) : (
                    <div className="project-group-empty">暂无对话</div>
                  )}
                  {hasSessions && showLoadMore && (
                    <button
                      type="button"
                      className="project-group-load-more"
                      onClick={() => handleProjectLoadMore(group)}
                      disabled={loadingMore && !moreState.canRevealLoaded}
                    >
                      {loadingMore && !moreState.canRevealLoaded ? <Loader2 size={12} /> : null}
                      <span>{moreState.canRevealLoaded ? `更多 ${Math.min(moreState.hiddenLoadedCount, PROJECT_SESSION_PAGE_SIZE)} 个` : '继续加载'}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {loadingMore && <div className="session-list-loading">继续加载 provider sessions...</div>}
    </div>
  );
}
