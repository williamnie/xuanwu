export const SETTINGS_PRIMARY_TABS = Object.freeze([
  { id: 'general', label: 'Projects' },
  { id: 'supervisor', label: 'Xuanwu Supervisor' },
  { id: 'code-agents', label: 'Code Agents' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'notifications', label: 'Notifications' },
]);

export const SETTINGS_ADVANCED_TABS = Object.freeze([
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'activity', label: 'Activity' },
  { id: 'policies', label: 'Policies' },
]);

export const SETTINGS_NAVIGATION_GROUPS = Object.freeze([
  { id: 'everyday', label: { 'zh-CN': '常用设置', 'en-US': 'Everyday' }, tabs: ['general', 'notifications', 'permissions'] },
  { id: 'assistant', label: { 'zh-CN': '助手与连接', 'en-US': 'Assistant & connections' }, tabs: ['supervisor', 'code-agents', 'integrations'] },
  { id: 'advanced', label: { 'zh-CN': '高级设置', 'en-US': 'Advanced' }, tabs: ['diagnostics', 'skills', 'memory', 'activity', 'policies'] },
]);

const SECTION_COPY = {
  'zh-CN': {
    general: { title: '项目与偏好', hint: '管理项目、界面语言', description: '添加或管理玄武工作的项目，选择你熟悉的界面语言。' },
    notifications: { title: '消息通知', hint: '决定何时、向哪里通知', description: '选择通知渠道和提醒频率，让需要你处理的消息及时送达。' },
    permissions: { title: '执行权限', hint: '查看可执行的操作', description: '查看哪些操作允许执行、哪些需要审批，以及外部连接当前授予的权限。' },
    supervisor: { title: '玄武助手', hint: '连接模型、设置工作方式', description: '为玄武助手连接 AI 模型，设置工作方式，并选择它可以使用的工具。' },
    'code-agents': { title: '编程工具', hint: '配置写代码的执行工具', description: '配置 Codex、Claude Code 等编程工具，由它们在项目中执行代码任务。' },
    integrations: { title: '外部连接', hint: '连接代码平台与聊天渠道', description: '先选择要连接的平台，再填写配置。连接后可接收外部任务或发送通知。' },
    diagnostics: { title: '运行维护', hint: '更新、诊断与服务管理', description: '查看服务状态、检查版本更新或排查运行故障。日常使用通常无需调整这里的设置。' },
    skills: { title: '技能管理', hint: '查看助手的专用能力', description: '查看助手已加载的技能，以及识别消息和处理事项的执行记录。' },
    memory: { title: '记忆管理', hint: '查看与维护记住的信息', description: '查看助手记住的信息及其来源；在需要时检查或整理这些记忆。' },
    activity: { title: '活动记录', hint: '追溯消息的处理过程', description: '按来源和时间查询处理记录，了解一条消息如何变成任务或动作。' },
    policies: { title: '来源策略', hint: '查看不同来源的处理规则', description: '查看外部消息来源对应的处理与权限规则。这里展示的是只读策略。' },
  },
  'en-US': {
    general: { title: 'Projects & preferences', hint: 'Projects and interface language', description: 'Manage the projects Xuanwu works on and choose your interface language.' },
    notifications: { title: 'Notifications', hint: 'Choose when and where to notify', description: 'Choose delivery channels and notification frequency for messages that need your attention.' },
    permissions: { title: 'Permissions', hint: 'Review allowed actions', description: 'Review allowed actions, approval requirements, and the permissions granted to external connections.' },
    supervisor: { title: 'Xuanwu assistant', hint: 'Connect a model and set behavior', description: 'Connect an AI model, choose how the assistant works, and manage the tools it can use.' },
    'code-agents': { title: 'Coding tools', hint: 'Configure code execution tools', description: 'Configure Codex, Claude Code, and other tools that execute coding tasks in your projects.' },
    integrations: { title: 'External connections', hint: 'Code platforms and chat channels', description: 'Choose a platform to configure. Connected platforms can receive tasks or deliver notifications.' },
    diagnostics: { title: 'System maintenance', hint: 'Updates, diagnostics, and service', description: 'Check service health, install updates, or troubleshoot an issue. Everyday use rarely requires changes here.' },
    skills: { title: 'Skills', hint: 'Review specialized capabilities', description: 'Review loaded skills and the history of message intake and task processing.' },
    memory: { title: 'Memory', hint: 'Review remembered information', description: 'Inspect what the assistant remembers and where it came from; maintain memories when needed.' },
    activity: { title: 'Activity history', hint: 'Trace how messages were handled', description: 'Filter by source and time to understand how a message became a task or action.' },
    policies: { title: 'Source policies', hint: 'Review rules for incoming messages', description: 'Inspect handling and permission rules for external message sources. These policies are read-only.' },
  },
};

export function settingsSectionCopy(tab, language = 'zh-CN') {
  const copy = SECTION_COPY[language] || SECTION_COPY['zh-CN'];
  return copy[tab] || copy.general;
}

const PRIMARY_TAB_IDS = new Set(SETTINGS_PRIMARY_TABS.map(tab => tab.id));
const ADVANCED_TAB_IDS = new Set(SETTINGS_ADVANCED_TABS.map(tab => tab.id));

export function resolveSettingsRoute(value = 'general') {
  const route = String(value || '').trim();
  if (PRIMARY_TAB_IDS.has(route)) return { tier: 'primary', tab: route };
  if (ADVANCED_TAB_IDS.has(route)) return { tier: 'advanced', tab: route };
  if (route.startsWith('advanced:')) {
    const tab = route.slice('advanced:'.length);
    if (ADVANCED_TAB_IDS.has(tab)) return { tier: 'advanced', tab };
  }
  return { tier: 'primary', tab: 'general' };
}

export function settingsRouteId(route) {
  if (route?.tier === 'advanced' && ADVANCED_TAB_IDS.has(route.tab)) {
    return `advanced:${route.tab}`;
  }
  return PRIMARY_TAB_IDS.has(route?.tab) ? route.tab : 'general';
}
