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

const MODE_META_EN = {
  local_changes: { label: 'Local change snapshot', summary: 'The attributable code changes for this Work are recorded. The Handoff itself did not create a commit, push, or deployment.' },
  branch_commit: { label: 'Local branch and commit', summary: 'An auditable local branch and commit were created for this Work. This does not mean they were pushed.' },
  push: { label: 'Pushed to remote', summary: 'The code for this Work was pushed to a remote ref.' },
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
  open_pull_request: '创建 PR',
  push: '推送代码',
  release: '完成发布',
  tracker_update: '更新外部任务',
};

const ACTION_LABELS_EN = {
  commit: 'create a commit', deploy: 'complete deployment', open_pull_request: 'create a PR',
  push: 'push code', release: 'complete the release', tracker_update: 'update the external task',
};

export function workDeliveryView({ detail, evidence = [], language = 'zh-CN', work = null } = {}) {
  const handoff = detail?.handoff || null;
  if (!handoff) return emptyDeliveryView(work, language);
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
  const pendingActions = requiredActions.filter(action => action?.outcome !== 'succeeded');

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
    nextAction: nextDeliveryAction({ highRiskCount, language, pendingActions, status, work }),
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

function nextDeliveryAction({ highRiskCount, language, pendingActions, status, work }) {
  const english = language === 'en-US';
  if (status === 'failed') return english ? 'Inspect the delivery failure' : '检查交付失败原因';
  if (highRiskCount > 0) return english ? 'Inspect high-risk attribution issues' : '检查高风险归因问题';
  if (pendingActions.length > 0) {
    const action = (english ? ACTION_LABELS_EN : ACTION_LABELS)[pendingActions[0]?.action] || pendingActions[0]?.action || (english ? 'delivery action' : '交付操作');
    return english ? `Wait to ${action}` : `等待${action}`;
  }
  if (work?.status === 'needs_user') return english ? 'Answer the PI question' : '处理 PI 提出的明确问题';
  return english ? 'No further action' : '无需额外操作';
}

function evidenceKindFromID(id) {
  if (String(id).startsWith('xw:evidence:git:')) return 'git';
  return 'evidence';
}
