// 每类人工审核请求可用的回复（方案 5.3）：验收不提供“拒绝”，授权不提供“要求修改”。
const REVIEW_ACTIONS = {
  acceptance: ['accept', 'request_changes'],
  decision: ['accept', 'request_changes', 'reject'],
  risk_acceptance: ['accept', 'reject'],
};

export function workHumanReviewActions(kind) {
  return REVIEW_ACTIONS[kind] || REVIEW_ACTIONS.acceptance;
}

export function workHumanReviewCopy(kind, t) {
  if (kind === 'decision') return {
    accept: t('work.confirmDecision'),
    title: t('work.confirmDecision'),
    detail: t('work.decisionConfirmationDetail'),
    pending: t('work.decisionRequired'),
    reject: t('work.rejectDecision'),
  };
  if (kind === 'risk_acceptance') return {
    accept: t('work.authorizeAndContinue'),
    title: t('work.authorizeAndContinue'),
    detail: t('work.authorizationDetail'),
    pending: t('work.authorizationRequired'),
    reject: t('work.rejectAuthorization'),
  };
  return {
    accept: t('work.acceptDeliveryShort'),
    title: t('work.acceptDelivery'),
    detail: t('work.deliveryAcceptanceDetail'),
    pending: t('work.state.reviewTitle'),
    reject: t('work.rejectDelivery'),
  };
}
