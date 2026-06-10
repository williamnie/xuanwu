export const COMMAND_CENTER_TERMS = {
  allowlist: '允许列表（allowlist）',
  delegation: '委托窗口（delegation）',
  heartbeat: '自动检查（heartbeat）',
  mcp: 'MCP 工具能力',
  pi: 'PI（托管执行代理）',
  policy: '执行策略（policy）',
  supervisor: '自动恢复（supervisor）',
};

const MODE_LABELS = {
  attended: '辅助确认',
  autonomous: '自动执行',
  delegated: '委托执行',
  manual: '手动',
};

const STATUS_LABELS = {
  active: '生效中',
  cancelled: '已取消',
  completed: '已完成',
  expired: '已过期',
  failed: '失败',
  idle: '空闲',
  paused: '已暂停',
  revoked: '已撤销',
  running: '运行中',
  skipped: '已跳过',
  success: '正常',
};

const STAGE_LABELS = {
  action: '执行动作',
  decision: '策略决策',
  result: '执行结果',
  signal: '运行信号',
  supervisor_action: '恢复动作',
  supervisor_decision: '恢复决策',
  supervisor_result: '恢复结果',
  supervisor_signal: '恢复信号',
};

const EVENT_LABELS = {
  action: '执行动作',
  action_proposed: '提议动作',
  authorization_gate: '授权检查',
  candidate: '候选动作',
  collect_signals: '收集信号',
  decision: '决策记录',
  decision_failed: '决策失败',
  evaluate_policies: '评估策略',
  execution_error: '执行错误',
  execution_result: '执行结果',
  execution_started: '开始执行',
  gate_decision: '准入决策',
  pending_approval: '等待人工确认',
  plan_actions: '规划动作',
  result: '结果记录',
  signal: '信号记录',
  supervisor_decision_failed: '恢复决策失败',
  supervisor_signal: '恢复信号',
};

const DECISION_LABELS = {
  ask: '需要确认',
  approve: '批准',
  approved: '已批准',
  execute: '允许执行',
  reject: '拒绝',
  rejected: '已拒绝',
  request_changes: '要求修改',
  snooze: '暂缓',
  snoozed: '已暂缓',
};

const RISK_LABELS = {
  critical: '严重',
  high: '高风险',
  low: '低风险',
  medium: '中风险',
};

const REPORT_TYPE_LABELS = {
  manual: '手动报告',
  night: '夜间报告',
  supervisor: '自动恢复报告',
  weekly: '周报',
};

const SOURCE_LABELS = {
  audit: '审计',
  heartbeat: '自动检查',
  supervisor: '自动恢复',
};

const ACTOR_LABELS = {
  executor: '执行器',
  gate: '准入检查',
  pi: 'PI',
  system: '系统',
};

const MESSAGE_LABELS = {
  'PI supervisor agent is not runnable': 'PI 自动恢复代理当前不可执行',
  'low-risk action is allowed by gate': '低风险动作已通过准入检查',
  requires_human_decision: '需要人工判断',
  'risk requires user confirmation': '风险需要用户确认',
};

export function labelWithCode(label, code) {
  const normalized = String(code || '').trim();
  return normalized ? `${label}（${normalized}）` : label;
}

export function modeLabel(mode) {
  return lookupWithCode(MODE_LABELS, mode, '未配置模式');
}

export function statusLabel(status) {
  return lookupWithCode(STATUS_LABELS, status, '未知状态');
}

export function stageLabel(stage) {
  const code = String(stage || '').trim();
  return STAGE_LABELS[code] || '结果记录';
}

export function eventTypeLabel(eventType) {
  return lookupWithCode(EVENT_LABELS, eventType, '事件记录', codeText(eventType));
}

export function decisionLabel(decision) {
  return lookupWithCode(DECISION_LABELS, decision, '未知决策');
}

export function riskLabel(risk) {
  return lookupWithCode(RISK_LABELS, risk, '风险未标注');
}

export function reportTypeLabel(type) {
  return lookupWithCode(REPORT_TYPE_LABELS, type, '报告');
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || '审计';
}

export function actorLabel(actor) {
  if (!actor) return '系统';
  return ACTOR_LABELS[actor] || actor;
}

export function runtimeMessageLabel(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  const delegatedMatch = text.match(/^delegated action is covered by authorization envelope; scope matched project (.+)$/);
  if (delegatedMatch) return `委托授权覆盖该动作；范围匹配项目 ${delegatedMatch[1]}`;
  return MESSAGE_LABELS[text] || text;
}

function lookupWithCode(map, value, fallback, displayCode = String(value || '').trim()) {
  const code = String(value || '').trim();
  if (!code) return fallback;
  return labelWithCode(map[code] || fallback, displayCode);
}

function codeText(value) {
  return String(value || '').replaceAll('_', ' ').trim();
}
