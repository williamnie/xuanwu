import {
  ChartNoAxesCombined,
  CalendarClock,
  BriefcaseBusiness,
  ChevronLeft,
  Layers,
  MessageSquare,
  Moon,
  Settings,
  Sun,
  LayoutDashboard,
  X,
} from 'lucide-react';
import BrandMark from './BrandMark';
import { useDynamicFavicon } from './brandFavicon.js';
import { useRunnerBrandState } from './useRunnerBrandState.js';
import {
  selectBackendConnectionState,
  selectAutomations,
  useDataStore,
} from '../store/dataStore';
import { PRODUCT_NAV_ITEMS, productNavPageForRoute } from '../pages/assistantModules';
import { useI18n } from '../i18n/context.js';
import './AppSidebar.css';

const NAV_ICONS = {
  'command-center': LayoutDashboard,
  'ask-xuanwu': MessageSquare,
  work: BriefcaseBusiness,
  runs: Layers,
  automations: CalendarClock,
  analytics: ChartNoAxesCombined,
  settings: Settings,
};

const NAV_TRANSLATION_KEYS = {
  'inbox': 'nav.commandCenter',
  'ask-xuanwu': 'nav.askXuanwu',
  tasks: 'nav.work',
  runs: 'nav.runs',
  automations: 'nav.automations',
  analytics: 'nav.analytics',
  settings: 'nav.settings',
};

const NAV_CODE_PREFIX = {
  'inbox': '01',
  tasks: '02',
  runs: '03',
  'ask-xuanwu': '04',
  analytics: '05',
  automations: '06',
};

export default function AppSidebar({
  currentPage,
  navigateTo,
  theme,
  toggleTheme,
  toggleSidebar,
  isMobileViewport,
  mobileSidebarOpen,
  onMobileClose,
  sidebarRef,
}) {
  const { t } = useI18n();
  const brandState = useRunnerBrandState();
  const activeNavPage = productNavPageForRoute(currentPage);
  const primaryNavItems = PRODUCT_NAV_ITEMS.filter(item => item.placement === 'primary');
  const footerNavItems = PRODUCT_NAV_ITEMS.filter(item => item.placement === 'footer');
  const navLabel = (item) => t(NAV_TRANSLATION_KEYS[item.page] || item.label);
  const closeMobileDrawer = () => {
    if (isMobileViewport) onMobileClose?.();
  };
  useDynamicFavicon(brandState);

  return (
    <aside
      aria-label={t('sidebar.navigation')}
      aria-modal={isMobileViewport && mobileSidebarOpen ? true : undefined}
      className="sidebar"
      id="app-sidebar"
      inert={isMobileViewport && !mobileSidebarOpen ? true : undefined}
      ref={sidebarRef}
      role={isMobileViewport ? 'dialog' : undefined}
    >
      <div className="sidebar-brand-row">
        <div className="sidebar-brand-main">
          <BrandMark className="sidebar-brand" state={brandState} />
          <ApiStatus />
        </div>
        <button
          aria-label={isMobileViewport ? t('sidebar.close') : t('sidebar.collapse')}
          className="sidebar-collapse-btn"
          onClick={isMobileViewport ? onMobileClose : toggleSidebar}
          title={isMobileViewport ? t('sidebar.close') : t('sidebar.collapse')}
          type="button"
        >
          {isMobileViewport ? <X size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>


      <div className="sidebar-nav-group">
        {primaryNavItems.map((item) => (
          <button
            aria-label={navLabel(item)}
            className={`nav-item ${activeNavPage === item.page ? 'active' : ''}`}
            key={item.page}
            onClick={() => {
              navigateTo(item.page);
              closeMobileDrawer();
            }}
          >
            <NavIconLabel Icon={NAV_ICONS[item.icon]} label={navLabel(item)} code={NAV_CODE_PREFIX[item.page]} />
            <ProductNavBadge active={activeNavPage === item.page} page={item.page} />
          </button>
        ))}
      </div>

      {(currentPage === 'runs' || currentPage === 'ask-xuanwu') && (
        <div id="sessions-app-sidebar-slot" className="sessions-app-sidebar-slot" />
      )}

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          {footerNavItems.map((item) => (
            <button
              aria-label={navLabel(item)}
              className={`nav-item nav-item-secondary nav-item-${item.page} ${activeNavPage === item.page ? 'active' : ''}`}
              key={item.page}
              onClick={() => {
                navigateTo(item.page);
                closeMobileDrawer();
              }}
              type="button"
            >
              <FooterIcon Icon={NAV_ICONS[item.icon]} /><span className="sidebar-footer-label">{navLabel(item)}</span>
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
  return <Icon aria-hidden="true" size={14} />;
}

function NavIconLabel({ Icon, label, code }) {
  return (
    <span className="nav-item-main">
      {code ? <span className="nav-item-code">{code}</span> : null}
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
      <span className="api-status-tag">[{label}]</span>
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
  const rawCount = activeCount > 0 ? activeCount : automations.length;
  const label = `[${String(rawCount).padStart(2, '0')}]`;

  return (
    <span className={`nav-badge${active ? ' is-active' : ''}`}>
      {label}
    </span>
  );
}
