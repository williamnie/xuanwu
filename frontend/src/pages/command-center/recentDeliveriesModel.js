import {
  deliveryTone,
  handoffRouteFromHash,
  safeExternalUrl,
} from '../handoffPageModel.js';

const MODE_META = {
  local_changes: { label: '本地改动快照', operation: '本地交付' },
  branch_commit: { label: '本地分支与 commit', operation: 'Commit' },
  push: { label: '已推送远端', operation: 'Push' },
  draft_pr: { label: '草稿 PR', operation: 'Pull request' },
  ready_pr: { label: '待评审 PR', operation: 'Pull request' },
  deploy: { label: '部署', operation: 'Deploy' },
  release: { label: '发布', operation: 'Release' },
};

const STATUS_LABELS = {
  delivered: '已交付',
  delivering: '交付中',
  draft: '草稿',
  failed: '失败',
  ready: '可交付',
  superseded: '已替代',
};

const REVIEW_LABELS = {
  approved: 'Review approved',
  changes_requested: 'Changes requested',
  not_applicable: 'Review not applicable',
  not_requested: 'Review not requested',
  pending: 'Review pending',
};

export function mergeRecentDeliveryDetail(summary, detail) {
  const handoff = detail?.handoff;
  if (!handoff || handoff.id !== summary?.id) return summary;
  return {
    ...summary,
    delivery: handoff.delivery || summary.delivery,
    delivery_status: detail.delivery_status || summary.delivery_status,
    evidence_count: Array.isArray(handoff.evidence_ids) ? handoff.evidence_ids.length : summary.evidence_count,
    review: handoff.review || summary.review,
    risk_count: Array.isArray(handoff.risks) ? handoff.risks.length : summary.risk_count,
    status: handoff.status || summary.status,
    summary: handoff.summary || summary.summary,
    updated_at: handoff.updated_at || summary.updated_at,
  };
}

export function recentDeliveryView(item) {
  const delivery = item?.delivery || {};
  const mode = delivery.mode || 'unknown';
  const modeMeta = MODE_META[mode] || { label: mode, operation: 'Delivery' };
  const status = item?.delivery_status?.overall || item?.status || 'draft';
  const refs = deliveryRefs(delivery);
  const evidenceCount = normalizedCount(item?.evidence_count);
  const riskCount = normalizedCount(item?.risk_count);
  const reviewState = item?.review?.state || 'not_requested';
  return {
    detailRoute: recentDeliveryDetailRoute(item),
    evidenceCount,
    evidencePassed: ['ready', 'delivered'].includes(item?.status),
    evidenceLabel: ['ready', 'delivered'].includes(item?.status)
      ? `${evidenceCount} Evidence passed`
      : `${evidenceCount} Evidence linked`,
    externalHref: safeExternalUrl(delivery.url || delivery.external_url),
    mode,
    modeLabel: modeMeta.label,
    operationLabel: modeMeta.operation,
    primaryRef: refs.at(-1)?.value || item?.id || '',
    refs,
    reviewLabel: REVIEW_LABELS[reviewState] || reviewState,
    reviewState,
    riskCount,
    riskLabel: riskCount === 0 ? 'No known risk' : `${riskCount} risk${riskCount === 1 ? '' : 's'}`,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    statusTone: deliveryTone(status),
  };
}

export function recentDeliveryDetailRoute(item) {
  const route = handoffRouteFromHash(item?.links?.view);
  return route?.handoffId === item?.id ? route : null;
}

function deliveryRefs(delivery) {
  return [
    ['Working tree', delivery.working_tree_ref],
    ['Branch', delivery.branch_ref],
    ['Commit', delivery.commit_ref],
    ['Remote', delivery.remote_ref],
    ['Pull request', delivery.pull_request_ref],
    ['Revision', delivery.revision_ref],
    ['Deployment', delivery.deployment_ref],
    ['Version', delivery.version],
    ['Release', delivery.release_ref],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
}

function normalizedCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
