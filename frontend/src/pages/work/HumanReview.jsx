import './HumanReview.css';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import ModalOverlay from '../../components/ModalOverlay.jsx';
import { useI18n } from '../../i18n/context.js';
import { workHumanReviewActions, workHumanReviewCopy } from '../workHumanReviewCopy.js';

export function HumanReviewCard({ compact = false, disabled, onSelect, request }) {
  const { t } = useI18n();
  const copy = workHumanReviewCopy(request.kind, t);
  const actions = workHumanReviewActions(request.kind);
  return <article className={`work-human-review-card${compact ? ' is-compact' : ''}`}>
    <span>{copy.pending}</span>
    <h3>{request.question}</h3>
    {request.recommendation ? <p><strong>{t('work.piRecommendation')}：</strong>{request.recommendation}</p> : null}
    {!compact && request.acceptance_summary?.length ? <div><strong>{t('work.acceptanceIncludes')}</strong><ul>{request.acceptance_summary.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {!compact && request.excluded_scope?.length ? <div><strong>{t('work.notIncluded')}</strong><ul>{request.excluded_scope.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {!compact && request.evidence_refs?.length ? <details><summary>{t('work.reviewEvidence')}</summary><ul>{request.evidence_refs.map(item => <li key={item}><code>{item}</code></li>)}</ul></details> : null}
    {request.consequences ? <p><strong>{t('work.approvalConsequences')}：</strong>{request.consequences}</p> : null}
    <div className="work-review-actions">
      {actions.includes('accept') ? <button disabled={disabled} onClick={() => onSelect('accept')} type="button"><CheckCircle2 size={14} /> {copy.accept}</button> : null}
      {actions.includes('request_changes') ? <button disabled={disabled} onClick={() => onSelect('request_changes')} type="button"><RefreshCw size={14} /> {t('work.changes')}</button> : null}
      {actions.includes('reject') ? <button className="danger" disabled={disabled} onClick={() => onSelect('reject')} type="button"><XCircle size={14} /> {copy.reject}</button> : null}
    </div>
  </article>;
}

export function ReviewDialog({ action, busy, comment, onCancel, onChange, onConfirm, request }) {
  const { t } = useI18n();
  const copy = workHumanReviewCopy(request?.kind, t);
  const commentRequired = action === 'reject' || action === 'request_changes';
  return <ModalOverlay className="work-dialog-overlay"><form className="work-review-dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}><span>{t('work.reviewGate')}</span><h2>{reviewTitle(action, t, copy)}</h2><p className="work-review-question">{request?.question}</p><p>{action === 'request_changes' ? t('work.reviewRevisionFlow') : action === 'accept' ? copy.detail : t('work.reviewAudit')}</p><label><span>{t(commentRequired ? 'work.reviewNoteRequired' : 'work.reviewNoteOptional')}</span><textarea autoFocus={commentRequired} className="form-control" onChange={event => onChange(event.target.value)} placeholder={action === 'request_changes' ? t('work.reviewChangesPlaceholder') : ''} rows={5} value={comment} /></label><div><button disabled={busy} onClick={onCancel} type="button">{t('work.cancel')}</button><button className={action === 'reject' ? 'danger' : 'primary'} disabled={busy || (commentRequired && !comment.trim())} type="submit">{busy ? t('work.submitting') : action === 'request_changes' ? t('work.submitChangesAndContinue') : action === 'accept' ? copy.accept : t('work.submitReview')}</button></div></form></ModalOverlay>;
}

function reviewTitle(action, t, copy) {
  if (action === 'accept') return copy.title;
  if (action === 'reject') return copy.reject;
  return t('work.requestChanges');
}
