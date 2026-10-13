export const SETTINGS_PRIMARY_TABS = Object.freeze([
  { id: 'general', label: 'Projects' },
  { id: 'ai', label: 'AI connections' },
  { id: 'connections', label: 'Notifications & connections' },
  { id: 'preferences', label: 'General' },
  { id: 'advanced', label: 'Advanced' },
]);
export const SETTINGS_ADVANCED_TABS = Object.freeze([
  { id: 'diagnostics', label: 'Maintenance' },
  { id: 'permissions', label: 'Security & permissions' },
  { id: 'skills', label: 'Skills & tools' },
  { id: 'memory', label: 'Memory' },
  { id: 'presets', label: 'Presets' },
  { id: 'activity', label: 'Processing history' },
]);
export const SETTINGS_NAVIGATION_GROUPS = Object.freeze([
  { id: 'settings', label: { 'zh-CN': '设置目录', 'en-US': 'Settings' }, tabs: SETTINGS_PRIMARY_TABS.map(tab => tab.id) },
]);
const COPY = {
  general: ['项目', 'Projects', '管理项目与执行默认值', 'Manage projects and execution defaults'],
  ai: ['AI 连接', 'AI connections', '编程工具负责写代码，玄武助手负责理解、验收和对话。助手未连接时任务能执行，但无法自动验收。', 'Coding tools execute tasks; the assistant understands, checks, and discusses results. Tasks can execute without the assistant, but cannot be accepted automatically.'],
  connections: ['通知与外部连接', 'Notifications & connections', '选择消息频率并管理外部平台', 'Choose notification frequency and manage platforms'],
  preferences: ['通用', 'General', '语言、主题、表达风格与版本', 'Language, theme, reply style, and version'],
  advanced: ['高级', 'Advanced', '需要时展开相应配置，已打开的草稿会保留', 'Open a section when needed; drafts remain when collapsed'],
  diagnostics: ['运行维护', 'Maintenance', '健康摘要、诊断与服务管理', 'Health, diagnostics, and service management'],
  permissions: ['安全与权限', 'Security & permissions', '授权、来源策略与生效规则', 'Permissions, source policies, and active rules'],
  skills: ['技能与工具', 'Skills & tools', '技能库、运行记录与 MCP', 'Skills, history, and MCP'],
  memory: ['记忆', 'Memory', '查看与维护记住的信息', 'Review remembered information'],
  presets: ['执行预设', 'Presets', '创建与编辑执行预设', 'Create and edit execution presets'],
  activity: ['处理记录', 'Processing history', '追溯消息和操作', 'Trace messages and actions'],
};
export function settingsSectionCopy(tab, language = 'zh-CN') {
  const copy = COPY[tab] || COPY.general;
  const english = language === 'en-US';
  const hints = { ai: ['编程工具与玄武助手', 'Coding tools and assistant'], advanced: ['按需配置与排查', 'Configure and troubleshoot'] };
  return { title: copy[english ? 1 : 0], hint: hints[tab]?.[english ? 1 : 0] || copy[english ? 3 : 2], description: copy[english ? 3 : 2] };
}
const PRIMARY = new Set(SETTINGS_PRIMARY_TABS.map(tab => tab.id));
const ADVANCED = new Set(SETTINGS_ADVANCED_TABS.map(tab => tab.id));
const LEGACY = {
  supervisor: ['ai', 'supervisor'], 'code-agents': ['ai', 'code-agents'],
  notifications: ['connections', 'notifications'], integrations: ['connections', 'integrations'],
  policies: ['advanced', 'permissions'],
};
export function resolveSettingsRoute(value = 'general') {
  const bare = String(value || '').trim().replace(/^advanced:/, '');
  if (ADVANCED.has(bare)) return { tier: 'advanced', tab: 'advanced', section: bare };
  if (LEGACY[bare]) {
    const [tab, section] = LEGACY[bare];
    return { tier: tab === 'advanced' ? 'advanced' : 'primary', tab, section };
  }
  if (PRIMARY.has(bare)) return { tier: bare === 'advanced' ? 'advanced' : 'primary', tab: bare };
  return { tier: 'primary', tab: 'general' };
}
export function settingsRouteId(route) {
  if (route?.tab === 'advanced' && ADVANCED.has(route.section)) return `advanced:${route.section}`;
  if (route?.section && LEGACY[route.section]) return route.section;
  return PRIMARY.has(route?.tab) ? route.tab : 'general';
}
