import {
  CalendarClock,
  BriefcaseBusiness,
  ChevronLeft,
  Layers,
  MessageSquare,
  Moon,
  Settings,
  Sun,
  LayoutDashboard,
} from 'lucide-react';
import BrandMark from './BrandMark';
import { useDynamicFavicon } from './brandFavicon.js';
import { useRunnerBrandState } from './useRunnerBrandState.js';
import {
  selectBackendConnectionState,
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
import { useI18n } from '../i18n/context.js';
import './AppSidebar.css';

const NAV_ICONS = {
  'command-center': LayoutDashboard,
  'ask-xuanwu': MessageSquare,
  work: BriefcaseBusiness,
  runs: Layers,
  automations: CalendarClock,
  settings: Settings,
};

const NAV_TRANSLATION_KEYS = {
  'command-center': 'nav.commandCenter',
  'ask-xuanwu': 'nav.askXuanwu',
  work: 'nav.work',
  runs: 'nav.runs',
  automations: 'nav.automations',
  settings: 'nav.settings',
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
  const { t } = useI18n();
  const brandState = useRunnerBrandState();
  const activeNavPage = productNavPageForRoute(currentPage);
  const navItems = productNavigationItems({ workBoardEnabled: WORK_BOARD_ENABLED });
  const primaryNavItems = navItems.filter(item => item.placement === 'primary');
  const footerNavItems = navItems.filter(item => item.placement === 'footer');
  const navLabel = (item) => t(NAV_TRANSLATION_KEYS[item.page] || item.label);
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
          title={t('sidebar.collapse')}
        >
          <ChevronLeft size={16} />
        </button>
      </div>


      <div className="sidebar-nav-group">
        {primaryNavItems.map((item) => (
          <button
            aria-label={navLabel(item)}
            className={`nav-item ${activeNavPage === item.page ? 'active' : ''}`}
            key={item.page}
            onClick={() => navigateTo(item.page)}
          >
            <NavIconLabel Icon={NAV_ICONS[item.icon]} label={navLabel(item)} />
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

      {(currentPage === 'runs' || currentPage === 'ask-xuanwu') && (
        <div id="sessions-app-sidebar-slot" className="sessions-app-sidebar-slot" />
      )}

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          {footerNavItems.map((item) => (
            <button
              aria-label={navLabel(item)}
              className={`nav-item nav-item-secondary ${activeNavPage === item.page ? 'active' : ''}`}
              key={item.page}
              onClick={() => navigateTo(item.page)}
              type="button"
            >
              <FooterIcon Icon={NAV_ICONS[item.icon]} />
            </button>
          ))}
          <button
            aria-label={theme === 'dark' ? t('sidebar.lightTheme') : t('sidebar.darkTheme')}
            className="nav-item nav-item-secondary sidebar-theme-row"
            onClick={toggleTheme}
            type="button"
          >
            <FooterIcon Icon={theme === 'dark' ? Sun : Moon} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function FooterIcon({ Icon }) {
  return <Icon aria-hidden="true" size={17} />;
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
  const connectionState = useDataStore(selectBackendConnectionState);
  const label = connectionState === 'reconnecting' ? 'RECONNECTING' : connectionState.toUpperCase();

  return (
    <span className={`api-status ${connectionState}`}>
      <span className="api-status-dot" />
      {label}
    </span>
  );
}

function ProductNavBadge({ active, page }) {
  if (page === 'automations') return <AutomationCountBadge active={active} />;
  return null;
}

function AutomationCountBadge({ active }) {
  const automations = useDataStore(selectAutomations);
  const activeCount = automations.filter(item => item.status === 'active').length;
  const label = activeCount > 0 ? activeCount : automations.length;

  return (
    <span className={`nav-badge${active ? ' is-active' : ''}`}>
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
        <span className="sidebar-new-issue-shortcut">c</span>
      </button>

      <div className="sidebar-loop-progress">
        <div className="sidebar-loop-progress__label">
          <span>LOOP AUTO</span>
          <span>{activeLoops} / {totalProjects}</span>
        </div>
        <div className="sidebar-progress">
          <div className="sidebar-progress-fill" style={{ width: `${totalProjects > 0 ? (activeLoops / totalProjects) * 100 : 0}%` }}></div>
        </div>
      </div>

      <div className="sidebar-section-title">Focus</div>
      <div className="sidebar-focus-list">
        <button className={`sub-filter-item ${focusFilter === 'all' ? 'active' : ''}`} onClick={() => setFocusFilter('all')}>
          <span>All columns</span>
          <span>{allCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'triage' ? 'active' : ''}`} onClick={() => setFocusFilter('triage')}>
          <span><span className="sub-filter-dot is-triage"></span>Just Triage</span>
          <span>{triageCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'active' ? 'active' : ''}`} onClick={() => setFocusFilter('active')}>
          <span><span className="sub-filter-dot is-active"></span>Active only</span>
          <span>{activeCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'failed' ? 'active' : ''}`} onClick={() => setFocusFilter('failed')}>
          <span><span className="sub-filter-dot is-failed"></span>Failed</span>
          <span>{failedCount}</span>
        </button>

        <button className={`sub-filter-item ${focusFilter === 'archive' ? 'active' : ''}`} onClick={() => setFocusFilter('archive')}>
          <span><span className="sub-filter-dot is-archive"></span>Archive</span>
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
              <span><span className="sub-filter-dot is-project"></span>{proj.name}</span>
              <span>{count}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
