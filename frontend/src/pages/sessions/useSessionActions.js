import { runsApi } from '../../api/runs.js';
import { removeApprovalRequest } from './approvalQueue';
import { message as toast } from '../../store/toastStore';
import { isInterruptPendingForSession, interruptRequestNotice, interruptFailureNotice } from './sessionInterrupt';
import { showToastNotice } from './sessionNotices.js';
import { setSessionRunningInList } from './sessionPageRuntime';

export default function useSessionActions({
  approvalRequest,
  setApprovalSubmitting,
  setApprovalQueue,
  selectedId,
  interruptStateRef,
  applyInterruptNotice,
  setSessionRunning,
  setSessions,
}) {
  const resolveApproval = async (decision, scope = 'turn') => {
    if (!approvalRequest) return;
    setApprovalSubmitting(true);
    try {
      await runsApi.resolveCodexApproval(approvalRequest.id, { decision, scope });
      setApprovalQueue((current) => removeApprovalRequest(current, approvalRequest));
    } catch (err) {
      toast.error(err.message || '提交授权决策失败');
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const interrupt = async () => {
    if (!selectedId || isInterruptPendingForSession(interruptStateRef.current, selectedId)) return;
    const requestId = selectedId;
    applyInterruptNotice({
      sessionId: requestId,
      status: 'pending',
      tone: 'info',
      text: '正在发送中断请求...',
    });
    try {
      const result = await runsApi.interruptSession(requestId);
      const notice = interruptRequestNotice(requestId, result);
      if (isInterruptPendingForSession(interruptStateRef.current, requestId)) {
        applyInterruptNotice(notice);
        showToastNotice(notice);
      }
      if (!result?.interrupted) {
        setSessionRunning(false);
        setSessions((prev) => setSessionRunningInList(prev, requestId, false));
      }
    } catch (err) {
      const notice = interruptFailureNotice(requestId, err);
      if (isInterruptPendingForSession(interruptStateRef.current, requestId)) {
        applyInterruptNotice(notice);
        showToastNotice(notice);
      }
    }
  };

  return { resolveApproval, interrupt };
}
