import { useState } from 'react';
import { workApi } from '../../api/work.js';
import { useI18n } from '../../i18n/context.js';
import { message } from '../../store/toastStore.js';
import { ReviewDialog } from './HumanReview.jsx';

// 任务人工审核在任务详情和首页共用：同一张卡片、同一个对话框、同一条提交路径
// （POST human-review-response，携带 review_request_id + review_revision）。
export function useHumanReview({ onSubmitted, classifyError } = {}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const select = (work, request, action) => {
    setPending({ action, request, work });
    setComment('');
  };
  const cancel = () => {
    setPending(null);
    setComment('');
  };
  const submit = async () => {
    if (!pending || submitting) return;
    const { action, request, work } = pending;
    if ((action === 'reject' || action === 'request_changes') && !comment.trim()) return;
    setSubmitting(true);
    try {
      await workApi.answerWorkHumanReview(work.id, {
        action,
        comment: comment.trim(),
        review_request_id: request?.id,
        review_revision: request?.revision,
      });
      message.success(t('work.reviewSubmitted'));
      cancel();
      await onSubmitted?.(work);
    } catch (reviewError) {
      const failure = classifyError?.(reviewError) || {
        invalidated: reviewError.status === 409,
        message: reviewError.status === 409 ? t('work.reviewStale') : reviewError.message || t('work.reviewFailed'),
      };
      message.error(failure.message);
      if (failure.invalidated) {
        cancel();
        await onSubmitted?.(work);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const dialog = pending ? (
    <ReviewDialog
      action={pending.action}
      busy={submitting}
      comment={comment}
      onCancel={cancel}
      onChange={setComment}
      onConfirm={submit}
      request={pending.request}
    />
  ) : null;

  return { dialog, select, submitting };
}
