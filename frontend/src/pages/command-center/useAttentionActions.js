import { useEffect, useRef, useState } from 'react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { useI18n } from '../../i18n/context.js';
import { message } from '../../store/toastStore.js';
import { attentionActionPayload } from './attentionModel.js';
import { inboxFailure } from './taskRequestsModel.js';

const emptyApproval = () => ({ detail: null, error: '', loading: false });
export function useAttentionActions(refresh) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState('');
  const [approval, setApproval] = useState(emptyApproval);
  const detailRequest = useRef(null);
  useEffect(() => () => { detailRequest.current?.abort(); detailRequest.current = null; }, []);
  const close = () => {
    detailRequest.current?.abort(); detailRequest.current = null;
    setApproval(emptyApproval());
  };
  const submit = async (item, action) => {
    if (submitting) return;
    setSubmitting(`${item.id}:${action}`);
    try {
      await commandCenterApi.controlAttention(item.id, action, attentionActionPayload(item, action));
      message.success(t(action === 'acknowledge' ? 'inbox.acknowledged' : 'inbox.snoozed'));
      await refresh();
    } catch (error) {
      const failure = inboxFailure('attention', error, t);
      message.error(failure.message);
      if (failure.invalidated) await refresh();
    } finally { setSubmitting(''); }
  };
  const review = async item => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setApproval({ detail: null, error: '', loading: true });
    try {
      const detail = await commandCenterApi.getAttention(item.id, { signal: controller.signal });
      if (detailRequest.current === controller) setApproval({ detail, error: '', loading: false });
    } catch (error) {
      if (detailRequest.current !== controller || error?.name === 'AbortError') return;
      const failure = inboxFailure('approval', error, t);
      setApproval({ detail: null, error: failure.message, loading: false });
      if (failure.invalidated) await refresh();
    } finally { if (detailRequest.current === controller) detailRequest.current = null; }
  };
  // Approval decisions retain their own endpoint payload and original Gate; they
  // are never sent through the acknowledgement/snooze audit-command adapter.
  const resolve = async (decision, target) => {
    if (!approval.detail || submitting) return;
    setSubmitting(`${target.ref}:${decision}`);
    try {
      await commandCenterApi.controlAttention(approval.detail.attention.id, decision, {
        actor: 'frontend:user', decision_ref: target.ref,
        reason: `Dashboard user ${decision}d ${target.kind}`, scope: 'turn',
      });
      message.success(t(decision === 'reject' ? 'inbox.approvalRejected' : 'inbox.approvalApproved'));
      close(); await refresh();
    } catch (error) {
      const failure = inboxFailure('approval', error, t);
      message.error(failure.message);
      if (failure.invalidated) { close(); await refresh(); }
    } finally { setSubmitting(''); }
  };
  return { approval, submitting, submit, review, resolve, close };
}
