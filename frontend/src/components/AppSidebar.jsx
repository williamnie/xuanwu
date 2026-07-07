import {
  CalendarClock,
  ChevronLeft,
  FolderGit2,
  Inbox,
  Layers,
  ListTodo,
  Moon,
  Settings,
  Sun,
  LayoutDashboard,
} from 'lucide-react';
import BrandMark from './BrandMark';
import { useDynamicFavicon } from './brandFavicon.js';
import { useRunnerBrandState } from './useRunnerBrandState.js';
import { APP_VERSION } from '../version';
import {
  selectBackendOnline,
  selectCronTasks,
  selectIssues,
  selectProjects,
  useDataStore,
} from '../store/dataStore';
import {
  isAssistantModulePage,
  PI_ASSISTANT_NAV_ITEMS,
  PI_ASSISTANT_SETTINGS_ITEM,
} from '../pages/assistantModules';

const ASSISTANT_ICONS = {
  Inbox,
};

export default function AppSidebar({
  currentPage,
  filterProject,
  focusFilter,
  handleOpenNewIssue,
  navigateTo,
  setFilterProject,
  setFocusFilter,
  theme,
  toggleTheme,
  toggleSidebar,
}) {
  const brandState = useRunnerBrandState();
  const settingsActive = currentPage === PI_ASSISTANT_SETTINGS_ITEM.page || isAssistantModulePage(currentPage);
  useDynamicFavicon(brandState);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <div className="sidebar-brand-main">
          <BrandMark className="sidebar-brand" state={brandState} />
          <ApiStatus />
        </div>
        <button
          className="sidebar-collapse-btn"
          onClick={toggleSidebar}
          title="收起菜单"
        >
          <ChevronLeft size={16} />
        </button>
      </div>


      <div className="sidebar-nav-group">
        <button className={`nav-item ${currentPage === 'dashboard' ? 'active' : ''}`} onClick={() => navigateTo('dashboard')}>
          <NavIconLabel Icon={LayoutDashboard} label="Dashboard" />
        </button>

        <button className={`nav-item ${currentPage === 'sessions' ? 'active' : ''}`} onClick={() => navigateTo('sessions')}>
          <NavIconLabel Icon={Layers} label="Sessions" />
        </button>

        <button className={`nav-item ${currentPage === 'issues' ? 'active' : ''}`} onClick={() => navigateTo('issues')}>
          <NavIconLabel Icon={ListTodo} label="Issues" />
          <IssueCountBadge active={currentPage === 'issues'} />
        </button>

        <button className={`nav-item ${currentPage === 'cron' ? 'active' : ''}`} onClick={() => navigateTo('cron')}>
          <NavIconLabel Icon={CalendarClock} label="Cron" />
          <CronCountBadge active={currentPage === 'cron'} />
        </button>

        <button className={`nav-item ${currentPage === 'projects' ? 'active' : ''}`} onClick={() => navigateTo('projects')}>
          <NavIconLabel Icon={FolderGit2} label="Projects" />
          <ProjectCountBadge active={currentPage === 'projects'} />
        </button>
      </div>

      <div className="sidebar-section-title">PI Assistant</div>
      <div className="sidebar-nav-group pi-assistant-nav">
        {PI_ASSISTANT_NAV_ITEMS.map((module) => (
          <button
            className={`nav-item pi-assistant-item ${currentPage === module.page ? 'active' : ''}`}
            key={module.page}
            onClick={() => navigateTo(module.page)}
          >
            <NavIconLabel Icon={ASSISTANT_ICONS[module.label]} label={module.label} />
          </button>
        ))}
      </div>

      {currentPage === 'issues' && (
        <IssuesSidebarFilters
          filterProject={filterProject}
          focusFilter={focusFilter}
          handleOpenNewIssue={handleOpenNewIssue}
          setFilterProject={setFilterProject}
          setFocusFilter={setFocusFilter}
        />
      )}

      {currentPage === 'sessions' && (
        <div id="sessions-app-sidebar-slot" className="sessions-app-sidebar-slot" />
      )}

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <button
            className={`nav-item nav-item-secondary ${settingsActive ? 'active' : ''}`}
            onClick={() => navigateTo(PI_ASSISTANT_SETTINGS_ITEM.page)}
            type="button"
          >
            <NavIconLabel Icon={Settings} label={PI_ASSISTANT_SETTINGS_ITEM.label} />
          </button>
          <button
            className="nav-item nav-item-secondary sidebar-theme-row"
            onClick={toggleTheme}
            type="button"
          >
            <NavIconLabel Icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Light theme' : 'Dark theme'} />
          </button>
        </div>
        <div className="sidebar-version">{APP_VERSION}</div>
      </div>
    </aside>
  );
}

function NavIconLabel({ Icon, label }) {
  return (
    <span className="nav-item-main">
      <Icon size={16} />
      <span className="nav-label">{label}</span>
    </span>
  );
}

