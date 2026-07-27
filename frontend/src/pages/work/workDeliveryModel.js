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
    label: '已推送远端',
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

const STATUS_LABELS = {
  delivered: '已对外交付',
  delivering: '交付进行中',
  draft: '交付凭证未完成',
  failed: '交付失败',
  ready: '交付凭证已就绪',
  superseded: '已被新版本替代',
};

const ACTION_LABELS = {
  commit: '创建 commit',
  deploy: '完成部署',
  open_pull_request: '创建 PR',
  push: '推送代码',
  release: '完成发布',
  tracker_update: '更新外部任务',
};

export function workDeliveryView({ detail, evidence = [], work = null } = {}) {
  const handoff = detail?.handoff || null;
  if (!handoff) return emptyDeliveryView(work);
  const mode = handoff.delivery?.mode || 'unknown';
  const meta = MODE_META[mode] || { label: mode, summary: '已记录交付凭证。' };
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
  const pendingActions = requiredActions.filter(action => action?.outcome !== 'succeeded');
  const review = detail?.review_summary || handoff.review || {};

  return {
    changedFileCount: Array.isArray(handoff.changed_files) ? handoff.changed_files.length : 0,
    deliverySummary: meta.summary,
    evidenceFailed: failedEvidence,
    evidenceLinked: linkedIDs.size,
    evidenceLoaded: linkedEvidence.length,
    evidencePassed: passedEvidence,
    highRiskCount,
    mode,
    modeLabel: meta.label,
    nextAction: nextDeliveryAction({ highRiskCount, pendingActions, review, status, work }),
    reviewLabel: reviewLabel(review),
    riskCount: risks.length,
    status,
    statusLabel: STATUS_LABELS[status] || status,
  };
}

export function deliveryEvidenceRows(detail, evidence = []) {
  const ids = Array.isArray(detail?.handoff?.evidence_ids) ? detail.handoff.evidence_ids : [];
  const byID = new Map(evidence.map(item => [item?.id, item]));
  return ids.map(id => {
    const item = byID.get(id);
    return {
      id,
      kind: item?.kind || evidenceKindFromID(id),
      loaded: Boolean(item),
      status: item?.status || 'linked',
      summary: item?.decisive_summary || '证据已关联；详细摘要尚未加载。',
      observedAt: item?.observed_at || item?.completed_at || '',
    };
  });
}

export function deliveryRefRows(handoff) {
  const delivery = handoff?.delivery || {};
  return [
    ['分支', delivery.branch_ref],
    ['Commit', delivery.commit_ref],
    ['远端引用', delivery.remote_ref],
    ['Pull request', delivery.pull_request_ref],
    ['部署', delivery.deployment_ref],
    ['环境', delivery.environment],
    ['版本', delivery.version],
    ['发布', delivery.release_ref],
    ['工作区快照', delivery.working_tree_ref],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
}

export function deliveryHistoryLabel(item) {
  const issue = item?.issue;
  const revision = Number(item?.revision ?? 0);
  return {
    issueLabel: issue?.id ? `Issue #${issue.id}` : item?.work_id || '关联 Work',
    revisionLabel: revision > 0 ? `版本 ${revision + 1}` : '初始版本',
    statusLabel: STATUS_LABELS[item?.delivery_status?.overall || item?.status] || item?.status || '未知状态',
  };
}

function emptyDeliveryView(work) {
  return {
    changedFileCount: 0,
    deliverySummary: work?.status === 'done'
      ? '该历史完成记录没有可查询的 Handoff 交付凭证。'
      : 'Work 完成并通过验证后，会在这里生成交付凭证。',
    evidenceFailed: 0,
    evidenceLinked: 0,
    evidenceLoaded: 0,
    evidencePassed: 0,
    highRiskCount: 0,
    mode: '',
    modeLabel: '尚无交付',
    nextAction: work?.status === 'done' ? '历史记录待补充交付凭证' : '等待 Work 完成',
    reviewLabel: '未请求评审',
    riskCount: 0,
    status: 'missing',
    statusLabel: '无 Handoff',
  };
}

function nextDeliveryAction({ highRiskCount, pendingActions, review, status, work }) {
  if (status === 'failed') return '检查交付失败原因';
  if (review?.state === 'pending') return '等待人工评审';
  if (review?.state === 'changes_requested') return '按评审意见修改';
  if (highRiskCount > 0) return '检查高风险归因问题';
  if (pendingActions.length > 0) {
    return `等待${ACTION_LABELS[pendingActions[0]?.action] || pendingActions[0]?.action || '交付操作'}`;
  }
  if (work?.status === 'pending_verification') return '完成 Work 验收';
  return '无需额外操作';
}

function reviewLabel(review) {
  if (review?.state === 'approved') return '评审已通过';
  if (review?.state === 'pending') return '等待人工评审';
  if (review?.state === 'changes_requested') return '已请求修改';
  return '未请求评审';
}

function evidenceKindFromID(id) {
  if (String(id).startsWith('xw:evidence:git:')) return 'git';
  return 'evidence';
}
