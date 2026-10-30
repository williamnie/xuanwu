import { useCallback, useEffect, useState } from 'react';
import { selectProjects, selectWorkSummary, useDataStore } from '../store/dataStore';
import WorkKanban from './work/WorkKanban.jsx';
import WorkDetail from './WorkDetail.jsx';
import TaskList from './work/TaskList.jsx';
import TaskSubviewTabs from './work/TaskSubviewTabs.jsx';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import WorkBoardHeader from './work/WorkBoardHeader.jsx';
import './WorkBoard.css';

const TASK_VIEW_STORAGE_KEY = 'xuanwu-task-view';

// 任务页：默认列表视图，看板保留为可切换视图；两者共享搜索、项目筛选和同一套创建/编辑对话框。
export default function WorkBoard({ filterProject: projectId = '', onProjectChange, onSourceChange, onScopeChange, navigateTo, onPageContextChange, selectedHandoffId = '', selectedRunId = '', selectedWorkId = '', taskScope = '', taskSource = '' }) {
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const [view, setView] = useState(readTaskView);
  const [scope, setScope] = useState(taskScope || 'active');
  useEffect(() => { setScope(taskScope || 'active'); }, [taskScope]);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken(value => value + 1), []);

  useEffect(() => {
    if (selectedWorkId) return;
    onPageContextChange?.({ page_id: 'tasks', project_id: projectId });
  }, [onPageContextChange, projectId, selectedWorkId]);

  const changeView = (next) => {
    setView(next);
    try { localStorage.setItem(TASK_VIEW_STORAGE_KEY, next); } catch { /* 仅为个人偏好，存储不可用时忽略。 */ }
  };

  if (selectedWorkId) {
    return (
      <WorkDetail
        navigateTo={navigateTo}
        onPageContextChange={onPageContextChange}
        onWorkChanged={refresh}
        projects={projects}
        selectedHandoffId={selectedHandoffId}
        selectedRunId={selectedRunId}
        workId={selectedWorkId}
      />
    );
  }

  const counts = projectId
    ? workSummary.project_counts?.find(item => item.project_id === projectId)?.counts || {}
    : workSummary.counts || {};

  return (
    <section className={`work-board-page bg-grid-tech is-${view}`}>
      <TaskSubviewTabs active="tasks" navigateTo={navigateTo} />
      <WorkBoardHeader
        onCreate={() => setDialog({ mode: 'create' })}
        onProjectChange={onProjectChange}
        onSourceChange={onSourceChange}
        onQueryChange={setQuery}
        onRefresh={refresh}
        onViewChange={changeView}
        projectId={projectId}
        projects={projects}
        query={query}
        view={view}
        source={taskSource}
      />
      {view === 'list' ? (
        <div className="work-list-scroll">
          <TaskList
            key={`${projectId}:${taskSource}:${scope}:${query}`}
            counts={taskSource ? {} : counts}
            navigateTo={navigateTo}
            onCreate={() => setDialog({ mode: 'create' })}
            onEdit={work => setDialog({ mode: 'edit', work })}
            onScopeChange={value => { setScope(value); onScopeChange?.(value); }}
            projectId={projectId}
            projects={projects}
            query={query}
            refreshToken={refreshToken}
            scope={scope}
            source={taskSource}
          />
        </div>
      ) : (
        <WorkKanban
          key={`${projectId}:${taskSource}:${query}`}
          navigateTo={navigateTo}
          onEdit={work => setDialog({ mode: 'edit', work })}
          projectId={projectId}
          query={query}
          refreshToken={refreshToken}
          source={taskSource}
        />
      )}
      {dialog ? (
        <WorkEditorDialog
          initialProject={dialog.mode === 'create' ? projectId : undefined}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
          projects={projects}
          work={dialog.work}
        />
      ) : null}
    </section>
  );
}

function readTaskView() {
  try {
    return localStorage.getItem(TASK_VIEW_STORAGE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}
