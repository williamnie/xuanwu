import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Folder, FolderOpen, ChevronDown, ChevronRight, Loader2, GripVertical } from 'lucide-react';

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

const SessionItem = memo(function SessionItem({ session, active, onSelect }) {
  const title = session.name || session.preview || 'Untitled Codex session';
  const relativeTime = formatRelativeTime(session.updatedAt || session.createdAt);
  const origin = sessionOriginMeta(session.origin);

  return (
    <button 
      className={`session-item-row ${active ? 'active' : ''}`} 
      onClick={() => onSelect(session.id)}
    >
      <span className="session-item-title" title={title}>{title}</span>
      <div className="session-item-right">
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
  onSelect,
  onLoadMore,
  onReorderProjects,
}) {
  const [collapsed, setCollapsed] = useState({});
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

  const toggleCollapse = (id) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
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
        {groups.map((group) => {
          const isCollapsed = collapsed[group.id];
          const hasSessions = group.sessions.length > 0;

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
                onClick={() => toggleCollapse(group.id)}
                aria-label={`${group.name} project sessions`}
              >
                {!group.isVirtual && (
                  <span className="project-group-drag-handle" title="拖动调整项目顺序">
                    <GripVertical size={13} />
                  </span>
                )}
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
                  {hasSessions ? (
                    group.sessions.map((session) => (
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
                </div>
              )}
            </div>
          );
        })}
      </div>
      {loadingMore && <div className="session-list-loading">继续加载 Codex sessions...</div>}
    </div>
  );
}
