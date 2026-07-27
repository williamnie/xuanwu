import {
  CalendarClock,
  BriefcaseBusiness,
  ChevronLeft,
  FolderGit2,
  Layers,
  MessageSquare,
  Moon,
  Plug,
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
  selectAutomations,
  selectIssues,
  selectProjects,
  useDataStore,
} from '../store/dataStore';
import {
  productNavigationItems,
  productNavPageForRoute,
} from '../pages/assistantModules';
import { WORK_BOARD_ENABLED } from '../pages/workBoardModel.js';

const NAV_ICONS = {
  'command-center': LayoutDashboard,
  'ask-xuanwu': MessageSquare,
  work: BriefcaseBusiness,
  runs: Layers,
  automations: CalendarClock,
  projects: FolderGit2,
  connections: Plug,
  settings: Settings,
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
  const activeNavPage = productNavPageForRoute(currentPage);
  const navItems = productNavigationItems({ workBoardEnabled: WORK_BOARD_ENABLED });
  const primaryNavItems = navItems.filter(item => item.placement === 'primary');
  const footerNavItems = navItems.filter(item => item.placement === 'footer');
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
        {primaryNavItems.map((item) => (
          <button
            aria-label={item.label}
            className={`nav-item ${activeNavPage === item.page ? 'active' : ''}`}
            key={item.page}
            onClick={() => navigateTo(item.page)}
          >
            <NavIconLabel Icon={NAV_ICONS[item.icon]} label={item.label} />
            <ProductNavBadge active={activeNavPage === item.page} page={item.page} />
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

      {currentPage === 'runs' && (
        <div id="sessions-app-sidebar-slot" className="sessions-app-sidebar-slot" />
      )}

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          {footerNavItems.map((item) => (
            <button
              aria-label={item.label}
              className={`nav-item nav-item-secondary ${activeNavPage === item.page ? 'active' : ''}`}
              key={item.page}
              onClick={() => navigateTo(item.page)}
              type="button"
            >
              <NavIconLabel Icon={NAV_ICONS[item.icon]} label={item.label} />
            </button>
          ))}
          <button
            aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
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
      {backendOnline ? 'ONLINE' : 'OFFLINE'}
    </span>
  );
}

function ProductNavBadge({ active, page }) {
  if (page === 'automations') return <AutomationCountBadge active={active} />;
  if (page === 'projects') return <ProjectCountBadge active={active} />;
  return null;
}

function ProjectCountBadge({ active }) {
  const projects = useDataStore(selectProjects);

  return (
    <span className="nav-badge" style={{ background: active ? 'var(--primary-glow)' : undefined, color: active ? 'var(--primary)' : undefined }}>
      {projects.length}
    </span>
  );
}

function AutomationCountBadge({ active }) {
  const automations = useDataStore(selectAutomations);
  const activeCount = automations.filter(item => item.status === 'active').length;
  const label = activeCount > 0 ? activeCount : automations.length;

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