function ApiStatus() {
  const backendOnline = useDataStore(selectBackendOnline);

  return (
    <span className={`api-status ${backendOnline ? '' : 'offline'}`}>
      <span className="api-status-dot" />
      {backendOnline ? 'LOCAL API • ONLINE' : 'LOCAL API • OFFLINE'}
    </span>
  );
}

function IssueCountBadge({ active }) {
  const issues = useDataStore(selectIssues);

  return (
    <span className="nav-badge" style={{ background: active ? 'var(--primary-glow)' : undefined, color: active ? 'var(--primary)' : undefined }}>
      {issues.length}
    </span>
  );
}

function ProjectCountBadge({ active }) {
  const projects = useDataStore(selectProjects);

  return (
    <span className="nav-badge" style={{ background: active ? 'var(--primary-glow)' : undefined, color: active ? 'var(--primary)' : undefined }}>
      {projects.length}
    </span>
  );
}

function CronCountBadge({ active }) {
  const cronTasks = useDataStore(selectCronTasks);
  const activeCount = cronTasks.filter(task => task.status === 'active').length;
  const label = activeCount > 0 ? activeCount : cronTasks.length;

  return (
    <span className="nav-badge" style={{ background: active ? 'var(--primary-glow)' : undefined, color: active ? 'var(--primary)' : undefined }}>
      {label}
    </span>
  );
}

function IssuesSidebarFilters({
  filterProject,
  focusFilter,
  handleOpenNewIssue,
  setFilterProject,
  setFocusFilter,
}) {
  const projects = useDataStore(selectProjects);
  const issues = useDataStore(selectIssues);
  const filteredIssuesList = issues.filter(i => !filterProject || i.project_id === filterProject);
  const triageCount = filteredIssuesList.filter(i => i.status === 'triage').length;
  const activeCount = filteredIssuesList.filter(i => i.status === 'todo' || i.status === 'in_progress').length;
  const failedCount = filteredIssuesList.filter(i => i.status === 'failed').length;
  const archiveCount = filteredIssuesList.filter(i => i.status === 'done' || i.status === 'cancelled').length;
  const allCount = filteredIssuesList.length;
  const activeLoops = projects.filter(p => p.loop_status === 'running' || p.auto_run === 1).length;
  const totalProjects = projects.length;

  return (
    <>
      <div className="sidebar-section-title">
        <span>— Issues • {issues.length}</span>
      </div>

      <button className="btn-new-issue-sidebar" onClick={() => handleOpenNewIssue('todo')}>
        <span>+ New issue</span>
        <span style={{ fontSize: '0.65rem', border: '1px solid rgba(16,185,129,0.3)', padding: '1px 4px', borderRadius: '3px', background: 'rgba(16,185,129,0.06)' }}>c</span>
      </button>

      <div style={{ padding: '12px 12px 4px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>
          <span>LOOP AUTO</span>
          <span>{activeLoops} / {totalProjects}</span>
        </div>
        <div className="sidebar-progress">
          <div className="sidebar-progress-fill" style={{ width: `${totalProjects > 0 ? (activeLoops / totalProjects) * 100 : 0}%` }}></div>
        </div>
      </div>

      <div className="sidebar-section-title">Focus</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <button className={`sub-filter-item ${focusFilter === 'all' ? 'active' : ''}`} onClick={() => setFocusFilter('all')}>
          <span>All columns</span>
          <span>{allCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'triage' ? 'active' : ''}`} onClick={() => setFocusFilter('triage')}>
          <span><span className="sub-filter-dot" style={{ background: '#f59e0b' }}></span>Just Triage</span>
          <span>{triageCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'active' ? 'active' : ''}`} onClick={() => setFocusFilter('active')}>
          <span><span className="sub-filter-dot" style={{ background: '#3b82f6' }}></span>Active only</span>
          <span>{activeCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'failed' ? 'active' : ''}`} onClick={() => setFocusFilter('failed')}>
          <span><span className="sub-filter-dot" style={{ background: '#ef4444' }}></span>Failed</span>
          <span>{failedCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'archive' ? 'active' : ''}`} onClick={() => setFocusFilter('archive')}>
          <span><span className="sub-filter-dot" style={{ background: '#10b981' }}></span>Archive</span>
          <span>{archiveCount}</span>
        </button>
      </div>

      <div className="sidebar-section-title">Project</div>
      <div className="sidebar-project-list">
        <button className={`sub-filter-item ${filterProject === '' ? 'active' : ''}`} onClick={() => setFilterProject('')}>
          <span>All projects</span>
          <span>{issues.length}</span>
        </button>

        {projects.map(proj => {
          const count = issues.filter(i => i.project_id === proj.id).length;
          return (
            <button key={proj.id} className={`sub-filter-item ${filterProject === proj.id ? 'active' : ''}`} onClick={() => setFilterProject(proj.id)}>
              <span><span className="sub-filter-dot" style={{ background: 'var(--primary)' }}></span>{proj.name}</span>
              <span>{count}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
