import { workHumanReviewCopy } from '../workHumanReviewCopy';
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDot, LoaderCircle } from 'lucide-react';
import { useI18n } from '../../i18n/context.js';

export function WorkStateSummary({ status, decision }) {
  const { t } = useI18n();
  const pendingSummary = decision?.owner === 'human'
    ? [workHumanReviewCopy(decision?.request?.kind, t).pending, decision?.request?.question || t('work.state.reviewDetail')]
    : decision?.phase === 'pi_continuing'
      ? [t('work.state.piRepairingTitle'), t('work.state.piRepairingDetail')]
      : decision?.phase === 'pi_deciding'
        ? [t('work.state.piVerifyingTitle'), t('work.state.piVerifyingDetail')]
        : decision?.phase === 'pi_error'
          ? [t('work.state.piBlockedTitle'), decision?.activity?.error || t('work.state.piBlockedDetail')]
          : decision?.phase === 'pi_waiting'
            ? [t('work.state.piWaitingTitle'), t('work.state.piWaitingDetail')]
            : [t('work.state.piQueuedTitle'), t('work.state.piQueuedDetail')];
  const summary = {
    cancelled: [t('work.state.cancelledTitle'), t('work.state.cancelledDetail')],
    done: [t('work.state.doneTitle'), t('work.state.doneDetail')],
    failed: [t('work.state.failedTitle'), t('work.state.failedDetail')],
    in_progress: decision?.phase?.startsWith('pi_') ? pendingSummary : [t('work.state.runningTitle'), t('work.state.runningDetail')],
    needs_user: pendingSummary,
    todo: [t('work.state.queuedTitle'), t('work.state.queuedDetail')],
    triage: [t('work.state.readyTitle'), t('work.state.readyDetail')],
  }[status] || [status, t('work.state.unknownDetail')];
  const Icon = status === 'failed' ? AlertTriangle : status === 'done' ? CheckCircle2 : CircleDot;
  return <div className="work-state-summary" data-status={status}><Icon size={16} /><div><strong>{summary[0]}</strong><span>{summary[1]}</span></div></div>;
}

export function WorkDetailLoading() {
  const { t } = useI18n();
  return <div className="work-detail-loading"><LoaderCircle className="is-spinning" size={14} /><strong>{t('work.loadingDetail')}</strong></div>;
}

export function WorkDetailFailure({ error, navigateTo }) {
  const { t } = useI18n();
  return <section className="work-detail-failure" role="alert"><AlertTriangle size={16} /><div><strong>{t('work.detailUnavailable')}</strong><span>{error || t('work.notFound')}</span></div><button onClick={() => navigateTo('tasks')} type="button"><ArrowLeft size={14} /> {t('work.backToBoard')}</button></section>;
}

export function SectionHeading({ eyebrow, title }) {
  return <header className="work-section-heading"><span>{eyebrow}</span><h2>{title}</h2></header>;
}

export function EmptySection({ text }) {
  return <div className="work-section-empty"><CircleDot size={16} /><span>{text}</span></div>;
}

export function ResourceError({ error }) {
  return error ? <div className="work-resource-error" role="alert"><AlertTriangle size={14} /> {error}</div> : null;
}

export function InlineConfirmation({ busy, onCancel, onConfirm }) {
  const { t } = useI18n();
  return <div className="work-inline-confirm" role="alertdialog" aria-label={t('work.confirmCancel')}><AlertTriangle size={16} /><div><strong>{t('work.confirmCancel')}</strong><span>{t('work.cancelAudit')}</span></div><button disabled={busy} onClick={onCancel} type="button">{t('work.keep')}</button><button className="danger" disabled={busy} onClick={onConfirm} type="button">{busy ? t('work.submitting') : t('work.confirmCancelAction')}</button></div>;
}
