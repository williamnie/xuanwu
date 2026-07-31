import { useCallback, useEffect, useState } from 'react';
import { workApi } from '../../api/work.js';
import { message } from '../../store/toastStore';
import { selectRefreshData, useDataStore } from '../../store/dataStore';
import { hasIssueEvent } from '../../utils/stateGuards';
import { serviceTierPayload } from '../../utils/serviceTier';
import { copyTextToClipboard } from './issueDetailFormatters';

export default function useIssueDetailActions({
  issueId,
  issue,
  navigateTo,
  loadIssueData,
  updateDetailState,
}) {
  const refreshData = useDataStore(selectRefreshData);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentError, setCommentError] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [verifierGenerating, setVerifierGenerating] = useState(false);
  const [verifierError, setVerifierError] = useState('');
  const [verificationReviewAction, setVerificationReviewAction] = useState('');
  const [verificationReviewDraft, setVerificationReviewDraft] = useState('');
  const [verificationReviewSubmitting, setVerificationReviewSubmitting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingIssue, setDeletingIssue] = useState(false);

  useEffect(() => {
    setIsEditModalOpen(false);
    setCommentDraft('');
    setCommentError('');
    setCommentSubmitting(false);
    setVerifierGenerating(false);
    setVerifierError('');
    setVerificationReviewAction('');
    setVerificationReviewDraft('');
    setVerificationReviewSubmitting(false);
    setDeleteConfirmOpen(false);
    setDeletingIssue(false);
  }, [issueId]);

  const handleMoveToTodo = async () => {
    try {
      await workApi.updateIssue(issueId, { status: 'todo', ...serviceTierPayload(issue.service_tier) });
      message.success('Issue 已移动到 Todo');
      loadIssueData();
    } catch (err) {
      message.error('移动到 Todo 失败: ' + err.message);
    }
  };

  const handleRetry = async () => {
    try {
      await workApi.retryIssue(issueId, serviceTierPayload(issue.service_tier));
      updateDetailState(draft => {
        draft.logEvents = [];
        draft.logsLoaded = false;
        draft.logsHasMore = false;
        draft.unseenLogCount = 0;
      });
      loadIssueData();
    } catch (err) {
      message.error('重新运行失败: ' + err.message);
    }
  };

  const handleServiceTierChange = async (serviceTier) => {
    try {
      const updated = await workApi.updateIssue(issueId, serviceTierPayload(serviceTier));
      updateDetailState(draft => {
        draft.issue = updated;
      });
      refreshData(['issues']);
    } catch (err) {
      message.error('更新执行速度失败: ' + err.message);
    }
  };

  const handleIssueLogModeChange = async (issueLogMode) => {
    try {
      const updated = await workApi.updateIssue(issueId, { issue_log_mode: issueLogMode });
      updateDetailState(draft => {
        draft.issue = updated;
      });
      message.success(issueLogMode === 'debug' ? '下次运行将记录完整调试日志' : '已恢复精简日志模式');
      refreshData(['issues']);
    } catch (err) {
      message.error('更新日志模式失败: ' + err.message);
    }
  };

  const handleCancel = async () => {
    try {
      await workApi.cancelIssue(issueId);
      loadIssueData();
    } catch (err) {
      message.error('取消任务失败: ' + err.message);
    }
  };

  const handleDelete = async () => {
    if (issue?.status === 'in_progress') {
      message.warning('运行中的 Issue 不能删除，请先中断取消');
      setDeleteConfirmOpen(false);
      return;
    }
    setDeletingIssue(true);
    try {
      await workApi.deleteIssue(issueId);
      message.success(`Issue #${issueId} 已删除`);
      refreshData(['issues']);
      navigateTo('issues');
    } catch (err) {
      message.error('删除任务失败: ' + err.message);
    } finally {
      setDeletingIssue(false);
    }
  };

  const handleMarkStatus = async (targetStatus) => {
    try {
      await workApi.updateIssue(issueId, { status: targetStatus });
      loadIssueData();
    } catch (err) {
      message.error('更改状态失败: ' + err.message);
    }
  };

  const handleVerificationReview = async (action, comment = '') => {
    setVerificationReviewSubmitting(true);
    try {
      await workApi.reviewIssueVerification(issueId, {
        action,
        comment: comment.trim(),
        review_request_id: issue?.verification?.request?.id,
        review_revision: issue?.verification?.request?.revision,
      });
      message.success('验证处理已提交');
      setVerificationReviewAction('');
      setVerificationReviewDraft('');
      loadIssueData();
      refreshData(['issues']);
    } catch (err) {
      message.error('验证处理失败: ' + err.message);
    } finally {
      setVerificationReviewSubmitting(false);
    }
  };

  const handleSubmitComment = async (event) => {
    event.preventDefault();
    const body = commentDraft.trim();
    if (!body) {
      setCommentError('内部备注不能为空');
      return;
    }
    setCommentSubmitting(true);
    setCommentError('');
    try {
      const created = await workApi.createIssueComment(issueId, { body, author: 'user' });
      updateDetailState(draft => {
        if (!hasIssueEvent(draft.events, created)) draft.events.push(created);
      });
      setCommentDraft('');
    } catch (err) {
      const errorMessage = err.message || '保存内部备注失败';
      setCommentError(errorMessage);
      message.error('保存内部备注失败: ' + errorMessage);
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleGenerateVerifierReport = async () => {
    setVerifierGenerating(true);
    setVerifierError('');
    try {
      const result = await workApi.generateIssueVerifierReport(issueId);
      updateDetailState(draft => {
        if (result?.event && !hasIssueEvent(draft.events, result.event)) draft.events.push(result.event);
      });
      message.success('Verifier report 已生成');
      loadIssueData();
    } catch (err) {
      const errorMessage = err.message || '生成 verifier report 失败';
      setVerifierError(errorMessage);
      message.error('生成 verifier report 失败: ' + errorMessage);
    } finally {
      setVerifierGenerating(false);
    }
  };

  const closeEditModal = useCallback(() => setIsEditModalOpen(false), []);
  const handleIssueSaved = useCallback((updatedIssue) => {
    updateDetailState(draft => {
      draft.issue = updatedIssue;
    });
    setIsEditModalOpen(false);
    refreshData(['issues']);
  }, [refreshData, updateDetailState]);

  const handleCopyText = useCallback(async (text) => {
    try {
      await copyTextToClipboard(text);
      message.success('已复制到剪贴板');
    } catch (err) {
      message.error(err.message || '复制失败');
    }
  }, []);

  return {
    isEditModalOpen,
    setIsEditModalOpen,
    commentDraft,
    setCommentDraft,
    commentError,
    commentSubmitting,
    verifierGenerating,
    verifierError,
    verificationReviewAction,
    setVerificationReviewAction,
    verificationReviewDraft,
    setVerificationReviewDraft,
    verificationReviewSubmitting,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    deletingIssue,
    handleMoveToTodo,
    handleRetry,
    handleServiceTierChange,
    handleIssueLogModeChange,
    handleCancel,
    handleDelete,
    handleMarkStatus,
    handleVerificationReview,
    handleSubmitComment,
    handleGenerateVerifierReport,
    closeEditModal,
    handleIssueSaved,
    handleCopyText,
  };
}
