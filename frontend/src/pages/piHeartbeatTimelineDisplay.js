const STAGE_LABELS = {
  action: '准备执行',
  decision: '策略判断',
  result: '执行结果',
  signal: '发现信号',
  supervisor_action: '主管恢复',
  supervisor_decision: '主管恢复',
  supervisor_result: '主管恢复',
  supervisor_signal: '主管恢复',
};

const VIEW_FILTER_LABELS = {
  abnormal: '异常记录',
  all: '全部记录',
  attention: '待确认',
  result: '执行结果',
};

const SOURCE_LABELS = {
  action: '动作记录',
  heartbeat: '自动检查',
  supervisor: '主管恢复',
};

const ACTION_LABELS = {
  'agent.workflow_request': '启动 Agent 工作流',
  'issue.create': '创建 issue',
  'issue.enqueue': '入队执行 issue',
  'issue.retry_proposal': '重试 issue',
  'issue.schedule_enqueue': '安排 issue 入队',
  'memory.write_candidate': '记录记忆候选',
  'needs_user.escalate': '提醒人工确认',
  'session.resume_followup': '恢复会话',
  'session.steer_proposal': '调整会话方向',
};

const ACTION_PHRASES = {
  'agent.workflow_request': ['准备启动 Agent 工作流', '开始启动 Agent 工作流', 'Agent 工作流已完成', 'Agent 工作流失败'],
  'issue.create': ['准备创建 issue', '开始创建 issue', 'issue 创建完成', 'issue 创建失败'],
  'issue.enqueue': ['准备入队 issue', '开始入队 issue', 'issue 入队完成', 'issue 入队失败'],
  'needs_user.escalate': ['准备提醒人工确认', '开始提醒人工确认', '人工提醒已记录', '人工提醒失败'],
  'session.resume_followup': ['准备恢复会话', '开始恢复会话', '会话恢复完成', '会话恢复失败'],
};

const DECISION_LABELS = {
  ask: '需要确认',
  approve: '通过',
  approved: '已通过',
  execute: '允许执行',
  reject: '拒绝',
  rejected: '已拒绝',
  request_changes: '要求修改',
  snooze: '暂缓',
  snoozed: '已暂缓',
};

const STATUS_LABELS = {
  completed: '已完成',
  failed: '失败',
  running: '运行中',
  skipped: '已跳过',
  success: '成功',
};

const RUNTIME_MESSAGES = {
  'PI planned or started an action.': 'PI 已准备或开始执行该动作。',
  'PI recorded the result.': 'PI 已记录执行结果。',
  'PI supervisor agent is not runnable': '自动恢复代理当前不可执行，已记录为待处理。',
  'low-risk action is allowed by gate': '低风险动作已通过准入检查，可继续执行。',
  requires_human_decision: '该事项需要人工确认后继续。',
  'risk requires user confirmation': '存在需要确认的风险，等待人工处理。',
};

export function timelineItemDisplay(item) {
  const action = actionSummary(item);
  return {
    description: timelineDescription(item, action),
    stageLabel: timelineStageLabel(item.stage),
    title: timelineTitle(item, action),
  };
}

export function timelineStageLabel(stage) {
  return STAGE_LABELS[clean(stage)] || '执行结果';
}

export function timelineChips(item, shortener = defaultShortener) {
  const action = actionSummary(item);
  return [
    item.project_id ? chip(`项目：${item.project_id}`) : null,
    positiveNumber(item.issue_id) ? chip(`Issue：#${item.issue_id}`) : null,
    action.type ? chip(`动作类型：${action.label}（${action.type}）`) : null,
    item.decision ? chip(`决策：${decisionLabel(item.decision)}`) : null,
    item.source ? chip(`来源：${sourceLabel(item.source)}`) : null,
    item.heartbeat_id ? chip(`检查：${shortener(item.heartbeat_id)}`, true) : null,
    item.action_id ? chip(`动作：${shortener(item.action_id)}`, true) : null,
    item.delegation_id ? chip(`委托：${shortener(item.delegation_id)}`, true) : null,
  ].filter(Boolean);
}

export function filterTimelineItems(items, view) {
  const selected = clean(view) || 'all';
  if (selected === 'abnormal') return items.filter(isAbnormalRecord);
  if (selected === 'attention') return items.filter(needsAttentionRecord);
  if (selected === 'result') return items.filter(isResultRecord);
  return items;
}

export function viewFilterLabel(view) {
  return VIEW_FILTER_LABELS[clean(view)] || VIEW_FILTER_LABELS.all;
}

function timelineTitle(item, action) {
  const eventType = clean(item.event_type);
  if (eventType.includes('decision_failed')) return '恢复判断失败';
  if (eventType === 'execution_error' || hasError(item)) return actionPhrase(action, 3, '执行失败');
  if (eventType === 'pending_approval') return '等待人工确认';
  if (eventType === 'gate_decision' || eventType === 'authorization_gate') return gateDecisionTitle(item);
  if (eventType === 'execution_started') return actionPhrase(action, 1, '开始执行');
  if (eventType === 'execution_result') return resultTitle(item, action);
  if (eventType === 'candidate') return actionPhrase(action, 0, '发现可处理动作');
  if (eventType === 'action_proposed' || eventType === 'plan_actions') return actionPhrase(action, 0, '准备执行');
  if (eventType === 'collect_signals' || eventType === 'signal') return signalTitle(item);
  if (eventType === 'evaluate_policies' || eventType === 'decision') return '评估执行策略';
  if (eventType === 'supervisor_signal') return '发现恢复线索';
  if (eventType === 'supervisor_action') return actionPhrase(action, 0, '准备恢复');
  if (eventType === 'supervisor_result') return '恢复处理结果';
  return fallbackTitle(item);
}

