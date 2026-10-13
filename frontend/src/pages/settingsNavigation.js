// 设置 5 个分区（方案 6.3）：项目 / AI 连接 / 通知与外部连接 / 通用 / 高级。
// “高级”是一个页面，内部按节折叠；节通过 advanced:<id> 深链展开。
export const SETTINGS_SECTIONS = Object.freeze([
  { id: 'general' },
  { id: 'ai' },
  { id: 'notifications' },
  { id: 'preferences' },
  { id: 'advanced' },
]);

export const SETTINGS_ADVANCED_SECTIONS = Object.freeze([
  { id: 'diagnostics' },
  { id: 'security' },
  { id: 'skills' },
  { id: 'memory' },
  { id: 'presets' },
  { id: 'activity' },
]);

// 旧 section 值（裸值与 advanced: 前缀两种写法）统一映射到新位置（方案 6.6）。
const LEGACY_SECTION_ROUTES = Object.freeze({
  supervisor: { tab: 'ai', section: '' },
  'code-agents': { tab: 'ai', section: '' },
  integrations: { tab: 'notifications', section: '' },
  permissions: { tab: 'advanced', section: 'security' },
  policies: { tab: 'advanced', section: 'security' },
  diagnostics: { tab: 'advanced', section: 'diagnostics' },
  skills: { tab: 'advanced', section: 'skills' },
  memory: { tab: 'advanced', section: 'memory' },
  presets: { tab: 'advanced', section: 'presets' },
  activity: { tab: 'advanced', section: 'activity' },
});

const SECTION_COPY = {
  'zh-CN': {
    general: { title: '项目', hint: '玄武工作的代码仓库', description: '添加或管理玄武工作的项目，以及每个项目默认使用的编程工具和权限。' },
    ai: { title: 'AI 连接', hint: '编程工具与玄武助手', description: '编程工具负责写代码；玄武助手负责理解任务、验收结果并和你对话。玄武助手未连接时，任务能执行，但无法自动验收。' },
    notifications: { title: '通知与外部连接', hint: '何时通知，连接哪些平台', description: '选择通知方式，并连接 GitHub、飞书、Telegram 等平台接收任务或发送通知。' },
    preferences: { title: '通用', hint: '语言、主题与版本', description: '界面语言、主题，以及版本与更新。' },
    advanced: { title: '高级', hint: '维护、权限、技能与记录', description: '日常使用通常不需要调整这里的内容。展开需要的部分即可。' },
  },
  'en-US': {
    general: { title: 'Projects', hint: 'Repositories Xuanwu works on', description: 'Manage the projects Xuanwu works on and the default coding tool and permissions for each.' },
    ai: { title: 'AI connections', hint: 'Coding tools and the assistant', description: 'Coding tools write code; the Xuanwu assistant understands tasks, verifies results and talks with you. Without the assistant, tasks still run but cannot be verified automatically.' },
    notifications: { title: 'Notifications & connections', hint: 'When to notify, which platforms', description: 'Choose how you are notified and connect GitHub, Feishu or Telegram to receive tasks or send notifications.' },
    preferences: { title: 'General', hint: 'Language, theme and version', description: 'Interface language, theme, and version updates.' },
    advanced: { title: 'Advanced', hint: 'Maintenance, permissions, skills', description: 'Everyday use rarely requires changes here. Expand only what you need.' },
  },
};

const ADVANCED_SECTION_COPY = {
  'zh-CN': {
    diagnostics: { title: '运行维护', hint: '服务状态、诊断包、并发与重启' },
    security: { title: '安全与权限', hint: '连接能力、操作审批与来源策略' },
    skills: { title: '技能与工具', hint: '技能库、MCP 服务器与技能运行记录' },
    memory: { title: '记忆', hint: '玄武记住的信息及其来源' },
    presets: { title: '执行预设', hint: '可复用的执行偏好与项目默认预设' },
    activity: { title: '处理记录', hint: '一条消息如何变成任务或动作' },
  },
  'en-US': {
    diagnostics: { title: 'Maintenance', hint: 'Service health, diagnostics, concurrency, restart' },
    security: { title: 'Security & permissions', hint: 'Connection capabilities, approvals and source policies' },
    skills: { title: 'Skills & tools', hint: 'Skill library, MCP servers and skill runs' },
    memory: { title: 'Memory', hint: 'What Xuanwu remembers and where it came from' },
    presets: { title: 'Execution presets', hint: 'Reusable execution preferences and project defaults' },
    activity: { title: 'Processing history', hint: 'How a message became a task or action' },
  },
};

export function settingsSectionCopy(tab, language = 'zh-CN') {
  const copy = SECTION_COPY[language] || SECTION_COPY['zh-CN'];
  return copy[tab] || copy.general;
}

export function advancedSectionCopy(section, language = 'zh-CN') {
  const copy = ADVANCED_SECTION_COPY[language] || ADVANCED_SECTION_COPY['zh-CN'];
  return copy[section] || copy.diagnostics;
}

const SECTION_IDS = new Set(SETTINGS_SECTIONS.map(item => item.id));
const ADVANCED_SECTION_IDS = new Set(SETTINGS_ADVANCED_SECTIONS.map(item => item.id));

export function resolveSettingsRoute(value = 'general') {
  const route = String(value || '').trim();
  if (SECTION_IDS.has(route)) return { tab: route, section: '' };
  if (LEGACY_SECTION_ROUTES[route]) return { ...LEGACY_SECTION_ROUTES[route] };
  if (route.startsWith('advanced:')) {
    const section = route.slice('advanced:'.length);
    if (ADVANCED_SECTION_IDS.has(section)) return { tab: 'advanced', section };
    if (LEGACY_SECTION_ROUTES[section]?.tab === 'advanced') return { ...LEGACY_SECTION_ROUTES[section] };
  }
  return { tab: 'general', section: '' };
}

export function settingsRouteId(route) {
  if (route?.tab === 'advanced' && ADVANCED_SECTION_IDS.has(route.section)) return `advanced:${route.section}`;
  return SECTION_IDS.has(route?.tab) ? route.tab : 'general';
}
