import { PRODUCT_NAV_LABELS } from '../brand.js';

export const PRODUCT_NAV_ITEMS = Object.freeze([
  {
    page: 'inbox',
    label: PRODUCT_NAV_LABELS.commandCenter,
    icon: 'command-center',
    placement: 'primary',
    availability: 'compatibility',
  },
  {
    page: 'tasks',
    label: PRODUCT_NAV_LABELS.work,
    icon: 'work',
    placement: 'primary',
    availability: 'compatibility',
    featureFlag: 'workBoard',
  },
  {
    page: 'runs',
    label: PRODUCT_NAV_LABELS.runs,
    icon: 'runs',
    placement: 'primary',
    availability: 'compatibility',
  },
  {
    page: 'automations',
    label: PRODUCT_NAV_LABELS.automations,
    icon: 'automations',
    placement: 'subview',
    parent: 'tasks',
    availability: 'compatibility',
  },
  {
    page: 'ask-xuanwu',
    label: PRODUCT_NAV_LABELS.askXuanwu,
    icon: 'ask-xuanwu',
    placement: 'primary',
    availability: 'compatibility',
  },
  {
    page: 'analytics',
    label: PRODUCT_NAV_LABELS.analytics,
    icon: 'analytics',
    placement: 'footer',
    availability: 'available',
  },
  {
    page: 'settings',
    label: PRODUCT_NAV_LABELS.settings,
    icon: 'settings',
    placement: 'footer',
    availability: 'available',
  },
]);

export const PRODUCT_ROUTE_ALIASES = Object.freeze({
  'command-center': 'inbox',
  work: 'tasks',
});

export const PRODUCT_COMPAT_ROUTE_REDIRECTS = Object.freeze({
  ...PRODUCT_ROUTE_ALIASES,
  dashboard: 'inbox',
  'pi-chat': 'ask-xuanwu',
  issues: 'tasks',
  sessions: 'runs',
  cron: 'automations',
  'pi-automations': 'automations',
  'pi-approvals': 'inbox',
  'attention-inbox': 'inbox',
  'pi-inbox': 'inbox',
  projects: 'settings',
});

export function productNavigationItems({ workBoardEnabled = true } = {}) {
  return PRODUCT_NAV_ITEMS.filter(item => item.featureFlag !== 'workBoard' || workBoardEnabled);
}

export function resolveProductPage(page, { workBoardEnabled = true } = {}) {
  const resolvedPage = PRODUCT_COMPAT_ROUTE_REDIRECTS[page] || page;
  if (resolvedPage === 'tasks' && !workBoardEnabled) return 'issues';
  return resolvedPage;
}

export function productNavPageForRoute(page) {
  const resolvedPage = PRODUCT_COMPAT_ROUTE_REDIRECTS[page] || page;
  if (isAssistantModulePage(resolvedPage)) return 'settings';
  // 子视图（如自动化）在侧栏中高亮所属的一级页面。
  return PRODUCT_NAV_ITEMS.find(item => item.page === resolvedPage && item.placement === 'subview')?.parent || resolvedPage;
}

export const PI_ASSISTANT_CONFIG_MODULES = [
  {
    page: 'pi-skills',
    tab: 'skills',
    label: 'Skills',
    title: 'Skills',
    description: '查看 intake/domain skill、依赖工具、schema 与运行历史。'
  },
  {
    page: 'pi-memory',
    tab: 'memory',
    label: 'Memory',
    title: 'Memory',
    description: '查看、编辑、禁用或忘记玄武助手自动维护的可复用记忆。'
  },
  {
    page: 'pi-activity',
    tab: 'activity',
    label: 'Activity',
    title: 'Activity',
    description: '查看 raw event、intake run、skill run、proposal 与 tool call 的审计时间线。'
  },
  {
    page: 'pi-policies',
    tab: 'policies',
    label: 'Policies',
    title: 'Policies',
    description: '管理项目级重试、并发与验证门禁；自动接管由项目绑定统一启用。'
  }
];

export const PI_ASSISTANT_MODULES = [
  ...PI_ASSISTANT_CONFIG_MODULES,
];

export function assistantModuleForPage(page) {
  return PI_ASSISTANT_MODULES.find((module) => module.page === page) || null;
}

export function isAssistantModulePage(page) {
  const module = assistantModuleForPage(page);
  return Boolean(module?.tab);
}