function timelineDescription(item, action) {
  const translated = translatedMessage(item.message);
  if (hasError(item)) return `处理失败：${translatedMessage(item.error) || '请展开技术详情排查。'}`;
  if (translated) return translated;
  if (clean(item.event_type) === 'pending_approval') return '该动作需要用户确认，系统已暂停自动执行。';
  if (clean(item.event_type).includes('decision_failed')) return '恢复策略没有通过，等待后续人工或配置处理。';
  if (clean(item.event_type) === 'collect_signals') return '系统已收集项目、issue 和会话运行状态，用于判断下一步动作。';
  if (clean(item.event_type) === 'execution_result') return resultDescription(action);
  if (action.type) return `系统识别到“${action.label}”动作，后续将按策略判断是否执行。`;
  return `${sourceLabel(item.source)}已记录一条${timelineStageLabel(item.stage)}。`;
}

function gateDecisionTitle(item) {
  const decision = clean(item.decision);
  if (['approve', 'approved', 'execute'].includes(decision)) return '授权通过';
  if (['ask', 'request_changes'].includes(decision)) return '等待人工确认';
  if (['reject', 'rejected'].includes(decision)) return '授权拒绝';
  if (decision === 'snooze' || decision === 'snoozed') return '暂缓执行';
  return '完成授权检查';
}

function resultTitle(item, action) {
  if (statusFailed(action.status)) return actionPhrase(action, 3, '执行失败');
  if (statusPending(action.status)) return actionPhrase(action, 1, '执行中');
  return actionPhrase(action, 2, '执行完成');
}

function signalTitle(item) {
  if (clean(item.source) === 'supervisor') return '发现恢复线索';
  return '检查项目状态';
}

function fallbackTitle(item) {
  if (clean(item.source) === 'supervisor') return '主管恢复记录';
  if (clean(item.stage) === 'decision') return '策略判断记录';
  if (clean(item.stage) === 'action') return '准备执行动作';
  if (clean(item.stage) === 'signal') return '发现运行信号';
  return '执行结果记录';
}

function resultDescription(action) {
  if (action.status) return `动作已结束，状态：${statusLabel(action.status)}。`;
  return '动作已结束，结果已写入审计记录。';
}

function actionSummary(item) {
  const payload = jsonObject(item.payload_json);
  const result = jsonObject(item.result_json);
  const type = firstText(result.action_type, payload.action_type, payload.requested_action, knownActionType(item.message));
  const status = firstText(result.status, payload.status);
  return { label: actionLabel(type), status, type };
}

function actionPhrase(action, index, fallback) {
  const phrase = ACTION_PHRASES[action.type]?.[index];
  if (phrase) return phrase;
  return action.type ? `${fallback}：${action.label}` : fallback;
}

function actionLabel(type) {
  const code = clean(type);
  return ACTION_LABELS[code] || '自动化动作';
}

function translatedMessage(message) {
  const text = clean(message);
  if (!text) return '';
  if (RUNTIME_MESSAGES[text]) return RUNTIME_MESSAGES[text];
  const delegatedMatch = text.match(/^delegated action is covered by authorization envelope; scope matched project (.+)$/);
  if (delegatedMatch) return `委托授权覆盖该动作；范围匹配项目 ${delegatedMatch[1]}`;
  return hasChinese(text) ? text : '';
}

function isAbnormalRecord(item) {
  const eventType = clean(item.event_type);
  return hasError(item) || eventType.includes('error') || eventType.includes('failed') ||
    clean(item.message) === 'PI supervisor agent is not runnable';
}

function needsAttentionRecord(item) {
  const eventType = clean(item.event_type);
  const decision = clean(item.decision);
  const message = clean(item.message);
  return eventType === 'pending_approval' || eventType.includes('decision_failed') ||
    ['ask', 'request_changes', 'reject', 'rejected'].includes(decision) ||
    ['requires_human_decision', 'risk requires user confirmation'].includes(message);
}

function isResultRecord(item) {
  const stage = clean(item.stage);
  const eventType = clean(item.event_type);
  return stage === 'result' || stage === 'supervisor_result' || eventType.includes('result');
}

function statusFailed(status) {
  return ['error', 'failed', 'failure'].includes(clean(status));
}

function statusPending(status) {
  return ['running', 'started'].includes(clean(status));
}

function statusLabel(status) {
  const code = clean(status);
  return STATUS_LABELS[code] || code;
}

function decisionLabel(decision) {
  const code = clean(decision);
  return DECISION_LABELS[code] || code;
}

function sourceLabel(source) {
  return SOURCE_LABELS[clean(source)] || '自动记录';
}

function chip(text, muted = false) {
  return { muted, text };
}

function jsonObject(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function firstText(...values) {
  return values.map(clean).find(Boolean) || '';
}

function knownActionType(value) {
  const text = clean(value);
  return ACTION_LABELS[text] ? text : '';
}

function positiveNumber(value) {
  return Number(value) > 0;
}

function hasError(item) {
  return clean(item.error) !== '';
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function defaultShortener(value) {
  const text = clean(value);
  return text.length > 8 ? text.slice(0, 8) : text;
}
