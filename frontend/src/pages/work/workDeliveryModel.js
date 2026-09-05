const MODE_META = {
  local_changes: {
    label: '本地改动快照',
    summary: '已记录本次 Work 可归属的代码改动；Handoff 本身没有创建 commit、push 或部署。',
  },
  branch_commit: {
    label: '本地分支与 commit',
    summary: '已为本次 Work 创建可审计的本地分支和 commit；尚不代表已经推送远端。',
  },
  push: {
    label: '推送远端',
    summary: '本次 Work 的代码已推送到远端引用。',
  },
  draft_pr: {
    label: '草稿 PR',
    summary: '已创建草稿 PR，仍需继续完善或评审。',
  },
  ready_pr: {
    label: '待评审 PR',
    summary: 'PR 已准备好，等待评审或合并。',
  },
  deploy: {
    label: '部署',
    summary: '已记录部署交付及其环境引用。',
  },
  release: {
    label: '发布',
    summary: '已记录正式发布及其版本引用。',
  },
};

const MODE_META_EN = {
  local_changes: { label: 'Local change snapshot', summary: 'The attributable code changes for this Work are recorded. The Handoff itself did not create a commit, push, or deployment.' },
  branch_commit: { label: 'Local branch and commit', summary: 'An auditable local branch and commit were created for this Work. This does not mean they were pushed.' },
  push: { label: 'Push to remote', summary: 'The code for this Work was pushed to a remote ref.' },
  draft_pr: { label: 'Draft PR', summary: 'A draft PR was created and still needs work or review.' },
  ready_pr: { label: 'PR awaiting review', summary: 'The PR is ready for review or merge.' },
  deploy: { label: 'Deployment', summary: 'The deployment delivery and environment reference are recorded.' },
  release: { label: 'Release', summary: 'The release and version reference are recorded.' },
};

const STATUS_LABELS = {
  delivered: '已对外交付',
  delivering: '交付进行中',
  draft: '交付凭证未完成',
  failed: '交付失败',
  ready: '交付凭证已就绪',
  superseded: '已被新版本替代',
};

const STATUS_LABELS_EN = {
  delivered: 'Delivered', delivering: 'Delivering', draft: 'Delivery credential incomplete',
  failed: 'Delivery failed', ready: 'Delivery credential ready', superseded: 'Superseded',
};

const ACTION_LABELS = {
  commit: '创建 commit',
  deploy: '完成部署',
  pull_request: '创建 PR',
  open_pull_request: '创建 PR',
  push: '推送代码',
  release: '完成发布',
  tracker_update: '更新外部任务',
};

const ACTION_LABELS_EN = {
  commit: 'create a commit', deploy: 'complete deployment', open_pull_request: 'create a PR',
  pull_request: 'create a PR',
  push: 'push code', release: 'complete the release', tracker_update: 'update the external task',
};

