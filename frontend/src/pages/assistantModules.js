export const PI_ASSISTANT_NAV_ITEMS = [
  {
    page: 'pi-chat',
    label: 'Chat',
    title: 'Chat',
    description: '查看和继续所有 PI Assistant conversations。'
  },
  {
    page: 'pi-inbox',
    label: 'Inbox',
    title: 'Inbox',
    description: '多来源事项经过 intake 后进入这里，再由 skill 或人工处理。'
  }
];

export const PI_ASSISTANT_SETTINGS_ITEM = {
  page: 'settings',
  label: 'Settings',
  title: 'Settings',
  description: 'PI Assistant 与 runner runtime 的高级配置集合。'
};

export const PI_ASSISTANT_CONFIG_MODULES = [
  {
    page: 'pi-overview',
    tab: 'assistant',
    label: 'Overview',
    title: 'Overview',
    description: '唯一 PI Assistant 的管理中心，集中展示 runtime 配置、能力边界与入口。'
  },
  {
    page: 'pi-connectors',
    tab: 'connectors',
    label: 'Connectors',
    title: 'Connectors',
    description: '管理外部来源、tool provider 与只读健康诊断，不把具体来源硬编码进核心 runtime。'
  },
  {
    page: 'pi-skills',
    tab: 'skills',
    label: 'Skills',
    title: 'Skills',
    description: '查看 intake/domain skill、依赖工具、schema 与运行历史。'
  },
  {
    page: 'pi-automations',
    tab: 'automations',
    label: 'Automations',
    title: 'Automations',
    description: '预留 continuous intake、manual run、schedule 与 webhook 规则入口。'
  },
  {
    page: 'pi-approvals',
    tab: 'approvals',
    label: 'Approvals',
    title: 'Approvals',
    description: '集中处理 action proposal、外部写操作与高风险工具调用确认。'
  },
  {
    page: 'pi-memory',
    tab: 'memory',
    label: 'Memory',
    title: 'Memory',
    description: '审阅、启用、pin 或忘记 PI Assistant 可检索记忆。'
  },
  {
    page: 'pi-activity',
    tab: 'activity',
    label: 'Activity',
    title: 'Activity',
    description: '预留 raw event、intake run、skill run、proposal 与 tool call 审计时间线。'
  },
  {
    page: 'pi-policies',
    tab: 'policies',
    label: 'Policies',
    title: 'Policies',
    description: '在 Assistant Settings 中管理 source policy、自动回复、自动建 issue 与自动 enqueue 等策略。'
  }
];

export const PI_ASSISTANT_MODULES = [
  ...PI_ASSISTANT_NAV_ITEMS,
  PI_ASSISTANT_SETTINGS_ITEM,
  ...PI_ASSISTANT_CONFIG_MODULES,
];

export function assistantModuleForPage(page) {
  return PI_ASSISTANT_MODULES.find((module) => module.page === page) || null;
}

export function isAssistantModulePage(page) {
  const module = assistantModuleForPage(page);
  return Boolean(module?.tab);
}
