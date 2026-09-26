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