export function workDeliveryView({ detail, evidence = [], language = 'zh-CN', work = null } = {}) {
  const handoff = detail?.handoff || null;
  if (!handoff || (work?.id && handoff.work_id !== work.id)) return emptyDeliveryView(work, language);
  const mode = handoff.delivery?.mode || 'unknown';
  const english = language === 'en-US';
  const meta = (english ? MODE_META_EN : MODE_META)[mode] || { label: mode, summary: english ? 'The delivery credential is recorded.' : '已记录交付凭证。' };
  const status = detail?.delivery_status?.overall || handoff.status || 'draft';
  const linkedIDs = new Set(Array.isArray(handoff.evidence_ids) ? handoff.evidence_ids : []);
  const linkedEvidence = evidence.filter(item => linkedIDs.has(item?.id));
  const passedEvidence = linkedEvidence.filter(item => item?.status === 'passed').length;
  const failedEvidence = linkedEvidence.filter(item => item?.status === 'failed').length;
  const risks = Array.isArray(handoff.risks) ? handoff.risks : [];
  const highRiskCount = risks.filter(risk => risk?.severity === 'high' || risk?.severity === 'critical').length;
  const requiredActions = Array.isArray(handoff.delivery_actions)
    ? handoff.delivery_actions.filter(action => action?.required)
    : [];
  const pendingActions = requiredActions.filter(action => actionOutcome(detail, action) !== 'succeeded');
  const milestones = deliveryMilestones(detail, evidence, language);
  const missingEvidence = linkedIDs.size - linkedEvidence.length;
  const reviewState = handoff.review?.state || 'not_requested';

  return {
    changedFileCount: Array.isArray(handoff.changed_files) ? handoff.changed_files.length : 0,
    deliverySummary: status === 'failed' ? (english ? 'Delivery failed; inspect the recorded action results below.' : '交付操作失败，请检查下方各项实际结果。')
      : pendingActions.length > 0 || !['ready', 'delivered'].includes(status)
        ? (english ? 'Delivery is not complete. See the recorded results below.' : '交付尚未完成，请以下方实际操作结果为准。')
        : mode === 'local_changes' && handoff.changed_files?.length === 0 ? (english ? 'Recorded verification and workspace snapshot; no code changes claimed.' : '已记录验证和工作区快照；没有声明代码改动。') : meta.summary,
    changeSummary: handoff.summary || (english ? 'No change summary recorded' : '尚未记录改动摘要'),
    milestones,
    missingEvidence,
    evidenceFailed: failedEvidence,
    evidenceLinked: linkedIDs.size,
    evidenceLoaded: linkedEvidence.length,
    evidencePassed: passedEvidence,
    highRiskCount,
    mode,
    modeLabel: mode === 'local_changes' && handoff.changed_files?.length === 0 ? (english ? 'Read-only check receipt' : '只读检查凭证') : meta.label,
    nextAction: nextDeliveryAction({ failedEvidence, highRiskCount, language, linkedCount: linkedIDs.size, missingEvidence, pendingActions, reviewState, status, work }),
    riskCount: risks.length,
    status,
    statusLabel: (english ? STATUS_LABELS_EN : STATUS_LABELS)[status] || status,
  };
}

export function deliveryEvidenceRows(detail, evidence = [], language = 'zh-CN') {
  const ids = Array.isArray(detail?.handoff?.evidence_ids) ? detail.handoff.evidence_ids : [];
  const byID = new Map(evidence.map(item => [item?.id, item]));
  return ids.map(id => {
    const item = byID.get(id);
    return {
      id,
      kind: item?.kind || evidenceKindFromID(id),
      loaded: Boolean(item),
      status: item?.status || 'linked',
      summary: item?.decisive_summary || (language === 'en-US' ? 'Evidence is linked; its detailed summary has not loaded.' : '证据已关联；详细摘要尚未加载。'),
      observedAt: item?.observed_at || item?.completed_at || '',
    };
  });
}

export function deliveryRefRows(handoff, language = 'zh-CN') {
  const delivery = handoff?.delivery || {};
  const english = language === 'en-US';
  return [
    [english ? 'Branch' : '分支', delivery.branch_ref],
    ['Commit', delivery.commit_ref],
    [english ? 'Remote ref' : '远端引用', delivery.remote_ref],
    ['Pull request', delivery.pull_request_ref],
    [english ? 'Deployment' : '部署', delivery.deployment_ref],
    [english ? 'Environment' : '环境', delivery.environment],
    [english ? 'Version' : '版本', delivery.version],
    [english ? 'Release' : '发布', delivery.release_ref],
    [english ? 'Workspace snapshot' : '工作区快照', delivery.working_tree_ref],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
}

export function deliveryHistoryLabel(item, language = 'zh-CN') {
  const issue = item?.issue;
  const revision = Number(item?.revision ?? 0);
  const english = language === 'en-US';
  return {
    issueLabel: issue?.id ? `Issue #${issue.id}` : item?.work_id || (english ? 'Related Work' : '关联 Work'),
    revisionLabel: revision > 0 ? (english ? `Revision ${revision + 1}` : `版本 ${revision + 1}`) : (english ? 'Initial revision' : '初始版本'),
    statusLabel: (english ? STATUS_LABELS_EN : STATUS_LABELS)[item?.delivery_status?.overall || item?.status] || item?.status || (english ? 'Unknown status' : '未知状态'),
  };
}

function emptyDeliveryView(work, language) {
  const english = language === 'en-US';
  return {
    changedFileCount: 0,
    deliverySummary: work?.status === 'done'
      ? (english ? 'This historical completion has no queryable Handoff delivery credential.' : '该历史完成记录没有可查询的 Handoff 交付凭证。')
      : (english ? 'A delivery credential may appear after Work completes.' : 'Work 完成后可能在这里生成交付凭证。'),
    evidenceFailed: 0,
    evidenceLinked: 0,
    evidenceLoaded: 0,
    evidencePassed: 0,
    highRiskCount: 0,
    mode: '',
    modeLabel: english ? 'No delivery' : '尚无交付',
    nextAction: work?.status === 'done' ? (english ? 'Add a delivery credential to the historical record' : '历史记录待补充交付凭证') : (english ? 'Wait for Work to complete' : '等待 Work 完成'),
    riskCount: 0,
    status: 'missing',
    statusLabel: english ? 'No Handoff' : '无 Handoff',
  };
}

function nextDeliveryAction({ failedEvidence, highRiskCount, language, linkedCount, missingEvidence, pendingActions, reviewState, status, work }) {
  const english = language === 'en-US';
  if (status === 'failed') return english ? 'Inspect the delivery failure' : '检查交付失败原因';
  if (highRiskCount > 0) return english ? 'Inspect high-risk attribution issues' : '检查高风险归因问题';
  if (failedEvidence > 0) return english ? 'Resolve failed checks' : '处理未通过的验证';
  if (missingEvidence > 0 || linkedCount === 0) return english ? 'Load or complete verification evidence' : '读取或补齐验证证据';
  if (reviewState === 'changes_requested') return english ? 'Address the review feedback' : '处理评审提出的修改要求';
  if (reviewState === 'pending') return english ? 'Review this delivery' : '完成交付评审';
  if (pendingActions.length > 0) {
    const action = (english ? ACTION_LABELS_EN : ACTION_LABELS)[pendingActions[0]?.action] || pendingActions[0]?.action || (english ? 'delivery action' : '交付操作');
    return english ? `Wait to ${action}` : `等待${action}`;
  }
  if (work?.status === 'needs_user') return english ? 'Answer the PI question' : '处理 PI 提出的明确问题';
  if (!['ready', 'delivered'].includes(status)) return english ? 'Complete the delivery check' : '完成交付检查';
  return english ? 'No further action' : '无需额外操作';
}

function evidenceKindFromID(id) {
  if (String(id).startsWith('xw:evidence:git:')) return 'git';
  return 'evidence';
}

function actionOutcome(detail, action) {
  return detail?.delivery_status?.actions?.find(item => item.action === action.action && item.source_ref === action.audit_event_ref)?.current_status || action.outcome;
}

export function deliveryMilestones(detail, evidence = [], language = 'zh-CN') {
  const english = language === 'en-US';
  const rows = deliveryEvidenceRows(detail, evidence, language);
  const checks = rows.filter(row => ['test', 'lint', 'build', 'shell', 'command', 'http', 'browser'].includes(row.kind));
  const checkStatus = !checks.length ? 'unknown' : checks.some(row => row.status === 'failed') ? 'failed'
    : checks.every(row => row.status === 'passed') ? 'succeeded' : 'unknown';
  const statuses = english
    ? { succeeded: 'Confirmed', failed: 'Failed', pending: 'Pending', unknown: 'Not verified', not_recorded: 'Not recorded' }
    : { succeeded: '已确认', failed: '失败', pending: '待完成', unknown: '未验证', not_recorded: '未记录' };
  const milestones = [{ key: 'checks', label: english ? 'Checks' : '验证', status: checkStatus }];
  for (const [key, zh, en] of [['commit', '提交', 'Commit'], ['push', '推送', 'Push'], ['deploy', '部署', 'Deployment'], ['release', '发布', 'Release']]) {
    const actions = (detail?.handoff?.delivery_actions || []).filter(action => action.action === key);
    const results = actions.map(action => actionOutcome(detail, action));
    const status = !results.length ? 'not_recorded' : results.includes('failed') ? 'failed'
      : results.every(result => result === 'succeeded') ? 'succeeded' : 'pending';
    milestones.push({ key, label: english ? en : zh, status });
  }
  return milestones.map(item => ({ ...item, value: statuses[item.status] }));
}
